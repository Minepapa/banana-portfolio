import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCashAllocationPrompt, validateAllocations, resolveInstrumentPricing,
  findCashBalance, allAllocationsSent,
} from './new-cash-allocation.mjs';

test('buildCashAllocationPrompt: 계좌·실잔고·갭·후보가 프롬프트에 포함됨', () => {
  const prompt = buildCashAllocationPrompt({
    account: '위탁', availableCash: 550_000,
    rankedGaps: [{ assetClass: '국내주식', targetPct: 30, currentPct: 20, absDeltaPct: -10 }],
    candidatesByClass: { 국내주식: [{ name: 'TIGER 200', ticker: '102110', curPrice: 40000 }], 해외주식: [] },
  });
  assert.match(prompt, /위탁 계좌/);
  assert.match(prompt, /550,000원/);
  assert.match(prompt, /국내주식: 목표 30% \/ 현재 20\.00%/);
  assert.match(prompt, /TIGER 200\(102110\) 현재가 40000원/);
  assert.match(prompt, /신규 ETF 제안 가능/); // 해외주식은 빈 후보
});

test('buildCashAllocationPrompt: 개별종목 배분 금지 규칙이 항상 포함됨', () => {
  const prompt = buildCashAllocationPrompt({ account: '위탁', availableCash: 500_000, rankedGaps: [], candidatesByClass: {} });
  assert.match(prompt, /개별 회사 주식.*절대 배분하지 말 것/);
});

test('buildCashAllocationPrompt: 분할매수 지시(전액 배분 금지)가 항상 포함됨(2026-08-23 오너 지적)', () => {
  const prompt = buildCashAllocationPrompt({ account: '위탁', availableCash: 500_000, rankedGaps: [], candidatesByClass: {} });
  assert.match(prompt, /전액을 한 번에 배분하려 하지 마라/);
});

test('buildCashAllocationPrompt: 언더웨이트 후보 없으면 안내 문구', () => {
  const prompt = buildCashAllocationPrompt({ account: '연금저축', availableCash: 500_000, rankedGaps: [], candidatesByClass: {} });
  assert.match(prompt, /언더웨이트 없음/);
});

test('validateAllocations: 캡(가용잔고의 50%) 이내 라인은 그대로 유지', () => {
  const { kept, dropped } = validateAllocations(
    [{ assetClass: '국내주식', instrumentName: 'TIGER 200', amountWon: 200000, reasoning: '갭 큼' }],
    { account: '위탁', availableCash: 500000, eligibleClasses: ['국내주식', '해외주식'] },
  );
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
  assert.equal(kept[0].instrumentName, 'TIGER 200');
  assert.equal(kept[0].amountWon, 200000);
});

test('validateAllocations: 분할매수 하드 캡(2026-08-23 오너 지적) — 가용잔고 50% 초과분은 드롭 아니라 캡까지 축소', () => {
  const { kept, dropped } = validateAllocations(
    [{ assetClass: '국내주식', instrumentName: 'TIGER 200', amountWon: 500000, reasoning: '갭 큼' }],
    { account: '위탁', availableCash: 500000, eligibleClasses: ['국내주식'] },
  );
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0); // 드롭이 아니라 캡까지 축소
  assert.equal(kept[0].amountWon, 250000); // 500000 * 0.5
});

test('[막아야 함] validateAllocations: 그 계좌가 세금상 담을 수 없는 자산군은 드롭', () => {
  const { kept, dropped } = validateAllocations(
    [{ assetClass: '배당주', instrumentName: 'ACE 고배당', amountWon: 100000 }],
    { account: '위탁', availableCash: 500000, eligibleClasses: ['국내주식', '해외주식'] },
  );
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /담을 수 없는 자산군/);
});

test('validateAllocations: 캡 소진 후 뒤에 오는 라인은 드롭(먼저 온 라인이 캡 우선순위)', () => {
  const { kept, dropped } = validateAllocations(
    [
      { assetClass: '국내주식', instrumentName: 'A', amountWon: 400000 }, // 캡(250000)까지 축소돼 캡 전부 소진
      { assetClass: '해외주식', instrumentName: 'B', amountWon: 300000 }, // 남은 캡 없어 드롭
    ],
    { account: '위탁', availableCash: 500000, eligibleClasses: ['국내주식', '해외주식'] },
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].instrumentName, 'A');
  assert.equal(kept[0].amountWon, 250000);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].a.instrumentName, 'B');
  assert.match(dropped[0].reason, /분할매수 캡/);
});

