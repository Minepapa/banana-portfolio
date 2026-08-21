import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportFacts } from './report-facts.mjs';

// 2026-08-20 Vault 네이티브 재작성 — holdings는 이제 State/Holdings 원본(계좌당 파일
// 하나, 평가액·현재가를 자체적으로 들고 있음). tradeRows·dividendRows는 v1과 동일
// row-array 스키마 그대로(behavior-signals.mjs의 매입평균 기반 실현손익 로직을 안
// 건드리기 위함 — 2026-07 현대차·삼성바이오로직스 회귀방지 테스트는 그대로 유지).

const baseInput = () => ({
  asof: '2026-06-14',
  weekStart: '2026-06-08',
  holdings: [
    { account: '위탁', name: 'SK하이닉스', assetClass: '국내주식', qty: 8, invest: 15920000, evalAmount: 17200000 },
    { account: '위탁', name: '애플', assetClass: '해외주식', qty: 8, invest: 2400000, evalAmount: 2651420 },
  ],
  macro: {
    KOSPI: { value: 8123.62, change5d: -0.5, source: '네이버(비지연)' },
    SP500: { value: 7431, change5d: 0.65, source: 'yfinance' },
    USDKRW: { value: 1518.2, change5d: -2.5, source: 'yfinance(FX,~10h지연)' },
    GOLD: { value: 4238.8, change5d: -2.9, source: 'yfinance' },
  },
  // 체결내역 실제 스키마: A날짜 B구분 C계좌 D코드 E자산군 F종목명 G체결가 H수량 I금액
  tradeRows: [
    ['2026-06-05', '매수', '위탁', '000660', '국내주식', 'SK하이닉스', '1990000', '5', '9950000'],
    ['2026-05-01', '매수', '위탁', '005930', '국내주식', '삼성전자', '70000', '10', '700000'],
  ],
  dividendRows: [
    ['2026-06-02', '52000', 'TIGER 리츠'],
    ['2026-05-02', '48000', 'TIGER 리츠'],
  ],
  prevReport: { date: '2026-06-07', summary: '지난주 요약 텍스트' },
});

test('buildReportFacts: 평가액·총수익률은 State/Holdings 원본값 그대로(재계산 안 함)', () => {
  const { facts } = buildReportFacts(baseInput());
  const hynix = facts.holdings.find(h => h.name === 'SK하이닉스');
  assert.equal(hynix.evalValue, 17200000);
  assert.equal(hynix.totalReturnPct, Math.round((17200000 - 15920000) / 15920000 * 1000) / 10);
});

test('buildReportFacts: 같은 종목이 여러 계좌에 걸치면 평가액·원금 합산', () => {
  const input = baseInput();
  input.holdings.push({ account: '연금저축', name: 'SK하이닉스', assetClass: '국내주식', qty: 2, invest: 3980000, evalAmount: 4300000 });
  const { facts } = buildReportFacts(input);
  const hynix = facts.holdings.find(h => h.name === 'SK하이닉스');
  assert.equal(hynix.qty, 10);
  assert.equal(hynix.evalValue, 17200000 + 4300000);
  assert.equal(hynix.invest, 15920000 + 3980000);
});

test('buildReportFacts: 자산군 비중은 evalAmount 합 기준', () => {
  const { facts } = buildReportFacts(baseInput());
  const total = 17200000 + 2651420;
  const kr = facts.assetClasses.find(a => a.type === '국내주식');
  assert.equal(kr.evalValue, 17200000);
  assert.equal(kr.weightPct, Math.round(17200000 / total * 1000) / 10);
});

test('buildReportFacts: 계좌별 합계 = 총 평가액 (수량 0 현금성 보유도 그대로 포함)', () => {
  const input = baseInput();
  // Vault는 계좌당 파일이 원자 레코드라 v1처럼 수량 비중으로 배분할 필요가 없다 —
  // 예수금(수량 0)도 그 계좌 합계에 그냥 더해지면 된다.
  input.holdings.push({ account: '위탁', name: '예수금', assetClass: '현금', qty: 0, invest: 5000000, evalAmount: 4800000, isCashLike: true });
  const { facts } = buildReportFacts(input);
  const acctSum = facts.accounts.reduce((s, a) => s + a.evalValue, 0);
  const holdSum = facts.holdings.reduce((s, h) => s + (h.evalValue || 0), 0);
  assert.equal(acctSum, holdSum);
  assert.ok(facts.accounts.find(a => a.acct === '위탁').evalValue >= 4800000);
});

