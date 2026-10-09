#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const keyPath = () => process.env.VAULT_BACKUP_KEY_PATH || join(homedir(), '.config', 'banana-portfolio-v2', 'vault-backup.key');
export function generateKey(path = keyPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, randomBytes(32)); }
  finally { closeSync(fd); }
  chmodSync(path, 0o600);
  return path;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { const path = generateKey(); console.log(`키 저장됨 — base64 < ${path} 로 확인해 비밀번호 관리자에 보관하세요`); }
  catch (error) { console.error(error.code === 'EEXIST' ? '키 파일이 이미 있음 — 덮어쓰지 않음' : error.message); process.exitCode = 1; }
}
