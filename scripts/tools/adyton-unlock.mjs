#!/usr/bin/env node
// 오너가 본 세션에서 직접 실행하는 금고 일시 해제 도구.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const UNLOCK_FILE = process.env.ADYTON_UNLOCK_FILE ||
  join(homedir(), '.config', 'banana-portfolio-v2', 'adyton-unlock.json');
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;

export function durationMs(value) {
  const match = /^(\d+)(m|h)$/.exec(value || '');
  if (!match) throw new Error('사용법: 15m 또는 1h (최대 2h), --lock, --status');
  const duration = Number(match[1]) * (match[2] === 'h' ? 60 : 1) * 60_000;
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > MAX_DURATION_MS) {
    throw new Error('해제 시간은 1분 이상, 최대 2시간입니다.');
  }
  return duration;
}

function expiry() {
  try {
    const value = JSON.parse(readFileSync(UNLOCK_FILE, 'utf8')).expiresAt;
    return typeof value === 'string' ? Date.parse(value) : NaN;
  } catch {
    return NaN;
  }
}

function timeLabel(timestamp) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(timestamp));
}

export function run(args, { isTTY = process.stdin.isTTY, now = Date.now() } = {}) {
  if (!isTTY) throw new Error('금고 해제 도구는 오너의 대화형 TTY에서만 실행할 수 있습니다.');
  if (args.length !== 1) throw new Error('사용법: 15m 또는 1h (최대 2h), --lock, --status');
  if (args[0] === '--status') {
    const until = expiry();
    return until > now ? `금고 열림: ${timeLabel(until)}까지` : '금고 잠김';
  }
  if (args[0] === '--lock') {
    try { unlinkSync(UNLOCK_FILE); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return '금고 잠김';
  }

  const expiresAt = new Date(now + durationMs(args[0])).toISOString();
  mkdirSync(dirname(UNLOCK_FILE), { recursive: true, mode: 0o700 });
  const tempFile = join(dirname(UNLOCK_FILE), `.${basename(UNLOCK_FILE)}.${process.pid}.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tempFile, JSON.stringify({ expiresAt }), { mode: 0o600, flag: 'wx' });
    chmodSync(tempFile, 0o600);
    renameSync(tempFile, UNLOCK_FILE);
  } catch (error) {
    try { unlinkSync(tempFile); } catch { /* 생성 전 실패했거나 이미 이동됨 */ }
    throw error;
  }
  return `금고 열림: ${timeLabel(Date.parse(expiresAt))}까지`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${run(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
