#!/usr/bin/env node
// isa-exposure-facts.mjs — ISA 분기점검·3계좌 합산 노출 보고용 Node 결정론 사실 조립기.
// ledger-facts.mjs·rebalance-facts.mjs와 같은 패턴(Node는 사실만 조립, 판단은 LLM) —
// 순수 읽기전용(macro-overlay-facts.mjs와 달리 상태 갱신 없음).
//
// 목표비중(rebalance-gap.mjs)의 "위탁+연금저축만" 계산과 나란히 보여줘야 "이중노출
// 공백"이 실제로 눈에 보인다 — 그래서 두 숫자를 한 화면에 같이 낸다.
//
// 사용법:
//   node scripts/tools/isa-exposure-facts.mjs            # 사람이 읽는 보고
//   node scripts/tools/isa-exposure-facts.mjs --json      # 구조화 데이터
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { computeCurrentAllocation } from '../lib/rebalance-gap.mjs';
import { computeThreeAccountExposure, summarizeIsaHoldings, OVERLAP_CLASSES } from '../lib/isa-exposure.mjs';

const JSON_OUT = process.argv.includes('--json');

function readHoldings() {
  const dir = VAULT_PATHS.state.holdings;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

const won = (n) => Math.round(n).toLocaleString('ko-KR');

function main() {
  const holdings = readHoldings();
  const { currentPct: targetBasisPct } = computeCurrentAllocation(holdings); // 위탁+연금저축만(목표비중 계산 기준)
  const exposure = computeThreeAccountExposure(holdings); // 위탁+연금저축+ISA
  const isaSummary = summarizeIsaHoldings(holdings);

  if (JSON_OUT) {
    console.log(JSON.stringify({ targetBasisPct, exposure, isaSummary }, null, 2));
    return;
  }

  console.log('[ISA 분기점검 · 3계좌 합산 노출 보고]\n');
  console.log(`ISA 보유 ${isaSummary.items.length}종목, 평가액 ${won(isaSummary.totalEval)}원`);
  for (const it of isaSummary.items) {
    console.log(`  - ${it.name}(${it.assetClass}): ${won(it.evalAmount)}원 (ISA 내 ${it.weightPct.toFixed(1)}%)${it.profitPct != null ? ` 수익률 ${it.profitPct.toFixed(1)}%` : ''}`);
  }

  console.log(`\n3계좌(위탁+연금저축+ISA) 합산 평가액 ${won(exposure.totalEval)}원 — 겹치는 자산군 실제 노출:`);
  // ⚠️ 두 %는 분모·분자가 둘 다 다르다(코드리뷰 지적, 2026-08-05) — targetBasisPct는
  // 위탁+연금저축·6개자산군 분모, exposurePct는 3계좌·전체자산 분모. 단순 뺄셈은 "ISA
  // 때문에 커진 양"을 뜻하지 않는다(위탁·연금저축 현금성 비중이 크면 반대로도 나올 수
  // 있음) — 그래서 두 %는 각자 기준을 명시해 나란히만 보여주고, 자동 경고는 서로
  // 다른 잣대끼리의 차이가 아니라 ISA의 절대 기여액(단일 기준)으로만 낸다.
  for (const cls of OVERLAP_CLASSES) {
    const targetBased = targetBasisPct[cls];
    const actual = exposure.exposurePct[cls];
    const isaContribution = exposure.byClassIsaEval[cls];
    console.log(`  ${cls}: 리밸런싱 기준(위탁+연금저축, 6개자산군 분모) ${targetBased.toFixed(2)}% / 3계좌 합산(전체자산 분모) ${actual.toFixed(2)}%`);
    if (isaContribution > 0) console.log(`      └ 그중 ISA 기여분: ${won(isaContribution)}원`);
  }
  console.log('\n※ 이 보고는 정보 제공용 — 목표비중 계산(위탁+연금저축)이나 자동 매매량을 바꾸지 않습니다. 판단은 오너 재량.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