test('buildReportFacts: evalAmount 결측이면 null, 추정 금지', () => {
  const input = baseInput();
  input.holdings[0] = { account: '위탁', name: 'SK하이닉스', assetClass: '국내주식', qty: 8, invest: 15920000 }; // evalAmount 없음
  const { facts } = buildReportFacts(input);
  const hynix = facts.holdings.find(h => h.name === 'SK하이닉스');
  assert.equal(hynix.evalValue, null);
  assert.equal(hynix.totalReturnPct, null);
});

test('buildReportFacts: 이번 주 체결만 필터(weekStart 이상)', () => {
  const { facts } = buildReportFacts(baseInput());
  // 6/05·5/01 매수 모두 weekStart(6/08) 이전 → 0건
  assert.equal(facts.weekTrades.length, 0);
  // weekStart를 6/01로 낮추면 6/05만 포함(5/01 제외) → 1건
  const wider = buildReportFacts({ ...baseInput(), weekStart: '2026-06-01' });
  assert.equal(wider.facts.weekTrades.length, 1);
  assert.equal(wider.facts.weekTrades[0].name, 'SK하이닉스');
});

test('buildReportFacts: 매도 실현손익은 체결이력 매입평균 대비로 계산(체결행 라이브 컬럼 무시) — 2026-07 현대차 회귀 재현', () => {
  // 실제 사고 재현: 현대차 6/23 8주 @524,000 매수 → 7/24 8주 @396,000 매도(-24.4% 손절).
  const input = {
    ...baseInput(),
    weekStart: '2026-07-24',
    asof: '2026-07-26',
    tradeRows: [
      ['2026-06-23', '매수', '위탁', '005380', '국내주식', '현대차', '524000', '8', '4192000'],
      ['2026-07-24', '매도', '위탁', '005380', '국내주식', '현대차', '396000', '8', '3168000'],
    ],
  };
  const { facts, factsText } = buildReportFacts(input);
  const sell = facts.weekTrades.find(t => t.name === '현대차' && t.side === '매도');
  assert.equal(sell.realizedPct, -24.4);
  assert.equal(sell.partialHistory, false); // 매수 8주 = 매도 8주, 완전 추적
  assert.match(factsText, /현대차.*실현 -24\.4%/);
});

test('buildReportFacts: 매도 수량보다 추적된 매수 수량이 적으면 partialHistory=true — 2026-07 삼성바이오로직스 회귀 재현', () => {
  const input = {
    ...baseInput(),
    weekStart: '2026-07-13',
    asof: '2026-07-19',
    tradeRows: [
      ['2026-05-12', '매수', '위탁', '207940', '국내주식', '삼성바이오로직스', '1439000', '1', '1439000'],
      ['2026-05-27', '매수', '위탁', '207940', '국내주식', '삼성바이오로직스', '1376000', '1', '1376000'],
      ['2026-07-13', '매도', '위탁', '207940', '국내주식', '삼성바이오로직스', '1405000', '4', '5620000'],
    ],
  };
  const { facts, factsText } = buildReportFacts(input);
  const sell = facts.weekTrades.find(t => t.name === '삼성바이오로직스' && t.side === '매도');
  assert.equal(sell.partialHistory, true);
  assert.equal(sell.realizedPct, -0.2); // (1405000-1407500)/1407500*100, round1
  assert.match(factsText, /매입이력 일부만 추적됨/);
});

test('buildReportFacts: 매수 행은 realizedPct null(익절/손절 개념 없음)', () => {
  const { facts } = buildReportFacts({ ...baseInput(), weekStart: '2026-06-01' });
  const buy = facts.weekTrades.find(t => t.side === '매수');
  assert.equal(buy.realizedPct, null);
});

test('buildReportFacts: 이번 주 배당만 필터', () => {
  const { facts } = buildReportFacts(baseInput());
  // 6/02 배당은 weekStart(6/08) 이전 → 제외
  assert.equal(facts.weekDividends.length, 0);
});

test('buildReportFacts: factsText에 핵심 수치가 포함되고 추정 표현이 없다', () => {
  const { factsText } = buildReportFacts(baseInput());
  assert.ok(factsText.includes('17,200,000'));
  assert.ok(factsText.includes('SK하이닉스'));
  assert.ok(!/추정/.test(factsText));                    // 추정 단어가 facts엔 없어야
});
