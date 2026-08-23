// ISA 3계좌 합산 노출 보고 — 순수 함수(구현계획서 Phase 8, Phase 8 4/4 컴포넌트).
// docs/ARCHITECTURE-V2.md "ISA 담당 부서 — Athena" 절(2026-08-04 확정) 그대로 구현.
//
// 배경: 목표비중(rebalance-gap.mjs TARGET_ALLOCATION)은 위탁+연금저축 합산에만 적용되고
// ISA는 계산에서 완전히 빠진다. 그런데 ISA가 담는 자산(배당·리츠·채권)이 연금저축의
// 담당 자산군과 그대로 겹쳐서, ISA 잔액이 크면 "시스템이 보여주는 목표비중"보다 실제
// 총자산 기준 인컴자산 노출이 훨씬 클 수 있다 — 아무도 그 차이를 안 보여주고 있었다.
//
// ⚠️ 이 모듈은 **보고 전용**이다 — 목표비중 계산 자체는 여전히 위탁+연금저축만 대상으로
// 그대로 두고(설계서 확정), 여기서 계산한 3계좌 합산 노출은 위탁·연금저축 매수량을
// 자동으로 줄이는 데 쓰이지 않는다. "이중노출을 자동 보정하지 않고 오너에게 보이게만
// 한다" — 최종 판단은 오너 재량(Zeus 의사결정 범위 원칙과 일치).
import { normalizeAccount } from './rebalance-gap.mjs';

const EXPOSURE_ACCOUNTS = new Set(['위탁', '연금저축', 'ISA']);

// ISA가 담는 자산군과 겹치는 3종(설계서 명시) — 이 3개만 별도 보고 대상.
export const OVERLAP_CLASSES = ['배당주', '리츠', '채권'];

// holdings: State/Holdings 전체 배열. 분모는 3계좌의 **전체** 평가액(현금성·달러 포함) —
// rebalance-gap.mjs의 5개 자산군 한정 분모와 다르다. "실제 총자산 기준" 노출을 보이는
// 게 목적이라 일부러 좁히지 않는다(이게 좁혀지면 원래 발견됐던 이중노출 공백을 이 모듈
// 스스로 다시 재현하게 됨).
export function computeThreeAccountExposure(holdings) {
  // 금현물은 위탁으로 정규화(rebalance-gap.mjs normalizeAccount) — 안 하면 "실제 총자산
  // 기준"이라는 이 모듈의 취지와 달리 금현물 평가액이 분모에서 빠져 배당주·채권·리츠
  // 비중이 실제보다 부풀려진다(2026-08-21 발견).
  const inScope = holdings.filter((h) => EXPOSURE_ACCOUNTS.has(normalizeAccount(h.account)));
  const totalEval = inScope.reduce((s, h) => s + (h.evalAmount ?? 0), 0);
  const byClassEval = Object.fromEntries(OVERLAP_CLASSES.map((c) => [c, 0]));
  const byClassIsaEval = Object.fromEntries(OVERLAP_CLASSES.map((c) => [c, 0]));
  for (const h of inScope) {
    if (!OVERLAP_CLASSES.includes(h.assetClass)) continue;
    byClassEval[h.assetClass] += h.evalAmount ?? 0;
    if (h.account === 'ISA') byClassIsaEval[h.assetClass] += h.evalAmount ?? 0;
  }
  const exposurePct = Object.fromEntries(
    OVERLAP_CLASSES.map((c) => [c, totalEval > 0 ? (byClassEval[c] / totalEval) * 100 : 0]),
  );
  // ISA가 정확히 얼마(원)를 이 자산군에 보태고 있는지 — 코드리뷰 지적(2026-08-05):
  // exposurePct(3계좌·전체분모)와 rebalance-gap.mjs의 currentPct(위탁+연금저축·6개
  // 자산군분모)는 분자·분모가 둘 다 달라 단순 뺄셈이 "ISA 때문에 커진 양"을 뜻하지
  // 않는다(위탁·연금저축에 현금성 비중이 크면 오히려 반대로 나올 수 있음 — 서로 다른
  // 잣대를 빼면 숫자는 나오지만 의미가 없다). ISA의 절대 기여액은 어느 잣대와도
  // 섞이지 않는 단일 기준 숫자라 안전하게 보고할 수 있다.
  return { totalEval, byClassEval, byClassIsaEval, exposurePct };
}

// ISA 계좌만 따로 뽑은 요약 — "ISA 배당전략·보유내역 분기점검"용(설계서). 강제 리밸런싱
// 판정은 하지 않는다(ISA는 손익통산 구조상 잦은 회전이 불리할 수 있어 신중히 — 설계서
// 명시) — 여기선 현재 보유 현황만 사실로 낸다, 필요 여부 판단은 Athena 몫.
export function summarizeIsaHoldings(holdings) {
  const isa = holdings.filter((h) => h.account === 'ISA');
  const totalEval = isa.reduce((s, h) => s + (h.evalAmount ?? 0), 0);
  return {
    totalEval,
    items: isa.map((h) => ({
      name: h.name, assetClass: h.assetClass, evalAmount: h.evalAmount ?? 0,
      weightPct: totalEval > 0 ? ((h.evalAmount ?? 0) / totalEval) * 100 : 0,
      profitPct: h.profitPct ?? null,
    })),
  };
}
