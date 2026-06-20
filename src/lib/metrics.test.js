import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeKPI, computeAssets, computeBehaviorMetrics } from './metrics.js';

test('computeKPI: 3개월 TWR 누적 연환산', () => {
  const data = [
    { label: '25.01', value: 10_000_000, savings: 0, year: 2025 },
    { label: '25.02', value: 10_500_000, savings: 200_000, year: 2025 },
    { label: '25.03', value: 10_800_000, savings: 100_000, year: 2025 },
  ];
  const kpi = computeKPI(data);
  assert.notEqual(kpi, null);
  const r1 = 0.03, r2 = (10_800_000 - 10_500_000 - 100_000) / 10_500_000;
  const expectedCum = (1 + r1) * (1 + r2) - 1;
  assert.ok(Math.abs(kpi.twrCum - expectedCum) < 0.0001);
  assert.equal(kpi.months, 2);
});

test('computeKPI: MDD는 TWR 누적곡선 기준', () => {
  const data = [
    { label: '25.01', value: 10_000_000, savings: 0, year: 2025 },
    { label: '25.02', value: 10_500_000, savings: 0, year: 2025 },
    { label: '25.03', value:  9_660_000, savings: 0, year: 2025 },
    { label: '25.04', value:  9_853_200, savings: 0, year: 2025 },
  ];
  const kpi = computeKPI(data);
  assert.ok(Math.abs(kpi.mdd - (-0.08)) < 0.001);
});

test('computeKPI: 벤치마크 TWR (KOSPI 50% + SP500 50%)', () => {
  const data = [
    { label: '25.01', value: 10_000_000, savings: 0, year: 2025, kospi: 2500, sp500: 5000 },
    { label: '25.02', value: 10_300_000, savings: 0, year: 2025, kospi: 2550, sp500: 5100 },
    { label: '25.03', value: 10_600_000, savings: 0, year: 2025, kospi: 2600, sp500: 5200 },
  ];
  const kpi = computeKPI(data);
  assert.notEqual(kpi.benchmarkTWRCum, null);
  assert.ok(Math.abs(kpi.benchmarkTWRCum - 0.04) < 0.001);
});

test('computeKPI: 벤치마크 지수 없으면 null', () => {
  const data = [
    { label: '25.01', value: 10_000_000, savings: 0, year: 2025 },
    { label: '25.02', value: 10_300_000, savings: 0, year: 2025 },
  ];
  const kpi = computeKPI(data);
  assert.equal(kpi.benchmarkTWR, null);
  assert.equal(kpi.benchmarkTWRCum, null);
});

test('computeKPI: Sharpe 계산 (변동성 충분한 데이터)', () => {
  const vals = [10_000_000, 10_300_000, 10_100_000, 10_500_000, 10_200_000,
    10_800_000, 10_400_000, 11_000_000, 10_600_000, 11_200_000, 10_900_000, 11_500_000, 11_100_000];
  const data = vals.map((v, i) => ({ label: '25.' + String(i+1).padStart(2,'0'), value: v, savings: 0, year: 2025 }));
  const kpi = computeKPI(data);
  assert.notEqual(kpi.sharpe, null);
  assert.equal(typeof kpi.sharpe, 'number');
});

test('computeKPI: 데이터 부족 시 null', () => {
  assert.equal(computeKPI(null), null);
  assert.equal(computeKPI([]), null);
  assert.equal(computeKPI([{ label: '25.01', value: 10_000_000, savings: 0, year: 2025 }]), null);
});

test('computeKPI: 전월 잔고 0이면 해당 월 수익률 스킵', () => {
  const data = [
    { label: '25.01', value: 0, savings: 0, year: 2025 },
    { label: '25.02', value: 10_000_000, savings: 10_000_000, year: 2025 },
    { label: '25.03', value: 10_500_000, savings: 0, year: 2025 },
  ];
  const kpi = computeKPI(data);
  assert.equal(kpi.months, 1);
});

