// Frank의 텔레그램 답장 → 어떤 Proposal에 어떤 조치를 할지 결정 — 순수 함수.
// 실제 파일 읽기/쓰기(Decisions/Proposals 조회, state-writer 갱신)는 호출부
// (scripts/tools/process-telegram-reply.mjs)가 수행한다.
//
// ⚠️ 의도적으로 "승인" 조치가 즉시 체결까지 가지 않는다 — 검문소(order-gate.mjs)를
// 통과시키려면 현재가·보유수량·예수금 등 실행 시점 데이터가 필요한데, 그건 Phase 8·9
// (자산분배·퀀트 트랙 부서 로직)가 준비하는 것이다. 이 모듈은 "대기 → 승인/거부"라는
// 상태 전이까지만 책임지고, 승인된 제안의 실제 체결(execute-proposal.mjs 호출)은
// 그 데이터를 갖춘 호출부의 몫으로 명시적으로 남긴다 — 데이터 없이 체결을 흉내 내지
// 않는다.
import { parseReplyDecision } from './telegram-messages.mjs';
import { findProposalByTelegramMessageId } from './proposal-vault.mjs';

// ⚠️ 텔레그램 플러그인이 <channel> 태그에 reply_to(Frank가 어느 메시지에 답했는지)를
// 노출하지 않는다(2026-08-12 발견, project-telegram-approval-flow 메모리) — 상시세션
// (com.banana2.telegram-session)으로 들어오는 승인/거부 답장은 진짜 reply_to를 못
// 받는다. 이 함수가 유일한 안전한 대체 경로: "대기" 상태 제안이 **정확히 1건**일 때만
// 그 telegramMessageId로 추론한다. 0건·2건 이상이면 절대 추정하지 않고 null(호출부가
// Frank에게 재확인하도록) — 예전엔 이 판단을 Zeus(LLM)가 매번 수동으로 Vault 파일을
// 세어 판별했는데, 이건 완전히 기계적 판정이라 Node 함수로 옮겨야 셀 때마다 실수할
// 여지가 없다(feedback-no-hardcoded-judgment와 같은 결 — 판단은 LLM, 카운트는 Node).
// 순수함수 — 테스트 가능.
export function inferReplyTargetFromPendingProposals(proposals) {
  const pending = proposals.filter((p) => p.status === '대기');
  if (pending.length === 0) {
    return { telegramMessageId: null, reason: '대기 중인 제안이 없습니다 — 무엇에 대한 답장인지 Frank에게 확인 필요' };
  }
  if (pending.length > 1) {
    const labels = pending.map((p) => p.id ?? p.assetKey ?? '(id 없음)').join(', ');
    return { telegramMessageId: null, reason: `대기 중인 제안이 ${pending.length}건이라 어느 것인지 추정할 수 없습니다(${labels}) — Frank에게 어느 제안인지 확인 필요` };
  }
  return { telegramMessageId: pending[0].telegramMessageId, reason: null };
}

// proposals: proposal-vault.parseProposal()로 이미 파싱된 배열(호출부가 Decisions/
// Proposals 디렉토리를 읽어 넘긴다 — 이 모듈은 fs를 만지지 않는다).
export function resolveReplyAction({ replyTo, replyText, proposals, now = new Date() }) {
  const decision = parseReplyDecision(replyText);
  if (!decision) {
    return { action: 'clarify', reason: '승인/거부 의사를 답장 텍스트에서 읽을 수 없습니다 — 재확인 요청' };
  }

  const proposal = findProposalByTelegramMessageId(proposals, replyTo);
  if (!proposal) {
    return { action: 'clarify', reason: 'reply_to가 가리키는 제안을 찾을 수 없습니다 — 추정하지 않고 재확인 요청' };
  }

  if (proposal.status !== '대기') {
    return { action: 'clarify', reason: `이미 처리된 제안입니다(현재 상태: ${proposal.status}) — 중복 처리 방지`, proposal };
  }

  if (decision === '거부') {
    return {
      action: 'reject',
      proposal,
      updates: { status: '거부', decidedAt: now.toISOString(), rejectReason: replyText },
    };
  }

  return {
    action: 'approve',
    proposal,
    updates: { status: '승인', decidedAt: now.toISOString() },
    nextStep: '체결하려면 현재가·보유수량·예수금 등을 갖춰 execute-proposal.mjs(runExecutionGateChecks)를 호출하세요 — 이 데이터는 Phase 8·9 부서 로직이 공급합니다.',
  };
}
