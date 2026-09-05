import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  findLastGreetingChannelMessage, guardFilePath, hasAlreadySentReaction, markReactionSent, readBotToken,
} from './telegram-progress-reaction.mjs';

const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), 'telegram-progress-reaction.mjs');

const CHANNEL_USER = (messageId, text = '안녕') => ({
  type: 'user',
  message: {
    content: `<channel source="plugin:telegram:telegram" chat_id="8722755985" message_id="${messageId}" user="8722755985" user_id="8722755985" ts="2026-09-05T00:00:00.000Z">\n${text}\n</channel>`,
  },
});
const ASSISTANT_TOOL = (name, input = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'telegram-progress-reaction-test-'));
}

test('findLastGreetingChannelMessage: 마지막 채널 메시지가 정확히 "안녕"이면 chatId·messageId 반환', () => {
  const lines = [CHANNEL_USER('653')];
  assert.deepEqual(findLastGreetingChannelMessage(lines), { chatId: '8722755985', messageId: '653' });
});

test('findLastGreetingChannelMessage: "안녕하세요" 등 다른 문구는 대상 아님(null)', () => {
  const lines = [CHANNEL_USER('1', '안녕하세요')];
  assert.equal(findLastGreetingChannelMessage(lines), null);
});

test('findLastGreetingChannelMessage: 앞뒤 공백만 붙은 "안녕 "도 trim 후 일치하면 대상', () => {
  const lines = [CHANNEL_USER('2', '  안녕  ')];
  assert.deepEqual(findLastGreetingChannelMessage(lines), { chatId: '8722755985', messageId: '2' });
});

test('findLastGreetingChannelMessage: 채널 메시지가 아예 없으면 null', () => {
  const lines = [{ type: 'user', message: { content: '그냥 터미널 프롬프트' } }];
  assert.equal(findLastGreetingChannelMessage(lines), null);
});

test('findLastGreetingChannelMessage: 가장 최근 채널 메시지 기준 — "안녕" 다음에 다른 메시지가 왔으면 그게 최신', () => {
  const lines = [CHANNEL_USER('1', '안녕'), ASSISTANT_TOOL('mcp__plugin_telegram_telegram__reply', {}), CHANNEL_USER('2', '리밸런싱 어때')];
  assert.equal(findLastGreetingChannelMessage(lines), null);
});

test('findLastGreetingChannelMessage: 사이드체인(위임된 서브에이전트)이 원본 인사를 인용해도, 진짜 최신 메인라인 메시지 기준으로 판정', () => {
  const lines = [
    CHANNEL_USER('10', '안녕'),
    ASSISTANT_TOOL('mcp__plugin_telegram_telegram__reply', {}),
    CHANNEL_USER('11', '리밸런싱 어때'),
    // 서브에이전트가 위임 프롬프트에 원본 "안녕" 채널 태그를 그대로 인용하는 사이드체인
    // — 이걸 무시하지 않으면 진짜 최신 메시지('리밸런싱 어때')가 아니라 옛 "안녕"이
    // 잘못 최신으로 잡힘.
    { ...CHANNEL_USER('10', '안녕'), isSidechain: true },
  ];
  assert.equal(findLastGreetingChannelMessage(lines), null);
});

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

// ── 서브프로세스 안전성 테스트(2026-09-05 코드리뷰 LOW 지적) ────────────────────
// 이 훅의 가장 중요한 계약은 "무슨 입력이 와도 stdout을 오염시키지 않고 exit 0"이다
// (PreToolUse는 stdout에 뭔가 찍히면 reply 자체를 막을 수 있는 hookSpecificOutput으로
// 해석될 위험이 있음). 순수함수 테스트만으론 이 계약 자체가 검증되지 않아 실제
// 서브프로세스로 훅을 실행한다 — 단, 실제 Telegram API 호출이 나가면 안 되므로
// (코드리뷰 중 실제로 한 번 사고가 났음, 헤더 주석 참고) transcript_path를 존재하지
// 않는 경로로 고정해 fetch 이전에 항상 조기 반환하게 만든다.
function runHook(stdin, envOverrides = {}) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_TELEGRAM_SESSION: '1', TELEGRAM_BOT_TOKEN: '', ...envOverrides },
    timeout: 5000,
  });
}

test('[코드리뷰 안전성 검증] 훅은 어떤 입력에도 stdout을 오염시키지 않고 exit 0(hookSpecificOutput 없음)', () => {
  const inputs = [
    '',
    'not json',
    JSON.stringify({ transcript_path: '/definitely/does/not/exist.jsonl' }),
  ];
  for (const stdin of inputs) {
    const r = runHook(stdin);
    assert.equal(r.status, 0, `input=${JSON.stringify(stdin)}`);
    assert.equal(r.stdout, '', `input=${JSON.stringify(stdin)} 는 stdout이 비어야 함(deny/block 절대 금지)`);
  }
});

test('CLAUDE_TELEGRAM_SESSION 없으면 즉시 통과(stdout 없음, exit 0)', () => {
  const r = runHook('{}', { CLAUDE_TELEGRAM_SESSION: '' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
