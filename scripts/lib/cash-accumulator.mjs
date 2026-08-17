// 계좌별 "배당·매도체결로 생긴 미투자 현금" 누적 — 순수 함수(ARCHITECTURE-V2.md
// "신규 현금 배분 원칙" 절, 구현계획서 Phase 8이 열어둔 채 남겨뒀던 항목).
//
// 트리거는 계좌당 누적 50만원↑(오너 확정, 2026-08-04) — 소액 배당마다 알림이 뜨는 걸
// 막기 위한 문턱값. 이벤트 기반(카카오 알림 파싱 직후)이지 폴링이 아니다 — 이 모듈은
// "지금까지 안 센 이벤트를 더하면 얼마고, 이번에 처음으로 문턱을 넘었는가"만 판정한다.
//
// dedupKey 기반 멱등 — 같은 이벤트를 여러 번 넘겨도(잡이 재실행돼 겹치는 배치를 다시
// 읽어도) 한 번만 반영된다(update-holdings-from-executions.mjs의 appliedDedupKeys와
// 동일 원칙).

export const NEW_CASH_THRESHOLD_WON = 500_000;

// 이 기능의 적용 범위 — 위탁·연금저축만(ARCHITECTURE-V2.md "신규 현금 배분 원칙" 절,
// rebalance-gap.mjs TARGET_ALLOCATION과 동일 범위: ISA·IRP·퀀트는 대상 밖).
export const CASH_ELIGIBLE_ACCOUNTS = new Set(['위탁', '연금저축']);

// existing: { accumulatedAmount, appliedDedupKeys } | null (State/CashAccumulator/{계좌}.md
// 프론트매터, 없으면 최초 실행). events: [{ dedupKey, amount }] — 배당 afterTaxAmount 또는
// 매도 실현손익 기록의 proceeds(quantity*sellPrice)만 넘긴다(realizedProfit 아님 — 매도로
// 실제 손에 들어오는 현금은 전액이지 손익 부분만이 아니다).
//
// 반환: { accumulatedAmount, appliedDedupKeys, addedCount, crossed }. crossed=true는 "이번
// 호출로 처음 문턱을 넘었다"는 뜻(이미 넘어있던 상태로 또 들어오면 false — 중복 트리거
// 방지, 트리거 후 resetAccumulator로 0부터 다시 세는 게 전제).
export function applyCashEvents(existing, events) {
  const appliedKeys = new Set(existing?.appliedDedupKeys ?? []);
  let amount = existing?.accumulatedAmount ?? 0;
  const wasOver = amount >= NEW_CASH_THRESHOLD_WON;
  let addedCount = 0;
  for (const e of events ?? []) {
    if (!e?.dedupKey || appliedKeys.has(e.dedupKey)) continue;
    if (!Number.isFinite(e.amount) || e.amount <= 0) continue;
    appliedKeys.add(e.dedupKey);
    amount += e.amount;
    addedCount++;
  }
  const crossed = !wasOver && amount >= NEW_CASH_THRESHOLD_WON;
  return { accumulatedAmount: amount, appliedDedupKeys: [...appliedKeys], addedCount, crossed };
}

// 제안 발송 성공 직후 호출 — 다음 사이클을 0부터 다시 센다. appliedDedupKeys도 비운다
// (리셋 이전 이벤트는 이미 이번 트리거에 반영됐으니 더 들고 있을 이유가 없음 — 무한정
// 누적되는 걸 방지).
export function resetAccumulator() {
  return { accumulatedAmount: 0, appliedDedupKeys: [] };
}
