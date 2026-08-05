import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCurrentAllocation, checkBand, computeRebalanceGaps, TARGET_ALLOCATION } from './rebalance-gap.mjs';

test('TARGET_ALLOCATION: 6개 자산군 합이 정확히 100%(확정 정본)', () => {
  const sum = Object.values(TARGET_ALLOCATION).reduce((s, v) => s + v, 0);
  assert.equal(sum, 100);
});

test('computeCurrentAllocation: ISA·IRP는 범위 밖(위탁+연금저축만)', () => {
  const holdings = [
    { account: 'ISA', assetClass: '배당주', evalAmount: 1000000 },
    { account: 'IRP', assetClass: '국내주식', evalAmount: 1000000 },
    { account: '위탁', assetClass: '국내주식', evalAmount: 300000 },
  ];
  const r = computeCurrentAllocation(holdings);
  assert.equal(r.totalEval, 300000);
  assert.equal(r.currentPct.국내주식, 100);
});

test('computeCurrentAllocation: 현금성·달러·TDF 등 목표 6종 밖의 자산군은 분모에서 제외', () => {
  const holdings = [
    { account: '위탁', assetClass: '현금성', evalAmount: 5000000 },
    { account: '위탁', assetClass: '달러', evalAmount: 2000000 },
    { account: '위탁', assetClass: '국내주식', evalAmount: 100000 },
  ];
  const r = computeCurrentAllocation(holdings);
  assert.equal(r.totalEval, 100000); // 현금성·달러는 분모에 안 들어감
  assert.equal(r.currentPct.국내주식, 100);
});

test('computeCurrentAllocation: 위탁+연금저축 합산', () => {
  const holdings = [
    { account: '위탁', assetClass: '채권', evalAmount: 100000 },
    { account: '연금저축', assetClass: '채권', evalAmount: 200000 },
    { account: '위탁', assetClass: '국내주식', evalAmount: 700000 },
  ];
  const r = computeCurrentAllocation(holdings);
  assert.equal(r.totalEval, 1000000);
  assert.equal(r.currentPct.채권, 30);
  assert.equal(r.currentPct.국내주식, 70);
});

test('checkBand: 목표 20%(채권)는 절대 5%p·상대 25%가 수학적으로 정확히 같은 지점(설계서 확정 사실)', () => {
  const r = checkBand(20, 25); // +5%p 이탈, 25% 목표대비 상대 25%
  assert.equal(r.absDeltaPct, 5);
  assert.equal(r.relDeltaPct, 25);
  assert.equal(r.breached, true);
  assert.equal(r.breachType, '절대+상대');
});

test('checkBand: 목표 20%에서 4.9%p 이탈은 밴드 안(둘 다 미달)', () => {
  const r = checkBand(20, 24.9);
  assert.equal(r.breached, false);
});

test('checkBand: 목표 10%(금)는 상대 25%(=2.5%p)가 절대 5%p보다 먼저 걸림', () => {
  const r = checkBand(10, 12.6); // +2.6%p, 상대 26% → 상대만 이탈
  assert.equal(r.breached, true);
  assert.equal(r.breachType, '상대');
});

test('checkBand: 목표 30%(국내·해외주식)는 절대 5%p가 상대 25%(=7.5%p)보다 먼저 걸림', () => {
  const r = checkBand(30, 35.2); // +5.2%p, 상대 17.3% → 절대만 이탈
  assert.equal(r.breached, true);
  assert.equal(r.breachType, '절대');
});

test('checkBand: 부족 방향(현재가 목표보다 낮음)도 동일하게 판정', () => {
  const r = checkBand(30, 24); // -6%p
  assert.equal(r.breached, true);
  assert.equal(r.breachType, '절대');
});

test('computeRebalanceGaps: 목표비중 그대로면 이탈 없음', () => {
  const holdings = [
    { account: '위탁', assetClass: '채권', evalAmount: 200000 },
    { account: '위탁', assetClass: '금', evalAmount: 100000 },
    { account: '위탁', assetClass: '배당주', evalAmount: 50000 },
    { account: '위탁', assetClass: '리츠', evalAmount: 50000 },
    { account: '위탁', assetClass: '국내주식', evalAmount: 300000 },
    { account: '위탁', assetClass: '해외주식', evalAmount: 300000 },
  ];
  const r = computeRebalanceGaps(holdings);
  assert.equal(r.anyBreached, false);
  for (const g of r.gaps) assert.equal(g.breached, false);
});

test('computeRebalanceGaps: 보유가 하나도 없으면 전부 0%로 목표 대비 크게 이탈', () => {
  const r = computeRebalanceGaps([]);
  assert.equal(r.totalEval, 0);
  assert.equal(r.anyBreached, true); // 목표>0인데 현재 0%면 전부 이탈
});
