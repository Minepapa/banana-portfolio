// 돌파매매(추세추종) 전략 신호 계산 — 순수 함수 (2026-09-12, 깡토 철학+KIS 공식
// 프리셋 기반 설계). 매수신호 = 52주 신고가 AND 변동성확장(VCP식) AND 상대강도(RS)
// AND 시가총액 하한 — 네 조건 전부 AND(§8: 근거있는 조합만, 각 조건이 "진짜 돌파"를
// 다른 각도에서 확인하는 관계라 임의조합이 아님, Log/Implementation 참고).
import { mean, sampleVariance } from './stats.mjs';

export const MARKET_CAP_FLOOR_WON = 1_000_000_000_000; // 1조원(오너 확정, 2026-09-12)
// 상대강도(RS) 기본 비교 구간 — 원래 breakout-simulator.mjs에만 있고 이 파일의
// computeBreakoutEntrySignal은 별도로 리터럴 60을 하드코딩하고 있었다(2026-09-15
// 코드리뷰 LOW 지적 — 같은 숫자가 두 곳에 따로 있어, 한쪽만 바꾸면 백테스트와
// 실전(daily-breakout-signal-scan.mjs, rsLookbackDays 미전달로 이 기본값에 의존)이
// 에러 없이 조용히 갈라질 수 있었음). 단일 진실소스로 여기로 옮기고
// breakout-simulator.mjs는 이 값을 재수출(하위호환 — 기존 import 경로 안 깨짐).
export const RS_LOOKBACK_DAYS = 60;
// VCP(변동성확장) 기본 파라미터 — isVolatilityExpansionBreakout·computeVcpReadiness
// 양쪽이 각자 리터럴 기본값을 따로 들고 있었다(2026-09-15 코드리뷰 MEDIUM 지적 —
// RS_LOOKBACK_DAYS와 동일 클래스: 한쪽만 튜닝하면 라이브와 프리뷰가 조용히
// 갈라짐). 단일 진실소스로 승격.
export const VCP_LOOKBACK_DAYS = 10;
export const VCP_MARGIN_RATIO = 1.1;

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

// vol(rollingVolatility 결과) 시리즈에서 endIdx 지점이 "그 지점을 포함한 직전
// lookbackDays 구간 중 최저 변동성 대비 marginRatio 이내"인지 판정하는 공유
// 헬퍼(2026-09-15 코드리뷰 MEDIUM 지적으로 추출) — isVolatilityExpansionBreakout와
// computeVcpReadiness가 이 판정 로직 6줄을 각각 복제해 갖고 있었는데, 둘의 유일한
// 차이(라이브="오늘 이전"=vol.length-2, 프리뷰="오늘까지 확정된 마지막"=
// vol.length-1)가 슬라이스 산술 안에 암묵적으로 숨어 있어 실제로 하루 밀리는
// 버그가 나서도 저자·테스트 양쪽이 못 잡았다(실측: 랜덤워크 3만건 비교 시 2.41%
// 불일치 — 전부 "라이브 기준 조용함인데 프리뷰가 미준비로 오판"방향, 거짓
// "준비됨"은 구조적으로 불가능하지만 그래도 실제 회귀였음). endIdx를 인자로
// 받게 해 그 하루 차이를 슬라이스 산술이 아니라 호출부의 숫자 하나로 명시한다.
function isQuietAt(vol, endIdx, lookbackDays, marginRatio) {
  const current = vol[endIdx];
  const window = vol.slice(endIdx - lookbackDays + 1, endIdx + 1); // current 자신을 포함한 최근 lookbackDays개
  if (current == null || window.length < lookbackDays || window.some((v) => v == null)) return null;
  const minVol = Math.min(...window);
  return { quiet: current <= minVol * marginRatio, currentVol: current, minVol };
}

// 변동성확장(변동성 수축 후 돌파, VCP식) — KIS 공식 프리셋 strategy_08_volatility의
// 개념을 가져오되 구현을 하나 고쳤다: 원본은 "당일 포함 롤링변동성"을 그대로
// "현재 변동성"으로 써서 최근 최저치와 비교하는데, 이러면 당일 돌파(예: +3%)
// 자체가 그 롤링윈도우에 들어가 즉시 변동성을 끌어올려 버려 "조용하다가 오늘
// 터진" 진짜 돌파일수록 오히려 조건을 통과 못 하는 역설이 생긴다(직접 검증:
// 평상시 일간 변동폭이 아주 작을 때(0.1%대) +3% 돌파는 통과율 0%, 평상시
// 변동폭이 이미 2%대로 커야 통과함 — VCP의 취지와 반대). 그래서 "조용한 상태"는
// 어제까지의 변동성으로 측정하고, 오늘의 급등은 별도로 확인한다.
export function isVolatilityExpansionBreakout(closes, { lookbackDays = VCP_LOOKBACK_DAYS, breakoutPct = 3.0, marginRatio = VCP_MARGIN_RATIO } = {}) {
  const returns = computeDailyReturns(closes);
  const vol = rollingVolatility(returns, lookbackDays);
  if (vol.length < lookbackDays + 1) return { pass: false, reason: '데이터 부족' };
  const quiet = isQuietAt(vol, vol.length - 2, lookbackDays, marginRatio); // vol.length-2 = "오늘(closes 마지막) 이전"까지의 변동성
  if (!quiet) return { pass: false, reason: '변동성 계산 불가' };
  const prevClose = closes[closes.length - 2];
  const currentClose = closes[closes.length - 1];
  if (!(prevClose > 0)) return { pass: false, reason: '전일 종가 없음' };
  const changePct = (currentClose / prevClose - 1) * 100;
  const pass = quiet.quiet && changePct >= breakoutPct;
  return { pass, priorVol: quiet.currentVol, minVol: quiet.minVol, changePct };
}

