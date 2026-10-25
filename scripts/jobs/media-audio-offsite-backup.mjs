#!/usr/bin/env node
// 통화·녹음 원본 암호화 외부 백업(2026-10-13 오너 결정: 볼트 외부 백업 D88과 같은 방식, 새 파일만 추가).
// - 파일마다 AES-256-GCM(볼트 백업 키) → 구글 드라이브 앱 전용 폴더. 원격 이름은 `pantheon-audio-{id}.enc`(상대·내용 비노출).
// - 매일 밤 드라이브 목록과 대조해 빠진 것만 올린다(회당 용량 상한으로 첫 백업은 며칠에 나눔).
// - 휴지통 영구 삭제 목록(purged.jsonl)에 오른 ID는 드라이브에서도 지운다(오너가 지운 녹음이 백업에만 남지 않게).
// 음성은 암호화된 상태로만 나간다. 사진·영상은 구글 포토에 이미 백업돼 대상이 아니다.
import { readFile, stat, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, MEDIA_AUDIO_BACKUP_PATHS } from '../lib/vault-paths.mjs';
import { DRIVE_BACKUP_SCOPES, getAccessToken } from '../lib/google-oauth.mjs';
import { decryptBuffer, deleteBackup, downloadBackup, encryptBuffer, findOrCreateFolder, generateFileId, getBackupMetadata, listFiles, uploadBackup } from '../lib/vault-offsite-backup.mjs';
import { withLock } from '../lib/state-writer.mjs';
import { keyPath } from '../tools/vault-backup-keygen.mjs';

export const AUDIO_APP_PROPERTY = Object.freeze({ pantheon: 'audio-backup' });
export const AUDIO_FOLDER_NAME = 'Pantheon Audio Backups';
export const AUDIO_NAME = /^pantheon-audio-([a-f0-9]{16})\.enc$/;
export const RUN_BYTE_CAP = 400 * 1024 * 1024;
const MAX_UPLOAD_ATTEMPTS = 3;
const INTENT_DIR = fileURLToPath(new URL('../.cache/media-audio-offsite-backup/', import.meta.url));
const INTENT_FS = { mkdir, open, rename, unlink };

function intentPath(id, directory) { return join(directory, `${id}.intent`); }

