import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProposalRecord, updateProposalRecord, parseProposal, proposalMatchKey,
  findActiveProposal, findRecentRejection, findProposalByTelegramMessageId,
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

test('buildProposalRecord: tags — account 있으면 계좌·종목 태그', () => {
  const { content } = buildProposalRecord({
    track: '자산분배', account: '위탁', assetKey: '테슬라', side: '매도', quantity: 1, proposedPrice: null, now,
  });
  assert.deepEqual(parseProposal(content).tags, ['계좌/위탁', '종목/테슬라']);
});

test('[오너 결정 2026-09-05] buildProposalRecord: account가 null인 퀀트 제안은 track("퀀트")으로 계좌 태그 대체', () => {
  const { content } = buildProposalRecord({ track: '퀀트', assetKey: '삼성전자', side: '매수', quantity: 10, proposedPrice: 71000, now });
  assert.deepEqual(parseProposal(content).tags, ['계좌/퀀트', '종목/삼성전자']);
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

test('[막아야 함] findActiveProposal: "승인" 상태도 활성으로 취급 — 같은 종목에 승인 두 건이 동시에 쌓이는 걸 막는다', () => {
  const approved = { ...parseProposal(buildProposalRecord({ track: '퀀트', assetKey: 'X', side: '매수', quantity: 1, proposedPrice: 100, now }).content), status: '승인' };
  const found = findActiveProposal([approved], { track: '퀀트', assetKey: 'X', side: '매수' });
  assert.equal(found.id, approved.id);
});

test('findActiveProposal: "체결"·"섀도우체결"·"거부"·"대체됨"은 최종 상태라 활성 아님', () => {
  for (const status of ['체결', '섀도우체결', '거부', '대체됨']) {
    const done = { ...parseProposal(buildProposalRecord({ track: '퀀트', assetKey: 'X', side: '매수', quantity: 1, proposedPrice: 100, now }).content), status };
    assert.equal(findActiveProposal([done], { track: '퀀트', assetKey: 'X', side: '매수' }), null, `status=${status}`);
  }
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

test('findProposalByTelegramMessageId: 정확히 일치하는 1건을 찾는다', () => {
  const p = { ...parseProposal(buildProposalRecord({ track: '퀀트', assetKey: 'X', side: '매수', quantity: 1, proposedPrice: 100, now }).content), telegramMessageId: 555 };
  const found = findProposalByTelegramMessageId([p], 555);
  assert.equal(found.id, p.id);
});

test('[막아야 함] findProposalByTelegramMessageId: 못 찾으면 추정하지 않고 null', () => {
  const p = { ...parseProposal(buildProposalRecord({ track: '퀀트', assetKey: 'X', side: '매수', quantity: 1, proposedPrice: 100, now }).content), telegramMessageId: 555 };
  assert.equal(findProposalByTelegramMessageId([p], 999), null);
  assert.equal(findProposalByTelegramMessageId([p], null), null);
});

test('[막아야 함] findProposalByTelegramMessageId: 같은 메시지ID가 둘 이상이면(모호) null — 아무거나 안 고름', () => {
  const p1 = { ...parseProposal(buildProposalRecord({ track: '퀀트', assetKey: 'X', side: '매수', quantity: 1, proposedPrice: 100, now }).content), telegramMessageId: 555 };
  const p2 = { ...parseProposal(buildProposalRecord({ track: '퀀트', assetKey: 'Y', side: '매수', quantity: 1, proposedPrice: 100, now }).content), telegramMessageId: 555 };
  assert.equal(findProposalByTelegramMessageId([p1, p2], 555), null);
});

test('findRecentRejection: 승인/체결된 건은 거부 이력으로 안 잡힘', () => {
  const approved = {
    ...parseProposal(buildProposalRecord({ track: '자산분배', assetKey: 'Y', side: '매도', quantity: 1, proposedPrice: 100, now }).content),
    status: '승인', decidedAt: now.toISOString(),
  };
  assert.equal(findRecentRejection([approved], { track: '자산분배', assetKey: 'Y', side: '매도', withinMs: 999999999, now }), null);
});

// 독립 코드리뷰 지적(2026-08-13, MEDIUM) — 승인 당일유효 자동만료(execute-quant-proposal.mjs
// isApprovalStale)가 한때 status를 "거부"로 재사용했는데, decidedAt(승인 시각)을 그대로 둔
// 채라 findRecentRejection이 "정말로 오너가 거부했다"고 오인해 24시간 재상정 쿨다운을
// 걸어버렸다(오너는 거부한 적이 없는데도) — "만료"라는 별개 상태로 분리해 고침.
test('[막아야 함] findRecentRejection: "만료"(당일유효 자동만료) 상태는 거부 이력으로 안 잡힘', () => {
  const expired = {
    ...parseProposal(buildProposalRecord({ track: '퀀트', assetKey: 'Z', side: '매수', quantity: 1, proposedPrice: 100, now }).content),
    status: '만료', decidedAt: now.toISOString(),
  };
  assert.equal(findRecentRejection([expired], { track: '퀀트', assetKey: 'Z', side: '매수', withinMs: 999999999, now }), null);
});
