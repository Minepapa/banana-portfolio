import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportFacts } from './report-facts.mjs';

// 최소 입력 픽스처 — 페처는 weekly-report.mjs가 수행, 여기선 순수 조립만 검증.
const baseInput = () => ({
  asof: '2026-06-14',
  holdings: [
    { name: 'SK하이닉스', market: 'KR', type: '국내주식',
      accounts: [{ acct: '위탁', type: '국내주식', qty: 8, invest: 15920000 }] },
    { name: '애플', market: 'US', type: '해외주식',
      accounts: [{ acct: '위탁', type: '해외주식', qty: 8, invest: 2400000 }] },
  ],
  // 자산 값 정본 = 시트(현재가 F·평가액 H). 추정 금지.
  sheetByName: new Map([
    ['SK하이닉스', { price: 2150000, eval: 17200000, qty: 8 }],
    ['애플', { price: 291.13, eval: 2651420, qty: 8 }],  // 시트 평가액(KRW, 환율 반영된 값)
  ]),
  macro: {
    KOSPI: { value: 8123.62, change5d: -0.5, source: '네이버(비지연)' },
    SP500: { value: 7431, change5d: 0.65, source: 'yfinance' },
    USDKRW: { value: 1518.2, change5d: -2.5, source: 'yfinance(FX,~10h지연)' },
    GOLD: { value: 4238.8, change5d: -2.9, source: 'yfinance' },
  },
  marketByName: new Map([
    ['SK하이닉스', { weekChange: 7.6, pos52w: 88, rsi14: 61,
      forwardPE: 9.3, pbr: 9.28, high52w: 2200000, source: 'yfinance 000660.KS' }],
    ['애플', { weekChange: 1.2, pos52w: 78.5, rsi14: 55,
      forwardPE: 30, pbr: 40.1, high52w: 317.4, source: 'yfinance AAPL' }],
  ]),
  fundByName: new Map([
    ['SK하이닉스', { opMargin: 71.5, roe: 62.3, debtRatio: 35.5, revenueYoY: 79.2, source: 'OpenDart 2026 반기보고서(연결)' }],
    ['애플', { opMargin: 32.3, roe: 141.5, debtRatio: 79.5, revenueYoY: 8.1, source: 'yfinance quarterly+info(TTM)' }],
  ]),
  riskRows: [
    ['2026-06-08 07:00', 'B', 'SK하이닉스', '🟢', '논리 유효', 'HBM 수요 견조', '{}', '2026-06-01'],
    ['2026-06-13 16:30', 'D', '포트폴리오 전체', '🟢', '거시 트리거 미발동', '정상 범위', '{}', ''],
  ],
  baselineRows: [
    ['SK하이닉스', '000660', 'KR', '2026-06-01', '79.2%', '71.5%', '62.3%', '35.5%', '', '9.28', ''],
  ],
  noteRows: [
    ['2026-06-05', 'SK하이닉스', '', '', '🟢 유효', '', '', '', '', '', '1) HBM4 독주 2) NVIDIA 협력', '1) 사이클 둔화', '', '', '보유'],
  ],
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
  weekStart: '2026-06-08',
});

test('buildReportFacts: 평가액·총수익률은 수량×현재가로 결정론 산출', () => {
  const { facts } = buildReportFacts(baseInput());
  const hynix = facts.holdings.find(h => h.name === 'SK하이닉스');
  assert.equal(hynix.evalValue, 8 * 2150000);            // 17,200,000
  assert.equal(hynix.currentPrice, 2150000);             // WebSearch 197만 오류 아님
  // 총수익률 = (평가액 - 원금) / 원금 × 100, 소수1
  assert.equal(hynix.totalReturnPct, Math.round((17200000 - 15920000) / 15920000 * 1000) / 10);
});

