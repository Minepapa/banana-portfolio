import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDailyAllocationGate, createAndSendProposal } from './proposal-flow.mjs';

const NOW = new Date('2026-10-01T07:30:00Z'); // KST 16:30
const today = (assetClass, extra = {}) => ({ track: '자산분배', assetClass, createdAt: '2026-10-01T07:21:00Z', status: '대기', ...extra });

test('같은 날 같은 자산군 1건·하루 2건 상한, 자산군 없는 제안·어제 제안·실패 건은 세지 않는다(2026-10-10)', () => {
  assert.match(checkDailyAllocationGate({ existingProposals: [today('금')], assetClass: '금', now: NOW }), /오늘 이미 금 제안/);
  assert.equal(checkDailyAllocationGate({ existingProposals: [today('금')], assetClass: '채권', now: NOW }), null);
  assert.match(checkDailyAllocationGate({ existingProposals: [today('금'), today('채권')], assetClass: '달러', now: NOW }), /2건 상한/);
  const ignored = [today('금', { status: '발송오류' }), today('금', { status: '거부', rejectTag: '결함' }), today('금', { createdAt: 'broken' }), { track: '자산분배', createdAt: '2026-10-01T07:00:00Z', status: '대기' },
    today('금', { createdAt: '2026-09-30T07:00:00Z' })];
  assert.equal(checkDailyAllocationGate({ existingProposals: ignored, assetClass: '금', now: NOW }), null);
});

test('createAndSendProposal: 자산분배 자동 제안은 관문에서 막히고(발송 없음), 진입 시점은 사유 맨 앞에 붙는다', async () => {
  const sent = [];
  const written = [];
  const base = { track: '자산분배', account: '연금저축', assetKey: 'TIGER KRX금현물', side: '매수', quantity: 1, proposedPrice: 10000,
    reason: '판단 서술', now: NOW, writeProposalFile: async (f, c) => { written.push(c); }, sendMessage: async (m) => { sent.push(m); return { message_id: 1 }; } };
  const blocked = await createAndSendProposal({ ...base, existingProposals: [today('금')], assetClass: '금', timing: '분기 정기 점검' });
  assert.equal(blocked.action, 'deferred', '관문에 막히면 미룸(다음 실행에서 이어서)');
  assert.equal(sent.length, 0);
  const created = await createAndSendProposal({ ...base, existingProposals: [], assetClass: '금', timing: '분기 정기 점검' });
  assert.equal(created.action, 'created');
  assert.match(written.at(-1), /assetClass: "?금"?/);
  assert.match(written.at(-1), /진입 시점: 분기 정기 점검/);
  const direct = await createAndSendProposal({ ...base, existingProposals: [today('금'), today('채권')] });
  assert.equal(direct.action, 'created', '자산군을 넘기지 않는 오너 직접 주문은 관문 적용 안 함');
});

test('keepPending: 같은 안건이 대기·승인 중이면 다시 보내지 않고 pending을 돌려준다(리뷰 HIGH — 다음 날 대체 발송 반복 방지)', async () => {
  const sent = [];
  const base = { track: '자산분배', account: '위탁', assetKey: 'X', side: '매수', quantity: 1, proposedPrice: 10000, reason: 'r',
    now: NOW, writeProposalFile: async () => {}, sendMessage: async (m) => { sent.push(m); return { message_id: 2 }; } };
  const yesterday = { id: 'P1', track: '자산분배', assetKey: 'X', side: '매수', status: '대기', createdAt: '2026-09-30T07:00:00Z' };
  const kept = await createAndSendProposal({ ...base, existingProposals: [yesterday], keepPending: true });
  assert.equal(kept.action, 'pending');
  assert.equal(sent.length, 0);
});
