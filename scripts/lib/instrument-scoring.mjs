// ETF 종목 스코어링 — 2026-09-06 신설. "자산분배 트랙 핵심 로직 설계" §2. 지금까지
// 신규 종목 선택은 100% Athena(LLM) 자유판단(프롬프트에 "보수율·유동성·NAV괴리율·
// 추적오차 고려해서 골라라"라고만 적혀 있고 그 데이터를 실제로 조회해 주는 코드가 없었음)
// — 이 모듈이 그 데이터 기반 절대 스케일 점수를 계산한다.
//
// peer 상대평가가 아니라 고정 임계값 기반 절대 스케일이다(checkBand의 고정 5%p/25%
// 밴드, 퀀트 트랙 유동성 기준과 같은 "고정 임계값" 철학 — 후보 하나가 들고나도 다른
// 후보 점수가 안 흔들려야 연 1회 재스코어링 때 연도별 비교가 가능함). THRESHOLDS는
// 1차 placeholder — 오너가 나중에 실측 기반으로 조정할 것을 전제로 한다.
//
// 2026-09-07 오너 지적 반영 — "4축(보수율·유동성·NAV괴리율·추적오차)만 보면 액티브
// 상품은 무조건 불리하다, 가장 중요한 게 수익률인데 그게 빠져있다"는 지적으로 수익률
// 관련 2축(absoluteReturn·excessReturn)을 추가했다. 왜 하나가 아니라 둘인지 —
// 오너 확정: "추적지수 대비 초과수익률과 절대수익률 모두" 봐야 한다. excessReturn은
// "이 종목이 자기 벤치마크 대비 얼마나 잘했나"(액티브 펀드의 실력, 패시브는 ~0 근처가
// 정상)를, absoluteReturn은 "그냥 얼마나 벌었나"(같은 자산군 후보끼리만 비교되므로
// 절대 스케일이 자산군마다 달라도 순위 자체는 보존됨)를 본다 — 서로 답하는 질문이
// 달라 하나로 뭉개면 정보 손실이 생긴다.
import { getExpenseRatio } from './etf-expense-ratios.mjs';
import { ASSET_CLASS_ETF_UNIVERSE } from './asset-class-etf-universe.mjs';
import { fetchEtfSeries, fetchEtfSeriesForNames } from './krx.mjs';
import { fetchUsEtfSeries, US_ETF_BENCHMARK_TICKER } from './us-etf-scoring.mjs';

// 수익률 2축(absoluteReturn+excessReturn)에 합계 0.5를 줘 "가장 중요한 축"이라는
// 오너 지시를 반영 — 나머지 4축은 나머지 0.5를 균등분배. 전부 1차 placeholder.
export const SCORING_WEIGHTS = {
  expenseRatio: 0.125, liquidity: 0.125, navPremium: 0.125, trackingError: 0.125,
  absoluteReturn: 0.25, excessReturn: 0.25,
};

export const THRESHOLDS = {
  expenseRatioPct: { good: 0.05, bad: 1.0 },
  liquidityWon: { good: 5_000_000_000, bad: 100_000_000 },
  navPremiumPct: { good: 0, bad: 3 },
  trackingErrorPct: { good: 0, bad: 3 },
  // series 조회 구간(기본 252거래일≈1년) 전체의 단순 수익률(%) — 같은 자산군
  // 후보끼리만 비교되므로(rankAssetClassUniverse가 assetClass 단위로만 순위를 매김)
  // 자산군마다 "좋은 수익률"의 절대 기준이 달라도(채권 vs 주식) 상대 순위는 보존된다.
  absoluteReturnPct: { good: 15, bad: -10 },
  // 종목 수익률 - 추적지수 수익률(%p, 같은 구간). 패시브는 0%p 근처가 정상(잘 추종),
  // 액티브는 벤치마크를 얼마나 이겼는지가 그대로 드러난다.
  excessReturnPct: { good: 2, bad: -2 },
};

// value를 [bad→0점, good→100점] 선형 스케일로 매핑(good·bad 대소관계는 축마다 다름 —
// 보수율·괴리율·추적오차는 낮을수록 good, 유동성은 높을수록 good. 방향은 good/bad 값
// 자체의 대소관계로 인코딩되므로 이 함수는 방향을 모른 채 동작). 범위 밖은 클램프.
// 값이 없으면(데이터 부족) null — 0점으로 추정하지 않는다.
function linearScore(value, { good, bad }) {
  if (value == null || !Number.isFinite(value)) return null;
  if (good === bad) return value === good ? 100 : 0;
  const t = (value - bad) / (good - bad);
  return Math.min(1, Math.max(0, t)) * 100;
}

