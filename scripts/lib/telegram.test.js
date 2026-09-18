import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { isHtmlParseFailure, sendTelegram } from './telegram.mjs';

// 2026-09-18 실사고 대응(Log/DevRequests/2026-09-18-macro-cache-데이터신선도-알람공백.md)
// — isHtmlParseFailure는 순수함수라 무조건 테스트. sendTelegram의 재시도 "배선"
// 자체(fetchImpl을 실제로 2번 부르는지, 2번째 호출엔 parse_mode가 빠지는지)는
// 코드리뷰 지적(2026-09-18) — fetchImpl 주입 시임을 이미 만들어뒀으면서 그 배선을
// 검증하는 테스트가 없었다. loadTelegramConfig()가 이 Mac의 실제 설정 파일
// ($HOME/.claude/channels/telegram/.env·access.json)을 읽으므로(fetchImpl만
// 모킹, config 자체는 실환경 의존) 그 파일이 없는 환경(CI 등)에서는 스킵 —
// vault-job-catalog-audit.test.js의 CAN_RUN과 동일 원칙.
const CAN_RUN = existsSync(`${process.env.HOME}/.claude/channels/telegram/.env`)
  && existsSync(`${process.env.HOME}/.claude/channels/telegram/access.json`);

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

test('sendTelegram: HTML 파싱 실패면 plain text로 재시도(총 2회 호출, 2번째엔 parse_mode 없음+마커 접두사)', { skip: !CAN_RUN }, async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (calls.length === 1) {
      return { ok: false, status: 400, text: async () => '{"description":"Bad Request: can\'t parse entities: Unsupported start tag \\"module\\""}' };
    }
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const result = await sendTelegram('<b>title</b> <module>', undefined, { fetchImpl });
  assert.equal(calls.length, 2, '실패 1회 + 재시도 1회 = 총 2번 호출돼야 함');
  assert.equal(calls[0].parse_mode, 'HTML');
  assert.equal(calls[1].parse_mode, undefined, '2번째 호출엔 parse_mode가 아예 없어야(plain text) 함');
  assert.match(calls[1].text, /^\[서식 오류 — 원문 그대로 발송\]\n/, '재시도 실패가 조용히 성공하면 안 되므로 눈에 띄는 마커가 붙어야 함');
  assert.deepEqual(result, { ok: true, result: { message_id: 1 } });
});

test('sendTelegram: HTML 파싱 실패가 아닌 다른 400 오류는 재시도 없이 즉시 throw(총 1회 호출)', { skip: !CAN_RUN }, async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: false, status: 400, text: async () => '{"description":"Bad Request: chat not found"}' };
  };
  await assert.rejects(
    () => sendTelegram('hello', undefined, { fetchImpl }),
    /텔레그램 전송 실패/,
  );
  assert.equal(calls.length, 1, '파싱실패가 아닌 400은 재시도하면 안 됨(회귀 시 조용한 이중발송 위험 — 코드리뷰 지적)');
});
