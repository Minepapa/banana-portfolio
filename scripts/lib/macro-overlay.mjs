// 거시 전술 오버레이 — 신호 계산 순수 함수(구현계획서 Phase 8).
// docs/ARCHITECTURE-V2.md "거시 전술 오버레이 — Node/LLM 분리" 절 그대로: 신호 계산은
// Node(여기), "진짜 국면전환인가 노이즈인가" 판단은 LLM(Athena) — 이 모듈은 절대
// 판단하지 않는다, 숫자와 이진 신호만 낸다.
//
// 확정 5개 신호(Faber·금리차·DXY·VIX·유가) — "금리차"는 원래 설계부터 한국ECOS+
// 미국10Y-3M 둘로 구성됐는데, 2026-08-05~2026-09-12 사이엔 ECOS API 키 미신청으로
// 미국 쪽만 구현돼 있었다(오너 확정 2026-08-05 "나머지 4개 신호부터"). 2026-09-12
// ECOS 키 발급으로 한국 국고채(3년-10년) 스프레드를 추가해 "금리" 축을 완성했다
// (Knowledge/API/ECOS.md 참고). Faber는 국내주식·해외주식 각각, 금리차는 한국·미국
// 각각 별도 판정이라 실질 계산은 7개.
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

// 장단기 금리차 — 미국(10Y-3M, ^TNX-^IRX)·한국(국고채 10년-3년, ECOS 817Y002) 둘 다
// 이 함수 하나로 계산한다(2026-09-12, 국고채 스프레드 추가 시점에 미국 전용에서
// 일반화 — 스프레드 계산 자체는 어느 나라든 "장기 종가 - 단기 종가" 이상도 이하도
// 아니라 통화·국가 개념이 여기 들어올 이유가 없다). longCloses·shortCloses는 같은
// 시장 캘린더의 장기물·단기물 종가 시계열(과거→현재).
//
// 둘 다 같은 거래일 캘린더라 원칙적으로 날짜가 맞물리지만, 각자 독립적으로 NaN을
// 걸러내면(둘 중 하나만 특정 날짜에 결측) 우연히 길이가 같아지면서도 실제로는 서로
// 다른 날짜끼리 짝지어지는 경우가 생길 수 있다(코드리뷰 지적, 2026-08-05) — 그래서
// **먼저 인덱스로 짝지은 뒤** 그 쌍 중 하나라도 결측이면 그 쌍째로 버린다(개별
// 배열을 따로 거른 뒤 길이만 비교하지 않음). 이러면 살아남은 쌍은 항상 원본 인덱스가
// 같아 날짜 정합이 보장된다. 짝지을 원본 배열 길이 자체가 다르면(리스트 통째로
// 어긋난 경우) 스프레드 이력을 못 만드니 **현재값만** 반환하고 볼린저는 null —
// 추정하지 않는다.
export function computeRateSpreadSignal(longCloses, shortCloses) {
  const longRaw = longCloses ?? [];
  const shortRaw = shortCloses ?? [];
  if (!longRaw.length || !shortRaw.length) return null;
  const lastFinite = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return arr[i]; return null; };
  const longLast = lastFinite(longRaw);
  const shortLast = lastFinite(shortRaw);
  if (longLast == null || shortLast == null) return null;
  const currentSpread = longLast - shortLast;
  const inverted = currentSpread < 0;
  if (longRaw.length !== shortRaw.length) return { currentSpread, inverted, bands: null };
  const spreadSeries = longRaw
    .map((v, i) => v - shortRaw[i])
    .filter((_, i) => Number.isFinite(longRaw[i]) && Number.isFinite(shortRaw[i]));
  return { currentSpread, inverted, bands: computeBollingerBands(spreadSeries) };
}

// 금리차 신호의 "의미있는 변화" 판정 — 볼린저 이탈이 있으면 그걸로, 없으면(스프레드
// 이력을 못 만든 경우) 역전 여부 자체를 신호로 본다. 미국·한국 금리차 둘 다 동일
// 기준을 쓰므로 공용 함수로 뺐다(2026-09-12, 한국 스프레드 추가 시점에 중복 방지).
export function isRateSpreadBreached(rateSpread) {
  return rateSpread != null && (
    (rateSpread.bands != null && Math.abs(rateSpread.bands.zscore) >= 2) || rateSpread.inverted
  );
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

// 7개 계산(Faber×2 + 금리차×2(한국·미국) + DXY·VIX·유가)을 한 번에 묶는다.
// previousFaberState: { domestic: bool|null, foreign: bool|null } — 직전 확인
// 시점 상태(없으면 첫 확인). anyMeaningfulChange: "소집 규칙"(설계서) — 하나라도
// 의미있는 변화가 있으면 협의체 소집.
//
// krBond10yCloses/krBond3yCloses(2026-09-12 신설) — ECOS 국고채 10년·3년 종가
// (scripts/lib/ecos.mjs fetchGovBondCloses). 옵션 취급: 아직 안 넘기면(과거 호출부
// 호환) koreaRateSpread는 그냥 null이 되고 anyMeaningfulChange 판정에서도 조용히
// 빠진다 — 미국 금리차와 나머지 신호는 전과 동일하게 계속 작동한다.
export function computeMacroOverlaySignals({
  kospiCloses, sp500Closes, tnxCloses, irxCloses, krBond10yCloses, krBond3yCloses,
  dxyCloses, vixCloses, wtiCloses, previousFaberState = {},
}) {
  const faberDomestic = computeFaberSignal(kospiCloses);
  const faberForeign = computeFaberSignal(sp500Closes);
  const usRateSpread = computeRateSpreadSignal(tnxCloses, irxCloses);
  const koreaRateSpread = computeRateSpreadSignal(krBond10yCloses, krBond3yCloses);
  const dxy = computeSimpleBollingerSignal(dxyCloses);
  const vix = computeSimpleBollingerSignal(vixCloses);
  const wti = computeSimpleBollingerSignal(wtiCloses);

  const faberDomesticCrossed = detectFaberCrossover(previousFaberState.domestic, faberDomestic?.aboveMA ?? null);
  const faberForeignCrossed = detectFaberCrossover(previousFaberState.foreign, faberForeign?.aboveMA ?? null);

  const usRateSpreadBreached = isRateSpreadBreached(usRateSpread);
  const koreaRateSpreadBreached = isRateSpreadBreached(koreaRateSpread);

  const anyMeaningfulChange = [
    faberDomesticCrossed, faberForeignCrossed,
    usRateSpreadBreached, koreaRateSpreadBreached, dxy?.breached, vix?.breached, wti?.breached,
  ].some(Boolean);

  return {
    faberDomestic, faberForeign, faberDomesticCrossed, faberForeignCrossed,
    usRateSpread, usRateSpreadBreached, koreaRateSpread, koreaRateSpreadBreached,
    dxy, vix, wti, anyMeaningfulChange,
  };
}
