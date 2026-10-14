// Syncthing Inbox의 안정된 파일을 하드링크로 보존하고 미연결 통화만 휴지통으로 옮긴다.
// 직접 실행하면 실제 Media/Vault에 기록하므로 검증은 runMediaArchive의 임시 경로 주입으로만 한다.
import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { parseCallFilename, loadPeople, isLinkedCall, contactKey } from '../lib/media-people.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';

const execFileAsync = promisify(execFile);
const KINDS = ['Camera', 'Recordings', 'Calls', 'Screenshots', 'KakaoTalk', 'KakaoTalkMovie'];
const STABLE_AGE_MS = 2 * 60 * 1000;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.avi', '.mkv', '.webm']);
const AUDIO_EXTENSIONS = new Set(['.m4a', '.m4b', '.m4p', '.m4r', '.mp3', '.wav', '.aac', '.flac', '.ogg', '.wma', '.amr', '.3ga']);
const QUICKTIME_EXTENSIONS = new Set(['.m4a', '.m4b', '.m4p', '.m4r', '.mp4', '.mov', '.m4v', '.3gp', '.3g2', '.3ga', '.qt']);
const MAX_TRASH_PER_RUN = 20;

function insidePath(root, candidate) {
  const inside = relative(resolve(root), resolve(candidate));
  return inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`);
}

async function noSymlinks(root, candidate) {
  if (!insidePath(root, candidate)) throw new Error(`허용된 폴더 밖 경로: ${candidate}`);
  let current = resolve(root);
  try {
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`심볼릭 링크 경로: ${current}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const part of relative(current, resolve(candidate)).split(sep)) {
    current = join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`심볼릭 링크 경로: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function uniqueTrashPath(directory, filename) {
  const extension = extname(filename);
  const stem = basename(filename, extension);
  for (let number = 1; ; number += 1) {
    const target = join(directory, number === 1 ? filename : `${stem} (${number})${extension}`);
    try { await fs.lstat(target); }
    catch (error) {
      if (error.code === 'ENOENT') return target;
      throw error;
    }
  }
}

async function expiredTrashFolders(mediaRoot, now, { latestArchivedAt = null } = {}) {
  const trashRoot = join(mediaRoot, 'Trash');
  let entries;
  try {
    if (!(await fs.lstat(trashRoot)).isDirectory()) throw new Error('휴지통 경로가 디렉터리가 아닙니다');
    entries = await fs.readdir(trashRoot, { withFileTypes: true });
  }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const today = kstIso(now).slice(0, 10);
  const cutoff = Date.parse(`${today}T00:00:00+09:00`) - 30 * 24 * 60 * 60_000;
  const dated = entries.filter((entry) => {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) return false;
    const timestamp = Date.parse(`${entry.name}T00:00:00+09:00`);
    return Number.isFinite(timestamp) && kstIso(new Date(timestamp)).slice(0, 10) === entry.name;
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (dated.length && dated.at(-1).name > today) return [];
  // 시계가 앞으로 튀면 정리하지 않는다: 오늘이 가장 최근 기록(보관 시각·휴지통 날짜)보다 2일 넘게 앞서면 멈춘다.
  const latest = [latestArchivedAt, dated.at(-1)?.name].filter(Boolean).sort().at(-1);
  if (latest && Date.parse(`${today}T00:00:00+09:00`) - Date.parse(`${latest}T00:00:00+09:00`) > 2 * 24 * 60 * 60_000) return [];
  return dated.filter((entry) => Date.parse(`${entry.name}T00:00:00+09:00`) < cutoff)
    .slice(0, 3).map((entry) => join(trashRoot, entry.name));
}

async function trashRecords(manifest, trashRoot) {
  await noSymlinks(trashRoot, manifest);
  let content;
  try { content = await fs.readFile(manifest, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const items = [];
  for (const line of content.trim().split('\n')) {
    try {
      const item = JSON.parse(line);
      if (/^[a-f0-9]{16}$/i.test(item.record?.id)) items.push(item);
    } catch { /* 완료 전 끊긴 manifest 줄은 무시한다. */ }
  }
  return items;
}

async function trashedIds(mediaRoot) {
  const trashRoot = join(mediaRoot, 'Trash');
  const all = new Set();
  const purgedIds = new Set();
  let dates;
  try {
    if (!(await fs.lstat(trashRoot)).isDirectory()) throw new Error('휴지통 경로가 디렉터리가 아닙니다');
    dates = await fs.readdir(trashRoot, { withFileTypes: true });
  } catch (error) { if (error.code === 'ENOENT') return { all, purged: purgedIds }; throw error; }
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.name)) continue;
    await noSymlinks(trashRoot, join(trashRoot, date.name));
    if (!date.isDirectory()) continue;
    const manifest = join(trashRoot, date.name, 'manifest.jsonl');
    for (const item of await trashRecords(manifest, trashRoot)) all.add(item.record.id.toLowerCase());
  }
  const purged = join(trashRoot, 'purged.jsonl');
  await noSymlinks(trashRoot, purged);
  let content;
  try { content = await fs.readFile(purged, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { all, purged: purgedIds }; throw error; }
  for (const line of content.trim().split('\n')) {
    try {
      const item = JSON.parse(line);
      if (/^[a-f0-9]{16}$/i.test(item.id)) {
        const id = item.id.toLowerCase();
        all.add(id);
        purgedIds.add(id);
      }
    } catch { /* 완료 전 끊긴 영구 목록 줄은 무시한다. */ }
  }
  return { all, purged: purgedIds };
}

async function orphanCalls(mediaRoot, records, people, now) {
  const archiveRoot = join(mediaRoot, 'Archive');
  const trashRoot = join(mediaRoot, 'Trash');
  const indexed = new Set([...records.values()].map((record) => record.archivePath));
  const manifests = new Map();
  const today = kstIso(now).slice(0, 10);
  const cutoff = Date.parse(`${today}T00:00:00+09:00`) - 30 * 24 * 3600_000;
  let dates = [];
  try { dates = await fs.readdir(trashRoot, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const date of dates) {
    if (!date.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(date.name) || date.name > today
      || Date.parse(`${date.name}T00:00:00+09:00`) < cutoff) continue;
    const manifest = join(trashRoot, date.name, 'manifest.jsonl');
    await noSymlinks(trashRoot, manifest);
    let content;
    try { content = await fs.readFile(manifest, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const line of content.trim().split('\n')) {
      try {
        const item = JSON.parse(line);
        if (/^[a-f0-9]{16}$/i.test(item.record?.id)
          && item.record?.kind === 'Calls'
          && item.trashPath?.startsWith(`Trash/${date.name}/Calls/`)
          && /^Trash\/\d{4}-\d{2}-\d{2}\/Calls\/[^/]+$/.test(item.trashPath)) {
          manifests.set(`${item.record.id}|${item.record.archivePath}`, item.trashPath);
        }
      } catch { /* 완료 전 끊긴 manifest 줄은 이동 근거가 아니다. */ }
    }
  }
  const found = [];
  let count = 0;
  let years = [];
  try { years = await fs.readdir(archiveRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { found, count }; throw error; }
  for (const year of years.filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))) {
    const yearPath = join(archiveRoot, year.name);
    for (const month of (await fs.readdir(yearPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^(0[1-9]|1[0-2])$/.test(entry.name))) {
      const calls = join(yearPath, month.name, 'Calls');
      let entries;
      try { entries = await fs.readdir(calls, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const archive = join(calls, entry.name);
        const archivePath = relative(mediaRoot, archive).split('\\').join('/');
        if (indexed.has(archivePath)) continue;
        count++;
        const parsed = parseCallFilename(entry.name);
        if (!parsed || !people || isLinkedCall(parsed.contact, people)) continue;
        await noSymlinks(archiveRoot, archive);
        const id = (await sha256(archive)).slice(0, 16);
        if (records.has(id)) continue;
        const trashPath = manifests.get(`${id}|${archivePath}`);
        if (!trashPath) continue;
        const target = join(mediaRoot, trashPath);
        await noSymlinks(trashRoot, target);
        found.push({ archive, target, id });
      }
    }
  }
  return { found, count };
}

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
  const bandPhoto = name.match(/BandPhoto_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})(?=\D|$)/i);
  if (bandPhoto) {
    const date = parseTimestamp(`${bandPhoto[1]}:${bandPhoto[2]}:${bandPhoto[3]} ${bandPhoto[4]}:${bandPhoto[5]}:${bandPhoto[6]}`);
    if (date) return { date, kind: 'saved' };
  }
  const full = name.match(/(?:^|\D)(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(?=\D|$)/);
  if (full) {
    const date = parseTimestamp(`${full[1]}:${full[2]}:${full[3]} ${full[4]}:${full[5]}:${full[6]}`);
    if (date) return { date, kind: 'camera' };
  }
  const epoch = name.match(/(?:^|\D)(1\d{12})(?=\D|$)/);
  if (epoch) {
    const date = new Date(Number(epoch[1]));
    if (!Number.isNaN(date.getTime())) return { date, kind: 'saved' };
  }
  const shortWithSeconds = name.match(/(?:^|\D)(\d{2})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(?=\D|$)/);
  if (shortWithSeconds) {
    const date = parseTimestamp(`20${shortWithSeconds[1]}:${shortWithSeconds[2]}:${shortWithSeconds[3]} ${shortWithSeconds[4]}:${shortWithSeconds[5]}:${shortWithSeconds[6]}`);
    if (date) return { date, kind: 'camera' };
  }
  const short = name.match(/(?:^|\D)(\d{2})(\d{2})(\d{2})[_-](\d{2})(\d{2})(?=\D|$)/);
  if (short) {
    const date = parseTimestamp(`20${short[1]}:${short[2]}:${short[3]} ${short[4]}:${short[5]}:00`);
    if (date) return { date, kind: 'camera' };
  }
  const savedMovie = name.match(/(?:^|\D)(\d{4})_(\d{2})_(\d{2})[ _](\d{2})_(\d{2})(?:_(\d{2}))?(?=\D|$)/);
  if (savedMovie) {
    const date = parseTimestamp(`${savedMovie[1]}:${savedMovie[2]}:${savedMovie[3]} ${savedMovie[4]}:${savedMovie[5]}:${savedMovie[6] || '00'}`);
    if (date) return { date, kind: 'saved' };
  }
  return null;
}

function differenceReason(first, second) {
  const minutes = Math.ceil(Math.abs(first.getTime() - second.getTime()) / 60_000);
  if (minutes >= 24 * 60) return `EXIF·파일명 ${Math.ceil(minutes / (24 * 60))}일 차이`;
  if (minutes >= 60) return `EXIF·파일명 ${Math.ceil(minutes / 60)}시간 차이`;
  return `EXIF·파일명 ${minutes}분 차이`;
}

export function capturedTime(file, metadata) {
  const extension = extname(file.path).toLowerCase();
  const video = VIDEO_EXTENSIONS.has(extension);
  const quickTime = QUICKTIME_EXTENSIONS.has(extension);
  const exifFields = [
    { value: metadata?.DateTimeOriginal },
    ...(video ? [{ value: metadata?.MediaCreateDate, utc: true }] : []),
    { value: metadata?.CreateDate, utc: quickTime },
    { value: metadata?.MediaCreateDate, utc: true },
  ];
  const selectedExif = exifFields.map(({ value, utc }) => ({
    date: parseTimestamp(value, { utc }), year: typeof value === 'string' ? Number(value.slice(0, 4)) : NaN,
  })).find(({ date }) => date);
  const rawExif = selectedExif?.date;
  const invalidExif = rawExif && selectedExif.year < 2005;
  const exif = invalidExif ? null : rawExif;
  const filename = dateFromFilename(basename(file.path));
  const invalidReason = invalidExif ? 'EXIF 2005년 이전' : null;
  if (exif && filename?.kind === 'camera') {
    const difference = Math.abs(exif.getTime() - filename.date.getTime());
    if (difference <= 2 * 60_000) return { date: exif, from: 'exif', confidence: 'confirmed' };
    const duration = metadata?.Duration;
    if ((video || AUDIO_EXTENSIONS.has(extension)) && typeof duration === 'number'
      && Number.isFinite(duration) && duration >= 0
      && exif.getTime() - filename.date.getTime() >= 0
      && difference <= duration * 1000 + 2 * 60_000) {
      return { date: exif, from: 'exif', confidence: 'confirmed' };
    }
    return { date: exif, from: 'exif', confidence: 'review', reason: differenceReason(exif, filename.date) };
  }
  if (exif && filename?.kind === 'saved') {
    if (exif.getTime() - filename.date.getTime() > 2 * 60_000) {
      return { date: exif, from: 'exif', confidence: 'review', reason: 'EXIF가 저장 시각보다 늦음' };
    }
    return { date: exif, from: 'exif', confidence: 'single' };
  }
  if (exif) return { date: exif, from: 'exif', confidence: 'single' };
  if (filename) return {
    date: filename.date, from: 'filename', confidence: filename.kind === 'camera' ? 'single' : 'estimated',
    ...((invalidReason || filename.kind === 'saved')
      ? { reason: [invalidReason, filename.kind === 'saved' ? '저장 시각 파일명만' : null].filter(Boolean).join('·') }
      : {}),
  };
  return { date: new Date(file.stat.mtimeMs), from: 'mtime', confidence: 'review',
    reason: [invalidReason, '수정일뿐'].filter(Boolean).join('·') };
}

export function kstIso(date) {
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

async function archiveLink(file, destination, sourceHash, link, { sameInodeOnly = false } = {}) {
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
      if (sameInodeOnly) {
        const targetStat = await fs.lstat(target);
        if (!targetStat.isFile()) throw new Error(`보관 대상이 일반 파일이 아닙니다: ${target}`);
        if (file.stat.dev === targetStat.dev && file.stat.ino === targetStat.ino) {
          return { target, created: false };
        }
        continue;
      }
      if (await sameContent(target, file.stat, sourceHash)) return { target, created: false };
    }
  }
}

export function gpsFrom(metadata) {
  const lat = Number(metadata?.GPSLatitude);
  const lon = Number(metadata?.GPSLongitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90
    && lon >= -180 && lon <= 180 ? { lat, lon } : undefined;
}

async function readIndexRecords(indexPath, { dryRun, allowIncomplete = false }) {
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
        if (allowIncomplete) return records;
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

export async function verifyIndexedRecord(record, mediaRoot, sourceHash) {
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

export async function repairMediaArchiveTimes({
  mediaRoot = join(homedir(), 'Pantheon', 'Media'),
  indexPath = VAULT_PATHS.mediaArchiveIndex,
  exiftoolPath = '/opt/homebrew/bin/exiftool',
  apply = false,
  link = fs.link,
  output = console,
} = {}) {
  const repair = async () => {
    await fs.stat(mediaRoot);
    const records = await readIndexRecords(indexPath, { dryRun: true });
    const archiveRoot = resolve(mediaRoot, 'Archive');
    const indexContent = () => `${[...records.values()].map((record) => JSON.stringify(record)).join('\n')}\n`;
    const pendingCleanup = [...records.values()].filter((record) => record.repairFrom
      && record.capturedFrom !== 'owner');
    if (apply && pendingCleanup.length) {
      for (const record of pendingCleanup) {
        const oldPath = resolve(mediaRoot, record.repairFrom);
        const inside = relative(archiveRoot, oldPath);
        if (isAbsolute(inside) || !inside || inside === '..' || inside.startsWith(`..${sep}`)) {
          throw new Error(`복구 전 경로가 Archive 밖입니다: ${record.repairFrom}`);
        }
        const currentPath = resolve(mediaRoot, record.archivePath);
        const currentInside = relative(archiveRoot, currentPath);
        if (oldPath === currentPath || isAbsolute(currentInside) || !currentInside
          || currentInside === '..' || currentInside.startsWith(`..${sep}`)) {
          throw new Error(`복구 색인 경로 오류: ${record.archivePath}`);
        }
        const current = await fs.lstat(currentPath);
        try {
          const old = await fs.lstat(oldPath);
          if (old.dev !== current.dev || old.ino !== current.ino) {
            throw new Error(`복구 전 링크가 색인 파일과 다릅니다: ${record.repairFrom}`);
          }
          await fs.unlink(oldPath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        delete record.repairFrom;
      }
      writeAtomic(indexPath, indexContent());
    }
    const indexed = [];
    for (const record of records.values()) {
      if (record.capturedFrom === 'owner') continue;
      const source = resolve(mediaRoot, record.archivePath);
      const inside = relative(archiveRoot, source);
      if (isAbsolute(inside) || !inside || inside === '..' || inside.startsWith(`..${sep}`)) {
        throw new Error(`색인 보관 경로가 Archive 밖입니다: ${record.archivePath}`);
      }
      const stat = await fs.lstat(source);
      if (!stat.isFile()) throw new Error(`보관 대상이 일반 파일이 아닙니다: ${source}`);
      indexed.push({ record, source, stat });
    }

    let metadataByPath = new Map();
    if (indexed.length) {
      let stdout;
      try {
        ({ stdout } = await execFileAsync(exiftoolPath, [
          '-json', '-n', '-DateTimeOriginal', '-CreateDate', '-MediaCreateDate', '-Duration#',
          ...indexed.map(({ source }) => source),
        ], { maxBuffer: 32 * 1024 * 1024 }));
      } catch (error) {
        if (!error.stdout) throw error;
        stdout = error.stdout;
        output.error(`[media-archive] exiftool 일부 파일 경고: ${error.message}`);
      }
      const metadata = JSON.parse(stdout);
      if (!Array.isArray(metadata)) throw new Error('exiftool JSON 배열이 아닙니다');
      metadataByPath = new Map(metadata.map((item) => [item.SourceFile, item]));
      for (const { source } of indexed) {
        if (!metadataByPath.has(source)) throw new Error(`exiftool 메타데이터 누락: ${source}`);
      }
    }

    const summary = { changed: 0, byKind: {}, moves: [], pendingCleanup: apply ? 0 : pendingCleanup.length };
    const changes = [];
    for (const { record, source, stat } of indexed) {
      const file = { path: join(mediaRoot, record.inboxPath), stat };
      const captured = capturedTime(file, metadataByPath.get(source));
      const capturedAt = kstIso(captured.date);
      const currentMonth = record.archivePath.match(/^Archive\/(\d{4})\/(\d{2})\//);
      if (!currentMonth) throw new Error(`색인 보관 경로 형식 오류: ${record.archivePath}`);
      const move = currentMonth[1] !== capturedAt.slice(0, 4) || currentMonth[2] !== capturedAt.slice(5, 7);
      if (capturedAt === record.capturedAt && captured.from === record.capturedFrom
        && captured.confidence === record.capturedConfidence
        && captured.reason === record.capturedReason && !move) continue;
      if (capturedAt !== record.capturedAt) {
        summary.changed += 1;
        summary.byKind[record.kind] = (summary.byKind[record.kind] || 0) + 1;
      }
      const destination = move
        ? join(mediaRoot, 'Archive', capturedAt.slice(0, 4), capturedAt.slice(5, 7), record.kind, basename(source))
        : null;
      if (move) summary.moves.push({ from: record.archivePath, to: relative(mediaRoot, destination).split('\\').join('/') });
      changes.push({ record, source, stat, capturedAt, capturedFrom: captured.from,
        capturedConfidence: captured.confidence, capturedReason: captured.reason, destination });
    }

    if (apply && changes.length) {
      const createdLinks = [];
      let indexCommitted = false;
      try {
        for (const change of changes) {
          const before = await fs.lstat(change.source);
          if (!before.isFile() || before.dev !== change.stat.dev || before.ino !== change.stat.ino
            || before.size !== change.stat.size || before.mtimeMs !== change.stat.mtimeMs
            || (await sha256(change.source)).slice(0, 16) !== change.record.id) {
            throw new Error(`색인 보관 파일이 검사 중 변경되었습니다: ${change.source}`);
          }
          if (!change.destination) continue;
          await fs.mkdir(dirname(change.destination), { recursive: true });
          const result = await archiveLink({ path: change.source, stat: change.stat }, change.destination,
            null, link, { sameInodeOnly: true });
          change.newPath = result.target;
          if (result.created) createdLinks.push(result.target);
        }
        for (const change of changes) {
          const current = await fs.lstat(change.source);
          if (!current.isFile() || current.dev !== change.stat.dev || current.ino !== change.stat.ino
            || current.size !== change.stat.size || current.mtimeMs !== change.stat.mtimeMs) {
            throw new Error(`링크 생성 중 보관 파일이 변경되었습니다: ${change.source}`);
          }
        }
        for (const change of changes) {
          change.record.capturedAt = change.capturedAt;
          change.record.capturedFrom = change.capturedFrom;
          change.record.capturedConfidence = change.capturedConfidence;
          if (change.capturedReason) change.record.capturedReason = change.capturedReason;
          else delete change.record.capturedReason;
          if (change.newPath) {
            change.record.repairFrom = change.record.archivePath;
            change.record.archivePath = relative(mediaRoot, change.newPath).split('\\').join('/');
          }
        }
        writeAtomic(indexPath, indexContent());
        indexCommitted = true;
      } catch (error) {
        if (!indexCommitted) await Promise.all(createdLinks.map((path) => fs.unlink(path)));
        throw error;
      }
      // 색인이 새 링크를 가리킨 뒤에만 이전 링크를 제거한다.
      for (const change of changes) {
        if (change.newPath) {
          await fs.unlink(change.source);
          delete change.record.repairFrom;
        }
      }
      writeAtomic(indexPath, indexContent());
    }

    output.log(`[media-archive] repair ${apply ? 'apply' : 'dry-run'}: 시각 변경 ${summary.changed}, 종류별 ${JSON.stringify(summary.byKind)}, 월 폴더 이동 ${summary.moves.length}, 정리 대기 ${summary.pendingCleanup}`);
    for (const move of summary.moves) output.log(`[media-archive] 이동: ${move.from} -> ${move.to}`);
    return summary;
  };
  return apply ? withLock(indexPath, repair, { retries: 1200, retryDelayMs: 100 }) : repair();
}

export async function runMediaArchive({
  mediaRoot = join(homedir(), 'Pantheon', 'Media'),
  indexPath = VAULT_PATHS.mediaArchiveIndex,
  vaultRoot = VAULT_PATHS.root,
  exiftoolPath = '/opt/homebrew/bin/exiftool',
  now = new Date(),
  dryRun = false,
  allowBulkTrash = false,
  link = fs.link,
  atomicWrite = writeAtomic,
  output = console,
} = {}) {
  const summary = { archived: 0, skipped: 0, failed: 0, trashIgnored: 0, trashedNew: 0,
    trashedExisting: 0, trashedOrphan: 0, orphanCalls: 0, cleanedTrash: 0, trashedByContact: {},
    capturedFrom: { exif: 0, filename: 0, mtime: 0 },
    capturedConfidence: { confirmed: 0, single: 0, estimated: 0, review: 0 } };
  await fs.stat(mediaRoot); // 마운트가 빠졌다면 빈 Inbox로 오인하지 않고 잡 실패를 알린다.
  const files = await collectFiles(mediaRoot, now);
  // 대량 차단 판단 전에는 색인 복구도 쓰기이므로 읽기 전용으로 파싱한다.
  const records = await readIndexRecords(indexPath, { dryRun: true, allowIncomplete: !dryRun });
  let trashIds;
  try { trashIds = await trashedIds(mediaRoot); }
  catch (error) {
    summary.failed += 1;
    output.error(`[media-archive] 휴지통 ID 검사 실패: ${error.message}`);
    const cause = error.message.startsWith('심볼릭 링크 경로:') ? '심볼릭 링크 경로'
      : error.code ?? '휴지통 경로/형식 오류';
    collectWarning(`휴지통 ID 검사 실패: ${cause}`, {
      jobName: 'media-archive', warningCode: 'MEDIA_TRASH_IDS_UNREADABLE',
      subjectKey: 'trash-ids', kind: 'operational', severity: 'high',
    });
    return summary; // 휴지통 기록을 읽지 못하면 삭제 요청 파일을 다시 보관할 수 없다.
  }
  let people = null;
  const trashSkipped = [];
  try {
    const peopleDirectory = join(vaultRoot, VAULT_REL.people);
    if (!(await fs.lstat(peopleDirectory)).isDirectory()) throw new Error('인물 폴더가 일반 디렉터리가 아닙니다');
    people = loadPeople(vaultRoot, { strict: true });
    if (!people.some((person) => person.contacts.length)) throw new Error('연결된 phoneContacts가 비었습니다');
  } catch (error) {
    people = null;
    trashSkipped.push(`엄격 모드 건너뜀: ${error.message}`);
    output.error(`[media-archive] 통화 휴지통 ${trashSkipped.at(-1)}`);
  }
  let orphans = [];
  try {
    const found = await orphanCalls(mediaRoot, records, people, now);
    orphans = found.found;
    summary.orphanCalls = found.count;
  } catch (error) {
    summary.failed += 1;
    output.error(`[media-archive] 고아 통화 검사 실패: ${error.message}`);
  }
  const indexedInbox = new Set([...records.values()].map((record) => record.inboxPath));
  const newTrash = people ? files.filter((file) => file.kind === 'Calls'
    && parseCallFilename(basename(file.path))
    && !isLinkedCall(parseCallFilename(basename(file.path)).contact, people)
    && !indexedInbox.has(relative(mediaRoot, file.path).split('\\').join('/'))) : [];
  // 연락처별 급변 보호와 대량 차단은 보관 루프 전에 정한다. 붙잡힌 새 통화는 지우지 않고 보관한다
  // (인물 노트를 실수로 고친 동안 들어온 가족 통화가 Inbox 링크로만 남지 않게).
  const countByContact = new Map();
  const protectedContacts = new Set();
  let bulkBlocked = false;
  if (people) {
    for (const record of records.values()) {
      if (record.kind !== 'Calls') continue;
      const parsed = parseCallFilename(basename(record.archivePath));
      if (!parsed || isLinkedCall(parsed.contact, people)) continue;
      const key = contactKey(parsed.contact);
      countByContact.set(key, (countByContact.get(key) || 0) + 1);
    }
    if (!allowBulkTrash) {
      for (const [key, count] of countByContact) if (count > 3) protectedContacts.add(key);
    }
    for (let index = newTrash.length - 1; index >= 0; index -= 1) {
      const parsed = parseCallFilename(basename(newTrash[index].path));
      if (protectedContacts.has(contactKey(parsed.contact))) newTrash.splice(index, 1);
    }
    const existingPlanned = [...countByContact].filter(([key]) => !protectedContacts.has(key))
      .reduce((sum, [, count]) => sum + count, 0);
    if (!allowBulkTrash && newTrash.length + existingPlanned + orphans.length > MAX_TRASH_PER_RUN) {
      bulkBlocked = true;
      trashSkipped.push(`대량 이동 차단: ${newTrash.length + existingPlanned + orphans.length}건 (한도 ${MAX_TRASH_PER_RUN})`);
      summary.failed += 1;
      output.error(`[media-archive] 휴지통 ${trashSkipped.at(-1)}`);
      newTrash.length = 0;
    }
  }
  const activeFiles = files.filter((file) => !newTrash.includes(file));
  let metadataByPath = new Map();
  if (activeFiles.length) {
    try {
      let stdout;
      try {
        ({ stdout } = await execFileAsync(exiftoolPath, [
        '-json', '-n', '-DateTimeOriginal', '-CreateDate', '-MediaCreateDate', '-Duration#',
        '-GPSLatitude', '-GPSLongitude', ...activeFiles.map((file) => file.path),
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
      summary.failed += activeFiles.length;
      output.error(`[media-archive] exiftool 실패: ${error.message}`);
      activeFiles.length = 0;
    }
  }

  let indexDirty = false;
  for (const file of activeFiles) {
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
        summary.capturedConfidence[captured.confidence] += 1;
        continue;
      }
      if (trashIds.all.has(id)) {
        summary.trashIgnored += 1;
        output.log(`[media-archive] 휴지통 제외: ${relativeInbox} (${id})`);
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
          capturedAt: kst, capturedFrom: captured.from, capturedConfidence: captured.confidence,
          ...(captured.reason ? { capturedReason: captured.reason } : {}), size: file.stat.size,
          ...(gps ? { gps } : {}),
          archivedAt: kstIso(now),
        };
        records.set(id, record);
        indexDirty = true;
        if (created) summary.archived += 1;
        else summary.skipped += 1;
      }
      summary.capturedFrom[captured.from] += 1;
      summary.capturedConfidence[captured.confidence] += 1;
    } catch (error) {
      summary.failed += 1;
      output.error(`[media-archive] 실패: ${file.path}: ${error.message}`);
    }
  }
  // 보관 루프를 마친 뒤 휴지통만 별도로 처리한다. 보관 결과는 휴지통 실패와 무관하다.
  const trashDate = kstIso(now).slice(0, 10);
  const trashRoot = join(mediaRoot, 'Trash', trashDate);
  const trashCalls = join(trashRoot, 'Calls');
  const trashTranscripts = join(trashRoot, 'Transcripts');
  const manifestPath = join(trashRoot, 'manifest.jsonl');
  const candidates = [];
  const movedByContact = new Map();
  const reportedProtected = new Set();
  if (people && !bulkBlocked) {
    for (const record of records.values()) {
      if (record.kind !== 'Calls') continue;
      const parsed = parseCallFilename(basename(record.archivePath));
      if (!parsed || isLinkedCall(parsed.contact, people)) continue;
      const key = contactKey(parsed.contact);
      if (protectedContacts.has(key)) {
        // 연락처당 한 번만 사유·실패로 센다.
        if (!reportedProtected.has(key)) {
          reportedProtected.add(key);
          trashSkipped.push(`연락처별 기존 보관 통화 급변 보호: ${parsed.contact} ${countByContact.get(key)}건`);
          summary.failed += 1;
        }
        continue;
      }
      try {
        if (!/^Archive\/\d{4}\/\d{2}\/Calls\/[^/]+$/.test(record.archivePath)
          || !/^Inbox\/Calls\/(?:[^/]+\/)*[^/]+$/.test(record.inboxPath)
          || [...record.archivePath.split('/'), ...record.inboxPath.split('/')]
            .some((part) => part === '.' || part === '..')) throw new Error('통화 색인 경로 형식 오류');
        const archive = resolve(mediaRoot, record.archivePath);
        const inbox = resolve(mediaRoot, record.inboxPath);
        await noSymlinks(join(mediaRoot, 'Archive'), archive);
        await noSymlinks(join(mediaRoot, 'Inbox'), inbox);
        let source;
        try { source = await fs.lstat(archive); }
        catch (error) {
          if (error.code === 'ENOENT') {
            output.error(`[media-archive] 색인 보관 파일 없음, 이번 휴지통 이동 건너뜀: ${record.archivePath}`);
            summary.failed += 1;
            continue;
          }
          throw error;
        }
        if (!source.isFile() || !/^[a-f0-9]{16}$/i.test(record.id)
          || (await sha256(archive)).slice(0, 16) !== record.id) throw new Error('sha256/id 검증 실패');
        const transcriptRoot = join(vaultRoot, VAULT_REL.mediaTranscripts);
        let transcriptPaths = [];
        try {
          const years = await fs.readdir(transcriptRoot, { withFileTypes: true });
          transcriptPaths = years.filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
            .map((entry) => join(transcriptRoot, entry.name, `${record.id}.json`));
          for (const path of transcriptPaths) await noSymlinks(transcriptRoot, path);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        candidates.push({ record, archive, inbox, source, transcriptPaths, contact: parsed.contact });
      } catch (error) {
        summary.failed += 1;
        output.error(`[media-archive] 기존 통화 휴지통 검증 실패: ${record.id}: ${error.message}`);
      }
    }
  }
  let cleanup = [];
  if (people) {
    const latestArchivedAt = [...records.values()].map((record) => String(record.archivedAt || '').slice(0, 10))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().at(-1) || null;
    try { cleanup = await expiredTrashFolders(mediaRoot, now, { latestArchivedAt }); }
    catch (error) {
      summary.failed += 1;
      output.error(`[media-archive] 휴지통 정리 준비 실패: ${error.message}`);
    }
  }
  if (dryRun) {
    summary.trashedNew = newTrash.length;
    summary.trashedExisting = candidates.length;
    summary.trashedOrphan = bulkBlocked ? 0 : orphans.length;
    summary.cleanedTrash = cleanup.length;
    for (const file of newTrash) output.log(`[media-archive] dry-run 휴지통 새 통화: ${file.path}`);
    for (const item of candidates) output.log(`[media-archive] dry-run 휴지통 기존 통화: ${item.record.archivePath}`);
    for (const item of orphans) if (!bulkBlocked) output.log(`[media-archive] dry-run 휴지통 고아 통화: ${item.archive}`);
  } else {
    // 기존 보관 파일의 검증을 모두 마친 뒤 색인을 단 한 번 원자적으로 교체한다.
    for (const item of candidates) records.delete(item.record.id);
    let indexWriteOk = true;
    if (indexDirty || candidates.length) {
      try {
        await fs.mkdir(dirname(indexPath), { recursive: true });
        const lines = [...records.values()].map((record) => JSON.stringify(record));
        atomicWrite(indexPath, lines.length ? `${lines.join('\n')}\n` : '');
      } catch (error) {
        indexWriteOk = false;
        summary.failed += 1;
        output.error(`[media-archive] 색인 원자 쓰기 실패, 휴지통 단계 건너뜀: ${error.message}`);
      }
    }
    if (indexWriteOk) {
      for (const file of newTrash) {
        try {
          await noSymlinks(join(mediaRoot, 'Inbox'), file.path);
          const current = await fs.lstat(file.path);
          if (!current.isFile() || current.dev !== file.stat.dev || current.ino !== file.stat.ino
            || current.size !== file.stat.size || current.mtimeMs !== file.stat.mtimeMs) throw new Error('Inbox 파일 변경');
          await noSymlinks(join(mediaRoot, 'Trash'), trashCalls);
          await fs.mkdir(trashCalls, { recursive: true });
          await fs.rename(file.path, await uniqueTrashPath(trashCalls, basename(file.path)));
          summary.trashedNew += 1;
          const contact = parseCallFilename(basename(file.path)).contact;
          movedByContact.set(contact, (movedByContact.get(contact) || 0) + 1);
        } catch (error) {
          summary.failed += 1;
          output.error(`[media-archive] 새 통화 휴지통 실패: ${file.path}: ${error.message}`);
        }
      }
      for (const item of candidates) {
        const { record, archive, inbox, source, transcriptPaths } = item;
        try {
          const current = await fs.lstat(archive);
          if (!current.isFile() || current.dev !== source.dev || current.ino !== source.ino
            || current.size !== source.size || current.mtimeMs !== source.mtimeMs) throw new Error('보관 파일 변경');
          await noSymlinks(join(mediaRoot, 'Trash'), trashCalls);
          await fs.mkdir(trashCalls, { recursive: true });
          const destination = await uniqueTrashPath(trashCalls, basename(archive));
          const transcriptMoves = [];
          for (const path of transcriptPaths) {
            try {
              const transcriptStat = await fs.lstat(path);
              if (!transcriptStat.isFile()) throw new Error('전사 원본이 일반 파일이 아닙니다');
              await noSymlinks(join(mediaRoot, 'Trash'), trashTranscripts);
              await fs.mkdir(trashTranscripts, { recursive: true });
              const target = await uniqueTrashPath(trashTranscripts, basename(path));
              transcriptMoves.push({ path, target });
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          // 이동 전에 복구 경로를 기록한다. 중단되면 예정 경로를 따라 수동 복구할 수 있다.
          await noSymlinks(join(mediaRoot, 'Trash'), manifestPath);
          await fs.appendFile(manifestPath, `${JSON.stringify({ record,
            trashPath: relative(mediaRoot, destination).split('\\').join('/'),
            transcripts: transcriptMoves.map(({ target }) => relative(mediaRoot, target).split('\\').join('/')) })}\n`);
          await fs.rename(archive, destination);
          summary.trashedExisting += 1;
          movedByContact.set(item.contact, (movedByContact.get(item.contact) || 0) + 1);
          for (const { path, target } of transcriptMoves) await fs.rename(path, target);
          // 동일한 하드링크인 Inbox만 제거한다. 다른 inode로 교체된 파일은 보존한다.
          try {
            const inboxStat = await fs.lstat(inbox);
            if (inboxStat.isFile() && inboxStat.dev === source.dev && inboxStat.ino === source.ino) await fs.unlink(inbox);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        } catch (error) {
          summary.failed += 1;
          output.error(`[media-archive] 기존 통화 휴지통 실패: ${record.id}: ${error.message}`);
        }
      }
      if (!bulkBlocked) for (const item of orphans) {
        try {
          if (records.has(item.id)) continue;
          await noSymlinks(join(mediaRoot, 'Archive'), item.archive);
          await noSymlinks(join(mediaRoot, 'Trash'), item.target);
          const source = await fs.lstat(item.archive);
          if (!source.isFile() || (await sha256(item.archive)).slice(0, 16) !== item.id) {
            throw new Error('고아 통화 원본 sha256/id 검증 실패');
          }
          try {
            const target = await fs.lstat(item.target);
            if (!target.isFile() || !await sameContent(item.target, source, await sha256(item.archive))) {
              throw new Error('휴지통 대상 내용 충돌');
            }
            await fs.unlink(item.archive);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await fs.mkdir(dirname(item.target), { recursive: true });
            await fs.rename(item.archive, item.target);
          }
          summary.trashedOrphan += 1;
        } catch (error) {
          summary.failed += 1;
          output.error(`[media-archive] 고아 통화 이동 건너뜀: ${item.archive}: ${error.message}`);
        }
      }
      for (const directory of cleanup) {
        try {
          await noSymlinks(join(mediaRoot, 'Trash'), directory);
          const pendingIds = new Set();
          const items = (await trashRecords(join(directory, 'manifest.jsonl'), join(mediaRoot, 'Trash')))
            .filter(({ record }) => {
              const id = record.id.toLowerCase();
              if (trashIds.purged.has(id) || pendingIds.has(id)) return false;
              pendingIds.add(id);
              return true;
            });
          if (items.length) {
            const purged = join(mediaRoot, 'Trash', 'purged.jsonl');
            await noSymlinks(join(mediaRoot, 'Trash'), purged);
            let previous = '';
            try { previous = await fs.readFile(purged, 'utf8'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            await fs.appendFile(purged, (previous && !previous.endsWith('\n') ? '\n' : '')
              + items.map(({ record, trashPath }) => JSON.stringify({
              id: record.id, kind: record.kind, inboxPath: record.inboxPath, trashPath,
              purgedAt: kstIso(now),
            })).join('\n') + '\n');
            for (const id of pendingIds) trashIds.purged.add(id);
          }
          await fs.rm(directory, { recursive: true });
          summary.cleanedTrash += 1;
        } catch (error) {
          summary.failed += 1;
          output.error(`[media-archive] 휴지통 정리 실패: ${directory}: ${error.message}`);
        }
      }
      summary.trashedByContact = Object.fromEntries(movedByContact);
    }
  }
  if (trashSkipped.length) output.log(`[media-archive] 통화 휴지통 ${trashSkipped.join(' / ')}`);
  output.log(`[media-archive] ${dryRun ? 'dry-run ' : ''}새로 보관 ${summary.archived}, 건너뜀 ${summary.skipped}, 실패 ${summary.failed}; 근거 exif ${summary.capturedFrom.exif}, filename ${summary.capturedFrom.filename}, mtime ${summary.capturedFrom.mtime}; 판정 confirmed ${summary.capturedConfidence.confirmed}, single ${summary.capturedConfidence.single}, estimated ${summary.capturedConfidence.estimated}, review ${summary.capturedConfidence.review}; 휴지통 ${summary.trashedNew + summary.trashedExisting + summary.trashedOrphan}(새 ${summary.trashedNew}·기존 ${summary.trashedExisting}·고아 이동 ${summary.trashedOrphan}), 휴지통 제외 ${summary.trashIgnored}, 고아 통화 ${summary.orphanCalls}건, 휴지통 정리 ${summary.cleanedTrash}폴더`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--dry-run', '--repair-times', '--apply', '--allow-bulk-trash'].includes(arg))
    || (args.includes('--apply') && !args.includes('--repair-times'))
    || (args.includes('--dry-run') && args.includes('--apply'))
    || (args.includes('--repair-times') && args.includes('--allow-bulk-trash'))) {
    console.error('usage: node scripts/jobs/media-archive.mjs [--dry-run] [--allow-bulk-trash] | [--repair-times [--apply]]');
    process.exitCode = 2;
  } else {
    (async () => {
      if (args.includes('--repair-times')) return repairMediaArchiveTimes({ apply: args.includes('--apply') });
      const dryRun = args.includes('--dry-run');
      const allowBulkTrash = args.includes('--allow-bulk-trash');
      if (dryRun) return runMediaArchive({ dryRun, allowBulkTrash });
      await fs.mkdir(dirname(VAULT_PATHS.mediaArchiveIndex), { recursive: true });
      const summary = await withLock(VAULT_PATHS.mediaArchiveIndex,
        () => runMediaArchive({ allowBulkTrash }), { retries: 1200, retryDelayMs: 100 });
      for (const [contact, count] of Object.entries(summary.trashedByContact)) {
        collectWarning(`통화 휴지통 이동: ${contact} ${count}건`, {
          jobName: 'media-archive', warningCode: 'CALL_TRASH_MOVED',
          subjectKey: `contact:${createHash('sha256').update(contact).digest('hex').slice(0, 20)
            .replace(/[0-9a-f]/g, (digit) => 'abcdefghijklmnop'[parseInt(digit, 16)])}`,
          kind: 'operational', severity: 'medium',
        });
      }
      // 경보 발송 실패는 이미 끝난 보관·휴지통 결과를 실패로 바꾸지 않는다.
      try { await flushWarnings('media-archive'); }
      catch (error) { console.error(`[media-archive] 경보 발송 실패: ${error.message}`); }
      return summary;
    })()
      .then((summary) => { if (summary.failed) process.exitCode = 1; })
      .catch((error) => { console.error(`[media-archive] ${error.stack}`); process.exitCode = 1; });
  }
}
