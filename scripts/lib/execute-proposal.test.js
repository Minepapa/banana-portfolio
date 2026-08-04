import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { executeProposal } from './execute-proposal.mjs';
import { buildProposalRecord, parseProposal } from './proposal-vault.mjs';
import { MODE_SHADOW, MODE_LIVE } from './shadow-mode.mjs';

const PASS_GATE_INPUT = {
  currentPrice: 71000, orderCost: 400000, availableCash: 500000,
  alreadyExecutedIds: [], replyTo: null, expectedProposalId: null,
  now: new Date('2026-08-05T01:00:00.000Z'), killSwitchContent: null,
};

function makeProposal(overrides = {}) {
  const { id, content } = buildProposalRecord({
    track: '퀀트', account: null, assetKey: '삼성전자', side: '매수',
    quantity: 10, proposedPrice: 71000, ...overrides,
  });
  return { id, proposal: { ...parseProposal(content), id }, content };
}

test('[핵심] 구조 검증: execute-proposal.mjs는 ledger-vault-writer.mjs를 import하지 않는다(Ledger로 가는 길이 원천적으로 없음)', () => {
  const src = readFileSync(fileURLToPath(new URL('./execute-proposal.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /ledger-vault-writer/);
});

test('섀도우 모드: 검문소 통과 시 상태가 "섀도우체결"로 바뀐다', () => {
  const { proposal, content } = makeProposal();
  const gateInput = { ...PASS_GATE_INPUT, replyTo: proposal.id, expectedProposalId: proposal.id };
  const r = executeProposal({ proposal, proposalContent: content, gateInput, mode: MODE_SHADOW });
  assert.equal(r.executed, true);
  const updated = parseProposal(r.updatedContent);
  assert.equal(updated.status, '섀도우체결');
  assert.match(updated.executionLog, /SHADOW/);
});

test('[막아야 함] 검문소 실패(가격이탈) 시 체결되지 않고 "대기" 상태를 유지(거부 아님 — 원인 해소 후 재시도 가능)', () => {
  const { proposal, content } = makeProposal();
  const gateInput = { ...PASS_GATE_INPUT, currentPrice: 80000, replyTo: proposal.id, expectedProposalId: proposal.id }; // 큰 가격이탈
  const r = executeProposal({ proposal, proposalContent: content, gateInput, mode: MODE_SHADOW });
  assert.equal(r.executed, false);
  assert.equal(r.gate.pass, false);
  const updated = parseProposal(r.updatedContent);
  assert.equal(updated.status, '대기'); // 원본 그대로 — 검문소 차단은 상태를 안 바꾼다
  assert.match(updated.gateBlockedReason, /priceDeviation/);
});

test('[막아야 함] reply_to 불일치면 섀도우 모드여도 체결되지 않는다(승인 위조 방어는 모드와 무관)', () => {
  const { proposal, content } = makeProposal();
  const gateInput = { ...PASS_GATE_INPUT, replyTo: '다른제안ID', expectedProposalId: proposal.id };
  const r = executeProposal({ proposal, proposalContent: content, gateInput, mode: MODE_SHADOW });
  assert.equal(r.executed, false);
});

test('실전 모드 + liveExecutor 없이 검문소를 통과하면(가정) 명시적으로 에러(조용히 안 넘어감)', () => {
  const { proposal, content } = makeProposal();
  const gateInput = { ...PASS_GATE_INPUT, replyTo: proposal.id, expectedProposalId: proposal.id };
  assert.throws(() => executeProposal({ proposal, proposalContent: content, gateInput, mode: MODE_LIVE }));
});

test('실전 모드 + liveExecutor 주입 시 상태가 "체결"로 바뀐다', () => {
  const { proposal, content } = makeProposal();
  const gateInput = { ...PASS_GATE_INPUT, replyTo: proposal.id, expectedProposalId: proposal.id };
  const liveExecutor = () => ({ brokerOrderId: 'KIS-1' });
  const r = executeProposal({ proposal, proposalContent: content, gateInput, mode: MODE_LIVE, liveExecutor });
  assert.equal(r.executed, true);
  assert.equal(parseProposal(r.updatedContent).status, '체결');
});
