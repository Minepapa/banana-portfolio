// KRX 국내주식 호가단위(tick size) — 2026-09-22, 실전 첫 손절주문 시도가 "주식주문
// 호가단위 오류입니다"(KIS rt_cd 오류)로 거부되며 발견. computeProtectionOrders
// (breakout-protection.mjs)가 entryPrice*(1-stopLossPct) 같은 퍼센트 계산으로
// 손절/익절 가격을 만드는데, 이 값이 KRX 호가단위 배수가 아니면 KIS가 주문 자체를
// 거부한다(예: SK텔레콤 87,400원 진입 × 0.92 = 80,408원 — 이 가격대 호가단위는
// 100원이라 80,408은 유효가가 아님, 실측). 2023-01-25 KRX 통합 호가단위 개정 기준
// (코스피·코스닥 동일 표) — 구간의 하한값 자체가 모든 하위 구간 호가단위의 배수라
// 경계값 부근이 아닌 한 하한 기준 나눗셈만으로 충분하다(경계선 바로 위 가격이
// 반올림으로 아래 구간에 걸리는 극히 드문 경우는 이 함수 범위 밖 — 발생해도 KIS가
// 다시 거부할 뿐 잘못된 주문이 나가진 않는다).
const TICK_BANDS = [
  { under: 2_000, tick: 1 },
  { under: 5_000, tick: 5 },
  { under: 20_000, tick: 10 },
  { under: 50_000, tick: 50 },
  { under: 200_000, tick: 100 },
  { under: 500_000, tick: 500 },
  { under: Infinity, tick: 1_000 },
];

export function krxTickSize(price) {
  return TICK_BANDS.find((b) => price < b.under).tick;
}

// 가장 가까운 유효 호가로 반올림(호가단위 배수). 손절/익절처럼 "정확한 목표가"가
// 없고 근사치로 충분한 계산값에 쓴다 — 실제 시장 호가(현재가 조회 등으로 이미
// 유효한 값)에는 적용할 필요 없음(이미 호가단위에 맞음).
export function roundToKrxTick(price) {
  const tick = krxTickSize(price);
  return Math.round(price / tick) * tick;
}
