#!/usr/bin/env node
/**
 * State/Allocation 실시간 갱신 — 2026-08-21 페이지별 Vault 감사에서 발견한 공백 수정.
 *
 * 대시보드 "자산분배" 탭이 8/13(Phase 7) 마이그레이션 스냅샷에 멈춘 채 그 이후로
 * 한 번도 안 갱신되고 있었다(16개 파일 전부 legacy:true). 이 잡이 State/Holdings를
 * 읽어 계좌별 실제 목표대비현재 비중을 계산해 덮어쓴다.
 *
 * ⚠️ Athena의 실제 리밸런싱 판단(rebalance-facts.mjs → rebalance-gap.mjs
 * computeRebalanceGaps)은 이 파일을 안 읽는다 — 위탁+연금저축 "합산 풀" 기준으로
 * 매번 새로 계산해서 그 자체로 항상 정확하다. 이 잡은 순수하게 대시보드 표시용
 * (계좌별 관점, scripts/lib/allocation-snapshot.mjs 주석 참고) — 실패해도 실제
 * 리밸런싱 판단엔 영향 없음.
 *
 * 사용법: node scripts/jobs/update-allocation-from-holdings.mjs [--dry-run]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { computeAccountAllocationSnapshot } from '../lib/allocation-snapshot.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const ACCOUNTS = ['위탁', '연금저축', 'ISA', 'IRP'];

function readHoldings() {
  const dir = VAULT_PATHS.state.holdings;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

function main() {
  const holdings = readHoldings();
  if (!holdings.length) { console.log('⚠️ State/Holdings가 비어있음 — 갱신 건너뜀(추정 안 함)'); return; }

  let updated = 0;
  for (const account of ACCOUNTS) {
    const rows = computeAccountAllocationSnapshot(holdings, account);
    for (const row of rows) {
      const filename = `${account}-${row.assetName}.md`;
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
  console.log(`\n✅ 자산분배 스냅샷 ${updated}건 갱신` + (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''));
}

main();
