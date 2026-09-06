import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getMonthLabel, shouldRunThisMonth, computeTiltRoomFacts, buildMacroTiltPrompt,
  validateMacroTiltActions, buildThemisTiltReviewPrompt, buildTiltReason, allActionsSent,
} from './monthly-macro-tilt-proposal.mjs';
import { computeRebalanceGaps } from '../lib/rebalance-gap.mjs';

test('getMonthLabel: YYYY-MM 포맷(0패딩)', () => {
  assert.equal(getMonthLabel(new Date(2026, 8, 5)), '2026-09');
});

test('shouldRunThisMonth: 31일짜리 달의 마지막 3일(29~31) 중 평일이면 true', () => {
  // 2026-01-29는 목요일
  assert.equal(shouldRunThisMonth(new Date(2026, 0, 29), '2025-12'), true);
});

test('shouldRunThisMonth: 마지막 3일보다 이르면 false', () => {
  assert.equal(shouldRunThisMonth(new Date(2026, 0, 28), '2025-12'), false);
});

test('shouldRunThisMonth: 28일짜리 달(2월, 평년)도 마지막 3일 기준으로 계산', () => {
  // 2026년은 평년 — 2월 26~28일이 마지막 3일. 2026-02-26은 목요일.
  assert.equal(shouldRunThisMonth(new Date(2026, 1, 26), '2026-01'), true);
  assert.equal(shouldRunThisMonth(new Date(2026, 1, 25), '2026-01'), false);
});

test('shouldRunThisMonth: 주말이면 false', () => {
  // 2026-01-31은 토요일
  assert.equal(shouldRunThisMonth(new Date(2026, 0, 31), '2025-12'), false);
});

test('shouldRunThisMonth: 이번 달 이미 실행됐으면 false', () => {
  assert.equal(shouldRunThisMonth(new Date(2026, 0, 29), '2026-01'), false);
});

function makeInBandHoldings() {
  return [
    { account: '위탁', assetClass: '채권', name: '채권ETF', evalAmount: 190000 }, // 목표 20%보다 살짬 낮음(밴드 안)
    { account: '위탁', assetClass: '금', name: '금ETF', evalAmount: 100000 },
    { account: '위탁', assetClass: '달러', name: '달러ETF', evalAmount: 100000 },
    { account: '위탁', assetClass: '국내주식', name: 'A전자', evalAmount: 310000 }, // 목표 30%보다 살짝 높음(밴드 안)
    { account: '위탁', assetClass: '해외주식', name: '해외ETF', evalAmount: 300000 },
  ];
}

test('computeTiltRoomFacts: 이미 이탈한(room<=0) 자산군은 제외, 안 터진 자산군만 여유폭·캡예산 계산', () => {
  // 국내주식만 목표(30%) 대비 크게 초과(39.8%, 절대밴드 5%p 초과)하고 나머지 4개 자산군은
  // 각자 목표 근처(밴드 안)에 머물도록 비중을 직접 설계(총합 100%) — 5개 자산군의
  // currentPct는 서로 상대적이라(totalEval 공유) 한 자산군만 절대금액으로 키우면 다른
  // 자산군 비중도 같이 흔들려 의도치 않게 이중으로 이탈하는 함정이 있었음(최초 시도에서
  // 실제로 겪음 — 국내주식만 키웠더니 희석 때문에 채권·해외주식까지 이탈해버림).
  const holdings = [
    { account: '위탁', assetClass: '채권', name: '채권ETF', evalAmount: 151000 }, // 15.1%(목표20, -4.9%p, 밴드 안)
    { account: '위탁', assetClass: '금', name: '금ETF', evalAmount: 100000 }, // 10%(목표 그대로)
    { account: '위탁', assetClass: '달러', name: '달러ETF', evalAmount: 100000 }, // 10%(목표 그대로)
    { account: '위탁', assetClass: '해외주식', name: '해외ETF', evalAmount: 251000 }, // 25.1%(목표30, -4.9%p, 밴드 안)
    { account: '위탁', assetClass: '국내주식', name: 'A전자', evalAmount: 398000 }, // 39.8%(목표30, +9.8%p, 이탈)
  ];
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const roomFacts = computeTiltRoomFacts(gaps, totalEval);
  assert.ok(!roomFacts.some((f) => f.assetClass === '국내주식')); // 이미 이탈 — 제외됨
  const bond = roomFacts.find((f) => f.assetClass === '채권');
  assert.ok(bond);
  assert.ok(bond.room > 0);
  assert.ok(bond.capBudgetWon > 0);
});

