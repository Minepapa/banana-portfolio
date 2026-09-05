import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { guardFilePath, hasAlreadySentReaction, markReactionSent, readBotToken } from './telegram-progress-reaction.mjs';

// findLastGreetingChannelMessage는 2026-09-05 telegram-reply-guard.mjs로 이전됨
// (analyzeTranscriptTail이 "안녕" 예외 처리에 같이 써야 해서) — 그 테스트는
// telegram-reply-guard.test.js에 있다.

const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), 'telegram-progress-reaction.mjs');

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'telegram-progress-reaction-test-'));
}

test('guardFilePath: chatId·messageId 조합별로 다른 경로', () => {
  const p1 = guardFilePath('/tmp/g', '111', '1');
  const p2 = guardFilePath('/tmp/g', '222', '1');
  assert.notEqual(p1, p2);
});

test('hasAlreadySentReaction → markReactionSent: 왕복 — 기록 전엔 false, 기록 후엔 true', () => {
  const dir = makeTmpDir();
  try {
    assert.equal(hasAlreadySentReaction(dir, '8722755985', '653'), false);
    markReactionSent(dir, '8722755985', '653');
    assert.equal(hasAlreadySentReaction(dir, '8722755985', '653'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markReactionSent: 가드 디렉터리가 없어도 새로 만들어 기록', () => {
  const dir = join(makeTmpDir(), 'nested', 'sub');
  try {
    markReactionSent(dir, '1', '2');
    assert.equal(existsSync(guardFilePath(dir, '1', '2')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readBotToken: TELEGRAM_BOT_TOKEN 환경변수가 있으면 .env보다 우선(플러그인 README와 동일 우선순위)', () => {
  const prev = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'env-wins';
  try {
    assert.equal(readBotToken('/nonexistent/path/.env'), 'env-wins');
  } finally {
    if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prev;
  }
});

test('readBotToken: 환경변수 없으면 .env 파일에서 파싱', () => {
  const prev = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const dir = makeTmpDir();
  const envPath = join(dir, '.env');
  try {
    writeFileSync(envPath, 'SOME_OTHER=1\nTELEGRAM_BOT_TOKEN=123456:AAABBBCCC\n');
    assert.equal(readBotToken(envPath), '123456:AAABBBCCC');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (prev !== undefined) process.env.TELEGRAM_BOT_TOKEN = prev;
  }
});

test('readBotToken: 파일이 없으면 null(throw 아님)', () => {
  const prev = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    assert.equal(readBotToken('/nonexistent/path/.env'), null);
  } finally {
    if (prev !== undefined) process.env.TELEGRAM_BOT_TOKEN = prev;
  }
});

// ── 서브프로세스 안전성 테스트(2026-09-05 코드리뷰 LOW 지적, Stop 훅 전환 후 갱신) ──
// 이 훅의 가장 중요한 계약은 "무슨 입력이 와도 Stop을 막지 않고(continue:true) exit
// 0"이다. 순수함수 테스트만으론 이 계약 자체가 검증되지 않아 실제 서브프로세스로
// 훅을 실행한다 — 단, 실제 Telegram API 호출이 나가면 안 되므로(코드리뷰 중 실제로
// 한 번 사고가 났음, 헤더 주석 참고) transcript_path를 존재하지 않는 경로로 고정해
// fetch 이전에 항상 조기 반환하게 만든다.
function runHook(stdin, envOverrides = {}) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_TELEGRAM_SESSION: '1', TELEGRAM_BOT_TOKEN: '', ...envOverrides },
    timeout: 5000,
  });
}

test('[코드리뷰 안전성 검증] 훅은 어떤 입력에도 Stop을 막지 않고 exit 0(continue:true)', () => {
  const inputs = [
    '',
    'not json',
    JSON.stringify({ transcript_path: '/definitely/does/not/exist.jsonl' }),
  ];
  for (const stdin of inputs) {
    const r = runHook(stdin);
    assert.equal(r.status, 0, `input=${JSON.stringify(stdin)}`);
    assert.deepEqual(JSON.parse(r.stdout), { continue: true, suppressOutput: true }, `input=${JSON.stringify(stdin)}`);
  }
});

test('CLAUDE_TELEGRAM_SESSION 없으면 즉시 통과(continue:true, exit 0)', () => {
  const r = runHook('{}', { CLAUDE_TELEGRAM_SESSION: '' });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { continue: true, suppressOutput: true });
});
