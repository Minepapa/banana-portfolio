// 돌파매매(추세추종) 전략 신호 계산 — 순수 함수 (2026-09-12, 깡토 철학+KIS 공식
// 프리셋 기반 설계). 매수신호 = 52주 신고가 AND 변동성확장(VCP식) AND 상대강도(RS)
// AND 시가총액 하한 — 네 조건 전부 AND(§8: 근거있는 조합만, 각 조건이 "진짜 돌파"를
// 다른 각도에서 확인하는 관계라 임의조합이 아님, Log/Implementation 참고).
import { mean, sampleVariance } from './stats.mjs';

export const MARKET_CAP_FLOOR_WON = 1_000_000_000_000; // 1조원(오너 확정, 2026-09-12)

// closes(오름차순, 마지막이 최신)에서 일별 수익률 배열(길이 n-1) 산출. 0 이하 종가는
// null(추정 안 함 — 상장폐지 직전 이상치 등 방어).
export function computeDailyReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    out.push(prev > 0 ? closes[i] / prev - 1 : null);
  }
  return out;
}

// returns(computeDailyReturns 결과)의 롤링 표준편차 시리즈 — 인덱스 i는
// returns[i-lookbackDays+1..i] 구간의 표준편차(표본, n-1분모). 윈도우 안에 null이
// 하나라도 있으면 그 지점은 null(추정 안 함). 앞부분(윈도우 미충족)도 null.
export function rollingVolatility(returns, lookbackDays) {
  const out = new Array(returns.length).fill(null);
  for (let i = lookbackDays - 1; i < returns.length; i++) {
    const window = returns.slice(i - lookbackDays + 1, i + 1);
    if (window.some((r) => r == null)) continue;
    const variance = sampleVariance(window);
    out[i] = variance == null ? null : Math.sqrt(variance);
  }
  return out;
}

// 변동성확장(변동성 수축 후 돌파, VCP식) — KIS 공식 프리셋 strategy_08_volatility의
// 개념을 가져오되 구현을 하나 고쳤다: 원본은 "당일 포함 롤링변동성"을 그대로
// "현재 변동성"으로 써서 최근 최저치와 비교하는데, 이러면 당일 돌파(예: +3%)
// 자체가 그 롤링윈도우에 들어가 즉시 변동성을 끌어올려 버려 "조용하다가 오늘
// 터진" 진짜 돌파일수록 오히려 조건을 통과 못 하는 역설이 생긴다(직접 검증:
// 평상시 일간 변동폭이 아주 작을 때(0.1%대) +3% 돌파는 통과율 0%, 평상시
// 변동폭이 이미 2%대로 커야 통과함 — VCP의 취지와 반대). 그래서 "조용한 상태"는
// 어제까지의 변동성으로 측정하고, 오늘의 급등은 별도로 확인한다.
export function isVolatilityExpansionBreakout(closes, { lookbackDays = 10, breakoutPct = 3.0, marginRatio = 1.1 } = {}) {
  const returns = computeDailyReturns(closes);
  const vol = rollingVolatility(returns, lookbackDays);
  if (vol.length < lookbackDays + 1) return { pass: false, reason: '데이터 부족' };
  const priorVol = vol[vol.length - 2]; // 어제까지의 변동성(오늘 수익률 미포함)
  const window = vol.slice(-(lookbackDays + 1), -1);
  if (priorVol == null || window.some((v) => v == null)) return { pass: false, reason: '변동성 계산 불가' };
  const minVol = Math.min(...window);
  const prevClose = closes[closes.length - 2];
  const currentClose = closes[closes.length - 1];
  if (!(prevClose > 0)) return { pass: false, reason: '전일 종가 없음' };
  const changePct = (currentClose / prevClose - 1) * 100;
  const pass = priorVol <= minVol * marginRatio && changePct >= breakoutPct;
  return { pass, priorVol, minVol, changePct };
}

// 박스권(가격범위) 기반 변동성수축 — VCP의 더 문자 그대로의 근사(2026-09-13, 오너
// 지적으로 재검토). 위 isVolatilityExpansionBreakout는 "하루 등락폭의 표준편차"라
// 완만하게 계속 오르는 종목도 "조용함"으로 잡을 수 있다(방향 무관) — 실측 확인.
// 원래 VCP(Minervini) 개념은 파동별 되돌림이 점점 얕아지는 다중파동 패턴이지만(예:
// 18%→12%→6% 수축), 그 전체를 재현하려면 국지적 고점/저점 탐지가 필요해 더 큰
// 작업이다 — 1차 근사로 "최근 구간 전체가 얼마나 좁은 박스 안에 있었는지"(고가-저가
// 범위 ÷ 평균종가)만 본다. 이건 방향과 무관하지 않다 — 완만한 상승추세는 범위 자체가
// 넓어지므로 자연히 걸러진다. 오늘 급등이 범위 계산에 들어가 자기 자신을 왜곡하지
// 않도록(위와 같은 원리) 어제까지의 구간만 본다.
export function isPriceRangeConsolidationBreakout(closes, highs, lows, { lookbackDays = 20, rangeThresholdPct = 15, breakoutPct = 3.0 } = {}) {
  if (closes.length < lookbackDays + 1) return { pass: false, reason: '데이터 부족' };
  const priorHighs = highs.slice(-(lookbackDays + 1), -1);
  const priorLows = lows.slice(-(lookbackDays + 1), -1);
  const priorCloses = closes.slice(-(lookbackDays + 1), -1);
  if (priorHighs.some((h) => h == null) || priorLows.some((l) => l == null)) return { pass: false, reason: '고가/저가 없음' };
  const rangeHigh = Math.max(...priorHighs);
  const rangeLow = Math.min(...priorLows);
  const avgClose = mean(priorCloses);
  if (!(avgClose > 0)) return { pass: false, reason: '평균가 계산 불가' };
  const rangePct = ((rangeHigh - rangeLow) / avgClose) * 100;
  const prevClose = closes[closes.length - 2];
  const currentClose = closes[closes.length - 1];
  if (!(prevClose > 0)) return { pass: false, reason: '전일 종가 없음' };
  const changePct = (currentClose / prevClose - 1) * 100;
  const pass = rangePct <= rangeThresholdPct && changePct >= breakoutPct;
  return { pass, rangePct, changePct };
}

