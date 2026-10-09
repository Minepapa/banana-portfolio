#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { DRIVE_BACKUP_SCOPES, getAccessToken } from '../lib/google-oauth.mjs';
import { deleteBackup, encryptBuffer, findOrCreateFolder, listFiles, planRetention, uploadBackup } from '../lib/vault-offsite-backup.mjs';
import { keyPath } from '../tools/vault-backup-keygen.mjs';

const exec = promisify(execFile);
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const io = { mkdtemp, readFile, rm, stat, exec, getAccessToken, encryptBuffer,
    findOrCreateFolder, listFiles, planRetention, uploadBackup, deleteBackup,
    keyPath, now: () => Date.now(), log: console.log, ...dependencies };
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--dry-run')) throw new Error('사용법: vault-offsite-backup.mjs [--dry-run]');
  const dryRun = argv.includes('--dry-run');
  let key;
  try {
    const path = io.keyPath();
    if (((await io.stat(path)).mode & 0o077) !== 0) throw new Error('백업 키 권한 오류: 소유자만 접근 가능해야 함');
    key = await io.readFile(path);
  }
  catch (error) {
    if (error.message.startsWith('백업 키 권한 오류')) throw error;
    throw new Error('백업 키 없음 — vault-backup-keygen 실행');
  }
  if (key.length !== 32) throw new Error('백업 키 길이 오류');
  const token = dryRun ? null : await io.getAccessToken({ requiredScopes: DRIVE_BACKUP_SCOPES });
  const temporary = await io.mkdtemp(join(tmpdir(), 'pantheon-vault-backup-'));
  try {
    const bundlePath = join(temporary, 'vault.bundle');
    await io.exec('git', ['-C', VAULT_PATHS.root, 'bundle', 'create', bundlePath, '--all']);
    const encrypted = io.encryptBuffer(await io.readFile(bundlePath), key);
    const date = new Date(io.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const name = `pantheon-vault-${date}.bundle.enc`;
    if (dryRun) { io.log(`dry-run: ${name} (${encrypted.length} bytes)`); return; }
    const folder = await io.findOrCreateFolder({ token });
    const uploaded = await io.uploadBackup({ token, folderId: folder.id, name, blob: encrypted });
    if (Number(uploaded.size) !== encrypted.length) throw new Error('업로드 후 원격 파일 크기 불일치');
    const files = (await io.listFiles({ token, folderId: folder.id })).filter((file) => file.appProperties?.pantheon === 'vault-backup');
    const { delete: stale } = io.planRetention(files, date);
    const remove = new Map(stale.map((file) => [file.id, file]));
    for (const file of files) {
      if (file.name === name && file.id !== uploaded.id) remove.set(file.id, file);
    }
    for (const file of remove.values()) await io.deleteBackup({ token, folderId: folder.id, file });
    io.log(`백업 완료: ${name} (${encrypted.length} bytes)`);
  } finally { await io.rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
