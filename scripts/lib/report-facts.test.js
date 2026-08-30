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

// ── Facts/Ledger/Profits 정본 매칭(2026-08-30 신설, 오너 신고 재현) ─────────────────
// 실사고: PLUS 고배당주·TIGER 미국배당다우존스가 리포트에서 "손익 미확정"으로 나왔다.
// 원인은 Executions 원장에 매수 체결이 하나도 없어서(v1→v2 이관 이전 매수 포지션이라
// 매수 "체결" 자체가 기록된 적 없음, 매도만 있음) — 매입평균 재구성이 항상 실패.
// Facts/Ledger/Profits엔 이미 정확한 실현손익이 있는데(대시보드 수익금 탭이 읽는 바로
// 그 원장) 리포트가 그 원장 자체를 안 읽고 있던 게 진짜 원인이었다.

test('buildReportFacts: 매수 이력이 전혀 없어도 Profits 정본에 매칭되면 실현손익을 정확히 보고(실사고 재현)', () => {
  const input = {
    ...baseInput(),
    weekStart: '2026-08-24',
    asof: '2026-08-30',
    tradeRows: [
      // PLUS 고배당주 실사고 그대로 — 매수 체결 자체가 없음(v1→v2 이관 이전 포지션).
      ['2026-08-27 10:06:45', '매도', '연금저축', '', '배당주', 'PLUS 고배당주', '25500', '30', '765000'],
    ],
    profitRows: [
      { date: '2026-08-27 10:06:45', stockName: 'PLUS 고배당주', quantity: 30, buyPrice: 17766, sellPrice: 25500, profit: 232020, account: '연금저축' },
    ],
  };
  const { facts, factsText } = buildReportFacts(input);
  const sell = facts.weekTrades.find(t => t.name === 'PLUS 고배당주');
  assert.equal(sell.ledgerMatched, true);
  assert.equal(sell.realizedWon, 232020);
  assert.equal(sell.partialHistory, false); // 재구성이 아니라 정본이라 "일부만 추적" 플래그 자체가 무의미
  assert.match(factsText, /PLUS 고배당주.*실현손익 \+232,020원.*정본 원장/);
  assert.doesNotMatch(factsText, /PLUS 고배당주.*손익 미확정/);
});

test('buildReportFacts: Profits에 매칭되는 기록이 없으면 기존처럼 Executions 재구성으로 폴백(하위호환)', () => {
  const input = {
    ...baseInput(),
    weekStart: '2026-07-24',
    asof: '2026-07-26',
    tradeRows: [
      ['2026-06-23', '매수', '위탁', '005380', '국내주식', '현대차', '524000', '8', '4192000'],
      ['2026-07-24', '매도', '위탁', '005380', '국내주식', '현대차', '396000', '8', '3168000'],
    ],
    profitRows: [], // 없음 — 기존 재구성 경로를 타야 함
  };
  const { facts } = buildReportFacts(input);
  const sell = facts.weekTrades.find(t => t.name === '현대차');
  assert.equal(sell.ledgerMatched, false);
  assert.equal(sell.realizedWon, null);
  assert.equal(sell.realizedPct, -24.4); // 기존 재구성 로직 그대로 동작(회귀 없음)
});

test('buildReportFacts: account 없는 레거시 Profits 레코드도 date|name|qty 보조 조회로 매칭(코드리뷰 지적 — 실측 37건 중 23건이 account:null이라 정확일치 4필드 키로는 전부 누락됨)', () => {
  const input = {
    ...baseInput(),
    weekStart: '2026-07-01',
    asof: '2026-07-10',
    tradeRows: [
      ['2026-07-09 12:36:44', '매도', '연금저축', '', '배당주', 'TIGER 미국배당다우존스', '15200', '10', '152000'],
    ],
    profitRows: [
      // account 없음 — v1 이관 레거시 레코드 그대로 재현.
      { date: '2026-07-09 12:36:44', stockName: 'TIGER 미국배당다우존스', quantity: 10, buyPrice: 13000, sellPrice: 15200, profit: 22000, account: null },
    ],
  };
  const { facts } = buildReportFacts(input);
  const sell = facts.weekTrades.find(t => t.name === 'TIGER 미국배당다우존스');
  assert.equal(sell.ledgerMatched, true);
  assert.equal(sell.realizedWon, 22000);
});

