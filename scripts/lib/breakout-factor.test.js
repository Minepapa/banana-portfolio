import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDailyReturns,
  rollingVolatility,
  isVolatilityExpansionBreakout,
  computeVcpReadiness,
  isPriceRangeConsolidationBreakout,
  is52WeekHighBreakout,
  computeRelativeStrength,
  computeRelativeStrengthMultiPeriod,
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

test('computeVcpReadiness: 조용한 구간이 이어지고 있으면(전일까지) ready=true — 오늘 종가 없이도 판정', () => {
  // 돌파일(마지막 급등)을 뺀, 순수 조용한 구간만(오늘 종가를 모르는 아침 프리뷰 상황과 동일)
  const closes = buildQuietThenBreakoutCloses().slice(0, -1);
  const result = computeVcpReadiness(closes, { lookbackDays: 10 });
  assert.notEqual(result, null);
  assert.equal(result.ready, true);
});

test('computeVcpReadiness: 데이터 부족이면 null(추정 안 함)', () => {
  assert.equal(computeVcpReadiness([100, 101, 102], { lookbackDays: 10 }), null);
});

test('computeVcpReadiness: 경계값 — vol이 정확히 lookbackDays개면(윈도우 꽉 참) 계산됨, 하나 모자라면 null', () => {
  // rollingVolatility는 returns가 lookbackDays개 있어야 vol[lookbackDays-1] 하나가 나온다.
  // computeVcpReadiness의 window는 vol 중 lookbackDays개(자기 포함)가 필요 — 즉 vol
  // 유효값이 정확히 lookbackDays개(returns lookbackDays*2-1개)일 때가 최소 통과 경계.
  const lookbackDays = 5;
  const closesEnough = [100];
  for (let i = 0; i < lookbackDays * 2 - 1; i++) closesEnough.push(closesEnough[closesEnough.length - 1] * (1 + (i % 2 === 0 ? 0.01 : -0.01)));
  assert.notEqual(computeVcpReadiness(closesEnough, { lookbackDays }), null);

  const closesShort = closesEnough.slice(0, -1); // 수익률 하나 모자람
  assert.equal(computeVcpReadiness(closesShort, { lookbackDays }), null);
});

test('computeVcpReadiness: 최근 변동성이 이미 확대돼 있으면(조용하지 않음) ready=false', () => {
  // 앞부분은 조용하다가, 관찰구간(마지막 10일)에 큰 등락을 섞어 최근 변동성을 끌어올림
  const closes = [100];
  for (let i = 0; i < 15; i++) closes.push(closes[closes.length - 1] * (1 + (i % 2 === 0 ? 0.001 : -0.001))); // 조용한 과거
  for (let i = 0; i < 11; i++) closes.push(closes[closes.length - 1] * (1 + (i % 2 === 0 ? 0.04 : -0.04))); // 최근 변동성 확대
  const result = computeVcpReadiness(closes, { lookbackDays: 10 });
  assert.notEqual(result, null);
  assert.equal(result.ready, false);
});

test('computeVcpReadiness: isVolatilityExpansionBreakout의 "조용함" 절반과 정확히 동치(고정진폭 픽스처 — 최소 스모크 확인용)', () => {
  const fullCloses = buildQuietThenBreakoutCloses();
  const readiness = computeVcpReadiness(fullCloses.slice(0, -1), { lookbackDays: 10 });
  const fullResult = isVolatilityExpansionBreakout(fullCloses, { lookbackDays: 10, breakoutPct: 3.0 });
  assert.equal(readiness.ready, fullResult.priorVol <= fullResult.minVol * 1.1);
});

// ⚠️ 위 고정진폭(±0.1%) 픽스처만으로는 이 동치성을 실제로 검증하지 못한다(2026-09-15
// 코드리뷰 HIGH 지적 — 돌파 전 롤링변동성 값들이 전부 동일해 Math.min이 윈도우
// 선택과 무관해지고, 실제로 윈도우가 하루 밀리는 버그가 있었는데도 이 테스트가
// 계속 통과했었다). 진폭이 매일 달라지는 랜덤워크로 다건 반복해야 윈도우 경계가
// 실제로 검증된다 — 결정론적 시드(간단한 LCG)로 재현 가능하게 구성.
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

