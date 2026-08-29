#!/usr/bin/env node
/**
 * State/Allocation 실시간 갱신 — 2026-08-21 페이지별 Vault 감사에서 발견한 공백 수정.
 *
 * 대시보드 "자산분배" 탭이 8/13(Phase 7) 마이그레이션 스냅샷에 멈춘 채 그 이후로
 * 한 번도 안 갱신되고 있었다(16개 파일 전부 legacy:true). 이 잡이 State/Holdings를
 * 읽어 계좌별 실제 목표대비현재 비중을 계산해 덮어쓴다.
 *
 * ⚠️ Athena의 실제 리밸런싱 판단(rebalance-facts.mjs → rebalance-gap.mjs
 * computeRebalanceGaps)은 이 파일을 안 읽는다 — 위탁+연금저축+금현물 "합산 풀" 기준으로
 * 매번 새로 계산해서 그 자체로 항상 정확하다. 이 잡은 순수하게 대시보드 표시용
 * (위탁·연금저축·금현물 탭 모두 같은 합산 풀 숫자를 보여준다, 2026-08-21 오너 확정 —
 * scripts/lib/allocation-snapshot.mjs 주석 참고) — 실패해도 실제 리밸런싱 판단엔 영향 없음.
 *
 * 사용법: node scripts/jobs/update-allocation-from-holdings.mjs [--dry-run]
 */
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { computeAccountAllocationSnapshot } from '../lib/allocation-snapshot.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
// 금현물은 2026-08-21 추가 — CMA와 동일 패턴(대시보드에 계좌 블록이 아예 없어 보유가
// 안 보이던 것 발견·수정). 위탁·연금저축과 같은 합산 풀 숫자를 그대로 받는다
// (allocation-snapshot.mjs computeAccountAllocationSnapshot 참고).
// ⚠️ CMA 자신은 그 "동일 패턴"이라던 비교 대상인데 정작 이 목록엔 빠져있었다
// (2026-08-22 오너 지적 — CMA 목표비중이 항상 0%로 나옴). allocation-snapshot.mjs의
// SINGLE_ASSET_ACCOUNTS엔 같은 날 추가했지만, 그걸 실제로 호출해 State/Allocation에
// 쓰는 이 잡의 목록엔 반영이 안 돼있었던 것 — 두 군데 다 고쳐야 실제로 반영된다.
const ACCOUNTS = ['위탁', '연금저축', '금현물', 'ISA', 'IRP', 'CMA'];

function readHoldings() {
  const dir = VAULT_PATHS.state.holdings;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

// 순수함수(테스트 가능) — 지금 시점 기준 유효한 계좌×자산군 조합에 없는 기존 파일을
// 골라낸다. TARGET_ALLOCATION에서 자산군이 빠지거나 ACCOUNTS 목록이 바뀌면 이 함수가
// 그 잔재를 찾아낸다(2026-08-29 신설, 므네모시네 파일배선도 감사 지적).
export function findOrphanedAllocationFiles(existingFilenames, expectedFilenames) {
  const expected = new Set(expectedFilenames);
  return existingFilenames.filter((f) => !expected.has(f));
}

function main() {
  const holdings = readHoldings();
  if (!holdings.length) { console.log('⚠️ State/Holdings가 비어있음 — 갱신 건너뜀(추정 안 함)'); return; }

  let updated = 0;
  const expectedFilenames = new Set();
  for (const account of ACCOUNTS) {
    const rows = computeAccountAllocationSnapshot(holdings, account);
    for (const row of rows) {
      const filename = `${account}-${row.assetName}.md`;
      expectedFilenames.add(filename);
      const filepath = join(VAULT_PATHS.state.allocation, filename);
      const record = buildFrontmatter({
        type: 'allocation', account, assetName: row.assetName,
        targetPct: row.targetPct, currentPct: row.currentPct, rebalAmt: row.rebalAmt,
        updatedAt: new Date().toISOString(),
      });
      console.log(`  · ${filename}: 목표 ${row.targetPct}% / 현재 ${row.currentPct}% (갭 ${(row.currentPct - row.targetPct).toFixed(1)}%p)`);
      if (!DRY_RUN) writeAtomic(filepath, record);
      updated++;
    }
  }

  // ⚠️ 고아 파일 자동정리(2026-08-29, 므네모시네 파일배선도 감사 지적 — TARGET_ALLOCATION
  // 에서 자산군을 빼면 옛 State/Allocation 파일이 안 지워지고 남던 문제, 2026-08-23
  // 배당주·리츠 삭제 때 수동으로 처리했던 전례). 이 잡이 매번 "지금 유효한 계좌×자산군
  // 조합 전체"를 다시 계산하므로, 그 목록에 없는 기존 파일은 전부 지금 시점 기준 무의미한
  // 잔재다 — update-cash-from-ledger.mjs의 "매번 처음부터 재계산해 덮어쓴다" 원칙과
  // 동일하게, 여기서도 "지금 상태"만 남기고 stale 파일은 능동적으로 지운다(순수 표시용
  // 캐시라 삭제해도 실제 리밸런싱 판단엔 영향 없음, 위 헤더 주석 참고).
  const existing = existsSync(VAULT_PATHS.state.allocation)
    ? readdirSync(VAULT_PATHS.state.allocation).filter((f) => f.endsWith('.md'))
    : [];
  const orphaned = findOrphanedAllocationFiles(existing, expectedFilenames);
  for (const filename of orphaned) {
    console.log(`  🗑️  고아 파일 삭제: ${filename}(현재 목표비중에 없는 계좌×자산군 조합)`);
    if (!DRY_RUN) unlinkSync(join(VAULT_PATHS.state.allocation, filename));
  }

  console.log(`\n✅ 자산분배 스냅샷 ${updated}건 갱신, 고아 파일 ${orphaned.length}건 삭제` + (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
