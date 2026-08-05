import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBuy, applySell, consolidateLots } from './holdings-updater.mjs';

test('applyBuy: 기존 보유 없으면 새 보유 생성', () => {
  const exec = { account: '위탁', assetClass: '국내주식', stockName: '삼성전자', stockCode: '005930', price: 70000, quantity: 10 };
  const h = applyBuy(null, exec);
  assert.equal(h.qty, 10);
  assert.equal(h.avgPrice, 70000);
  assert.equal(h.invest, 700000);
  assert.equal(h.account, '위탁');
});

test('applyBuy: 기존 보유 있으면 가중평균으로 합침', () => {
  const existing = { account: '위탁', assetClass: '국내주식', name: '삼성전자', ticker: '005930', market: '', avgPrice: 50450, qty: 40, invest: 2018000, curPrice: null, evalAmount: null, profitAmount: null, profitPct: null, isCashLike: false };
  const exec = { account: '위탁', stockName: '삼성전자', price: 60000, quantity: 10 };
  const h = applyBuy(existing, exec);
  assert.equal(h.qty, 50);
  assert.equal(h.invest, 2018000 + 600000);
  assert.equal(h.avgPrice, (2018000 + 600000) / 50);
});

test('applyBuy: 기존 필드(assetClass 등)는 보존', () => {
  const existing = { account: '위탁', assetClass: '국내주식', name: '삼성전자', ticker: '005930', market: '', avgPrice: 100, qty: 1, invest: 100, curPrice: 105, evalAmount: 105, profitAmount: 5, profitPct: 5, isCashLike: false };
  const h = applyBuy(existing, { account: '위탁', stockName: '삼성전자', price: 100, quantity: 1 });
  assert.equal(h.assetClass, '국내주식');
  assert.equal(h.ticker, '005930');
});

test('applySell: 기존 보유 없으면 경고, 아무것도 안 씀', () => {
  const r = applySell(null, { account: '위탁', stockName: '없는종목', price: 100, quantity: 1 });
  assert.equal(r.updatedHolding, null);
  assert.ok(r.warning);
  assert.equal(r.closed, false);
});

test('applySell: 매도수량이 보유수량 초과면 경고, 값 변경 안 함', () => {
  const existing = { account: '위탁', name: '삼성전자', avgPrice: 50000, qty: 10, invest: 500000 };
  const r = applySell(existing, { account: '위탁', stockName: '삼성전자', price: 60000, quantity: 20 });
  assert.equal(r.updatedHolding, null);
  assert.ok(r.warning.includes('초과'));
});

test('applySell: 일부 매도 — 평단가 유지, 수량·투자금 비례 축소, 실현손익 계산', () => {
  const existing = { account: '위탁', name: '삼성전자', avgPrice: 50000, qty: 10, invest: 500000 };
  const r = applySell(existing, { account: '위탁', stockName: '삼성전자', price: 70000, quantity: 4 });
  assert.equal(r.closed, false);
  assert.equal(r.updatedHolding.qty, 6);
  assert.equal(r.updatedHolding.avgPrice, 50000);
  assert.equal(r.updatedHolding.invest, 300000);
  assert.equal(r.realizedProfit, (70000 - 50000) * 4);
});

test('applySell: 전량 매도 — updatedHolding null + closed:true, 파일 삭제 신호', () => {
  const existing = { account: '위탁', name: '삼성전자', avgPrice: 50000, qty: 10, invest: 500000 };
  const r = applySell(existing, { account: '위탁', stockName: '삼성전자', price: 40000, quantity: 10 });
  assert.equal(r.updatedHolding, null);
  assert.equal(r.closed, true);
  assert.equal(r.warning, null);
  assert.equal(r.realizedProfit, (40000 - 50000) * 10);
});

test('applySell: 부동소수점 오차로 남은 극소수량은 전량매도로 취급(EPS)', () => {
  const existing = { account: '위탁', name: 'X', avgPrice: 100, qty: 0.3, invest: 30 };
  const r = applySell(existing, { account: '위탁', stockName: 'X', price: 100, quantity: 0.1 + 0.2 }); // 부동소수점 0.30000000000000004
  assert.equal(r.closed, true);
});

// consolidateLots — 코드리뷰 지적으로 추가(2026-08-05): 위탁 삼성전자 40주@50,450원 +
// 30주@54,700원처럼 Phase 7 마이그레이션이 로트별로 나눠둔 파일들을 실제 체결 적용
// 전에 하나로 합쳐야 한다(그렇지 않으면 Map 키 충돌로 한쪽 로트가 조용히 사라짐).
test('consolidateLots: 로트 1개면 그대로 반환', () => {
  const lot = { account: '위탁', name: '삼성전자', qty: 10, invest: 100, avgPrice: 10, curPrice: null };
  assert.equal(consolidateLots([lot]), lot);
});

test('consolidateLots: 빈 배열이면 null', () => {
  assert.equal(consolidateLots([]), null);
});

test('consolidateLots: 실제 사고 재현 — 위탁 삼성전자 2로트를 가중평균으로 합침', () => {
  const lots = [
    { account: '위탁', assetClass: '국내주식', name: '삼성전자', ticker: '005930', qty: 40, invest: 2018000, avgPrice: 50450, curPrice: null },
    { account: '위탁', assetClass: '국내주식', name: '삼성전자', ticker: '005930', qty: 30, invest: 1641000, avgPrice: 54700, curPrice: null },
  ];
  const merged = consolidateLots(lots);
  assert.equal(merged.qty, 70);
  assert.equal(merged.invest, 2018000 + 1641000);
  assert.equal(merged.avgPrice, (2018000 + 1641000) / 70);
});

test('consolidateLots: curPrice가 전부 있으면 evalAmount·profitAmount·profitPct를 합산 수량 기준 재계산', () => {
  const lots = [
    { account: '위탁', name: 'X', qty: 10, invest: 1000, avgPrice: 100, curPrice: 120 },
    { account: '위탁', name: 'X', qty: 5, invest: 400, avgPrice: 80, curPrice: 120 },
  ];
  const merged = consolidateLots(lots);
  assert.equal(merged.curPrice, 120);
  assert.equal(merged.evalAmount, 120 * 15);
  assert.equal(merged.profitAmount, 120 * 15 - 1400);
  assert.equal(merged.profitPct, ((120 * 15 - 1400) / 1400) * 100);
});

test('consolidateLots: 하나라도 curPrice가 null이면 전부 null(추정 안 함)', () => {
  const lots = [
    { account: '위탁', name: 'X', qty: 10, invest: 1000, avgPrice: 100, curPrice: 120 },
    { account: '위탁', name: 'X', qty: 5, invest: 400, avgPrice: 80, curPrice: null },
  ];
  const merged = consolidateLots(lots);
  assert.equal(merged.curPrice, null);
  assert.equal(merged.evalAmount, null);
  assert.equal(merged.profitAmount, null);
  assert.equal(merged.profitPct, null);
});