test('buildReportFacts: account 있는 정확일치가 있으면 보조 조회보다 우선(둘 다 있을 때 계좌까지 맞는 쪽을 신뢰)', () => {
  const input = {
    ...baseInput(),
    weekStart: '2026-07-01',
    asof: '2026-07-10',
    tradeRows: [
      ['2026-07-09 12:36:44', '매도', '연금저축', '', '배당주', 'TIGER 미국배당다우존스', '15200', '10', '152000'],
    ],
    profitRows: [
      { date: '2026-07-09 12:36:44', stockName: 'TIGER 미국배당다우존스', quantity: 10, buyPrice: 999, sellPrice: 999, profit: 999, account: null }, // 계좌 없는 잡음 레코드
      { date: '2026-07-09 12:36:44', stockName: 'TIGER 미국배당다우존스', quantity: 10, buyPrice: 13000, sellPrice: 15200, profit: 22000, account: '연금저축' }, // 정확일치
    ],
  };
  const { facts } = buildReportFacts(input);
  const sell = facts.weekTrades.find(t => t.name === 'TIGER 미국배당다우존스');
  assert.equal(sell.realizedWon, 22000); // 999가 아니라 정확일치 22000이 선택돼야 함
});

test('buildReportFacts: ledgerMatched는 profit이 유한수일 때만 true(malformed 레코드는 재구성 폴백으로) — null>=0 JS 강제변환 방지', () => {
  const input = {
    ...baseInput(),
    weekStart: '2026-06-23',
    asof: '2026-07-26',
    tradeRows: [
      ['2026-06-23', '매수', '위탁', '005380', '국내주식', '현대차', '524000', '8', '4192000'],
      ['2026-07-24', '매도', '위탁', '005380', '국내주식', '현대차', '396000', '8', '3168000'],
    ],
    profitRows: [
      { date: '2026-07-24', stockName: '현대차', quantity: 8, buyPrice: 524000, sellPrice: 396000, profit: null, account: '위탁' }, // profit 결측(malformed)
    ],
  };
  const { facts } = buildReportFacts(input);
  const sell = facts.weekTrades.find(t => t.name === '현대차' && t.side === '매도');
  assert.equal(sell.ledgerMatched, false); // malformed 레코드는 매칭 성공으로 안 침
  assert.equal(sell.realizedWon, null);
  assert.equal(sell.realizedPct, -24.4); // 재구성 폴백이 정상 동작
});

test('buildReportFacts: 같은 종목이 같은 주에 정본매칭 매도와 재구성폴백 매도로 섞여도 서로 안 간섭', () => {
  const input = {
    ...baseInput(),
    weekStart: '2026-08-24',
    asof: '2026-08-30',
    tradeRows: [
      ['2026-06-23', '매수', '위탁', '005380', '국내주식', '현대차', '524000', '8', '4192000'], // 매수 이력(재구성용)
      ['2026-08-25', '매도', '위탁', '005380', '국내주식', '현대차', '400000', '3', '1200000'],  // Profits 매칭 안 됨 → 재구성
      ['2026-08-27', '매도', '위탁', '005380', '국내주식', '현대차', '410000', '5', '2050000'],  // Profits 매칭됨 → 정본
    ],
    profitRows: [
      { date: '2026-08-27', stockName: '현대차', quantity: 5, buyPrice: 524000, sellPrice: 410000, profit: -570000, account: '위탁' },
    ],
  };
  const { facts } = buildReportFacts(input);
  const sells = facts.weekTrades.filter(t => t.name === '현대차' && t.side === '매도');
  assert.equal(sells.length, 2);
  const fallback = sells.find(t => t.qty === '3');
  const matched = sells.find(t => t.qty === '5');
  assert.equal(fallback.ledgerMatched, false);
  assert.equal(fallback.realizedPct, round1((400000 - 524000) / 524000 * 100));
  assert.equal(matched.ledgerMatched, true);
  assert.equal(matched.realizedWon, -570000);
});

function round1(v) { return Math.round(v * 10) / 10; }

test('buildReportFacts: profitRows를 아예 안 넘겨도(undefined) 기존 동작 그대로(하위호환)', () => {
  const input = { ...baseInput(), weekStart: '2026-06-01' };
  delete input.profitRows;
  const { facts } = buildReportFacts(input);
  assert.equal(facts.weekTrades.length, 1); // 기존 테스트와 동일 결과
});

