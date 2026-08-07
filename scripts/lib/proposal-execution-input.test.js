import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGateInput } from './proposal-execution-input.mjs';
import { executeProposal } from './execute-proposal.mjs';
import { buildKillSwitchState } from './kill-switch.mjs';
import { buildProposalRecord, parseProposal } from './proposal-vault.mjs';

const baseProposal = { assetKey: '005930', quantity: 10, proposedPrice: 70000, telegramMessageId: 999 };

test('buildGateInput: 보유 중인 종목이면 그 수량, orderCost는 quantity*proposedPrice', () => {
  const input = buildGateInput({
    proposal: baseProposal, currentPrice: 70500,
    holdings: [{ code: '005930', name: '삼성전자', qty: 5 }], cash: 1_000_000, killSwitchContent: null,
  });
  assert.equal(input.currentHoldingQty, 5);
  assert.equal(input.orderCost, 700_000);
  assert.equal(input.currentPrice, 70500);
  assert.equal(input.availableCash, 1_000_000);
});

test('buildGateInput: 보유 목록에 없으면 0(추정 아니라 "0주 보유"가 사실)', () => {
  const input = buildGateInput({ proposal: baseProposal, currentPrice: 70000, holdings: [], cash: 0, killSwitchContent: null });
  assert.equal(input.currentHoldingQty, 0);
});

test('buildGateInput: cash가 null이면 availableCash도 0으로(호출측이 이미 매수+null조합은 걸러내고 부르지만, 방어적으로 0)', () => {
  const input = buildGateInput({ proposal: baseProposal, currentPrice: 70000, holdings: [], cash: null, killSwitchContent: null });
  assert.equal(input.availableCash, 0);
});

test('buildGateInput: killSwitchContent를 그대로 전달(가공하지 않음)', () => {
  const active = buildKillSwitchState({ active: true, reason: 'Frank 정지 명령' });
  const input = buildGateInput({ proposal: baseProposal, currentPrice: 70000, holdings: [], cash: 0, killSwitchContent: active });
  assert.equal(input.killSwitchContent, active);
});

test('buildGateInput: replyTo·expectedProposalId는 proposal.telegramMessageId 자기매칭', () => {
  const input = buildGateInput({ proposal: baseProposal, currentPrice: 70000, holdings: [], cash: 0, killSwitchContent: null });
  assert.equal(input.replyTo, 999);
  assert.equal(input.expectedProposalId, 999);
});

// 회귀테스트 — 2026-08-07 코드리뷰 CRITICAL: killSwitchContent가 gateInput에서 빠져
// execute-quant-proposal.mjs가 킬스위치를 읽고도 검문소에 전달하지 않던 버그. buildGateInput
// + executeProposal을 실제로 엮어서 "킬스위치 활성 → 체결 차단"을 증명한다(단위테스트
// 하나로는 못 잡는 배선 버그라 통합 형태로 남김).
test('킬스위치 활성 상태면 나머지 조건이 전부 통과여도 체결이 차단된다(회귀 — 2026-08-07)', () => {
  const now = new Date('2026-08-10T05:00:00.000Z'); // 평일 KST 14:00, 장중
  const { id, content } = buildProposalRecord({
    track: '퀀트', assetKey: '005930', side: '매수', quantity: 10, proposedPrice: 70000, reason: 'test', now,
  });
  const withApproval = content.replace(/^status: .*$/m, 'status: "승인"').replace(/^telegramMessageId: .*$/m, 'telegramMessageId: 999');
  const proposal = { id, telegramMessageId: 999, ...parseProposal(withApproval) };

  const killSwitchContent = buildKillSwitchState({ active: true, reason: 'Frank 정지 명령', now });
  // checkMarketOpen은 gateInput에 now가 없으면 실제 현재시각을 쓴다(운영 코드에선 맞는
  // 동작이지만, 테스트는 "장중"을 고정해야 킬스위치 실패만 정확히 걸러낼 수 있어 여기서
  // 명시로 덮어씀).
  const gateInput = { ...buildGateInput({ proposal, currentPrice: 70000, holdings: [], cash: 10_000_000, killSwitchContent }), now };

  const result = executeProposal({ proposal, proposalContent: withApproval, gateInput, mode: '섀도우' });

  assert.equal(result.executed, false);
  assert.ok(result.gate.failures.some((f) => f.check === 'killSwitch'));
});

test('킬스위치 비활성(null, 파일 미존재)이면 나머지 조건 통과 시 체결된다(대조군)', () => {
  const now = new Date('2026-08-10T05:00:00.000Z');
  const { id, content } = buildProposalRecord({
    track: '퀀트', assetKey: '005930', side: '매수', quantity: 10, proposedPrice: 70000, reason: 'test', now,
  });
  const withApproval = content.replace(/^status: .*$/m, 'status: "승인"').replace(/^telegramMessageId: .*$/m, 'telegramMessageId: 999');
  const proposal = { id, telegramMessageId: 999, ...parseProposal(withApproval) };

  const gateInput = { ...buildGateInput({ proposal, currentPrice: 70000, holdings: [], cash: 10_000_000, killSwitchContent: null }), now };
  const result = executeProposal({ proposal, proposalContent: withApproval, gateInput, mode: '섀도우' });

  assert.equal(result.executed, true);
  assert.equal(result.settlement.status, '섀도우체결');
});
