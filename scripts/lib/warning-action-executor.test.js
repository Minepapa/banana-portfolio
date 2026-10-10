import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendWarningEvent, readWarningEvents, rebuildWarningIncidents } from './warning-event-journal.mjs';
import { markMacroWarningRecovered, runMacroReadRetry } from './warning-action-executor.mjs';
import { deliverWarningBatch } from './warning-batch-delivery.mjs';

const FIRST_WARNING = '2026-09-30T01:00:00.000Z';
const AFTER_COOLDOWN = '2026-09-30T01:31:00.000Z';

async function recordedIncident(t, overrides = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'warning-action-executor-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const incidentId = `coded-${randomUUID()}`;
  await appendWarningEvent({
    eventId: randomUUID(), occurredAt: FIRST_WARNING, incidentId,
    jobName: 'intraday-market-move-monitor', warningCode: 'MACRO_YFINANCE_QUERY_FAILED',
    subjectKey: 'macro:yfinance', kind: 'operational', severity: 'medium',
    eventType: 'detected', ...overrides,
  }, { rootDir });
  return { rootDir, incidentId };
}

const available = () => ({ status: 0, stdout: JSON.stringify({ '^VIX': [24.5] }) });

test('dry-run과 shadow는 네트워크·원장을 건드리지 않고 30분 간격을 검증한다', async (t) => {
  const { rootDir, incidentId } = await recordedIncident(t);
  let probes = 0;
  const options = { rootDir, probe: () => { probes++; return available(); },
    fileExists: () => true };
  const early = await runMacroReadRetry(incidentId, {
    ...options, now: () => new Date('2026-09-30T01:29:59.000Z'),
  });
  assert.equal(early.executed, false);
  assert.match(early.reason, /30분/);
  for (const mode of ['dry-run', 'shadow']) {
    const result = await runMacroReadRetry(incidentId, {
      ...options, mode, now: () => new Date(AFTER_COOLDOWN),
    });
    assert.equal(result.wouldRun, true);
    assert.equal(result.executed, false);
  }
  assert.equal(probes, 0);
  assert.equal(readWarningEvents({ rootDir }).events.length, 1);
});

test('live는 고정 VIX 한 번만 읽고 running·succeeded를 남기되 사건은 해결하지 않는다', async (t) => {
  const { rootDir, incidentId } = await recordedIncident(t);
  const calls = [];
  const options = {
    rootDir, mode: 'live', now: () => new Date(AFTER_COOLDOWN), fileExists: () => true,
    probe: (...args) => { calls.push(args); return available(); },
  };
  const result = await runMacroReadRetry(incidentId, options);
  assert.equal(result.executed, true);
  assert.equal(result.actionStatus, 'succeeded');
  assert.equal(result.incidentResolved, false);
  assert.deepEqual(calls[0][1].at(-1), '^VIX');
  assert.equal(calls[0][2].timeout, 15_000);
  assert.equal(calls.length, 1);
  assert.deepEqual(readWarningEvents({ rootDir }).events
    .filter((event) => event.eventType === 'action').map((event) => event.actionStatus),
  ['running', 'succeeded']);
  assert.deepEqual(readWarningEvents({ rootDir }).events
    .filter((event) => event.eventType === 'action').map((event) => event.detail),
  ['^VIX 단일 재조회 시작', '^VIX 단일 재조회: source-available-now']);
  assert.equal((await runMacroReadRetry(incidentId, options)).executed, false);
  assert.equal(calls.length, 1);
});

test('동시 실행도 사건당 한 번만 조회하며 실패 뒤 자동 재시도하지 않는다', async (t) => {
  const { rootDir, incidentId } = await recordedIncident(t);
  let probes = 0;
  const options = {
    rootDir, mode: 'live', now: () => new Date(AFTER_COOLDOWN), fileExists: () => true,
    probe: () => { probes++; return { status: 0, stdout: JSON.stringify({ '^VIX': [] }) }; },
  };
  const results = await Promise.all([
    runMacroReadRetry(incidentId, options), runMacroReadRetry(incidentId, options),
  ]);
  assert.equal(results.filter((result) => result.executed).length, 1);
  assert.equal(probes, 1);
  assert.equal(readWarningEvents({ rootDir }).events.at(-1).actionOutcome, 'data-empty');
  assert.equal((await runMacroReadRetry(incidentId, options)).executed, false);
});

