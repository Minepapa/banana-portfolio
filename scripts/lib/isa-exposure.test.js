import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeThreeAccountExposure, summarizeIsaHoldings, OVERLAP_CLASSES } from './isa-exposure.mjs';

test('OVERLAP_CLASSES: 설계서 명시 3종(배당주·리츠·채권)', () => {
  assert.deepEqual(OVERLAP_CLASSES, ['배당주', '리츠', '채권']);
});

test('computeThreeAccountExposure: IRP는 범위 밖', () => {
  const holdings = [
    { account: 'IRP', assetClass: '배당주', evalAmount: 10000000 },
    { account: '위탁', assetClass: '배당주', evalAmount: 100000 },
  ];
  const r = computeThreeAccountExposure(holdings);
  assert.equal(r.totalEval, 100000);
});

test('computeThreeAccountExposure: 분모는 3계좌 전체(현금성·달러 포함) — rebalance-gap과 다름(이중노출 공백 재현 방지)', () => {
  const holdings = [
    { account: '위탁', assetClass: '현금성', evalAmount: 500000 },
    { account: '위탁', assetClass: '배당주', evalAmount: 500000 },
  ];
  const r = computeThreeAccountExposure(holdings);
  assert.equal(r.totalEval, 1000000); // 현금성도 분모에 포함
  assert.equal(r.exposurePct.배당주, 50);
});

test('computeThreeAccountExposure: 위탁+연금저축만으로 계산할 때보다 ISA를 더하면 노출%가 커질 수 있음(설계 의도 그대로 재현)', () => {
  const withoutIsa = [
    { account: '위탁', assetClass: '배당주', evalAmount: 100000 },
    { account: '위탁', assetClass: '국내주식', evalAmount: 900000 },
  ];
  const withIsa = [...withoutIsa, { account: 'ISA', assetClass: '배당주', evalAmount: 500000 }];
  const rWithout = computeThreeAccountExposure(withoutIsa);
  const rWith = computeThreeAccountExposure(withIsa);
  assert.ok(rWith.exposurePct.배당주 > rWithout.exposurePct.배당주);
});

test('computeThreeAccountExposure: ISA·위탁·연금저축 3계좌 합산', () => {
  const holdings = [
    { account: 'ISA', assetClass: '배당주', evalAmount: 200000 },
    { account: '연금저축', assetClass: '배당주', evalAmount: 300000 },
    { account: '위탁', assetClass: '국내주식', evalAmount: 500000 },
  ];
  const r = computeThreeAccountExposure(holdings);
  assert.equal(r.totalEval, 1000000);
  assert.equal(r.exposurePct.배당주, 50);
});

test('computeThreeAccountExposure: byClassIsaEval은 ISA만의 기여액(단일 기준, 코드리뷰 지적으로 추가) — 위탁·연금저축 현금성 비중이 커도 흔들리지 않는 절대값', () => {
  const holdings = [
    { account: '위탁', assetClass: '현금성', evalAmount: 10000000 }, // 분모를 크게 흔드는 현금성
    { account: '위탁', assetClass: '배당주', evalAmount: 100000 },
    { account: 'ISA', assetClass: '배당주', evalAmount: 500000 },
  ];
  const r = computeThreeAccountExposure(holdings);
  assert.equal(r.byClassIsaEval.배당주, 500000); // 위탁 현금성 크기와 무관하게 항상 정확
  assert.equal(r.byClassEval.배당주, 600000);
});

test('summarizeIsaHoldings: ISA만 필터링, weightPct는 ISA 내부 기준', () => {
  const holdings = [
    { account: 'ISA', name: 'A', assetClass: '배당주', evalAmount: 300000, profitPct: 5 },
    { account: 'ISA', name: 'B', assetClass: '리츠', evalAmount: 700000, profitPct: -2 },
    { account: '위탁', name: 'C', assetClass: '국내주식', evalAmount: 1000000 },
  ];
  const r = summarizeIsaHoldings(holdings);
  assert.equal(r.totalEval, 1000000);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].weightPct, 30);
  assert.equal(r.items[1].weightPct, 70);
});

test('summarizeIsaHoldings: ISA 보유 없으면 빈 결과(0으로 나누기 없이 안전)', () => {
  const r = summarizeIsaHoldings([{ account: '위탁', name: 'X', evalAmount: 1000 }]);
  assert.equal(r.totalEval, 0);
  assert.deepEqual(r.items, []);
});
