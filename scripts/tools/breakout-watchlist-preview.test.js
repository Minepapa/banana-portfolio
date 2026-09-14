import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProximity, rankByProximity } from './breakout-watchlist-preview.mjs';

function flatSeries(n, value) {
  return Array.from({ length: n }, () => value);
}

test('computeProximity: 데이터 부족(252거래일 미만)이면 null(추정 안 함)', () => {
  const closes = flatSeries(100, 100);
  const highs = flatSeries(100, 101);
  const benchmarkCloses = flatSeries(100, 1000);
  assert.equal(computeProximity({ closes, highs, benchmarkCloses }), null);
});

test('computeProximity: 종가가 직전 52주 고점보다 낮으면 distancePct가 음수', () => {
  const highs = [...flatSeries(252, 100), 90]; // 당일 제외 직전 252일 고점=100, 당일 종가=90
  const closes = [...flatSeries(252, 90), 90];
  const benchmarkCloses = flatSeries(253, 1000);
  const p = computeProximity({ closes, highs, benchmarkCloses });
  assert.notEqual(p, null);
  assert.ok(p.distancePct < 0, `distancePct는 음수여야 함, got ${p.distancePct}`);
  assert.equal(p.alreadyAboveHigh, false);
  assert.ok(Math.abs(p.distancePct - -10) < 1e-6); // 90/100-1 = -10%
});

test('computeProximity: 종가가 직전 52주 고점을 넘으면 distancePct 양수 + alreadyAboveHigh true', () => {
  const highs = [...flatSeries(252, 100), 110];
  const closes = [...flatSeries(252, 90), 110];
  const benchmarkCloses = flatSeries(253, 1000);
  const p = computeProximity({ closes, highs, benchmarkCloses });
  assert.notEqual(p, null);
  assert.ok(p.distancePct > 0);
  assert.equal(p.alreadyAboveHigh, true);
});

test('rankByProximity: proximity가 null인 후보는 제외', () => {
  const candidates = [
    { code: 'A', proximity: { distancePct: -5 } },
    { code: 'B', proximity: null },
    { code: 'C', proximity: { distancePct: -1 } },
  ];
  const ranked = rankByProximity(candidates, 10);
  assert.deepEqual(ranked.map((c) => c.code), ['C', 'A']);
});

test('rankByProximity: distancePct 내림차순(고점에 가까울수록 먼저) + top 개수로 자름', () => {
  const candidates = [
    { code: 'A', proximity: { distancePct: -10 } },
    { code: 'B', proximity: { distancePct: -1 } },
    { code: 'C', proximity: { distancePct: -20 } },
    { code: 'D', proximity: { distancePct: 2 } },
  ];
  const ranked = rankByProximity(candidates, 2);
  assert.deepEqual(ranked.map((c) => c.code), ['D', 'B']);
});
