// ETF 연 총보수(%) 수동 테이블 — 2026-09-06 신설. KRX API에 총보수 필드가 없어(2026-09-06
// 실측 확인, etp/etf_bydd_trd 응답에 보수 관련 필드 자체가 없음) 스크래퍼를 새로 만드는
// 대신 `rebalance-gap.mjs`의 `LEGACY_INDIVIDUAL_STOCKS`와 같은 패턴(오너가 확인해서
// 채우는 수동 테이블)을 그대로 따른다. 없는 종목은 "데이터 부족"으로 그 축만 점수
// 계산에서 제외 — 0으로 추정하지 않는다(이 프로젝트 feedback-no-silent-fallback 원칙).
// 2026-09-06 오너 확인 — 현재 보유 중인 ETF만 우선 채움(ASSET_CLASS_ETF_UNIVERSE와
// 짝). funetf.co.kr 공시 페이지의 "총보수(운용보수)" 표기를 기준으로 함(연 %, 판매·
// 신탁·일반사무 포함 총보수 — 괄호 안 운용보수만이 아님). 각주가 있는 항목은 자동
// 조회 신뢰도가 낮아 다음에 실제 etfcheck.co.kr 앱으로 직접 재확인 권장.
export const EXPENSE_RATIO_TABLE = {
  'KODEX CD금리액티브(합성)': 0.02,
  'TIGER KRX금현물': 0.15,
  'ACE 미국달러SOFR금리(합성)': 0.05,
  'TIGER 일본엔선물': 0.25, // ⚠️ 단일 출처(funetf) 확인 — 교차검증 못 함
  'KoAct K수출핵심기업TOP30액티브': 0.5,
  'KoAct 미국나스닥성장기업액티브': 0.5,
  'KODEX 미국나스닥100': 0.0062, // 2026-09-07 오너 직접 확인(etfcheck) — 정확함
  'TIGER 미국S&P500': 0.0068, // 2026-09-07 오너 직접 확인(etfcheck) — 정확함
  // 2026-09-07 오너 추가 요청분(funetf.co.kr "총보수(운용보수)" 기준)
  'KIWOOM 종합채권(AA-이상)액티브': 0.025,
  'KODEX 국고채10년액티브': 0.015,
  'ACE 미국10년국채액티브': 0.15,
  'TIGER 200': 0.05,
  'KODEX 200TR': 0.05,
  'ACE 200': 0.017,
  // 'ACE KRX금현물'은 자동조회 실패(ACE 공식 페이지가 자바스크립트 렌더링이라 못 읽음)
  // — getExpenseRatio가 null 반환, 그 축만 데이터 부족으로 스킵됨(0으로 추정 안 함).
  // etfcheck에서 확인되면 추가.
  // 미국 직접 상장 ETF(2026-09-07, us-etf-scoring.mjs 신설과 함께 추가) — 운용사가
  // 공시하는 안정적 공개값이라 KRX 상품들과 달리 사실상 고정값(자주 안 바뀜).
  VOO: 0.03, // Vanguard S&P 500 ETF
  QQQM: 0.15, // Invesco NASDAQ-100 ETF (Mini)
};

export function getExpenseRatio(name) {
  return EXPENSE_RATIO_TABLE[name] ?? null;
}
