import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHomeMirror,
  buildHoldingsMirror,
  buildAllocationMirror,
  buildDividendsMirror,
  buildProfitsMirror,
  buildTradesMirror,
  buildLatestReportMirror,
  buildMonthlyBalancesMirror,
  buildAllMirrors,
} from './firestore-mirror.mjs';

const NOW = new Date('2026-08-05T00:00:00.000Z');

test('buildHomeMirror: 보유종목 없으면 0값 + 빈 accounts, 가짜 숫자 없음', () => {
  const r = buildHomeMirror({ now: NOW });
  assert.equal(r.totalInvest, 0);
  assert.equal(r.totalEval, 0);
  assert.equal(r.totalProfit, 0);
  assert.equal(r.totalProfitPct, 0);
  assert.deepEqual(r.accounts, []);
  assert.equal(r.pendingProposalCount, 0);
  assert.equal(r.updatedAt, NOW.toISOString());
});

test('buildHomeMirror: 보유종목 있으면 손익 계산', () => {
  const holdings = [
    { avgPrice: 10000, qty: 10, invest: 100000, evalAmount: 120000 },
    { avgPrice: 5000, qty: 4, invest: 20000, evalAmount: 18000 },
  ];
  const r = buildHomeMirror({ holdings, pendingProposalCount: 2, usdRate: 1350, now: NOW });
  assert.equal(r.totalInvest, 120000);
  assert.equal(r.totalEval, 138000);
  assert.equal(r.totalProfit, 18000);
  assert.equal(r.totalProfitPct, 15);
  assert.equal(r.pendingProposalCount, 2);
  assert.equal(r.usdRate, 1350);
});

test('buildHomeMirror: totalInvest는 invest 필드를 그대로 합산(avgPrice*qty 재계산 안 함) — 2026-08-21 실사고(총 투자금 130억원 오표시) 회귀 재현', () => {
  // 실사고 재현: VIP펀드는 avgPrice가 1,000좌당 기준가 관례(1560)라 avgPrice*qty(8202681주)로
  // 재계산하면 128억원까지 부풀려진다. 실제 투자금(invest 필드)은 1,280만원이다.
  const holdings = [{ avgPrice: 1560, qty: 8202681, invest: 12800000, evalAmount: 15716337 }];
  const r = buildHomeMirror({ holdings, now: NOW });
  assert.equal(r.totalInvest, 12800000);
  assert.ok(r.totalProfitPct > -100 && r.totalProfitPct < 100, `비정상 totalProfitPct: ${r.totalProfitPct}`);
});

test('buildHoldingsMirror: 빈 배열이면 items 빈 배열', () => {
  const r = buildHoldingsMirror({ now: NOW });
  assert.deepEqual(r.items, []);
});

test('buildHoldingsMirror: weightPct는 evalAmount 비중으로 계산', () => {
  const holdings = [
    { name: 'A', evalAmount: 300 },
    { name: 'B', evalAmount: 700 },
  ];
  const r = buildHoldingsMirror({ holdings, now: NOW });
  assert.equal(r.items[0].weightPct, 30);
  assert.equal(r.items[1].weightPct, 70);
});

test('buildHoldingsMirror: invest 필드를 그대로 전달(2026-08-21 — 프론트가 avgPrice*qty로 재계산하지 않도록)', () => {
  const holdings = [{ name: 'A', avgPrice: 1560, qty: 8202681, invest: 12800000, evalAmount: 15716337 }];
  const r = buildHoldingsMirror({ holdings, now: NOW });
  assert.equal(r.items[0].invest, 12800000);
});

test('buildHoldingsMirror: assetClass·isCashLike를 그대로 전달(App.jsx 7탭 재배선용, 2026-08-13)', () => {
  const holdings = [
    { name: '삼성전자', assetClass: '국내주식', evalAmount: 100 },
    { name: '예수금', isCashLike: true, evalAmount: 0 },
  ];
  const r = buildHoldingsMirror({ holdings, now: NOW });
  assert.equal(r.items[0].assetClass, '국내주식');
  assert.equal(r.items[0].isCashLike, false);
  assert.equal(r.items[1].assetClass, '');
  assert.equal(r.items[1].isCashLike, true);
});

test('buildAllocationMirror: 빈 accounts 그대로 통과', () => {
  const r = buildAllocationMirror({ now: NOW });
  assert.deepEqual(r.accounts, []);
});

test('buildDividendsMirror: 1년 이전 항목은 제외', () => {
  const dividendEvents = [
    { date: '2026-08-01', stockName: '삼성전자', afterTaxAmount: 1000 },
    { date: '2024-01-01', stockName: '옛날배당', afterTaxAmount: 9999 },
  ];
  const r = buildDividendsMirror({ dividendEvents, now: NOW });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].name, '삼성전자');
});

