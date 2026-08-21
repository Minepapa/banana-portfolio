#!/usr/bin/env node
/**
 * v1 "월별잔고" 시트 → Facts/Ledger/MonthlyBalances 1회성 이관 (2026-08-21)
 *
 * Phase 7(migrate-v1-to-vault.mjs)이 옮긴 12종 범주엔 이 시트가 없었다 — 원래 v1→v2
 * 감사에서 새로 발견된 gap. 오너 확정(2026-08-21): 일별/월별 스냅샷을 계속 쌓는 신규
 * 자동 잡은 만들지 않는다(v1 daily-snapshot.mjs는 그래서 CLEANUP 대상으로 삭제됨) —
 * 대신 v1이 이미 손으로 채워온 월별잔고 이력을 그대로 가져와 홈 화면 막대그래프에 쓴다.
 * 그래서 이 잡은 Phase 7의 다른 이벤트로그류와 달리 앞으로도 재실행해서 새 달을 계속
 * 채우는 용도가 아니다 — 필요하면 나중에 수동으로 다시 돌려 새로 채워진 v1 시트 행을
 * 마저 가져오면 된다(멱등이라 안전).
 *
 * 시트 레이아웃(A~J): 연도 · 월 · 그달신규입금 · ISA · 위탁 · 연금저축 · IRP · 총잔고 ·
 * KOSPI월말지수 · S&P500월말지수. 미래 개월(총잔고 미기입)은 v1 시트에 연도·월만 미리
 * 채워진 빈 placeholder 행으로 남아있어 총잔고 없는 행은 건너뛴다(kpi-calc.mjs의
 * parseMonthlyBalance와 동일 판정 기준).
 *
 * 사용법:
 *   node scripts/jobs/migrate-monthly-balance.mjs            # 실제로 Vault에 씀
 *   node scripts/jobs/migrate-monthly-balance.mjs --dry-run  # 건수만 미리보기(쓰기 없음)
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getToken, getRange } from '../lib/sheets-common.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseNum } from '../../src/lib/textFormat.js';
import { buildMigratedMonthlyBalanceRecord } from '../lib/migration-vault-writer.mjs';

const args = process.argv.slice(2);
const explicitToken = args.find((a) => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');

async function main() {
  console.log('🗂️  v1 월별잔고 → Vault 이관' + (DRY_RUN ? ' (--dry-run, 쓰기 없음)' : ''));
  let token = explicitToken?.trim() || null;
  token = await getToken(token);

  const rows = await getRange(token, '월별잔고!A2:J');
  let written = 0, skipped = 0, futureSkipped = 0;
  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const year = parseNum(row?.[0]);
    const month = parseNum(row?.[1]);
    const total = parseNum(row?.[7]);
    if (!year || !month || !total) { futureSkipped++; return; } // 아직 안 채워진 미래 개월
    const { filename, content, dir } = buildMigratedMonthlyBalanceRecord(row, rowNum);
    const filepath = join(dir, filename);
    if (existsSync(filepath)) { skipped++; return; }
    console.log(`  + ${filename} — 총잔고 ₩${total.toLocaleString()}`);
    if (!DRY_RUN) { mkdirSync(dir, { recursive: true }); writeAtomic(filepath, content); }
    written++;
  });

  console.log(`\n✅ 완료 — 신규 ${written} · 이미 있음(스킵) ${skipped} · 미기록 개월(건너뜀) ${futureSkipped}` + (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''));
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
