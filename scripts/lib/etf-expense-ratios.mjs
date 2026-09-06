// ETF 연 총보수(%) 수동 테이블 — 2026-09-06 신설. KRX API에 총보수 필드가 없어(2026-09-06
// 실측 확인, etp/etf_bydd_trd 응답에 보수 관련 필드 자체가 없음) 스크래퍼를 새로 만드는
// 대신 `rebalance-gap.mjs`의 `LEGACY_INDIVIDUAL_STOCKS`와 같은 패턴(오너가 확인해서
// 채우는 수동 테이블)을 그대로 따른다. 없는 종목은 "데이터 부족"으로 그 축만 점수
// 계산에서 제외 — 0으로 추정하지 않는다(이 프로젝트 feedback-no-silent-fallback 원칙).
export const EXPENSE_RATIO_TABLE = {};

export function getExpenseRatio(name) {
  return EXPENSE_RATIO_TABLE[name] ?? null;
}
