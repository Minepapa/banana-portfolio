import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAP_FRACTION, applyCappedAllocation, resolveAllocationPricing, resolveAllocationPricingByName } from './allocation-proposal-shared.mjs';

test('applyCappedAllocation: 캡 상수는 0.5', () => {
  assert.equal(CAP_FRACTION, 0.5);
});

test('applyCappedAllocation: 도메인검증 실패 항목은 드롭되고 원본이 a로 보존', () => {
  const items = [{ x: 1 }];
  const { kept, dropped } = applyCappedAllocation(items, {
    capBudget: {},
    validateItem: () => ({ ok: false, reason: '테스트 사유' }),
  });
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].a, items[0]);
  assert.equal(dropped[0].reason, '테스트 사유');
});

test('applyCappedAllocation: 캡 초과분은 드롭이 아니라 캡까지 축소', () => {
  const capBudget = { A: 100 };
  const items = [{ amt: 150 }];
  const { kept, dropped } = applyCappedAllocation(items, {
    capBudget,
    validateItem: (raw) => ({ ok: true, key: 'A', amountWon: raw.amt, normalized: { tag: 'x' } }),
  });
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].amountWon, 100);
  assert.equal(kept[0].tag, 'x');
});

test('applyCappedAllocation: 순수함수 — 호출부가 넘긴 capBudget 객체는 mutate하지 않음', () => {
  const capBudget = { A: 100 };
  applyCappedAllocation([{ amt: 60 }], {
    capBudget,
    validateItem: (raw) => ({ ok: true, key: 'A', amountWon: raw.amt, normalized: {} }),
  });
  assert.equal(capBudget.A, 100); // 호출 후에도 원본은 그대로
});

test('applyCappedAllocation: 캡 이미 소진된 key는 드롭', () => {
  const capBudget = { A: 0 };
  const items = [{ amt: 10 }];
  const { kept, dropped } = applyCappedAllocation(items, {
    capBudget,
    validateItem: (raw) => ({ ok: true, key: 'A', amountWon: raw.amt, normalized: {} }),
  });
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /분할매수 캡 이미 소진/);
});

test('applyCappedAllocation: capLabel을 넘기면 드롭 사유에 그 라벨이 포함(내부 버킷명 대신 사람이 읽는 설명)', () => {
  const capBudget = { A: 0 };
  const { dropped } = applyCappedAllocation([{ amt: 10 }], {
    capBudget, capLabel: '가용잔고의 50%',
    validateItem: (raw) => ({ ok: true, key: 'A', amountWon: raw.amt, normalized: {} }),
  });
  assert.match(dropped[0].reason, /분할매수 캡\(가용잔고의 50%\) 이미 소진/);
});

test('applyCappedAllocation: capBudget에 없는 key가 오면 "미정의 키" 사유로 드롭(호출부 버그와 구분)', () => {
  const { kept, dropped } = applyCappedAllocation([{ amt: 10 }], {
    capBudget: { A: 100 },
    validateItem: (raw) => ({ ok: true, key: 'B', amountWon: raw.amt, normalized: {} }),
  });
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /미정의 키/);
});

test('applyCappedAllocation: 예산이 NaN이면 무제한 통과가 아니라 0으로 취급(하드 캡 무력화 방지)', () => {
  const { kept, dropped } = applyCappedAllocation([{ amt: 999999 }], {
    capBudget: { A: NaN },
    validateItem: (raw) => ({ ok: true, key: 'A', amountWon: raw.amt, normalized: {} }),
  });
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /이미 소진/);
});

test('applyCappedAllocation: 여러 항목이 같은 key 예산을 순서대로 소진', () => {
  const capBudget = { A: 100 };
  const items = [{ amt: 60 }, { amt: 60 }];
  const { kept, dropped } = applyCappedAllocation(items, {
    capBudget,
    validateItem: (raw) => ({ ok: true, key: 'A', amountWon: raw.amt, normalized: {} }),
  });
  assert.equal(kept.length, 2);
  assert.equal(kept[0].amountWon, 60);
  assert.equal(kept[1].amountWon, 40); // 첫 항목이 60 소진, 남은 40까지만 축소
  assert.equal(dropped.length, 0);
});

