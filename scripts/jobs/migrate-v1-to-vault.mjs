#!/usr/bin/env node
/**
 * v1(구글시트) → Vault 1회성 마이그레이션 (구현계획서 Phase 7)
 *
 * ⚠️ "가장 위험한 지점"(구현계획서 원문) — 개인 재무 이력 전체를 다룬다. 반드시
 * --dry-run으로 먼저 건수를 확인하고, scripts/jobs/reconcile-v1-vault-migration.mjs로
 * 계좌별 보유수량·평가액 합계가 v1과 정확히 일치하는지 확인한 뒤에만 실제로 실행한다.
 *
 * docs/ARCHITECTURE-V2.md "v1 → v2 마이그레이션 계획" 매핑표(확정) 그대로: 체결·배당·
 * 수익금·일별스냅샷 → Facts/Ledger, 보유종목 → State/Holdings, 자산분배 → State/Allocation,
 * 리스크기준선 → State/Baselines, 종목투자노트 → Decisions/Evaluations, 포지션저널 →
 * Decisions/PositionJournal, 리스크모니터 → Decisions/RiskMonitor, 주문제안 →
 * Decisions/Proposals(원본 필드 그대로 아카이브, legacy:true), 주간리포트 →
 * Knowledge/Reports, 성향관찰 → Knowledge/Profile. "평가요청"·"실시간시세"는 그 순간의
 * 파생 작업큐/시세라 이관 대상 아님(오너 확정, 2026-08-05).
 *
 * 멱등: 이벤트 로그류는 시트 행번호 기반 파일명(r{n})이라 재실행해도 같은 파일 →
 * existsSync로 스킵. 현재값류(보유종목·자산분배·기준선)는 매번 덮어쓰기(State 원칙).
 *
 * 사용법:
 *   node scripts/jobs/migrate-v1-to-vault.mjs            # 실제로 Vault에 씀
 *   node scripts/jobs/migrate-v1-to-vault.mjs --dry-run   # 건수만 미리보기(쓰기 없음)
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getToken, getRange } from '../lib/sheets-common.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { DEFAULT_ACCOUNTS } from '../../src/lib/constants.js';
import { parseNum } from '../../src/lib/textFormat.js';
import {
  buildMigratedExecutionRecord, buildMigratedDividendRecord, buildMigratedProfitRecord,
  buildMigratedDailySnapshotRecord, buildMigratedHoldingRecord, buildMigratedAllocationRecord,
  buildMigratedBaselineRecord, buildMigratedEvaluationRecord, buildMigratedPositionJournalRecord,
  buildMigratedRiskMonitorRecord, buildMigratedProposalRecord, buildMigratedReportRecord,
  buildMigratedPreferenceRecord,
} from '../lib/migration-vault-writer.mjs';

const args = process.argv.slice(2);
const explicitToken = args.find((a) => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');

const ACCOUNT_KEYS = ['ISA', '위탁', '연금저축', 'IRP'];
const REBAL_RANGES = { 위탁: '자산분배!B3:D9', 연금저축: '자산분배!B12:D18', ISA: '자산분배!B21:D21', IRP: '자산분배!B24:D24' };

const counts = {};
function bump(k, n = 1) { counts[k] = (counts[k] ?? 0) + n; }

// 이벤트로그류 공통 처리: rows를 순회하며 builder(row, rowNum) 결과를 dedup 스킵 후 기록.
function writeEventLog(rows, builder, label) {
  let written = 0, skipped = 0;
  rows.forEach((row, i) => {
    const rowNum = i + 2; // A2 기준 시트 행번호
    if (!row?.some((c) => String(c ?? '').trim())) return; // 완전 빈 행 스킵
    const { filename, content, dir } = builder(row, rowNum);
    const filepath = join(dir, filename);
    if (existsSync(filepath)) { skipped++; return; }
    if (!DRY_RUN) { mkdirSync(dir, { recursive: true }); writeAtomic(filepath, content); }
    written++;
  });
  console.log(`  ${label}: +${written} (스킵 ${skipped})`);
  bump(label, written);
}

async function main() {
  console.log('🗂️  v1 → Vault 마이그레이션' + (DRY_RUN ? ' (--dry-run, 쓰기 없음)' : ''));
  let token = explicitToken?.trim() || null;
  token = await getToken(token);

  // ── Facts/Ledger 4종 ──────────────────────────────────────────────────────
  console.log('\n[Facts/Ledger]');
  writeEventLog(await getRange(token, '체결내역!A2:M'), buildMigratedExecutionRecord, '체결내역');
  writeEventLog(await getRange(token, '배당금!A2:C'), buildMigratedDividendRecord, '배당금');
  writeEventLog(await getRange(token, '수익금!A2:F'), buildMigratedProfitRecord, '수익금');
  writeEventLog(await getRange(token, '일별스냅샷!A2:E'), buildMigratedDailySnapshotRecord, '일별스냅샷');

  // ── State/Holdings — 계좌별 보유종목(현재값, ISA/위탁/연금저축/IRP!A2:I) ────
  console.log('\n[State/Holdings]');
  let holdingsWritten = 0;
  for (const acctKey of ACCOUNT_KEYS) {
    const rows = await getRange(token, `${acctKey}!A2:I`);
    let lastType = '';
    rows.forEach((r, i) => {
      const rowNum = i + 2;
      // 자산군(A열)은 병합 셀이라 종목명 없는 행에도 값이 있을 수 있다 — 이름으로 스킵하기
      // 전에 먼저 lastType을 갱신해야 한다(readHoldings, sheets-api.mjs와 동일 순서로
      // 맞춤 — 코드리뷰 지적, 2026-08-05. 순서가 바뀌면 그 행이 스킵되면서 자산군 갱신도
      // 같이 스킵돼, 다음 종목이 엉뚱한 이전 자산군으로 잘못 표시될 수 있음).
      const type = String(r[0] ?? '').trim();
      if (type) lastType = type;
      if (!r[1]) return;
      const nmTrim = String(r[1] ?? '').trim();
      const holding = {
        account: acctKey, type: lastType, name: r[1],
        price: parseNum(r[2]), qty: parseNum(r[3]), invest: parseNum(r[4]),
        currentPrice: parseNum(r[5]), profit: parseNum(r[6]), eval: parseNum(r[7]), rate: parseNum(r[8]),
        isCashLike: nmTrim === '예수금' || nmTrim === '외화 RP' || nmTrim.includes('MMF'),
      };
      const { filename, content, dir } = buildMigratedHoldingRecord(holding, rowNum);
      if (!DRY_RUN) { mkdirSync(dir, { recursive: true }); writeAtomic(join(dir, filename), content); }
      holdingsWritten++;
    });
  }
  console.log(`  보유종목(4계좌 합산): ${holdingsWritten}건(현재값 — 덮어쓰기)`);
  bump('보유종목', holdingsWritten);

  // ── State/Allocation — 계좌별 자산군 목표·현재비중(자산분배 시트, 계좌 리밸 범위) ──
  console.log('\n[State/Allocation]');
  let allocWritten = 0;
  for (const [acctKey, range] of Object.entries(REBAL_RANGES)) {
    const rows = await getRange(token, range);
    const assetNames = DEFAULT_ACCOUNTS[acctKey].assets.map((a) => a.name);
    rows.forEach((r, i) => {
      const assetName = assetNames[i];
      if (!assetName) return; // 위탁리밸 등 범위가 자산군 개수보다 넓게 잡혀있을 가능성 방어
      const { filename, content, dir } = buildMigratedAllocationRecord({
        account: acctKey, assetName, target: parseNum(r[0]), current: parseNum(r[1]), rebalAmt: parseNum(r[2]),
      });
      if (!DRY_RUN) { mkdirSync(dir, { recursive: true }); writeAtomic(join(dir, filename), content); }
      allocWritten++;
    });
  }
  console.log(`  자산분배(4계좌 합산): ${allocWritten}건(현재값 — 덮어쓰기)`);
  bump('자산분배', allocWritten);

  // ── State/Baselines — 실제 11열(K열까지, PBR 포함) — SHEET_RANGES의 10열(J까지)이 아님 ──
  console.log('\n[State/Baselines]');
  const baselineRows = await getRange(token, '리스크기준선!A2:K');
  let baselineWritten = 0;
  for (const r of baselineRows) {
    if (!r[0]) continue;
    const { filename, content, dir } = buildMigratedBaselineRecord(r);
    if (!DRY_RUN) { mkdirSync(dir, { recursive: true }); writeAtomic(join(dir, filename), content); }
    baselineWritten++;
  }
  console.log(`  리스크기준선: ${baselineWritten}건(현재값 — 덮어쓰기)`);
  bump('리스크기준선', baselineWritten);

  // ── Decisions 4종 ─────────────────────────────────────────────────────────
  console.log('\n[Decisions]');
  writeEventLog(await getRange(token, '종목투자노트!A2:U'), buildMigratedEvaluationRecord, '종목투자노트');
  writeEventLog(await getRange(token, '포지션저널!A2:P'), buildMigratedPositionJournalRecord, '포지션저널');
  writeEventLog(await getRange(token, '리스크모니터!A2:H'), buildMigratedRiskMonitorRecord, '리스크모니터');
  writeEventLog(await getRange(token, '주문제안!A2:N'), buildMigratedProposalRecord, '주문제안(아카이브)');

  // ── Knowledge 2종 ─────────────────────────────────────────────────────────
  console.log('\n[Knowledge]');
  writeEventLog(await getRange(token, '주간리포트!A2:C'), buildMigratedReportRecord, '주간리포트');
  writeEventLog(await getRange(token, '성향관찰!A2:H'), buildMigratedPreferenceRecord, '성향관찰');

  console.log('\n📊 요약:', JSON.stringify(counts, null, 2));
  console.log(DRY_RUN
    ? '\n(드라이런 — 실제 Vault 쓰기 없음. 검토 후 --dry-run 없이 재실행하면 실제 반영됩니다.)'
    : '\n✅ 마이그레이션 완료 — 이제 reconcile-v1-vault-migration.mjs로 대조 검증하세요.');
}

main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