async function readUploadIntent(id, directory) {
  let content;
  try { content = await readFile(intentPath(id, directory)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const separator = content.indexOf(10);
  if (separator < 0) throw new Error(`업로드 의도 파일 손상: ${id}`);
  const header = JSON.parse(content.subarray(0, separator).toString('utf8'));
  if (header.audioId !== id || !header.id || !header.folderId || !AUDIO_NAME.test(header.name))
    throw new Error(`업로드 의도 파일 손상: ${id}`);
  const blob = content.subarray(separator + 1);
  if (header.completed) {
    if (blob.length || !Number.isSafeInteger(header.blobSize) || header.blobSize <= 0
      || !/^[a-f0-9]{32}$/.test(header.blobMd5)
      || !/^[a-f0-9]{64}$/.test(header.appProperties?.blobSha256))
      throw new Error(`업로드 완료 기록 손상: ${id}`);
  } else if (!blob.length || createHash('sha256').update(blob).digest('hex') !== header.appProperties?.blobSha256)
    throw new Error(`업로드 의도 파일 손상: ${id}`);
  return { ...header, blob };
}

async function writeUploadIntent(intent, directory, fs = INTENT_FS) {
  const intentDirectory = resolve(directory);
  await fs.mkdir(intentDirectory, { recursive: true, mode: 0o700 });
  const tempPath = `${intentPath(intent.audioId, intentDirectory)}.${randomUUID()}.tmp`;
  const { blob = Buffer.alloc(0), ...header } = intent;
  try {
    // 이전 실행에서 mkdir 뒤 sync가 실패했을 수도 있으므로 매번 조상 디렉터리도 확정한다.
    for (let path = dirname(intentDirectory); ; path = dirname(path)) {
      const parent = await fs.open(path, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
      if (path === dirname(path)) break;
    }
    const temp = await fs.open(tempPath, 'wx', 0o600);
    try {
      await temp.writeFile(Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), blob]));
      await temp.sync();
    } finally { await temp.close(); }
    await fs.rename(tempPath, intentPath(intent.audioId, intentDirectory));
    // macOS에서는 디렉터리도 열어 sync할 수 있다. 실패 시 POST하지 않고 의도를 재확인한다.
    const parent = await fs.open(intentDirectory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function deleteUploadIntent(id, directory) {
  await unlink(intentPath(id, directory));
}

function isTransientUploadError(error) {
  return error.status === 429 || (error.status >= 500 && error.status <= 599)
    || error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'TypeError';
}

function isExactUploadedCopy(file, { id, name, folderId, appProperties, blob, blobSize, blobMd5 }) {
  return file?.id === id && file.name === name && file.parents?.length === 1
    && file.parents[0] === folderId && file.appProperties?.pantheon === appProperties.pantheon
    && file.appProperties?.kind === appProperties.kind
    && file.appProperties?.blobSha256 === appProperties.blobSha256
    && Number(file.size) === (blobSize ?? blob.length)
    && file.md5Checksum === (blobMd5 ?? createHash('md5').update(blob).digest('hex'));
}

async function uploadAudioWithReconciliation(io, { token, intent, checkExisting = false }) {
  // Drive의 사전 발급 ID를 모든 POST에 재사용하면 응답이 유실돼도 중복 파일을 만들지 않는다.
  const { id, folderId, name, blob, appProperties } = intent;
  const args = { token, folderId, name, blob, id, appProperties,
    blobSize: intent.blobSize, blobMd5: intent.blobMd5, namePattern: AUDIO_NAME };
  if (checkExisting) {
    try {
      const remote = await io.getBackupMetadata({ token, id });
      if (!isExactUploadedCopy(remote, args)) throw new Error('업로드 상태 불명확: 기존 원격 파일 불일치');
      return remote;
    } catch (error) { if (error.status !== 404 || intent.completed) throw error; }
  }
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const uploaded = await io.uploadBackup(args);
      if (!isExactUploadedCopy(uploaded, args)) throw new Error('업로드 응답의 원격 파일 불일치');
      return uploaded;
    } catch (error) {
      if (!isTransientUploadError(error) && error.status !== 409) throw error;
      let remote;
      try { remote = await io.getBackupMetadata({ token, id }); }
      catch (lookupError) {
        if (lookupError.status !== 404) throw lookupError;
      }
      if (remote) {
        if (!isExactUploadedCopy(remote, args)) throw new Error('업로드 상태 불명확: 같은 ID의 원격 파일 불일치');
        return remote;
      }
      if (error.status === 409 || attempt === MAX_UPLOAD_ATTEMPTS) throw error;
      await io.delay(500 * 2 ** (attempt - 1));
    }
  }
}

export function audioRecords(indexText) {
  return indexText.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => ['Calls', 'Recordings'].includes(row.kind) && /^[a-f0-9]{16}$/.test(row.id)
      && typeof row.archivePath === 'string' && row.archivePath.startsWith('Archive/'));
}

export function purgedIds(text) {
  const ids = new Set();
  for (const line of String(text || '').trim().split('\n')) {
    try { const item = JSON.parse(line); if (/^[a-f0-9]{16}$/i.test(item.id)) ids.add(item.id.toLowerCase()); } catch { /* 끊긴 줄 무시 */ }
  }
  return ids;
}

// 올릴 것: 원격에 없는 ID, 최근 보관 순, 회당 바이트 상한. 상한보다 큰 한 파일은 그 파일만 단독으로 올린다.
export function planUploads(records, remoteIds, sizes, cap = RUN_BYTE_CAP) {
  const pending = records.filter((row) => !remoteIds.has(row.id))
    .sort((a, b) => String(b.archivedAt || '').localeCompare(String(a.archivedAt || '')));
  const chosen = [];
  let total = 0;
  for (const row of pending) {
    const size = sizes.get(row.id) ?? row.size ?? 0;
    if (chosen.length && total + size > cap) continue;
    chosen.push(row);
    total += size;
    if (total >= cap) break;
  }
  return { chosen, pending: pending.length, bytes: total };
}

function insideArchive(mediaRoot, archivePath) {
  const base = resolve(mediaRoot, 'Archive');
  const path = resolve(mediaRoot, archivePath);
  const inside = relative(base, path);
  if (!inside || inside.startsWith('..') || inside.startsWith(sep)) throw new Error('Archive 경로 오류');
  return path;
}

