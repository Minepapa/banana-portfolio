import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFundPurchase, checkFundValuationDrift, isValuationStale, DEFAULT_FUND_ASSET_CLASS } from './fund-holdings-updater.mjs';

// 가상값(공개 저장소 — 실제 펀드명·적립금·좌수를 쓰지 않는다).
const PURCHASE = { fundName: '가상적립펀드', amount: 100000, nav: 2000, units: 50000, account: '연금저축', dedupKey: '2026-09-01|가상적립펀드|100000' };

test('[실사고 재현] applyFundPurchase: 기존 보유 없으면 이번 매수 그대로 첫 보유가 됨', () => {
  const updated = applyFundPurchase(null, PURCHASE);
  assert.equal(updated.qty, 50000);
  assert.equal(updated.invest, 100000);
  assert.equal(updated.account, '연금저축');
  assert.equal(updated.curPrice, null);
  assert.equal(updated.evalAmount, null); // curPrice 없으면 평가액도 추정 안 함
});

test('[코드리뷰 MEDIUM 지적] applyFundPurchase: 기존 보유 없으면(신규 펀드 생성) assetClass 빈 문자열 대신 기본값', () => {
  const updated = applyFundPurchase(null, PURCHASE);
  assert.equal(updated.assetClass, DEFAULT_FUND_ASSET_CLASS);
});

test('applyFundPurchase: 기존 보유에 정확히 누적(실측 데이터 기준 avgPrice 역산 검증)', () => {
  // 가상값: invest 1,500,000/qty 1,000,000 → avgPrice 1,500(실측 검증 방식과 같은 역산)
  const existing = { qty: 1000000, invest: 1500000, curPrice: 1600, assetClass: '국내주식', ticker: '', market: '' };
  const updated = applyFundPurchase(existing, { ...PURCHASE, units: 49999.37 });
  assert.equal(updated.qty, 1000000 + 49999.37);
  assert.equal(updated.invest, 1600000);
  // avgPrice = (invest/qty)*1000
  const expectedAvgPrice = (1600000 / (1000000 + 49999.37)) * 1000;
  assert.ok(Math.abs(updated.avgPrice - expectedAvgPrice) < 1e-6);
});

test('applyFundPurchase: curPrice 있으면 evalAmount·profitAmount·profitPct 즉시 재계산(unitScale 0.001)', () => {
  const existing = { qty: 1000, invest: 2000, curPrice: 2000 };
  const updated = applyFundPurchase(existing, { ...PURCHASE, fundName: 'X', amount: 1000, nav: 2000, units: 500 });
  assert.equal(updated.qty, 1500);
  assert.equal(updated.invest, 3000);
  assert.equal(updated.curPrice, 2000);
  // evalAmount = curPrice * qty * 0.001 = 2000 * 1500 * 0.001 = 3000
  assert.equal(updated.evalAmount, 3000);
  assert.equal(updated.profitAmount, 0);
  assert.equal(updated.profitPct, 0);
});

test('applyFundPurchase: assetClass·ticker·market은 기존 보유에서 이어받음(identity 필드)', () => {
  const existing = { qty: 100, invest: 1000, assetClass: '국내주식', ticker: 'X', market: 'KR' };
  const updated = applyFundPurchase(existing, { ...PURCHASE, amount: 100, nav: 100, units: 100 });
  assert.equal(updated.assetClass, '국내주식');
  assert.equal(updated.ticker, 'X');
  assert.equal(updated.market, 'KR');
});

test('[코드리뷰 HIGH 지적] applyFundPurchase: appliedDedupKeys에 이번 매수 dedupKey를 누적(2차 방어용)', () => {
  const existing = { qty: 100, invest: 1000, appliedDedupKeys: ['old-key'] };
  const updated = applyFundPurchase(existing, PURCHASE);
  assert.deepEqual(updated.appliedDedupKeys, ['old-key', PURCHASE.dedupKey]);
});

test('applyFundPurchase: 기존 보유 없으면 appliedDedupKeys는 이번 매수 dedupKey 하나만', () => {
  const updated = applyFundPurchase(null, PURCHASE);
  assert.deepEqual(updated.appliedDedupKeys, [PURCHASE.dedupKey]);
});

test('[코드리뷰 MEDIUM 지적] applyFundPurchase: amount·units가 NaN·0·음수면 throw(누적 안 함, 포지션 조용히 안 깨짐)', () => {
  assert.throws(() => applyFundPurchase(null, { ...PURCHASE, amount: NaN }), /금액\/좌수/);
  assert.throws(() => applyFundPurchase(null, { ...PURCHASE, units: NaN }), /금액\/좌수/);
  assert.throws(() => applyFundPurchase(null, { ...PURCHASE, amount: 0 }), /금액\/좌수/);
  assert.throws(() => applyFundPurchase(null, { ...PURCHASE, units: -5 }), /금액\/좌수/);
});

test('[실사고 재현] checkFundValuationDrift: 미반영 매수 1건(적립금)과 정확히 같은 크기의 차이를 잡아냄', () => {
  const holding = { invest: 1500000 };
  const valuation = { principal: 1600000, date: '2026-09-04' };
  const warning = checkFundValuationDrift(holding, valuation);
  assert.match(warning, /100,000원/);
  assert.match(warning, /2026-09-04/);
});

test('checkFundValuationDrift: threshold 이내 차이는 경고 없음(반올림 오차 허용)', () => {
  assert.equal(checkFundValuationDrift({ invest: 1600500 }, { principal: 1600000, date: '2026-09-04' }), null);
});

test('checkFundValuationDrift: holding·valuation 둘 중 하나 없으면(비교 불가) null', () => {
  assert.equal(checkFundValuationDrift(null, { principal: 100, date: 'x' }), null);
  assert.equal(checkFundValuationDrift({ invest: 100 }, null), null);
});

test('checkFundValuationDrift: 이름매칭 안 함(호출부가 이미 같은 펀드로 확정해서 넘김) — 값 차이만 본다', () => {
  // fundName 필드 자체를 안 받는다는 걸 확인 — 넘겨도 무시됨
  const warning = checkFundValuationDrift({ invest: 100000, fundName: 'A' }, { invest: 100000, principal: 90000, fundName: 'B(다른표기)', date: 'x' });
  assert.match(warning, /10,000원/);
});

test('[코드리뷰 HIGH 지적/실사고 방지] isValuationStale: valuation이 최근 반영된 매수보다 옛날 기준이면 true(비교 무의미)', () => {
  // 재현: 9/1 매수를 반영했는데 아직 8월분 펀드평가만 온 상태 — 이 경우 drift 비교하면
  // 매달 며칠간 "정상인데 불일치"로 오탐난다.
  assert.equal(isValuationStale('2026-09-01', { date: '2026-08-05' }), true);
});

test('isValuationStale: valuation이 최근 매수와 같은 날이거나 이후면 false(비교 유효)', () => {
  assert.equal(isValuationStale('2026-09-01', { date: '2026-09-01' }), false);
  assert.equal(isValuationStale('2026-09-01', { date: '2026-09-04' }), false);
});

test('isValuationStale: 반영 이력이 아예 없으면(latestAppliedPurchaseDate=null) 항상 false(비교 시도)', () => {
  assert.equal(isValuationStale(null, { date: '2026-09-04' }), false);
});
