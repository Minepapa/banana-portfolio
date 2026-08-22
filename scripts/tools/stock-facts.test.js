import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, renderFacts, assembleFacts, findHolding, formatHoldings, resolveHoldingsText } from './stock-facts.mjs';

// stock-facts.mjs — 대화형 부서에 주입할 "Node 결정론 숫자"를 조립·출력하는 CLI.
// 목적: 대화형 Athena가 숫자를 직접 fetch하지 못하게 하고(하드 보장), 모든 수치를 이 CLI가
// buildEvalFacts로 산출해 주입. 환각 차단이 최우선이므로 실패는 "데이터 부족"으로 정직하게.

test('parseArgs — 종목명 필수, --market/--json 플래그', () => {
  assert.deepEqual(parseArgs(['알파벳']), { name: '알파벳', market: null, json: false });
  assert.deepEqual(parseArgs(['삼성전자', '--market', 'KR']), { name: '삼성전자', market: 'KR', json: false });
  assert.deepEqual(parseArgs(['AAPL', '--json']), { name: 'AAPL', market: null, json: true });
  assert.deepEqual(parseArgs(['엔비디아', '--market', 'US', '--json']), { name: '엔비디아', market: 'US', json: true });
});

test('parseArgs — 종목명 없으면 throw', () => {
  assert.throws(() => parseArgs([]), /종목명/);
  assert.throws(() => parseArgs(['--json']), /종목명/);
});

test('parseArgs — 잘못된 market 값 거부', () => {
  assert.throws(() => parseArgs(['x', '--market', 'JP']), /market/i);
});

const sampleFacts = () => ({
  axisItems: {
    수익성: [{ label: '영업이익률', value: '36.1%', source: 'yfinance' }],
    안정성: [], 밸류에이션: [{ label: 'PBR', value: '9.1', source: 'yfinance' }],
    현금흐름: [], 모멘텀: [{ label: 'RSI(14)', value: '47.66', source: 'yfinance' }],
  },
  factsText: '- 수익성: 영업이익률 36.1%\n- 모멘텀: RSI(14) 47.66',
  market: 'US',
  missing: [],
});

test('renderFacts — 사람용: factsText + Node 검증 가드 헤더 포함', () => {
  const out = renderFacts(sampleFacts(), { json: false });
  assert.match(out, /영업이익률 36\.1%/);
  assert.match(out, /RSI\(14\) 47\.66/);
  // 하드 보장 가드 문구가 출력 자체에 실려야 한다(주입 시 "재조회 금지"가 항상 따라붙게).
  assert.match(out, /재조회|추정 금지|Node/);
});

test('renderFacts — 데이터 부족은 정직하게 노출', () => {
  const f = sampleFacts();
  f.missing = ['US 티커 매핑 실패(재무)'];
  const out = renderFacts(f, { json: false });
  assert.match(out, /데이터 부족|매핑 실패/);
});

test('renderFacts — --json은 구조 그대로 라운드트립', () => {
  const out = renderFacts(sampleFacts(), { json: true });
  const parsed = JSON.parse(out);
  assert.equal(parsed.market, 'US');
  assert.ok(parsed.axisItems && parsed.factsText != null);
  assert.deepEqual(parsed.missing, []);
});

test('assembleFacts — 주입된 페처의 숫자만 사용(Node 출처 증명)', async () => {
  const facts = await assembleFacts('테스트종목', 'US', {
    resolveIds: () => ({ corpCode: null, stockCode: null, ticker: 'TST' }),
    fetchers: {
      usFund: async () => ({ source: 'stub-fund', opMargin: 40, roe: 30, debtRatio: 20 }),
      usMkt: async () => ({ source: 'stub-mkt', rsi14: 55, pos52w: 70 }),
    },
  });
  assert.equal(facts.market, 'US');
  assert.match(facts.factsText, /영업이익률 40%/);
  assert.match(facts.factsText, /RSI\(14\) 55/);
});

test('assembleFacts — 매핑 실패 종목은 데이터 부족(추정 금지)', async () => {
  const facts = await assembleFacts('없는종목', 'US', {
    resolveIds: () => ({ corpCode: null, stockCode: null, ticker: null }),
    fetchers: {},
  });
  assert.ok(facts.missing.length > 0);
  assert.match(facts.factsText, /데이터 부족/);
});