async function readKey(io) {
  const path = io.keyPath();
  let info;
  try { info = await io.stat(path); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('백업 키 없음 — vault-backup-keygen 실행');
    throw new Error(`백업 키 읽기 실패(${error.code ?? error.message})`);
  }
  if ((info.mode & 0o077) !== 0) throw new Error('백업 키 권한 오류: 소유자만 접근 가능해야 함');
  const key = await io.readFile(path);
  if (key.length !== 32) throw new Error('백업 키 길이 오류');
  return key;
}

async function audioFolder(io, token) {
  // 첫 실행이 겹쳐 폴더가 둘 생기면 삭제 반영이 한쪽에만 될 수 있어 멈춘다.
  const folders = (await io.listFiles({ token, appProperties: AUDIO_APP_PROPERTY }))
    .filter((file) => file.appProperties?.pantheon === AUDIO_APP_PROPERTY.pantheon && file.mimeType === 'application/vnd.google-apps.folder');
  if (folders.length > 1) throw new Error(`오디오 백업 폴더가 ${folders.length}개 — 하나로 정리 필요`);
  return folders[0] ?? io.findOrCreateFolder({ token, appProperties: AUDIO_APP_PROPERTY, folderName: AUDIO_FOLDER_NAME });
}

// 복원 확인: 원격 파일을 받아 복호화하고 원본 sha256과 비교한다.
export async function verify(id, dependencies = {}) {
  const io = { readFile, stat, getAccessToken, listFiles, findOrCreateFolder, downloadBackup, decryptBuffer, keyPath,
    indexPath: VAULT_PATHS.mediaArchiveIndex, paths: MEDIA_AUDIO_BACKUP_PATHS, log: console.log, ...dependencies };
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('ID 형식 오류');
  const key = await readKey(io);
  const record = audioRecords(await io.readFile(io.indexPath, 'utf8')).find((row) => row.id === id);
  if (!record) throw new Error('색인에 없는 ID');
  const token = await io.getAccessToken({ requiredScopes: DRIVE_BACKUP_SCOPES });
  const folder = await audioFolder(io, token);
  const remote = (await io.listFiles({ token, folderId: folder.id, appProperties: AUDIO_APP_PROPERTY }))
    .find((file) => file.name === `pantheon-audio-${id}.enc`);
  if (!remote) throw new Error('원격에 없음');
  const plain = io.decryptBuffer(await io.downloadBackup({ token, id: remote.id }), key);
  const original = await io.readFile(insideArchive(io.paths.mediaRoot, record.archivePath));
  const same = createHash('sha256').update(plain).digest('hex') === createHash('sha256').update(original).digest('hex');
  io.log(`[media-audio-offsite-backup] 복원 확인 ${id}: ${same ? '원본과 일치' : '불일치'} (${plain.length} bytes)`);
  if (!same) throw new Error('복원본이 원본과 다름');
  return true;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const io = { readFile, stat, lstat, getAccessToken, encryptBuffer, findOrCreateFolder, listFiles, generateFileId,
    getBackupMetadata, uploadBackup, deleteBackup,
    readIntent: (id) => readUploadIntent(id, dependencies.intentDir ?? INTENT_DIR),
    writeIntent: (intent) => writeUploadIntent(intent, dependencies.intentDir ?? INTENT_DIR,
      dependencies.intentFs ?? INTENT_FS),
    deleteIntent: (id) => deleteUploadIntent(id, dependencies.intentDir ?? INTENT_DIR),
    delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    keyPath, indexPath: VAULT_PATHS.mediaArchiveIndex, paths: MEDIA_AUDIO_BACKUP_PATHS, cap: RUN_BYTE_CAP,
    lock: (fn) => withLock(join(MEDIA_AUDIO_BACKUP_PATHS.mediaRoot, '.audio-backup'), fn, { retries: 0 }),
    log: console.log, ...dependencies };
  if (argv[0] === '--verify' && argv.length === 2) return verify(argv[1], dependencies);
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--dry-run')) throw new Error('사용법: media-audio-offsite-backup.mjs [--dry-run] | --verify <id>');
  const dryRun = argv.includes('--dry-run');
  return dryRun ? run(io, true) : io.lock(() => run(io, false));
}

