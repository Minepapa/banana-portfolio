// 승인된 제안을 실제로 처리하는 오케스트레이션 — docs/ARCHITECTURE-V2.md "실행 흐름
// (주문)" 4단계("결정론적 검문소 통과 → 브로커 API로 자동 체결")의 구현.
//
// 이 모듈은 **의도적으로 Facts/Ledger를 전혀 건드리지 않는다**(import조차 안 함) —
// Ledger는 오직 실제 체결 확인 경로(카카오 알림 파싱, Phase 11의 브로커 API 응답)로만
// 채워진다는 게 이 프로젝트의 구조다. 섀도우 체결이 Ledger에 안 섞이는 걸 "조심해서"
// 보장하는 게 아니라,애초에 여기서 Ledger로 가는 길 자체가 없다 — 완료 기준
// ("섀도우 로그가 Facts/Ledger에는 안 섞인다")이 코드 구조로 강제된다.
import { runExecutionGateChecks } from './order-gate.mjs';
import { settleExecution } from './shadow-mode.mjs';
import { updateProposalRecord } from './proposal-vault.mjs';

// proposal: proposal-vault.parseProposal()로 읽은 객체(+원본 content).
// gateInput: runExecutionGateChecks가 요구하는 나머지 입력(현재가·보유수량·예수금·
// reply_to·킬스위치 content 등 — 전부 호출부가 이미 조회해서 넘긴다, 이 모듈은
// 조회하지 않는다).
// mode: shadow-mode.getExecutionMode()의 반환값('섀도우'|'실전').
export async function executeProposal({ proposal, proposalContent, gateInput, mode, liveExecutor }) {
  const gate = runExecutionGateChecks({
    proposalId: proposal.id,
    proposedPrice: proposal.proposedPrice,
    side: proposal.side,
    quantity: proposal.quantity,
    ...gateInput,
  });

  if (!gate.pass) {
    return {
      executed: false,
      gate,
      updatedContent: updateProposalRecord(proposalContent, {
        // 검문소 차단은 "거부"가 아니다(Frank가 거부한 게 아니라 기계적으로 막힌 것) —
        // 상태는 "대기"로 유지하고 사유만 남겨, 원인 해소 후 같은 승인으로 재시도 가능하게 한다.
        gateBlockedReason: gate.failures.map((f) => `${f.check}: ${f.reason}`).join('; '),
      }),
    };
  }

  const settlement = await settleExecution({ mode, proposal, liveExecutor });
  const updatedContent = updateProposalRecord(proposalContent, {
    status: settlement.status,
    executedAt: new Date().toISOString(),
    executionLog: settlement.log ?? '',
    gateBlockedReason: null,
  });

  return { executed: true, gate, settlement, updatedContent };
}
