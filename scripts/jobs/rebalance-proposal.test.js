import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBreachFacts, computeBreachFingerprint, buildRebalanceProposalPrompt,
  validateRebalanceActions, resolveRebalanceInstrumentPricing, allActionsSent,
} from './rebalance-proposal.mjs';
import { computeRebalanceGaps } from '../lib/rebalance-gap.mjs';

function makeHoldings() {
  return [
    // 국내주식 과대보유(초과) — 위탁+연금저축 실보유
    { account: '위탁', assetClass: '국내주식', name: 'A전자', ticker: '000001', qty: 10, curPrice: 100000, evalAmount: 1000000 },
    { account: '연금저축', assetClass: '국내주식', name: 'B펀드', ticker: '000002', qty: 5, curPrice: 200000, evalAmount: 1000000 },
    // 달러 과소보유(부족) — 연금저축은 자격 없음(위탁만 eligible)
    { account: '위탁', assetClass: '달러', name: '미국달러ETF', ticker: '000003', qty: 2, curPrice: 10000, evalAmount: 20000 },
    // 채권 정상 범위
    { account: '위탁', assetClass: '채권', name: '채권ETF', ticker: '000004', qty: 10, curPrice: 10000, evalAmount: 100000 },
  ];
}

test('buildBreachFacts: 초과 자산군엔 매도후보(qty 필드 포함), 부족 자산군엔 계좌별 매수후보', () => {
  const holdings = makeHoldings();
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const facts = buildBreachFacts(holdings, gaps, totalEval);
  const kr = facts.find((f) => f.assetClass === '국내주식');
  assert.equal(kr.direction, '초과');
  assert.ok(kr.sellCandidates.some((c) => c.name === 'A전자' && c.qty === 10));
  const usd = facts.find((f) => f.assetClass === '달러');
  assert.equal(usd.direction, '부족');
  assert.ok(usd.buyCandidatesByAccount.위탁);
  assert.equal(usd.buyCandidatesByAccount.연금저축, undefined); // 연금저축은 달러 자격 없음
});

test('computeBreachFingerprint: 같은 이탈집합이면 같은 지문, 방향이 바뀌면 다른 지문', () => {
  const holdings = makeHoldings();
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const facts = buildBreachFacts(holdings, gaps, totalEval);
  const fp1 = computeBreachFingerprint(facts);
  const fp2 = computeBreachFingerprint(buildBreachFacts(holdings, gaps, totalEval));
  assert.equal(fp1, fp2);

  const flipped = facts.map((f) => (f.assetClass === '국내주식' ? { ...f, direction: '부족' } : f));
  assert.notEqual(computeBreachFingerprint(flipped), fp1);
});

test('computeBreachFingerprint: 같은 자산군·같은 방향이어도 갭 크기가 1%p 이상 줄면 다른 지문 — 50% 캡 분할매수 후 재트리거가 실제로 이어지는지 회귀 방지(2026-08-23 코드리뷰 지적)', () => {
  const holdings = makeHoldings();
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const facts = buildBreachFacts(holdings, gaps, totalEval);
  const fp1 = computeBreachFingerprint(facts);

  // 절반만 매수 체결됐다고 가정 — 이탈유형·방향은 그대로지만 갭(absDeltaPct)이 좁혀짐.
  const halfExecuted = facts.map((f) => (f.assetClass === '달러' ? { ...f, absDeltaPct: f.absDeltaPct / 2 } : f));
  assert.notEqual(computeBreachFingerprint(halfExecuted), fp1, '갭이 줄었는데 지문이 그대로면 다음 실행에서 영원히 재트리거 안 됨');
});

test('buildRebalanceProposalPrompt: 분할매수 원칙·달러 분산 지시·재조회 금지 문구가 전부 포함', () => {
  const holdings = makeHoldings();
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const facts = buildBreachFacts(holdings, gaps, totalEval);
  const prompt = buildRebalanceProposalPrompt(facts);
  assert.match(prompt, /한 번에 채우려 하지 마라/);
  assert.match(prompt, /미국달러ETF와 엔선물ETF/);
  assert.match(prompt, /재조회·추정 금지/);
});

