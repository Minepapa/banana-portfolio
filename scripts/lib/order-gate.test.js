// order-gate.mjs 테스트 — 이 프로젝트에서 가장 신중해야 하는 코드. "막아야 하는
// 상황을 실제로 막는다"를 각 검문소 항목마다 확인한다(구현계획서 Phase 4 완료기준).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveProposalIntake, checkPriceDeviation, checkHoldingsConsistency, checkIdempotency,
  checkApprovalMatch, checkMarketOpen, checkKillSwitch, runExecutionGateChecks, isApprovalStale,
} from './order-gate.mjs';
import { buildProposalRecord, parseProposal } from './proposal-vault.mjs';
import { buildKillSwitchState } from './kill-switch.mjs';

// ── resolveProposalIntake (제안 생성 시점) ──────────────────────────

test('resolveProposalIntake: 겹치는 안건이 없으면 그냥 생성', () => {
  const r = resolveProposalIntake({ track: '퀀트', assetKey: 'X', side: '매수', existingProposals: [] });
  assert.equal(r.action, 'create');
});

test('[막아야 함] resolveProposalIntake: 같은 안건이 이미 "대기" 중이면 새로 쌓지 않고 대체(supersede)', () => {
  const active = parseProposal(buildProposalRecord({ track: '퀀트', assetKey: 'X', side: '매수', quantity: 1, proposedPrice: 100 }).content);
  const r = resolveProposalIntake({ track: '퀀트', assetKey: 'X', side: '매수', existingProposals: [active] });
  assert.equal(r.action, 'supersede');
  assert.equal(r.supersedeId, active.id);
});

test('[막아야 함] resolveProposalIntake: 같은 안건이 이미 "승인"(검문소 차단 등으로 미체결) 상태여도 대체(supersede) — 승인 두 건 동시존재 방지', () => {
  const blocked = { ...parseProposal(buildProposalRecord({ track: '퀀트', assetKey: 'X', side: '매도', quantity: 2, proposedPrice: 90000 }).content), status: '승인', gateBlockedReason: '가격이탈' };
  const r = resolveProposalIntake({ track: '퀀트', assetKey: 'X', side: '매도', existingProposals: [blocked] });
  assert.equal(r.action, 'supersede');
  assert.equal(r.supersedeId, blocked.id);
});

test('[막아야 함] resolveProposalIntake: 24시간 이내 거부 이력이 있으면 조건변화 명시 없이는 차단', () => {
  const rejected = { ...parseProposal(buildProposalRecord({ track: '자산분배', assetKey: 'Y', side: '매도', quantity: 1, proposedPrice: 100, now: new Date('2026-08-05T08:00:00.000Z') }).content), status: '거부', decidedAt: '2026-08-05T08:05:00.000Z' };
  const r = resolveProposalIntake({ track: '자산분배', assetKey: 'Y', side: '매도', existingProposals: [rejected], now: new Date('2026-08-05T09:00:00.000Z') });
  assert.equal(r.action, 'blocked');
  assert.match(r.reason, /쿨다운/);
});

test('resolveProposalIntake: 거부 이력이 있어도 conditionsChanged=true면 통과(부서가 명시적으로 판단한 경우만)', () => {
  const rejected = { ...parseProposal(buildProposalRecord({ track: '자산분배', assetKey: 'Y', side: '매도', quantity: 1, proposedPrice: 100, now: new Date('2026-08-05T08:00:00.000Z') }).content), status: '거부', decidedAt: '2026-08-05T08:05:00.000Z' };
  const r = resolveProposalIntake({ track: '자산분배', assetKey: 'Y', side: '매도', existingProposals: [rejected], conditionsChanged: true, now: new Date('2026-08-05T09:00:00.000Z') });
  assert.equal(r.action, 'create');
});

// ── isApprovalStale (당일 유효기간) ──────────────────────────────
test('isApprovalStale: 같은 KST 달력일이면 아직 유효', () => {
  const r = isApprovalStale({ decidedAt: '2026-08-13T01:00:00.000Z', now: new Date('2026-08-13T08:00:00.000Z') }); // 둘 다 KST 8/13
  assert.equal(r, false);
});

test('[막아야 함] isApprovalStale: 날짜가 넘어가면(KST 기준) 만료 — 가격이탈로 계속 막히다 다음날로 넘어간 경우', () => {
  const r = isApprovalStale({ decidedAt: '2026-08-12T05:42:54.455Z', now: new Date('2026-08-13T01:00:00.000Z') }); // 승인 KST 8/12, 지금 KST 8/13
  assert.equal(r, true);
});