// 보유 파싱: 2026-08-22부터 Vault State/Holdings 프론트매터 배열이 입력(v1 시트 탭 A2:I
// 조회를 대체 — PANTHEON.md가 명시했던 마지막 미전환 항목). 종목명 정식표기는
// "알파벳 Class A"인데 Frank는 "알파벳"으로 부른다 → 선행 단어 매칭 필요.
const holdingsFixture = () => ([
  { account: '위탁', assetClass: '해외주식', name: '알파벳 Class A', avgPrice: 311500, qty: 14, invest: 6488790, profitAmount: 734006, profitPct: 11.3 },
  { account: '위탁', assetClass: '해외주식', name: '엔비디아', avgPrice: 100, qty: 10, invest: 1000, profitAmount: 50, profitPct: 5 },
  { account: 'ISA', assetClass: '배당주', name: '알파벳 Class C', avgPrice: 340000, qty: 2, invest: 680000, profitAmount: 13000, profitPct: 1.9 },
]);

test('findHolding — 포지션 집계(평단·수익률 포함) + 선행단어 매칭("알파벳"→"알파벳 Class A")', () => {
  const rows = findHolding(holdingsFixture(), '알파벳');
  assert.equal(rows.length, 2);              // 위탁 Class A + ISA Class C
  assert.equal(rows[0].account, '위탁');
  assert.equal(rows[0].qty, 14);
  assert.equal(rows[0].avgPrice, 311500);
  assert.equal(rows[0].profitPct, 11.3);
});

test('findHolding — 정확일치도 매칭', () => {
  const rows = findHolding([{ account: '위탁', assetClass: '국내주식', name: '삼성전자', avgPrice: 60000, qty: 100, invest: 6000000, profitAmount: 0, profitPct: 0 }], '삼성전자');
  assert.equal(rows.length, 1);
});

test('findHolding — 과매칭 방지: "삼성"은 "삼성전자"를 매칭하지 않는다(공백 경계)', () => {
  const rows = findHolding([{ account: '위탁', name: '삼성전자', qty: 100, invest: 6000000 }], '삼성');
  assert.deepEqual(rows, []);
});

test('findHolding — 미보유는 빈 배열, 수량·투자금 0은 제외', () => {
  assert.deepEqual(findHolding(holdingsFixture(), '테슬라'), []);
  const zero = [{ account: '위탁', name: '유령', qty: 0, invest: 0 }];
  assert.deepEqual(findHolding(zero, '유령'), []);
});

test('formatHoldings — 미보유는 "미보유" 명시', () => {
  assert.match(formatHoldings([]), /미보유/);
});

test('formatHoldings — 보유는 수치·계좌를 서술', () => {
  const out = formatHoldings(findHolding(holdingsFixture(), '알파벳'));
  assert.match(out, /위탁/);
  assert.match(out, /14/);
  assert.match(out, /311[,.]?500/);
});

test('formatHoldings — profitPct가 null(invest 0/결측)이면 추정하지 않고 데이터 부족 표시', () => {
  const out = formatHoldings([{ account: '위탁', assetClass: '국내주식', avgPrice: 1000, qty: 1, invest: 1000, profitAmount: 0, profitPct: null }]);
  assert.match(out, /데이터 부족/);
});

test('resolveHoldingsText — Vault State/Holdings 전체가 빈 응답이면 "미보유"가 아니라 데이터 부족(읽기 이상)', () => {
  // 리뷰 지적(readHoldings 가드 미러): 실계좌엔 항상 보유가 있으므로 전부 빈 응답 = 읽기 이상.
  const r = resolveHoldingsText([], '알파벳');
  assert.equal(r.holdings, null);
  assert.match(r.holdingsText, /데이터 부족|읽기 이상/);
});

test('resolveHoldingsText — 데이터는 있는데 그 종목만 없으면 정직한 "미보유"', () => {
  const r = resolveHoldingsText(holdingsFixture(), '테슬라');
  assert.deepEqual(r.holdings, []);
  assert.match(r.holdingsText, /미보유/);
});

test('resolveHoldingsText — 보유 종목은 리스트+서술', () => {
  const r = resolveHoldingsText(holdingsFixture(), '알파벳');
  assert.equal(r.holdings.length, 2);
  assert.match(r.holdingsText, /위탁/);
});
