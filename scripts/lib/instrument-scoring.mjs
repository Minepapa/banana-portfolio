// ETF 종목 스코어링 — 2026-09-06 신설. "자산분배 트랙 핵심 로직 설계" §2. 지금까지
// 신규 종목 선택은 100% Athena(LLM) 자유판단(프롬프트에 "보수율·유동성·NAV괴리율·
// 추적오차 고려해서 골라라"라고만 적혀 있고 그 데이터를 실제로 조회해 주는 코드가 없었음)
// — 이 모듈이 그 데이터 기반 절대 스케일 점수를 계산한다.
//
// peer 상대평가가 아니라 고정 임계값 기반 절대 스케일이다(checkBand의 고정 5%p/25%
// 밴드, 퀀트 트랙 유동성 기준과 같은 "고정 임계값" 철학 — 후보 하나가 들고나도 다른
// 후보 점수가 안 흔들려야 연 1회 재스코어링 때 연도별 비교가 가능함). THRESHOLDS는
// 1차 placeholder — 오너가 나중에 실측 기반으로 조정할 것을 전제로 한다.
import { getExpenseRatio } from './etf-expense-ratios.mjs';
import { ASSET_CLASS_ETF_UNIVERSE } from './asset-class-etf-universe.mjs';
import { fetchEtfSeries } from './krx.mjs';

export const SCORING_WEIGHTS = { expenseRatio: 0.25, liquidity: 0.25, navPremium: 0.25, trackingError: 0.25 };

export const THRESHOLDS = {
  expenseRatioPct: { good: 0.05, bad: 1.0 },
  liquidityWon: { good: 5_000_000_000, bad: 100_000_000 },
  navPremiumPct: { good: 0, bad: 3 },
  trackingErrorPct: { good: 0, bad: 3 },
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

// candidate: { name, accTrdVal, close, nav, series } — 데이터 있는 축만 가중평균(가중치
// 재분배), dataGaps로 빠진 축을 노출(호출부가 "이 순위는 몇 개 축만으로 계산됐다"를
// 알 수 있게). 모든 축이 데이터 부족이면 composite는 null(추정 안 함).
export function computeInstrumentScore(candidate) {
  const axes = {
    expenseRatio: scoreExpenseRatio(candidate.name),
    liquidity: scoreLiquidity(candidate.accTrdVal),
    navPremium: scoreNavPremium(candidate.close, candidate.nav),
    trackingError: scoreTrackingError(candidate.series),
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

// ASSET_CLASS_ETF_UNIVERSE(오너가 수동 확인해 채우는 자산군별 후보 목록)의 각 이름을
// 실측 KRX 데이터(fetchEtfSeries)로 조회해 스코어링·순위화한다 — "그 계좌에 보유 후보가
// 전혀 없을 때"(완전 신규 매수) 경로 전용. 조회 실패(상장 전·이름 오타 등, 빈 시리즈)
// 후보는 스코어링 대상에서 제외(0점으로 추정 안 함) — 유니버스가 비어있으면(오너가 아직
// 안 채운 자산군) 빈 배열 반환, 호출부가 "이 경로는 아직 못 쓴다"로 처리해야 한다.
export async function rankAssetClassUniverse(assetClass, { fetchSeries = fetchEtfSeries, days = 60 } = {}) {
  const names = ASSET_CLASS_ETF_UNIVERSE[assetClass] ?? [];
  const candidates = [];
  for (const name of names) {
    const series = await fetchSeries(name, days);
    if (!series.length) continue;
    const latest = series[series.length - 1];
    candidates.push({ name, accTrdVal: latest.accTrdVal, close: latest.close, nav: latest.nav, series });
  }
  return rankInstruments(candidates);
}
