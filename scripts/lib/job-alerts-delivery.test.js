import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectWarning, flushWarnings, resetWarnings, warningsSignature } from './job-alerts.mjs';
import { appendWarningEvent, readWarningEvents } from './warning-event-journal.mjs';
import { queryWarningIncidents } from './warning-incident-query.mjs';

function paths(t) {
  const dir = mkdtempSync(join(tmpdir(), 'job-alerts-delivery-'));
  t.after(() => { resetWarnings(); rmSync(dir, { recursive: true, force: true }); });
  return { stateFile: join(dir, 'job-alerts.json'), journalRoot: join(dir, 'warning-events') };
}

test('성공 응답만 sent로 기록하고 기존 배치 서명의 24시간 억제를 유지한다', async (t) => {
  const config = paths(t);
  resetWarnings();
  collectWarning('시험 경고 원문 — 원장에 요약 저장');
  let sends = 0;
  const options = {
    ...config, now: () => Date.parse('2026-09-30T01:00:00.000Z'),
    sendImpl: async () => { sends++; return { ok: true, result: { message_id: 1234 } }; },
  };
  assert.equal((await flushWarnings('test-job', options)).status, 'sent');
  assert.equal((await flushWarnings('test-job', options)).status, 'suppressed');
  assert.equal(sends, 1);
  const events = readWarningEvents({ rootDir: config.journalRoot }).events;
  assert.deepEqual(events.map((event) => event.deliveryStatus).filter(Boolean), [
    'reserved', 'sending', 'sent', 'suppressed',
  ]);
  assert.equal(events.find((event) => event.deliveryStatus === 'sent').telegramMessageId, 1234);
  assert.equal(events.every((event) => event.detail === '시험 경고 원문 — 원장에 요약 저장'), true);
  assert.deepEqual(JSON.parse(readFileSync(config.stateFile, 'utf8'))['test-job'], {
    sig: warningsSignature(['시험 경고 원문 — 원장에 요약 저장']),
    ts: options.now(),
  });
});

test('구조화 경고는 기존 텔레그램 배치 1건과 별도 사건으로 연결되고 전달 상태도 공유한다', async (t) => {
  const config = paths(t);
  resetWarnings();
  collectWarning('yfinance 거시 조회 실패', {
    warningCode: 'MACRO_YFINANCE_QUERY_FAILED', subjectKey: 'macro:yfinance',
    kind: 'operational', severity: 'medium',
  });
  collectWarning('다른 거시 조회 오류', {
    warningCode: 'MACRO_YFINANCE_RESPONSE_INVALID', subjectKey: 'macro:yfinance',
    kind: 'data-quality', severity: 'medium',
  });
  let sends = 0;
  const options = {
    ...config, now: () => Date.parse('2026-09-30T01:00:00.000Z'),
    sendImpl: async () => { sends++; return { ok: true, result: { message_id: 1234 } }; },
  };
  assert.equal((await flushWarnings('intraday-market-move-monitor', options)).status, 'sent');
  assert.equal(sends, 1);
  const events = readWarningEvents({ rootDir: config.journalRoot }).events;
  for (const code of ['LEGACY_WARNING_BATCH', 'MACRO_YFINANCE_QUERY_FAILED', 'MACRO_YFINANCE_RESPONSE_INVALID']) {
    const own = events.filter((event) => event.warningCode === code);
    assert.deepEqual(own.map((event) => event.eventType === 'detected' ? 'detected' : event.deliveryStatus),
      ['detected', 'reserved', 'sending', 'sent']);
    assert.equal(own.at(-1).telegramMessageId, 1234);
  }
  const query = queryWarningIncidents({ rootDir: config.journalRoot });
  assert.equal(query.total, 3);
  assert.equal(query.incidents.every((incident) => incident.lastDeliveryStatus === 'sent'), true);
  const sentEvents = events.filter((event) => event.deliveryStatus === 'sent');
  assert.deepEqual(sentEvents.map((event) => event.warningCode), [
    'MACRO_YFINANCE_QUERY_FAILED', 'MACRO_YFINANCE_RESPONSE_INVALID', 'LEGACY_WARNING_BATCH',
  ]);
  assert.equal(events.find((event) => event.warningCode === 'MACRO_YFINANCE_QUERY_FAILED').detail,
    'yfinance 거시 조회 실패');
  assert.match(events.find((event) => event.warningCode === 'LEGACY_WARNING_BATCH').detail,
    /yfinance 거시 조회 실패.*다른 거시 조회 오류/);
  assert.equal((await flushWarnings('intraday-market-move-monitor', options)).status, 'suppressed');
  const after = readWarningEvents({ rootDir: config.journalRoot }).events;
  assert.equal(after.filter((event) => event.warningCode === 'MACRO_YFINANCE_QUERY_FAILED'
    && event.deliveryStatus === 'suppressed').length, 1);
});

