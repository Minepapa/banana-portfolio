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