async function run(io, dryRun) {
  const key = await readKey(io);
  const records = audioRecords(await io.readFile(io.indexPath, 'utf8'));
  let purgedText = '';
  try { purgedText = await io.readFile(io.paths.purged, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const purged = purgedIds(purgedText);
  const token = dryRun ? null : await io.getAccessToken({ requiredScopes: DRIVE_BACKUP_SCOPES });
  const folder = dryRun ? null : await audioFolder(io, token);
  const allRemote = dryRun ? [] : await io.listFiles({ token, folderId: folder.id, appProperties: AUDIO_APP_PROPERTY });
  const remote = allRemote
    .filter((file) => file.appProperties?.pantheon === AUDIO_APP_PROPERTY.pantheon && AUDIO_NAME.test(file.name));
  const live = records.filter((row) => !purged.has(row.id));
  const intents = new Map();
  if (!dryRun) {
    for (const row of live) {
      const intent = await io.readIntent(row.id);
      if (intent) intents.set(row.id, intent);
    }
  }
  const invalidExisting = new Set();
  for (const row of live) {
    if (intents.has(row.id)) continue;
    const sameName = allRemote.filter((file) => file.name === `pantheon-audio-${row.id}.enc`);
    if (sameName.length && (sameName.length !== 1
      || sameName[0].appProperties?.pantheon !== AUDIO_APP_PROPERTY.pantheon
      || sameName[0].appProperties?.kind !== row.kind
      || !sameName[0].parents?.includes(folder.id)
      || !Number.isFinite(row.size)
      || !Number.isFinite(Number(sameName[0].size))
      || Number(sameName[0].size) !== row.size + 32)) invalidExisting.add(row.id);
  }
  const remoteIds = new Set(allRemote.map((file) => AUDIO_NAME.exec(file.name)?.[1])
    .filter((id) => id && !intents.has(id)));
  const unverifiedCompleted = new Set();
  for (const row of live) {
    const intent = intents.get(row.id);
    if (!intent?.completed) continue;
    if (intent.folderId !== folder.id || intent.name !== `pantheon-audio-${row.id}.enc`
      || intent.appProperties?.kind !== row.kind) {
      unverifiedCompleted.add(row.id);
      continue;
    }
    const sameNameFiles = allRemote.filter((file) => file.name === intent.name);
    if (sameNameFiles.length !== 1 || sameNameFiles[0].id !== intent.id) {
      unverifiedCompleted.add(row.id);
      continue;
    }
    try {
      const copy = await io.getBackupMetadata({ token, id: intent.id });
      if (isExactUploadedCopy(copy, intent)) remoteIds.add(row.id);
      else unverifiedCompleted.add(row.id);
    } catch { unverifiedCompleted.add(row.id); }
  }
  const pending = live.filter((row) => !remoteIds.has(row.id)).length;
  const { chosen, bytes } = planUploads(live.filter((row) => !unverifiedCompleted.has(row.id)),
    remoteIds, new Map(), io.cap);
  const summary = { uploaded: 0, bytes: 0, deleted: 0,
    failed: invalidExisting.size + unverifiedCompleted.size, skipped: 0, pending, remote: remote.length };
  if (dryRun) {
    io.log(`dry-run: 대상 ${live.length}, 원격 ${remote.length}, 이번 회차 ${chosen.length}건 ${(bytes / 1048576).toFixed(1)}MB, 남음 ${pending - chosen.length}`);
    return summary;
  }
  for (const id of invalidExisting) io.log(`[media-audio-offsite-backup] ${id}: 원격 사본 메타데이터 불일치`);
  for (const id of unverifiedCompleted) io.log(`[media-audio-offsite-backup] ${id}: 완료된 원격 사본 확인 실패`);
  for (const row of chosen) {
    try {
      const name = `pantheon-audio-${row.id}.enc`;
      let intent = intents.get(row.id);
      if (intent) {
        if (intent.folderId !== folder.id || intent.name !== name || intent.appProperties?.kind !== row.kind)
          throw new Error('기존 업로드 의도와 현재 대상 불일치');
        if (!intent.completed) await io.writeIntent(intent);
      } else {
        const path = insideArchive(io.paths.mediaRoot, row.archivePath);
        const info = await io.lstat(path);
        if (!info.isFile()) throw new Error('일반 파일 아님');
        const blob = io.encryptBuffer(await io.readFile(path), key);
        intent = { audioId: row.id, id: await io.generateFileId({ token }), folderId: folder.id, name, blob,
          appProperties: { ...AUDIO_APP_PROPERTY, kind: row.kind,
            blobSha256: createHash('sha256').update(blob).digest('hex') } };
        await io.writeIntent(intent);
      }
      const sameNameFiles = allRemote.filter((file) => file.name === name);
      if (sameNameFiles.some((file) => file.id !== intent.id) || sameNameFiles.length > 1)
        throw new Error('같은 이름의 다른 원격 사본 존재');
      if (intent.completed && sameNameFiles.length !== 1)
        throw new Error('완료된 원격 사본이 목록에 없음');
      await uploadAudioWithReconciliation(io, { token, intent, checkExisting: intents.has(row.id) });
      if (!intent.completed) {
        await io.writeIntent({ ...intent, completed: true, blobSize: intent.blob.length,
          blobMd5: createHash('md5').update(intent.blob).digest('hex'), blob: Buffer.alloc(0) });
        summary.uploaded += 1; summary.bytes += intent.blob.length;
      } else summary.skipped += 1;
    } catch (error) {
      // 보관 잡이 방금 휴지통으로 옮긴 파일은 실패가 아니라 건너뜀. 로그에는 경로(상대 이름) 대신 ID·코드만.
      if (error.code === 'ENOENT') { summary.skipped += 1; continue; }
      summary.failed += 1;
      io.log(`[media-audio-offsite-backup] ${row.id}: ${error.code ?? error.message.split(':')[0]}`);
    }
  }
  const purgedIntents = new Map();
  const unreadableIntents = new Set();
  for (const id of purged) {
    try {
      const intent = await io.readIntent(id);
      if (intent) purgedIntents.set(id, intent);
    } catch (error) {
      unreadableIntents.add(id);
      summary.failed += 1;
      io.log(`[media-audio-offsite-backup] 의도 확인 ${id}: ${error.message}`);
    }
  }
  for (const file of remote) {
    const id = AUDIO_NAME.exec(file.name)[1];
    if (!purged.has(id) || purgedIntents.has(id) || unreadableIntents.has(id)) continue;
    try {
      await io.deleteBackup({ token, folderId: folder.id, file, appProperties: AUDIO_APP_PROPERTY, namePattern: AUDIO_NAME });
      summary.deleted += 1;
    } catch (error) { summary.failed += 1; io.log(`[media-audio-offsite-backup] 삭제 ${file.name}: ${error.message}`); }
  }
  for (const [id, intent] of purgedIntents) {
    try {
      if (intent.folderId !== folder.id || intent.name !== `pantheon-audio-${id}.enc`
        || allRemote.some((file) => file.name === intent.name && file.id !== intent.id))
        throw new Error('삭제 대상과 업로드 의도 불일치');
      let file;
      try { file = await io.getBackupMetadata({ token, id: intent.id }); }
      catch (error) { if (error.status !== 404) throw error; }
      if (!file) {
        if (allRemote.some((remoteFile) => remoteFile.name === intent.name))
          throw new Error('삭제 상태 불명확: 목록에 원격 사본 존재');
        await io.deleteIntent(id);
        summary.deleted += 1;
        continue;
      }
      if (!isExactUploadedCopy(file, intent)) throw new Error('삭제 대상 원격 사본 불일치');
      await io.deleteBackup({ token, folderId: folder.id, file, appProperties: AUDIO_APP_PROPERTY, namePattern: AUDIO_NAME });
      await io.deleteIntent(id);
      summary.deleted += 1;
    } catch (error) {
      summary.failed += 1;
      io.log(`[media-audio-offsite-backup] 삭제 ${id}: ${error.message}`);
    }
  }
  io.log(`[media-audio-offsite-backup] 올림 ${summary.uploaded}건 ${(summary.bytes / 1048576).toFixed(1)}MB, 영구 삭제 반영 ${summary.deleted}, 건너뜀 ${summary.skipped}, 실패 ${summary.failed}, 남음 ${pending - summary.uploaded}`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((summary) => { if (summary?.failed) process.exitCode = 1; })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