test('배치 상세는 묶인 경고를 요약하고 비밀값을 가려 200자로 제한한다', async (t) => {
  const config = paths(t);
  resetWarnings();
  collectWarning('NH 예수금조회 실패 Bearer private-token 계좌 12345678901');
  collectWarning(`KIS 응답 누락 token=private ${'x'.repeat(250)}`);
  await flushWarnings('reconcile-nh-cash', {
    ...config, sendImpl: async () => ({ ok: true, result: { message_id: 8 } }),
  });
  const events = readWarningEvents({ rootDir: config.journalRoot }).events;
  assert.equal(events.every((event) => event.detail.length <= 200), true);
  assert.match(events[0].detail, /NH 예수금조회 실패/);
  assert.match(events[0].detail, /KIS 응답 누락/);
  assert.doesNotMatch(events[0].detail, /private-token|12345678901|token=private/);
});

test('원인별 terminal 기록이 실패하면 배치 terminal을 완료로 남기지 않는다', async (t) => {
  const config = paths(t);
  resetWarnings();
  collectWarning('경고는 발송되지만 메타데이터가 잘못됨', {
    warningCode: 'invalid-code', subjectKey: 'macro:yfinance',
    kind: 'operational', severity: 'medium',
  });
  const logged = [];
  const result = await flushWarnings('test-job', {
    ...config, sendImpl: async () => ({ ok: true, result: { message_id: 123 } }),
    logger: { error: (message) => logged.push(message) },
  });
  assert.equal(result.status, 'sent'); // Bot API 결과는 그대로 보고한다.
  assert.ok(logged.some((message) => message.includes('원장 기록 실패')));
  const events = readWarningEvents({ rootDir: config.journalRoot }).events;
  assert.equal(events.some((event) => event.warningCode === 'LEGACY_WARNING_BATCH'
    && event.deliveryStatus === 'sent'), false);
  assert.equal(events.some((event) => event.warningCode === 'LEGACY_WARNING_BATCH'
    && event.deliveryStatus === 'sending'), true);
});

test('기존 sig/ts 상태만 있는 잡도 동일하게 억제한다', async (t) => {
  const config = paths(t);
  resetWarnings();
  collectWarning('기존 경고');
  const now = Date.parse('2026-09-30T01:00:00.000Z');
  writeFileSync(config.stateFile, JSON.stringify({
    'test-job': { sig: warningsSignature(['기존 경고']), ts: now - 1000 },
  }));
  const result = await flushWarnings('test-job', {
    ...config, now: () => now,
    sendImpl: async () => { throw new Error('발송되면 안 됨'); },
  });
  assert.equal(result.status, 'suppressed');
  assert.equal(result.reason, 'recent-send');
});

test('응답 불명은 unknown으로 기록하고 같은 배치를 자동 재발송하지 않는다', async (t) => {
  const config = paths(t);
  resetWarnings();
  collectWarning('네트워크 결과 불명');
  let sends = 0;
  const options = {
    ...config, now: () => Date.parse('2026-09-30T01:00:00.000Z'),
    sendImpl: async () => { sends++; throw new Error('connection lost'); },
  };
  assert.equal((await flushWarnings('test-job', options)).status, 'unknown');
  assert.deepEqual(await flushWarnings('test-job', options), {
    status: 'suppressed', reason: 'unknown-delivery',
  });
  assert.equal(sends, 1);
  assert.equal(readWarningEvents({ rootDir: config.journalRoot }).events
    .some((event) => event.deliveryStatus === 'unknown'), true);
});

test('명시적 거부는 rejected로 기록하고 다음 실행에서 재시도할 수 있다', async (t) => {
  const config = paths(t);
  resetWarnings();
  collectWarning('전송 거부');
  const rejection = Object.assign(new Error('Telegram 400'), { telegramExplicitRejection: true });
  const first = await flushWarnings('test-job', {
    ...config, sendImpl: async () => { throw rejection; },
  });
  assert.equal(first.status, 'rejected');
  const second = await flushWarnings('test-job', {
    ...config, sendImpl: async () => ({ ok: true, result: { message_id: 9876 } }),
  });
  assert.equal(second.status, 'sent');
});

test('원장 기록 실패는 경고 발송을 막거나 자기 자신을 다시 알리지 않는다', async (t) => {
  const config = paths(t);
  resetWarnings();
  collectWarning('원장 장애 중에도 발송');
  writeFileSync(config.journalRoot, '디렉터리 자리에 기존 파일');
  let sends = 0;
  const result = await flushWarnings('test-job', {
    ...config,
    sendImpl: async () => { sends++; return { ok: true, result: { message_id: 34 } }; },
  });
  assert.equal(result.status, 'sent');
  assert.equal(sends, 1);
});