test('validateRebalanceActions: 방향 불일치는 드롭', () => {
  const holdings = makeHoldings();
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const breachFacts = buildBreachFacts(holdings, gaps, totalEval);
  const actions = [{ assetClass: '국내주식', side: '매수', account: '위탁', instrumentName: 'A전자', amountWon: 100000 }]; // 국내주식은 "초과"라 매도만 가능
  const { kept, dropped } = validateRebalanceActions(actions, { breachFacts, holdings });
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /방향 불일치/);
});

test('validateRebalanceActions: 매도인데 실보유 없으면 드롭', () => {
  const holdings = makeHoldings();
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const breachFacts = buildBreachFacts(holdings, gaps, totalEval);
  const actions = [{ assetClass: '국내주식', side: '매도', account: '위탁', instrumentName: '없는종목', amountWon: 100000 }];
  const { kept, dropped } = validateRebalanceActions(actions, { breachFacts, holdings });
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /실보유 없음/);
});

test('validateRebalanceActions: 매도 금액이 보유평가액을 초과하면 보유액으로 캡(50% 갭캡보다 보유액이 더 작은 경우)', () => {
  // 보유액을 일부러 작게 잡아(5000원) 50%갭캡보다 보유액쪽이 먼저 걸리는 시나리오를 분리.
  const holdings = [
    ...makeHoldings().filter((h) => h.name !== 'A전자'),
    { account: '위탁', assetClass: '국내주식', name: 'A전자', ticker: '000001', qty: 1, curPrice: 5000, evalAmount: 5000 },
  ];
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const breachFacts = buildBreachFacts(holdings, gaps, totalEval);
  const actions = [{ assetClass: '국내주식', side: '매도', account: '위탁', instrumentName: 'A전자', amountWon: 999999999 }];
  const { kept } = validateRebalanceActions(actions, { breachFacts, holdings });
  assert.equal(kept[0].amountWon, 5000); // A전자 evalAmount(5000)로 캡 — 50%갭캡보다 작아 이쪽이 binding
});

test('validateRebalanceActions: 50%갭캡이 보유액보다 작으면 갭캡이 최종 상한(두 캡 모두 적용됨을 확인)', () => {
  const holdings = makeHoldings(); // A전자 evalAmount=1,000,000 (큼) — 50%갭캡이 더 작을 것으로 기대
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const breachFacts = buildBreachFacts(holdings, gaps, totalEval);
  const kr = breachFacts.find((b) => b.assetClass === '국내주식');
  const halfGap = Math.abs(kr.gapWon) * 0.5;
  const actions = [{ assetClass: '국내주식', side: '매도', account: '위탁', instrumentName: 'A전자', amountWon: 999999999 }];
  const { kept } = validateRebalanceActions(actions, { breachFacts, holdings });
  assert.ok(halfGap < 1000000, '이 시나리오는 50%갭캡이 보유액보다 작아야 함');
  assert.equal(Math.round(kept[0].amountWon), Math.round(halfGap));
});

test('validateRebalanceActions: 분할매수 하드 캡 — 갭의 50% 초과분은 축소(드롭 아님)', () => {
  const holdings = makeHoldings();
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const breachFacts = buildBreachFacts(holdings, gaps, totalEval);
  const usd = breachFacts.find((b) => b.assetClass === '달러');
  const halfGap = Math.abs(usd.gapWon) * 0.5;
  const actions = [{ assetClass: '달러', side: '매수', account: '위탁', instrumentName: '미국달러ETF', amountWon: Math.abs(usd.gapWon) }]; // 갭 전액 요청
  const { kept, dropped } = validateRebalanceActions(actions, { breachFacts, holdings });
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0); // 드롭이 아니라 캡까지 축소
  assert.equal(Math.round(kept[0].amountWon), Math.round(halfGap));
});