test('다른 코드·대상·종결 사건은 네트워크 이전에 거부한다', async (t) => {
  const { rootDir, incidentId } = await recordedIncident(t, { subjectKey: 'macro:other' });
  await assert.rejects(runMacroReadRetry(incidentId, {
    rootDir, mode: 'live', now: () => new Date(AFTER_COOLDOWN),
    probe: () => { throw new Error('조회하면 안 됨'); },
  }), /허용/);
});

test('첫 장애 재조회 뒤 5지표 회복·새 장애가 오면 새 구간에서 다시 한 번만 읽는다', async (t) => {
  const { rootDir, incidentId } = await recordedIncident(t);
  let probes = 0;
  const options = {
    rootDir, mode: 'live', fileExists: () => true,
    probe: () => { probes++; return available(); },
  };
  assert.equal((await runMacroReadRetry(incidentId, {
    ...options, now: () => new Date(AFTER_COOLDOWN),
  })).executed, true);
  assert.equal(await markMacroWarningRecovered({
    rootDir, observedAt: new Date('2026-09-30T01:40:00.000Z'),
    recordedAt: () => new Date('2026-09-30T01:40:05.000Z'),
  }), true);
  assert.equal(rebuildWarningIncidents({ rootDir }).incidents[0].status, 'resolved');
  await appendWarningEvent({
    eventId: randomUUID(), occurredAt: '2026-09-30T02:00:00.000Z',
    incidentId, jobName: 'intraday-market-move-monitor',
    warningCode: 'MACRO_YFINANCE_QUERY_FAILED', subjectKey: 'macro:yfinance',
    kind: 'operational', severity: 'medium', eventType: 'detected',
  }, { rootDir });
  assert.equal(rebuildWarningIncidents({ rootDir }).incidents[0].status, 'reopened');
  const later = { ...options, now: () => new Date('2026-09-30T02:31:00.000Z') };
  assert.equal((await runMacroReadRetry(incidentId, later)).executed, true);
  assert.equal((await runMacroReadRetry(incidentId, later)).executed, false);
  assert.equal(probes, 2);
});

test('조치안·dry-run 기록은 실제 조회 claim이 아니다', async (t) => {
  const { rootDir, incidentId } = await recordedIncident(t);
  await appendWarningEvent({
    eventId: randomUUID(), occurredAt: '2026-09-30T01:20:00.000Z',
    incidentId, jobName: 'intraday-market-move-monitor',
    warningCode: 'MACRO_YFINANCE_QUERY_FAILED', subjectKey: 'macro:yfinance',
    kind: 'operational', severity: 'medium', eventType: 'action',
    actionId: 'MACRO_SINGLE_READ_RETRY', actionStatus: 'dry-run', actionOutcome: 'probe-failed',
  }, { rootDir });
  const result = await runMacroReadRetry(incidentId, {
    rootDir, mode: 'live', now: () => new Date(AFTER_COOLDOWN),
    fileExists: () => true, probe: available,
  });
  assert.equal(result.executed, true);
});

test('월 경계에 새 원장 파일을 만든 running claim도 다음 실행의 중복 조회를 막는다', async (t) => {
  const { rootDir, incidentId } = await recordedIncident(t, {
    occurredAt: '2026-09-30T14:20:00.000Z', // KST 9월 30일 23:20
  });
  let probes = 0;
  const options = {
    rootDir, mode: 'live', now: () => new Date('2026-09-30T15:01:00.000Z'),
    fileExists: () => true, probe: () => { probes++; return available(); },
  };
  assert.equal((await runMacroReadRetry(incidentId, options)).executed, true);
  assert.equal(existsSync(join(rootDir, '2026-10.jsonl')), true);
  assert.equal((await runMacroReadRetry(incidentId, options)).executed, false);
  assert.equal(probes, 1);
});

