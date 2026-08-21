// 5/25 리밸런싱 갭 계산 — 순수 함수(구현계획서 Phase 8, Hermes의 "기계적 계산" 몫).
// docs/ARCHITECTURE-V2.md "목표 배분 %" 절(확정 정본) + "리밸런싱 규칙 — Swedroe 5/25
// 룰" 절을 그대로 구현.
//
// ⚠️ 여기까지만 Node다 — 이탈이 확인된 뒤 "구체적으로 무엇을 팔고 살지"는 Athena의
// 재량 판단(위탁 내부 우선순위를 타이브레이커로만 참고, 고정 공식 아님)이라 이 모듈은
// 만들지 않는다("판단에 하드코딩 금지" 원칙 — feedback-no-hardcoded-judgment.md 메모리
// 참고). 이 모듈의 역할은 정확히 "지금 갭이 얼마고 밴드를 넘었는가"까지.

// 목표 배분 %(확정 정본, ARCHITECTURE-V2.md "목표 배분 % — 산출 방법론" 절) — 위탁+
// 연금저축 합산 자산에만 적용. ISA·IRP·현금성·달러(잔여 헤지성 소액)는 범위 밖.
export const TARGET_ALLOCATION = {
  채권: 20, 금: 10, 배당주: 5, 리츠: 5, 국내주식: 30, 해외주식: 30,
};

const IN_SCOPE_ACCOUNTS = new Set(['위탁', '연금저축']);

// 금현물은 실제 매매·보유가 위탁과 별개 계좌에서 이뤄지지만(ARCHITECTURE-V2.md "금현물의
// 실제 거래 계좌는 위탁과 별개다" 각주), 자산배분 계산(목표비중 갱신)에는 위탁 소속으로
// 합산한다고 이미 확정돼 있다 — cash-ledger.mjs CASH_ELIGIBLE_ACCOUNTS/new-cash-
// allocation.mjs의 금현물→위탁 합산과 동일한 규칙.
const ACCOUNT_ALIASES = Object.assign(Object.create(null), { 금현물: '위탁' });
// cash-allocation-candidates.mjs findExistingInstruments 등 계좌명을 직접 비교하는
// 다른 소비자도 같은 정규화가 필요해 export한다(2026-08-21 코드리뷰 지적 — 이 규칙을
// 여러 곳에 각자 하드코딩하면 다음 소비자가 또 이 버그를 반복한다).
export const normalizeAccount = (account) => ACCOUNT_ALIASES[account] ?? account;

// holdings: State/Holdings 전체 배열({ account, assetClass, evalAmount, ... }).
// 위탁+연금저축만(금현물은 위탁으로 정규화), 그 안에서도 TARGET_ALLOCATION 6개 자산군만
// 분모에 포함한다 — 현금성·달러·TDF 등은 원칙 자체가 배분 대상 밖이라 있어도 무시(제외가
// 아니라 애초에 범위 밖).
export function computeCurrentAllocation(holdings) {
  const inScope = holdings.filter((h) => IN_SCOPE_ACCOUNTS.has(normalizeAccount(h.account)) && TARGET_ALLOCATION[h.assetClass] != null);
  const byClassEval = Object.fromEntries(Object.keys(TARGET_ALLOCATION).map((c) => [c, 0]));
  for (const h of inScope) byClassEval[h.assetClass] += h.evalAmount ?? 0;
  const totalEval = Object.values(byClassEval).reduce((s, v) => s + v, 0);
  const currentPct = Object.fromEntries(
    Object.keys(TARGET_ALLOCATION).map((c) => [c, totalEval > 0 ? (byClassEval[c] / totalEval) * 100 : 0]),
  );
  return { totalEval, byClassEval, currentPct };
}

// Swedroe 5/25 룰: 절대 5%p 이탈 OR 목표비중의 상대 25% 이탈, 둘 중 먼저 걸리는 쪽.
// 20% 목표에서 둘이 정확히 같은 지점(5%p = 20%*25%)이라는 게 설계서에 확정된 사실 —
// 두 조건을 OR로만 판정해도 "먼저 걸리는 쪽"이 자동으로 반영된다(둘 중 하나라도 걸리면
// 그게 곧 더 좁은 쪽이 걸렸다는 뜻이므로 별도로 "어느 게 더 좁은지" 계산할 필요 없음).
export function checkBand(targetPct, currentPct) {
  const absDelta = currentPct - targetPct;
  const relDeltaPct = targetPct > 0 ? (Math.abs(absDelta) / targetPct) * 100 : 0;
  const absBreach = Math.abs(absDelta) >= 5;
  const relBreach = relDeltaPct >= 25;
  const breachType = absBreach && relBreach ? '절대+상대' : absBreach ? '절대' : relBreach ? '상대' : null;
  return { absDeltaPct: absDelta, relDeltaPct, breached: absBreach || relBreach, breachType };
}

// 6개 자산군 전부에 대해 갭·밴드판정을 계산 — 이탈 없으면 협의체 자체가 조용히 종료
// 로그만 남기고 텔레그램 발송 없음(ARCHITECTURE-V2.md "실행 프로토콜" 절, 오너 확정).
export function computeRebalanceGaps(holdings) {
  const { totalEval, byClassEval, currentPct } = computeCurrentAllocation(holdings);
  const gaps = Object.entries(TARGET_ALLOCATION).map(([assetClass, targetPct]) => ({
    assetClass, targetPct, currentPct: currentPct[assetClass], currentEval: byClassEval[assetClass],
    ...checkBand(targetPct, currentPct[assetClass]),
  }));
  return { totalEval, gaps, anyBreached: gaps.some((g) => g.breached) };
}