// ── 계좌별 현금 가용성(2026-08-30 신설, 오너 신고 재현 + 구조 확장) ─────────────────
// 실사고: 리포트가 "CMA(21,054,004원) + 현금(30,132,560원) 실탄 충분"이라고 서술 —
// CMA는 전액 현금 계좌라 이미 "현금" 자산군 합계 안에 포함돼 있는데 별도로 더해
// 실탄을 51,186,564원으로 부풀려 보고했다. 오너가 "그 경우만 고치지 말고 전체를
// 보라"고 지적해 조사한 결과, 문제는 CMA 이중계산 하나가 아니라 "현금 합계 하나 =
// 실탄"이라는 프레임 자체였다 — ARCHITECTURE-V2.md가 이미 확정한 "연금저축·IRP·ISA는
// 세제혜택 계좌라 계좌 밖으로 현금을 뺄 수 없다" 원칙과 충돌한다. 계좌별로 가용성을
// 분리해서 보여주도록 확장.

// ⚠️ 현금 보유는 반드시 name: '예수금'(findCashBalance·holdings-vault-writer.mjs 관례,
// 실측 Vault 6계좌 전부 이 이름 그대로) — "위탁예수금"처럼 계좌명을 붙이면 매칭 안 됨.
// 이전 버전 테스트가 이 관례를 안 지켜 통과했던 건 findCashBalance 도입 전 assetClass
// 기반 자체 합산을 쓰던 시절 얘기 — 지금 이 이름 규칙 자체가 회귀 감지 대상이다.

test('buildReportFacts: 위탁+금현물 현금은 "자유 재투자 가능"으로 합산(cash-ledger.mjs resolveDesignatedCashBalance 재사용, 신규현금배분 잡과 동일 정의)', () => {
  const input = baseInput();
  input.holdings.push({ account: '위탁', name: '예수금', assetClass: '현금', qty: 0, invest: 3000000, evalAmount: 3000000, isCashLike: true });
  input.holdings.push({ account: '금현물', name: '예수금', assetClass: '현금', qty: 0, invest: 1000000, evalAmount: 1000000, isCashLike: true });
  const { factsText } = buildReportFacts(input);
  assert.match(factsText, /자유 재투자 가능\(위탁\+금현물, 신규현금배분 실제 배정 대상\): 4,000,000원/);
});

test('buildReportFacts: CMA는 별도 표시(위탁과 자동 합산 안 됨, 오너 재량 명시)', () => {
  const input = baseInput();
  // 위탁 현금도 같이 넣어 designated 합산이 실제로 0이 아닌 상태에서 CMA가 안 섞여
  // 들어가는지 검증(코드리뷰 지적 — baseInput()만으로는 designated가 항상 0이라 이
  // doesNotMatch가 공허하게 통과할 수 있었음).
  input.holdings.push({ account: '위탁', name: '예수금', assetClass: '현금', qty: 0, invest: 3000000, evalAmount: 3000000, isCashLike: true });
  input.holdings.push({ account: 'CMA', name: '예수금', assetClass: '현금', qty: 0, invest: 21054004, evalAmount: 21054004, isCashLike: true });
  const { factsText } = buildReportFacts(input);
  assert.match(factsText, /자유 재투자 가능\(위탁\+금현물, 신규현금배분 실제 배정 대상\): 3,000,000원/); // CMA 21M이 안 섞임
  assert.match(factsText, /CMA: 21,054,004원 \(위탁과 별도 계좌.*자동배분 대상은 아님.*오너 재량\)/);
});