test('buildDividendsMirror: ytdTotal·monthTotal 합산', () => {
  const dividendEvents = [
    { date: '2026-08-01', stockName: 'A', afterTaxAmount: 1000 },
    { date: '2026-07-01', stockName: 'B', afterTaxAmount: 2000 },
    { date: '2025-12-01', stockName: 'C', afterTaxAmount: 500 },
  ];
  const r = buildDividendsMirror({ dividendEvents, now: NOW });
  assert.equal(r.ytdTotal, 3000);
  assert.equal(r.monthTotal, 1000);
});

test('buildProfitsMirror: 필요한 필드만 골라 담는다(레거시 마이그레이션 잡필드 제외) — 2026-08-21', () => {
  // Facts/Ledger/Profits 레코드엔 legacy·legacySourceRow·recordedAt·type·account 등
  // ProfitTab이 안 쓰는 필드가 섞여있다 — 전체 스프레드하지 않고 명시적으로 골라야 한다
  // (buildDividendsMirror·buildTradesMirror와 동일 원칙, 2026-08-05 보안리뷰).
  const profitEvents = [{
    type: 'realized-profit', legacy: true, legacySourceRow: 2,
    date: '2026-08-01', stockName: '삼성전자', quantity: 10,
    buyPrice: 70000, sellPrice: 75000, profit: 50000, account: null,
    recordedAt: '2026-08-05T05:17:38.713Z',
  }];
  const r = buildProfitsMirror({ profitEvents, now: NOW });
  assert.deepEqual(r.items, [{ date: '2026-08-01', stockName: '삼성전자', profit: 50000 }]);
});

test('buildProfitsMirror: 1년 이전 항목은 제외', () => {
  const profitEvents = [
    { date: '2026-08-01', stockName: '최근', profit: 1000 },
    { date: '2024-01-01', stockName: '옛날', profit: 9999 },
  ];
  const r = buildProfitsMirror({ profitEvents, now: NOW });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].stockName, '최근');
});

test('buildProfitsMirror: 빈 입력이면 빈 items', () => {
  const r = buildProfitsMirror({ now: NOW });
  assert.deepEqual(r.items, []);
});

test('buildTradesMirror: 1년 이전 제외 + 필드 매핑', () => {
  const executionEvents = [
    {
      tradeDate: '2026-08-01', tradeType: '매수', stockName: '삼성전자', stockCode: '005930',
      assetClass: '국내주식', price: 70000, quantity: 10, fee: 100, tax: 0,
    },
    { tradeDate: '2024-01-01', tradeType: '매도', stockName: '옛날', stockCode: '000000', price: 1, quantity: 1 },
  ];
  const r = buildTradesMirror({ executionEvents, now: NOW });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].amount, 700000);
  assert.equal(r.items[0].ticker, '005930');
  assert.equal(r.items[0].side, '매수');
});

test('buildLatestReportMirror: report 없으면 빈 값', () => {
  const r = buildLatestReportMirror({ now: NOW });
  assert.equal(r.headline, '');
  assert.equal(r.date, null);
});

test('buildLatestReportMirror: report 있으면 그대로 병합', () => {
  const r = buildLatestReportMirror({ report: { date: '2026-08-01', headline: '제목', summary: '요약', body: '본문' }, now: NOW });
  assert.equal(r.headline, '제목');
});

test('buildMonthlyBalancesMirror: ym 오름차순 정렬 + label 조합("YY.MM")', () => {
  const monthlyBalances = [
    { year: 2026, month: 1, ym: 202601, total: 150000 },
    { year: 2025, month: 4, ym: 202504, total: 57000 },
  ];
  const r = buildMonthlyBalancesMirror({ monthlyBalances, now: NOW });
  assert.deepEqual(r.items.map((i) => i.label), ['25.04', '26.01']);
  assert.equal(r.items[0].total, 57000);
});

test('buildMonthlyBalancesMirror: 데이터 없으면 빈 items(가짜 개월 채우지 않음)', () => {
  const r = buildMonthlyBalancesMirror({ now: NOW });
  assert.deepEqual(r.items, []);
});

test('buildMonthlyBalancesMirror: 최근 1년 필터 없음(dividends·profits와 달리 전체 이력을 그래프로 보여주는 게 목적)', () => {
  const monthlyBalances = [{ year: 2020, month: 1, ym: 202001, total: 1000 }];
  const r = buildMonthlyBalancesMirror({ monthlyBalances, now: NOW });
  assert.equal(r.items.length, 1);
});

test('buildAllMirrors: 8개 문서 모두 반환', () => {
  const r = buildAllMirrors({ now: NOW });
  assert.deepEqual(Object.keys(r).sort(), ['allocation', 'dividends', 'holdings', 'home', 'latestReport', 'monthlyBalances', 'profits', 'trades'].sort());
});
