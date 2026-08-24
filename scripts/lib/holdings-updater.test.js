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

// 실사고 재현(2026-08-24, 오너 신고) — 과거 전량매도 후 curPrice·시세 갱신만 계속되던
// 0-qty 플레이스홀더 보유(ACE 미국달러SOFR금리(합성) 등)에 새로 매수가 들어왔는데,
// evalAmount가 매수 이전 값(qty=0 시절의 0원)을 그대로 들고 가 프론트엔드 필터
// (invest>0 && eval>0)에 걸려 화면에서 사라졌다. curPrice는 이미 유효한데도 새 qty로
// 재계산을 안 한 게 근본원인.
test('applyBuy: 0-qty 플레이스홀더(curPrice는 있고 qty만 0)에 매수가 들어오면 evalAmount를 새 수량 기준으로 즉시 재계산 — 0원에 머물지 않음', () => {
  const existing = { account: '연금저축', assetClass: '달러', name: 'ACE 미국달러SOFR금리(합성)', ticker: '', market: '', avgPrice: 12200, qty: 0, invest: 0, curPrice: 12130, evalAmount: 0, profitAmount: 0, profitPct: null, isCashLike: false };
  const h = applyBuy(existing, { account: '연금저축', stockName: 'ACE 미국달러SOFR금리(합성)', price: 12130, quantity: 100 });
  assert.equal(h.qty, 100);
  assert.equal(h.invest, 1213000);
  assert.equal(h.curPrice, 12130); // 체결 자체가 새 시세를 알려주진 않음 — 기존 curPrice 이어받음
  assert.equal(h.evalAmount, 12130 * 100);
  assert.notEqual(h.evalAmount, 0, '매수 직후에도 evalAmount가 0에 머물면 프론트엔드 필터에 걸려 화면에서 사라짐');
});

test('applyBuy: 기존 curPrice가 null(진짜 신규종목 성격)이면 매수 후에도 evalAmount는 추정하지 않고 null', () => {
  const existing = { account: '위탁', assetClass: '국내주식', name: 'X', ticker: '', market: '', avgPrice: 100, qty: 1, invest: 100, curPrice: null, evalAmount: null, profitAmount: null, profitPct: null, isCashLike: false };
  const h = applyBuy(existing, { account: '위탁', stockName: 'X', price: 100, quantity: 1 });
  assert.equal(h.curPrice, null);
  assert.equal(h.evalAmount, null);
});

test('applyBuy: 일반적인 추가매수(qty>0)도 매수 직후 evalAmount가 새 수량 기준으로 즉시 갱신됨(예전엔 다음 시세갱신 전까지 매수 이전 수량 기준값으로 과소표시됐음)', () => {
  const existing = { account: '위탁', assetClass: '국내주식', name: '삼성전자', ticker: '005930', market: '', avgPrice: 50450, qty: 40, invest: 2018000, curPrice: 281000, evalAmount: 281000 * 40, profitAmount: 281000 * 40 - 2018000, profitPct: 5, isCashLike: false };
  const h = applyBuy(existing, { account: '위탁', stockName: '삼성전자', price: 281000, quantity: 10 });
  assert.equal(h.qty, 50);
  assert.equal(h.evalAmount, 281000 * 50);
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

test('applySell: 일부 매도도 evalAmount를 축소된 새 수량 기준으로 즉시 재계산(2026-08-24, applyBuy와 동일 클래스 결함)', () => {
  const existing = { account: '위탁', name: '삼성전자', avgPrice: 50000, qty: 10, invest: 500000, curPrice: 55000, evalAmount: 550000, profitAmount: 50000, profitPct: 10 };
  const r = applySell(existing, { account: '위탁', stockName: '삼성전자', price: 70000, quantity: 4 });
  assert.equal(r.updatedHolding.qty, 6);
  assert.equal(r.updatedHolding.curPrice, 55000);
  assert.equal(r.updatedHolding.evalAmount, 55000 * 6);
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
