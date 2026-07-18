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
import { loadEnv, hasServiceAccount, getToken, getRange, ACCOUNTS } from '../lib/sheets-common.mjs';

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

// ── 보유 현황(시트 결정론) — 순수 파싱. 시트 탭 A2:I: A구분0 B종목1 C평단2 D수량3 E투자금4 G손익6 I수익률8.
const pn = (v) => parseFloat(String(v ?? '').replace(/[,%]/g, '')) || 0;

export function findHolding(holdingsByAcct, name) {
  const results = [];
  for (const [acct, rows] of Object.entries(holdingsByAcct || {})) {
    let lastType = '';
    for (const r of (rows || [])) {
      const t = String(r[0] ?? '').trim();
      if (t) lastType = t;
      // 정확일치 또는 선행 단어 매칭("알파벳"→"알파벳 Class A"). 공백 경계로 과매칭 방지
      // ("삼성"이 "삼성전자"를 잡지 않음 — 그건 Frank가 정확명을 쓰게 둔다).
      const nm = String(r[1] ?? '').trim();
      if (nm !== name && !nm.startsWith(name + ' ')) continue;
      const qty = pn(r[3]); const invest = pn(r[4]);
      if (qty <= 0 && invest <= 0) continue;
      results.push({ acct, type: lastType, avgPrice: pn(r[2]), qty, invest, profit: pn(r[6]), rate: pn(r[8]) });
    }
  }
  return results;
}

export function formatHoldings(list) {
  if (!list || !list.length) return '미보유';
  const won = (n) => Math.round(n).toLocaleString('ko-KR');        // 원화(투자금·손익)는 정수
  const price = (n) => Number.isInteger(n) ? n.toLocaleString('ko-KR')  // 평단은 US 소수($311.5) 보존
    : n.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  return list.map((h) =>
    `[${h.acct}${h.type ? ` · ${h.type}` : ''}] 평단 ${price(h.avgPrice)} × ${h.qty}주 = 투자금 ${won(h.invest)}원 (평가손익 ${won(h.profit)}원, 수익률 ${h.rate}%)`
  ).join('\n');
}

// 보유 판정(순수) — 리뷰 지적(readHoldings 가드 미러): 실계좌엔 항상 보유가 있으므로 전 계좌 빈 응답은
// "미보유"가 아니라 시트 읽기 이상이다. 이걸 "미보유"로 내면 무결성 기능 안에서 사실을 날조하는 꼴.
// 전 계좌 총 0행이면 데이터 부족으로, 데이터는 있는데 그 종목만 없으면 정직한 미보유로 구분한다.
export function holdingsFromRows(byAcct, name) {
  const totalRows = Object.values(byAcct || {}).reduce((s, r) => s + (r?.length || 0), 0);
  if (totalRows === 0) return { holdings: null, holdingsText: '(보유 데이터 부족: 전 계좌 빈 응답 — 시트 읽기 이상 의심, 추정 금지)' };
  const list = findHolding(byAcct, name);
  return { holdings: list, holdingsText: formatHoldings(list) };
}

export function renderFacts(facts, { json = false } = {}) {
  if (json) {
    return JSON.stringify({
      market: facts.market, factsText: facts.factsText,
      axisItems: facts.axisItems, missing: facts.missing,
      holdings: facts.holdings ?? null,
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
  if (facts.holdingsText) {
    lines.push('', '[보유 현황 — 시트 결정론 조회]', facts.holdingsText);
  }
  lines.push('⚠️ 위 숫자만 사용하라. 어떤 수치도 직접 fetch·추정하지 말 것 — 역할은 이 숫자로 판단하는 것뿐이다.');
  return lines.join('\n');
}

// 시트 보유현황 조회(서비스계정, 브라우저 없음). 실패는 환각보다 공백 — 데이터 부족 문구로 폴백.
async function loadHoldings(name) {
  if (!hasServiceAccount()) return { holdings: null, holdingsText: '(보유 데이터 부족: 시트 서비스계정 없음)' };
  const token = await getToken(null, { allowBrowser: false });
  const byAcct = {};
  const rows = await Promise.all(ACCOUNTS.map((acct) => getRange(token, `${acct}!A2:I`)));
  ACCOUNTS.forEach((acct, i) => { byAcct[acct] = rows[i]; });
  return holdingsFromRows(byAcct, name);   // 전 계좌 빈 응답 가드 포함(readHoldings 미러)
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
    try {
      Object.assign(facts, await loadHoldings(opts.name));
    } catch (e) {
      facts.holdingsText = `(보유 데이터 부족: 시트 조회 실패 — ${e.message.slice(0, 60)})`;
    }
    process.stdout.write(renderFacts(facts, { json: opts.json }) + '\n');
  } catch (e) {
    // 조립 실패도 환각보다 공백 — 데이터 부족으로 정직하게 알린다.
    console.error(`⚠️ facts 조립 실패(${opts.name}): ${e.message} — 데이터 부족으로 처리(추정 금지)`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