test('resolveAllocationPricing: 일치하는 실보유 있으면 quantity·proposedPrice 산출', () => {
  const holdings = [{ account: '위탁', assetClass: '주식', name: 'KODEX 200', ticker: '069500', curPrice: 40000 }];
  const r = resolveAllocationPricing(holdings, { account: '위탁', assetClass: '주식', instrumentName: 'KODEX 200', amountWon: 100000 });
  assert.equal(r.ticker, '069500');
  assert.equal(r.quantity, 2);
  assert.equal(r.proposedPrice, 40000);
});

test('resolveAllocationPricing: account 정규화(금현물→위탁 등) 후 비교', () => {
  const holdings = [{ account: '금현물', assetClass: '금', name: '금ETF', ticker: '', curPrice: 1000 }];
  const r = resolveAllocationPricing(holdings, { account: '위탁', assetClass: '금', instrumentName: '금ETF', amountWon: 5000 });
  assert.equal(r.quantity, 5);
});

test('resolveAllocationPricing: 실보유 없으면 quantity/proposedPrice null', () => {
  const r = resolveAllocationPricing([], { account: '위탁', assetClass: '주식', instrumentName: '신규종목', amountWon: 100000 });
  assert.equal(r.quantity, null);
  assert.equal(r.proposedPrice, null);
  assert.equal(r.assetKey, '신규종목');
});

test('resolveAllocationPricing: curPrice가 0 이하면 무효 취급', () => {
  const holdings = [{ account: '위탁', assetClass: '주식', name: 'X', ticker: 'T1', curPrice: 0 }];
  const r = resolveAllocationPricing(holdings, { account: '위탁', assetClass: '주식', instrumentName: 'X', amountWon: 1000 });
  assert.equal(r.quantity, null);
  assert.equal(r.proposedPrice, null);
});

test('resolveAllocationPricing: 수량이 0이 되면 null로 취급', () => {
  const holdings = [{ account: '위탁', assetClass: '주식', name: 'X', ticker: 'T1', curPrice: 100000 }];
  const r = resolveAllocationPricing(holdings, { account: '위탁', assetClass: '주식', instrumentName: 'X', amountWon: 50000 });
  assert.equal(r.quantity, null);
  assert.equal(r.proposedPrice, 100000);
});

test('resolveAllocationPricing: assetClass가 다르면(계좌·이름 같아도) 매칭 안 됨', () => {
  const holdings = [{ account: '위탁', assetClass: '금', name: 'X', ticker: 'T1', curPrice: 1000 }];
  const r = resolveAllocationPricing(holdings, { account: '위탁', assetClass: '주식', instrumentName: 'X', amountWon: 1000 });
  assert.equal(r.quantity, null);
});

test('resolveAllocationPricingByName: 이름만 일치하면 계좌·자산군 달라도 매칭(호출부가 이미 걸러 넘긴 후보 전제)', () => {
  const candidates = [{ account: '연금저축', assetClass: '금', name: 'TIGER 200', ticker: '102110', curPrice: 40000 }];
  const r = resolveAllocationPricingByName(candidates, { instrumentName: 'TIGER 200', amountWon: 100000 });
  assert.equal(r.ticker, '102110');
  assert.equal(r.quantity, 2);
});

test('resolveAllocationPricingByName: 후보에 없는 이름(신규 제안)은 quantity·price null', () => {
  const r = resolveAllocationPricingByName([], { instrumentName: '신규ETF', amountWon: 100000 });
  assert.equal(r.quantity, null);
  assert.equal(r.assetKey, '신규ETF');
});
