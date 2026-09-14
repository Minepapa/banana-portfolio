import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextBettingUnits,
  computeBettingUnitInvestment,
  TOTAL_BETTING_UNITS,
  MIN_BETTING_UNITS,
} from './breakout-unit-tracker.mjs';

test('TOTAL_BETTING_UNITS=5, MIN_BETTING_UNITS=1 (오너 확정, 2026-09-14)', () => {
  assert.equal(TOTAL_BETTING_UNITS, 5);
  assert.equal(MIN_BETTING_UNITS, 1);
});

test('nextBettingUnits: success는 +1', () => {
  assert.equal(nextBettingUnits(1, 'success'), 2);
  assert.equal(nextBettingUnits(3, 'success'), 4);
});

test('nextBettingUnits: failure는 -1', () => {
  assert.equal(nextBettingUnits(3, 'failure'), 2);
  assert.equal(nextBettingUnits(2, 'failure'), 1);
});

test('nextBettingUnits: 상한(5) 넘게 성공해도 5에서 멈춤(래칫)', () => {
  assert.equal(nextBettingUnits(5, 'success'), 5);
  assert.equal(nextBettingUnits(4, 'success'), 5);
});

test('nextBettingUnits: 하한(1) 밑으로 실패해도 1에서 멈춤(래칫)', () => {
  assert.equal(nextBettingUnits(1, 'failure'), 1);
});

test('nextBettingUnits: 4연속 성공하면 1→5(풀유닛)', () => {
  let units = 1;
  for (let i = 0; i < 4; i++) units = nextBettingUnits(units, 'success');
  assert.equal(units, 5);
});

test('nextBettingUnits: 알 수 없는 outcome은 throw', () => {
  assert.throws(() => nextBettingUnits(1, 'draw'));
});

test('nextBettingUnits: currentUnits가 정수가 아니면(NaN·소수) throw — 조용한 폴백 방지', () => {
  assert.throws(() => nextBettingUnits(NaN, 'success'));
  assert.throws(() => nextBettingUnits(2.5, 'success'));
  assert.throws(() => nextBettingUnits(undefined, 'success'));
});

test('computeBettingUnitInvestment: 영상 예시(1000만원·5유닛) — 1유닛=50만원, 5유닛(풀)=250만원', () => {
  const capital = 10_000_000;
  assert.ok(Math.abs(computeBettingUnitInvestment(capital, 1) - 500_000) < 1e-6);
  assert.ok(Math.abs(computeBettingUnitInvestment(capital, 5) - 2_500_000) < 1e-6);
  assert.ok(Math.abs(computeBettingUnitInvestment(capital, 3) - 1_500_000) < 1e-6);
});

test('computeBettingUnitInvestment: currentUnits가 범위를 벗어나면 클램프', () => {
  const capital = 10_000_000;
  assert.ok(Math.abs(computeBettingUnitInvestment(capital, 0) - 500_000) < 1e-6); // MIN(1)로 클램프
  assert.ok(Math.abs(computeBettingUnitInvestment(capital, 99) - 2_500_000) < 1e-6); // TOTAL(5)로 클램프
});

test('computeBettingUnitInvestment: currentUnits가 정수가 아니면(NaN·소수) throw — 조용한 폴백 방지', () => {
  const capital = 10_000_000;
  assert.throws(() => computeBettingUnitInvestment(capital, NaN));
  assert.throws(() => computeBettingUnitInvestment(capital, 2.5));
  assert.throws(() => computeBettingUnitInvestment(capital, undefined));
});

test('computeBettingUnitInvestment: riskPct 등 opts는 computePositionSize에 그대로 전달', () => {
  const capital = 10_000_000;
  // riskPct=0.01이면 최대한도가 절반(125만원)이 되므로, 5유닛 기준 125만원이어야 함
  assert.ok(Math.abs(computeBettingUnitInvestment(capital, 5, { riskPct: 0.01 }) - 1_250_000) < 1e-6);
});