// 52주 신고가 돌파 — highs(오름차순, 당일 포함)에서 당일을 제외한 직전 lookbackDays
// 거래일의 최고가를 구하고, 당일 "종가"가 그 값(+marginPct)을 넘는지 확인. 당일 고가가
// 아니라 종가로 판정하는 이유: 장중 위꼬리로 살짝 찍고 도로 내려온 가짜돌파를 걸러내는
// 확정신호 원칙(깡토 철학의 "의미있는 구간" — 장 마감까지 버틴 돌파만 인정).
export function is52WeekHighBreakout(highs, currentClose, { lookbackDays = 252, marginPct = 0 } = {}) {
  if (highs.length < lookbackDays + 1) return { pass: false, reason: '데이터 부족' };
  const priorHighs = highs.slice(-(lookbackDays + 1), -1);
  const priorHigh = Math.max(...priorHighs);
  if (!(priorHigh > 0) || currentClose == null) return { pass: false, reason: '가격 없음' };
  const threshold = priorHigh * (1 + marginPct / 100);
  return { pass: currentClose > threshold, priorHigh, currentClose };
}

// 상대강도(RS) — lookbackDays 구간 동안 "종목 수익률 - 벤치마크(코스피) 수익률"(%p).
// "시장 RS 이상"(오너 확정)은 이 값이 0 이상인지로 판정한다 — 지수 자체와 비교해
// 그 지수보다 더 오르거나 덜 빠졌는지를 보는 것이 IBD RS Rating(전체 유니버스 백분위
// 랭킹)의 핵심 취지를 단순화한 것. 전체 유니버스 백분위 랭킹은 별도 인프라(전 종목
// 순위화)가 필요해 더 정교한 버전은 추후 보완 과제로 남긴다(Log/Implementation 참고).
export function computeRelativeStrength(stockCloses, benchmarkCloses, lookbackDays) {
  if (stockCloses.length < lookbackDays + 1 || benchmarkCloses.length < lookbackDays + 1) return null;
  const stockBase = stockCloses[stockCloses.length - 1 - lookbackDays];
  const benchBase = benchmarkCloses[benchmarkCloses.length - 1 - lookbackDays];
  if (!(stockBase > 0) || !(benchBase > 0)) return null;
  const stockReturn = stockCloses[stockCloses.length - 1] / stockBase - 1;
  const benchReturn = benchmarkCloses[benchmarkCloses.length - 1] / benchBase - 1;
  return (stockReturn - benchReturn) * 100;
}

export function passesRelativeStrengthFilter(relativeStrength) {
  return relativeStrength != null && relativeStrength >= 0;
}

export function passesMarketCapFloor(marcap, floorWon = MARKET_CAP_FLOOR_WON) {
  return marcap != null && marcap >= floorWon;
}

// 네 조건 종합 — 하나라도 데이터 부족/미충족이면 매수 신호 아님(폴백 없음).
// candidate: { closes, highs, lows, benchmarkCloses, marcap }(closes/highs/lows는
// 오름차순, 마지막이 오늘. lows는 consolidationMethod='range'일 때만 필요).
// opts.consolidationMethod: 'stddev'(기본, 기존 isVolatilityExpansionBreakout) |
// 'range'(신규, isPriceRangeConsolidationBreakout — 박스권 근사, 2026-09-13 비교용).
export function computeBreakoutEntrySignal(candidate, opts = {}) {
  const week52 = is52WeekHighBreakout(candidate.highs, candidate.closes[candidate.closes.length - 1], opts.week52High);
  const volatility = opts.consolidationMethod === 'range'
    ? isPriceRangeConsolidationBreakout(candidate.closes, candidate.highs, candidate.lows, opts.volatility)
    : isVolatilityExpansionBreakout(candidate.closes, opts.volatility);
  const relativeStrength = computeRelativeStrength(candidate.closes, candidate.benchmarkCloses, opts.rsLookbackDays ?? 60);
  const marketCapOk = passesMarketCapFloor(candidate.marcap, opts.marketCapFloor);
  const pass = week52.pass && volatility.pass && passesRelativeStrengthFilter(relativeStrength) && marketCapOk;
  return { pass, week52, volatility, relativeStrength, marketCapOk };
}
