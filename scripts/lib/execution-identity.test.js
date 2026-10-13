import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEquivalentExecution, findEquivalentExecutions } from './execution-identity.mjs';

const execution = (overrides = {}) => ({
  type: 'execution', tradeDate: '2026-08-06 09:28:37', tradeType: '매수',
  stockCode: '329200', stockName: 'TIGER 리츠', quantity: 10, price: 4037,
  currency: 'KRW', account: 'ISA', orderNo: '', ...overrides,
});

test('경로가 달라도 같은 날짜·체결 값이면 시각 미상과 legacy 시각 표기를 허용한다', () => {
  const candidate = execution({ tradeDate: '2026-08-06 00:00:00', orderNo: '847026' });
  const existing = execution({ tradeDate: '2026-08-06 9_28_37', currency: undefined, filename: 'legacy.md' });
  assert.equal(findEquivalentExecution(candidate, [existing]), existing);
  assert.equal(findEquivalentExecution(execution(), [existing]), existing);
  assert.equal(findEquivalentExecution(execution(), [execution({ tradeDate: '2026-08-06 9:28:37' })])?.tradeType, '매수');
});

test('가격·수량·계좌·주문번호·통화·실제 시각이 다르면 별개 체결이다', () => {
  const candidate = execution({ orderNo: '847026' });
  for (const changes of [
    { price: 4038 }, { quantity: 11 }, { account: '위탁' }, { orderNo: '847027' },
    { currency: 'USD' }, { tradeDate: '2026-08-06 09:28:38' }, { tradeDate: '2026-08-07 09:28:37' },
  ]) assert.equal(findEquivalentExecution(candidate, [execution(changes)]), null);
});

test('두 개 이상 후보가 일치하면 어느 하나도 선택하지 않는다', () => {
  const existing = [execution({ filename: 'first.md' }), execution({ filename: 'second.md' })];
  assert.equal(findEquivalentExecutions(execution(), existing).length, 2);
  assert.equal(findEquivalentExecution(execution(), existing), null);
});
