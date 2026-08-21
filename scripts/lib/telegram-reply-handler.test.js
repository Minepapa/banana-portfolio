import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReplyAction, inferReplyTargetFromPendingProposals } from './telegram-reply-handler.mjs';
import { buildProposalRecord, parseProposal } from './proposal-vault.mjs';

function waitingProposal(overrides = {}) {
  const { content } = buildProposalRecord({ track: '퀀트', assetKey: '삼성전자', side: '매수', quantity: 10, proposedPrice: 71000 });
  return { ...parseProposal(content), telegramMessageId: 555, ...overrides };
}

test('승인 텍스트 + 정확한 reply_to → approve, 상태는 "승인"으로 전이', () => {
  const p = waitingProposal();
  const r = resolveReplyAction({ replyTo: 555, replyText: '승인', proposals: [p] });
  assert.equal(r.action, 'approve');
  assert.equal(r.updates.status, '승인');
  assert.ok(r.nextStep); // 즉시 체결하지 않고 다음 단계 안내
});

test('거부 텍스트 → reject, rejectReason에 원문 텍스트 보존', () => {
  const p = waitingProposal();
  const r = resolveReplyAction({ replyTo: 555, replyText: '거부 — 가격이 너무 높음', proposals: [p] });
  assert.equal(r.action, 'reject');
  assert.equal(r.updates.status, '거부');
  assert.equal(r.updates.rejectReason, '거부 — 가격이 너무 높음');
});

test('[막아야 함] 애매한 텍스트(승인/거부 판독 불가) → clarify, 상태 변경 없음', () => {
  const p = waitingProposal();
  const r = resolveReplyAction({ replyTo: 555, replyText: '음 좀 더 볼게', proposals: [p] });
  assert.equal(r.action, 'clarify');
  assert.equal(r.updates, undefined);
});

test('[막아야 함] reply_to가 안 맞으면(다른 메시지ID) 추정하지 않고 clarify', () => {
  const p = waitingProposal();
  const r = resolveReplyAction({ replyTo: 999, replyText: '승인', proposals: [p] });
  assert.equal(r.action, 'clarify');
});

test('[막아야 함] 이미 처리된 제안(대기 아님)에 대한 답장은 재처리하지 않고 clarify', () => {
  const p = waitingProposal({ status: '체결' });
  const r = resolveReplyAction({ replyTo: 555, replyText: '승인', proposals: [p] });
  assert.equal(r.action, 'clarify');
  assert.match(r.reason, /이미 처리/);
});

test('여러 제안 중 정확히 매칭되는 것만 대상으로 삼는다', () => {
  const p1 = waitingProposal({ telegramMessageId: 111 });
  const p2 = waitingProposal({ telegramMessageId: 222, id: 'other-id' });
  const r = resolveReplyAction({ replyTo: 222, replyText: '승인', proposals: [p1, p2] });
  assert.equal(r.proposal.id, 'other-id');
});

// inferReplyTargetFromPendingProposals — 텔레그램 플러그인이 reply_to를 안 주는
// 상시세션 경로의 유일한 안전한 대체. 대기 제안 개수가 정확히 1건일 때만 추론한다.
test('inferReplyTargetFromPendingProposals: 대기 제안이 정확히 1건이면 그 telegramMessageId 반환', () => {
  const p = waitingProposal({ telegramMessageId: 777 });
  const r = inferReplyTargetFromPendingProposals([p]);
  assert.equal(r.telegramMessageId, 777);
  assert.equal(r.reason, null);
});

test('[막아야 함] inferReplyTargetFromPendingProposals: 대기 제안이 0건이면 추정하지 않고 null', () => {
  const p = waitingProposal({ status: '체결' });
  const r = inferReplyTargetFromPendingProposals([p]);
  assert.equal(r.telegramMessageId, null);
  assert.match(r.reason, /없습니다/);
});

test('[막아야 함] inferReplyTargetFromPendingProposals: 대기 제안이 2건 이상이면 추정하지 않고 null(오승인 방지)', () => {
  const p1 = waitingProposal({ telegramMessageId: 111, id: 'a' });
  const p2 = waitingProposal({ telegramMessageId: 222, id: 'b' });
  const r = inferReplyTargetFromPendingProposals([p1, p2]);
  assert.equal(r.telegramMessageId, null);
  assert.match(r.reason, /2건/);
});
