// 신규 보유 자산군은 확인된 출처만 사용한다. 주문 라우터의 KR_STOCK은 ETF의
// 기초자산(채권·금·달러 포함)을 알 수 없으므로 자산군으로 역변환하지 않는다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TARGET_ALLOCATION } from './rebalance-gap.mjs';
import { ASSET_CLASS_ETF_UNIVERSE } from './asset-class-etf-universe.mjs';
import { VAULT_PATHS, VAULT_REL, vaultAbs } from './vault-paths.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { PHYSICAL_GOLD_ASSET_CLASS_MAPPING } from './asset-allocation-instrument-router.mjs';

// 목표배분은 위탁+연금저축의 5종만 계산한다(rebalance-gap.mjs). 실보유에서
// 연금저축 배당주는 레거시로 유지하지만 신규 위탁에 옮기면 리밸런싱에서 빠진다.
// ISA는 배당주 중심이며 해외주식도 허용한다. IRP는 TDF와 목표배분 5종을 쓴다.
const POOLED_CLASSES = Object.keys(TARGET_ALLOCATION);
export const ACCOUNT_ASSET_CLASSES = Object.freeze({
  위탁: new Set([...POOLED_CLASSES, '현금']),
  연금저축: new Set([...POOLED_CLASSES, '배당주', '현금']),
  ISA: new Set(['배당주', '해외주식', '현금']),
  IRP: new Set([...POOLED_CLASSES, 'TDF', '현금']),
  CMA: new Set(['현금']),
  금현물: new Set(['금', '현금']),
});
const NOTE_ASSET_CLASS = Object.freeze({ '배당주·리츠': '배당주' });
const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase('ko');
const matching = (left, right) => left && right && normalize(left) === normalize(right);

export function assetClassTableRows(content, assetClass) {
  const section = String(content).split(/^## 지금 쓰는 종목\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  return section.split('\n').filter((line) => /^\|/.test(line)).slice(2).map((line) => {
    const cells = line.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '[[$1\u0000$2]]')
      .split('|').slice(1).map((cell) => cell.replaceAll('\u0000', '|').trim());
    const link = cells[0]?.match(/^\[\[[^|\]]+\|([^\]]+)\]\]$/);
    return { name: link?.[1] ?? cells[0], account: cells[1], assetClass };
  }).filter((row) => row.name && row.account);
}

// 주입된 자료만 읽는 순수 함수. 동명이종목/복수 자산군은 추정하지 않는다.
export function resolveHoldingAssetClass(exec, { proposals = [], holdingsMap = new Map(), wikiRows = [],
  universe = ASSET_CLASS_ETF_UNIVERSE, routerMappings = [] } = {}) {
  const holdings = holdingsMap instanceof Map ? [...holdingsMap.values()] : holdingsMap;
  const allowed = ACCOUNT_ASSET_CLASSES[exec.account] ?? new Set();
  const identity = (candidate) => matching(candidate, exec.stockCode) || matching(candidate, exec.stockName);
  const proposalsForBuy = proposals.filter((proposal) => proposal.side === '매수'
    && proposal.account === exec.account && ['부분체결', '체결', '섀도우체결'].includes(proposal.status)
    && identity(proposal.assetKey));
  const proposalClasses = new Set(proposalsForBuy.map((proposal) => proposal.assetClass).filter(Boolean));
  const candidates = [
    ['체결', exec.assetClass],
    ['매수 제안', proposalClasses.size === 1 ? [...proposalClasses][0] : null],
    ['다른 계좌 보유', (() => {
      const others = holdings.filter((holding) => holding.account !== exec.account && holding.assetClass);
      const byCode = exec.stockCode ? others.filter((holding) => matching(holding.ticker, exec.stockCode)) : [];
      const rows = byCode.length ? byCode : others.filter((holding) => matching(holding.name, exec.stockName)
        && (!exec.stockCode || !holding.ticker || matching(holding.ticker, exec.stockCode)));
      const classes = new Set(rows.map((holding) => holding.assetClass));
      return classes.size === 1 ? rows[0]?.assetClass : null;
    })()],
    ['자산군 표', (() => {
      const rows = wikiRows.filter((row) => row.account === exec.account && (identity(row.name) || identity(row.code)));
      return new Set(rows.map((row) => row.assetClass)).size === 1 ? rows[0]?.assetClass : null;
    })()],
    ['ETF 유니버스', (() => {
      const classes = Object.entries(universe).filter(([, names]) => names.some((name) => name === exec.stockName))
        .map(([assetClass]) => assetClass);
      return classes.length === 1 ? classes[0] : null;
    })()],
    ['종목 라우터', (() => {
      const rows = routerMappings.filter((row) => (!row.account || row.account === exec.account)
        && (identity(row.code) || identity(row.name)));
      return new Set(rows.map((row) => row.assetClass)).size === 1 ? rows[0]?.assetClass : null;
    })()],
  ];
  const warnings = [];
  for (const [source, value] of candidates) {
    if (value && !allowed.has(value)) warnings.push(`${source}: ${exec.account} 계좌에 맞지 않는 자산군: ${value}`);
  }
  const valid = candidates.filter(([, value]) => allowed.has(value));
  const [source, assetClass] = valid[0] ?? [null, ''];
  for (const [otherSource, value] of valid.slice(1)) {
    if (value !== assetClass) warnings.push(`자산군 충돌: ${source}=${assetClass}, ${otherSource}=${value}`);
  }
  return { assetClass, source, warnings, conflict: warnings.some((warning) => warning.startsWith('자산군 충돌:')) };
}

function readNotes(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.md'))
    .flatMap((name) => {
      try { return [{ name, content: readFileSync(join(dir, name), 'utf8') }]; }
      catch (error) { console.warn(`⚠️ 자산군 출처 읽기 실패 ${join(dir, name)}: ${error.message}`); return []; }
    });
}

export function loadHoldingAssetClassSources({ holdingsMap = new Map(),
  proposalsDir = VAULT_PATHS.decisions.proposals, topicsDir = vaultAbs(VAULT_REL.assetClassTopics) } = {}) {
  const proposals = readNotes(proposalsDir).map(({ content }) => parseFrontmatter(content));
  const wikiRows = readNotes(topicsDir).flatMap(({ name, content }) => {
    const topic = name.replace(/(?: 자산군)?\.md$/, '');
    const assetClass = NOTE_ASSET_CLASS[topic] ?? topic;
    return Object.values(ACCOUNT_ASSET_CLASSES).some((classes) => classes.has(assetClass))
      ? assetClassTableRows(content, assetClass) : [];
  });
  // 라우터가 확정하는 자산군은 실물 금 상품 하나뿐이다.
  const routerMappings = [PHYSICAL_GOLD_ASSET_CLASS_MAPPING];
  return { proposals, holdingsMap, wikiRows, routerMappings };
}

export function missingAssetClassQuestion(holding, resolution = null) {
  const identity = holding.name;
  const detail = resolution?.conflict ? '출처 사이 자산군이 충돌했습니다.' : '보유 자산군이 비어 있습니다.';
  return {
    kind: 'manual-change', asker: 'plutus', urgent: false, evidenceNotes: [],
    dedupeKey: `asset-class|${holding.account}|${identity}`,
    question: `${holding.account} 종목 ${identity}의 자산군을 확인해 주세요. ${detail} 확인 후 자산군과 태그를 수정해야 합니다.`,
  };
}