test('정상 5지표 조회와 회복 기록 사이의 running은 이전 장애 구간에만 속한다', async (t) => {
  const { rootDir, incidentId } = await recordedIncident(t);
  let probes = 0;
  const options = { rootDir, mode: 'live', fileExists: () => true,
    probe: () => { probes++; return available(); } };
  await runMacroReadRetry(incidentId, {
    ...options, now: () => new Date('2026-09-30T01:40:02.000Z'),
  });
  assert.equal(await markMacroWarningRecovered({
    rootDir, observedAt: new Date('2026-09-30T01:40:00.000Z'),
    recordedAt: () => new Date('2026-09-30T01:40:05.000Z'),
  }), true);
  await appendWarningEvent({
    eventId: randomUUID(), occurredAt: '2026-09-30T02:00:00.000Z',
    incidentId, jobName: 'intraday-market-move-monitor',
    warningCode: 'MACRO_YFINANCE_QUERY_FAILED', subjectKey: 'macro:yfinance',
    kind: 'operational', severity: 'medium', eventType: 'detected',
  }, { rootDir });
  assert.equal((await runMacroReadRetry(incidentId, {
    ...options, now: () => new Date('2026-09-30T02:31:00.000Z'),
  })).executed, true);
  assert.equal(probes, 2);
});

test('정상 조회 뒤 회복 기록 전에 새 실패가 감지되면 회복 처리하지 않는다', async (t) => {
  const { rootDir, incidentId } = await recordedIncident(t);
  await appendWarningEvent({
    eventId: randomUUID(), occurredAt: '2026-09-30T01:40:02.000Z',
    incidentId, jobName: 'intraday-market-move-monitor',
    warningCode: 'MACRO_YFINANCE_QUERY_FAILED', subjectKey: 'macro:yfinance',
    kind: 'operational', severity: 'medium', eventType: 'detected',
  }, { rootDir });
  assert.equal(await markMacroWarningRecovered({
    rootDir, observedAt: new Date('2026-09-30T01:40:00.000Z'),
    recordedAt: () => new Date('2026-09-30T01:40:05.000Z'),
  }), false);
});

test('정상 조회와 같은 밀리초의 실패는 순서를 확정할 수 없어 회복을 보류한다', async (t) => {
  const { rootDir, incidentId } = await recordedIncident(t);
  await appendWarningEvent({
    eventId: randomUUID(), occurredAt: '2026-09-30T01:40:00.000Z',
    incidentId, jobName: 'intraday-market-move-monitor',
    warningCode: 'MACRO_YFINANCE_QUERY_FAILED', subjectKey: 'macro:yfinance',
    kind: 'operational', severity: 'medium', eventType: 'detected',
  }, { rootDir });
  assert.equal(await markMacroWarningRecovered({
    rootDir, observedAt: new Date('2026-09-30T01:40:00.000Z'),
    recordedAt: () => new Date('2026-09-30T01:40:05.000Z'),
  }), false);
});

test('회복 잠금 중 시작한 새 경고는 같은 밀리초라도 회복 뒤 감지로 남는다', async (t) => {
  const incidentId = `coded-${createHash('sha256')
    .update('intraday-market-move-monitor\0MACRO_YFINANCE_QUERY_FAILED\0macro:yfinance')
    .digest('hex').slice(0, 32)}`;
  const incident = await recordedIncident(t, { incidentId });
  const { rootDir } = incident;
  let delivery;
  assert.equal(await markMacroWarningRecovered({
    rootDir, observedAt: new Date('2026-09-30T01:40:00.000Z'),
    recordedAt: () => {
      delivery = deliverWarningBatch({
        jobName: 'intraday-market-move-monitor', sig: 'a'.repeat(40), message: 'test',
        stateFile: join(rootDir, 'delivery-state.json'), journalRoot: rootDir,
        structuredWarnings: [{ warningCode: 'MACRO_YFINANCE_QUERY_FAILED',
          subjectKey: 'macro:yfinance', kind: 'operational', severity: 'medium' }],
        clock: () => Date.parse('2026-09-30T01:40:05.000Z'),
        sendImpl: async () => ({ ok: true, result: { message_id: 42 } }),
      });
      return new Date('2026-09-30T01:40:05.000Z');
    },
  }), true);
  assert.equal((await delivery).status, 'sent');
  const events = readWarningEvents({ rootDir }).events;
  const resolvedIndex = events.findIndex((event) => event.incidentId === incidentId
    && event.eventType === 'status' && event.incidentStatus === 'resolved');
  const detectedIndex = events.findLastIndex((event) => event.warningCode === 'MACRO_YFINANCE_QUERY_FAILED'
    && event.eventType === 'detected');
  assert.ok(detectedIndex > resolvedIndex);
  assert.equal(rebuildWarningIncidents({ rootDir }).incidents.find((incident) => incident.incidentId === incidentId).status,
    'reopened');
});
