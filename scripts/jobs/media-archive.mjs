// Syncthing Inbox의 안정된 파일을 하드링크로 보존한다. Inbox 링크는 건드리지 않는다.
// 직접 실행하면 실제 Media/Vault에 기록하므로 검증은 runMediaArchive의 임시 경로 주입으로만 한다.
import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { withLock } from '../lib/state-writer.mjs';

const execFileAsync = promisify(execFile);
const KINDS = ['Camera', 'Recordings', 'Calls', 'Screenshots'];
const STABLE_AGE_MS = 2 * 60 * 1000;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.avi', '.mkv', '.webm']);

function excluded(name) {
  return name.startsWith('.') || name.startsWith('~syncthing~') || name.endsWith('.tmp');
}

async function collectFiles(mediaRoot, now) {
  const files = [];
  for (const kind of KINDS) {
    const inbox = join(mediaRoot, 'Inbox', kind);
    async function visit(folder) {
      let entries;
      try { entries = await fs.readdir(folder, { withFileTypes: true }); }
      catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (excluded(entry.name)) continue;
        const path = join(folder, entry.name);
        // Syncthing 폴더 안의 링크는 바깥 파일/디렉터리를 따라갈 수 있으므로 제외한다.
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) {
          const stat = await fs.lstat(path);
          if (stat.isFile() && now.getTime() - stat.mtimeMs >= STABLE_AGE_MS) {
            files.push({ kind, path, stat });
          }
        }
      }
    }
    await visit(inbox);
  }
  return files;
}

function validLocal(year, month, day, hour, minute, second) {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

function parseTimestamp(value, { utc = false } = {}) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})[:/-](\d{2})[:/-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/i);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '00', zone] = match;
  const parts = [y, mo, d, h, mi, s].map(Number);
  if (!validLocal(...parts)) return null;
  const normalizedZone = zone?.toUpperCase() === 'Z' ? '+00:00'
    : zone ? zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')
      : utc ? '+00:00' : '+09:00';
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${normalizedZone}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateFromFilename(name) {
  const full = name.match(/(?:^|\D)(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(?=\D|$)/);
  if (full) {
    const date = parseTimestamp(`${full[1]}:${full[2]}:${full[3]} ${full[4]}:${full[5]}:${full[6]}`);
    if (date) return date;
  }
  const epoch = name.match(/(?:^|\D)(1\d{12})(?=\D|$)/);
  if (epoch) {
    const date = new Date(Number(epoch[1]));
    if (!Number.isNaN(date.getTime())) return date;
  }
  const short = name.match(/(?:^|\D)(\d{2})(\d{2})(\d{2})[_-](\d{2})(\d{2})(?=\D|$)/);
  if (short) return parseTimestamp(`20${short[1]}:${short[2]}:${short[3]} ${short[4]}:${short[5]}:00`);
  return null;
}

function capturedTime(file, metadata) {
  const video = VIDEO_EXTENSIONS.has(extname(file.path).toLowerCase());
  const exif = parseTimestamp(metadata?.DateTimeOriginal)
    || (video ? parseTimestamp(metadata?.MediaCreateDate, { utc: true }) : null)
    || parseTimestamp(metadata?.CreateDate)
    || parseTimestamp(metadata?.MediaCreateDate, { utc: true });
  if (exif) return { date: exif, from: 'exif' };
  const filename = dateFromFilename(basename(file.path));
  if (filename) return { date: filename, from: 'filename' };
  return { date: new Date(file.stat.mtimeMs), from: 'mtime' };
}

function kstIso(date) {
  // KST는 UTC+09:00이며 DST가 없다.
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function sameContent(target, sourceStat, sourceHash) {
  const targetStat = await fs.lstat(target);
  if (!targetStat.isFile()) throw new Error(`보관 대상이 일반 파일이 아닙니다: ${target}`);
  if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) return true;
  return sourceStat.size === targetStat.size && sourceHash === await sha256(target);
}

async function archiveLink(file, destination, sourceHash, link) {
  const extension = extname(destination);
  const stem = basename(destination, extension);
  for (let number = 1; ; number += 1) {
    const target = number === 1 ? destination
      : join(dirname(destination), `${stem} (${number})${extension}`);
    try {
      await link(file.path, target);
      return { target, created: true };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await sameContent(target, file.stat, sourceHash)) return { target, created: false };
    }
  }
}

