// 거시 전술 오버레이 — 신호 계산 순수 함수(구현계획서 Phase 8).
// docs/ARCHITECTURE-V2.md "거시 전술 오버레이 — Node/LLM 분리" 절 그대로: 신호 계산은
// Node(여기), "진짜 국면전환인가 노이즈인가" 판단은 LLM(Athena) — 이 모듈은 절대
// 판단하지 않는다, 숫자와 이진 신호만 낸다.
//
// 확정 5개 신호 중 4개(Faber·미국금리차·DXY·VIX·유가는 사실 5개 계산이지만 "금리차"가
// 원래 한국ECOS+미국10Y-3M 둘로 구성된 것 중 미국 쪽만 우선 구현 — ECOS API 키 미신청,
// 오너 확정 2026-08-05 "나머지 4개 신호부터"). Faber는 국내주식·해외주식 각각 별도
// 판정이라 실질 계산은 6개.
import { computeBollingerBands } from './fundamentals.mjs';

// Faber 10개월(≈200일) 이동평균 추세필터 — 원 논문 방법론 그대로 이진 판정(위/아래).
// window=200이 기본이나 실제 트리거는 "월 1회, 월말 종가 기준"(운영 스케줄 몫 — 이 함수
// 자체는 호출 시점과 무관하게 항상 같은 계산을 한다).
export function computeFaberSignal(closes, window = 200) {
  const a = (closes ?? []).filter(Number.isFinite);
  if (a.length < window) return null; // 데이터 부족(신규 상장 등) — 판정 보류
  const ma = a.slice(-window).reduce((s, x) => s + x, 0) / window;
  const current = a[a.length - 1];
  const deviationPct = ma !== 0 ? ((current - ma) / ma) * 100 : 0;
  return { ma, current, aboveMA: current >= ma, deviationPct };
}

// 미국 장단기 금리차(10Y-3M, ^TNX-^IRX) — 둘 다 같은 미국 거래일 캘린더라 원칙적으로
// 날짜가 맞물리지만, 티커별로 각자 독립적으로 NaN을 걸러내면(둘 중 하나만 특정 날짜에
// 결측) 우연히 길이가 같아지면서도 실제로는 서로 다른 날짜끼리 짝지어지는 경우가 생길
// 수 있다(코드리뷰 지적, 2026-08-05) — 그래서 **먼저 인덱스로 짝지은 뒤** 그 쌍 중
// 하나라도 결측이면 그 쌍째로 버린다(개별 배열을 따로 거른 뒤 길이만 비교하지 않음).
// 이러면 살아남은 쌍은 항상 원본 인덱스가 같아 날짜 정합이 보장된다. 짝지을 원본 배열
// 길이 자체가 다르면(리스트 통째로 어긋난 경우) 스프레드 이력을 못 만드니 **현재값만**
// 반환하고 볼린저는 null — 추정하지 않는다.
export function computeRateSpreadSignal(tnxCloses, irxCloses) {
  const tnxRaw = tnxCloses ?? [];
  const irxRaw = irxCloses ?? [];
  if (!tnxRaw.length || !irxRaw.length) return null;
  const lastFinite = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return arr[i]; return null; };
  const tnxLast = lastFinite(tnxRaw);
  const irxLast = lastFinite(irxRaw);
  if (tnxLast == null || irxLast == null) return null;
  const currentSpread = tnxLast - irxLast;
  const inverted = currentSpread < 0;
  if (tnxRaw.length !== irxRaw.length) return { currentSpread, inverted, bands: null };
  const spreadSeries = tnxRaw
    .map((v, i) => v - irxRaw[i])
    .filter((_, i) => Number.isFinite(tnxRaw[i]) && Number.isFinite(irxRaw[i]));
  return { currentSpread, inverted, bands: computeBollingerBands(spreadSeries) };
}

// DXY·VIX·유가 — 기존 risk-monitor와 동일한 ±2σ 볼린저 이탈 판정을 그대로 재사용.
export function computeSimpleBollingerSignal(closes) {
  const a = (closes ?? []).filter(Number.isFinite);
  if (!a.length) return null;
  const current = a[a.length - 1];
  const bands = computeBollingerBands(a);
  const breached = bands != null && Math.abs(bands.zscore) >= 2;
  return { current, bands, breached };
}

// Faber는 "지금 위/아래"가 아니라 "지난 확인 이후 위→아래 또는 아래→위로 바뀌었는가"가
// 신호다(설계서: "이달 말 자산군별 이동평균 상·하향 크로스 발생 여부") — 매일 계산해도
// 항상 계산 가능(true)하다는 사실 자체는 "변화"가 아니다. previousAboveMA가 없으면
// (첫 확인) 크로스로 치지 않는다 — 비교 기준이 없는데 "변화"라고 부를 근거가 없음.
export function detectFaberCrossover(previousAboveMA, currentAboveMA) {
  if (previousAboveMA == null || currentAboveMA == null) return false;
  return previousAboveMA !== currentAboveMA;
}

// 6개 계산(Faber×2 + 금리차 + DXY·VIX·유가)을 한 번에 묶는다. previousFaberState:
// { domestic: bool|null, foreign: bool|null } — 직전 확인 시점 상태(없으면 첫 확인).
// anyMeaningfulChange: "소집 규칙"(설계서) — 하나라도 의미있는 변화가 있으면 협의체 소집.
export function computeMacroOverlaySignals({ kospiCloses, sp500Closes, tnxCloses, irxCloses, dxyCloses, vixCloses, wtiCloses, previousFaberState = {} }) {
  const faberDomestic = computeFaberSignal(kospiCloses);
  const faberForeign = computeFaberSignal(sp500Closes);
  const rateSpread = computeRateSpreadSignal(tnxCloses, irxCloses);
  const dxy = computeSimpleBollingerSignal(dxyCloses);
  const vix = computeSimpleBollingerSignal(vixCloses);
  const wti = computeSimpleBollingerSignal(wtiCloses);

  const faberDomesticCrossed = detectFaberCrossover(previousFaberState.domestic, faberDomestic?.aboveMA ?? null);
  const faberForeignCrossed = detectFaberCrossover(previousFaberState.foreign, faberForeign?.aboveMA ?? null);

  // 금리차의 "의미있는 변화"는 볼린저 이탈이 있으면 그걸로, 없으면(스프레드 이력을 못
  // 만든 경우) 역전 여부 자체를 신호로 본다 — 완전히 판단을 포기하지 않되 추정은 안 함.
  const rateSpreadBreached = rateSpread != null && (
    (rateSpread.bands != null && Math.abs(rateSpread.bands.zscore) >= 2) || rateSpread.inverted
  );

  const anyMeaningfulChange = [
    faberDomesticCrossed, faberForeignCrossed,
    rateSpreadBreached, dxy?.breached, vix?.breached, wti?.breached,
  ].some(Boolean);

  return {
    faberDomestic, faberForeign, faberDomesticCrossed, faberForeignCrossed,
    rateSpread, rateSpreadBreached, dxy, vix, wti, anyMeaningfulChange,
  };
}
