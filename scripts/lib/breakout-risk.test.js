import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rMultiplePrice,
  reachedRMultiple,
  computeTrailingStop,
  computePositionSize,
  shouldPyramid,
  shouldTakePartialProfit,
  computeTrueRange,
  computeATR,
  selectAdaptiveStopLossPct,
  STOP_LOSS_PCT,
  RISK_PER_TRADE_PCT,
  TIGHT_STOP_LOSS_PCT,
  ATR_LOOKBACK_DAYS,
  ATR_STOP_THRESHOLD_PCT,
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

// ATR 가변 손절(2026-09-19, 오너 지시) — rMultiplePrice/reachedRMultiple/
// computeTrailingStop의 stopLossPct 파라미터화(기본값 유지 하위호환) + ATR 계산 +
// 손절폭 선택 함수.
test('rMultiplePrice: stopLossPct를 커스텀하면 R배수 가격도 그에 비례(3R=+12% for 4% stop)', () => {
  assert.ok(Math.abs(rMultiplePrice(10000, 1, 0.04) - 10400) < 1e-6);
  assert.ok(Math.abs(rMultiplePrice(10000, 3, 0.04) - 11200) < 1e-6); // 3R = +12%(24%가 아님)
});

test('reachedRMultiple: stopLossPct 4%면 절반 상승만으로도 같은 R단계 도달', () => {
  assert.equal(reachedRMultiple(10000, 10400, 0.04), 1); // 8%짜리였으면 아직 0R
  assert.equal(reachedRMultiple(10000, 10400, STOP_LOSS_PCT), 0);
});

test('computeTrailingStop: stopLossPct 4%면 최초 손절이 -4%', () => {
  assert.ok(Math.abs(computeTrailingStop(10000, 10000, 0.04) - 9600) < 1e-6);
});

test('computeTrueRange: index 0은 null, 이후는 고가-저가/갭 중 최댓값', () => {
  const highs = [100, 110, 108];
  const lows = [95, 104, 100];
  const closes = [98, 106, 105];
  const tr = computeTrueRange(highs, lows, closes);
  assert.equal(tr[0], null);
  assert.equal(tr[1], 12); // max(110-104=6, |110-98|=12, |104-98|=6)
  assert.equal(tr[2], 8); // max(108-100=8, |108-106|=2, |100-106|=6)
});

test('computeATR: 균일한 TR이면 그 값 그대로(단순평균)', () => {
  const n = ATR_LOOKBACK_DAYS + 1;
  const highs = new Array(n).fill(110);
  const lows = new Array(n).fill(100);
  const closes = new Array(n).fill(105);
  const atr = computeATR(highs, lows, closes, n - 1);
  assert.ok(Math.abs(atr - 10) < 1e-6); // TR = 고가-저가 = 10 매일 동일
});

test('computeATR: 창 부족이면 null', () => {
  const highs = new Array(5).fill(110);
  const lows = new Array(5).fill(100);
  const closes = new Array(5).fill(105);
  assert.equal(computeATR(highs, lows, closes, 4), null);
});

// 2026-09-19 재조정으로 기본 임계값이 4.0→8.0으로 바뀌어 ATR% 예시값도 같이 조정
// (아래 세 테스트는 "기본값이 실제로 얼마인지"를 검증하는 게 목적이라, 상수가
// 바뀌면 여기 리터럴도 같이 바뀌는 게 맞다 — thresholdPct를 명시로 고정한
// "커스텀 임계값" 테스트와는 다른 성격).
test('selectAdaptiveStopLossPct: ATR%가 임계값 이상이면 넓은 손절(STOP_LOSS_PCT)', () => {
  // atr=900, price=10000 → ATR%=9.0 ≥ 8.0(기본 임계값)
  assert.equal(selectAdaptiveStopLossPct(900, 10000), STOP_LOSS_PCT);
});

test('selectAdaptiveStopLossPct: ATR%가 임계값 미만이면 좁은 손절(TIGHT_STOP_LOSS_PCT)', () => {
  // atr=300, price=10000 → ATR%=3.0 < 8.0
  assert.equal(selectAdaptiveStopLossPct(300, 10000), TIGHT_STOP_LOSS_PCT);
});

test('selectAdaptiveStopLossPct: 경계값(정확히 임계값)은 넓은 손절 쪽', () => {
  assert.equal(selectAdaptiveStopLossPct(800, 10000), STOP_LOSS_PCT); // ATR%=8.0=임계값
});

test('selectAdaptiveStopLossPct: 데이터 부족(atr=null)이나 가격 무효면 null(추정 안 함)', () => {
  assert.equal(selectAdaptiveStopLossPct(null, 10000), null);
  assert.equal(selectAdaptiveStopLossPct(500, 0), null);
  assert.equal(selectAdaptiveStopLossPct(500, null), null);
});

test('selectAdaptiveStopLossPct: 커스텀 임계값·손절폭도 반영', () => {
  assert.equal(selectAdaptiveStopLossPct(500, 10000, { thresholdPct: 6, tightPct: 0.03, widePct: 0.1 }), 0.03); // 5.0 < 6 → tight
  assert.equal(selectAdaptiveStopLossPct(700, 10000, { thresholdPct: 6, tightPct: 0.03, widePct: 0.1 }), 0.1); // 7.0 ≥ 6 → wide
});

// 2026-09-19 재조정 — 백테스트(4/6/8/10% 스윕, 2014~2026)로 8%가 4%(초기값) 대비
// 연환산 8.8%→13.0%·샤프 0.60→0.74 개선을 확인한 뒤 오너가 실전배선 확정.
test('ATR_STOP_THRESHOLD_PCT: 백테스트로 재조정된 실전값(8%), TIGHT_STOP_LOSS_PCT는 그대로', () => {
  assert.equal(ATR_STOP_THRESHOLD_PCT, 8.0);
  assert.equal(TIGHT_STOP_LOSS_PCT, 0.04);
});
