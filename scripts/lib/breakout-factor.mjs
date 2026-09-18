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
// RS 앵커 스무딩 실전 배선값(2026-09-15, 오너 확정) — daily-breakout-signal-scan.mjs
// 가 실제로 쓰는 값을 여기 단일 진실소스로 둔다(2026-09-15 코드리뷰 HIGH 지적 —
// 처음엔 그 잡 파일 안에만 상수가 있어서, --rsAnchorSmoothDays 플래그 없이 돌리는
// 모든 백테스트(run-breakout-backtest.mjs 기본 baseline)가 실전과 다른 전략을
// 검증하는 상태가 조용히 생길 뻔했다 — RS_LOOKBACK_DAYS를 이 파일로 승격시킨 것과
// 동일 클래스의 재발). 백테스트 결과는 기존(단일시점) 대비 연환산 +0.2%p·샤프+0.011로
// 거래 ~1400건 기준 노이즈 수준의 개선이었다 — Zeus는 "기존 유지"를 권고했으나 오너가
// "그래도 5일평균으로 배선"을 명시 확정(2026-09-15)해 배선함
// (Log/Implementation/2026-09-15-RS앵커스무딩-백테스트비교.md 참고).
export const RS_ANCHOR_SMOOTH_DAYS = 5;
// 거래량 확인(볼륨 컨펌) 기본 파라미터(2026-09-19, 오너 지시 — 코드리뷰가 지적한
// "가격 돌파에 거래량 확인이 없다"는 공백 보강). 20일 창은 유동성 사전필터
// (breakout-simulator.mjs LIQUIDITY_FLOOR_WON, computeAvgTradingValue)가 이미 쓰는
// 창과 동일하게 맞춰 세 번째 다른 창을 새로 만들지 않는다(일관성). 배수(1.5)는
// IBD/미너비니류 돌파매매가 통상 요구하는 "평균대비 +40~50%"(=1.4~1.5배) 문턱과
// 일치하는 값으로 오너가 확정.
//
// ⚠️ 호출부가 candidate.volumes/todayVolume을 안 넘기면 이 조건 자체가 평가되지
// 않고 조용히 통과한다(하위호환 — opt-in 설계). 2026-09-19 백테스트(2014~2026,
// 승률+1.6%p·샤프 0.66→0.70·MDD 25.1%→19.5% 개선 확인, Log/Implementation/
// 2026-09-19-돌파매매-거래량확인·RS문턱-백테스트비교.md 참고)로 실전 배선
// 확정(daily-breakout-signal-scan.mjs) — 오너 승인.
export const VOLUME_LOOKBACK_DAYS = 20;
export const VOLUME_CONFIRMATION_MULTIPLIER = 1.5;
// ⚠️ 미검증 가정(코드리뷰 Open Question, 2026-09-19) — 이 조건은 서로 다른 소스의
// 거래량을 직접 비율 비교한다: 분모(평균)는 FinanceDataReader 경유 KRX 일별
// Volume(캐시), 분자(오늘)는 KIS 라이브 acml_vol(15:32 시점 누적치). 두 소스의
// "거래량" 정의(시간외 포함 여부 등)가 정확히 같은지 이번 세션에서 확정 못 했다 —
// 다르다면 문턱(1.5배)이 실효적으로 살짝 어긋날 수 있음(fail-closed 방향으로
// 추정: 유효 매수를 가끔 놓치는 쪽, 반대로 가짜통과가 느는 방향은 아닐 것). 다음
// 거래일 캐시 갱신 후 같은 종목의 acml_vol(15:32)과 캐시 Volume을 직접 대조하면
// 확인 가능 — 필요해지면.

// RS 절대 문턱(2026-09-19, 오너 지적 — "RS≥0은 너무 열려있다") — passesRelativeStrengthFilter의
// minRs 기본값(0)을 이 값으로 실전 배선(daily-breakout-signal-scan.mjs). 후보군
// 크기가 매일 들쭉날쭉해 순위(백분위) 기반 문턱은 후보가 적은 날 품질보장이 안
// 된다고 판단해 기각(논의 경위: Log/Implementation/2026-09-19-돌파매매-거래량확인
// ·RS문턱-백테스트비교.md) — 절대 문턱만 채택. 0/3/5/8 백테스트 비교(2014~2026)
// 결과 8이 가장 나은 연환산·샤프를 냄(같은 조합 내에서 일관되게 개선) — 오너 확정.
export const MIN_RELATIVE_STRENGTH = 8;

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

