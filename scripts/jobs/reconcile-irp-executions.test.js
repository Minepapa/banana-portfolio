import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTradeDate } from './reconcile-irp-executions.mjs';

test('buildTradeDate: 6자리 HHMMSS를 콜론 포함 시각으로 조합', () => {
  assert.equal(buildTradeDate('2026-09-02', '093015'), '2026-09-02 09:30:15');
});

// [핵심 안전장치] orderTime이 예상 밖 형식(빈 문자열·6자리 아님·비숫자)이면 추정하지
// 않고 자정(00:00:00)으로 명시적 폴백 — buildExecutionRecord의 dedup 파일명 생성
// 자체는 막지 않되, "시각을 모른다"는 걸 항상 같은 값(00:00:00)으로 드러낸다.
test('[핵심 안전장치] buildTradeDate: orderTime이 6자리가 아니거나 없으면 00:00:00으로 폴백(추정 안 함)', () => {
  assert.equal(buildTradeDate('2026-09-02', ''), '2026-09-02 00:00:00');
  assert.equal(buildTradeDate('2026-09-02', undefined), '2026-09-02 00:00:00');
  assert.equal(buildTradeDate('2026-09-02', '9301'), '2026-09-02 00:00:00');
  assert.equal(buildTradeDate('2026-09-02', 'abcdef'), '2026-09-02 00:00:00');
});
