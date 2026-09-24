import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideMorningProtection, carryForwardProtectionOrders } from './breakout-morning-protection.mjs';
import { ensurePositionProtected } from './breakout-protection.mjs';

const base = {
  position: { code: '003490', status: '보유', quantity: 8, stopPrice: 28_000 },
  holding: { qty: 8 }, sellOrders: [], currentPrice: 30_500, stopPrice: 28_000, profitPrice: 38_000,
};

test('아침 보호조정: 잔고가 맞고 동일종목 미체결 매도가 없으면 누락 보호주문 등록', () => {
  assert.equal(decideMorningProtection(base).action, 'place');
});
test('아침 보호조정: 3R 부분익절 수량이 없는 포지션도 손절 주문은 설정 가능', () => {
  assert.equal(decideMorningProtection({ ...base, profitPrice: null }).action, 'place');
});
test('아침 보호조정: 같은 종목 미체결 매도가 보호주문으로 식별되지 않으면 추가 발주 금지', () => {
  const r = decideMorningProtection({ ...base, sellOrders: [{ code: '003490', side: '매도', cancelableQty: 4 }] });
  assert.equal(r.action, 'review');
  assert.match(r.reason, /미체결 매도주문/);
});
test('아침 보호조정: 기존 손절 다리가 정확히 일치하면 보존하고 누락 3R 다리만 허용', () => {
  const stop = { orderNo: '100', branchNo: '06010', code: '003490', side: '매도', orderTypeCode: '22', quantity: 8, filledQty: 0, cancelableQty: 8, conditionPrice: 28_000, orderPrice: 28_000 };
  const r = decideMorningProtection({ ...base, sellOrders: [stop] });
  assert.equal(r.action, 'place');
  assert.equal(r.existingStop, stop);
  assert.equal(r.existingProfit, null);
});
test('아침 보호조정: 기존 손절 번호를 이어받아 누락된 3R 다리만 실제 접수 시도', async () => {
  const stop = { orderNo: '100', branchNo: '06010', code: '003490', side: '매도', orderTypeCode: '22', quantity: 8, filledQty: 0, cancelableQty: 8, conditionPrice: 28_000, orderPrice: 28_000 };
  const decision = decideMorningProtection({ ...base, sellOrders: [stop] });
  const position = carryForwardProtectionOrders({ ...base.position, entryPrice: 30_500, stopLossPct: 0.08, stopPrice: 28_000, profitOrderApplicable: true }, decision);
  const calls = [];
  const result = await ensurePositionProtected(position, { placeOrder: async (params) => {
    calls.push(params);
    return { orderNo: '102', orgNo: '06010' };
  } });
  assert.equal(position.stopOrderNo, '100');
  assert.equal(position.stopOrderOrgNo, '06010');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].quantity, 4);
  assert.equal(result.stopOrderNo, '100');
  assert.equal(result.profitOrderNo, '102');
});
test('아침 보호조정: 기존 3R 다리를 정확히 식별하고 누락 손절 다리만 허용', () => {
  const profit = { orderNo: '101', branchNo: '06010', code: '003490', side: '매도', orderTypeCode: '22', quantity: 4, filledQty: 0, cancelableQty: 4, conditionPrice: 38_000, orderPrice: 38_000 };
  const r = decideMorningProtection({ ...base, sellOrders: [profit] });
  assert.equal(r.action, 'place');
  assert.equal(r.existingStop, null);
  assert.equal(r.existingProfit, profit);
});
test('아침 보호조정: 같은 보호다리가 중복이면 추측하지 않고 사람 확인', () => {
  const stop = { code: '003490', side: '매도', orderTypeCode: '22', quantity: 8, filledQty: 0, cancelableQty: 8, conditionPrice: 28_000, orderPrice: 28_000 };
  assert.equal(decideMorningProtection({ ...base, sellOrders: [stop, { ...stop, orderNo: 'duplicate' }] }).action, 'review');
});
test('아침 보호조정: 포지션과 실제 보유수량 불일치는 사람 확인', () => {
  assert.equal(decideMorningProtection({ ...base, holding: { qty: 6 } }).action, 'review');
});
test('아침 보호조정: 기록 손절가와 계산 손절가가 다르면 오래된 가격으로 주문하지 않음', () => {
  const r = decideMorningProtection({ ...base, position: { ...base.position, stopPrice: 27_900 } });
  assert.equal(r.action, 'review');
  assert.match(r.reason, /계산 손절가 불일치/);
});
test('아침 보호조정: API 잔고 미조회는 0주로 추정하지 않고 중단', () => {
  assert.equal(decideMorningProtection({ ...base, holding: null }).action, 'review');
});
test('아침 보호조정: 현재가가 손절 또는 3R을 넘었으면 뒤늦은 스톱 발주 금지', () => {
  assert.equal(decideMorningProtection({ ...base, currentPrice: 27_900 }).action, 'review');
  assert.equal(decideMorningProtection({ ...base, currentPrice: 38_100 }).action, 'review');
});
test('아침 보호조정: 청산 포지션은 재등록하지 않음', () => {
  assert.equal(decideMorningProtection({ ...base, position: { ...base.position, status: '청산' } }).action, 'skip');
});

test('아침 보호조정: 기존 손절·3R이 모두 활성인 protected 포지션은 재접수하지 않음', async () => {
  const stop = { orderNo: '100', branchNo: '06010', code: '003490', side: '매도', orderTypeCode: '22', quantity: 8, filledQty: 0, cancelableQty: 8, conditionPrice: 28_000, orderPrice: 28_000 };
  const profit = { orderNo: '101', branchNo: '06010', code: '003490', side: '매도', orderTypeCode: '22', quantity: 4, filledQty: 0, cancelableQty: 4, conditionPrice: 38_000, orderPrice: 38_000 };
  const decision = decideMorningProtection({ ...base, sellOrders: [stop, profit] });
  assert.equal(decision.action, 'place');
  const position = carryForwardProtectionOrders({ ...base.position, profitOrderApplicable: true }, decision);
  const calls = [];
  const result = await ensurePositionProtected(position, { placeOrder: async (params) => { calls.push(params); } });
  assert.equal(calls.length, 0);
  assert.equal(result.protectionStatus, 'protected');
  assert.equal(result.stopOrderNo, '100');
  assert.equal(result.profitOrderNo, '101');
});

test('아침 보호조정: 손절만 활성인 protected 포지션은 누락 3R 다리만 복구', async () => {
  const stop = { orderNo: '100', branchNo: '06010', code: '003490', side: '매도', orderTypeCode: '22', quantity: 8, filledQty: 0, cancelableQty: 8, conditionPrice: 28_000, orderPrice: 28_000 };
  const decision = decideMorningProtection({ ...base, sellOrders: [stop] });
  const position = carryForwardProtectionOrders({ ...base.position, entryPrice: 30_500, stopLossPct: 0.08, profitOrderApplicable: true }, decision);
  const calls = [];
  await ensurePositionProtected(position, { placeOrder: async (params) => { calls.push(params); return { orderNo: '102', orgNo: '06010' }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].quantity, 4);
});
