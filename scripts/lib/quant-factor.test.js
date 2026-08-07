import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOcfToPrice, rankByOcfToPrice } from './quant-factor.mjs';

test('computeOcfToPrice: 정상 계산', () => {
  assert.equal(computeOcfToPrice(1000, 10000), 0.1);
});

test('computeOcfToPrice: operCf가 null이면(추정 안 함) null', () => {
  assert.equal(computeOcfToPrice(null, 10000), null);
});

test('computeOcfToPrice: marcap이 0 이하면 null(0으로 나누기 방지)', () => {
  assert.equal(computeOcfToPrice(1000, 0), null);
  assert.equal(computeOcfToPrice(1000, -100), null);
});

test('computeOcfToPrice: OCF가 음수(적자)여도 정상 계산(저평가 랭킹에서 자연히 하위로)', () => {
  assert.equal(computeOcfToPrice(-1000, 10000), -0.1);
});

test('rankByOcfToPrice: OCF/P 내림차순 정렬 + 순위 부여', () => {
  const candidates = [
    { Code: 'A', Marcap: 10000, operCf: 500 },  // 0.05
    { Code: 'B', Marcap: 10000, operCf: 2000 }, // 0.20 (1위)
    { Code: 'C', Marcap: 10000, operCf: 1000 }, // 0.10
  ];
  const ranked = rankByOcfToPrice(candidates);
  assert.deepEqual(ranked.map((c) => c.Code), ['B', 'C', 'A']);
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].rank, 2);
  assert.equal(ranked[2].rank, 3);
});

test('rankByOcfToPrice: operCf가 null인 종목은 순위에서 제외(추정 안 함)', () => {
  const candidates = [
    { Code: 'A', Marcap: 10000, operCf: 1000 },
    { Code: 'B', Marcap: 10000, operCf: null }, // 조회 실패
  ];
  const ranked = rankByOcfToPrice(candidates);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].Code, 'A');
});

test('rankByOcfToPrice: 빈 배열이면 빈 배열', () => {
  assert.deepEqual(rankByOcfToPrice([]), []);
});