test('computeTiltRoomFacts: capBudgetWon = room * CAP_FRACTION(0.5) * totalEval / 100', () => {
  const holdings = makeInBandHoldings();
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const roomFacts = computeTiltRoomFacts(gaps, totalEval);
  const bond = roomFacts.find((f) => f.assetClass === '채권');
  assert.ok(bond);
  const expected = (bond.room * 0.5 * totalEval) / 100;
  assert.ok(Math.abs(bond.capBudgetWon - expected) < 1e-6);
});

test('buildMacroTiltPrompt: 여유폭·캡금액·신호 원문이 전부 포함, 자유선택 문구', () => {
  const roomFacts = [{ assetClass: '채권', targetPct: 20, currentPct: 18, room: 3, capBudgetWon: 150_000 }];
  const prompt = buildMacroTiltPrompt({ signalsReport: '[테스트 신호 원문]', roomFacts });
  assert.match(prompt, /테스트 신호 원문/);
  assert.match(prompt, /채권.*목표 20% \/ 현재 18\.00%/);
  assert.match(prompt, /150,000원/);
  assert.match(prompt, /actions를 빈 배열로 둬라/);
});

test('buildMacroTiltPrompt: rankedUniverseByClass 있으면 데이터 기반 순위 블록 렌더', () => {
  const roomFacts = [{ assetClass: '금', targetPct: 10, currentPct: 8, room: 2, capBudgetWon: 100_000 }];
  const ranked = { 금: [{ name: '금ETF-A', composite: 88.5, axes: {}, dataGaps: [] }] };
  const prompt = buildMacroTiltPrompt({ signalsReport: '(신호)', roomFacts, rankedUniverseByClass: ranked });
  assert.match(prompt, /데이터 기반 순위 중에서만 골라라/);
  assert.match(prompt, /1\. 금ETF-A \(점수 88\.5\/100\)/);
});

test('buildMacroTiltPrompt: 틸트 가능 자산군이 없으면 안내 문구', () => {
  const prompt = buildMacroTiltPrompt({ signalsReport: '(신호)', roomFacts: [] });
  assert.match(prompt, /틸트 가능한 자산군 없음/);
});

test('buildMacroTiltPrompt: cashByAccount가 있으면 계좌별 가용 예수금 블록 렌더(2026-09-06 코드리뷰 지적)', () => {
  const roomFacts = [{ assetClass: '채권', targetPct: 20, currentPct: 18, room: 3, capBudgetWon: 150_000 }];
  const prompt = buildMacroTiltPrompt({ signalsReport: '(신호)', roomFacts, cashByAccount: { 위탁: 1_200_000 } });
  assert.match(prompt, /가용 예수금/);
  assert.match(prompt, /위탁: 1,200,000원/);
});

test('buildMacroTiltPrompt: cashByAccount 생략하면 "데이터 없음" 안내', () => {
  const roomFacts = [{ assetClass: '채권', targetPct: 20, currentPct: 18, room: 3, capBudgetWon: 150_000 }];
  const prompt = buildMacroTiltPrompt({ signalsReport: '(신호)', roomFacts });
  assert.match(prompt, /가용 예수금 데이터 없음/);
});

test('validateMacroTiltActions: 캡 예산 안이면 유지, 초과분은 드롭 아니라 캡까지 축소', () => {
  const capBudgetByClass = { 채권: 100_000 };
  const actions = [{ assetClass: '채권', side: '매수', account: '위탁', instrumentName: '채권ETF', amountWon: 150_000 }];
  const holdings = [{ account: '위탁', assetClass: '채권', name: '채권ETF', ticker: '000001', qty: 1, curPrice: 10000, evalAmount: 10000 }];
  const { kept, dropped } = validateMacroTiltActions(actions, { capBudgetByClass, holdings });
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].amountWon, 100_000);
});

