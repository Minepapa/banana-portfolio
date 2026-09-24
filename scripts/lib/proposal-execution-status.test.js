import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProposalRecord, parseProposal, updateProposalRecord } from './proposal-vault.mjs';
import { buildExecutionStatusUpdates, recordProposalExecutionStatus } from './proposal-execution-status.mjs';

const now = new Date('2026-09-24T02:00:00.000Z');

test('실주문 감시 상태: 부분체결과 전량체결 시각·수량을 따로 기록한다', () => {
  assert.deepEqual(buildExecutionStatusUpdates({ status: '부분체결', filledQty: 3, now }), {
    status: '부분체결', partialFilledQty: 3, partialUpdatedAt: now.toISOString(),
  });
  assert.deepEqual(buildExecutionStatusUpdates({ status: '체결', filledQty: 10, avgFillPrice: 71000, now }), {
    status: '체결', executedAt: now.toISOString(), filledQuantity: 10, avgFillPrice: 71000,
  });
  assert.equal(buildExecutionStatusUpdates({ status: '취소', now }).status, '취소');
  assert.deepEqual(buildExecutionStatusUpdates({ status: '취소', filledQty: 3, avgFillPrice: 70500, now }), {
    status: '취소', canceledAt: now.toISOString(), filledQuantity: 3, avgFillPrice: 70500,
  });
  assert.throws(() => buildExecutionStatusUpdates({ status: '승인', now }), /지원하지 않는/);
});

test('주문접수 Proposal은 API 전량체결 확인 뒤에만 체결로 바뀐다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-fill-'));
  try {
    const proposal = buildProposalRecord({
      track: '자산분배', account: '위탁', assetKey: '삼성전자', side: '매수',
      quantity: 10, proposedPrice: 71000, now,
    });
    const path = join(dir, proposal.filename);
    const accepted = updateProposalRecord(proposal.content, { status: '주문접수', brokerOrderId: '847026' });
    writeFileSync(path, accepted);

    assert.equal(await recordProposalExecutionStatus({
      proposalsDir: dir, proposalId: proposal.id, brokerOrderId: '847026', status: '체결', filledQty: 10, avgFillPrice: 71000, now,
    }), true);
    const final = parseProposal(readFileSync(path, 'utf8'));
    assert.equal(final.status, '체결');
    assert.equal(final.executedAt, now.toISOString());
    assert.equal(final.filledQuantity, 10);
    assert.equal(final.assetKey, '삼성전자');
    assert.equal(final.quantity, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('주문접수 또는 부분체결 상태가 아닌 Proposal은 감시 결과로 덮지 않는다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-fill-'));
  try {
    const proposal = buildProposalRecord({
      track: '퀀트', assetKey: '삼성전자', side: '매수', quantity: 1, proposedPrice: 71000, now,
    });
    const path = join(dir, proposal.filename);
    writeFileSync(path, proposal.content);
    assert.equal(await recordProposalExecutionStatus({
      proposalsDir: dir, proposalId: proposal.id, brokerOrderId: 'wrong-order', status: '체결', filledQty: 1, avgFillPrice: 71000, now,
    }), false);
    assert.equal(parseProposal(readFileSync(path, 'utf8')).status, '대기');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Proposal ID가 맞아도 브로커 주문번호가 다르면 감시 결과를 적용하지 않는다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-fill-'));
  try {
    const proposal = buildProposalRecord({
      track: '자산분배', account: '위탁', assetKey: '삼성전자', side: '매수',
      quantity: 2, proposedPrice: 71000, now,
    });
    const path = join(dir, proposal.filename);
    writeFileSync(path, updateProposalRecord(proposal.content, {
      status: '주문접수', brokerOrderId: '847026',
    }));
    assert.equal(await recordProposalExecutionStatus({
      proposalsDir: dir, proposalId: proposal.id, brokerOrderId: '847027',
      status: '체결', filledQty: 2, avgFillPrice: 71000, now,
    }), false);
    const current = parseProposal(readFileSync(path, 'utf8'));
    assert.equal(current.status, '주문접수');
    assert.equal(current.brokerOrderId, '847026');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('주문접수 뒤 잔량 취소가 확인되면 최종 취소와 이미 체결된 수량·평균가를 함께 보존한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-fill-'));
  try {
    const proposal = buildProposalRecord({
      track: '퀀트', assetKey: '005930', side: '매수', quantity: 10, proposedPrice: 71000, now,
    });
    const path = join(dir, proposal.filename);
    writeFileSync(path, updateProposalRecord(proposal.content, { status: '주문접수', brokerOrderId: '847028' }));
    assert.equal(await recordProposalExecutionStatus({
      proposalsDir: dir, proposalId: proposal.id, brokerOrderId: '847028',
      status: '취소', filledQty: 3, avgFillPrice: 70500, now,
    }), true);
    const final = parseProposal(readFileSync(path, 'utf8'));
    assert.equal(final.status, '취소');
    assert.equal(final.filledQuantity, 3);
    assert.equal(final.avgFillPrice, 70500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
