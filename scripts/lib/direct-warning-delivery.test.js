import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendDirectWarning, warningSubjectKey } from './direct-warning-delivery.mjs';
import { readWarningEvents } from './warning-event-journal.mjs';
import { warningsSignature } from './job-alerts.mjs';
import { deferWarning, drainDeferredWarnings, isQuietHour, resolveDeferredIssue } from './deferred-warnings.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'direct-warning-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    journalRoot: join(dir, 'journal'),
    jobName: 'test-direct-job', warningCode: 'TEST_DIRECT_WARNING',
    subjectKey: 'batch', kind: 'operational', severity: 'high',
    clock: () => Date.parse('2026-09-30T03:00:00.000Z'),
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

test('23~07시 KST 경고는 보류하고 07시 요약은 중복 발송하지 않는다', async (t) => {
  const input = setup(t);
  const queueFile = join(input.journalRoot, '..', 'deferred.json');
  const night = Date.parse('2026-10-11T14:00:00.000Z');
  const morning = Date.parse('2026-10-11T22:00:00.000Z');
  assert.equal(isQuietHour(night), true);
  assert.equal(isQuietHour(morning), false);
  let directSends = 0;
  const message = { agent: 'zeus', kind: '판단', facts: ['잡 media-archive가 조용합니다'] };
  const result = await sendDirectWarning({ ...input, message, queueFile, clock: () => night,
    send: async () => { directSends++; } });
  assert.equal(result.deferred, true);
  assert.equal(directSends, 0);
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).pending.length, 1);
  await resolveDeferredIssue(`${input.jobName}|${input.warningCode}|${input.subjectKey}`, queueFile);
  const digest = [];
  const send = async (item) => { digest.push(item); return { ok: true, result: { message_id: 1 } }; };
  await drainDeferredWarnings({ queueFile, now: morning, send });
  await drainDeferredWarnings({ queueFile, now: morning + 1800_000, send });
  assert.equal(digest.length, 1);
  assert.match(digest[0].facts[0], /밤사이 경고 1건/);
  assert.match(digest[0].facts[1], /복구됨/);
  assert.equal(readWarningEvents({ rootDir: input.journalRoot }).events.at(-1).deliveryStatus, 'sent');
});

test('trade-safety와 critical 경고는 밤에도 즉시 발송한다', async (t) => {
  const input = setup(t);
  const queueFile = join(input.journalRoot, '..', 'deferred.json');
  let sends = 0;
  for (const override of [{ kind: 'trade-safety' }, { severity: 'critical' }]) {
    await sendDirectWarning({ ...input, ...override, queueFile,
      clock: () => Date.parse('2026-10-11T15:00:00.000Z'), message: '긴급',
      send: async () => ({ ok: true, result: { message_id: ++sends } }) });
  }
  assert.equal(sends, 2);
});

test('아침 요약의 응답 불명은 큐에 남기고 자동 재전송하지 않는다', async (t) => {
  const input = setup(t);
  const queueFile = join(input.journalRoot, '..', 'deferred.json');
  await sendDirectWarning({ ...input, queueFile,
    clock: () => Date.parse('2026-10-11T15:00:00.000Z'), message: { agent: 'zeus', facts: ['경고'] },
    send: async () => { throw new Error('전송되면 안 됨'); } });
  let calls = 0;
  const options = { queueFile, now: Date.parse('2026-10-11T22:00:00.000Z'),
    logger: { error() {} }, send: async () => { calls++; throw new Error('응답 불명'); } };
  assert.equal((await drainDeferredWarnings(options)).status, 'unknown');
  await drainDeferredWarnings(options);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).inFlight.length, 1);
});

test('손상된 보류 큐는 격리하고 critical 경보 후 새 경고를 보존한다', async (t) => {
  const input = setup(t);
  const queueFile = join(input.journalRoot, '..', 'deferred.json');
  writeFileSync(queueFile, '{broken');
  const messages = [];
  await sendDirectWarning({ ...input, queueFile, clock: () => Date.parse('2026-10-11T15:00:00Z'),
    message: { agent: 'zeus', facts: ['새 경고'] },
    send: async (message, chatId) => { assert.equal(chatId, undefined);
      messages.push(message); return { ok: true, result: { message_id: 1 } }; } });
  assert.equal(messages.length, 1);
  assert.match(messages[0].facts[0], /큐 손상/);
  assert.ok(readdirSync(join(input.journalRoot, '..')).some((name) => name.startsWith('deferred.json.corrupt-')));
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).pending.length, 1);
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).corrupt, undefined);
});

test('JSON 형식은 맞지만 null 항목인 큐도 격리한다', async (t) => {
  const input = setup(t);
  const queueFile = join(input.journalRoot, '..', 'deferred.json');
  writeFileSync(queueFile, JSON.stringify({ pending: [null], inFlight: [] }));
  const sent = [];
  await sendDirectWarning({ ...input, queueFile, clock: () => Date.parse('2026-10-11T15:00:00Z'),
    message: { agent: 'zeus', facts: ['새 경고'] },
    send: async (message) => { sent.push(message); return { ok: true, result: { message_id: 1 } }; } });
  assert.equal(sent.length, 1);
  assert.match(sent[0].facts[0], /큐 손상/);
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).pending.length, 1);
});

