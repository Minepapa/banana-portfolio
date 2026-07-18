#!/usr/bin/env node
// stock-facts.mjs — 대화형 부서(투자전략실 Athena 등)에 주입할 "Node 결정론 숫자"를 조립·출력한다.
//
// 앱 최우선 원칙: LLM은 숫자를 지어내지 않는다 — Node가 가져오고 LLM은 판단만.
// 헤드리스(drain-eval-queue --auto)가 buildEvalFacts로 하던 것을 대화형에서도 쓰도록 CLI화.
// /athena 커맨드가 Athena 스폰 전에 이걸 Bash로 실행 → factsText를 프롬프트에 주입.
// (하드 보장의 나머지 절반은 athena.md frontmatter의 도구 제한 — 대화형 Athena가 직접 fetch 불가.)
//
// 순수부(parseArgs·renderFacts·assembleFacts)는 테스트됨(stock-facts.test.js). 네트워크 페처는
// buildEvalFacts에 주입되므로 스텁 가능. 실패는 추정 없이 "데이터 부족"으로 정직하게.

import { buildEvalFacts } from '../lib/eval-facts.mjs';
import { fetchKrFundamentals, fetchUsFundamentals, fetchKrMarketData, fetchMarketData } from '../lib/fundamentals.mjs';
import { krCorpCode, krStockCode, usTicker } from '../lib/instruments.mjs';
import { loadEnv } from '../lib/auth.mjs';

const MARKETS = ['KR', 'US'];

export function parseArgs(argv) {
  let name = null, market = null, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--market') {
      market = String(argv[++i] ?? '').toUpperCase();
      if (!MARKETS.includes(market)) throw new Error(`--market 값은 KR|US 여야 함: "${market}"`);
    } else if (!a.startsWith('--') && name == null) {
      name = a;
    }
  }
  if (!name) throw new Error('종목명이 필요합니다. 사용법: stock-facts.mjs "<종목명>" [--market KR|US] [--json]');
  return { name, market, json };
}

// 종목명 → 식별자. 순수·결정론(instruments 조회). 테스트에서 주입 대체 가능.
export function defaultResolveIds(name) {
  return { corpCode: krCorpCode(name), stockCode: krStockCode(name), ticker: usTicker(name) };
}

// 실 네트워크 페처 묶음(drain-eval-queue.buildAutoFacts와 동일 배선 — 같은 결정론 소스).
export const defaultFetchers = {
  krFund: (c) => fetchKrFundamentals(c),
  usFund: (t) => fetchUsFundamentals(t),
  krMkt: (s) => fetchKrMarketData(s),
  usMkt: (t) => fetchMarketData(t),
};

export async function assembleFacts(name, market, { resolveIds = defaultResolveIds, fetchers = defaultFetchers } = {}) {
  const entry = { name, market };
  const ids = resolveIds(name);
  return buildEvalFacts(entry, ids, fetchers);
}

export function renderFacts(facts, { json = false } = {}) {
  if (json) {
    return JSON.stringify({
      market: facts.market, factsText: facts.factsText,
      axisItems: facts.axisItems, missing: facts.missing,
    });
  }
  const lines = [
    `[Node 검증 숫자 — ${facts.market}] (OpenDart·yfinance 결정론 산출 — 재조회·수정 금지)`,
    facts.factsText,
  ];
  // buildEvalFacts는 missing을 factsText에 이미 붙이지만, 직접 조립한 facts엔 없을 수 있어 보강.
  if (facts.missing?.length && !/데이터 부족/.test(facts.factsText)) {
    lines.push(`⚠️ 데이터 부족: ${facts.missing.join('; ')} → 추정 금지, 해당 항목은 "(데이터 부족)"`);
  }
  lines.push('⚠️ 위 숫자만 사용하라. 어떤 수치도 직접 fetch·추정하지 말 것 — 역할은 이 숫자로 판단하는 것뿐이다.');
  return lines.join('\n');
}

async function main() {
  loadEnv(); // DART_API_KEY 등
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  try {
    const facts = await assembleFacts(opts.name, opts.market);
    process.stdout.write(renderFacts(facts, { json: opts.json }) + '\n');
  } catch (e) {
    // 조립 실패도 환각보다 공백 — 데이터 부족으로 정직하게 알린다.
    console.error(`⚠️ facts 조립 실패(${opts.name}): ${e.message} — 데이터 부족으로 처리(추정 금지)`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
