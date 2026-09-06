// NH PLUG 잔고조회 응답(자산군마다 필드명이 다름) → order-gate.mjs 계열이 공유하는
// `{code, qty}` 공통 형태로 정규화(2026-09-05 신설). proposal-execution-input.mjs의
// buildGateInput({ holdings, ... })이 이미 `holdings.find(h => h.code === assetKey)`
// 로 KIS 잔고 형태를 소비하고 있었다 — 이 정규화만 거치면 execute-asset-allocation-
// proposal.mjs가 그 함수를 전혀 안 고치고 그대로 재사용할 수 있다(브로커별 새 gate-
// input 조립기를 또 만들면 검문소 로직이 두 곳으로 갈라지는 위험이 생긴다).
//
// 각 자산군의 "잔고" 필드가 다른 이유(2026-09-05 라이브 조회로 실측 확인):
//   - KR: itg_bnc_qty(통합잔고수량)는 미체결 주문분까지 포함할 수 있어, 지금 이
//     순간 실제로 팔 수 있는 수량은 rsdl_qty(잔여수량)다.
//   - 해외: cns_bse_bnc_qty(잔고기준수량)보다 sll_pbl_qty1(매도가능수량)이 매도
//     가능성 판단에 더 정확한 값(위와 동일 이유).
//   - 금현물: krstock과 동일하게 rsdl_qty(잔여수량)가 실주문가능 수량.
function toQty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function normalizeKrHoldings(output1) {
  return (output1 || []).map((h) => ({ code: h.iem_cd, qty: toQty(h.rsdl_qty) }));
}

export function normalizeGbHoldings(output1) {
  return (output1 || []).map((h) => ({ code: h.iem_cd, qty: toQty(h.sll_pbl_qty1) }));
}

export function normalizeGoldHoldings(output1) {
  return (output1 || []).map((h) => ({ code: h.iem_cd, qty: toQty(h.rsdl_qty) }));
}

// 장내채권(2026-09-06 추가, 오너 지시 — "장내채권도 주문 넣을 수 있게 확장"). krstock·
// krgold와 달리 별도 "매도가능수량" 필드 자체가 없다(getBondBalance openapi 확인) —
// itg_bnc_qty(통합잔고수량)에서 itg_ny_stl_qty(통합미결제수량, 실측상 항상 0)를 뺀
// 값을 실주문가능 수량으로 쓴다(다른 자산군의 "미체결분 제외" 원칙과 동일 정신).
// ⚠️ 단위는 액면가 원 단위 그대로(예: 30,000,000 = 3천만원 액면) — Vault Holdings의
// qty(3000, 1만원 단위 "좌수" 관례)와 단위가 다르다(update-holdings-prices.mjs가
// evalAmount/qty로 좌당 단가를 역산할 때 이 불일치를 이미 흡수함) — 주문 API도 이
// 원 단위를 그대로 받는다고 가정(라이브 매수/매도 검증 전이라 명시).
export function normalizeBondHoldings(output1) {
  return (output1 || []).map((h) => ({ code: h.iem_cd, qty: toQty(h.itg_bnc_qty) - toQty(h.itg_ny_stl_qty) }));
}
