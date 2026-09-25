import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GB_EXECUTION_API_CUTOVER_KST_DATE, gbReconcileStartDate, gbReconcileWindow, shouldRecordGbExecutionAtCutover } from './reconcile-nh-executions.mjs';

test('gbReconcileWindow: 컷오버 전에는 gbstock 대사를 아예 열지 않는다', () => {
  assert.equal(GB_EXECUTION_API_CUTOVER_KST_DATE, '2026-09-25');
  assert.equal(gbReconcileWindow('20260924'), null);
});

test('gbReconcileWindow: 컷오버 당일에는 조회 시작일을 컷오버 날짜로 고정한다', () => {
  assert.deepEqual(gbReconcileWindow('20260925'), { startDate: '20260925', endDate: '20260925' });
});

test('gbReconcileStartDate: 컷오버 후에는 7일 룩백과 컷오버 날짜 중 더 최근 날짜를 쓴다', () => {
  assert.equal(gbReconcileStartDate('20260926'), '20260925');
  assert.equal(gbReconcileStartDate('20261004'), '20260927');
});

test('shouldRecordGbExecutionAtCutover: API 조회일과 무관하게 장부 표시일이 컷오버 전이면 기록하지 않는다', () => {
  assert.equal(shouldRecordGbExecutionAtCutover({ tradeDate: '2026-09-24 00:00:00' }), false);
  assert.equal(shouldRecordGbExecutionAtCutover({ tradeDate: '2026-09-25 00:00:00' }), true);
});
