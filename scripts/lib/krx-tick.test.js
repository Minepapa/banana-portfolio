import { test } from 'node:test';
import assert from 'node:assert/strict';
import { krxTickSize, roundToKrxTick } from './krx-tick.mjs';

test('krxTickSize: 구간별 호가단위(2026-01-25 KRX 통합 표)', () => {
  assert.equal(krxTickSize(1000), 1);
  assert.equal(krxTickSize(1999), 1);
  assert.equal(krxTickSize(2000), 5);
  assert.equal(krxTickSize(4999), 5);
  assert.equal(krxTickSize(5000), 10);
  assert.equal(krxTickSize(19999), 10);
  assert.equal(krxTickSize(20000), 50);
  assert.equal(krxTickSize(49999), 50);
  assert.equal(krxTickSize(50000), 100);
  assert.equal(krxTickSize(199999), 100);
  assert.equal(krxTickSize(200000), 500);
  assert.equal(krxTickSize(499999), 500);
  assert.equal(krxTickSize(500000), 1000);
  assert.equal(krxTickSize(1000000), 1000);
});

// 2026-09-22 실사고 재현 — SK텔레콤 87,400원 진입 × 0.92(8% 손절) = 80,408원,
// 이 가격대(50,000~200,000원) 호가단위는 100원이라 KIS가 "주식주문호가단위
// 오류입니다"로 거부했다.
test('roundToKrxTick: 실사고 재현 — 80,408원(호가단위 위반)을 80,400원으로 보정', () => {
  assert.equal(roundToKrxTick(80408), 80400);
});

test('roundToKrxTick: 이미 유효한 호가는 그대로', () => {
  assert.equal(roundToKrxTick(80400), 80400);
  assert.equal(roundToKrxTick(1234), 1234);
});

test('roundToKrxTick: 반올림 방향(사사오입)', () => {
  assert.equal(roundToKrxTick(80450), 80500); // 정확히 중간이면 반올림
  assert.equal(roundToKrxTick(80449), 80400);
});
