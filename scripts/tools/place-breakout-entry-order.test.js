import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWithinAfterHoursSubmitWindow, buildWatchArgs } from './place-breakout-entry-order.mjs';

// [MEDIUM 재발방지] 2026-09-19 코드리뷰 — order.orgNo → --org-no 플러밍이 지금까지
// 아무 테스트도 없어, place-breakout-fallback-entry.mjs 취소시도 기능이 조용히
// 영구 무력화돼도(예: KIS 응답에 KRX_FWDG_ORD_ORGNO가 없는 경우) 이 스위트가 계속
// 초록이었을 것 — 최소한 --org-no가 실제로 인자에 실리는지는 고정해둔다.
test('buildWatchArgs: --org-no에 order.orgNo가 실림', () => {
  const args = buildWatchArgs({
    order: { orderNo: '6693100', orgNo: '06010' }, code: '005930', name: '삼성전자',
    entryDate: '2026-09-19', budgetForFallback: 10_000_000,
  });
  assert.ok(args.includes('--org-no=06010'), args.join(' '));
  assert.ok(args.includes('--order-no=6693100'), args.join(' '));
  assert.ok(args.includes('--fallback=nextDayOpen'), args.join(' '));
  assert.ok(args.includes('--defer-protection-until=nextKrxPreMarket'), args.join(' '));
});

test('buildWatchArgs: order.orgNo가 빈 문자열(KIS 응답에 KRX_FWDG_ORD_ORGNO 없음)이면 --org-no=만 실림(빈 값 그대로 전달, 숨기지 않음)', () => {
  const args = buildWatchArgs({
    order: { orderNo: '6693100', orgNo: '' }, code: '005930', name: '삼성전자',
    entryDate: '2026-09-19', budgetForFallback: 10_000_000,
  });
  assert.ok(args.includes('--org-no='), args.join(' '));
});

// [MEDIUM 재발방지] 2026-09-19 코드리뷰 — ATR 가변손절(stopLossPct) 플러밍도
// --org-no와 똑같은 위험(조용히 무력화돼도 테스트가 안 잡음)에 노출돼 있었다.
test('buildWatchArgs: stopLossPct가 --stop-loss-pct로 실림', () => {
  const args = buildWatchArgs({
    order: { orderNo: '6693100', orgNo: '06010' }, code: '005930', name: '삼성전자',
    entryDate: '2026-09-19', budgetForFallback: 10_000_000, stopLossPct: 0.04,
  });
  assert.ok(args.includes('--stop-loss-pct=0.04'), args.join(' '));
});

test('buildWatchArgs: stopLossPct 생략 시 기본값(STOP_LOSS_PCT=0.08)으로 실림', () => {
  const args = buildWatchArgs({
    order: { orderNo: '6693100', orgNo: '06010' }, code: '005930', name: '삼성전자',
    entryDate: '2026-09-19', budgetForFallback: 10_000_000,
  });
  assert.ok(args.includes('--stop-loss-pct=0.08'), args.join(' '));
});

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
