// 실주문 체결감시기가 Proposal 상태를 접수→부분체결→체결/취소로 전이한다.
// 파일 락 안에서 최신 상태를 다시 읽어 갱신해, 다른 필드의 동시 변경을 덮지 않는다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProposal, updateProposalRecord } from './proposal-vault.mjs';
import { writeAtomic, withLock } from './state-writer.mjs';

const WATCHABLE_STATUSES = new Set(['주문접수', '부분체결']);
const FINAL_STATUSES = new Set(['체결', '취소']);

export function buildExecutionStatusUpdates({ status, now = new Date(), filledQty = null, avgFillPrice = null }) {
  if (status === '부분체결') {
    return {
      status,
      partialFilledQty: filledQty,
      partialUpdatedAt: now.toISOString(),
    };
  }
  if (status === '체결') {
    return {
      status,
      executedAt: now.toISOString(),
      filledQuantity: filledQty,
      avgFillPrice,
    };
  }
  if (status === '취소') {
    return {
      status,
      canceledAt: now.toISOString(),
      ...(filledQty != null ? { filledQuantity: filledQty } : {}),
      ...(avgFillPrice != null ? { avgFillPrice } : {}),
    };
  }
  throw new Error(`지원하지 않는 실주문 상태: ${status}`);
}

export async function recordProposalExecutionStatus({ proposalsDir, proposalId, brokerOrderId, status, now, filledQty, avgFillPrice }) {
  if (!proposalId || !/^[\p{L}\p{N}_.-]+$/u.test(proposalId)) return false;
  if (!WATCHABLE_STATUSES.has(status) && !FINAL_STATUSES.has(status)) return false;
  const filepath = join(proposalsDir, `${proposalId}.md`);
  return withLock(filepath, () => {
    let content;
    try {
      content = readFileSync(filepath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    const current = parseProposal(content);
    if (!brokerOrderId || String(current.brokerOrderId ?? '') !== String(brokerOrderId)) return false;
    if (!WATCHABLE_STATUSES.has(current.status)) return false;
    if (current.status === '부분체결' && status === '부분체결') {
      if (current.partialFilledQty === filledQty) return false;
    }
    const updates = buildExecutionStatusUpdates({ status, now, filledQty, avgFillPrice });
    writeAtomic(filepath, updateProposalRecord(content, updates));
    return true;
  });
}
