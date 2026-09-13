import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWithinAfterHoursSubmitWindow } from './place-breakout-entry-order.mjs';

// [핵심 안전장치] 코드리뷰 MEDIUM 지적(2026-09-13) 재발방지 — ORD_DVSN=06(장후시간외)는
// 15:40~16:00 KRX에만 유효, 그 밖에서 호출되면 KIS에 던지기 전에 여기서 막아야 한다.
test('isWithinAfterHoursSubmitWindow: KST 15:37(신호스캔이 실제로 호출하는 시각대)는 true', () => {
  assert.equal(isWithinAfterHoursSubmitWindow(new Date('2026-09-14T06:37:00Z')), true); // UTC 06:37 = KST 15:37
});

test('isWithinAfterHoursSubmitWindow: KST 15:59는 true(경계 안쪽)', () => {
  assert.equal(isWithinAfterHoursSubmitWindow(new Date('2026-09-14T06:59:00Z')), true);
});

test('isWithinAfterHoursSubmitWindow: KST 16:00 정각은 false(경계 바깥, 16:00부터 시간외단일가로 전환)', () => {
  assert.equal(isWithinAfterHoursSubmitWindow(new Date('2026-09-14T07:00:00Z')), false);
});

test('isWithinAfterHoursSubmitWindow: KST 오전(예: 10:00)은 false', () => {
  assert.equal(isWithinAfterHoursSubmitWindow(new Date('2026-09-14T01:00:00Z')), false);
});

test('isWithinAfterHoursSubmitWindow: KST 14:59는 false(15:00 직전)', () => {
  assert.equal(isWithinAfterHoursSubmitWindow(new Date('2026-09-14T05:59:00Z')), false);
});
