import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendWarningEvent } from './warning-event-journal.mjs';
import { queryWarningIncidents } from './warning-incident-query.mjs';
import { formatWarningQuery, parseWarningQueryArgs } from '../tools/query-warning-incidents.mjs';

function tempRoot(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'warning-query-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

async function append(rootDir, overrides = {}) {
  return appendWarningEvent({
    eventId: randomUUID(), occurredAt: '2026-09-29T16:10:00.000Z',
    incidentId: 'incident-operational', jobName: 'intraday-market-move-monitor',
    warningCode: 'BREAKOUT_INDEX_QUERY_FAILED', subjectKey: 'market:KOSPI',
    kind: 'operational', severity: 'high', eventType: 'detected',
    ...overrides,
  }, { rootDir });
}

test('KST 최근 발생일, 잡, 종류, 사건, 전달상태, 미해결 필터를 조합해 조회한다', async (t) => {
  const rootDir = tempRoot(t);
  await append(rootDir);
  await append(rootDir, { eventType: 'delivery', deliveryStatus: 'unknown', deliveryAttemptId: randomUUID() });
  await append(rootDir, {
    incidentId: 'incident-market', jobName: 'daily-asset-allocation-check',
    warningCode: 'MARKET_OVERLAY_SIGNAL', subjectKey: 'macro:overlay', kind: 'market-signal',
    occurredAt: '2026-09-30T16:10:00.000Z',
  });
  await append(rootDir, {
    incidentId: 'incident-resolved', jobName: 'health-watcher', warningCode: 'JOB_HEALTH_ISSUES',
    subjectKey: 'batch', kind: 'operational', occurredAt: '2026-09-29T17:00:00.000Z',
  });
  await append(rootDir, {
    incidentId: 'incident-resolved', jobName: 'health-watcher', warningCode: 'JOB_HEALTH_ISSUES',
    subjectKey: 'batch', kind: 'operational', eventType: 'status', incidentStatus: 'resolved',
    occurredAt: '2026-09-29T17:01:00.000Z',
  });
  const filters = {
    from: '2026-09-30', to: '2026-09-30', job: 'intraday-market-move-monitor',
    kind: 'operational', incident: 'incident-operational',
    warningCode: 'BREAKOUT_INDEX_QUERY_FAILED', delivery: 'unknown', unresolved: true,
  };
  const result = queryWarningIncidents({ rootDir, filters, now: '2026-09-29T17:20:00.000Z' });
  assert.equal(result.total, 1);
  assert.equal(result.incidents[0].incidentId, 'incident-operational');
  assert.equal(result.incidents[0].unknownDeliveryCount, 1);
  assert.equal(result.incidents[0].oldestUnknownAgeMinutes, 70);
  assert.equal(result.incidents[0].classification, 'cataloged');
  assert.equal(queryWarningIncidents({ rootDir, filters: { from: '2026-10-01' } }).total, 1);
  assert.equal(queryWarningIncidents({ rootDir, filters: { unresolved: true } }).total, 2);
  assert.equal(queryWarningIncidents({ rootDir, filters: { limit: 1 } }).incidents.length, 1);
});

test('레거시 사건은 조회만 하고, 5분 지난 미완결 전송과 손상 행을 숨기지 않는다', async (t) => {
  const rootDir = tempRoot(t);
  await append(rootDir, {
    incidentId: 'incident-legacy', warningCode: 'LEGACY_WARNING_BATCH',
    subjectKey: 'batch', kind: 'legacy-unstructured', severity: 'unclassified',
  });
  await append(rootDir, {
    incidentId: 'incident-legacy', warningCode: 'LEGACY_WARNING_BATCH',
    subjectKey: 'batch', kind: 'legacy-unstructured', severity: 'unclassified',
    eventType: 'delivery', deliveryStatus: 'sending', deliveryAttemptId: randomUUID(),
  });
  appendFileSync(join(rootDir, '2026-09.jsonl'), '{broken}\n');
  const result = queryWarningIncidents({ rootDir, now: '2026-09-29T16:16:00.000Z' });
  assert.equal(result.incidents[0].classification, 'legacy');
  assert.equal(result.incidents[0].incompleteDeliveryCount, 1);
  assert.equal(result.incidents[0].oldestIncompleteAgeMinutes, 6);
  assert.equal(result.invalidRows.length, 1);
  assert.match(formatWarningQuery(result), /재발송 금지/);
});

test('조회 CLI는 잘못된 날짜·필터를 거부하고 격리 원장만 읽는다', async (t) => {
  assert.throws(() => parseWarningQueryArgs(['--from=2026-02-30']), /YYYY-MM-DD/);
  assert.throws(() => parseWarningQueryArgs(['--from=2026-10-01', '--to=2026-09-30']), /늦음/);
  assert.throws(() => parseWarningQueryArgs(['--kind=unknown']), /분류값/);
  assert.throws(() => parseWarningQueryArgs(['--limit=0']), /1~500/);
  assert.throws(() => parseWarningQueryArgs(['--oops=1']), /알 수 없는/);
  const rootDir = tempRoot(t);
  await append(rootDir);
  const cli = new URL('../tools/query-warning-incidents.mjs', import.meta.url).pathname;
  const output = execFileSync(process.execPath, [cli, `--journal-root=${rootDir}`, '--json'], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0].warningCode, 'BREAKOUT_INDEX_QUERY_FAILED');
  assert.equal(result.invalidRows.length, 0);
});

