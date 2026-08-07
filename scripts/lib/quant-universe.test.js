import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterByLiquidity, LIQUIDITY_MIN_KRW } from './quant-universe.mjs';

test('LIQUIDITY_MIN_KRW: 오너 확정값 30억원', () => {
  assert.equal(LIQUIDITY_MIN_KRW, 3_000_000_000);
});

test('filterByLiquidity: 기준 이상만 통과', () => {
  const candidates = [
    { Code: 'A', avgTradingValue: 5_000_000_000 },
    { Code: 'B', avgTradingValue: 2_000_000_000 },
    { Code: 'C', avgTradingValue: 3_000_000_000 }, // 경계값(포함)
  ];
  const r = filterByLiquidity(candidates);
  assert.deepEqual(r.map((c) => c.Code), ['A', 'C']);
});

test('filterByLiquidity: avgTradingValue가 null이면 추정하지 않고 제외', () => {
  const candidates = [
    { Code: 'A', avgTradingValue: 5_000_000_000 },
    { Code: 'B', avgTradingValue: null }, // 조회 실패
  ];
  const r = filterByLiquidity(candidates);
  assert.deepEqual(r.map((c) => c.Code), ['A']);
});

test('filterByLiquidity: 커스텀 기준값 적용 가능', () => {
  const candidates = [{ Code: 'A', avgTradingValue: 1_000_000_000 }];
  assert.equal(filterByLiquidity(candidates, 500_000_000).length, 1);
  assert.equal(filterByLiquidity(candidates, 2_000_000_000).length, 0);
});
