import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDailyReturns,
  rollingVolatility,
  isVolatilityExpansionBreakout,
  isPriceRangeConsolidationBreakout,
  is52WeekHighBreakout,
  computeRelativeStrength,
  passesRelativeStrengthFilter,
  passesMarketCapFloor,
  computeBreakoutEntrySignal,
  MARKET_CAP_FLOOR_WON,
} from './breakout-factor.mjs';

test('computeDailyReturns: 정상 계산', () => {
  const returns = computeDailyReturns([100, 110, 99]);
  assert.ok(Math.abs(returns[0] - 0.1) < 1e-9);
  assert.ok(Math.abs(returns[1] - -0.1) < 1e-9);
});

test('computeDailyReturns: 이전 종가가 0 이하면 null(추정 안 함)', () => {
  assert.deepEqual(computeDailyReturns([0, 100]), [null]);
});

test('rollingVolatility: 윈도우 미충족 구간은 null', () => {
  const returns = [0.01, 0.02, -0.01, 0.015];
  const vol = rollingVolatility(returns, 3);
  assert.equal(vol[0], null);
  assert.equal(vol[1], null);
  assert.notEqual(vol[2], null);
  assert.notEqual(vol[3], null);
});

test('rollingVolatility: 윈도우 안에 null 있으면 그 지점 null', () => {
  const returns = [0.01, null, -0.01];
  const vol = rollingVolatility(returns, 3);
  assert.equal(vol[2], null);
});

// 롤링 변동성 자체가 lookbackDays개 필요하고(각 지점 계산에 lookbackDays개 수익률
// 필요), 그 변동성의 "최근 lookbackDays일 중 최저"까지 보려면 수익률이
// 2*lookbackDays-1개 있어야 전부 non-null이 된다 — quietDays를 넉넉히 잡는다.
function buildQuietThenBreakoutCloses({ quietDays = 25, breakoutPct = 4 } = {}) {
  const closes = [100];
  for (let i = 0; i < quietDays; i++) {
    // ±0.1~0.2% 잔잔한 등락(낮은 변동성 유지)
    closes.push(closes[closes.length - 1] * (1 + (i % 2 === 0 ? 0.001 : -0.001)));
  }
  closes.push(closes[closes.length - 1] * (1 + breakoutPct / 100));
  return closes;
}

test('isVolatilityExpansionBreakout: 변동성 수축+당일 급등이면 통과', () => {
  const closes = buildQuietThenBreakoutCloses();
  const result = isVolatilityExpansionBreakout(closes, { lookbackDays: 10, breakoutPct: 3.0 });
  assert.equal(result.pass, true);
});

test('isVolatilityExpansionBreakout: 데이터 부족이면 통과 안 함', () => {
  const result = isVolatilityExpansionBreakout([100, 101, 102], { lookbackDays: 10 });
  assert.equal(result.pass, false);
});

test('isVolatilityExpansionBreakout: 변동성 수축이어도 당일 상승률 미달이면 불통과', () => {
  const closes = buildQuietThenBreakoutCloses({ breakoutPct: 0.5 });
  const result = isVolatilityExpansionBreakout(closes, { lookbackDays: 10, breakoutPct: 3.0 });
  assert.equal(result.pass, false);
});

test('isPriceRangeConsolidationBreakout: 좁은 박스권 + 당일 급등이면 통과', () => {
  // 20일간 98~102 사이 박스권(평균 100 대비 범위 4% — 15% 임계 이내), 마지막날 +5%
  const closes = [...new Array(20).fill(100).map((v, i) => v + (i % 2 === 0 ? 2 : -2))];
  const highs = closes.map((c) => c + 1);
  const lows = closes.map((c) => c - 1);
  closes.push(closes[closes.length - 1] * 1.05);
  highs.push(closes[closes.length - 1] * 1.01);
  lows.push(closes[closes.length - 2]);
  const result = isPriceRangeConsolidationBreakout(closes, highs, lows, { lookbackDays: 20, rangeThresholdPct: 15, breakoutPct: 3 });
  assert.equal(result.pass, true);
});

test('isPriceRangeConsolidationBreakout: 완만한 상승추세(박스권 아님)는 범위가 넓어 불통과', () => {
  // 20일간 90→110로 꾸준히 상승(범위=20/평균100=20% — 15% 임계 초과), 마지막날 +5%
  const closes = [];
  for (let i = 0; i < 20; i++) closes.push(90 + i);
  const highs = closes.map((c) => c + 0.5);
  const lows = closes.map((c) => c - 0.5);
  closes.push(closes[closes.length - 1] * 1.05);
  highs.push(closes[closes.length - 1] * 1.01);
  lows.push(closes[closes.length - 2]);
  const result = isPriceRangeConsolidationBreakout(closes, highs, lows, { lookbackDays: 20, rangeThresholdPct: 15, breakoutPct: 3 });
  assert.equal(result.pass, false);
  assert.ok(result.rangePct > 15);
});