test('validateAllocations: 금액이 0 이하·비숫자면 드롭', () => {
  const { kept, dropped } = validateAllocations(
    [{ assetClass: '국내주식', instrumentName: 'A', amountWon: 0 }, { assetClass: '국내주식', instrumentName: 'B', amountWon: 'abc' }],
    { account: '위탁', availableCash: 500000, eligibleClasses: ['국내주식'] },
  );
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 2);
});

test('validateAllocations: 종목명 없으면 드롭', () => {
  const { kept, dropped } = validateAllocations(
    [{ assetClass: '국내주식', instrumentName: '', amountWon: 100000 }],
    { account: '위탁', availableCash: 500000, eligibleClasses: ['국내주식'] },
  );
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
});

test('resolveInstrumentPricing: 후보와 이름이 일치하면 가격·수량 계산(내림)', () => {
  const candidates = [{ name: 'TIGER 200', ticker: '102110', curPrice: 40000 }];
  const r = resolveInstrumentPricing({ instrumentName: 'TIGER 200', amountWon: 310000 }, candidates);
  assert.equal(r.assetKey, '102110');
  assert.equal(r.quantity, 7); // floor(310000/40000)=7
  assert.equal(r.proposedPrice, 40000);
});

test('resolveInstrumentPricing: 후보에 없는(신규 제안) 종목은 quantity·price null', () => {
  const r = resolveInstrumentPricing({ instrumentName: 'KODEX 신규ETF', amountWon: 300000 }, []);
  assert.equal(r.assetKey, 'KODEX 신규ETF');
  assert.equal(r.quantity, null);
  assert.equal(r.proposedPrice, null);
});

test('resolveInstrumentPricing: 1주도 못 사는 소액이면 quantity null(0주 제안 방지)', () => {
  const candidates = [{ name: 'TIGER 200', ticker: '102110', curPrice: 400000 }];
  const r = resolveInstrumentPricing({ instrumentName: 'TIGER 200', amountWon: 100000 }, candidates);
  assert.equal(r.quantity, null);
});

test('resolveInstrumentPricing: ticker 없는 후보는 name을 assetKey로 사용', () => {
  const candidates = [{ name: '위탁-금현물', ticker: '', curPrice: 100000 }];
  const r = resolveInstrumentPricing({ instrumentName: '위탁-금현물', amountWon: 200000 }, candidates);
  assert.equal(r.assetKey, '위탁-금현물');
});

test('[실사고 재현 방지/2026-08-17] findCashBalance: 예수금 보유(isCashLike)의 evalAmount를 그대로 실잔고로 사용 — 배당·매도 이벤트를 다시 더하지 않음', () => {
  const holdings = [
    { account: '위탁', name: '예수금', isCashLike: true, evalAmount: 1164516 },
    { account: '위탁', name: '삼성전자', isCashLike: false, evalAmount: 5000000 },
  ];
  assert.equal(findCashBalance(holdings, '위탁'), 1164516);
});

test('findCashBalance: 그 계좌 예수금 보유가 없으면 null(0으로 추정 안 함)', () => {
  assert.equal(findCashBalance([{ account: 'ISA', name: '예수금', isCashLike: true, evalAmount: 1000 }], '위탁'), null);
});

test('allAllocationsSent: 전부 created면 true(트리거 상태 갱신 대상)', () => {
  assert.equal(allAllocationsSent([{ action: 'created' }, { action: 'created' }]), true);
});

test('[막아야 함] allAllocationsSent: 하나라도 blocked면 false(상태 갱신하면 안 됨 — 다음 실행이 재시도해야 함)', () => {
  assert.equal(allAllocationsSent([{ action: 'created' }, { action: 'blocked' }]), false);
});

test('allAllocationsSent: 하나라도 failed면 false', () => {
  assert.equal(allAllocationsSent([{ action: 'created' }, { action: 'failed' }]), false);
});

test('allAllocationsSent: 빈 배열이면 false(아무것도 안 보냈으니 갱신 대상 아님)', () => {
  assert.equal(allAllocationsSent([]), false);
});