test('validateMacroTiltActions: 캡 목록 밖 자산군(이미 이탈)은 드롭', () => {
  const capBudgetByClass = { 채권: 100_000 };
  const actions = [{ assetClass: '국내주식', side: '매수', account: '위탁', instrumentName: 'X', amountWon: 10000 }];
  const { kept, dropped } = validateMacroTiltActions(actions, { capBudgetByClass, holdings: [] });
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /틸트 대상 밖 자산군/);
});

test('validateMacroTiltActions: side가 매수/매도 아니면 드롭(고정 방향 없음 — rebalance-proposal과 다른 점)', () => {
  const capBudgetByClass = { 채권: 100_000 };
  const actions = [{ assetClass: '채권', side: '보류', account: '위탁', instrumentName: 'X', amountWon: 10000 }];
  const { kept, dropped } = validateMacroTiltActions(actions, { capBudgetByClass, holdings: [] });
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /side 값 이상/);
});

test('validateMacroTiltActions: 매도인데 실보유 없으면 드롭, 보유평가액 초과 시 캡', () => {
  const capBudgetByClass = { 채권: 1_000_000 };
  const holdings = [{ account: '위탁', assetClass: '채권', name: '채권ETF', evalAmount: 50_000 }];
  const noHoldAction = [{ assetClass: '채권', side: '매도', account: '위탁', instrumentName: '없는종목', amountWon: 10000 }];
  const { dropped: d1 } = validateMacroTiltActions(noHoldAction, { capBudgetByClass, holdings });
  assert.match(d1[0].reason, /실보유 없음/);

  const overAction = [{ assetClass: '채권', side: '매도', account: '위탁', instrumentName: '채권ETF', amountWon: 999_999 }];
  const { kept: k2 } = validateMacroTiltActions(overAction, { capBudgetByClass, holdings });
  assert.equal(k2[0].amountWon, 50_000); // 보유평가액으로 캡
});

test('validateMacroTiltActions: 매수인데 그 계좌가 담을 수 없는 자산군이면 드롭', () => {
  const capBudgetByClass = { 달러: 100_000 };
  const actions = [{ assetClass: '달러', side: '매수', account: '연금저축', instrumentName: 'X', amountWon: 10000 }];
  const { kept, dropped } = validateMacroTiltActions(actions, { capBudgetByClass, holdings: [] });
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /담을 수 없는 자산군/);
});

test('validateMacroTiltActions: 보유 후보 0건 계좌의 신규매수가 순위 목록 밖 이름이면 드롭', () => {
  const capBudgetByClass = { 금: 100_000 };
  const rankedUniverseByClass = { 금: [{ name: '금ETF-A', composite: 80, axes: {}, dataGaps: [] }] };
  const actions = [{ assetClass: '금', side: '매수', account: '위탁', instrumentName: '아무거나', amountWon: 10000 }];
  const { kept, dropped } = validateMacroTiltActions(actions, { capBudgetByClass, holdings: [], rankedUniverseByClass });
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /순위에 없는 이름/);
});

test('buildThemisTiltReviewPrompt: 액션 목록·금액·신호 원문이 포함, 통과/보류 판정 요청', () => {
  const actions = [{ account: '위탁', side: '매수', instrumentName: '채권ETF', assetClass: '채권', amountWon: 100_000, reasoning: '테스트 근거' }];
  const prompt = buildThemisTiltReviewPrompt({ signalsReport: '[신호]', actions });
  assert.match(prompt, /\[신호\]/);
  assert.match(prompt, /채권ETF\(채권\) 약 100,000원/);
  assert.match(prompt, /테스트 근거/);
  assert.match(prompt, /"verdict":"통과 또는 보류"/);
});

test('validateMacroTiltActions: 같은 계좌·자산군·종목·방향이 중복되면 두 번째는 드롭(2026-09-06 코드리뷰 지적)', () => {
  const capBudgetByClass = { 채권: 1_000_000 };
  const holdings = [{ account: '위탁', assetClass: '채권', name: '채권ETF', evalAmount: 500_000 }];
  const actions = [
    { assetClass: '채권', side: '매도', account: '위탁', instrumentName: '채권ETF', amountWon: 100_000 },
    { assetClass: '채권', side: '매도', account: '위탁', instrumentName: '채권ETF', amountWon: 50_000 },
  ];
  const { kept, dropped } = validateMacroTiltActions(actions, { capBudgetByClass, holdings });
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /중복/);
});

