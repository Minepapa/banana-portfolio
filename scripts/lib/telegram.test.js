import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isHtmlParseFailure, sendTelegram, editTelegramMessage, getTelegramWebhookInfo, loadTelegramConfig,
  resolveTelegramConfig, truncateForTelegram,
} from './telegram.mjs';

// 2026-09-18 실사고 대응(Log/DevRequests/2026-09-18-macro-cache-데이터신선도-알람공백.md)
// — isHtmlParseFailure는 순수함수라 무조건 테스트. sendTelegram의 재시도 "배선"
// 자체(fetchImpl을 실제로 2번 부르는지, 2번째 호출엔 parse_mode가 빠지는지)는
// 코드리뷰 지적(2026-09-18)으로 추가했다. 예전엔 loadTelegramConfig()가 이 Mac의 실제 설정 파일을
// 읽어 그 파일이 없는 환경에서 스킵했으나, 2026-10-30 config 주입이 생겨 가짜 토큰(FAKE_CONFIG)으로
// 어디서나 돈다. 가짜 fetch만 쓰므로 실제 봇으로 아무것도 나가지 않는다.
const FAKE_CONFIG = { botToken: 'FAKE:gate-test-token', chatId: '424242' };

test('isHtmlParseFailure: 400 + "can\'t parse entities" 메시지면 true', () => {
  assert.equal(
    isHtmlParseFailure(400, '{"ok":false,"error_code":400,"description":"Bad Request: can\'t parse entities: Unsupported start tag \\"module\\" at byte offset 305"}'),
    true,
  );
});

test('isHtmlParseFailure: 400이지만 다른 사유면 false(다른 400 오류를 이 경로로 삼키지 않음)', () => {
  assert.equal(isHtmlParseFailure(400, '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}'), false);
});

test('isHtmlParseFailure: 400이 아니면(예: 429 rate limit) false', () => {
  assert.equal(isHtmlParseFailure(429, "can't parse entities"), false);
});

test('isHtmlParseFailure: bodyText가 없거나 빈 문자열이면 false(예외 던지지 않음)', () => {
  assert.equal(isHtmlParseFailure(400, ''), false);
  assert.equal(isHtmlParseFailure(400, undefined), false);
  assert.equal(isHtmlParseFailure(400, null), false);
});

test('isHtmlParseFailure: 대소문자 무관하게 매칭', () => {
  assert.equal(isHtmlParseFailure(400, "Can'T Parse Entities: whatever"), true);
});

test('sendTelegram: HTML 파싱 실패면 plain text로 재시도(총 2회 호출, 2번째엔 parse_mode 없음+마커 접두사)', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (calls.length === 1) {
      return { ok: false, status: 400, text: async () => '{"description":"Bad Request: can\'t parse entities: Unsupported start tag \\"module\\""}' };
    }
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const result = await sendTelegram('<b>title</b> <module>', undefined, { fetchImpl, config: FAKE_CONFIG });
  assert.equal(calls.length, 2, '실패 1회 + 재시도 1회 = 총 2번 호출돼야 함');
  assert.equal(calls[0].parse_mode, 'HTML');
  assert.equal(calls[1].parse_mode, undefined, '2번째 호출엔 parse_mode가 아예 없어야(plain text) 함');
  assert.match(calls[1].text, /^\[서식 오류 — 원문 그대로 발송\]\n/, '재시도 실패가 조용히 성공하면 안 되므로 눈에 띄는 마커가 붙어야 함');
  assert.deepEqual(result, { ok: true, result: { message_id: 1 } });
});

test('sendTelegram: HTML 파싱 실패가 아닌 다른 400 오류는 재시도 없이 즉시 throw(총 1회 호출)', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: false, status: 400, text: async () => '{"description":"Bad Request: chat not found"}' };
  };
  await assert.rejects(
    () => sendTelegram('hello', undefined, { fetchImpl, config: FAKE_CONFIG }),
    /텔레그램 전송 실패/,
  );
  assert.equal(calls.length, 1, '파싱실패가 아닌 400은 재시도하면 안 됨(회귀 시 조용한 이중발송 위험 — 코드리뷰 지적)');
});

test('sendTelegram: 명시적 4xx 거부와 결과 불명 5xx를 구분한다', async () => {
  for (const [status, rejected] of [[403, true], [429, true], [503, false]]) {
    await assert.rejects(
      () => sendTelegram('test', undefined, {
        fetchImpl: async () => ({ ok: false, status, text: async () => 'failure' }),
        config: FAKE_CONFIG,
      }),
      (error) => Boolean(error.telegramExplicitRejection) === rejected,
    );
  }
});

// ── truncateForTelegram(2026-09-20 독립 코드리뷰 MEDIUM 지적) — Telegram 메시지
// 상한(4096자)을 넘기면 400 "message is too long"으로 발송이 통째로 거부되고,
// job-alerts.mjs의 flushWarnings가 그 실패를 catch해 경고 배치 전체가 조용히
// 유실된다. weekly-report.mjs의 위치정보 포함 경고나 facts 항목이 많은 메시지가
// 이 상한을 넘기기 쉬워져(이번 세션에서 facts 사이 빈 줄 추가로 메시지 길이 자체도
// 늘어남) 발송 함수 자신이 최종 안전망으로 자른다.
test('truncateForTelegram: 4096자 이하면 그대로 통과', () => {
  const short = 'A'.repeat(100);
  assert.equal(truncateForTelegram(short), short);
});

test('truncateForTelegram: 4096자를 넘으면 잘리고 생략 마커가 붙음, 전체 길이는 상한 이내', () => {
  const long = 'A'.repeat(5000);
  const result = truncateForTelegram(long);
  assert.ok(result.length <= 4096);
  assert.match(result, /생략됨/);
});

