#!/usr/bin/env node
// 통화·녹음 원본 암호화 외부 백업(2026-10-13 오너 결정: 볼트 외부 백업 D88과 같은 방식, 새 파일만 추가).
// - 파일마다 AES-256-GCM(볼트 백업 키) → 구글 드라이브 앱 전용 폴더. 원격 이름은 `pantheon-audio-{id}.enc`(상대·내용 비노출).
// - 매일 밤 드라이브 목록과 대조해 빠진 것만 올린다(회당 용량 상한으로 첫 백업은 며칠에 나눔).
// - 휴지통 영구 삭제 목록(purged.jsonl)에 오른 ID는 드라이브에서도 지운다(오너가 지운 녹음이 백업에만 남지 않게).
// 음성은 암호화된 상태로만 나간다. 사진·영상은 구글 포토에 이미 백업돼 대상이 아니다.
import { readFile, stat, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, MEDIA_AUDIO_BACKUP_PATHS } from '../lib/vault-paths.mjs';
import { DRIVE_BACKUP_SCOPES, getAccessToken } from '../lib/google-oauth.mjs';
import { decryptBuffer, deleteBackup, downloadBackup, encryptBuffer, findOrCreateFolder, listFiles, uploadBackup } from '../lib/vault-offsite-backup.mjs';
import { withLock } from '../lib/state-writer.mjs';
import { keyPath } from '../tools/vault-backup-keygen.mjs';

export const AUDIO_APP_PROPERTY = Object.freeze({ pantheon: 'audio-backup' });
export const AUDIO_FOLDER_NAME = 'Pantheon Audio Backups';
export const AUDIO_NAME = /^pantheon-audio-([a-f0-9]{16})\.enc$/;
export const RUN_BYTE_CAP = 400 * 1024 * 1024;

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
  const io = { readFile, stat, lstat, getAccessToken, encryptBuffer, findOrCreateFolder, listFiles, uploadBackup, deleteBackup,
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
  const remote = dryRun ? [] : (await io.listFiles({ token, folderId: folder.id, appProperties: AUDIO_APP_PROPERTY }))
    .filter((file) => file.appProperties?.pantheon === AUDIO_APP_PROPERTY.pantheon && AUDIO_NAME.test(file.name));
  const remoteIds = new Set(remote.map((file) => AUDIO_NAME.exec(file.name)[1]));
  const live = records.filter((row) => !purged.has(row.id));
  const { chosen, pending, bytes } = planUploads(live, remoteIds, new Map(), io.cap);
  const summary = { uploaded: 0, bytes: 0, deleted: 0, failed: 0, skipped: 0, pending, remote: remote.length };
  if (dryRun) {
    io.log(`dry-run: 대상 ${live.length}, 원격 ${remote.length}, 이번 회차 ${chosen.length}건 ${(bytes / 1048576).toFixed(1)}MB, 남음 ${pending - chosen.length}`);
    return summary;
  }
  for (const row of chosen) {
    try {
      const path = insideArchive(io.paths.mediaRoot, row.archivePath);
      const info = await io.lstat(path);
      if (!info.isFile()) throw new Error('일반 파일 아님');
      const blob = io.encryptBuffer(await io.readFile(path), key);
      const name = `pantheon-audio-${row.id}.enc`;
      const uploaded = await io.uploadBackup({ token, folderId: folder.id, name, blob,
        appProperties: { ...AUDIO_APP_PROPERTY, kind: row.kind }, namePattern: AUDIO_NAME });
      if (Number(uploaded.size) !== blob.length) {
        // 검증 실패 사본을 남기면 다음 회차가 이름만 보고 백업 완료로 여긴다 — 지우고 다음에 다시 올린다.
        await io.deleteBackup({ token, folderId: folder.id, file: { ...uploaded, parents: uploaded.parents ?? [folder.id],
          appProperties: uploaded.appProperties ?? { ...AUDIO_APP_PROPERTY } }, appProperties: AUDIO_APP_PROPERTY, namePattern: AUDIO_NAME });
        throw new Error('업로드 후 원격 파일 크기 불일치(원격 사본 삭제)');
      }
      summary.uploaded += 1; summary.bytes += blob.length;
    } catch (error) {
      // 보관 잡이 방금 휴지통으로 옮긴 파일은 실패가 아니라 건너뜀. 로그에는 경로(상대 이름) 대신 ID·코드만.
      if (error.code === 'ENOENT') { summary.skipped += 1; continue; }
      summary.failed += 1;
      io.log(`[media-audio-offsite-backup] ${row.id}: ${error.code ?? error.message.split(':')[0]}`);
    }
  }
  for (const file of remote) {
    if (!purged.has(AUDIO_NAME.exec(file.name)[1])) continue;
    try {
      await io.deleteBackup({ token, folderId: folder.id, file, appProperties: AUDIO_APP_PROPERTY, namePattern: AUDIO_NAME });
      summary.deleted += 1;
    } catch (error) { summary.failed += 1; io.log(`[media-audio-offsite-backup] 삭제 ${file.name}: ${error.message}`); }
  }
  io.log(`[media-audio-offsite-backup] 올림 ${summary.uploaded}건 ${(summary.bytes / 1048576).toFixed(1)}MB, 영구 삭제 반영 ${summary.deleted}, 건너뜀 ${summary.skipped}, 실패 ${summary.failed}, 남음 ${pending - summary.uploaded - summary.skipped}`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((summary) => { if (summary?.failed) process.exitCode = 1; })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
