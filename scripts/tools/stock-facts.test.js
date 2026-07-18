import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, renderFacts, assembleFacts } from './stock-facts.mjs';

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
