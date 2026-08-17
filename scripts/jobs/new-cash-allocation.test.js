import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCashAllocationPrompt, validateAllocations, resolveInstrumentPricing,
  classifyCashEvents, allAllocationsSent,
} from './new-cash-allocation.mjs';

test('buildCashAllocationPrompt: 계좌·누적금액·갭·후보가 프롬프트에 포함됨', () => {
  const prompt = buildCashAllocationPrompt({
    account: '위탁', accumulatedAmount: 550_000,
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
  const prompt = buildCashAllocationPrompt({ account: '위탁', accumulatedAmount: 500_000, rankedGaps: [], candidatesByClass: {} });
  assert.match(prompt, /개별 회사 주식.*절대 배분하지 말 것/);
});

test('buildCashAllocationPrompt: 언더웨이트 후보 없으면 안내 문구', () => {
  const prompt = buildCashAllocationPrompt({ account: '연금저축', accumulatedAmount: 500_000, rankedGaps: [], candidatesByClass: {} });
  assert.match(prompt, /언더웨이트 없음/);
});

test('validateAllocations: 정상 라인은 유지', () => {
  const { kept, dropped } = validateAllocations(
    [{ assetClass: '국내주식', instrumentName: 'TIGER 200', amountWon: 300000, reasoning: '갭 큼' }],
    { account: '위탁', accumulatedAmount: 500000, eligibleClasses: ['국내주식', '해외주식'] },
  );
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
  assert.equal(kept[0].instrumentName, 'TIGER 200');
});

test('[막아야 함] validateAllocations: 그 계좌가 세금상 담을 수 없는 자산군은 드롭', () => {
  const { kept, dropped } = validateAllocations(
    [{ assetClass: '배당주', instrumentName: 'ACE 고배당', amountWon: 100000 }],
    { account: '위탁', accumulatedAmount: 500000, eligibleClasses: ['국내주식', '해외주식'] },
  );
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /담을 수 없는 자산군/);
});

test('validateAllocations: 누적잔여 초과 요청은 뒤에서부터 드롭(먼저 온 라인 우선)', () => {
  const { kept, dropped } = validateAllocations(
    [
      { assetClass: '국내주식', instrumentName: 'A', amountWon: 400000 },
      { assetClass: '해외주식', instrumentName: 'B', amountWon: 300000 },
    ],
    { account: '위탁', accumulatedAmount: 500000, eligibleClasses: ['국내주식', '해외주식'] },
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].instrumentName, 'A');
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /초과 요청/);
});

test('validateAllocations: 금액이 0 이하·비숫자면 드롭', () => {
  const { kept, dropped } = validateAllocations(
    [{ assetClass: '국내주식', instrumentName: 'A', amountWon: 0 }, { assetClass: '국내주식', instrumentName: 'B', amountWon: 'abc' }],
    { account: '위탁', accumulatedAmount: 500000, eligibleClasses: ['국내주식'] },
  );
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 2);
});

test('validateAllocations: 종목명 없으면 드롭', () => {
  const { kept, dropped } = validateAllocations(
    [{ assetClass: '국내주식', instrumentName: '', amountWon: 100000 }],
    { account: '위탁', accumulatedAmount: 500000, eligibleClasses: ['국내주식'] },
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

test('classifyCashEvents: 계좌 귀속 성공한 배당은 이벤트로 반영 + 처리됨 표시 대상', () => {
  const dividendFiles = [{ filepath: '/d1.md', dedupKey: 'd1', afterTaxAmount: 10000, broker: 'NH투자증권', stockName: 'X', acctRaw: '' }];
  const { eventsByAccount, processedFilepaths } = classifyCashEvents({
    dividendFiles, profitFiles: [], holdings: [],
    resolveAccount: () => '위탁',
  });
  assert.deepEqual(eventsByAccount.위탁, [{ dedupKey: 'd1', amount: 10000 }]);
  assert.deepEqual(processedFilepaths, ['/d1.md']);
});

test('[막아야 함] classifyCashEvents: 계좌 귀속 모호(null)한 배당은 처리됨 표시 안 함(다음 실행 재시도)', () => {
  const dividendFiles = [{ filepath: '/d1.md', dedupKey: 'd1', afterTaxAmount: 10000, broker: 'NH투자증권', stockName: 'X', acctRaw: '' }];
  const { eventsByAccount, processedFilepaths } = classifyCashEvents({
    dividendFiles, profitFiles: [], holdings: [],
    resolveAccount: () => null,
  });
  assert.deepEqual(eventsByAccount.위탁, []);
  assert.deepEqual(eventsByAccount.연금저축, []);
  assert.deepEqual(processedFilepaths, []); // 처리됨 표시 안 됨 — 다음 실행이 재확인
});

test('classifyCashEvents: 계좌가 확정됐지만 범위 밖(ISA·IRP)인 배당은 처리됨 표시는 하되 이벤트엔 안 넣음', () => {
  const dividendFiles = [{ filepath: '/d1.md', dedupKey: 'd1', afterTaxAmount: 10000, broker: 'NH투자증권', stockName: 'X', acctRaw: '' }];
  const { eventsByAccount, processedFilepaths } = classifyCashEvents({
    dividendFiles, profitFiles: [], holdings: [],
    resolveAccount: () => 'ISA',
  });
  assert.deepEqual(eventsByAccount.위탁, []);
  assert.deepEqual(processedFilepaths, ['/d1.md']); // 확정 계좌라 재확인 불필요 — 처리됨 표시
});

test('classifyCashEvents: 매도실현 파일은 quantity*sellPrice 전액이 이벤트 금액(실현손익 아님)', () => {
  const profitFiles = [{ filepath: '/p1.md', dedupKey: 'p1', account: '연금저축', quantity: 10, sellPrice: 50000, profit: 12000 }];
  const { eventsByAccount, processedFilepaths } = classifyCashEvents({ dividendFiles: [], profitFiles, holdings: [] });
  assert.deepEqual(eventsByAccount.연금저축, [{ dedupKey: 'p1', amount: 500000 }]);
  assert.deepEqual(processedFilepaths, ['/p1.md']);
});

test('classifyCashEvents: 매도실현 파일은 항상 계좌가 확정돼 있어 범위 밖이어도 처리됨 표시', () => {
  const profitFiles = [{ filepath: '/p1.md', dedupKey: 'p1', account: 'IRP', quantity: 10, sellPrice: 50000 }];
  const { processedFilepaths } = classifyCashEvents({ dividendFiles: [], profitFiles, holdings: [] });
  assert.deepEqual(processedFilepaths, ['/p1.md']);
});

test('allAllocationsSent: 전부 created면 true(리셋 대상)', () => {
  assert.equal(allAllocationsSent([{ action: 'created' }, { action: 'created' }]), true);
});

test('[막아야 함] allAllocationsSent: 하나라도 blocked면 false(리셋하면 안 됨 — 아직 안 보낸 현금)', () => {
  assert.equal(allAllocationsSent([{ action: 'created' }, { action: 'blocked' }]), false);
});

test('allAllocationsSent: 하나라도 failed면 false', () => {
  assert.equal(allAllocationsSent([{ action: 'created' }, { action: 'failed' }]), false);
});

test('allAllocationsSent: 빈 배열이면 false(아무것도 안 보냈으니 리셋 대상 아님)', () => {
  assert.equal(allAllocationsSent([]), false);
});