test('isApprovalStale: decidedAt 없으면(아직 미승인 등 이상상태) 추정하지 않고 false', () => {
  assert.equal(isApprovalStale({ decidedAt: null }), false);
});

// ── checkPriceDeviation ──────────────────────────────────────────

test('[막아야 함] checkPriceDeviation: ±1% 초과 이탈은 차단', () => {
  const r = checkPriceDeviation({ proposedPrice: 100000, currentPrice: 102000 }); // 2% 이탈
  assert.equal(r.pass, false);
});

test('checkPriceDeviation: 허용범위 내는 통과', () => {
  const r = checkPriceDeviation({ proposedPrice: 100000, currentPrice: 100500 }); // 0.5%
  assert.equal(r.pass, true);
});

test('checkPriceDeviation: 경계값(정확히 1%)은 통과', () => {
  const r = checkPriceDeviation({ proposedPrice: 100000, currentPrice: 101000 });
  assert.equal(r.pass, true);
});

test('[막아야 함] checkPriceDeviation: 현재가 조회 실패(null)면 통과시키지 않는다', () => {
  const r = checkPriceDeviation({ proposedPrice: 100000, currentPrice: null });
  assert.equal(r.pass, false);
});

test('checkPriceDeviation: 가격 기준 없는 제안(proposedPrice null)은 이 체크 대상 아님(통과, 사유 명시)', () => {
  const r = checkPriceDeviation({ proposedPrice: null, currentPrice: 100000 });
  assert.equal(r.pass, true);
  assert.match(r.reason, /적용 대상 아님/);
});

// ── checkHoldingsConsistency ─────────────────────────────────────

test('[막아야 함] checkHoldingsConsistency: 보유수량보다 많이 매도하려 하면 차단', () => {
  const r = checkHoldingsConsistency({ side: '매도', quantity: 100, currentHoldingQty: 50 });
  assert.equal(r.pass, false);
});

test('checkHoldingsConsistency: 매도 — 보유수량 이내면 통과', () => {
  const r = checkHoldingsConsistency({ side: '매도', quantity: 30, currentHoldingQty: 50 });
  assert.equal(r.pass, true);
});

test('[막아야 함] checkHoldingsConsistency: 예수금보다 많이 매수하려 하면 차단', () => {
  const r = checkHoldingsConsistency({ side: '매수', orderCost: 1000000, availableCash: 500000 });
  assert.equal(r.pass, false);
});

test('checkHoldingsConsistency: 매수 — 예수금 이내면 통과', () => {
  const r = checkHoldingsConsistency({ side: '매수', orderCost: 400000, availableCash: 500000 });
  assert.equal(r.pass, true);
});

// ── checkIdempotency ──────────────────────────────────────────────

test('[막아야 함] checkIdempotency: 이미 체결된 제안 ID로 재시도하면 차단', () => {
  const r = checkIdempotency({ proposalId: 'p1', alreadyExecutedIds: ['p1', 'p2'] });
  assert.equal(r.pass, false);
});

test('checkIdempotency: 처음 보는 제안 ID는 통과', () => {
  const r = checkIdempotency({ proposalId: 'p3', alreadyExecutedIds: ['p1', 'p2'] });
  assert.equal(r.pass, true);
});

// ── checkApprovalMatch ────────────────────────────────────────────

test('[막아야 함] checkApprovalMatch: reply_to 없이 "승인"만 오면 추정하지 않고 차단', () => {
  const r = checkApprovalMatch({ replyTo: null, expectedProposalId: 'p1' });
  assert.equal(r.pass, false);
});

test('[막아야 함] checkApprovalMatch: reply_to가 다른 제안을 가리키면 차단(위조 승인 방어)', () => {
  const r = checkApprovalMatch({ replyTo: 'p2', expectedProposalId: 'p1' });
  assert.equal(r.pass, false);
});

test('checkApprovalMatch: 정확히 일치하면 통과', () => {
  const r = checkApprovalMatch({ replyTo: 'p1', expectedProposalId: 'p1' });
  assert.equal(r.pass, true);
});

// ── checkMarketOpen ────────────────────────────────────────────────

test('checkMarketOpen: 평일 장중(수요일 10:00 KST)은 통과', () => {
  const r = checkMarketOpen({ now: new Date('2026-08-05T01:00:00.000Z') }); // 수 10:00 KST
  assert.equal(r.pass, true);
});

test('[막아야 함] checkMarketOpen: 장 시작 전(수요일 08:00 KST)은 차단', () => {
  const r = checkMarketOpen({ now: new Date('2026-08-04T23:00:00.000Z') }); // 수 08:00 KST
  assert.equal(r.pass, false);
});