function sampleStdev(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function scoreExpenseRatio(name) {
  return linearScore(getExpenseRatio(name), THRESHOLDS.expenseRatioPct);
}

export function scoreLiquidity(accTrdVal) {
  return linearScore(accTrdVal, THRESHOLDS.liquidityWon);
}

// NAV 대비 시장가 괴리율(%) — 프리미엄(고평가)·디스카운트(저평가) 둘 다 괴리는
// 괴리라 절대값으로 본다(부호 무시).
export function scoreNavPremium(close, nav) {
  if (!Number.isFinite(close) || !Number.isFinite(nav) || nav <= 0) return null;
  const premiumPct = Math.abs(((close - nav) / nav) * 100);
  return linearScore(premiumPct, THRESHOLDS.navPremiumPct);
}

// series: 과거→현재 순 {close, idxClose}[] — ETF 일간수익률과 추적지수 일간수익률의
// 차(트래킹 디퍼런스) 표준편차를 연환산(√252)한 값(%)을 추적오차로 본다. 유효한 연속
// 구간(close·idxClose 둘 다 있는 날)이 3일 미만이면(수익률 쌍 2개 미만) null.
export function scoreTrackingError(series) {
  const valid = (series ?? []).filter((s) => Number.isFinite(s?.close) && Number.isFinite(s?.idxClose) && s.close > 0 && s.idxClose > 0);
  if (valid.length < 3) return null;
  const diffs = [];
  for (let i = 1; i < valid.length; i++) {
    const etfRet = valid[i].close / valid[i - 1].close - 1;
    const idxRet = valid[i].idxClose / valid[i - 1].idxClose - 1;
    diffs.push(etfRet - idxRet);
  }
  const stdev = sampleStdev(diffs);
  if (stdev == null) return null;
  const annualizedPct = stdev * Math.sqrt(252) * 100;
  return linearScore(annualizedPct, THRESHOLDS.trackingErrorPct);
}

// series 구간 첫날→마지막날 단순 수익률(%). 유효한 close가 2일 미만이면 null.
export function scoreAbsoluteReturn(series) {
  const valid = (series ?? []).filter((s) => Number.isFinite(s?.close) && s.close > 0);
  if (valid.length < 2) return null;
  const returnPct = ((valid[valid.length - 1].close / valid[0].close) - 1) * 100;
  return linearScore(returnPct, THRESHOLDS.absoluteReturnPct);
}

// series 구간 첫날→마지막날, 종목 수익률 - 추적지수 수익률(%p). 둘 다 유효한 날이
// 2일 미만이면 null.
export function scoreExcessReturn(series) {
  const valid = (series ?? []).filter((s) => Number.isFinite(s?.close) && s.close > 0 && Number.isFinite(s?.idxClose) && s.idxClose > 0);
  if (valid.length < 2) return null;
  const ownReturnPct = ((valid[valid.length - 1].close / valid[0].close) - 1) * 100;
  const idxReturnPct = ((valid[valid.length - 1].idxClose / valid[0].idxClose) - 1) * 100;
  return linearScore(ownReturnPct - idxReturnPct, THRESHOLDS.excessReturnPct);
}

// candidate: { name, accTrdVal, close, nav, series } — 데이터 있는 축만 가중평균(가중치
// 재분배), dataGaps로 빠진 축을 노출(호출부가 "이 순위는 몇 개 축만으로 계산됐다"를
// 알 수 있게). 모든 축이 데이터 부족이면 composite는 null(추정 안 함).
export function computeInstrumentScore(candidate) {
  const axes = {
    expenseRatio: scoreExpenseRatio(candidate.name),
    liquidity: scoreLiquidity(candidate.accTrdVal),
    navPremium: scoreNavPremium(candidate.close, candidate.nav),
    trackingError: scoreTrackingError(candidate.series),
    absoluteReturn: scoreAbsoluteReturn(candidate.series),
    excessReturn: scoreExcessReturn(candidate.series),
  };
  const dataGaps = Object.keys(axes).filter((k) => axes[k] == null);
  const available = Object.keys(axes).filter((k) => axes[k] != null);
  const weightSum = available.reduce((s, k) => s + SCORING_WEIGHTS[k], 0);
  const composite = weightSum > 0 ? available.reduce((s, k) => s + SCORING_WEIGHTS[k] * axes[k], 0) / weightSum : null;
  return { name: candidate.name, composite, axes, dataGaps };
}

// composite 내림차순 정렬(null은 맨 뒤 — 스코어링 불가 후보는 순위 최하단).
export function rankInstruments(candidates) {
  return candidates.map(computeInstrumentScore).sort((a, b) => {
    if (a.composite == null && b.composite == null) return 0;
    if (a.composite == null) return 1;
    if (b.composite == null) return -1;
    return b.composite - a.composite;
  });
}

// 이름이 미국 직접 상장 티커(US_ETF_BENCHMARK_TICKER에 등록된 것, VOO·QQQM 등)면
// yfinance로, 아니면 KRX로 라우팅해 시계열을 조회한다(2026-09-07 신설) — 그 티커는
// KRX etp/etf_bydd_trd에 존재하지 않아 fetchEtfSeries로는 항상 빈 시리즈만 나온다.
// rankAssetClassUniverse뿐 아니라 annual-instrument-rescore.mjs가 보유종목·교체
// 후보 가격을 직접 조회할 때도 같은 라우팅이 필요해(VOO·QQQM이 유니버스 1위가 되면
// 그 잡도 이 이름으로 KRX를 직접 조회하게 됨) 공유 함수로 뺐다 — 두 데이터 소스를
// 호출부가 몰라도 되게 라우팅 판단을 이 한 곳에 모은다.
export async function fetchInstrumentSeries(name, days = 252, { fetchSeries = fetchEtfSeries, fetchUsSeries = fetchUsEtfSeries } = {}) {
  return Object.hasOwn(US_ETF_BENCHMARK_TICKER, name) ? fetchUsSeries(name) : fetchSeries(name, days);
}

// ASSET_CLASS_ETF_UNIVERSE(오너가 수동 확인해 채우는 자산군별 후보 목록)의 각 이름을
// 실측 데이터로 조회해 스코어링·순위화한다 — "그 계좌에 보유 후보가 전혀 없을 때"
// (완전 신규 매수) 경로 전용. 조회 실패(상장 전·이름 오타 등, 빈 시리즈) 후보는
// 스코어링 대상에서 제외(0점으로 추정 안 함) — 유니버스가 비어있으면(오너가 아직 안
// 채운 자산군) 빈 배열 반환, 호출부가 "이 경로는 아직 못 쓴다"로 처리해야 한다. days
// 기본값 252(≈1년, 2026-09-07 60→252 상향) — 수익률 축(absoluteReturn·excessReturn)
// 이 의미 있으려면 60거래일(약 3개월)은 너무 짧다.
//
// ⚠️ 2026-09-07 성능 수정 — KRX 종목은 fetchInstrumentSeries로 하나씩 조회하지 않고
// fetchEtfSeriesForNames로 한 번에 배치 조회한다(days=252로 올린 뒤 실측 확인 —
// 자산군 하나에 KRX 후보 3개만 있어도 순차 조회는 몇 분씩 걸렸고, 긴 연속 호출 중
// KRX 서버가 연결을 끊는 사례도 실제로 관측됨). 미국 티커(US_ETF_BENCHMARK_TICKER에
// 등록된 것)는 이 배치의 대상이 아니라 여전히 개별 조회(fetchUsEtfSeries) — 애초에
// 티커당 파이썬 프로세스 1회뿐이라 배치할 병목이 없다.
export async function rankAssetClassUniverse(assetClass, { fetchSeriesForNames = fetchEtfSeriesForNames, fetchUsSeries = fetchUsEtfSeries, days = 252 } = {}) {
  const names = ASSET_CLASS_ETF_UNIVERSE[assetClass] ?? [];
  const krxNames = names.filter((n) => !Object.hasOwn(US_ETF_BENCHMARK_TICKER, n));
  const usNames = names.filter((n) => Object.hasOwn(US_ETF_BENCHMARK_TICKER, n));

  const candidates = [];
  if (krxNames.length) {
    const seriesByName = await fetchSeriesForNames(krxNames, days);
    for (const name of krxNames) {
      const series = seriesByName[name] ?? [];
      if (!series.length) continue;
      const latest = series[series.length - 1];
      candidates.push({ name, accTrdVal: latest.accTrdVal, close: latest.close, nav: latest.nav, series });
    }
  }
  for (const name of usNames) {
    const series = await fetchUsSeries(name);
    if (!series.length) continue;
    const latest = series[series.length - 1];
    candidates.push({ name, accTrdVal: latest.accTrdVal, close: latest.close, nav: latest.nav, series });
  }
  return rankInstruments(candidates);
}
