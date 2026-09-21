import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCurrentPriceFetcher, resolveDirectOrderTarget } from './place-nh-direct-order.mjs';
import { INSTRUMENT_TYPE } from '../lib/asset-allocation-instrument-router.mjs';
import { setNhRateLimitForTests } from '../lib/nhplug.mjs';
import {
  buildProposalRecord, updateProposalRecord, parseProposal, findActiveProposal,
} from '../lib/proposal-vault.mjs';
import { buildGateInput } from '../lib/proposal-execution-input.mjs';
import { runExecutionGateChecks } from '../lib/order-gate.mjs';
import { classifyAssetAllocationInstrument } from '../lib/asset-allocation-instrument-router.mjs';

// nhplug.mjs의 속도제한을 끈다 — nhplug-krstock.test.js 등과 동일 관례.
setNhRateLimitForTests(Infinity);

// fetch 모킹 헬퍼 — nhplug-krstock.test.js와 동일 패턴.
const mockFetch = (responses) => {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok !== false, status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
  };
  fn.calls = calls;
  return fn;
};

test('pickCurrentPriceFetcher: KR_STOCK은 krstock currentPrice를 호출하고 stck_prpr을 뽑음', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { stck_prpr: '75000' } } }]);
  const fetchPrice = pickCurrentPriceFetcher(INSTRUMENT_TYPE.KR_STOCK);
  const price = await fetchPrice({ token: 't', iemCd: '005930', fetchImpl });
  assert.equal(price, 75000);
  assert.match(fetchImpl.calls[0].url, /\/krstock\/quote\/v1\/currentPrice$/);
});

test('pickCurrentPriceFetcher: OVERSEAS_STOCK은 gbstock currentPrice를 호출하고 trdprc를 뽑음', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { trdprc: '150.25' } } }]);
  const fetchPrice = pickCurrentPriceFetcher(INSTRUMENT_TYPE.OVERSEAS_STOCK);
  const price = await fetchPrice({ token: 't', iemCd: 'AAPL', fetchImpl });
  assert.equal(price, 150.25);
  assert.match(fetchImpl.calls[0].url, /\/gbstock\/quote\/v1\/current$/);
});

test('pickCurrentPriceFetcher: GOLD는 krgold currentPrice를 호출하고 stck_prpr을 뽑음', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { stck_prpr: '132000' } } }]);
  const fetchPrice = pickCurrentPriceFetcher(INSTRUMENT_TYPE.GOLD);
  const price = await fetchPrice({ token: 't', iemCd: 'M04020000', fetchImpl });
  assert.equal(price, 132000);
  assert.match(fetchImpl.calls[0].url, /\/krgold\/quote\/v1\/goldCurrent$/);
});

test('pickCurrentPriceFetcher: KR_BOND는 null(직접채권은 항상 --price 필수)', () => {
  assert.equal(pickCurrentPriceFetcher(INSTRUMENT_TYPE.KR_BOND), null);
});

test('pickCurrentPriceFetcher: UNSUPPORTED는 null', () => {
  assert.equal(pickCurrentPriceFetcher(INSTRUMENT_TYPE.UNSUPPORTED), null);
});

