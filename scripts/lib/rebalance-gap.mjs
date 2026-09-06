// 5/25 리밸런싱 갭 계산 — 순수 함수(구현계획서 Phase 8, Hermes의 "기계적 계산" 몫).
// docs/ARCHITECTURE-V2.md "목표 배분 %" 절(확정 정본) + "리밸런싱 규칙 — Swedroe 5/25
// 룰" 절을 그대로 구현.
//
// ⚠️ 여기까지만 Node다 — 이탈이 확인된 뒤 "구체적으로 무엇을 팔고 살지"는 Athena의
// 재량 판단(위탁 내부 우선순위를 타이브레이커로만 참고, 고정 공식 아님)이라 이 모듈은
// 만들지 않는다("판단에 하드코딩 금지" 원칙 — feedback-no-hardcoded-judgment.md 메모리
// 참고). 이 모듈의 역할은 정확히 "지금 갭이 얼마고 밴드를 넘었는가"까지.

// 목표 배분 %(확정 정본, ARCHITECTURE-V2.md "목표 배분 % — 산출 방법론" 절) — 위탁+
// 연금저축 합산 자산에만 적용. ISA·IRP·현금성은 범위 밖.
//
// ⚠️ 2026-08-23 오너 확정 재조정 — 배당주5%·리츠5%를 삭제하고 달러10%를 신설.
// 이유: ISA가 이미 독자적으로(오너 수동 적립) 배당주·리츠 익스포션을 계속 쌓아가고
// 있어서(isa-exposure.mjs가 그 사실만 보고할 뿐 이 풀에 반영은 안 함, 의도된 설계),
// 이 통합 풀에 또 배당주5%·리츠5%를 잡아두면 이중 계산이 된다. 0으로 남기지 않고
// 키 자체를 삭제한 이유: 목표 0%면 checkBand의 relDeltaPct(상대이탈)가 절대 못
// 잡혀(0으로 나누는 분기라 항상 0) 절대이탈만 영구적으로 계속 [경고]를 울리게 된다
// (연금저축에 남아있는 기존 배당주·리츠 보유 ₩10.28M어치가 그 대상 — 강제 매도 안
// 하기로 확정했으니 이 보유는 조용히 목표비중 계산 밖으로 빠지는 게 맞다, 현금성·TDF와
// 동일 취급). "달러"는 allocation-snapshot.mjs가 이미 화면표시용 0%항목으로 별도
// 취급해오던 걸 정식 목표군으로 승격한 것 — 해외주식은 이미 미국주식 위주라 별도
// "달러 노출" 자산군을 또 만드는 대신 그냥 해외주식을 키우는 방안도 검토했으나,
// 오너가 미국달러ETF+엔선물ETF 분할매수라는 구체적 상품 계획을 갖고 있어 독립
// 자산군으로 신설.
export const TARGET_ALLOCATION = {
  채권: 20, 금: 10, 달러: 10, 국내주식: 30, 해외주식: 30,
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

// 위탁 레거시 개별종목 — 2트랙 확정 이전 매수분, 자산분배 트랙 자동판단(매도후보·매수후보
// 재사용 둘 다) 대상에서 하드 제외한다(2026-08-29 신설).
//
// ⚠️ 이건 "이름 패턴 추정"이 아니라 오너가 이미 명시적으로 확정한 목록의 그대로 옮김이다
// (Log/Strategy/2026-08-24-위탁-개별종목-전면매도-ETF전환-결정.md — 오너가 이 8종목
// 전량매도+ETF전환을 텔레그램 제안으로 이미 승인, "당장 실행 아님, 차차 전환" 중이라
// 지금(2026-08-29)도 holdings에 그대로 남아있다). Vault holdings 스키마에 ETF/개별주식
// 구분 필드가 없어 일반적으로는 못 거른다는 한계는 여전히 유효 — 이 목록은 "지금 확정된
// 8종목"만 안다는 뜻이라, 오너가 새로 다른 개별종목을 사면(위탁 레거시 정리와 무관하게)
// 이 목록이 자동으로 못 잡는다. 그런 경우가 생기면 이 Set에 수동으로 추가해야 한다 —
// 스키마 자체에 ETF/개별주식 구분 필드를 추가하는 게 근본 해법이지만 이번엔 범위 밖.
export const LEGACY_INDIVIDUAL_STOCKS = new Set([
  '삼성전자', '삼성전자(자사주)', 'SK하이닉스', '메리츠금융지주',
  '마이크로소프트', '알파벳 Class A', '엔비디아', '테슬라',
]);

export const isLegacyIndividualStock = (name) => LEGACY_INDIVIDUAL_STOCKS.has(name);

// holdings: State/Holdings 전체 배열({ account, assetClass, evalAmount, ... }).
// 위탁+연금저축만(금현물은 위탁으로 정규화), 그 안에서도 TARGET_ALLOCATION 5개 자산군만
// 분모에 포함한다 — 현금성·TDF·배당주·리츠 등은 원칙 자체가 배분 대상 밖이라 있어도
// 무시(제외가 아니라 애초에 범위 밖).
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

// 밴드가 "터지는" 바로 그 경계까지 남은 폭(%p, 부호 있음) — checkBand와 동일한 두
// 임계값(절대5%p·상대25%) 중 더 좁은 쪽이 실제 밴드 폭이라는 사실을 그대로 재사용한다
// (월간 거시틸트 잡의 틸트 규모 산정용, 2026-09-06 신설 — 아직 5/25 이탈 전이라 분기
// 리밸런싱의 "갭"이 없는 상태에서 "얼마나 틸트해도 안전한지"의 기준). room<=0이면
// 이미 이탈(분기 리밸런싱 소관) — 이 함수는 TARGET_ALLOCATION의 5개 자산군처럼
// targetPct>0인 입력만 상정한다(target 0%는 checkBand도 절대 임계값만 보는 특수
// 케이스라 이 공식이 안 맞음 — 이 저장소에 target 0%인 자산군은 없음).
export function computeBandEdgeDistance(targetPct, currentPct) {
  const edgeAbsDelta = Math.min(5, targetPct * 0.25);
  const currentAbsDelta = currentPct - targetPct;
  const room = edgeAbsDelta - Math.abs(currentAbsDelta);
  return { edgeAbsDelta, currentAbsDelta, room };
}

// 5개 자산군 전부에 대해 갭·밴드판정을 계산 — 이탈 없으면 협의체 자체가 조용히 종료
// 로그만 남기고 텔레그램 발송 없음(ARCHITECTURE-V2.md "실행 프로토콜" 절, 오너 확정).
export function computeRebalanceGaps(holdings) {
  const { totalEval, byClassEval, currentPct } = computeCurrentAllocation(holdings);
  const gaps = Object.entries(TARGET_ALLOCATION).map(([assetClass, targetPct]) => ({
    assetClass, targetPct, currentPct: currentPct[assetClass], currentEval: byClassEval[assetClass],
    ...checkBand(targetPct, currentPct[assetClass]),
  }));
  return { totalEval, gaps, anyBreached: gaps.some((g) => g.breached) };
}