test('validateRebalanceActions: 같은 자산군에 여러 라인이면 누적으로 50% 캡 적용, 캡 소진 후 라인은 드롭', () => {
  const holdings = makeHoldings();
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const breachFacts = buildBreachFacts(holdings, gaps, totalEval);
  const usd = breachFacts.find((b) => b.assetClass === '달러');
  const halfGap = Math.abs(usd.gapWon) * 0.5;
  const actions = [
    { assetClass: '달러', side: '매수', account: '위탁', instrumentName: '미국달러ETF', amountWon: halfGap },
    { assetClass: '달러', side: '매수', account: '위탁', instrumentName: '엔선물ETF', amountWon: 1 },
  ];
  const { kept, dropped } = validateRebalanceActions(actions, { breachFacts, holdings });
  assert.equal(kept.length, 1); // 첫 라인이 캡을 전부 소진
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /분할매수 캡/);
});

test('validateRebalanceActions: 보유평가액이 0이면(데이터 이상) 매도 드롭 — amountWon이 0으로 캡핑된 무의미한 제안 방지(2026-08-23 코드리뷰 지적)', () => {
  const holdings = [
    ...makeHoldings().filter((h) => h.name !== 'A전자'),
    { account: '위탁', assetClass: '국내주식', name: 'A전자', ticker: '000001', qty: 10, curPrice: 100000, evalAmount: 0 },
  ];
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const breachFacts = buildBreachFacts(holdings, gaps, totalEval);
  const actions = [{ assetClass: '국내주식', side: '매도', account: '위탁', instrumentName: 'A전자', amountWon: 500000 }];
  const { kept, dropped } = validateRebalanceActions(actions, { breachFacts, holdings });
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /보유평가액 0 이하/);
});

test('validateRebalanceActions: 연금저축은 달러 자격 없음(부적격 계좌 드롭)', () => {
  const holdings = makeHoldings();
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const breachFacts = buildBreachFacts(holdings, gaps, totalEval);
  const actions = [{ assetClass: '달러', side: '매수', account: '연금저축', instrumentName: '미국달러ETF', amountWon: 10000 }];
  const { kept, dropped } = validateRebalanceActions(actions, { breachFacts, holdings });
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /담을 수 없는 자산군/);
});

test('resolveRebalanceInstrumentPricing: 실보유와 이름 일치하면 수량 계산', () => {
  const holdings = makeHoldings();
  const action = { account: '위탁', assetClass: '국내주식', instrumentName: 'A전자', amountWon: 250000 };
  const pricing = resolveRebalanceInstrumentPricing(action, holdings);
  assert.equal(pricing.quantity, 2); // 250000/100000 = 2.5 → floor 2
  assert.equal(pricing.proposedPrice, 100000);
});

test('resolveRebalanceInstrumentPricing: 금액이 단가보다 작아 수량이 0이면 null(신규 매수와 동일 안전장치)', () => {
  const holdings = makeHoldings();
  const action = { account: '위탁', assetClass: '국내주식', instrumentName: 'A전자', amountWon: 50000 };
  const pricing = resolveRebalanceInstrumentPricing(action, holdings);
  assert.equal(pricing.quantity, null); // 50000/100000 = 0.5 → floor 0 → null(new-cash-allocation.mjs와 동일 규칙)
});

test('resolveRebalanceInstrumentPricing: 신규 종목(보유 없음)이면 quantity·price null', () => {
  const holdings = makeHoldings();
  const action = { account: '위탁', assetClass: '금', instrumentName: '신규금ETF', amountWon: 50000 };
  const pricing = resolveRebalanceInstrumentPricing(action, holdings);
  assert.equal(pricing.quantity, null);
  assert.equal(pricing.proposedPrice, null);
  assert.equal(pricing.assetKey, '신규금ETF');
});

test('allActionsSent: 전부 created여야 true', () => {
  assert.equal(allActionsSent([{ action: 'created' }, { action: 'created' }]), true);
  assert.equal(allActionsSent([{ action: 'created' }, { action: 'blocked' }]), false);
  assert.equal(allActionsSent([]), false);
});
