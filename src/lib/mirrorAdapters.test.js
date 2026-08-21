import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountsFromMirror, rebalanceAccountFromMirror, monthlyDividendsFromMirror,
  monthlyProfitsFromMirror, sortedTradesFromMirror, monthlyBalancesFromMirror,
} from './mirrorAdapters.js';

test('accountsFromMirror: 계좌별로 보유종목을 나누고 투자금·평가금·손익을 합산', () => {
  const holdingsMirror = {
    items: [
      { account: 'ISA', name: 'A', avgPrice: 1000, qty: 10, invest: 10000, evalAmount: 12000, assetClass: '배당주' },
      { account: '위탁', name: 'B', avgPrice: 2000, qty: 5, invest: 10000, evalAmount: 9000, assetClass: '국내주식' },
    ],
  };
  const r = accountsFromMirror(holdingsMirror);
  assert.equal(r.ISA.total_invest, 10000);
  assert.equal(r.ISA.total_eval, 12000);
  assert.equal(r.ISA.profit, 2000);
  assert.equal(r.ISA.holdings.length, 1);
  assert.equal(r.ISA.holdings[0].type, '배당주');
  assert.equal(r.위탁.total_invest, 10000);
  assert.equal(r.연금저축.total_invest, 0); // 없는 계좌는 빈 값(추정 안 함)
});

test('accountsFromMirror: profitAmount·profitPct가 없으면(구버전 미러) invest 기반으로 계산', () => {
  const holdingsMirror = { items: [{ account: 'IRP', name: 'X', avgPrice: 1000, qty: 10, invest: 10000, evalAmount: 11000 }] };
  const r = accountsFromMirror(holdingsMirror);
  assert.equal(r.IRP.holdings[0].profit, 1000);
  assert.equal(r.IRP.holdings[0].rate, 10);
});

test('accountsFromMirror: total_invest는 invest 필드를 그대로 합산(avgPrice*qty 재계산 안 함) — 2026-08-21 실사고(총 투자금 130억원 오표시) 회귀 재현', () => {
  // VIP펀드처럼 avgPrice가 1,000좌당 기준가 관례라 avgPrice*qty로 재계산하면
  // 128억원까지 부풀려지는 케이스. invest 필드(실제 투자금)를 그대로 써야 한다.
  const holdingsMirror = { items: [{ account: '연금저축', name: 'VIP펀드', avgPrice: 1560, qty: 8202681, invest: 12800000, evalAmount: 15716337 }] };
  const r = accountsFromMirror(holdingsMirror);
  assert.equal(r.연금저축.total_invest, 12800000);
  assert.equal(r.연금저축.holdings[0].invest, 12800000);
});

test('rebalanceAccountFromMirror: allocation의 target/current + holdings의 자산군별 평가금 합산', () => {
  const allocationMirror = { accounts: [{ account: 'ISA', assetName: '배당주', targetPct: 100, currentPct: 95, rebalAmt: 50000 }] };
  const holdingsMirror = { items: [{ account: 'ISA', name: 'A', assetClass: '배당주', avgPrice: 1000, qty: 10, invest: 10000, evalAmount: 12000 }] };
  const r = rebalanceAccountFromMirror({ allocationMirror, holdingsMirror, acctKey: 'ISA' });
  assert.equal(r.assets.length, 1);
  assert.equal(r.assets[0].target, 100);
  assert.equal(r.assets[0].ratio, 95);
  assert.equal(r.assets[0].rebalAmt, 50000);
  assert.equal(r.assets[0].eval, 12000);
});

test('rebalanceAccountFromMirror: allocation 기록이 없는 자산군은 0(추정 안 함)', () => {
  const r = rebalanceAccountFromMirror({ allocationMirror: { accounts: [] }, holdingsMirror: { items: [] }, acctKey: '위탁' });
  assert.equal(r.assets.length, 7); // 위탁의 DEFAULT_ACCOUNTS 자산군 7개
  assert.ok(r.assets.every((a) => a.target === 0 && a.ratio === 0 && a.rebalAmt === 0 && a.eval === 0));
});

test('monthlyDividendsFromMirror: 날짜 기준 월별 그룹 + 오름차순 정렬', () => {
  const dividendsMirror = {
    items: [
      { date: '2026-03-05', name: 'A', amount: 1000 },
      { date: '2026-01-10', name: 'B', amount: 2000 },
      { date: '2026-01-20', name: 'C', amount: 500 },
    ],
  };
  const r = monthlyDividendsFromMirror(dividendsMirror);
  assert.deepEqual(r.map((x) => `${x.year}-${x.month}`), ['2026-1', '2026-3']);
  assert.equal(r[0].amount, 2500);
  assert.equal(r[0].items.length, 2);
});

test('monthlyProfitsFromMirror: stockName·profit 필드로 월별 합산', () => {
  const profitsMirror = { items: [{ date: '2026-02-01', stockName: 'X', profit: -500 }, { date: '2026-02-15', stockName: 'Y', profit: 1500 }] };
  const r = monthlyProfitsFromMirror(profitsMirror);
  assert.equal(r.length, 1);
  assert.equal(r[0].total, 1000);
});

test('sortedTradesFromMirror: 최신 날짜가 먼저 오도록 내림차순 정렬', () => {
  const tradesMirror = { items: [{ date: '2026-01-01', name: 'A' }, { date: '2026-03-01', name: 'B' }, { date: '2026-02-01', name: 'C' }] };
  const r = sortedTradesFromMirror(tradesMirror);
  assert.deepEqual(r.map((t) => t.name), ['B', 'C', 'A']);
});

test('monthlyBalancesFromMirror: mirror.items를 그대로 반환(빌더가 이미 정렬·가공함)', () => {
  const items = [{ year: 2025, month: 4, label: '25.04', total: 100 }];
  assert.equal(monthlyBalancesFromMirror({ items }), items);
});

test('monthlyBalancesFromMirror: mirror가 없으면(비로그인 등) 빈 배열', () => {
  assert.deepEqual(monthlyBalancesFromMirror(null), []);
});
