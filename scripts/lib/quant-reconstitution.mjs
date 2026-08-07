// 퀀트 트랙 버퍼존 리컨스티튜션 판정 — 순수 함수(구현계획서 Phase 9,
// ARCHITECTURE-V2.md "매달 재계산 흐름" 절 그대로). rankByOcfToPrice 결과와 실제 KIS
// 잔고(kis.mjs getAccountBalance 결과)를 비교해 매수·매도·유지·확인필요로 분류한다.
// "정확히 몇 주를 얼마에" 판단은 이 함수의 범위 밖 — Node는 분류와 포지션사이징 밴드까지만
// 내고, 실제 수량·타이밍은 Kairos 재량(판단 하드코딩 금지 원칙).

export const BUY_RANK = 10; // 신규 매수: 상위 10위 안에 들어야만 편입
export const SELL_RANK = 20; // 기존 유지: 20위 밖으로 밀려야만 매도(버퍼존 — 회전율 절감)
export const EQUAL_WEIGHT_KRW = 4_000_000; // 동일가중 기준(10종목 목표)
export const POSITION_BAND_PCT = 0.5; // ±50%, OCF/P 점수 강도로 Kairos 재량 조정

// 포지션 사이징 밴드(원) — 정확한 금액은 Kairos 재량이라 Node는 상하한만 보고한다.
export function positionBand(targetKrw = EQUAL_WEIGHT_KRW, bandPct = POSITION_BAND_PCT) {
  return { min: Math.round(targetKrw * (1 - bandPct)), target: targetKrw, max: Math.round(targetKrw * (1 + bandPct)) };
}

// ranked: rankByOcfToPrice 결과([{Code, Name, rank, ocfToPrice, ...}], ocfToPrice가 null인
// 항목은 이미 제외된 상태). holdings: KIS getAccountBalance().holdings([{code, name, qty}]).
//
// 분류 규칙:
// - 매수: 랭킹 상위 buyRank위 이내 + 미보유
// - 매도: 보유 중 + 랭킹에서 sellRank위 밖으로 확인됨(랭킹에 있고 순위가 확인됨)
// - 유지: 보유 중 + 랭킹 sellRank위 이내(신규 진입 조건을 다시 만족할 필요는 없음 — 버퍼존)
// - 확인필요: 보유 중인데 이번 랭킹 결과 자체에 없음(유니버스 이탈·유동성 미달·법인코드
//   매칭 실패·공시 미확인 중 어느 사유인지 이 함수만으로는 특정 불가) — "랭킹에 없다"를
//   곧장 "매도"로 추정하지 않는다(ADR 0003 폴백 금지 원칙과 동일 — 원인 불명 상태에서
//   기계적으로 청산 결정을 내리는 게 오히려 위험할 수 있어 Kairos 검토로 넘긴다).
export function computeReconstitution(ranked, holdings, { buyRank = BUY_RANK, sellRank = SELL_RANK } = {}) {
  const rankedByCode = new Map(ranked.map((r) => [r.Code, r]));
  const heldCodes = new Set(holdings.map((h) => h.code));

  const buys = ranked
    .filter((r) => r.rank <= buyRank && !heldCodes.has(r.Code))
    .map((r) => ({ code: r.Code, name: r.Name, rank: r.rank, ocfToPrice: r.ocfToPrice, band: positionBand() }));

  const sells = [];
  const holds = [];
  const needsReview = [];
  for (const h of holdings) {
    const r = rankedByCode.get(h.code);
    if (!r) {
      needsReview.push({ code: h.code, name: h.name, qty: h.qty, reason: '이번 랭킹 결과에 없음(유니버스 이탈·유동성 미달·법인코드 매칭 실패·공시 미확인 중 하나 — 원인 미확정, 매도로 자동 추정하지 않음)' });
    } else if (r.rank > sellRank) {
      sells.push({ code: h.code, name: h.name, qty: h.qty, rank: r.rank, ocfToPrice: r.ocfToPrice });
    } else {
      holds.push({ code: h.code, name: h.name, qty: h.qty, rank: r.rank, ocfToPrice: r.ocfToPrice });
    }
  }

  return { buys, sells, holds, needsReview };
}
