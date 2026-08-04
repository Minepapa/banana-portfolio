import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProposalRecord, updateProposalRecord, parseProposal, proposalMatchKey,
  findActiveProposal, findRecentRejection,
} from './proposal-vault.mjs';

const now = new Date('2026-08-05T09:00:00.000Z');

test('buildProposalRecord: 대기 상태로 생성, 필수 필드 포함', () => {
  const { id, filename, content } = buildProposalRecord({
    track: '자산분배', account: '위탁', assetKey: '국내주식', side: '매수',
    quantity: 5000000, proposedPrice: null, reason: '5/25 밴드 이탈', now,
  });
  const p = parseProposal(content);
  assert.equal(p.status, '대기');
  assert.equal(p.track, '자산분배');
  assert.equal(p.assetKey, '국내주식');
  assert.equal(p.decidedAt, null);
  assert.equal(filename, `${id}.md`);
  assert.match(id, /^자산분배-매수-국내주식-/);
});

test('updateProposalRecord: 상태 전이(대기→승인) — 다른 필드는 보존', () => {
  const { content } = buildProposalRecord({ track: '퀀트', assetKey: '삼성전자', side: '매수', quantity: 10, proposedPrice: 71000, now });
  const updated = updateProposalRecord(content, { status: '승인', decidedAt: '2026-08-05T09:10:00.000Z' });
  const p = parseProposal(updated);
  assert.equal(p.status, '승인');
  assert.equal(p.decidedAt, '2026-08-05T09:10:00.000Z');
  assert.equal(p.assetKey, '삼성전자'); // 안 건드린 필드는 그대로
  assert.equal(p.quantity, 10);
});

test('proposalMatchKey: track+assetKey+side가 같으면 같은 키', () => {
  const a = proposalMatchKey({ track: '퀀트', assetKey: 'SK하이닉스', side: '매수' });
  const b = proposalMatchKey({ track: '퀀트', assetKey: 'SK하이닉스', side: '매수' });
  const c = proposalMatchKey({ track: '퀀트', assetKey: 'SK하이닉스', side: '매도' }); // 방향 다름
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('findActiveProposal: 같은 안건의 "대기" 상태 중 가장 최근 것을 찾는다', () => {
  const p1 = parseProposal(buildProposalRecord({ track: '퀀트', assetKey: 'X', side: '매수', quantity: 1, proposedPrice: 100, now: new Date('2026-08-05T08:00:00.000Z') }).content);
  const p2 = { ...parseProposal(buildProposalRecord({ track: '퀀트', assetKey: 'X', side: '매수', quantity: 2, proposedPrice: 100, now: new Date('2026-08-05T09:00:00.000Z') }).content) };
  const found = findActiveProposal([p1, p2], { track: '퀀트', assetKey: 'X', side: '매수' });
  assert.equal(found.quantity, 2); // 더 최근 것
});

test('findActiveProposal: 상태가 "대기"가 아니면(이미 처리됨) 후보에서 제외', () => {
  const done = { ...parseProposal(buildProposalRecord({ track: '퀀트', assetKey: 'X', side: '매수', quantity: 1, proposedPrice: 100, now }).content), status: '체결' };
  assert.equal(findActiveProposal([done], { track: '퀀트', assetKey: 'X', side: '매수' }), null);
});

test('findActiveProposal: 다른 종목/방향은 안 걸린다', () => {
  const p = parseProposal(buildProposalRecord({ track: '퀀트', assetKey: 'X', side: '매수', quantity: 1, proposedPrice: 100, now }).content);
  assert.equal(findActiveProposal([p], { track: '퀀트', assetKey: 'Y', side: '매수' }), null);
  assert.equal(findActiveProposal([p], { track: '퀀트', assetKey: 'X', side: '매도' }), null);
});

test('findRecentRejection: withinMs 이내 거부 이력이 있으면 반환', () => {
  const rejected = {
    ...parseProposal(buildProposalRecord({ track: '자산분배', assetKey: 'Y', side: '매도', quantity: 1, proposedPrice: 100, now: new Date('2026-08-05T08:00:00.000Z') }).content),
    status: '거부', decidedAt: '2026-08-05T08:05:00.000Z',
  };
  const found = findRecentRejection([rejected], { track: '자산분배', assetKey: 'Y', side: '매도', withinMs: 24 * 60 * 60 * 1000, now: new Date('2026-08-05T09:00:00.000Z') });
  assert.ok(found);
});

test('findRecentRejection: withinMs 밖(오래된 거부)은 안 걸린다', () => {
  const rejected = {
    ...parseProposal(buildProposalRecord({ track: '자산분배', assetKey: 'Y', side: '매도', quantity: 1, proposedPrice: 100, now: new Date('2026-08-01T08:00:00.000Z') }).content),
    status: '거부', decidedAt: '2026-08-01T08:05:00.000Z',
  };
  const found = findRecentRejection([rejected], { track: '자산분배', assetKey: 'Y', side: '매도', withinMs: 24 * 60 * 60 * 1000, now: new Date('2026-08-05T09:00:00.000Z') });
  assert.equal(found, null);
});

test('findRecentRejection: 승인/체결된 건은 거부 이력으로 안 잡힘', () => {
  const approved = {
    ...parseProposal(buildProposalRecord({ track: '자산분배', assetKey: 'Y', side: '매도', quantity: 1, proposedPrice: 100, now }).content),
    status: '승인', decidedAt: now.toISOString(),
  };
  assert.equal(findRecentRejection([approved], { track: '자산분배', assetKey: 'Y', side: '매도', withinMs: 999999999, now }), null);
});