test('동시 flush는 첫 발송의 응답을 기다리는 동안 두 번째를 억제한다', async (t) => {
  const config = paths(t);
  resetWarnings();
  collectWarning('동시 실행 경고');
  let release;
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const reply = new Promise((resolve) => { release = resolve; });
  let sends = 0;
  const options = {
    ...config,
    sendImpl: async () => {
      sends++;
      started();
      return reply;
    },
  };
  const first = flushWarnings('test-job', options);
  await began;
  assert.deepEqual(await flushWarnings('test-job', options), {
    status: 'suppressed', reason: 'active-reservation',
  });
  release({ ok: true, result: { message_id: 4321 } });
  assert.equal((await first).status, 'sent');
  assert.equal(sends, 1);
});

test('중단된 예약은 unknown으로 확정하고 같은 경고를 자동 재발송하지 않는다', async (t) => {
  const config = paths(t);
  resetWarnings();
  collectWarning('중단된 발송');
  const sig = warningsSignature(['중단된 발송']);
  writeFileSync(config.stateFile, JSON.stringify({
    'test-job': { reservations: { [sig]: {
      attemptId: randomUUID(), phase: 'sending',
      createdAt: Date.parse('2026-09-29T00:00:00.000Z'), pid: 99999999,
    } } },
  }));
  let sends = 0;
  const result = await flushWarnings('test-job', {
    ...config, now: () => Date.parse('2026-09-30T00:00:00.000Z'),
    sendImpl: async () => { sends++; return { ok: true, result: { message_id: 1 } }; },
  });
  assert.deepEqual(result, { status: 'suppressed', reason: 'unknown-delivery' });
  assert.equal(sends, 0);
  assert.equal(readWarningEvents({ rootDir: config.journalRoot }).events
    .some((event) => event.deliveryStatus === 'unknown'), true);
});

test('원장에는 sent가 남고 상태 확정 전에 중단돼도 재시작 후 중복 발송하지 않는다', async (t) => {
  const config = paths(t);
  resetWarnings();
  collectWarning('상태 확정 전 중단');
  const sig = warningsSignature(['상태 확정 전 중단']);
  const attemptId = randomUUID();
  writeFileSync(config.stateFile, JSON.stringify({
    'test-job': { reservations: { [sig]: {
      attemptId, phase: 'sending', createdAt: Date.parse('2026-09-29T00:00:00.000Z'), pid: 99999999,
    } } },
  }));
  await appendWarningEvent({
    eventId: randomUUID(), occurredAt: '2026-09-30T00:00:00.000Z',
    incidentId: 'legacy-recovery', jobName: 'test-job', warningCode: 'LEGACY_WARNING_BATCH',
    subjectKey: 'batch', kind: 'legacy-unstructured', severity: 'unclassified',
    eventType: 'delivery', deliveryStatus: 'sent', deliveryAttemptId: attemptId,
    telegramMessageId: 77, legacyFingerprint: sig,
  }, { rootDir: config.journalRoot });
  let sends = 0;
  const result = await flushWarnings('test-job', {
    ...config, now: () => Date.parse('2026-09-30T00:01:00.000Z'),
    sendImpl: async () => { sends++; return { ok: true, result: { message_id: 78 } }; },
  });
  assert.deepEqual(result, { status: 'suppressed', reason: 'recent-send' });
  assert.equal(sends, 0);
  assert.deepEqual(JSON.parse(readFileSync(config.stateFile, 'utf8'))['test-job'], {
    sig, ts: Date.parse('2026-09-30T00:00:00.000Z'),
  });
});

test('Bot API 응답에 메시지 ID가 없으면 성공으로 추정하지 않는다', async (t) => {
  const config = paths(t);
  resetWarnings();
  collectWarning('응답 불완전');
  const result = await flushWarnings('test-job', {
    ...config, sendImpl: async () => ({ ok: true, result: {} }),
  });
  assert.equal(result.status, 'unknown');
  assert.equal(readWarningEvents({ rootDir: config.journalRoot }).events
    .some((event) => event.deliveryStatus === 'sent'), false);
});

test('dry-run은 전송 및 원장 기록을 하지 않는다', async (t) => {
  const config = paths(t);
  resetWarnings();
  collectWarning('드라이런 경고');
  const result = await flushWarnings('test-job', {
    ...config, dryRun: true,
    sendImpl: async () => { throw new Error('드라이런에서 전송하면 안 됨'); },
  });
  assert.equal(result.status, 'dry-run');
  assert.deepEqual(readWarningEvents({ rootDir: config.journalRoot }).events, []);
});

test('다른 프로세스 예약 잠금을 확인할 수 없으면 전송하지 않는다', async (t) => {
  const config = paths(t);
  resetWarnings();
  collectWarning('락 충돌 경고');
  writeFileSync(`${config.stateFile}.lock`, `${process.pid}:${randomUUID()}`);
  let sends = 0;
  const result = await flushWarnings('test-job', {
    ...config,
    sendImpl: async () => { sends++; return { ok: true, result: { message_id: 3 } }; },
    logger: { error() {} },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(sends, 0);
});