test('buildReportFacts: 세제혜택 계좌(연금저축·ISA·IRP)는 "이 계좌 안에서만" 문구와 함께 개별 표시', () => {
  const input = baseInput();
  input.holdings.push({ account: '연금저축', name: '예수금', assetClass: '현금', qty: 0, invest: 2000000, evalAmount: 2000000, isCashLike: true });
  input.holdings.push({ account: 'ISA', name: '예수금', assetClass: '현금', qty: 0, invest: 87336, evalAmount: 87336, isCashLike: true });
  const { factsText } = buildReportFacts(input);
  assert.match(factsText, /연금저축: 2,000,000원 \(세제혜택 계좌.*이 계좌 안에서만 재투자 가능.*못 옮김/);
  assert.match(factsText, /ISA: 87,336원 \(세제혜택 계좌/);
});

test('buildReportFacts: 연금저축은 세제혜택 계좌면서 동시에 신규현금배분 자동 배정 대상 — 두 사실을 한 줄에 명시(코드리뷰 지적: 예전엔 "이 계좌 안에서만"이라고만 써서 자동배분 대상이라는 사실이 누락됨)', () => {
  const input = baseInput();
  input.holdings.push({ account: '연금저축', name: '예수금', assetClass: '현금', qty: 0, invest: 2000000, evalAmount: 2000000, isCashLike: true });
  input.holdings.push({ account: 'ISA', name: '예수금', assetClass: '현금', qty: 0, invest: 87336, evalAmount: 87336, isCashLike: true });
  const { factsText } = buildReportFacts(input);
  assert.match(factsText, /연금저축: 2,000,000원 \(.*신규현금배분 자동 배정 대상\)/);
  assert.doesNotMatch(factsText, /ISA: 87,336원 \(.*신규현금배분/); // ISA는 배정 대상 아님(CASH_ELIGIBLE_ACCOUNTS 밖)
});

test('buildReportFacts: 계좌는 있는데 예수금 레코드가 없는(null) 경우와 실제 0원인 경우를 구분 — 둘 다 절대 조용히 빠지지 않음(코드리뷰 HIGH 지적)', () => {
  const input = baseInput();
  // 위탁 예수금 자체가 없음(holdings에 위탁 예수금 행이 아예 없음) → cashByAcct['위탁']=null
  input.holdings.push({ account: '퀀트KIS', name: '삼성전자', assetClass: '국내주식', qty: 1, invest: 100000, evalAmount: 100000 });
  input.holdings.push({ account: 'IRP', name: '예수금', assetClass: '현금', qty: 0, invest: 0, evalAmount: 0, isCashLike: true });
  const { factsText } = buildReportFacts(input);
  // 위탁 예수금 데이터가 없으므로 "자유 재투자 가능"을 0원으로 확정 서술하지 않고 경고를 단다
  assert.match(factsText, /자유 재투자 가능\(위탁\+금현물.*\): 0원 \(⚠️ 위탁.*데이터 없음/);
  // 퀀트KIS는 예수금 레코드 자체가 없음(null) — "0원"이 아니라 "데이터 부족"으로, 조용히 안 빠짐
  assert.match(factsText, /퀀트KIS: 데이터 부족\(예수금 레코드 없음/);
  // IRP는 실제로 0원임이 확인됨(레코드 있음, 값이 0) — "데이터 부족"이 아니라 0원으로 명시, 역시 안 빠짐
  assert.match(factsText, /IRP: 0원 \(세제혜택 계좌/);
});

test('buildReportFacts: 위탁·금현물·CMA·세제혜택 어디에도 안 속하는 새 계좌는 "분류 미정"으로 표시(닫힌 계좌 집합 하드코딩 방지, 코드리뷰 지적)', () => {
  const input = baseInput();
  input.holdings.push({ account: '퀀트KIS', name: '예수금', assetClass: '현금', qty: 0, invest: 500000, evalAmount: 500000, isCashLike: true });
  const { factsText } = buildReportFacts(input);
  assert.match(factsText, /퀀트KIS: 500,000원 \(분류 미정 계좌/);
});

test('buildReportFacts: 이름이 "예수금"이 아닌 현금성 보유(예: 외화RP)는 계좌별 현금 가용성에서 안 잡힘 — findCashBalance 정확일치 규칙 그대로', () => {
  const input = baseInput();
  input.holdings.push({ account: '위탁', name: '외화 RP', assetClass: '달러', qty: 100, invest: 892846, evalAmount: 892846, isCashLike: true });
  const { factsText } = buildReportFacts(input);
  assert.match(factsText, /자유 재투자 가능\(위탁\+금현물, 신규현금배분 실제 배정 대상\): 0원/);
});

test('buildReportFacts: "총 실탄으로 합산 금지" 경고가 항상 포함', () => {
  const { factsText } = buildReportFacts(baseInput());
  assert.match(factsText, /서로 더해 "총 실탄"이라고 쓰지 마라/);
});

test('buildReportFacts: 현금 계좌가 전혀 없으면 자유 재투자 가능 0원으로 명시(추정 아님)', () => {
  const input = { ...baseInput(), holdings: [{ account: '위탁', name: 'SK하이닉스', assetClass: '국내주식', qty: 8, invest: 15920000, evalAmount: 17200000 }] };
  const { factsText } = buildReportFacts(input);
  assert.match(factsText, /자유 재투자 가능\(위탁\+금현물, 신규현금배분 실제 배정 대상\): 0원/);
});

test('buildReportFacts: 보유 전부 evalValue=0(null 아님)이면 totalEval도 실제로 0(코드리뷰 지적 — 예전엔 weightPct용 나눗셈 가드 `|| 1`이 그대로 노출돼 "총 평가액 1원"이라는 틀린 값이 나갈 뻔했다)', () => {
  const input = { ...baseInput(), holdings: [{ account: '위탁', name: 'X', assetClass: '국내주식', qty: 1, invest: 0, evalAmount: 0 }] };
  const { facts, factsText } = buildReportFacts(input);
  assert.equal(facts.totalEval, 0);
  assert.match(factsText, /총 평가액: 0원/);
});
