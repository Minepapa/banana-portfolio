import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendDirectWarning, warningSubjectKey } from './direct-warning-delivery.mjs';
import { readWarningEvents } from './warning-event-journal.mjs';
import { warningsSignature } from './job-alerts.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'direct-warning-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    journalRoot: join(dir, 'journal'),
    jobName: 'test-direct-job', warningCode: 'TEST_DIRECT_WARNING',
    subjectKey: 'batch', kind: 'operational', severity: 'high',
  };
}

test('동적 식별자는 원문을 남기지 않는 안전한 subjectKey로 변환한다', () => {
  const key = warningSubjectKey('proposal', '0006693100');
  assert.match(key, /^proposal:[a-p]{20}$/);
  assert.equal(key, warningSubjectKey('proposal', '0006693100'));
  assert.notEqual(key, warningSubjectKey('proposal', '6693100'));
  assert.doesNotMatch(key, /0006693100/);
});

test('전송 함수는 반드시 주입해야 하며 누락 시 실제 채널을 호출하지 않는다', async (t) => {
  const input = setup(t);
  await assert.rejects(() => sendDirectWarning({ ...input, message: '시험' }), /전송 함수 필요/);
  assert.deepEqual(readWarningEvents({ rootDir: input.journalRoot }).events, []);
});

test('잡 경보 원장은 대상 잡과 민감정보를 가린 200자 상세를 기록한다', async (t) => {
  const input = setup(t);
  await sendDirectWarning({ ...input, targetJob: 'intraday-portfolio-sync',
    detail: `Bearer secret-token appkey=KEY123 계좌 12345678901 ${'x'.repeat(300)}`,
    message: '시험', send: async () => ({ ok: true, result: { message_id: 1 } }) });
  const events = readWarningEvents({ rootDir: input.journalRoot }).events;
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.equal(event.targetJob, 'intraday-portfolio-sync');
    assert.ok(event.detail.length <= 200);
    assert.doesNotMatch(event.detail, /secret-token|KEY123|12345678901/);
  }
});

test('Bot API 수락 응답이면 원문 변경 없이 1회 전송하고 message_id를 기록한다', async (t) => {
  const input = setup(t);
  let sends = 0;
  const message = '[경고] 원문 그대로';
  const response = await sendDirectWarning({
    ...input, message,
    send: async (text) => {
      assert.equal(text, message);
      sends++;
      return { ok: true, result: { message_id: 53 } };
    },
  });
  assert.equal(sends, 1);
  assert.equal(response.result.message_id, 53);
  const events = readWarningEvents({ rootDir: input.journalRoot }).events;
  assert.deepEqual(events.map((event) => event.deliveryStatus).filter(Boolean), ['sending', 'sent']);
  assert.equal(events.find((event) => event.deliveryStatus === 'sent').telegramMessageId, 53);
  assert.equal(events.every((event) => event.detail === message), true);
});

test('명시적 거부와 응답 불명은 구분해 기록하고 기존 호출부에 실패를 돌려준다', async (t) => {
  const input = setup(t);
  const rejection = Object.assign(new Error('400'), { telegramExplicitRejection: true });
  await assert.rejects(() => sendDirectWarning({
    ...input, message: '거부', send: async () => { throw rejection; },
  }), (error) => error === rejection);
  await assert.rejects(() => sendDirectWarning({
    ...input, message: '불명', send: async () => { throw new Error('connection lost'); },
  }), /connection lost/);
  await assert.rejects(() => sendDirectWarning({
    ...input, message: 'ID 결측', send: async () => ({ ok: true, result: {} }),
  }), /전달 결과 확인 불가/);
  const statuses = readWarningEvents({ rootDir: input.journalRoot }).events
    .map((event) => event.deliveryStatus).filter(Boolean);
  assert.deepEqual(statuses, ['sending', 'rejected', 'sending', 'unknown', 'sending', 'unknown']);
});

test('원장 장애가 원래 경고 발송을 막거나 추가 Telegram 발송을 만들지 않는다', async (t) => {
  const input = setup(t);
  writeFileSync(input.journalRoot, '파일이 경로를 점유');
  let sends = 0;
  const result = await sendDirectWarning({
    ...input, message: '원장 장애', logger: { error() {} },
    send: async () => { sends++; return { ok: true, result: { message_id: 90 } }; },
  });
  assert.equal(result.result.message_id, 90);
  assert.equal(sends, 1);
});

test('문구만 바뀐 같은 코드·대상은 같은 사건으로 묶고, 레거시 문자열 서명 변화와 구분한다', async (t) => {
  const input = setup(t);
  let messageId = 100;
  const send = async () => ({ ok: true, result: { message_id: messageId++ } });
  await sendDirectWarning({ ...input, message: '조회 실패: 재시도 1회', send });
  await sendDirectWarning({ ...input, message: '조회 실패: 재시도 2회', send });
  const events = readWarningEvents({ rootDir: input.journalRoot }).events;
  assert.equal(new Set(events.map((event) => event.incidentId)).size, 1);
  assert.equal(events.filter((event) => event.eventType === 'detected').length, 2);
  assert.equal(events.filter((event) => event.deliveryStatus === 'sent').length, 2);
  assert.notEqual(warningsSignature(['조회 실패: 재시도 1회']), warningsSignature(['조회 실패: 재시도 2회']));
  assert.deepEqual(events.filter((event) => event.eventType === 'detected').map((event) => event.detail),
    ['조회 실패: 재시도 1회', '조회 실패: 재시도 2회']);
});

test('메시지 본문과 사실 목록에서 상세를 공통 추출하고 민감정보를 가린다', async (t) => {
  const input = setup(t);
  const send = async () => ({ ok: true, result: { message_id: 4 } });
  await sendDirectWarning({ ...input, message: { body: 'NH 실패 Bearer hidden 12345678901' }, send });
  await sendDirectWarning({ ...input, message: { facts: ['조회 실패', 'token=hidden'] }, send });
  const details = readWarningEvents({ rootDir: input.journalRoot }).events
    .filter((event) => event.eventType === 'detected').map((event) => event.detail);
  assert.match(details[0], /NH 실패/);
  assert.match(details[1], /조회 실패/);
  assert.equal(details.every((detail) => detail.length <= 200), true);
  assert.doesNotMatch(details.join(' '), /hidden|12345678901/);
});
