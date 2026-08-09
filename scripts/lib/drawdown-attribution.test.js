import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMaxDrawdownWindow, computeDrawdownContributions } from './drawdown-attribution.mjs';

test('findMaxDrawdownWindow: 고점→저점 구간을 정확히 찾는다', () => {
  // 1.0 → 1.2(고점) → 1.1 → 0.8(저점, 여기까지 낙폭 0.333) → 0.9 → 1.5(새 고점)
  const cum = [1.0, 1.2, 1.1, 0.8, 0.9, 1.5];
  const { peakIndex, troughIndex, drawdown } = findMaxDrawdownWindow(cum);
  assert.equal(peakIndex, 1);
  assert.equal(troughIndex, 3);
  assert.ok(Math.abs(drawdown - (1.2 - 0.8) / 1.2) < 1e-9);
});

test('findMaxDrawdownWindow: 계속 상승만 하면 낙폭 0, peak=trough=0', () => {
  const { peakIndex, troughIndex, drawdown } = findMaxDrawdownWindow([1.0, 1.1, 1.2]);
  assert.equal(drawdown, 0);
  assert.equal(peakIndex, 0);
  assert.equal(troughIndex, 0);
});

test('findMaxDrawdownWindow: 여러 낙폭 중 가장 큰 것을 고른다', () => {
  // 첫 낙폭(1.0→0.95, 5%)보다 둘째 낙폭(1.3→1.0, 23%)이 더 큼
  const cum = [1.0, 0.95, 1.3, 1.0];
  const { peakIndex, troughIndex } = findMaxDrawdownWindow(cum);
  assert.equal(peakIndex, 2);
  assert.equal(troughIndex, 3);
});

test('computeDrawdownContributions: 낙폭구간 동안 보유했던 종목의 누적수익률을 계산', () => {
  const sim = [
    { date: 'd0', holdings: ['A', 'B'] },
    { date: 'd1', holdings: ['A'] }, // d0~d1 구간엔 A,B 보유(d0 시점 확정분)
    { date: 'd2', holdings: ['A'] }, // d1~d2 구간엔 A만 보유
  ];
  const prices = {
    A: { d0: 100, d1: 90, d2: 81 }, // -10% then -10% → 누적 -19%
    B: { d0: 100, d1: 50 },          // -50%(한 구간만 보유)
  };
  const contributions = computeDrawdownContributions(sim, prices, 0, 2);
  const byCode = Object.fromEntries(contributions.map((c) => [c.code, c]));
  assert.ok(Math.abs(byCode.A.cumulativeReturn - (-0.19)) < 1e-9);
  assert.equal(byCode.A.monthsHeld, 2);
  assert.ok(Math.abs(byCode.B.cumulativeReturn - (-0.5)) < 1e-9);
  assert.equal(byCode.B.monthsHeld, 1);
});

test('computeDrawdownContributions: 가장 많이 깎아먹은 순(낮은 수익률 순)으로 정렬', () => {
  const sim = [{ date: 'd0', holdings: ['A', 'B'] }, { date: 'd1', holdings: [] }];
  const prices = { A: { d0: 100, d1: 90 }, B: { d0: 100, d1: 50 } };
  const contributions = computeDrawdownContributions(sim, prices, 0, 1);
  assert.deepEqual(contributions.map((c) => c.code), ['B', 'A']); // B가 더 많이 깎아먹음
});

test('computeDrawdownContributions: 가격 결측 구간은 제외(추정 안 함)', () => {
  const sim = [{ date: 'd0', holdings: ['A'] }, { date: 'd1', holdings: ['A'] }];
  const prices = { A: { d0: 100 } }; // d1 가격 없음
  const contributions = computeDrawdownContributions(sim, prices, 0, 1);
  assert.deepEqual(contributions, []);
});

test('computeDrawdownContributions: 구간이 없으면(windowStart===windowEnd) 빈 배열', () => {
  const sim = [{ date: 'd0', holdings: ['A'] }];
  assert.deepEqual(computeDrawdownContributions(sim, {}, 0, 0), []);
});