function gpsFrom(metadata) {
  const lat = Number(metadata?.GPSLatitude);
  const lon = Number(metadata?.GPSLongitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90
    && lon >= -180 && lon <= 180 ? { lat, lon } : undefined;
}

async function readIndexRecords(indexPath, { dryRun }) {
  let content;
  try { content = await fs.readFile(indexPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  const records = new Map();
  const lines = content.split('\n');
  const hasTrailingLine = lines.at(-1) !== '';
  if (!hasTrailingLine) lines.pop();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    try {
      const record = JSON.parse(line);
      if (!record.id || !record.archivePath) throw new Error('필수 필드 누락');
      records.set(record.id, record);
    } catch (error) {
      if (hasTrailingLine && index === lines.length - 1) {
        if (dryRun) throw new Error(`색인 마지막 줄 손상(읽기 전용 dry-run): ${error.message}`);
        // append 도중 끊긴 마지막 조각만 버린다. 개행으로 끝난 완성 레코드는 보존한다.
        await fs.truncate(indexPath, Buffer.byteLength(content.slice(0, content.lastIndexOf('\n') + 1)));
        return records;
      }
      throw new Error(`색인 ${index + 1}번째 줄 손상: ${error.message}`);
    }
  }
  if (hasTrailingLine && !dryRun) await fs.appendFile(indexPath, '\n');
  return records;
}

async function verifyIndexedRecord(record, mediaRoot, sourceHash) {
  const archiveRoot = resolve(mediaRoot, 'Archive');
  const target = resolve(mediaRoot, record.archivePath);
  const inside = relative(archiveRoot, target);
  if (isAbsolute(inside) || !inside || inside === '..' || inside.startsWith(`..${sep}`)) {
    throw new Error(`색인 보관 경로가 Archive 밖입니다: ${record.archivePath}`);
  }
  const stat = await fs.lstat(target);
  if (!stat.isFile() || await sha256(target) !== sourceHash) {
    throw new Error(`색인 보관 파일이 없거나 내용이 다릅니다: ${record.archivePath}`);
  }
}

async function destinationExistsWithSameContent(file, destination, hash) {
  const extension = extname(destination);
  const stem = basename(destination, extension);
  for (let number = 1; ; number += 1) {
    const target = number === 1 ? destination : join(dirname(destination), `${stem} (${number})${extension}`);
    try {
      if (await sameContent(target, file.stat, hash)) return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
}

export async function runMediaArchive({
  mediaRoot = join(homedir(), 'Pantheon', 'Media'),
  indexPath = VAULT_PATHS.mediaArchiveIndex,
  exiftoolPath = '/opt/homebrew/bin/exiftool',
  now = new Date(),
  dryRun = false,
  link = fs.link,
  output = console,
} = {}) {
  const summary = { archived: 0, skipped: 0, failed: 0, capturedFrom: { exif: 0, filename: 0, mtime: 0 } };
  await fs.stat(mediaRoot); // 마운트가 빠졌다면 빈 Inbox로 오인하지 않고 잡 실패를 알린다.
  const files = await collectFiles(mediaRoot, now);
  const records = await readIndexRecords(indexPath, { dryRun });
  let metadataByPath = new Map();
  if (files.length) {
    try {
      let stdout;
      try {
        ({ stdout } = await execFileAsync(exiftoolPath, [
        '-json', '-n', '-DateTimeOriginal', '-CreateDate', '-MediaCreateDate',
        '-GPSLatitude', '-GPSLongitude', ...files.map((file) => file.path),
        ], { maxBuffer: 32 * 1024 * 1024 }));
      } catch (error) {
        // exiftool은 한 파일의 형식 오류에도 나머지 파일 JSON을 출력하며 비정상 종료할 수 있다.
        if (!error.stdout) throw error;
        stdout = error.stdout;
        output.error(`[media-archive] exiftool 일부 파일 경고: ${error.message}`);
      }
      const metadata = JSON.parse(stdout);
      if (!Array.isArray(metadata)) throw new Error('exiftool JSON 배열이 아닙니다');
      metadataByPath = new Map(metadata.map((item) => [item.SourceFile, item]));
    } catch (error) {
      summary.failed = files.length;
      output.error(`[media-archive] exiftool 실패: ${error.message}`);
      output.log(`[media-archive] 새로 보관 0, 건너뜀 0, 실패 ${summary.failed}; 근거 exif 0, filename 0, mtime 0`);
      return summary;
    }
  }

  for (const file of files) {
    try {
      const captured = capturedTime(file, metadataByPath.get(file.path));
      const hash = await sha256(file.path);
      const currentStat = await fs.lstat(file.path);
      if (!currentStat.isFile() || currentStat.dev !== file.stat.dev || currentStat.ino !== file.stat.ino
        || currentStat.size !== file.stat.size || currentStat.mtimeMs !== file.stat.mtimeMs) {
        throw new Error('해시 계산 중 원본 파일이 변경되었습니다');
      }
      const id = hash.slice(0, 16);
      const relativeInbox = relative(mediaRoot, file.path).split('\\').join('/');
      const kst = kstIso(captured.date);
      const destination = join(mediaRoot, 'Archive', kst.slice(0, 4), kst.slice(5, 7), file.kind, basename(file.path));
      const existing = records.get(id);
      if (existing) {
        await verifyIndexedRecord(existing, mediaRoot, hash);
        summary.skipped += 1;
        summary.capturedFrom[captured.from] += 1;
        continue;
      }
      if (dryRun) {
        // dry-run은 디렉터리조차 만들지 않고 예측만 한다.
        if (await destinationExistsWithSameContent(file, destination, hash)) summary.skipped += 1;
        else summary.archived += 1;
      } else {
        await fs.mkdir(dirname(destination), { recursive: true });
        const { target, created } = await archiveLink(file, destination, hash, link);
        try {
          const linkedSource = await fs.lstat(file.path);
          if (!linkedSource.isFile() || linkedSource.dev !== file.stat.dev || linkedSource.ino !== file.stat.ino
            || linkedSource.size !== file.stat.size || linkedSource.mtimeMs !== file.stat.mtimeMs) {
            throw new Error('링크 생성 중 원본 파일이 변경되었습니다');
          }
        } catch (error) {
          if (created) await fs.unlink(target);
          throw error;
        }
        const gps = gpsFrom(metadataByPath.get(file.path));
        const record = {
          id, kind: file.kind, inboxPath: relativeInbox,
          archivePath: relative(mediaRoot, target).split('\\').join('/'),
          capturedAt: kst, capturedFrom: captured.from, size: file.stat.size,
          ...(gps ? { gps } : {}),
          archivedAt: kstIso(now),
        };
        await fs.mkdir(dirname(indexPath), { recursive: true });
        await fs.appendFile(indexPath, `${JSON.stringify(record)}\n`);
        records.set(id, record);
        if (created) summary.archived += 1;
        else summary.skipped += 1;
      }
      summary.capturedFrom[captured.from] += 1;
    } catch (error) {
      summary.failed += 1;
      output.error(`[media-archive] 실패: ${file.path}: ${error.message}`);
    }
  }
  output.log(`[media-archive] ${dryRun ? 'dry-run ' : ''}새로 보관 ${summary.archived}, 건너뜀 ${summary.skipped}, 실패 ${summary.failed}; 근거 exif ${summary.capturedFrom.exif}, filename ${summary.capturedFrom.filename}, mtime ${summary.capturedFrom.mtime}`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--dry-run')) {
    console.error('usage: node scripts/jobs/media-archive.mjs [--dry-run]');
    process.exitCode = 2;
  } else {
    (async () => {
      const dryRun = args.includes('--dry-run');
      if (dryRun) return runMediaArchive({ dryRun });
      await fs.mkdir(dirname(VAULT_PATHS.mediaArchiveIndex), { recursive: true });
      return withLock(VAULT_PATHS.mediaArchiveIndex, () => runMediaArchive(),
        { retries: 1200, retryDelayMs: 100 });
    })()
      .then((summary) => { if (summary.failed) process.exitCode = 1; })
      .catch((error) => { console.error(`[media-archive] ${error.stack}`); process.exitCode = 1; });
  }
}
