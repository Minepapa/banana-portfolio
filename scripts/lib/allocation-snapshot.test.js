import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAccountAllocationSnapshot } from './allocation-snapshot.mjs';

test('computeAccountAllocationSnapshot: 위탁 계좌는 6개 목표자산군+달러(목표 0%) 7건 반환', () => {
  const holdings = [
    { account: '위탁', assetClass: '국내주식', evalAmount: 3000 },
    { account: '위탁', assetClass: '채권', evalAmount: 2000 },
    { account: '연금저축', assetClass: '국내주식', evalAmount: 9999 }, // 다른 계좌는 무시
  ];
  const rows = computeAccountAllocationSnapshot(holdings, '위탁');
  assert.equal(rows.length, 7);
  const stock = rows.find((r) => r.assetName === '국내주식');
  assert.equal(stock.targetPct, 30);
  assert.equal(stock.currentPct, 60); // 3000/(3000+2000)*100
  const usd = rows.find((r) => r.assetName === '달러');
  assert.equal(usd.targetPct, 0);
  assert.equal(usd.currentPct, 0);
});

test('computeAccountAllocationSnapshot: rebalAmt는 (목표%-현재%)*총평가액/100', () => {
  const holdings = [{ account: '위탁', assetClass: '금', evalAmount: 1000 }]; // 금만 보유, 목표 10%
  const rows = computeAccountAllocationSnapshot(holdings, '위탁');
  const gold = rows.find((r) => r.assetName === '금');
  assert.equal(gold.currentPct, 100);
  // 목표10 - 현재100 = -90 → -90/100*1000 = -900(줄여야 함)
  assert.equal(gold.rebalAmt, -900);
});

test('computeAccountAllocationSnapshot: 위탁 보유가 아예 없으면 전부 0%(추정 안 함)', () => {
  const rows = computeAccountAllocationSnapshot([], '위탁');
  assert.ok(rows.every((r) => r.currentPct === 0));
});

test('computeAccountAllocationSnapshot: ISA는 배당주 단일자산, 목표 100%', () => {
  const holdings = [
    { account: 'ISA', assetClass: '배당주', evalAmount: 900 },
    { account: 'ISA', assetClass: '현금', evalAmount: 100 },
  ];
  const rows = computeAccountAllocationSnapshot(holdings, 'ISA');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assetName, '배당주');
  assert.equal(rows[0].targetPct, 100);
  assert.equal(rows[0].currentPct, 90); // 900/1000*100 — 현금 섞였으면 정직하게 드리프트 반영
});

test('computeAccountAllocationSnapshot: IRP는 TDF 단일자산, 목표 100%', () => {
  const holdings = [{ account: 'IRP', assetClass: 'TDF', evalAmount: 500 }];
  const rows = computeAccountAllocationSnapshot(holdings, 'IRP');
  assert.equal(rows[0].assetName, 'TDF');
  assert.equal(rows[0].currentPct, 100);
});

test('computeAccountAllocationSnapshot: 알 수 없는 계좌는 빈 배열(추정 안 함)', () => {
  assert.deepEqual(computeAccountAllocationSnapshot([], 'CMA'), []);
  assert.deepEqual(computeAccountAllocationSnapshot([], '퀀트'), []);
});

test('computeAccountAllocationSnapshot: TARGET_ALLOCATION 밖 자산군(예: 현금)은 위탁 분모·목록에 안 들어감', () => {
  const holdings = [
    { account: '위탁', assetClass: '현금', evalAmount: 100000 },
    { account: '위탁', assetClass: '금', evalAmount: 1000 },
  ];
  const rows = computeAccountAllocationSnapshot(holdings, '위탁');
  assert.equal(rows.find((r) => r.assetName === '금').currentPct, 100); // 현금은 분모에 안 섞임
  assert.ok(!rows.some((r) => r.assetName === '현금'));
});
