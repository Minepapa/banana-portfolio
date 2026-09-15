import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProximity, rankByProximity, formatWatchlistFact } from './breakout-watchlist-preview.mjs';

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

test('computeProximity: 52주 데이터는 충분하고 변동성 계산도 충분하면 vcpReady가 계산됨(null 아님)', () => {
  const highs = flatSeries(253, 100);
  const closes = flatSeries(253, 90); // flat 시리즈는 변동성 0 → 항상 조용함(ready=true)
  const benchmarkCloses = flatSeries(253, 1000);
  const p = computeProximity({ closes, highs, benchmarkCloses });
  assert.notEqual(p, null);
  assert.equal(p.vcpReady, true);
});

test('computeProximity: 최근 변동성이 확대돼 있으면 vcpReady=false', () => {
  const highs = flatSeries(280, 100);
  const closes = [];
  for (let i = 0; i < 260; i++) closes.push(100 * (1 + (i % 2 === 0 ? 0.001 : -0.001))); // 조용한 과거
  for (let i = 0; i < 11; i++) closes.push(closes[closes.length - 1] * (1 + (i % 2 === 0 ? 0.04 : -0.04))); // 최근 변동성 확대
  const benchmarkCloses = flatSeries(closes.length, 1000);
  const p = computeProximity({ closes, highs: highs.slice(0, closes.length), benchmarkCloses });
  assert.notEqual(p, null);
  assert.equal(p.vcpReady, false);
});

test('computeProximity: 52주 데이터는 충분해도 변동성 계산 구간에 결측(0 이하 종가)이 섞이면 vcpReady만 null(다른 필드는 정상)', () => {
  // 52주신고가 판정은 highs만 보므로 영향 없음 — closes 쪽 결측이 VCP 계산에만 전파되는지 확인
  const highs = flatSeries(260, 101);
  const closes = flatSeries(260, 100);
  closes[254] = 0; // 최근 10일 변동성 윈도우 안에 0 이하 종가 삽입 → computeDailyReturns가 그 지점 null
  const benchmarkCloses = flatSeries(260, 1000);
  const p = computeProximity({ closes, highs, benchmarkCloses });
  assert.notEqual(p, null);
  assert.equal(p.vcpReady, null);
  assert.equal(p.vcpVolRatio, null);
  assert.notEqual(p.distancePct, null); // 52주 고점 거리는 영향 안 받아야 함
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

test('rankByProximity: vcpReady=false인 후보도 걸러내지 않고 그대로 포함(VCP는 표시 전용, 필터 아님 — 설계 고정용)', () => {
  const candidates = [
    { code: 'A', proximity: { distancePct: 1, vcpReady: false } },
    { code: 'B', proximity: { distancePct: 2, vcpReady: true } },
  ];
  const ranked = rankByProximity(candidates, 10);
  assert.deepEqual(ranked.map((c) => c.code), ['B', 'A']);
});

test('formatWatchlistFact: vcpReady=true면 여유배율을 포함한 "수축완료" 문구, 판정형 단어("준비됨") 없음', () => {
  const c = { name: '테스트', code: '000000', proximity: {
    distancePct: -1.5, relativeStrength: 3.4, alreadyAboveHigh: false, vcpReady: true, vcpVolRatio: 1.05,
  } };
  const line = formatWatchlistFact(c);
  assert.match(line, /VCP 수축완료\(여유 1\.05배, 당일상승률 미확인\)/);
  assert.doesNotMatch(line, /VCP 준비됨/);
});

test('formatWatchlistFact: vcpReady=false면 "수축미형성"', () => {
  const c = { name: '테스트', code: '000000', proximity: {
    distancePct: -1.5, relativeStrength: 3.4, alreadyAboveHigh: false, vcpReady: false, vcpVolRatio: 2.3,
  } };
  assert.match(formatWatchlistFact(c), /VCP 수축미형성/);
});

test('formatWatchlistFact: vcpReady=null이면 "VCP N/A"', () => {
  const c = { name: '테스트', code: '000000', proximity: {
    distancePct: -1.5, relativeStrength: 3.4, alreadyAboveHigh: false, vcpReady: null, vcpVolRatio: null,
  } };
  assert.match(formatWatchlistFact(c), /VCP N\/A/);
});

test('formatWatchlistFact: 전일 종가가 이미 신고가를 넘었으면 태그 포함', () => {
  const c = { name: '테스트', code: '000000', proximity: {
    distancePct: 3.0, relativeStrength: 1.0, alreadyAboveHigh: true, vcpReady: null, vcpVolRatio: null,
  } };
  assert.match(formatWatchlistFact(c), /\[전일 종가 이미 신고가 돌파\]/);
});