test('truncateForTelegram: 빈 값이면 빈 문자열(안 터짐)', () => {
  assert.equal(truncateForTelegram(null), '');
  assert.equal(truncateForTelegram(undefined), '');
});

test('sendTelegram: 4096자 넘는 텍스트도 발송 자체는 잘려서라도 나감(경고 배치 전체 유실 방지)', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  await sendTelegram('A'.repeat(5000), undefined, { fetchImpl });
  assert.ok(calls[0].text.length <= 4096, 'Telegram에 실제로 나가는 payload.text는 상한 이내여야 함');
});

test('잘라낸 메시지는 열린 태그를 닫아 HTML 파싱이 깨지지 않는다', () => {
  const long = `<b>제목</b>\n<blockquote>${'해석 문장 '.repeat(800)}</blockquote>`;
  const cut = truncateForTelegram(long);
  assert.ok(cut.length <= 4096);
  assert.equal((cut.match(/<blockquote>/g) ?? []).length, (cut.match(/<\/blockquote>/g) ?? []).length);
  assert.doesNotMatch(cut.replace(/…\(길이 제한으로 생략됨.*$/s, ''), /<[^>]*$/);
});

// config 주입(2026-10-30, 텔레그램 관문 0단계) — 실제 설정 파일 없이 돈다(FAKE_CONFIG는 파일 위쪽).

function recordingFetch(calls, result = { ok: true, result: { message_id: 7 } }) {
  return async (url, opts = {}) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, json: async () => result };
  };
}

test('sendTelegram: config를 넘기면 그 토큰·chat_id만 쓴다', async () => {
  const calls = [];
  await sendTelegram('<b>시험</b>', undefined, { fetchImpl: recordingFetch(calls), config: FAKE_CONFIG });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/botFAKE:gate-test-token/sendMessage');
  assert.equal(calls[0].body.chat_id, '424242');
});

test('sendTelegram: chatId 인자가 config.chatId보다 우선한다(기존 계약 유지)', async () => {
  const calls = [];
  await sendTelegram('시험', '999', { fetchImpl: recordingFetch(calls), config: FAKE_CONFIG });
  assert.equal(calls[0].body.chat_id, '999');
});

test('editTelegramMessage: config를 넘기면 그 토큰으로 editMessageText를 부른다', async () => {
  const calls = [];
  await editTelegramMessage(5, '고침', undefined, { fetchImpl: recordingFetch(calls), config: FAKE_CONFIG });
  assert.equal(calls[0].url, 'https://api.telegram.org/botFAKE:gate-test-token/editMessageText');
  assert.equal(calls[0].body.message_id, 5);
  assert.equal(calls[0].body.chat_id, '424242');
});

test('getTelegramWebhookInfo: config·fetchImpl 주입으로 실제 설정 없이 조회한다', async () => {
  const calls = [];
  const info = await getTelegramWebhookInfo({
    fetchImpl: recordingFetch(calls, { ok: true, result: { url: '', pending_update_count: 0 } }),
    config: FAKE_CONFIG,
  });
  assert.equal(calls[0].url, 'https://api.telegram.org/botFAKE:gate-test-token/getWebhookInfo');
  assert.deepEqual(info, { url: '', pending_update_count: 0 });
});

test('resolveTelegramConfig: null·반쪽·형식이 틀린 config는 fetch 전에 거부한다(실제 봇으로 돌아가지 않음)', async () => {
  const bad = [
    null, {}, { botToken: 'FAKE:x' }, { chatId: '1' },
    { botToken: '', chatId: '1' }, { botToken: '   ', chatId: '1' }, { botToken: 'no-colon', chatId: '1' },
    { botToken: 'FAKE:x', chatId: '' }, { botToken: 'FAKE:x', chatId: '  ' }, { botToken: 'FAKE:x', chatId: 0 },
    { botToken: 'FAKE:x', chatId: '0' }, { botToken: 'FAKE:x', chatId: false }, { botToken: 'FAKE:x', chatId: { id: 1 } },
    { botToken: 'FAKE:x', chatId: '12a' },
  ];
  for (const config of bad) {
    assert.throws(() => resolveTelegramConfig(config), /botToken·chatId/);
    const calls = [];
    await assert.rejects(sendTelegram('시험', undefined, { fetchImpl: recordingFetch(calls), config }), /botToken·chatId/);
    assert.equal(calls.length, 0, '거부된 config로 네트워크를 타면 안 됨');
  }
});

test('resolveTelegramConfig: 완전한 config는 그대로 돌려준다(숫자 chat_id·그룹 음수 id 포함)', () => {
  assert.deepEqual(resolveTelegramConfig(FAKE_CONFIG), FAKE_CONFIG);
  for (const chatId of [424242, '-1001234', -1001234]) {
    assert.deepEqual(resolveTelegramConfig({ botToken: 'FAKE:x', chatId }), { botToken: 'FAKE:x', chatId });
  }
});

test('loadTelegramConfig: envPath·accessPath를 넘기면 그 파일을 읽는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-config-'));
  try {
    const envPath = join(dir, 'test.env');
    const accessPath = join(dir, 'access.json');
    writeFileSync(envPath, 'TELEGRAM_BOT_TOKEN=FAKE:from-file\n');
    writeFileSync(accessPath, JSON.stringify({ allowFrom: ['31337'] }));
    assert.deepEqual(loadTelegramConfig({ envPath, accessPath }), { botToken: 'FAKE:from-file', chatId: '31337' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