test('computeAssets: 자산군별 합산 + 비율', () => {
  const holdings = [
    { type: '국내주식', invest: 5_000_000, eval: 5_500_000 },
    { type: '국내주식', invest: 3_000_000, eval: 3_200_000 },
    { type: '해외주식', invest: 2_000_000, eval: 2_100_000 },
  ];
  const defaults = [
    { name: '국내주식', invest: 0, eval: 0, ratio: 0 },
    { name: '해외주식', invest: 0, eval: 0, ratio: 0 },
  ];
  const result = computeAssets(holdings, 10_800_000, defaults);
  assert.equal(result[0].eval, 8_700_000);
  assert.equal(result[1].eval, 2_100_000);
  assert.equal(result[0].ratio, Math.round(8_700_000 / 10_800_000 * 100));
});

test('computeAssets: type 없는 종목은 무시', () => {
  const holdings = [
    { type: '', invest: 1_000_000, eval: 1_000_000 },
    { type: '채권', invest: 500_000, eval: 510_000 },
  ];
  const defaults = [{ name: '채권', invest: 0, eval: 0, ratio: 0 }];
  const result = computeAssets(holdings, 510_000, defaults);
  assert.equal(result[0].eval, 510_000);
});

test('computeAssets: totalEval 0이면 기본 비율 유지', () => {
  const defaults = [{ name: '주식', invest: 0, eval: 0, ratio: 50 }];
  const result = computeAssets([], 0, defaults);
  assert.equal(result[0].ratio, 50);
});

const mkTrade = (date, buySell, acct, code, type, name, price, qty) => ({
  row: [date, buySell, acct, code, type, name, String(price), String(qty), String(price * qty)],
});

const mkEval = (date, name, ticker, conclusion) => ({
  date,
  stock: { name, ticker, market: 'KR' },
  conclusion: { raw: conclusion },
  status: 'buy',
});

test('computeBehaviorMetrics: 매수 매도 건수', () => {
  const trades = [
    mkTrade('2026-06-01', '매수', '위탁', '005930', '국내주식', '삼성전자', 60000, 10),
    mkTrade('2026-06-05', '매도', '위탁', '005930', '국내주식', '삼성전자', 65000, 10),
    mkTrade('2026-06-10', '매수', '위탁', 'AAPL', '해외주식', '애플', 500000, 2),
  ];
  const m = computeBehaviorMetrics(trades, []);
  assert.equal(m.totalBuys, 2);
  assert.equal(m.totalSells, 1);
});

test('computeBehaviorMetrics: 500만 원칙 초과 감지', () => {
  const trades = [
    mkTrade('2026-06-01', '매수', '위탁', '005930', '국내주식', '삼성전자', 60000, 100),
    mkTrade('2026-06-02', '매수', '위탁', 'AAPL', '해외주식', '애플', 200000, 2),
  ];
  const m = computeBehaviorMetrics(trades, []);
  assert.equal(m.rule500Total, 2);
  assert.equal(m.rule500OK, 1);
  assert.equal(m.rule500Rate, 50);
});

test('computeBehaviorMetrics: 평가 후 매수 매칭', () => {
  const trades = [
    mkTrade('2026-06-05', '매수', '위탁', '005930', '국내주식', '삼성전자', 60000, 10),
  ];
  const evals = [
    mkEval('2026-06-01', '삼성전자', '005930', '🟢 유효'),
  ];
  const m = computeBehaviorMetrics(trades, evals);
  assert.equal(m.evalMatchCount, 1);
  assert.equal(m.evalMatchRate, 100);
});

test('computeBehaviorMetrics: 빈 입력은 null', () => {
  assert.equal(computeBehaviorMetrics(null, []), null);
  assert.equal(computeBehaviorMetrics([], []), null);
});

test('computeBehaviorMetrics: 매도 규율 사전 평가 존재', () => {
  const trades = [
    mkTrade('2026-06-10', '매도', '위탁', '005930', '국내주식', '삼성전자', 65000, 10),
  ];
  const evals = [
    mkEval('2026-06-05', '삼성전자', '005930', '🔴 부적합'),
  ];
  const m = computeBehaviorMetrics(trades, evals);
  assert.equal(m.sellDisciplineOK, 1);
  assert.equal(m.sellDisciplineRate, 100);
});

test('computeBehaviorMetrics: 매도 규율 사전 평가 없으면 0', () => {
  const trades = [
    mkTrade('2026-06-10', '매도', '위탁', '005930', '국내주식', '삼성전자', 65000, 10),
  ];
  const m = computeBehaviorMetrics(trades, []);
  assert.equal(m.sellDisciplineOK, 0);
  assert.equal(m.sellDisciplineRate, 0);
});
