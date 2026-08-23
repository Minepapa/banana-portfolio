#!/usr/bin/env node
// rebalance-facts.mjs — 자산분배 트랙(Athena) 대화형 보고용 Node 결정론 사실 조립기.
//
// ledger-facts.mjs·risk-facts.mjs와 같은 패턴(Hermes/Athena 스폰 전에 이 CLI로 factsText를
// 만들어 주입) — 이 파일은 State/Holdings를 읽어 5/25 밴드 갭까지만 계산한다("Node는
// 사실만 조립, 판단은 LLM" 원칙). 이탈이 확인된 뒤 "구체적으로 무엇을 팔고 살지"는
// Athena의 재량 판단이라 여기서 만들지 않는다.
//
// 사용법:
//   node scripts/tools/rebalance-facts.mjs            # 사람이 읽는 보고
//   node scripts/tools/rebalance-facts.mjs --json      # 구조화 데이터
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { computeRebalanceGaps } from '../lib/rebalance-gap.mjs';

const JSON_OUT = process.argv.includes('--json');

function readHoldings() {
  const dir = VAULT_PATHS.state.holdings;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

const won = (n) => Math.round(n).toLocaleString('ko-KR');
const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

function main() {
  const holdings = readHoldings();
  const { totalEval, gaps, anyBreached } = computeRebalanceGaps(holdings);

  if (JSON_OUT) {
    console.log(JSON.stringify({ totalEval, gaps, anyBreached }, null, 2));
    return;
  }

  // totalEval은 위탁+연금저축 "전체" 평가액이 아니라 그 안의 리밸런싱 대상 6개
  // 자산군만의 합계다(현금성·달러·TDF 등은 원칙상 배분 대상 밖이라 분모에서 제외) —
  // 코드리뷰 지적(2026-08-05): 라벨이 "합산 평가액"이라고만 하면 계좌 전체 잔고로
  // 오독될 수 있어 범위를 명시한다.
  console.log(`[자산분배 5/25 밴드 점검] 위탁+연금저축 리밸런싱 대상(5개 자산군) 합산 평가액 ${won(totalEval)}원\n`);
  for (const g of gaps) {
    const flag = g.breached ? `[경고] 이탈(${g.breachType})` : '정상';
    console.log(`  ${g.assetClass}: 목표 ${g.targetPct}% / 현재 ${g.currentPct.toFixed(2)}% (${pct(g.currentPct - g.targetPct)}p) — ${flag}`);
  }
  // ⚠️ "[경고]" 문자열은 단순 장식이 아니다 — daily-asset-allocation-check.mjs가 이
  // stdout 전체를 캡처해 .includes('[경고]')로 "텔레그램으로 보낼 만한 변화가 있는가"를
  // 판정하는 시그널이다(2026-08-23, 이모지⚠️→대괄호 태그로 교체하며 시그널 문자열도
  // 같이 바꿈 — 두 파일이 어긋나면 daily-asset-allocation-check가 영원히 조용해진다).
  console.log(anyBreached ? '\n[경고] 밴드 이탈 자산군 있음 — Athena 리밸런싱 판단 필요' : '\n[정상] 전 자산군 밴드 안 — 이번 분기 리밸런싱 불필요');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
