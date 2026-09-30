import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeWarningAction } from './warning-action-plan.mjs';
import { formatWarningActionPlan } from '../tools/plan-warning-action.mjs';
import { runWarningActionSelfTest } from '../tools/self-test-warning-action.mjs';

function diagnosis(outcome, confidence = 'medium') {
  return {
    runbookId: 'macro-yfinance-readonly-v1', warningCode: 'MACRO_YFINANCE_QUERY_FAILED',
    outcome, confidence, evidence: ['fixed-safe-evidence'],
    readOnly: true, actionTaken: false,
    limitation: '단일 조회로 전체 신선도 확인 불가',
  };
}

test('일시적 읽기 실패만 고정 1회 재조회 조치안으로 만들며 이 단계에서 실행하지 않는다', () => {
  for (const outcome of ['probe-timeout', 'probe-failed', 'data-empty']) {
    const plan = proposeWarningAction(diagnosis(outcome));
    assert.equal(plan.actionId, 'MACRO_SINGLE_READ_RETRY');
    assert.equal(plan.maxAttempts, 1);
    assert.equal(plan.timeoutMs, 15_000);
    assert.equal(plan.cooldownMs, 30 * 60_000);
    assert.equal(plan.proposalOnly, true);
    assert.equal(plan.executed, false);
    assert.match(formatWarningActionPlan(plan), /실행 여부: 미실행/);
  }
});

test('의존성 누락·응답 계약 이상·현재 정상은 자동 조치를 제안하지 않는다', () => {
  for (const outcome of ['dependency-missing', 'source-script-missing', 'python-missing',
    'response-invalid', 'source-available-now']) {
    assert.equal(proposeWarningAction(diagnosis(outcome)).actionId, null);
  }
  assert.throws(() => proposeWarningAction({ ...diagnosis('data-empty'), readOnly: false }), /허용/);
  assert.throws(() => proposeWarningAction({ ...diagnosis('data-empty'), warningCode: 'OTHER' }), /허용/);
});

test('격리 자가테스트는 고정 파일·시간제한만 사용하며 성공/실패를 명확히 보고한다', () => {
  const calls = [];
  const passed = runWarningActionSelfTest({ exec: (...args) => { calls.push(args); } });
  assert.deepEqual(passed, { passed: true, checks: 4, realNetwork: false, actionTaken: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.equal(calls[0][1][0], '--test');
  assert.equal(calls[0][2].timeout, 30_000);
  assert.deepEqual(runWarningActionSelfTest({ exec: () => { throw new Error('failed'); } }),
    { passed: false, checks: 4, realNetwork: false, actionTaken: false });
});
