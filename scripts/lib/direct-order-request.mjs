// 오너 직접주문 요청 멱등성. 원본 Telegram 요청 ID를 영속화하고, 동일 요청의
// 중복검사와 제안 저장을 파일락 안에서 수행해 재전달·동시호출 중복주문을 막는다.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from './state-writer.mjs';
import { parseProposal, updateProposalRecord } from './proposal-vault.mjs';

export function validateDirectOrderRequestId(requestId) {
  const value = String(requestId ?? '').trim();
  // Caller-supplied nonce is not sufficient: a retry could mint a new value and evade dedup.
  // Require the source Telegram chat and message IDs so the key is bound to the originating event.
  return /^telegram:-?\d{1,20}:\d{1,20}$/.test(value) ? value : null;
}

export async function createDirectOrderProposalOnce({
  requestId,
  proposalsDir,
  loadProposals,
  findActive,
  createProposal,
  writeProposal,
}) {
  const stableRequestId = validateDirectOrderRequestId(requestId);
  if (!stableRequestId) return { action: 'invalid-request-id' };
  mkdirSync(proposalsDir, { recursive: true });

  // 모든 직접주문 생성자를 짧게 직렬화한다. 파일시스템 일시정지 중에도 시간만으로
  // 살아있는 락을 탈취하지 않도록 자동 만료를 사실상 끈다. 비정상 종료로 락이 남으면
  // withLock이 제한 재시도 후 실패하므로 프로세스 종료를 확인하고 수동 정리해야 한다.
  // lock은 기존 proposal 디렉토리에 두고 실제 제안 파일은 .md만 스캔한다.
  return withLock(join(proposalsDir, '.direct-order-request'), async () => {
    const proposals = await loadProposals();
    const duplicate = proposals.find((proposal) => proposal.directOrderRequestId === stableRequestId);
    if (duplicate) return { action: 'duplicate-request', proposal: duplicate };

    const active = await findActive(proposals);
    if (active) return { action: 'active-proposal', proposal: active };

    const draft = await createProposal();
    const content = updateProposalRecord(draft.content, {
      status: '승인',
      decidedAt: new Date().toISOString(),
      telegramMessageId: `직접주문:${draft.id}`,
      directOrderRequestId: stableRequestId,
    });
    await writeProposal(draft.filename, content);
    return {
      action: 'created',
      proposal: { ...draft, content, ...parseProposal(content) },
    };
  }, { staleLockMs: Number.MAX_SAFE_INTEGER });
}