test('이전 전달 불명은 뒤이은 전송 성공 후에도 조회되고, 충돌 행은 집계하지 않는다', async (t) => {
  const rootDir = tempRoot(t);
  await append(rootDir);
  const unknownAttempt = randomUUID();
  await append(rootDir, {
    eventType: 'delivery', deliveryStatus: 'unknown', deliveryAttemptId: unknownAttempt,
  });
  await append(rootDir, {
    eventType: 'delivery', deliveryStatus: 'sent', deliveryAttemptId: randomUUID(),
    telegramMessageId: 42, occurredAt: '2026-09-29T16:11:00.000Z',
  });
  await append(rootDir, {
    warningCode: 'JOB_HEALTH_ISSUES', eventType: 'delivery',
    deliveryStatus: 'unknown', deliveryAttemptId: randomUUID(),
  });
  const result = queryWarningIncidents({ rootDir, filters: { delivery: 'unknown' } });
  assert.equal(result.total, 1);
  assert.equal(result.incidents[0].lastDeliveryStatus, 'sent');
  assert.equal(result.incidents[0].unknownDeliveryCount, 1);
  assert.deepEqual(result.invalidRows.map((row) => row.reason), ['사건 ID 키 충돌']);
});

test('조회 결과는 숫자형 민감 식별자를 내보내지 않고 가린 ID로 재조회할 수 있다', async (t) => {
  const rootDir = tempRoot(t);
  await append(rootDir, { incidentId: '123456789012', jobName: '123456789012' });
  await append(rootDir, { incidentId: '205-0159-6019', jobName: '205-0159-6019' });
  const result = queryWarningIncidents({ rootDir });
  assert.doesNotMatch(JSON.stringify(result), /123456789012/);
  assert.doesNotMatch(JSON.stringify(result), /205-0159-6019/);
  for (const incident of result.incidents) {
    assert.match(incident.incidentId, /^redacted-/);
    assert.equal(queryWarningIncidents({ rootDir, filters: { incident: incident.incidentId } }).total, 1);
  }
});

test('KST 날짜 필터는 전달·해결일이 아닌 마지막 실제 감지일을 사용한다', async (t) => {
  const rootDir = tempRoot(t);
  await append(rootDir, { occurredAt: '2026-09-29T14:00:00.000Z' }); // KST 29일
  await append(rootDir, {
    occurredAt: '2026-09-29T16:00:00.000Z', eventType: 'status', incidentStatus: 'resolved',
  }); // KST 30일
  assert.equal(queryWarningIncidents({ rootDir, filters: { from: '2026-09-30' } }).total, 0);
  const result = queryWarningIncidents({ rootDir, filters: { to: '2026-09-29' } });
  assert.equal(result.total, 1);
  assert.equal(result.incidents[0].lastDetectedAt, '2026-09-29T14:00:00.000Z');
  assert.equal(result.incidents[0].status, 'resolved');
});

test('단일 읽기 재조회 결과는 전달·사건 해결과 별도 축으로 조회한다', async (t) => {
  const rootDir = tempRoot(t);
  await append(rootDir, {
    occurredAt: '2026-09-30T01:00:00.000Z', warningCode: 'MACRO_YFINANCE_QUERY_FAILED',
  });
  await append(rootDir, {
    occurredAt: '2026-09-30T01:31:00.000Z', warningCode: 'MACRO_YFINANCE_QUERY_FAILED',
    eventType: 'action', actionId: 'MACRO_SINGLE_READ_RETRY', actionStatus: 'running',
  });
  await append(rootDir, {
    occurredAt: '2026-09-30T01:31:01.000Z', warningCode: 'MACRO_YFINANCE_QUERY_FAILED',
    eventType: 'action', actionId: 'MACRO_SINGLE_READ_RETRY', actionStatus: 'succeeded',
    actionOutcome: 'source-available-now',
  });
  const result = queryWarningIncidents({ rootDir }).incidents[0];
  assert.equal(result.actionAttemptCount, 1);
  assert.equal(result.lastActionStatus, 'succeeded');
  assert.equal(result.lastActionOutcome, 'source-available-now');
  assert.equal(result.status, 'open');
  assert.equal(result.lastDeliveryStatus, null);
});