// ── resolveDirectOrderTarget(2026-09-21 독립 코드리뷰 지적 — "테스트 커버리지가
// 실거래 기능치고 부족하다"의 핵심 처방: H2(계좌 허용 판정)가 main() 안에만 있어
// 테스트가 하나도 못 보던 지점이었다. 표 기반으로 4갈래를 한 번에 검증) ──
test('resolveDirectOrderTarget: UNSUPPORTED는 거부', () => {
  const r = resolveDirectOrderTarget({
    classification: { type: 'UNSUPPORTED', reason: '테스트 사유' }, side: '매수', explicitPrice: null,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /테스트 사유/);
});

test('resolveDirectOrderTarget: 허용 계좌(위탁·금현물) 밖이면 거부(ISA 등, H2 재발방지)', () => {
  const r = resolveDirectOrderTarget({
    classification: { type: INSTRUMENT_TYPE.KR_STOCK, nhAccountLabel: 'ISA', iemCd: '329200' }, side: '매수', explicitPrice: null,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ISA/);
});

test('resolveDirectOrderTarget: 직접채권 매도는 거부(로트 선택 불가)', () => {
  const r = resolveDirectOrderTarget({
    classification: { type: INSTRUMENT_TYPE.KR_BOND, nhAccountLabel: '위탁', iemCd: 'B150351F4' }, side: '매도', explicitPrice: 10000,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /직접채권 매도/);
});

test('resolveDirectOrderTarget: 직접채권 매수는 --price 없으면 거부', () => {
  const r = resolveDirectOrderTarget({
    classification: { type: INSTRUMENT_TYPE.KR_BOND, nhAccountLabel: '위탁', iemCd: 'B150351F4' }, side: '매수', explicitPrice: null,
  });
  assert.equal(r.ok, false);
});

test('resolveDirectOrderTarget: 직접채권 매수는 --price 있으면 통과', () => {
  const r = resolveDirectOrderTarget({
    classification: { type: INSTRUMENT_TYPE.KR_BOND, nhAccountLabel: '위탁', iemCd: 'B150351F4' }, side: '매수', explicitPrice: 10000,
  });
  assert.equal(r.ok, true);
});

test('resolveDirectOrderTarget: 금현물은 --price 없으면 거부', () => {
  const r = resolveDirectOrderTarget({
    classification: { type: INSTRUMENT_TYPE.GOLD, nhAccountLabel: '금현물', iemCd: 'M04020000' }, side: '매수', explicitPrice: null,
  });
  assert.equal(r.ok, false);
});

test('resolveDirectOrderTarget: 금현물은 --price 있으면 통과', () => {
  const r = resolveDirectOrderTarget({
    classification: { type: INSTRUMENT_TYPE.GOLD, nhAccountLabel: '금현물', iemCd: 'M04020000' }, side: '매수', explicitPrice: 130000,
  });
  assert.equal(r.ok, true);
});

test('resolveDirectOrderTarget: KR_STOCK/OVERSEAS_STOCK은 --price 없이도(자동조회 예정) 통과', () => {
  const kr = resolveDirectOrderTarget({
    classification: { type: INSTRUMENT_TYPE.KR_STOCK, nhAccountLabel: '위탁', iemCd: '005930' }, side: '매수', explicitPrice: null,
  });
  const us = resolveDirectOrderTarget({
    classification: { type: INSTRUMENT_TYPE.OVERSEAS_STOCK, nhAccountLabel: '위탁', iemCd: 'AAPL' }, side: '매도', explicitPrice: null,
  });
  assert.equal(kr.ok, true);
  assert.equal(us.ok, true);
});

// ── 독립 코드리뷰(2026-09-21) CRITICAL/HIGH 재발방지 회귀 테스트 ──
// 리뷰어가 실제 검문소 코드를 끝까지 실행해 증명한 버그들을 여기서도 자동화된
// 테스트로 재현·검증한다(place-nh-direct-order.mjs가 만드는 것과 정확히 같은
// 형태의 레코드를 직접 조립해 실제 order-gate 함수에 태운다).

test('[재발방지] 직접주문 제안은 checkApprovalMatch를 통과함(CRITICAL — telegramMessageId가 null이면 매번 차단돼 단 한 건도 체결 안 되던 사고)', () => {
  const { id, content } = buildProposalRecord({
    track: '자산분배', account: '위탁', assetKey: '삼성전자', side: '매수', quantity: 10, proposedPrice: 75000,
    reason: '오너 직접 지시(텔레그램) — 삼성전자',
  });
  // place-nh-direct-order.mjs의 main()이 실제로 하는 것과 동일한 갱신 — status 승인
  // + decidedAt + telegramMessageId를 직접주문 고유 provenance 문자열로 채운다.
  const approved = updateProposalRecord(content, {
    status: '승인', decidedAt: new Date().toISOString(), telegramMessageId: `직접주문:${id}`,
  });
  const proposal = parseProposal(approved);
  // execute-asset-allocation-proposal.mjs가 실제 실행 시점에 하는 것과 동일하게
  // assetKey만 iemCd로 덮은 얕은 복사본을 gateInput 조립에 넘긴다(그 파일 주석 참고).
  const gateInput = buildGateInput({
    proposal: { ...proposal, assetKey: '005930' },
    currentPrice: 75000, holdings: [], cash: 10_000_000, killSwitchContent: null,
  });
  // 2026-09-21(월) 11:30 KST — 장중, 주말 아님.
  const now = new Date('2026-09-21T02:30:00.000Z');
  const gate = runExecutionGateChecks({
    proposalId: proposal.id, proposedPrice: proposal.proposedPrice, side: proposal.side, quantity: proposal.quantity,
    ...gateInput, now,
  });
  assert.equal(gate.checks.approvalMatch.pass, true, gate.checks.approvalMatch.reason);
  assert.equal(gate.pass, true, JSON.stringify(gate.failures));
});

test('[재발방지] 직접주문이 telegramMessageId를 안 채우면(수정 전 상태) checkApprovalMatch가 항상 차단함을 재확인', () => {
  const { content } = buildProposalRecord({
    track: '자산분배', account: '위탁', assetKey: '삼성전자', side: '매수', quantity: 10, proposedPrice: 75000, reason: '',
  });
  const approved = updateProposalRecord(content, { status: '승인', decidedAt: new Date().toISOString() }); // telegramMessageId 안 채움
  const proposal = parseProposal(approved);
  const gateInput = buildGateInput({
    proposal: { ...proposal, assetKey: '005930' },
    currentPrice: 75000, holdings: [], cash: 10_000_000, killSwitchContent: null,
  });
  const gate = runExecutionGateChecks({
    proposalId: proposal.id, proposedPrice: proposal.proposedPrice, side: proposal.side, quantity: proposal.quantity,
    ...gateInput, now: new Date('2026-09-21T02:30:00.000Z'),
  });
  assert.equal(gate.checks.approvalMatch.pass, false);
});

test('[재발방지] 직접채권(KR_BOND) assetKey를 표시명으로 저장하면 재분류 왕복이 성공함(HIGH — iemCd(bondCode)로 저장하면 재분류 시 holdingsIndex 조회가 실패해 UNSUPPORTED로 떨어지던 사고)', () => {
  const holdingsIndex = new Map();
  holdingsIndex.set('삼척블루파워12', {
    account: '위탁', assetClass: '채권', name: '삼척블루파워12', ticker: null, isCashLike: false, qty: null, bondCode: 'B150351F4',
  });
  const registry = new Map();
  const first = classifyAssetAllocationInstrument({
    assetKey: '삼척블루파워12', holdingsIndex, registry, krStockCodeFn: () => null, usTickerFn: () => null,
  });
  assert.equal(first.type, 'KR_BOND');
  // place-nh-direct-order.mjs가 제안 레코드에 저장하는 값 = classification.resolvedName.
  // 그 값으로 다시 분류했을 때(execute-asset-allocation-proposal.mjs가 실행 시점에
  // 하는 것과 동일) 여전히 KR_BOND로 resolve돼야 한다.
  const second = classifyAssetAllocationInstrument({
    assetKey: first.resolvedName, holdingsIndex, registry, krStockCodeFn: () => null, usTickerFn: () => null,
  });
  assert.equal(second.type, 'KR_BOND');
  assert.equal(second.iemCd, 'B150351F4');
});

test('[재발방지] 중복발주 가드는 assetKey가 표시명이어야 Athena 스타일 기존 레코드와 실제로 매칭됨(HIGH — iemCd로 조회하면 이름 기반 기존 레코드와 절대 안 겹쳐 가드가 무력화됨)', () => {
  const existing = [
    { id: 'x', track: '자산분배', assetKey: '삼성전자', side: '매수', status: '승인', createdAt: '2026-09-21T00:00:00.000Z' },
  ];
  // place-nh-direct-order.mjs는 classification.resolvedName(표시명)으로 조회한다 —
  // 코드(예: '005930')로 조회하면 이 매칭 자체가 안 된다.
  assert.ok(findActiveProposal(existing, { track: '자산분배', assetKey: '삼성전자', side: '매수' }));
  assert.equal(findActiveProposal(existing, { track: '자산분배', assetKey: '005930', side: '매수' }), null);
});
