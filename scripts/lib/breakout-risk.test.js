import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rMultiplePrice,
  reachedRMultiple,
  computeTrailingStop,
  computePositionSize,
  shouldPyramid,
  shouldTakePartialProfit,
  STOP_LOSS_PCT,
  RISK_PER_TRADE_PCT,
} from './breakout-risk.mjs';

test('rMultiplePrice: 1R=+8%, 2R=+16%, 3R=+24%', () => {
  assert.ok(Math.abs(rMultiplePrice(10000, 1) - 10800) < 1e-6);
  assert.ok(Math.abs(rMultiplePrice(10000, 2) - 11600) < 1e-6);
  assert.ok(Math.abs(rMultiplePrice(10000, 3) - 12400) < 1e-6);
});

test('reachedRMultiple: 도달 단계 정수 계산', () => {
  assert.equal(reachedRMultiple(10000, 10000), 0); // 보합
  assert.equal(reachedRMultiple(10000, 10799), 0); // 1R 직전
  assert.equal(reachedRMultiple(10000, 10800), 1); // 정확히 1R
  assert.equal(reachedRMultiple(10000, 11600), 2);
  assert.equal(reachedRMultiple(10000, 12400), 3);
});

test('reachedRMultiple: 손실 중이어도 0(음수 없음)', () => {
  assert.equal(reachedRMultiple(10000, 9000), 0);
});

test('computeTrailingStop: 0R(미도달)이면 최초 손절(-8%)', () => {
  assert.ok(Math.abs(computeTrailingStop(10000, 10000) - 9200) < 1e-6);
});

test('computeTrailingStop: 1R 도달이면 본전', () => {
  assert.ok(Math.abs(computeTrailingStop(10000, 10800) - 10000) < 1e-6);
});

test('computeTrailingStop: 2R 도달이면 1R가', () => {
  assert.ok(Math.abs(computeTrailingStop(10000, 11600) - 10800) < 1e-6);
});

test('computeTrailingStop: 3R 도달이면 2R가', () => {
  assert.ok(Math.abs(computeTrailingStop(10000, 12400) - 11600) < 1e-6);
});

test('computeTrailingStop: 래칫은 호출측 책임 — 이 함수 자체는 현재 고점 기준 단조 계산만', () => {
  // 4R까지 갔다가 오늘 고점이 3R 수준으로 낮아 보이는 입력이 와도(호출측이 보통
  // "지금까지의 최고가"를 넘겨 이런 역전은 안 생기지만) 함수 자체는 입력 그대로 계산.
  assert.ok(Math.abs(computeTrailingStop(10000, 13200) - 12400) < 1e-6); // 4R 도달 → 3R가
});

test('computePositionSize: Max 2%룰 — 자본금 4천만원, 손절 8% → 1천만원', () => {
  const size = computePositionSize(40_000_000);
  assert.ok(Math.abs(size - 10_000_000) < 1e-3);
});

test('computePositionSize: 자본금·손절률 커스텀', () => {
  const size = computePositionSize(100_000_000, { riskPct: 0.02, stopLossPct: 0.08 });
  assert.ok(Math.abs(size - 25_000_000) < 1e-3);
});

test('computePositionSize: 자본금 0 이하면 0', () => {
  assert.equal(computePositionSize(0), 0);
  assert.equal(computePositionSize(-100), 0);
});

test('shouldPyramid: 3R 도달 + 유닛 여유 있으면 true', () => {
  assert.equal(shouldPyramid(10000, 12400, 1), true);
});

test('shouldPyramid: 3R 미도달이면 false', () => {
  assert.equal(shouldPyramid(10000, 11000, 1), false);
});

test('shouldPyramid: 이미 유닛이 꽉 찼으면 false', () => {
  assert.equal(shouldPyramid(10000, 12400, 2), false);
});

test('shouldTakePartialProfit: 3R 도달 + 아직 실행 안 했으면 true', () => {
  assert.equal(shouldTakePartialProfit(10000, 12400, false), true);
});

test('shouldTakePartialProfit: 3R 미도달이면 false', () => {
  assert.equal(shouldTakePartialProfit(10000, 11000, false), false);
});

test('shouldTakePartialProfit: 이미 실행했으면 다시 안 함(1회성)', () => {
  assert.equal(shouldTakePartialProfit(10000, 12400, true), false);
});

test('상수값 확인 — 오너 확정치', () => {
  assert.equal(STOP_LOSS_PCT, 0.08);
  assert.equal(RISK_PER_TRADE_PCT, 0.02);
});
