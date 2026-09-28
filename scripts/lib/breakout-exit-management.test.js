import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideExitManagement, executeExitManagement, decidePositionClosure, decidePendingPartialExitConfirmation,
} from './breakout-exit-management.mjs';

// orderNo는 실제 KIS 값처럼 숫자 문자열로 둔다 — findMatchingStopOrder가
// Number() 정규화 비교를 쓰므로(0패딩 차이 방어, 2026-09-29 2차 코드리뷰 MEDIUM
// 지적) 비숫자 플레이스홀더('s1' 등)를 쓰면 Number(NaN)===Number(NaN)이 항상
// false가 돼 매칭 자체가 깨진다.
const position = {
  code: '000001', entryPrice: 10000, quantity: 10, highSinceEntry: 10000, stopPrice: 9200,
  stopLossPct: 0.08, partialSold: false, profitOrderApplicable: true, stopOrderNo: '1001', stopOrderOrgNo: 'org',
};
const stop = {
  code: '000001', side: '매도', orderNo: '1001', branchNo: 'org', orderTypeCode: '22', quantity: 10,
  filledQty: 0, cancelableQty: 10, conditionPrice: 9200, orderPrice: 9200,
};
const holding = { code: '000001', qty: 10 };

test('판정: 잔고·손절 주문 불일치는 review(urgent)', () => {
  const a = decideExitManagement({ position, holding: { qty: 9 }, sellOrders: [stop], latestHigh: 10000, latestClose: 10000 });
  assert.equal(a.action, 'review'); assert.equal(a.urgent, true);
  const b = decideExitManagement({ position, holding, sellOrders: [{ ...stop, conditionPrice: 9100 }], latestHigh: 10000, latestClose: 10000 });
  assert.equal(b.action, 'review'); assert.equal(b.urgent, true);
});
test('판정: 최신 상태면 none, R 단계 상승이면 revise', () => {
  assert.equal(decideExitManagement({ position, holding, sellOrders: [stop], latestHigh: 10799, latestClose: 10500 }).action, 'none');
  const d = decideExitManagement({ position, holding, sellOrders: [stop], latestHigh: 10800, latestClose: 10500 });
  assert.equal(d.action, 'revise'); assert.equal(d.newStopPrice, 10000);
});
test('판정: 3R 정확 도달은(기존 손절주문 있음) partialExit, 미도달은 revise/none', () => {
  assert.equal(decideExitManagement({ position, holding, sellOrders: [stop], latestHigh: 12399, latestClose: 12000 }).action, 'revise');
  const d = decideExitManagement({ position, holding, sellOrders: [stop], latestHigh: 12400, latestClose: 12000 });
  assert.equal(d.action, 'partialExit'); assert.equal(d.soldQty, 5); assert.equal(d.remainingQty, 5); assert.equal(d.newStopPrice, 11600);
});
test('판정: 이미 부분익절했거나 비대상 1주는 partialExit를 다시 내지 않는다', () => {
  assert.equal(decideExitManagement({
    position: { ...position, partialSold: true, quantity: 5 }, holding: { qty: 5 },
    sellOrders: [{ ...stop, quantity: 5, cancelableQty: 5 }], latestHigh: 12400, latestClose: 12000,
  }).action, 'revise');
  assert.notEqual(decideExitManagement({
    position: { ...position, quantity: 1, profitOrderApplicable: false }, holding: { qty: 1 },
    sellOrders: [{ ...stop, quantity: 1, cancelableQty: 1 }], latestHigh: 12400, latestClose: 12000,
  }).action, 'partialExit');
});
test('실행: partialExit는 취소-매도-새 손절 순서로 한 번씩 실행하고 매도 주문번호를 함께 돌려준다', async () => {
  const calls = []; const result = await executeExitManagement({ action: 'partialExit', position, stopOrder: stop, soldQty: 5, remainingQty: 5, newStopPrice: 11600 }, {
    reviseOrder: async (p) => { calls.push(['revise', p.action]); return { orderNo: p.action === '취소' ? 'c1' : 'x' }; },
    placeOrder: async (p) => { calls.push(['place', p.marketOrder]); return { orderNo: calls.length === 2 ? 'm1' : 's2', orgNo: 'org2' }; },
  });
  assert.deepEqual(calls, [['revise', '취소'], ['place', true], ['place', undefined]]);
  assert.equal(result.status, 'completed'); assert.equal(result.stopOrderNo, 's2');
  assert.equal(result.partialExitOrderNo, 'm1'); assert.equal(result.soldQty, 5); assert.equal(result.remainingQty, 5);
});
test('실행: 취소·매도 불명은 다음 단계로 진행하지 않는다', async () => {
  const cancelUnknown = await executeExitManagement({ action: 'partialExit', position, stopOrder: stop, soldQty: 5, remainingQty: 5, newStopPrice: 11600 }, { reviseOrder: async () => { throw new Error('network'); }, placeOrder: async () => { throw new Error('no'); } });
  assert.equal(cancelUnknown.status, 'review'); assert.equal(cancelUnknown.stage, 'cancel');
  const saleUnknown = await executeExitManagement({ action: 'partialExit', position, stopOrder: stop, soldQty: 5, remainingQty: 5, newStopPrice: 11600 }, { reviseOrder: async () => ({ orderNo: 'c' }), placeOrder: async () => { throw new Error('network'); } });
  assert.equal(saleUnknown.status, 'urgentReview'); assert.equal(saleUnknown.stage, 'marketSell');
  assert.equal(saleUnknown.partialExitOrderNo, undefined);
});
test('실행: 잔여 손절 실패는 매도를 반복하지 않고 긴급 경고하되 매도 주문번호는 보존한다', async () => {
  let calls = 0; const r = await executeExitManagement({ action: 'partialExit', position, stopOrder: stop, soldQty: 5, remainingQty: 5, newStopPrice: 11600 }, { reviseOrder: async () => ({ orderNo: 'c' }), placeOrder: async () => { calls += 1; if (calls === 1) return { orderNo: 'm' }; const e = new Error('reject'); e.confirmedNotSent = true; throw e; } });
  assert.equal(r.status, 'urgentReview'); assert.equal(r.stage, 'newStop'); assert.equal(calls, 2);
  assert.equal(r.partialExitOrderNo, 'm');
});
test('종료 감지: 전량 체결 확인만 close, 조회 불명은 review', () => {
  assert.equal(decidePositionClosure({ position, holding: null, fill: { fullyFilled: true, filledQty: 10, avgFillPrice: 9200 } }).action, 'close');
  assert.equal(decidePositionClosure({ position, holding: null, fill: null }).action, 'review');
});