test('정리 발송 뒤 원장 쓰기가 실패하면 확인 상태를 큐에 보존하고 원장만 재시도한다', async (t) => {
  const input = setup(t);
  const queueFile = join(input.journalRoot, '..', 'deferred.json');
  const night = Date.parse('2026-10-11T15:00:00Z');
  const morning = Date.parse('2026-10-11T22:00:00Z');
  await sendDirectWarning({ ...input, queueFile, clock: () => night,
    message: { agent: 'zeus', facts: ['원본'] }, send: async () => { throw new Error('unexpected'); } });
  const backup = `${input.journalRoot}-backup`;
  renameSync(input.journalRoot, backup);
  writeFileSync(input.journalRoot, 'blocked');
  let sends = 0;
  const options = { queueFile, now: morning, journalRoot: join(input.journalRoot, '..', 'wrong-root'),
    logger: { error() {} }, send: async () => ({ ok: true, result: { message_id: ++sends } }) };
  await drainDeferredWarnings(options);
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).inFlight[0].digestSentMessageId, 1);
  rmSync(input.journalRoot);
  renameSync(backup, input.journalRoot);
  await drainDeferredWarnings({ ...options, now: morning + 60_000 });
  assert.equal(sends, 1);
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).inFlight.length, 0);
  assert.equal(readWarningEvents({ rootDir: input.journalRoot }).events.at(-1).deliveryStatus, 'sent');
});

test('보류 큐 쓰기에 실패하면 원래 경고를 즉시 전송한다', async (t) => {
  const input = setup(t);
  const blocked = join(input.journalRoot, '..', 'blocked');
  writeFileSync(blocked, 'file occupies parent path');
  const queueFile = join(blocked, 'deferred.json');
  let sends = 0;
  await sendDirectWarning({ ...input, queueFile, clock: () => Date.parse('2026-10-11T15:00:00Z'),
    message: '보존할 경고', logger: { error() {} },
    send: async () => ({ ok: true, result: { message_id: ++sends } }) });
  assert.equal(sends, 1);
});

test('정리 응답 불명이 30분 넘으면 원본 재발송 없이 한 번만 통지한다', async (t) => {
  const input = setup(t);
  const queueFile = join(input.journalRoot, '..', 'deferred.json');
  const night = Date.parse('2026-10-11T15:00:00Z');
  const morning = Date.parse('2026-10-11T22:00:00Z');
  await sendDirectWarning({ ...input, queueFile, clock: () => night,
    message: { agent: 'zeus', facts: ['원본'] }, send: async () => { throw new Error('unexpected'); } });
  let sends = 0;
  const send = async (_message, chatId) => { assert.equal(chatId, undefined);
    sends++; if (sends === 1) throw new Error('응답 불명');
    return { ok: true, result: { message_id: sends } }; };
  await drainDeferredWarnings({ queueFile, now: morning, send, logger: { error() {} }, journalRoot: input.journalRoot });
  await drainDeferredWarnings({ queueFile, now: morning + 31 * 60_000, send, journalRoot: input.journalRoot });
  await drainDeferredWarnings({ queueFile, now: morning + 60 * 60_000, send, journalRoot: input.journalRoot });
  assert.equal(sends, 2);
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).inFlight[0].unknownNotified, true);
});

test('9시간 넘게 pending인 큐는 조용한 시간에도 critical 경보를 한 번 보낸다', async (t) => {
  const input = setup(t);
  const queueFile = join(input.journalRoot, '..', 'deferred.json');
  const night = Date.parse('2026-10-11T15:00:00Z');
  await sendDirectWarning({ ...input, queueFile, clock: () => night,
    message: { agent: 'zeus', facts: ['원본'] }, send: async () => { throw new Error('unexpected'); } });
  const notices = [];
  const options = { queueFile, now: night + 10 * 3600_000,
    send: async (message, chatId) => { assert.equal(chatId, undefined);
      notices.push(message); return { ok: true, result: { message_id: 1 } }; } };
  await drainDeferredWarnings(options);
  await drainDeferredWarnings(options);
  assert.equal(notices.filter((message) => message.topic === '긴급 경고').length, 1);
  assert.match(notices[0].facts[0], /지연/);
});

test('테스트에서 기본 실볼트 큐 경로를 사용하면 쓰지 않고 거부한다', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT);
  await assert.rejects(() => sendDirectWarning({ message: 'test', jobName: 'test-job',
    warningCode: 'TEST_QUEUE_GUARD', subjectKey: 'guard', kind: 'operational', severity: 'high',
    clock: () => Date.parse('2026-10-11T15:00:00Z'),
    journalRoot: join(tmpdir(), 'guard-journal-' + Date.now()),
    send: async () => ({ ok: true, result: { message_id: 1 } }), logger: { error() {} } }),
  /실볼트/);
});

