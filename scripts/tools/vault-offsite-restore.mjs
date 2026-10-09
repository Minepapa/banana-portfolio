#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRIVE_BACKUP_SCOPES, getAccessToken } from '../lib/google-oauth.mjs';
import { decryptBuffer, downloadBackup, listFiles } from '../lib/vault-offsite-backup.mjs';
import { keyPath } from './vault-backup-keygen.mjs';

const exec = promisify(execFile);
const NAME = /^pantheon-vault-\d{4}-\d{2}-\d{2}\.bundle\.enc$/;
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const io = { existsSync, mkdtemp, readFile, readdir, rm, stat, writeFile, exec,
    getAccessToken, decryptBuffer, downloadBackup, listFiles, keyPath,
    log: console.log, ...dependencies };
  const verify = argv.includes('--verify');
  const latest = argv.includes('--latest') || verify;
  const nameArgs = argv.filter((arg) => arg.startsWith('--name='));
  const outArgs = argv.filter((arg) => arg.startsWith('--out='));
  const nameArg = nameArgs[0];
  const outArg = outArgs[0];
  const usage = '사용법: (--name=<파일> | --latest) --out=<빈 디렉터리>, 또는 --verify';
  if (argv.some((arg) => !['--verify', '--latest'].includes(arg) && !arg.startsWith('--name=') && !arg.startsWith('--out='))
    || argv.filter((arg) => arg === '--verify').length > 1
    || argv.filter((arg) => arg === '--latest').length > 1
    || nameArgs.length > 1 || outArgs.length > 1
    || (verify && argv.length !== 1)
    || (!verify && (Boolean(nameArg) === latest || !outArg || !outArg.slice(6)))) throw new Error(usage);
  const wantedName = nameArg?.slice(7);
  if (nameArg && !NAME.test(wantedName)) throw new Error('백업 파일 이름 오류');
  let key;
  try {
    const path = io.keyPath();
    if (((await io.stat(path)).mode & 0o077) !== 0) throw new Error('백업 키 권한 오류: 소유자만 접근 가능해야 함');
    key = await io.readFile(path);
  } catch (error) {
    if (error.message.startsWith('백업 키 권한 오류')) throw error;
    throw new Error('백업 키 없음');
  }
  if (key.length !== 32) throw new Error('백업 키 길이 오류');
  const output = outArg && resolve(outArg.slice(6));
  if (output && io.existsSync(output) && (await io.readdir(output)).length) throw new Error('출력 디렉터리는 비어 있어야 함');
  const token = await io.getAccessToken({ requiredScopes: DRIVE_BACKUP_SCOPES });
  const folders = await io.listFiles({ token });
  const folder = folders.find((file) => file.appProperties?.pantheon === 'vault-backup' && file.mimeType === 'application/vnd.google-apps.folder');
  if (!folder) throw new Error('백업 폴더 없음');
  const files = (await io.listFiles({ token, folderId: folder.id })).filter((file) => file.parents?.includes(folder.id) && file.appProperties?.pantheon === 'vault-backup' && NAME.test(file.name));
  const selected = latest ? files.sort((a, b) => b.name.localeCompare(a.name))[0] : files.find((file) => file.name === wantedName);
  if (!selected) throw new Error('백업 파일 없음');
  const temporary = await io.mkdtemp(join(tmpdir(), 'pantheon-vault-restore-'));
  try {
    const bundlePath = join(temporary, 'vault.bundle');
    await io.writeFile(bundlePath, io.decryptBuffer(await io.downloadBackup({ token, id: selected.id }), key));
    await io.exec('git', ['init', '--quiet'], { cwd: temporary });
    await io.exec('git', ['bundle', 'verify', bundlePath], { cwd: temporary });
    if (!verify) await io.exec('git', ['clone', bundlePath, output]);
    io.log(`${verify ? '검증' : '복구'} 완료: ${selected.name}`);
  } finally { await io.rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