test('판정: 이 종목 매도주문이 전혀 없고(당일유효 소멸) 3R 미도달이면 placeStop', () => {
  const d = decideExitManagement({ position, holding, sellOrders: [], latestHigh: 10000, latestClose: 10000 });
  assert.equal(d.action, 'placeStop');
  assert.equal(d.newStopPrice, 9200);
});
test('판정: placeStop은 트레일링 진행 상황도 반영한다', () => {
  const d = decideExitManagement({ position, holding, sellOrders: [], latestHigh: 10800, latestClose: 10500 });
  assert.equal(d.action, 'placeStop');
  assert.equal(d.newStopPrice, 10000);
});
test('판정: 매도주문이 전혀 없는데 3R도 동시에 처음 도달했으면(취소할 것 없음) placeStopAndPartialExit', () => {
  const d = decideExitManagement({ position, holding, sellOrders: [], latestHigh: 12400, latestClose: 12000 });
  assert.equal(d.action, 'placeStopAndPartialExit');
  assert.equal(d.soldQty, 5); assert.equal(d.remainingQty, 5); assert.equal(d.newStopPrice, 11600);
});
test('판정: 이 종목에 예상 밖 매도주문만 있으면 placeStop이 아니라 review(urgent)', () => {
  const d = decideExitManagement({ position, holding, sellOrders: [{ ...stop, orderNo: 'other' }], latestHigh: 10000, latestClose: 10000 });
  assert.equal(d.action, 'review'); assert.equal(d.urgent, true);
});
test('판정: 새 손절선이 이미 최신 종가를 통과했으면(갭하락) 주문 대신 긴급 review', () => {
  const d = decideExitManagement({ position, holding, sellOrders: [], latestHigh: 10000, latestClose: 9000 });
  assert.equal(d.action, 'review'); assert.equal(d.urgent, true);
  assert.match(d.reason, /갭하락/);
});
test('실행: placeStop 성공 시 새 손절주문번호를 반환', async () => {
  const decision = { action: 'placeStop', position, highSinceEntry: 10000, newStopPrice: 9200 };
  const result = await executeExitManagement(decision, {
    reviseOrder: async () => { throw new Error('호출되면 안 됨'); },
    placeOrder: async (p) => { assert.equal(p.quantity, 10); assert.equal(p.price, 9200); return { orderNo: 'new1', orgNo: 'org3' }; },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.stopOrderNo, 'new1');
});
test('실행: placeStop 실패는 무보호 상태이므로 urgentReview', async () => {
  const decision = { action: 'placeStop', position, highSinceEntry: 10000, newStopPrice: 9200 };
  const result = await executeExitManagement(decision, {
    reviseOrder: async () => { throw new Error('호출되면 안 됨'); },
    placeOrder: async () => { throw new Error('주문가능금액 부족'); },
  });
  assert.equal(result.status, 'urgentReview');
  assert.equal(result.stage, 'placeStop');
});
test('실행: placeStopAndPartialExit는 취소 없이 매도→새손절 2단계만 실행한다', async () => {
  const calls = [];
  const decision = { action: 'placeStopAndPartialExit', position, highSinceEntry: 12400, soldQty: 5, remainingQty: 5, newStopPrice: 11600 };
  const result = await executeExitManagement(decision, {
    reviseOrder: async () => { throw new Error('취소 단계가 있으면 안 됨'); },
    placeOrder: async (p) => { calls.push(p.marketOrder === true ? 'sell' : 'stop'); return { orderNo: p.marketOrder === true ? 'm1' : 'new1', orgNo: 'org4' }; },
  });
  assert.deepEqual(calls, ['sell', 'stop']);
  assert.equal(result.status, 'completed');
  assert.equal(result.stopOrderNo, 'new1'); assert.equal(result.partialExitOrderNo, 'm1');
  assert.equal(result.soldQty, 5); assert.equal(result.remainingQty, 5);
});
test('실행: placeStopAndPartialExit에서 매도는 확정됐는데 새손절이 실패하면 매도 주문번호를 보존한 채 urgentReview', async () => {
  const decision = { action: 'placeStopAndPartialExit', position, highSinceEntry: 12400, soldQty: 5, remainingQty: 5, newStopPrice: 11600 };
  const result = await executeExitManagement(decision, {
    reviseOrder: async () => { throw new Error('취소 단계가 있으면 안 됨'); },
    placeOrder: async (p) => {
      if (p.marketOrder === true) return { orderNo: 'm1', orgNo: 'org4' };
      throw new Error('호가단위 오류');
    },
  });
  assert.equal(result.status, 'urgentReview'); assert.equal(result.stage, 'newStop');
  assert.equal(result.partialExitOrderNo, 'm1'); assert.equal(result.soldQty, 5); assert.equal(result.remainingQty, 5);
});
test('실행: placeStopAndPartialExit에서 매도 자체가 애매하면 새손절을 시도하지 않는다', async () => {
  let stopCalls = 0;
  const decision = { action: 'placeStopAndPartialExit', position, highSinceEntry: 12400, soldQty: 5, remainingQty: 5, newStopPrice: 11600 };
  const result = await executeExitManagement(decision, {
    reviseOrder: async () => { throw new Error('취소 단계가 있으면 안 됨'); },
    placeOrder: async (p) => { if (p.marketOrder === true) throw new Error('network'); stopCalls += 1; return { orderNo: 'new1' }; },
  });
  assert.equal(result.status, 'urgentReview'); assert.equal(result.stage, 'marketSell');
  assert.equal(result.partialExitOrderNo, undefined); assert.equal(stopCalls, 0);
});

test('부분익절 체결확인: 체결 완전 확인만 confirm, 아니면 review로 다음 실행에 재확인', () => {
  const pending = { ...position, partialExitPendingOrderNo: 'm1', partialExitPendingQty: 5 };
  assert.equal(decidePendingPartialExitConfirmation({
    position: pending, fill: { fullyFilled: true, filledQty: 5, avgFillPrice: 12100 },
  }).action, 'confirm');
  assert.equal(decidePendingPartialExitConfirmation({ position: pending, fill: null }).action, 'review');
  assert.equal(decidePendingPartialExitConfirmation({ position: { ...position }, fill: null }).action, 'none');
});
test('부분익절 체결확인: 취소/미체결로 종결되면 abandon(원장 없이 원복 대상)', () => {
  const pending = { ...position, partialExitPendingOrderNo: 'm1', partialExitPendingQty: 5 };
  const d = decidePendingPartialExitConfirmation({ position: pending, fill: { canceled: true, filledQty: 0 } });
  assert.equal(d.action, 'abandon');
});
test('부분익절 체결확인: 일부만 체결되고 남은 주문이 종결됐으면(취소·remainingQty=0) partialFill', () => {
  const pending = { ...position, partialExitPendingOrderNo: 'm1', partialExitPendingQty: 5 };
  const d = decidePendingPartialExitConfirmation({
    position: pending, fill: { fullyFilled: false, filledQty: 3, remainingQty: 0, avgFillPrice: 12050, canceled: false },
  });
  assert.equal(d.action, 'partialFill');
  assert.equal(d.fill.filledQty, 3);
});
test('부분익절 체결확인: 일부만 체결됐지만 주문이 아직 살아있으면(remainingQty>0, 미취소) review — 나중 체결을 기다린다', () => {
  const pending = { ...position, partialExitPendingOrderNo: 'm1', partialExitPendingQty: 5 };
  const d = decidePendingPartialExitConfirmation({
    position: pending, fill: { fullyFilled: false, filledQty: 3, remainingQty: 2, avgFillPrice: 12050, canceled: false },
  });
  assert.equal(d.action, 'review');
});
