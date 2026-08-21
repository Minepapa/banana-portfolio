import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankEligibleGaps, findExistingInstruments, ACCOUNT_ELIGIBLE_ASSET_CLASSES } from './cash-allocation-candidates.mjs';

const GAPS = [
  { assetClass: '채권', targetPct: 20, currentPct: 15, absDeltaPct: -5 },
  { assetClass: '금', targetPct: 10, currentPct: 12, absDeltaPct: 2 },
  { assetClass: '배당주', targetPct: 5, currentPct: 2, absDeltaPct: -3 },
  { assetClass: '리츠', targetPct: 5, currentPct: 5, absDeltaPct: 0 },
  { assetClass: '국내주식', targetPct: 30, currentPct: 20, absDeltaPct: -10 },
  { assetClass: '해외주식', targetPct: 30, currentPct: 35, absDeltaPct: 5 },
];

test('rankEligibleGaps: 위탁은 배당주·리츠 후보에서 제외(세금상 담을 수 없음)', () => {
  const ranked = rankEligibleGaps(GAPS, '위탁');
  assert.ok(!ranked.some((g) => g.assetClass === '배당주'));
  assert.ok(!ranked.some((g) => g.assetClass === '리츠'));
});

test('rankEligibleGaps: 위탁 후보 중 언더웨이트만 남고 가장 부족한 순 정렬', () => {
  const ranked = rankEligibleGaps(GAPS, '위탁');
  assert.deepEqual(ranked.map((g) => g.assetClass), ['국내주식', '채권']);
});

test('rankEligibleGaps: 연금저축은 국내주식·금이 후보에서 제외', () => {
  const ranked = rankEligibleGaps(GAPS, '연금저축');
  assert.ok(!ranked.some((g) => g.assetClass === '국내주식'));
  assert.ok(!ranked.some((g) => g.assetClass === '금'));
  assert.deepEqual(ranked.map((g) => g.assetClass), ['채권', '배당주']);
});

test('rankEligibleGaps: 오버웨이트(양수 갭)인 자산군은 후보에서 제외', () => {
  const ranked = rankEligibleGaps(GAPS, '위탁');
  assert.ok(!ranked.some((g) => g.assetClass === '금')); // 위탁 후보이지만 absDeltaPct=2(오버웨이트)
});

test('rankEligibleGaps: 알 수 없는 계좌는 빈 배열(ISA·IRP·퀀트 등 범위 밖)', () => {
  assert.deepEqual(rankEligibleGaps(GAPS, 'ISA'), []);
});

test('ACCOUNT_ELIGIBLE_ASSET_CLASSES: 위탁·연금저축 두 계좌만 정의됨', () => {
  assert.deepEqual(Object.keys(ACCOUNT_ELIGIBLE_ASSET_CLASSES).sort(), ['연금저축', '위탁'].sort());
});

test('findExistingInstruments: 해당 계좌·자산군의 보유만 필터', () => {
  const holdings = [
    { account: '위탁', assetClass: '국내주식', name: 'A' },
    { account: '위탁', assetClass: '해외주식', name: 'B' },
    { account: '연금저축', assetClass: '국내주식', name: 'C' },
  ];
  const found = findExistingInstruments(holdings, '위탁', '국내주식');
  assert.deepEqual(found.map((h) => h.name), ['A']);
});

test('findExistingInstruments: 일치하는 보유 없으면 빈 배열', () => {
  assert.deepEqual(findExistingInstruments([], '위탁', '국내주식'), []);
});

test('findExistingInstruments: 금현물 계좌 보유는 위탁 조회 시 실존 후보로 잡힘(2026-08-21 사고 재발방지)', () => {
  const holdings = [
    { account: '금현물', assetClass: '금', name: '금 99.99K' },
    { account: '연금저축', assetClass: '금', name: 'TIGER KRX금현물' },
  ];
  const found = findExistingInstruments(holdings, '위탁', '금');
  assert.deepEqual(found.map((h) => h.name), ['금 99.99K']);
});

test('findExistingInstruments: 계좌 파라미터로 금현물을 넘겨도 위탁과 동일하게 정규화됨(대칭성, 코드리뷰 지적)', () => {
  const holdings = [
    { account: '금현물', assetClass: '금', name: '금 99.99K' },
    { account: '위탁', assetClass: '금', name: '가상의 위탁금ETF' },
  ];
  const foundViaGold = findExistingInstruments(holdings, '금현물', '금');
  const foundViaWt = findExistingInstruments(holdings, '위탁', '금');
  assert.deepEqual(foundViaGold, foundViaWt); // 둘 다 위탁으로 정규화되니 결과가 같아야 함
  assert.equal(foundViaGold.length, 2);
});
