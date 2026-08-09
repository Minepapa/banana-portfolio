// 승인된 제안 → 검문소(order-gate.runExecutionGateChecks) 입력 조립 — 순수 함수.
// execute-quant-proposal.mjs 오케스트레이션 안에 이 조립 로직이 묻혀 있던 첫 버전은
// killSwitchContent를 gateInput에 담는 걸 빠뜨렸는데도 아무 데서도 안 잡혔다(코드리뷰
// CRITICAL 지적, 2026-08-07 — 킬스위치가 "읽히기만 하고 검문소엔 절대 안 전달"돼 Frank의
// "정지" 명령이 체결 시점에는 무력화되는 상태였음). 조립 자체를 여기로 뽑아 순수함수로
// 만들어야 이런 "필드 하나 빠짐"류가 테스트로 잡힌다.
export function buildGateInput({ proposal, currentPrice, holdings, cash, killSwitchContent, market = 'KR', alreadyExecutedIds = [] }) {
  const currentHoldingQty = holdings.find((h) => h.code === proposal.assetKey)?.qty ?? 0;
  const orderCost = proposal.quantity * proposal.proposedPrice;
  return {
    currentPrice,
    currentHoldingQty,
    availableCash: cash ?? 0,
    orderCost,
    // 호출부(execute-quant-proposal.mjs)가 executed-orders.mjs(영속 저장소)에서 읽어 넘긴다
    // — 기본값 []는 하위호환(구 호출부·테스트)용일 뿐, 실전 경로는 항상 실제 목록을 넘겨야
    // 한다(Phase 11, 2026-08-09 — 예전엔 이 값이 항상 빈 배열이라 크래시 후 재실행 시
    // 중복체결 위험이 있었다, 이제 해소).
    alreadyExecutedIds,
    // reply_to 자기매칭 — Frank의 실제 reply_to 위조 방어는 이미 telegram-reply-handler.mjs
    // (대기→승인 전이 시점)가 담당한다. 여기서는 "텔레그램 발송된 적 없이 승인 상태에
    // 도달한 이상 상태"(telegramMessageId가 애초에 null)만 잡는 자기일관성 체크다.
    replyTo: proposal.telegramMessageId,
    expectedProposalId: proposal.telegramMessageId,
    killSwitchContent,
    market,
  };
}
