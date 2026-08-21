// 신규 현금 배분 — "그 계좌가 세금상 담을 수 있는 자산군" 필터 + 갭 랭킹(순수 함수).
// ARCHITECTURE-V2.md "원칙 2 — 계좌 배치: 한국 세금 메커니즘 기반 자산배치이론" 절의
// 계좌별 역할표를 그대로 상수화한 것 — 이건 세금 규칙이라는 결정론적 사실이지 투자
// 판단이 아니므로 하드코딩 금지 원칙에 위배되지 않는다("판단에 하드코딩 금지"는 *무엇을
// 얼마나 살지*의 판단을 가리키는 것이지, 세법이 정한 계좌별 자산군 자격 자체를 가리키지
// 않는다 — 어느 쪽으로 배분할지·얼마나 배분할지는 이 모듈이 정하지 않고 후보만 좁힌다).
import { normalizeAccount } from './rebalance-gap.mjs';

export const ACCOUNT_ELIGIBLE_ASSET_CLASSES = {
  위탁: ['국내주식', '해외주식', '채권', '금'],
  연금저축: ['배당주', '리츠', '채권', '해외주식'],
};

// gaps: computeRebalanceGaps(holdings).gaps(rebalance-gap.mjs, 이미 위탁+연금저축 합산
// 기준 목표 대비 갭을 계산해둔 것 — 여기서 새로 계산하지 않고 그대로 재사용). account
// 안에서 세금상 담을 수 있는 자산군만 남기고, "갭이 큰"(가장 부족한) 순으로 정렬한다.
// absDeltaPct = currentPct - targetPct 이므로 음수가 클수록(더 작을수록) 더 부족하다.
export function rankEligibleGaps(gaps, account) {
  const eligible = ACCOUNT_ELIGIBLE_ASSET_CLASSES[account];
  if (!eligible) return [];
  return gaps
    .filter((g) => eligible.includes(g.assetClass) && g.absDeltaPct < 0)
    .sort((a, b) => a.absDeltaPct - b.absDeltaPct);
}

// account 안에서 그 자산군에 이미 보유 중인 종목들 — Athena에게 "고를 수 있는 실존
// 후보"로 제시한다(신규 종목을 지어내지 않도록). holdings: State/Holdings 프론트매터 배열.
// 금현물은 위탁으로 정규화(rebalance-gap.mjs normalizeAccount) — 안 하면 위탁 계좌의
// 금 갭에 금99.99K(금현물 계좌 보유)가 실존 후보로 안 잡혀 신규 ETF를 지어내게 된다
// (2026-08-21 KODEX 골드선물(H) 오추천 사고의 실제 원인). account 쪽도 정규화한다 —
// 안 하면 findExistingInstruments(holdings, '금현물', '금')처럼 금현물을 조회 계좌로
// 넘겼을 때 normalizeAccount(h.account)가 절대 '금현물'을 반환하지 않아 항상 빈
// 배열이 나온다(코드리뷰 지적, 2026-08-21 — 금현물이 대시보드 1급 계좌 키로 승격되면서
// 이 비대칭이 실제로 호출될 가능성이 생김).
export function findExistingInstruments(holdings, account, assetClass) {
  const target = normalizeAccount(account);
  return holdings.filter((h) => normalizeAccount(h.account) === target && h.assetClass === assetClass);
}