// 상대강도(RS) — 앵커 스무딩 버전(2026-09-15, 오너 재지적 대응). 아래
// computeRelativeStrengthMultiPeriod("여러 다른 기간을 섞는다")와는 다른 접근 —
// 그 방식은 60일·126일·252일처럼 서로 다른 "길이의 구간"을 섞어 정상적으로 평가한
// 결과 이 전략에서는 오히려 성과를 깎는 것으로 실측됨(2026-09-15 백테스트,
// Log/Implementation 참고). 이건 구간 길이(lookbackDays=60)는 그대로 두고, 대신
// 비교 기준점 한 곳("60거래일 전 그 하루")만 그 날 근처 며칠의 **평균**으로
// 대체한다 — "60거래일 전이라는 시점 자체가 하필 급등/급락일이면 지표가
// 흔들린다"는 오너의 원래 우려에 더 직접적으로 대응(다구간 블렌드는 서로 다른
// 모멘텀 시간축을 섞어버려 원래 취지에서 벗어났었다는 반성).
//
// ⚠️ 윈도우를 앵커일 **중심으로 대칭 배치**한다(2026-09-15 코드리뷰 HIGH 지적으로
// 수정 — 최초 버전은 앵커일부터 과거 쪽으로만 뻗는 후행 윈도우였는데, 이러면
// 기준점의 무게중심이 lookbackDays+(anchorSmoothDays-1)/2로 밀려서 "스무딩 효과"와
// "룩백을 며칠 늘린 효과"가 뒤섞인다 — 실측: anchorSmoothDays=5는 lookbackDays를
// 62일로 늘린 것과 소수점 셋째 자리까지 거의 동일한 값을 냈다. 이 전략의 후보군이
// 상승추세만 남도록 구성돼 있어(52주 신고가+당일 급등) 이 오염이 RS를 체계적으로
// 부풀리는 방향 편향까지 만든다. 중심정렬이면 대칭이라 이 편향이 없다(홀수
// anchorSmoothDays는 정확히 무게중심=lookbackDays, 짝수는 0.5일 이내 오차 —
// 무시 가능). 앵커일보다 미래(=오늘) 데이터는 여전히 안 쓴다 — 다만 이건 "룩어헤드
// 금지"(미확정 데이터 참조 금지) 때문이 아니라(중심정렬 창의 더 최근 쪽 절반도
// 전부 신호계산 시점에 이미 확정된 과거 데이터라 룩어헤드가 아님) 단순히 "오늘
// 자신을 기준점 계산에 넣지 않는다"는 설계 선택이다(이전 버전 주석의 근거 서술이
// 부정확했음, 코드리뷰 MEDIUM 지적).
export function computeRelativeStrengthSmoothedAnchor(stockCloses, benchmarkCloses, lookbackDays, anchorSmoothDays = 1) {
  if (!Number.isInteger(anchorSmoothDays) || anchorSmoothDays < 1) {
    throw new Error(`computeRelativeStrengthSmoothedAnchor: anchorSmoothDays는 1 이상의 정수여야 함(받은 값: ${anchorSmoothDays})`);
  }
  const half = Math.floor((anchorSmoothDays - 1) / 2); // 짝수 anchorSmoothDays는 과거 쪽에 한 칸 더(오늘 쪽으로 안 치우치게)
  const anchorMean = (closes) => {
    const anchorIdx = closes.length - 1 - lookbackDays; // 기존 단일시점 앵커와 동일 인덱스
    const start = anchorIdx - half;
    const end = start + anchorSmoothDays; // slice 상한(배타적)
    if (start < 0 || end > closes.length - 1) return null; // end<=length-1 → 마지막 포함 인덱스가 "오늘" 전날 이하
    const window = closes.slice(start, end);
    return window.some((c) => c == null) ? null : mean(window);
  };
  const stockBase = anchorMean(stockCloses);
  const benchBase = anchorMean(benchmarkCloses);
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

// minRs 파라미터화(2026-09-19, 오너 지적 — "RS≥0은 너무 열려있다"). 기본값 0은
// 기존 동작 그대로(하위호환·회귀 없음) — 절대 문턱을 몇 %p로 올리는 게 적정한지는
// 백테스트로 정할 대상이라 여기서 임의로 올리지 않는다. 순위(백분위) 기반 대안은
// 오너와 논의 후 기각(후보 수가 적은 날엔 상위%가 품질을 보장 못 함 — 슬롯이
// 이미 RS 내림차순으로 채워지고 있어 "여럿 중 최선"은 별도 게이트 없이도 확보됨,
// 진짜 필요한 건 절대 하한).
export function passesRelativeStrengthFilter(relativeStrength, minRs = 0) {
  return relativeStrength != null && relativeStrength >= minRs;
}

export function passesMarketCapFloor(marcap, floorWon = MARKET_CAP_FLOOR_WON) {
  return marcap != null && marcap >= floorWon;
}

// volumes(오름차순, 마지막=어제 — "오늘"은 포함 안 함, breakout-simulator.mjs의
// computeAvgTradingValue와 동일 원칙: endIndex가 곧 마지막으로 반영할 거래일)에서
// endIndex 포함 최근 days거래일 평균 거래량(주식수). 표본 부족(신규상장 직후 등)이면
// null(추정 안 함) — computeAvgTradingValue와 동일 관용구, 다만 거래대금(종가×거래량)이
// 아니라 순수 거래량이라 "오늘 거래량이 평소 몇 배인지" 비율 비교에 쓴다.
export function computeAvgVolume(volumes, endIndex, days = VOLUME_LOOKBACK_DAYS, minWindowRatio = 0.9) {
  const startIndex = endIndex - days + 1;
  if (startIndex < 0) return null;
  let sum = 0;
  let count = 0;
  for (let i = startIndex; i <= endIndex; i++) {
    if (volumes[i] != null) { sum += volumes[i]; count += 1; }
  }
  if (count < days * minWindowRatio) return null;
  return sum / count;
}

// 거래량 확인 — 오늘 거래량이 평소(어제까지 평균)의 multiplier배 이상인지. 데이터
// 부족(avgVolume 계산 불가) 또는 todayVolume 자체가 없으면 통과 안 시킴(추정 안 함).
export function passesVolumeConfirmation(todayVolume, avgVolume, multiplier = VOLUME_CONFIRMATION_MULTIPLIER) {
  if (todayVolume == null || avgVolume == null || !(avgVolume > 0)) return false;
  return todayVolume >= avgVolume * multiplier;
}

// RS 계산 경로 선택 — opts.rsPeriods(다구간 블렌드) > opts.rsAnchorSmoothDays(앵커
// 스무딩) > 기본(단일시점). 둘 다 opts 미지정(null/undefined) 시 기존과 완전
// 동일(하위호환, 기존 호출측/테스트 회귀 없음) — computeBreakoutEntrySignal에서
// 분리(2026-09-15 코드리뷰 LOW 지적 — 3중 중첩 삼항이라 우선순위가 코드가 아니라
// 주석에만 있었음, RS 방법론이 더 늘어날 걸 대비해 헬퍼로 승격). rsPeriods와
// rsAnchorSmoothDays를 동시에 넘기는 조합은 아직 지원 안 함(rsPeriods 우선).
// ⚠️ `!= null`(truthy 아님) 체크 — 2026-09-15 코드리뷰 MEDIUM 지적: truthy 체크였으면
// rsAnchorSmoothDays=0이나 NaN이 falsy라 조용히 기본 경로로 흡수돼(feedback-no-silent-
// fallback 위반) 호출측 설정 오류가 "baseline과 결과 같네"로만 보이고 원인불명이었다.
// `!= null`로 넘기면 computeRelativeStrengthSmoothedAnchor 자신의 정수·1이상 검증이
// throw하므로 설정 오류가 즉시 드러난다.
function resolveRelativeStrength(closes, benchmarkCloses, opts) {
  if (opts.rsPeriods != null) return computeRelativeStrengthMultiPeriod(closes, benchmarkCloses, opts.rsPeriods);
  const lookbackDays = opts.rsLookbackDays ?? RS_LOOKBACK_DAYS;
  if (opts.rsAnchorSmoothDays != null) return computeRelativeStrengthSmoothedAnchor(closes, benchmarkCloses, lookbackDays, opts.rsAnchorSmoothDays);
  return computeRelativeStrength(closes, benchmarkCloses, lookbackDays);
}

// 네·다섯 조건 종합 — 하나라도 데이터 부족/미충족이면 매수 신호 아님(폴백 없음).
// candidate: { closes, highs, lows, benchmarkCloses, marcap, volumes, todayVolume }
// (closes/highs/lows는 오름차순, 마지막이 오늘. lows는 consolidationMethod='range'일
// 때만 필요. volumes/todayVolume은 opt-in — 2026-09-19 거래량 확인 조건 참고,
// VOLUME_LOOKBACK_DAYS 주석의 하위호환 설명 그대로 candidate.volumes가 없으면 이
// 다섯 번째 조건은 평가되지 않고 조용히 통과한다).
// opts.consolidationMethod: 'stddev'(기본, 기존 isVolatilityExpansionBreakout) |
// 'range'(신규, isPriceRangeConsolidationBreakout — 박스권 근사, 2026-09-13 비교용).
export function computeBreakoutEntrySignal(candidate, opts = {}) {
  const week52 = is52WeekHighBreakout(candidate.highs, candidate.closes[candidate.closes.length - 1], opts.week52High);
  const volatility = opts.consolidationMethod === 'range'
    ? isPriceRangeConsolidationBreakout(candidate.closes, candidate.highs, candidate.lows, opts.volatility)
    : isVolatilityExpansionBreakout(candidate.closes, opts.volatility);
  const relativeStrength = resolveRelativeStrength(candidate.closes, candidate.benchmarkCloses, opts);
  const marketCapOk = passesMarketCapFloor(candidate.marcap, opts.marketCapFloor);
  let volumeOk = true;
  let avgVolume = null;
  if (candidate.volumes != null) {
    // 불변식 가드(2026-09-19 코드리뷰 MEDIUM 지적) — candidate.volumes는 반드시
    // "오늘 제외"(closes보다 정확히 1 짧음)여야 한다. 이걸 안 지키고 오늘을 포함해
    // 넘기면 오늘 거래량이 자기 평균 계산에 섞여 경계 근처 판정이 조용히 뒤집힌다
    // (예: 평소1.0·오늘1.5배는 정상 통과해야 하는데, 오늘 포함 평균이면 탈락으로
    // 둔갑) — 현재 두 호출부(daily-breakout-signal-scan.mjs·breakout-simulator.mjs)
    // 는 이미 이 불변식을 만족하지만, 주석만으로는 다음 호출부가 안 지킬 수 있어
    // throw로 강제한다(추정 안 함 원칙).
    if (candidate.volumes.length !== candidate.closes.length - 1) {
      throw new Error(`computeBreakoutEntrySignal: candidate.volumes는 closes보다 정확히 1 짧아야 함("오늘 제외") — closes ${candidate.closes.length}, volumes ${candidate.volumes.length}`);
    }
    avgVolume = computeAvgVolume(candidate.volumes, candidate.volumes.length - 1, opts.volumeLookbackDays);
    volumeOk = passesVolumeConfirmation(candidate.todayVolume, avgVolume, opts.volumeMultiplier);
  }
  const relativeStrengthOk = passesRelativeStrengthFilter(relativeStrength, opts.minRelativeStrength);
  const pass = week52.pass && volatility.pass && relativeStrengthOk && marketCapOk && volumeOk;
  return {
    pass, week52, volatility, relativeStrength, marketCapOk,
    volume: candidate.volumes != null ? { pass: volumeOk, avgVolume, todayVolume: candidate.todayVolume } : null,
  };
}