test('validateMacroTiltActions: 같은 계좌·종목에 매수·매도가 동시에 오면(모순) 두 번째는 드롭', () => {
  const capBudgetByClass = { 채권: 1_000_000 };
  const holdings = [{ account: '위탁', assetClass: '채권', name: '채권ETF', evalAmount: 500_000 }];
  const actions = [
    { assetClass: '채권', side: '매도', account: '위탁', instrumentName: '채권ETF', amountWon: 100_000 },
    { assetClass: '채권', side: '매수', account: '위탁', instrumentName: '채권ETF', amountWon: 50_000 },
  ];
  const { kept, dropped } = validateMacroTiltActions(actions, { capBudgetByClass, holdings });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].side, '매도');
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /모순/);
});

test('validateMacroTiltActions: 다른 계좌라면 같은 종목·방향이어도 중복 아님', () => {
  const capBudgetByClass = { 채권: 1_000_000 };
  const holdings = [
    { account: '위탁', assetClass: '채권', name: '채권ETF', evalAmount: 500_000 },
    { account: '연금저축', assetClass: '채권', name: '채권ETF', evalAmount: 500_000 },
  ];
  const actions = [
    { assetClass: '채권', side: '매도', account: '위탁', instrumentName: '채권ETF', amountWon: 100_000 },
    { assetClass: '채권', side: '매도', account: '연금저축', instrumentName: '채권ETF', amountWon: 100_000 },
  ];
  const { kept, dropped } = validateMacroTiltActions(actions, { capBudgetByClass, holdings });
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 0);
});

test('buildTiltReason: verdict가 "통과"이고 caveat가 없으면 reasoning 그대로', () => {
  const action = { reasoning: '신호가 강해서' };
  assert.equal(buildTiltReason(action, { verdict: '통과', caveat: '' }), '신호가 강해서');
});

test('buildTiltReason: verdict가 "통과"라도 caveat가 있으면 이어붙인다(2026-09-06 코드리뷰 지적 — 예전엔 통과일 때 caveat를 무조건 버렸음)', () => {
  const action = { reasoning: '신호가 강해서' };
  const reason = buildTiltReason(action, { verdict: '통과', caveat: 'DXY 쪽은 주시 필요' });
  assert.match(reason, /신호가 강해서/);
  assert.match(reason, /\[리스크관리실 Themis · 통과\] DXY 쪽은 주시 필요/);
});

test('buildTiltReason: verdict가 "보류"면 caveat를 이어붙인다', () => {
  const action = { reasoning: '신호가 강해서' };
  const reason = buildTiltReason(action, { verdict: '보류', caveat: '틸트 규모가 과도해 보임' });
  assert.match(reason, /\[리스크관리실 Themis · 보류\] 틸트 규모가 과도해 보임/);
});

test('buildTiltReason: verdict 필드 자체가 없는 malformed 응답도 안전하게 처리(undefined 문자열 노출 방지)', () => {
  const action = { reasoning: '신호가 강해서' };
  const reason = buildTiltReason(action, { caveat: '뭔가 이상함' });
  assert.doesNotMatch(reason, /undefined/);
  assert.match(reason, /\[리스크관리실 Themis · 판정불명\] 뭔가 이상함/);
});

test('buildTiltReason: themisVerdict 자체가 없어도(예: 호출 자체가 스킵) 크래시 없이 reasoning 그대로', () => {
  const action = { reasoning: '신호가 강해서' };
  assert.equal(buildTiltReason(action, undefined), '신호가 강해서');
});

test('allActionsSent: 전부 created여야 true', () => {
  assert.equal(allActionsSent([{ action: 'created' }, { action: 'created' }]), true);
});

test('allActionsSent: 하나라도 blocked·failed면 false', () => {
  assert.equal(allActionsSent([{ action: 'created' }, { action: 'blocked' }]), false);
  assert.equal(allActionsSent([{ action: 'failed' }]), false);
});

test('allActionsSent: 빈 배열이면 false(아무것도 안 보냈으니 갱신 대상 아님)', () => {
  assert.equal(allActionsSent([]), false);
});