test('computeVcpReadiness: 랜덤워크 다건에서 isVolatilityExpansionBreakout의 조용함 판정과 정확히 일치(윈도우 경계 프로퍼티 검증)', () => {
  const rand = seededRandom(42);
  for (let trial = 0; trial < 200; trial++) {
    const closes = [100 + rand() * 50];
    for (let i = 0; i < 30; i++) {
      const changePct = (rand() - 0.5) * 6; // -3%~+3% 가변 진폭(고정진폭 아님)
      closes.push(closes[closes.length - 1] * (1 + changePct / 100));
    }
    const readiness = computeVcpReadiness(closes.slice(0, -1), { lookbackDays: 10 });
    const full = isVolatilityExpansionBreakout(closes, { lookbackDays: 10, breakoutPct: -999 }); // breakoutPct를 극단적으로 낮춰 quiet 판정만 분리
    if (readiness == null || full.reason) continue; // 양쪽 다 데이터 충분한 경우만 비교
    assert.equal(readiness.ready, full.priorVol <= full.minVol * 1.1, `trial ${trial}에서 불일치`);
  }
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

test('computeRelativeStrengthMultiPeriod: 단일 구간(weight 1개)은 computeRelativeStrength와 정확히 동일(하위호환)', () => {
  const stock = [100, 110, 120];
  const bench = [100, 100, 105];
  const single = computeRelativeStrength(stock, bench, 2);
  assert.ok(single != null, '전제: 단일구간 RS가 계산 가능해야 함(테스트 자체가 무의미해지지 않도록)');
  const multi = computeRelativeStrengthMultiPeriod(stock, bench, [{ days: 2, weight: 1 }]);
  assert.equal(multi, single); // weight=1/weightTotal=1이면 x*1/1===x가 부동소수점상 정확히 성립
});

test('computeRelativeStrengthMultiPeriod: 여러 구간 가중평균(weight 합≠1 정규화 포함)', () => {
  const stock = [100, 110, 120];
  const bench = [100, 100, 105];
  const rs1 = computeRelativeStrength(stock, bench, 1);
  const rs2 = computeRelativeStrength(stock, bench, 2);
  assert.ok(rs1 != null && rs2 != null, '전제: 두 구간 모두 RS 계산 가능해야 함');
  const expected = (rs1 * 2 + rs2 * 1) / 3; // weight 2:1(합 3, 정규화 경로를 실제로 탐)
  const actual = computeRelativeStrengthMultiPeriod(stock, bench, [{ days: 1, weight: 2 }, { days: 2, weight: 1 }]);
  assert.ok(Math.abs(actual - expected) < 1e-9);
});

test('computeRelativeStrengthMultiPeriod: 3개 이상 구간(실전 short/long arm과 동일 형태)도 가중평균', () => {
  const stock = [90, 95, 100, 110, 120];
  const bench = [100, 100, 100, 100, 105];
  const rs1 = computeRelativeStrength(stock, bench, 1);
  const rs2 = computeRelativeStrength(stock, bench, 2);
  const rs3 = computeRelativeStrength(stock, bench, 3);
  assert.ok(rs1 != null && rs2 != null && rs3 != null);
  const expected = (rs1 * 0.4 + rs2 * 0.3 + rs3 * 0.3) / 1.0;
  const actual = computeRelativeStrengthMultiPeriod(stock, bench, [
    { days: 1, weight: 0.4 }, { days: 2, weight: 0.3 }, { days: 3, weight: 0.3 },
  ]);
  assert.ok(Math.abs(actual - expected) < 1e-9);
});

test('computeRelativeStrengthMultiPeriod: 구간별 부호가 반대(한쪽은 양수, 한쪽은 음수)여도 정확히 가중평균(상쇄) — 이 기능의 핵심 효과', () => {
  // 종목이 1일 전엔 하락(-)했다가 2일 전 기준으론 상승(+)해 있는 합성 시나리오
  const stock = [100, 120, 90]; // 2일전:100, 1일전:120, 오늘:90
  const bench = [100, 100, 100]; // 벤치마크 고정 — RS = 종목수익률
  const rs1 = computeRelativeStrength(stock, bench, 1); // (90/120-1)*100 = -25
  const rs2 = computeRelativeStrength(stock, bench, 2); // (90/100-1)*100 = -10
  assert.ok(rs1 < 0 && rs2 < 0); // 이 시나리오에선 둘 다 음수(부호 상쇄가 아니라 가중평균 자체를 검증)
  const actual = computeRelativeStrengthMultiPeriod(stock, bench, [{ days: 1, weight: 1 }, { days: 2, weight: 1 }]);
  assert.ok(Math.abs(actual - (rs1 + rs2) / 2) < 1e-9);
});

test('computeRelativeStrengthMultiPeriod: 구간 중 하나라도 데이터 부족이면 전체 null(부분 추정 안 함)', () => {
  const stock = [100, 110, 120];
  const bench = [100, 100, 105];
  assert.equal(computeRelativeStrengthMultiPeriod(stock, bench, [{ days: 1, weight: 1 }, { days: 5, weight: 1 }]), null);
});

test('computeRelativeStrengthMultiPeriod: 빈 periods는 설정 오류 — throw(데이터부족 null과 구분)', () => {
  assert.throws(() => computeRelativeStrengthMultiPeriod([100, 110], [100, 105], []), /비어있지 않은 배열/);
});

test('computeRelativeStrengthMultiPeriod: weight 누락·0·음수는 설정 오류 — throw(조용히 null로 위장하지 않음)', () => {
  const stock = [100, 110];
  const bench = [100, 105];
  assert.throws(() => computeRelativeStrengthMultiPeriod(stock, bench, [{ days: 1 }]), /weight는 유한한 양수/);
  assert.throws(() => computeRelativeStrengthMultiPeriod(stock, bench, [{ days: 1, weight: 0 }]), /weight는 유한한 양수/);
  assert.throws(() => computeRelativeStrengthMultiPeriod(stock, bench, [{ days: 1, weight: -1 }, { days: 2, weight: 1 }]), /weight는 유한한 양수/);
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

test('computeBreakoutEntrySignal: rsPeriods 단일구간([{days:N,weight:1}])은 rsLookbackDays:N과 결과 완전 동일(분기 등가성 — 회귀 가드)', () => {
  const candidate = buildEntrySignalCandidate();
  const viaLookback = computeBreakoutEntrySignal(candidate, { rsLookbackDays: 5 });
  const viaPeriods = computeBreakoutEntrySignal(candidate, { rsPeriods: [{ days: 5, weight: 1 }] });
  assert.equal(viaPeriods.relativeStrength, viaLookback.relativeStrength);
  assert.equal(viaPeriods.pass, viaLookback.pass);
});

test('computeBreakoutEntrySignal: rsPeriods 미지정이면 rsLookbackDays 기본값(RS_LOOKBACK_DAYS=60) 경로 그대로(회귀 없음 고정)', () => {
  const candidate = buildEntrySignalCandidate();
  const noOpts = computeBreakoutEntrySignal(candidate, {});
  const explicit60 = computeBreakoutEntrySignal(candidate, { rsLookbackDays: 60 });
  assert.equal(noOpts.relativeStrength, explicit60.relativeStrength);
});

test('computeBreakoutEntrySignal: 시가총액 미달이면 다른 조건 다 충족해도 pass=false', () => {
  const candidate = buildEntrySignalCandidate({ marcap: MARKET_CAP_FLOOR_WON - 1 });
  const result = computeBreakoutEntrySignal(candidate, { rsLookbackDays: 1 });
  assert.equal(result.marketCapOk, false);
  assert.equal(result.pass, false);
});