test('buildReportFacts: 자산군 비중은 시트 평가액 합 기준', () => {
  const { facts } = buildReportFacts(baseInput());
  const apple = facts.holdings.find(h => h.name === '애플');
  assert.equal(apple.evalValue, 2651420);                // 시트 평가액 그대로(추정 아님)
  assert.equal(apple.currentPrice, 291.13);              // 현재가도 시트값
  const total = 17200000 + 2651420;
  const kr = facts.assetClasses.find(a => a.type === '국내주식');
  assert.equal(kr.evalValue, 17200000);
  assert.equal(kr.weightPct, Math.round(17200000 / total * 1000) / 10);
});

test('buildReportFacts: 계좌별 합계 = 총 평가액 (수량 0 현금성도 누락 없이 배분)', () => {
  const input = baseInput();
  // 예수금: 수량 0, 평가액만 존재(현금성) — 수량 비중 배분에서 누락되던 회귀를 잡는다.
  input.holdings.push({ name: '예수금', market: 'KR', type: '현금성',
    accounts: [{ acct: '위탁', type: '현금성', qty: 0, invest: 5000000 }] });
  input.sheetByName.set('예수금', { price: null, eval: 4800000, qty: 0 });
  const { facts } = buildReportFacts(input);
  const acctSum = facts.accounts.reduce((s, a) => s + a.evalValue, 0);
  // 계좌 합계가 종목 평가액 총합과 일치해야 함(예수금 480만 포함)
  const holdSum = facts.holdings.reduce((s, h) => s + (h.evalValue || 0), 0);
  assert.equal(acctSum, holdSum);
  assert.ok(facts.accounts.find(a => a.acct === '위탁').evalValue >= 4800000);
});

test('buildReportFacts: 평가액·현재가·수량은 시트값만 사용(라이브 시세로 재계산 안 함)', () => {
  const input = baseInput();
  // 라이브 시세가 시트와 다른 값을 줘도 무시되고 시트값이 쓰여야 한다.
  input.marketByName.set('SK하이닉스', { ...input.marketByName.get('SK하이닉스'), currentPrice: 9999999 });
  input.sheetByName.set('SK하이닉스', { price: 2150000, eval: 17200000, qty: 8 });
  const { facts } = buildReportFacts(input);
  const hynix = facts.holdings.find(h => h.name === 'SK하이닉스');
  assert.equal(hynix.currentPrice, 2150000);             // 시트값(라이브 9999999 무시)
  assert.equal(hynix.evalValue, 17200000);
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
  // 체결내역엔 손익/수익률 컬럼(J~M)이 없다(스키마상 I금액까지만 파싱 대상) — 이 테스트는
  // parseTrade가 그 컬럼을 아예 보지 않고 매입평균 기반으로 재계산함을 검증한다.
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
  // 실제 사고 재현: 삼성바이오로직스 매도 4주 중 체결내역에 추적된 매수는 2주뿐(체결내역
  // 시스템 도입 이전부터 보유하던 물량 포함 추정) — avgBuy가 2주치 평균이라 확정치가 아니다.
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

test('buildReportFacts: 리스크 신호 재인용 — 최신 D + 종목별 최신 B', () => {
  const { facts } = buildReportFacts(baseInput());
  assert.equal(facts.macroSignal.signal, '🟢');
  assert.equal(facts.logicSignals.find(s => s.target === 'SK하이닉스').signal, '🟢');
});

test('buildReportFacts: 시트 평가액 결측 시 null, 추정 금지', () => {
  const input = baseInput();
  input.sheetByName.delete('SK하이닉스');               // 시트에 값 없음
  const { facts } = buildReportFacts(input);
  const hynix = facts.holdings.find(h => h.name === 'SK하이닉스');
  assert.equal(hynix.evalValue, null);
  assert.equal(hynix.currentPrice, null);
  assert.equal(hynix.totalReturnPct, null);
});

test('buildReportFacts: factsText에 핵심 수치가 포함되고 추정 표현이 없다', () => {
  const { factsText } = buildReportFacts(baseInput());
  assert.ok(factsText.includes('2,150,000') || factsText.includes('2150000'));
  assert.ok(factsText.includes('SK하이닉스'));
  assert.ok(!/추정/.test(factsText));                    // 추정 단어가 facts엔 없어야
});