test('큐 기록 뒤 손상 알림이 실패해도 경고는 보류된 것으로 남는다', async (t) => {
  const input = setup(t);
  const queueFile = join(input.journalRoot, '..', 'deferred.json');
  writeFileSync(queueFile, '{broken');
  const errors = [];
  const entry = await deferWarning({ queueFile, agent: 'zeus', detail: '가상 경고',
    sendCritical: async () => { throw new Error('전송 실패'); },
    logger: { error: (message) => errors.push(message) } });
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).pending[0].id, entry.id);
  assert.match(errors[0], /손상 알림 실패/);
});

test('동시 drain은 지연 critical을 한 번만 선점한다', async (t) => {
  const input = setup(t);
  const queueFile = join(input.journalRoot, '..', 'deferred.json');
  const night = Date.parse('2026-10-11T15:00:00Z');
  await deferWarning({ queueFile, detail: '가상 경고', at: night });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let sends = 0;
  const options = { queueFile, now: night + 10 * 3600_000,
    sendCritical: async () => { sends++; started(); await gate;
      return { ok: true, result: { message_id: 1 } }; } };
  const first = drainDeferredWarnings(options);
  await entered;
  await drainDeferredWarnings(options);
  release();
  await first;
  assert.equal(sends, 1);
});

test('동시 drain은 전달 불명 critical을 한 번만 선점하고 7일 뒤 보관한다', async (t) => {
  const input = setup(t);
  const queueFile = join(input.journalRoot, '..', 'deferred.json');
  const night = Date.parse('2026-10-11T15:00:00Z');
  const morning = Date.parse('2026-10-11T22:00:00Z');
  await deferWarning({ queueFile, detail: '가상 경고', at: night });
  await drainDeferredWarnings({ queueFile, now: morning,
    send: async () => { throw new Error('응답 불명'); }, logger: { error() {} } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let sends = 0;
  const options = { queueFile, now: morning + 31 * 60_000,
    sendCritical: async () => { sends++; started(); await gate;
      return { ok: true, result: { message_id: 2 } }; } };
  const first = drainDeferredWarnings(options);
  await entered;
  await drainDeferredWarnings(options);
  release();
  await first;
  assert.equal(sends, 1);
  await drainDeferredWarnings({ queueFile, now: morning + 8 * 24 * 3600_000 });
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).inFlight.length, 0);
  assert.equal(readFileSync(`${queueFile}.unknown-archive.jsonl`, 'utf8').trim().split('\n').length, 1);
});

test('critical 전송이 거절되면 선점을 풀고, 오래된 불명 항목은 알림 없이도 보관한다', async (t) => {
  const input = setup(t);
  const queueFile = join(input.journalRoot, '..', 'deferred.json');
  const night = Date.parse('2026-10-11T15:00:00Z');
  await deferWarning({ queueFile, detail: '가상 경고', at: night });
  const rejection = Object.assign(new Error('거절'), { telegramExplicitRejection: true });
  await assert.rejects(() => drainDeferredWarnings({ queueFile, now: night + 10 * 3600_000,
    sendCritical: async () => { throw rejection; } }), (error) => error === rejection);
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).pending[0].staleNotifyingAt, undefined);
  await drainDeferredWarnings({ queueFile, now: night + 10 * 3600_000,
    sendCritical: async () => ({ ok: true, result: { message_id: 1 } }),
    send: async () => { throw new Error('응답 불명'); }, logger: { error() {} } });
  const morning = night + 10 * 3600_000;
  await assert.rejects(() => drainDeferredWarnings({ queueFile, now: morning + 31 * 60_000,
    sendCritical: async () => { throw rejection; } }), (error) => error === rejection);
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).inFlight[0].unknownNotifyingAt, undefined);
  const logs = [];
  await drainDeferredWarnings({ queueFile, now: morning + 8 * 24 * 3600_000,
    logger: { error: (message) => logs.push(message) } });
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).inFlight.length, 0);
  assert.match(logs[0], /보관/);
});

test('7일 동안 drain이 없던 전달 불명도 보관하며 critical 한 번을 보낸다', async (t) => {
  const input = setup(t);
  const queueFile = join(input.journalRoot, '..', 'deferred.json');
  const night = Date.parse('2026-10-11T15:00:00Z');
  const morning = Date.parse('2026-10-11T22:00:00Z');
  await deferWarning({ queueFile, detail: '가상 경고', at: night });
  await drainDeferredWarnings({ queueFile, now: morning,
    send: async () => { throw new Error('응답 불명'); }, logger: { error() {} } });
  let notices = 0;
  const options = { queueFile, now: morning + 8 * 24 * 3600_000,
    sendCritical: async () => { notices++; return { ok: true, result: { message_id: 3 } }; } };
  await drainDeferredWarnings(options);
  await drainDeferredWarnings(options);
  assert.equal(notices, 1);
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).inFlight.length, 0);
});
