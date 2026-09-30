import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendWarningEvent } from './warning-event-journal.mjs';
import { queryWarningIncidents } from './warning-incident-query.mjs';
import { diagnoseWarningIncident } from './warning-runbook.mjs';
import { parseDiagnosisArgs } from '../tools/diagnose-warning-incident.mjs';

async function incident(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'macro-runbook-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  await appendWarningEvent({
    eventId: randomUUID(), occurredAt: '2026-09-30T01:00:00.000Z',
    incidentId: 'coded-macro-test', jobName: 'intraday-market-move-monitor',
    warningCode: 'MACRO_YFINANCE_QUERY_FAILED', subjectKey: 'macro:yfinance',
    kind: 'operational', severity: 'medium', eventType: 'detected',
  }, { rootDir });
  return queryWarningIncidents({ rootDir }).incidents[0];
}

test('등록된 미해결 운영 사건만 진단하고 레거시·시장신호·종결 사건은 거부한다', async (t) => {
  const target = await incident(t);
  const noProbe = () => { throw new Error('probe must not run'); };
  for (const candidate of [
    { ...target, warningCode: 'LEGACY_WARNING_BATCH' },
    { ...target, kind: 'market-signal' },
    { ...target, classification: 'legacy' },
    { ...target, status: 'resolved' },
  ]) {
    assert.throws(() => diagnoseWarningIncident(candidate, { probe: noProbe }), /허용/);
  }
  assert.throws(() => parseDiagnosisArgs([]), /필수/);
  assert.throws(() => parseDiagnosisArgs(['--shell=rm']), /알 수 없는/);
});

test('파일·Python·의존성 오류는 원문을 노출하지 않고 고정 근거로 분류한다', async (t) => {
  const target = await incident(t);
  const base = { scriptPath: '/isolated/yf-macro.py', fileExists: () => true };
  assert.equal(diagnoseWarningIncident(target, { ...base, fileExists: () => false }).outcome,
    'source-script-missing');
  assert.equal(diagnoseWarningIncident(target, { ...base,
    probe: () => ({ error: { code: 'ENOENT' } }),
  }).outcome, 'python-missing');
  const missing = diagnoseWarningIncident(target, { ...base,
    probe: () => ({ status: 1, stderr: "No module named 'yfinance' SECRET" }),
  });
  assert.equal(missing.outcome, 'dependency-missing');
  assert.doesNotMatch(JSON.stringify(missing), /SECRET/);
  assert.equal(diagnoseWarningIncident(target, { ...base,
    probe: () => ({ error: { code: 'ETIMEDOUT' } }),
  }).outcome, 'probe-timeout');
});

test('단일 GET은 고정 티커·시간제한으로만 실행하며 빈 응답을 성공으로 오인하지 않는다', async (t) => {
  const target = await incident(t);
  const calls = [];
  const base = { scriptPath: '/isolated/yf-macro.py', fileExists: () => true };
  const probe = (...args) => {
    calls.push(args);
    return { status: 0, stdout: JSON.stringify({ '^VIX': [] }) };
  };
  assert.equal(diagnoseWarningIncident(target, { ...base, probe }).outcome, 'data-empty');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['python3', ['/isolated/yf-macro.py', '^VIX']]);
  assert.equal(calls[0][2].timeout, 15_000);
  assert.equal(diagnoseWarningIncident(target, { ...base,
    probe: () => ({ status: 0, stdout: '{bad' }),
  }).outcome, 'response-invalid');
  const available = diagnoseWarningIncident(target, { ...base,
    probe: () => ({ status: 0, stdout: JSON.stringify({ '^VIX': [25.1] }) }),
  });
  assert.equal(available.outcome, 'source-available-now');
  assert.equal(available.confidence, 'low');
  assert.match(available.limitation, /신선도/);
  assert.equal(available.actionTaken, false);
});
