import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isKrxPreMarketWindow, isPriceSeriesStale, tradingDayFillCheckWindow, latestConfirmedHigh,
} from './reconcile-breakout-protection.mjs';

test('isKrxPreMarketWindow: 평일 08:35 KST KRX 시가단일가 안', () => {
  assert.equal(isKrxPreMarketWindow(new Date('2026-09-24T23:35:00Z')), true); // 9/25 금 08:35 KST
});
test('isKrxPreMarketWindow: 08:30 시작 전은 false', () => {
  assert.equal(isKrxPreMarketWindow(new Date('2026-09-24T23:29:00Z')), false);
});
test('isKrxPreMarketWindow: 09:00 정규장 개시부터는 false', () => {
  assert.equal(isKrxPreMarketWindow(new Date('2026-09-25T00:00:00Z')), false);
});
test('isKrxPreMarketWindow: 토요일 08:35는 false', () => {
  assert.equal(isKrxPreMarketWindow(new Date('2026-09-25T23:35:00Z')), false);
});

// 2026-09-29 2차 코드리뷰 HIGH 지적 — 07:00 캐시 잡 실패나 이 잡 자체의 실행
// 공백으로 latestTradingDate가 너무 오래되면 checkOrderFill 조회창·원장 날짜를
// 신뢰하면 안 된다.
test('isPriceSeriesStale: null이면 항상 stale', () => {
  assert.equal(isPriceSeriesStale(null, new Date('2026-09-29T23:35:00Z')), true);
});
// now=2026-09-29T23:35:00Z는 KST로 2026-09-30 08:35(isKrxPreMarketWindow 테스트와
// 동일 관례) — "오늘"의 KST 날짜는 2026-09-30이다.
test('isPriceSeriesStale: 전날(정상적인 하루치 지연)은 stale 아님', () => {
  assert.equal(isPriceSeriesStale('2026-09-29', new Date('2026-09-29T23:35:00Z')), false);
});
test('isPriceSeriesStale: 실제 KRX 최장 연휴 수준(2017년 추석, 14일 이내)은 stale 아님', () => {
  assert.equal(isPriceSeriesStale('2026-09-16', new Date('2026-09-29T23:35:00Z')), false);
});
test('isPriceSeriesStale: 15일 이상 벌어지면 stale', () => {
  assert.equal(isPriceSeriesStale('2026-09-14', new Date('2026-09-29T23:35:00Z')), true);
});
test('isPriceSeriesStale: 캐시 날짜가 미래(시계 꼬임 등)면 stale', () => {
  assert.equal(isPriceSeriesStale('2026-10-01', new Date('2026-09-29T23:35:00Z')), true);
});

test('tradingDayFillCheckWindow: latestTradingDate가 있으면 그 날짜 KST 정오를 쓴다', () => {
  const d = tradingDayFillCheckWindow('2026-09-25', new Date('2026-09-29T23:35:00Z'));
  assert.equal(d.toISOString(), '2026-09-25T03:00:00.000Z');
});
test('tradingDayFillCheckWindow: latestTradingDate가 없으면 fallback을 그대로 쓴다', () => {
  const fallback = new Date('2026-09-29T23:35:00Z');
  assert.equal(tradingDayFillCheckWindow(null, fallback), fallback);
});

test('latestConfirmedHigh: entryDate 이후 구간의 최댓값(기존 highSinceEntry 포함)', () => {
  const series = { dates: ['2026-09-20', '2026-09-21', '2026-09-22'], highs: [9000, 11000, 10500] };
  const position = { entryDate: '2026-09-21', highSinceEntry: 10800 };
  assert.equal(latestConfirmedHigh(position, series), 11000);
});
test('latestConfirmedHigh: 시세 캐시가 없으면 null(추정 안 함)', () => {
  assert.equal(latestConfirmedHigh({ entryDate: '2026-09-21', highSinceEntry: 10000 }, null), null);
});