test('[막아야 함] checkMarketOpen: 장 마감 후(수요일 16:00 KST)은 차단', () => {
  const r = checkMarketOpen({ now: new Date('2026-08-05T07:00:00.000Z') }); // 수 16:00 KST
  assert.equal(r.pass, false);
});

test('[막아야 함] checkMarketOpen: 주말(토요일 10:00 KST)은 차단', () => {
  const r = checkMarketOpen({ now: new Date('2026-08-08T01:00:00.000Z') }); // 토 10:00 KST
  assert.equal(r.pass, false);
});

// market:'US' — 2026-09-06 asset-allocation 자동체결 코드리뷰 HIGH 지적으로 추가
// (해외주식 제안이 market 기본값 'KR'로만 게이트돼 실제 미국장 시간대와 반대로
// 동작하던 버그의 회귀 방지).
test('checkMarketOpen: market:"US" — 미국 장중(수요일 10:00 EDT)은 통과', () => {
  const r = checkMarketOpen({ now: new Date('2026-08-05T14:00:00.000Z'), market: 'US' }); // 수 10:00 EDT
  assert.equal(r.pass, true);
});

test('[막아야 함] checkMarketOpen: market:"US" — 이 시각은 미국장 마감 후(수요일 17:00 EDT)라 차단', () => {
  const r = checkMarketOpen({ now: new Date('2026-08-05T21:00:00.000Z'), market: 'US' }); // 수 17:00 EDT
  assert.equal(r.pass, false);
});

test('[막아야 함] checkMarketOpen: market:"US" — 같은 시각(KST 10:00)이 KR은 장중이어도 US는 마감 후라 차단(거꾸로 게이트되던 버그의 핵심 재현)', () => {
  const r = checkMarketOpen({ now: new Date('2026-08-05T01:00:00.000Z'), market: 'US' }); // 수 10:00 KST = 수 전날 21:00 EDT
  assert.equal(r.pass, false);
});

test('[막아야 함] checkMarketOpen: 지원 안 하는 시장 문자열은 차단', () => {
  const r = checkMarketOpen({ now: new Date('2026-08-05T01:00:00.000Z'), market: 'JP' });
  assert.equal(r.pass, false);
});

// ── checkKillSwitch ────────────────────────────────────────────────

test('[막아야 함] checkKillSwitch: 킬스위치 켜져 있으면 차단', () => {
  const content = buildKillSwitchState({ active: true, reason: 'STOP' });
  const r = checkKillSwitch({ killSwitchContent: content });
  assert.equal(r.pass, false);
});

test('checkKillSwitch: 킬스위치 꺼져 있으면(기본값 포함) 통과', () => {
  assert.equal(checkKillSwitch({ killSwitchContent: null }).pass, true);
  assert.equal(checkKillSwitch({ killSwitchContent: buildKillSwitchState({ active: false }) }).pass, true);
});

// ── runExecutionGateChecks (오케스트레이터) ─────────────────────────

const ALL_PASS_INPUT = {
  proposedPrice: 100000, currentPrice: 100200,
  side: '매수', orderCost: 400000, availableCash: 500000,
  proposalId: 'p1', alreadyExecutedIds: [],
  replyTo: 'p1', expectedProposalId: 'p1',
  now: new Date('2026-08-05T01:00:00.000Z'), // 평일 장중
  killSwitchContent: null,
};

test('[통합] runExecutionGateChecks: 전부 통과하는 정상 케이스', () => {
  const r = runExecutionGateChecks(ALL_PASS_INPUT);
  assert.equal(r.pass, true);
  assert.deepEqual(r.failures, []);
});

test('[통합, 막아야 함] runExecutionGateChecks: 하나라도 실패하면 전체 실패, 나머지 체크도 다 돌려서 보고', () => {
  const input = { ...ALL_PASS_INPUT, currentPrice: 110000, replyTo: null }; // 가격이탈 + 승인불일치 동시 실패
  const r = runExecutionGateChecks(input);
  assert.equal(r.pass, false);
  const failedChecks = r.failures.map((f) => f.check);
  assert.ok(failedChecks.includes('priceDeviation'));
  assert.ok(failedChecks.includes('approvalMatch'));
  // 나머지 통과 항목도 checks에 전부 남아있어야 함(부분 정보로 판단하지 않기 위함)
  assert.equal(Object.keys(r.checks).length, 6);
});

test('[통합, 막아야 함] runExecutionGateChecks: 킬스위치 하나만 켜져도 전체 차단', () => {
  const input = { ...ALL_PASS_INPUT, killSwitchContent: buildKillSwitchState({ active: true, reason: 'test' }) };
  const r = runExecutionGateChecks(input);
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => f.check === 'killSwitch'));
});
