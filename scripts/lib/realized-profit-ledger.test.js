import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfitLookup, lookupRealizedProfit } from './realized-profit-ledger.mjs';

// 2026-08-30 신설 — report-facts.mjs·behavior-signals.mjs 둘 다 이 모듈 하나만 써서
// Profits 정본 조회 로직이 두 번 구현되지 않게 한다(오너 지적: 같은 개념을 여러 곳에서
// 각자 계산하면 한쪽만 고쳐도 갈라진다).

test('lookupRealizedProfit: account 있는 정확일치를 찾으면 실현손익 반환', () => {
  const lookup = buildProfitLookup([
    { date: '2026-08-27 10:06:45', stockName: 'PLUS 고배당주', quantity: 30, buyPrice: 17766, sellPrice: 25500, profit: 232020, account: '연금저축' },
  ]);
  const hit = lookupRealizedProfit({ date: '2026-08-27 10:06:45', account: '연금저축', name: 'PLUS 고배당주', qty: '30' }, lookup);
  assert.equal(hit.realizedWon, 232020);
  assert.equal(hit.realizedPct, 43.5);
});

test('lookupRealizedProfit: account 없는 레거시 레코드는 date|name|qty 보조 조회로 매칭', () => {
  const lookup = buildProfitLookup([
    { date: '2026-07-09 12:36:44', stockName: 'TIGER 미국배당다우존스', quantity: 10, buyPrice: 13000, sellPrice: 15200, profit: 22000, account: null },
  ]);
  const hit = lookupRealizedProfit({ date: '2026-07-09 12:36:44', account: '연금저축', name: 'TIGER 미국배당다우존스', qty: '10' }, lookup);
  assert.equal(hit.realizedWon, 22000);
});

test('lookupRealizedProfit: account 있는 정확일치가 보조 조회보다 우선', () => {
  const lookup = buildProfitLookup([
    { date: '2026-07-09', stockName: 'X', quantity: 1, buyPrice: 999, sellPrice: 999, profit: 999, account: null },
    { date: '2026-07-09', stockName: 'X', quantity: 1, buyPrice: 100, sellPrice: 200, profit: 100, account: '위탁' },
  ]);
  const hit = lookupRealizedProfit({ date: '2026-07-09', account: '위탁', name: 'X', qty: '1' }, lookup);
  assert.equal(hit.realizedWon, 100);
});

test('lookupRealizedProfit: 매칭 실패면 null(호출부가 재구성 폴백으로 넘어가게)', () => {
  const lookup = buildProfitLookup([]);
  assert.equal(lookupRealizedProfit({ date: '2026-08-27', account: '위탁', name: '없는종목', qty: '1' }, lookup), null);
});

test('lookupRealizedProfit: lookup 자체가 없어도(undefined) 안전하게 null', () => {
  assert.equal(lookupRealizedProfit({ date: '2026-08-27', account: '위탁', name: 'X', qty: '1' }, undefined), null);
});

test('lookupRealizedProfit: profit이 유한수가 아니면(malformed) null — null>=0 JS 강제변환 방지', () => {
  const lookup = buildProfitLookup([
    { date: '2026-08-27', stockName: 'X', quantity: 1, buyPrice: 100, sellPrice: 90, profit: null, account: '위탁' },
  ]);
  assert.equal(lookupRealizedProfit({ date: '2026-08-27', account: '위탁', name: 'X', qty: '1' }, lookup), null);
});

test('lookupRealizedProfit: buyPrice가 0 이하면 realizedPct는 null(0으로 나눔 방지), realizedWon은 그대로', () => {
  const lookup = buildProfitLookup([
    { date: '2026-08-27', stockName: 'X', quantity: 1, buyPrice: 0, sellPrice: 100, profit: 100, account: '위탁' },
  ]);
  const hit = lookupRealizedProfit({ date: '2026-08-27', account: '위탁', name: 'X', qty: '1' }, lookup);
  assert.equal(hit.realizedWon, 100);
  assert.equal(hit.realizedPct, null);
});

// qty 정규화(2026-08-31 코드리뷰 지적 — normQty가 콤마·공백을 무시하지 않으면 v1
// 시트 스키마 유산의 "1,000" 같은 표기가 인덱스의 숫자 1000과 조용히 안 맞아 매칭
// 실패로 빠진다, feedback-sheets-numeric-parsing 메모리와 동일한 함정).
test('lookupRealizedProfit: qty에 콤마·공백이 섞여도(v1 시트 표기 유산) 인덱스의 숫자 quantity와 매칭', () => {
  const lookup = buildProfitLookup([
    { date: '2026-08-27', stockName: 'X', quantity: 1000, buyPrice: 100, sellPrice: 200, profit: 100000, account: '위탁' },
  ]);
  assert.equal(lookupRealizedProfit({ date: '2026-08-27', account: '위탁', name: 'X', qty: '1,000' }, lookup)?.realizedWon, 100000);
  assert.equal(lookupRealizedProfit({ date: '2026-08-27', account: '위탁', name: 'X', qty: ' 1000 ' }, lookup)?.realizedWon, 100000);
  assert.equal(lookupRealizedProfit({ date: '2026-08-27', account: '위탁', name: 'X', qty: 1000 }, lookup)?.realizedWon, 100000);
});

test('lookupRealizedProfit: 빈 qty("")는 quantity:0인 레코드와 절대 안 겹침(2026-08-31 코드리뷰 지적 — "수량 모름"과 "수량 0"을 같은 정규화 키로 합치면 안 됨)', () => {
  const lookup = buildProfitLookup([
    { date: '2026-08-27', stockName: 'X', quantity: 0, buyPrice: 100, sellPrice: 200, profit: 100000, account: '위탁' },
  ]);
  assert.equal(lookupRealizedProfit({ date: '2026-08-27', account: '위탁', name: 'X', qty: '' }, lookup), null);
  assert.equal(lookupRealizedProfit({ date: '2026-08-27', account: '위탁', name: 'X', qty: undefined }, lookup), null);
  // quantity:0을 실제 "0"으로 조회하면 여전히 정상 매칭돼야 한다
  assert.equal(lookupRealizedProfit({ date: '2026-08-27', account: '위탁', name: 'X', qty: '0' }, lookup)?.realizedWon, 100000);
});

test('buildProfitLookup: date·stockName·quantity 중 하나라도 없으면 인덱싱에서 제외', () => {
  const lookup = buildProfitLookup([
    { date: null, stockName: 'X', quantity: 1, profit: 100, account: '위탁' },
    { date: '2026-08-27', stockName: null, quantity: 1, profit: 100, account: '위탁' },
    { date: '2026-08-27', stockName: 'X', quantity: null, profit: 100, account: '위탁' },
  ]);
  assert.equal(lookup.byKey.size, 0);
  assert.equal(lookup.byKeyNoAccount.size, 0);
});
