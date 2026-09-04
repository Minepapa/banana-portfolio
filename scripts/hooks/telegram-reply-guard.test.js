import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeTranscriptTail, readTranscriptTailLines, shouldSkipBlocking } from './telegram-reply-guard.mjs';

const CHANNEL_USER = (messageId, text = '안녕') => ({
  type: 'user',
  message: {
    content: `<channel source="plugin:telegram:telegram" chat_id="8722755985" message_id="${messageId}" user="8722755985" user_id="8722755985" ts="2026-09-04T00:00:00.000Z">\n${text}\n</channel>`,
  },
});

const ASSISTANT_TEXT = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const ASSISTANT_TOOL = (name, input = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

test('[막아야 함/실사고] analyzeTranscriptTail: 채널 메시지 뒤 텍스트만 있고 도구 호출 없으면 강제재시도 필요(2026-09-04 실제 재현 케이스)', () => {
  const lines = [CHANNEL_USER('653'), ASSISTANT_TEXT('안녕하세요! 무엇을 도와드릴까요?')];
  const r = analyzeTranscriptTail(lines);
  assert.equal(r.shouldForceReply, true);
  assert.equal(r.chatId, '8722755985');
  assert.equal(r.messageId, '653');
});

test('analyzeTranscriptTail: reply 도구가 호출됐으면 강제재시도 불필요', () => {
  const lines = [CHANNEL_USER('626'), ASSISTANT_TOOL('mcp__plugin_telegram_telegram__reply', { text: '안녕하세요!' })];
  assert.equal(analyzeTranscriptTail(lines).shouldForceReply, false);
});

test('analyzeTranscriptTail: react만 호출돼도(아직 답장 전이라도) 강제재시도 불필요 — 진행 중 신호로 인정', () => {
  const lines = [CHANNEL_USER('626'), ASSISTANT_TOOL('mcp__plugin_telegram_telegram__react', { emoji: '😎' })];
  assert.equal(analyzeTranscriptTail(lines).shouldForceReply, false);
});

test('analyzeTranscriptTail: 부서 위임(Agent) 직후엔 아직 답장 전이라도 강제재시도 안 함(정당한 대기)', () => {
  const lines = [CHANNEL_USER('638'), ASSISTANT_TOOL('Agent', { subagent_type: 'hermes' })];
  assert.equal(analyzeTranscriptTail(lines).shouldForceReply, false);
});

test('analyzeTranscriptTail: 채널 메시지가 아예 없으면 강제재시도 대상 아님', () => {
  const lines = [{ type: 'user', message: { content: '그냥 터미널 프롬프트' } }, ASSISTANT_TEXT('네')];
  assert.equal(analyzeTranscriptTail(lines).shouldForceReply, false);
});

test('analyzeTranscriptTail: 가장 최근 채널 메시지 기준 — 이전 메시지에 답장했어도 최신 메시지에 안 했으면 강제재시도', () => {
  const lines = [
    CHANNEL_USER('1', '첫메시지'),
    ASSISTANT_TOOL('mcp__plugin_telegram_telegram__reply', { text: '첫 답장' }),
    CHANNEL_USER('2', '둘째메시지'),
    ASSISTANT_TEXT('둘째엔 답 안 함'),
  ];
  const r = analyzeTranscriptTail(lines);
  assert.equal(r.shouldForceReply, true);
  assert.equal(r.messageId, '2');
});

test('analyzeTranscriptTail: Bash·Read 등 다른 도구 호출만으론 강제재시도 방지 안 됨(투자조사만 하고 답장 안 한 경우도 잡아야 함)', () => {
  const lines = [CHANNEL_USER('9'), ASSISTANT_TOOL('Bash', { command: 'ls' }), ASSISTANT_TOOL('Read', { file_path: '/tmp/x' })];
  assert.equal(analyzeTranscriptTail(lines).shouldForceReply, true);
});

test('[코드리뷰 지적] analyzeTranscriptTail: 사이드체인(위임된 서브에이전트) 라인은 무시 — 채널 태그 원문을 인용해도 오탐 방지', () => {
  const lines = [
    CHANNEL_USER('10'),
    ASSISTANT_TOOL('mcp__plugin_telegram_telegram__reply', { text: '정상 답장' }),
    // 서브에이전트가 원본 채널 태그를 프롬프트에 그대로 인용하는 사이드체인 —
    // 이게 "최근 채널 메시지"로 잘못 잡히면 이미 답장했는데도 강제재시도됨
    { ...CHANNEL_USER('10'), isSidechain: true },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: '사이드체인 내부 텍스트' }] } },
  ];
  assert.equal(analyzeTranscriptTail(lines).shouldForceReply, false);
});

test('readTranscriptTailLines: 파일 끝 tail만 정확히 파싱(잘린 첫 줄은 버림)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-reply-guard-test-'));
  const filepath = join(dir, 'transcript.jsonl');
  try {
    const full = [
      JSON.stringify({ type: 'user', message: { content: 'x'.repeat(500) } }),
      JSON.stringify(CHANNEL_USER('42')),
      JSON.stringify(ASSISTANT_TOOL('mcp__plugin_telegram_telegram__reply', { text: 'ok' })),
    ].join('\n') + '\n';
    writeFileSync(filepath, full);
    const lines = readTranscriptTailLines(filepath, 200); // 일부러 작게 잘라서 tail 로직 검증(마지막 두 줄만 남을 정도)
    // 잘린 파일이라도 온전한 마지막 줄들은 파싱돼야 함
    const hasReply = lines.some((l) => l.type === 'assistant' && l.message?.content?.[0]?.name === 'mcp__plugin_telegram_telegram__reply');
    assert.equal(hasReply, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shouldSkipBlocking: context-limit류 stop_reason이면 스킵', () => {
  assert.equal(shouldSkipBlocking({ stop_reason: 'context_limit_reached' }), true);
  assert.equal(shouldSkipBlocking({ stopReason: 'max-tokens' }), true);
  assert.equal(shouldSkipBlocking({ reason: 'CONVERSATION_TOO_LONG' }), true);
});

test('shouldSkipBlocking: 사용자 중단이면 스킵', () => {
  assert.equal(shouldSkipBlocking({ user_requested: true }), true);
  assert.equal(shouldSkipBlocking({ stop_reason: 'user_interrupt' }), true);
});

test('shouldSkipBlocking: 평범한 stop(필드 없음/무관한 값)은 스킵 아님', () => {
  assert.equal(shouldSkipBlocking({}), false);
  assert.equal(shouldSkipBlocking({ stop_reason: 'end_turn' }), false);
});

test('readTranscriptTailLines: 파일이 maxBytes보다 작으면 전체를 그대로 파싱', () => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-reply-guard-test-'));
  const filepath = join(dir, 'transcript.jsonl');
  try {
    writeFileSync(filepath, JSON.stringify(CHANNEL_USER('1')) + '\n');
    const lines = readTranscriptTailLines(filepath, 300_000);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, 'user');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
