#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, closeSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validHost } from '../jobs/owntracks-receiver.mjs';

export const SETUP_PATH = process.env.OWNTRACKS_CONFIG_PATH || join(homedir(), '.config', 'banana-portfolio-v2', 'owntracks.json');
export function setup({ host, port = 8088, username = 'owntracks', path = SETUP_PATH } = {}) {
  if (!validHost(host)) throw new Error('--host에는 Tailscale IPv4 주소가 필요합니다');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('포트 범위 오류');
  if (existsSync(path)) throw new Error('설정 파일이 이미 있습니다');
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, 'wx', 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify({ host, port, username, password: randomBytes(24).toString('base64url') }, null, 2)}\n`); }
  finally { closeSync(descriptor); }
  return { host, port, username };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const host = process.argv.find((arg) => arg.startsWith('--host='))?.slice(7);
    const port = Number(process.argv.find((arg) => arg.startsWith('--port='))?.slice(7) || 8088);
    const result = setup({ host, port });
    console.log(`폰 설정: URL http://${result.host}:${result.port}/pub, 사용자 이름 ${result.username}`);
    console.log('비밀번호를 클립보드로 복사: node -e "process.stdout.write(JSON.parse(require(\'fs\').readFileSync(process.env.HOME+\'/.config/banana-portfolio-v2/owntracks.json\')).password)" | pbcopy');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