// VCP "준비도"(2026-09-15, breakout-watchlist-preview.mjs 전용) — 위
// isVolatilityExpansionBreakout는 "오늘 종가"가 있어야 changePct까지 판정할 수
// 있는데, 아침 워치리스트 프리뷰는 장 시작 전이라 오늘 종가를 모른다(오늘 종가를
// 알아야만 완전 판정 가능한 조건은 이 함수로 우회할 수 없음 — 추정 안 함 원칙).
// 대신 "조용함"(변동성 수축) 절반만 어제까지의 데이터로 미리 확인할 수 있다 —
// closes의 마지막 값(전일 종가)까지 반영된 최신 변동성이 그 자신을 포함한 직전
// lookbackDays 구간의 최저 변동성 대비 marginRatio 이내면, 오늘 breakoutPct
// 이상만 오르면 VCP 조건 자체는 통과할 "준비된" 상태라는 뜻.
// isVolatilityExpansionBreakout와 endIdx가 하루 어긋나는 이유: 그 함수는 "closes
// 마지막 = 오늘(미확정)"을 전제해 vol.length-2(오늘 이전)를 보지만, 이 함수는
// "closes 마지막 = 어제(확정)"를 전제해 vol.length-1(어제 자신까지 포함)을 본다.
export function computeVcpReadiness(closes, { lookbackDays = VCP_LOOKBACK_DAYS, marginRatio = VCP_MARGIN_RATIO } = {}) {
  const returns = computeDailyReturns(closes);
  const vol = rollingVolatility(returns, lookbackDays);
  const quiet = isQuietAt(vol, vol.length - 1, lookbackDays, marginRatio); // vol.length-1 = "어제(closes 마지막)까지 확정된" 변동성 자신을 포함
  if (!quiet) return null;
  return { ready: quiet.quiet, currentVol: quiet.currentVol, minVol: quiet.minVol };
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

// 상대강도(RS) — 다구간 가중평균 버전(2026-09-15, 오너 지적 대응). 단일 시점(예:
// "정확히 60거래일 전") 비교는 그 하루가 우연히 급등/급락한 날이면 지표 전체가
// 흔들리는 약점이 있다(단일 앵커 취약성) — IBD RS Rating의 취지(최근 분기 비중을
// 높이되 여러 구간을 섞어 노이즈를 평균으로 죽임)를 periods 배열로 일반화한다.
// periods: [{days, weight}, ...] — 각 구간을 computeRelativeStrength와 동일한 방식
// (그 구간 시작일 대비 현재까지 수익률차)으로 계산한 뒤 weight 가중평균(자동 정규화,
// 합이 1이 아니어도 됨). 구간 중 하나라도 데이터 부족(null)이면 전체 null(부분 추정
// 안 함 — 프로젝트 "폴백 없음" 원칙). periods가 1개([{days:60,weight:1}])면
// computeRelativeStrength(., ., 60)과 정확히 동일한 값(하위호환 확인용).
//
// ⚠️ null(데이터 부족)과 설정 오류를 구분(2026-09-15 코드리뷰 MEDIUM 지적 3건 반영) —
// periods가 빈 배열이거나 weight가 유한한 양수가 아니면 **즉시 throw**한다. 이전엔
// 둘 다 null을 반환해서 "데이터가 아직 안 쌓인 것"과 "호출측이 빈 배열/오타
// weight를 넘긴 프로그래밍 오류"를 구분할 수 없었다 — 후자는 백테스트가 거래
// 0건으로 조용히 끝나버리는데 원인을 알 방법이 없었다(project convention:
// "조용한 폴백 금지, throw+로그로 즉시 노출" — feedback-no-silent-fallback). 음수
// weight도 막는다(볼록결합이 깨져 가중평균이 아니라 구간값 범위 밖으로 나가는
// 외삽이 됨 — 코드리뷰 실측 확인: {days:1,w:2},{days:2,w:-1}처럼 두 구간 다
// 양수인데 결과가 음수로 나옴).
export function computeRelativeStrengthMultiPeriod(stockCloses, benchmarkCloses, periods) {
  if (!Array.isArray(periods) || !periods.length) {
    throw new Error('computeRelativeStrengthMultiPeriod: periods는 비어있지 않은 배열이어야 함');
  }
  let weightedSum = 0;
  let weightTotal = 0;
  for (const { days, weight } of periods) {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`computeRelativeStrengthMultiPeriod: weight는 유한한 양수여야 함(받은 값: ${weight}, days: ${days})`);
    }
    const rs = computeRelativeStrength(stockCloses, benchmarkCloses, days);
    if (rs == null) return null;
    weightedSum += rs * weight;
    weightTotal += weight;
  }
  return weightedSum / weightTotal;
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
  // opts.rsPeriods가 있으면 다구간 가중평균(신규 비교용), 없으면 기존 단일시점(기본값
  // 유지 — 하위호환, 기존 호출측/테스트 회귀 없음).
  const relativeStrength = opts.rsPeriods
    ? computeRelativeStrengthMultiPeriod(candidate.closes, candidate.benchmarkCloses, opts.rsPeriods)
    : computeRelativeStrength(candidate.closes, candidate.benchmarkCloses, opts.rsLookbackDays ?? RS_LOOKBACK_DAYS);
  const marketCapOk = passesMarketCapFloor(candidate.marcap, opts.marketCapFloor);
  const pass = week52.pass && volatility.pass && passesRelativeStrengthFilter(relativeStrength) && marketCapOk;
  return { pass, week52, volatility, relativeStrength, marketCapOk };
}