test('isPriceRangeConsolidationBreakout: 박스권이어도 당일 상승률 미달이면 불통과', () => {
  const closes = [...new Array(20).fill(100).map((v, i) => v + (i % 2 === 0 ? 2 : -2))];
  const highs = closes.map((c) => c + 1);
  const lows = closes.map((c) => c - 1);
  closes.push(closes[closes.length - 1] * 1.005); // +0.5%만 상승
  highs.push(closes[closes.length - 1] * 1.01);
  lows.push(closes[closes.length - 2]);
  const result = isPriceRangeConsolidationBreakout(closes, highs, lows, { lookbackDays: 20, rangeThresholdPct: 15, breakoutPct: 3 });
  assert.equal(result.pass, false);
});

test('isPriceRangeConsolidationBreakout: 데이터 부족이면 불통과', () => {
  const result = isPriceRangeConsolidationBreakout([100, 101], [101, 102], [99, 100], { lookbackDays: 20 });
  assert.equal(result.pass, false);
  assert.equal(result.reason, '데이터 부족');
});

test('is52WeekHighBreakout: 직전 고점 돌파 시 통과', () => {
  const highs = new Array(252).fill(100);
  highs.push(105); // 당일(마지막) — 슬라이스에서 제외됨
  const result = is52WeekHighBreakout(highs, 101);
  assert.equal(result.pass, true);
  assert.equal(result.priorHigh, 100);
});

test('is52WeekHighBreakout: 직전 고점 못 넘으면 불통과', () => {
  const highs = new Array(252).fill(100);
  highs.push(105);
  const result = is52WeekHighBreakout(highs, 99);
  assert.equal(result.pass, false);
});

test('is52WeekHighBreakout: 데이터 부족이면 불통과', () => {
  const result = is52WeekHighBreakout([100, 101], 102, { lookbackDays: 252 });
  assert.equal(result.pass, false);
  assert.equal(result.reason, '데이터 부족');
});

test('computeRelativeStrength: 종목이 벤치마크보다 더 오르면 양수', () => {
  const stock = [100, 120]; // +20%
  const bench = [100, 105]; // +5%
  const rs = computeRelativeStrength(stock, bench, 1);
  assert.ok(Math.abs(rs - 15) < 1e-9);
});

test('computeRelativeStrength: 데이터 부족이면 null', () => {
  assert.equal(computeRelativeStrength([100], [100], 5), null);
});

test('passesRelativeStrengthFilter: 시장 RS 이상(0 이상)이면 통과', () => {
  assert.equal(passesRelativeStrengthFilter(0), true);
  assert.equal(passesRelativeStrengthFilter(5), true);
  assert.equal(passesRelativeStrengthFilter(-0.1), false);
  assert.equal(passesRelativeStrengthFilter(null), false);
});

test('passesMarketCapFloor: 1조원 기본 하한', () => {
  assert.equal(passesMarketCapFloor(MARKET_CAP_FLOOR_WON), true);
  assert.equal(passesMarketCapFloor(MARKET_CAP_FLOOR_WON - 1), false);
  assert.equal(passesMarketCapFloor(null), false);
});

function buildEntrySignalCandidate({ marcap = MARKET_CAP_FLOOR_WON } = {}) {
  // 251거래일은 100에 눌려있다가(52주 신고가 기준선), 그 뒤로 조용한 등락 25일 +
  // 마지막날 급등 — 52주신고가·변동성확장 둘 다 동시에 만족하는 합성 시나리오.
  const flatDays = 251;
  const closes = [...new Array(flatDays).fill(100), ...buildQuietThenBreakoutCloses().slice(1)];
  const highs = closes.slice();
  const benchmarkCloses = new Array(closes.length).fill(100); // 벤치마크는 안 움직임 → RS는 종목 상승분만큼 항상 양수
  return { closes, highs, benchmarkCloses, marcap };
}

test('computeBreakoutEntrySignal: 네 조건 전부 충족해야 pass=true', () => {
  const candidate = buildEntrySignalCandidate();
  const result = computeBreakoutEntrySignal(candidate, { rsLookbackDays: 1 });
  assert.equal(result.week52.pass, true);
  assert.equal(result.volatility.pass, true);
  assert.equal(result.marketCapOk, true);
  assert.equal(result.pass, true);
});

test('computeBreakoutEntrySignal: 시가총액 미달이면 다른 조건 다 충족해도 pass=false', () => {
  const candidate = buildEntrySignalCandidate({ marcap: MARKET_CAP_FLOOR_WON - 1 });
  const result = computeBreakoutEntrySignal(candidate, { rsLookbackDays: 1 });
  assert.equal(result.marketCapOk, false);
  assert.equal(result.pass, false);
});
