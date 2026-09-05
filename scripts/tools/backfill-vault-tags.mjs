#!/usr/bin/env node
/**
 * 므네모시네 그래프 뷰 다중축 태그 소급 백필(일회성) — 2026-09-05.
 *
 * 배경: 오너가 그래프 뷰에서 계좌·자산군·종목(매수/매도/배당 등 같은 종목에서
 * 일어난 이벤트) 등 여러 기준으로 노드가 실제로 뭉쳐 보이게 하고 싶다고 요청.
 * `.obsidian/graph.json`의 색상 그룹(Groups) 기능을 먼저 시도했으나, LiveSync
 * 설정(`syncInternalFiles: false`)이 `.obsidian/` 폴더를 애초에 동기화 대상에서
 * 빼서 폰에서 전혀 안 보였다(오너 실측 확인) — 색상 그룹 대신 노트 frontmatter의
 * `tags` 필드를 쓰기로 전환(vault-tags.mjs 헤더 주석 참고, 태그는 진짜 콘텐츠라
 * LiveSync로 정상 동기화되고, Obsidian 그래프에서 태그 노드는 실제로 노드를
 * 물리적으로 끌어당겨 클러스터를 만든다).
 *
 * `scripts/lib/vault-tags.mjs`(태그 빌더)·각 카테고리의 라이브 writer(ledger-
 * vault-writer.mjs·holdings-vault-writer.mjs·proposal-vault.mjs·update-
 * allocation-from-holdings.mjs)는 이미 이번 세션에서 `tags` 필드를 신규 레코드에
 * 넣도록 갱신됐다 — 이 스크립트는 그 갱신 **이전에 만들어진 기존 파일들**에
 * 소급 적용하는 1회성 백필이다.
 *
 * ⚠️ 범위: Facts/Ledger/*·State/Holdings·State/Allocation·Decisions/Proposals만
 * (오너 명시 확인, 2026-09-05 AskUserQuestion) — Knowledge/Log는 이미 허브·
 * 위키링크 방식으로 따로 연결돼 있고, 오너가 "서로 다른 것들을 억지로 연결짓지
 * 말아달라"고 명시했다. 이 스크립트는 그 두 카테고리를 절대 안 건드린다.
 *
 * 각 카테고리의 필드 매핑은 라이브 writer와 정확히 동일하게 재현한다(신규
 * 파일과 기존 파일이 같은 규칙으로 태깅되게) — 카테고리별 상세 근거는
 * `scripts/lib/vault-tags.mjs` 및 각 writer 파일의 주석 참고.
 *
 * 멱등: frontmatter에 이미 `tags`가 배열로 있으면(빈 배열이어도) 건너뛴다 — 재실행
 * 해도 안전.
 *
 * 사용법:
 *   node scripts/tools/backfill-vault-tags.mjs            # 실제로 태깅
 *   node scripts/tools/backfill-vault-tags.mjs --dry-run   # 대상만 출력, 쓰기 없음
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, updateFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { buildVaultTags } from '../lib/vault-tags.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
// --force: 이미 tags가 있어도 무조건 재계산해서 덮어쓴다(2026-09-05 코드리뷰 지적 —
// 지연 계좌귀속처럼 나중에 원본 필드가 채워져도 최초 백필 시점 태그가 멱등 스킵에
// 걸려 영원히 안 고쳐지는 문제의 해소책). 평소엔 안 씀 — 신규 파일은 라이브 writer가
// 이미 tags를 정확히 채우므로, 매번 --force로 돌리면 그 정확한 값을 불필요하게
// 재계산만 반복한다.
const FORCE = process.argv.includes('--force');

// 순수함수(테스트 가능) — frontmatter 하나를 받아 그 카테고리의 규칙대로 태그를
// 계산한다. extract는 fm → {account, assetClass, stockName} 매핑(카테고리마다 다름).
export function computeBackfillTags(fm, extract) {
  return buildVaultTags(extract(fm));
}

// 카테고리별 대상 디렉터리 + fm→태그축 매핑. 라이브 writer 각각과 1:1 대응.
//
// ⚠️ 제외 대상(의도적, 오타 아님) — `VAULT_PATHS.facts.ledger`의 9개 하위폴더 중
// `dailySnapshots`·`monthlyBalances`는 여기 없다. 둘 다 계좌 단일 필드가 없는 전체
// 포트폴리오 집계 레코드(예: monthly-balance는 isa/wita/pension/irp가 각각 컬럼으로
// 평평하게 들어있음, 계좌 하나에 속하는 이벤트가 아님)라 계좌/자산군/종목 어느 축도
// 의미가 없다.
export const TARGETS = [
  { name: 'Executions', dir: VAULT_PATHS.facts.ledger.executions, extract: (fm) => ({ account: fm.account, stockName: fm.stockName }) },
  { name: 'CashEvents', dir: VAULT_PATHS.facts.ledger.cashEvents, extract: (fm) => ({ account: fm.account }) },
  // Dividends: 신규 기록 시점엔 account가 항상 null(ledger-vault-writer.mjs
  // buildDividendRecord 참고)이지만, update-holdings-from-executions.mjs가 나중에
  // 지연 계좌귀속으로 채운다 — fm.account를 읽어야 그 상태(백필 시점엔 이미 귀속이
  // 끝난 파일도 많음)를 정확히 반영한다(2026-09-05 코드리뷰 HIGH 지적 — 이걸 안 읽어서
  // 프로덕션 57건이 계좌 태그 없이 남았었다).
  { name: 'Dividends', dir: VAULT_PATHS.facts.ledger.dividends, extract: (fm) => ({ account: fm.account, stockName: fm.stockName }) },
  { name: 'FundPurchases', dir: VAULT_PATHS.facts.ledger.fundPurchases, extract: (fm) => ({ account: fm.account, stockName: fm.fundName }) },
  { name: 'FundValuations', dir: VAULT_PATHS.facts.ledger.fundValuations, extract: (fm) => ({ account: fm.account, stockName: fm.fundName }) },
  { name: 'Profits', dir: VAULT_PATHS.facts.ledger.profits, extract: (fm) => ({ account: fm.account, stockName: fm.stockName }) },
  { name: 'Exchanges', dir: VAULT_PATHS.facts.ledger.exchanges, extract: (fm) => ({ account: fm.account }) },
  // Holdings: 예수금(isCashLike)은 종목 태그 없음(buildCashHoldingRecord와 동일 — 매수/
  // 매도/배당 스레드가 없는 현금이라 "종목"으로 묶을 대상이 아님).
  { name: 'Holdings', dir: VAULT_PATHS.state.holdings, extract: (fm) => ({ account: fm.account, assetClass: fm.assetClass, stockName: fm.isCashLike ? undefined : fm.name }) },
  // Allocation: assetName 필드가 사실상 자산군(assetClass)과 같은 의미(필드명만 다름).
  { name: 'Allocation', dir: VAULT_PATHS.state.allocation, extract: (fm) => ({ account: fm.account, assetClass: fm.assetName }) },
  // Proposals: account가 null인 퀀트 제안은 track("퀀트")으로 계좌 축 대체(proposal-vault.mjs
  // buildProposalRecord와 동일). assetKey는 종목코드·종목명 혼재(vault-tags.mjs 헤더 주석의
  // 알려진 한계 그대로 적용 — 이 스크립트가 대신 추정하지 않음).
  { name: 'Proposals', dir: VAULT_PATHS.decisions.proposals, extract: (fm) => ({ account: fm.account ?? (fm.track === '퀀트' ? fm.track : null), stockName: fm.assetKey }) },
];

async function main() {
  let tagged = 0, noAxisSkipped = 0, skippedAlready = 0;
  for (const { name, dir, extract } of TARGETS) {
    // dir이 undefined면(VAULT_PATHS 키 오타 등) existsSync(undefined)가 false를
    // 반환해 이 카테고리 전체가 경고 없이 조용히 사라진다(2026-09-05 코드리뷰 LOW
    // 지적, "조용한 폴백 금지" 원칙 위반) — 여기서 명시적으로 잡아 던진다.
    if (!dir) throw new Error(`backfill-vault-tags: TARGETS["${name}"]의 dir이 undefined — VAULT_PATHS 매핑 확인 필요`);
    if (!existsSync(dir)) { console.warn(`  ⚠️  [${name}] 디렉터리 없음 — 스킵: ${dir}`); continue; }
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      const filepath = join(dir, f);
      const content = readFileSync(filepath, 'utf8');
      const fm = parseFrontmatter(content);
      // 이미 tags가 배열로 있으면(빈 배열 포함) 멱등 스킵 — 재실행해도 안전.
      // --force면 이 스킵을 무시하고 무조건 재계산(위 FORCE 주석 참고).
      if (!FORCE && Array.isArray(fm.tags)) { skippedAlready++; continue; }

      const tags = computeBackfillTags(fm, extract);
      // 축이 하나도 없으면 아예 안 씀(2026-09-05 코드리뷰 MEDIUM 지적) — 여기서
      // tags: []를 기록해버리면 "이미 태깅됨"으로 영구히 멱등 스킵돼, 나중에 원본
      // 데이터가 보정돼도(예: 지연 계좌귀속) 재실행으로 절대 안 고쳐진다. 안 쓰고
      // 넘기면 다음 재실행 때 다시 시도할 여지가 남는다.
      if (!tags.length) {
        console.log(`  · [${name}] ${basename(f)}: 태그 축 없음(스킵, tags 필드 안 씀)`);
        noAxisSkipped++;
        continue;
      }
      console.log(`  + [${name}] ${basename(f)}: ${tags.join(', ')}`);
      tagged++;
      if (!DRY_RUN) await writeStateFile(filepath, updateFrontmatter(content, { tags }));
    }
  }
  console.log(
    `\n✅ 완료 — 태깅 ${tagged}건 · 태그 축 없어 건너뜀 ${noAxisSkipped}건 · 이미 태깅됨(스킵) ${skippedAlready}건`
    + (DRY_RUN ? ' (드라이런)' : ''),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`backfill-vault-tags 실패: ${e?.message ?? e}`); process.exitCode = 1; });
}
