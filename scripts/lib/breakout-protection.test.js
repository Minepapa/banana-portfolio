import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInitialStopOrder, ensureStopOrder } from './breakout-protection.mjs';

test('computeInitialStopOrder: 손절만 전량·호가단위로 계산한다', () => {
  assert.deepEqual(computeInitialStopOrder(87400, 1), { quantity: 1, price: 80400, conditionPrice: 80400 });
});

test('ensureStopOrder: 성공한 손절 주문번호를 보존한다', async () => {
  const result = await ensureStopOrder({ entryPrice: 10000, quantity: 10, stopPrice: 9200 }, {
    placeOrder: async () => ({ orderNo: 's1', orgNo: 'org' }),
  });
  assert.equal(result.protectionStatus, 'protected');
  assert.equal(result.stopOrderNo, 's1');
});

test('ensureStopOrder: confirmedNotSent만 재시도하고 불명 응답은 중단한다', async () => {
  let calls = 0;
  const result = await ensureStopOrder({ entryPrice: 10000, quantity: 10, stopPrice: 9200 }, {
    maxAttempts: 3, sleep: async () => {},
    placeOrder: async () => { calls += 1; if (calls === 1) { const e = new Error('거부'); e.confirmedNotSent = true; throw e; } throw new Error('응답불명'); },
  });
  assert.equal(calls, 2);
  assert.equal(result.stopAmbiguous, true);
  assert.equal(result.protectionStatus, 'failed');
});
