import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankByMarketCap } from './marketcap-ranking.mjs';

test('rankByMarketCap: 시가총액 내림차순 정렬 + 순위 부여', () => {
  const candidates = [
    { Code: 'A', Marcap: 1000 },
    { Code: 'B', Marcap: 3000 },
    { Code: 'C', Marcap: 2000 },
  ];
  const ranked = rankByMarketCap(candidates);
  assert.deepEqual(ranked.map((c) => c.Code), ['B', 'C', 'A']);
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].rank, 2);
  assert.equal(ranked[2].rank, 3);
});

test('rankByMarketCap: Marcap이 0 이하인 항목은 제외(추정 안 함)', () => {
  const candidates = [
    { Code: 'A', Marcap: 1000 },
    { Code: 'B', Marcap: 0 },
    { Code: 'C', Marcap: -100 },
  ];
  const ranked = rankByMarketCap(candidates);
  assert.deepEqual(ranked.map((c) => c.Code), ['A']);
});

test('rankByMarketCap: 빈 배열이면 빈 배열', () => {
  assert.deepEqual(rankByMarketCap([]), []);
});

test('rankByMarketCap: 원본 필드를 보존한 채로 rank만 붙인다', () => {
  const ranked = rankByMarketCap([{ Code: 'A', Name: '테스트', Marcap: 1000 }]);
  assert.equal(ranked[0].Name, '테스트');
  assert.equal(ranked[0].rank, 1);
});
