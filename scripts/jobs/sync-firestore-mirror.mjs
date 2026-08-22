#!/usr/bin/env node
/**
 * Vault(Facts/State/Decisions) → Firestore mirror/* 8종 문서 동기화 (v2, Phase 6)
 *
 * 문서 스키마 자체는 scripts/lib/firestore-mirror.mjs(순수함수)가 정의한다 — 이
 * 파일은 Vault를 읽어 그 함수들에 넣고 firebase-admin으로 쓰는 I/O 글루만 담당
 * (parse-notifications-to-vault.mjs와 같은 역할 분담).
 *
 * ⚠️ 범위(2026-08-05, Phase 6): State/Allocation은 아직 자산분배 트랙 목표비중 갱신
 * 주체가 없어(legacy 마이그레이션 스냅샷만 있음) allocation 미러는 그 한계 그대로
 * 반영한다. State/Holdings·Facts/Ledger(체결·배당)는 Phase 8·2에서 이미 실제로
 * 기록되므로 holdings·trades·dividends 미러는 진짜 데이터로 채워진다.
 * Knowledge/Reports도 2026-08-20 weekly-report.mjs v2 재작성 이후 실제로 쌓여
 * latestReport가 최신 리포트를 반영한다(그 전까진 디렉토리가 비어있어 빈 값이었음).
 *
 * 인증: Firebase Admin SDK 서비스계정 키(~/.config/banana-portfolio-v2/
 * firebase-adminsdk-key.json, 2026-08-05 Firebase 콘솔에서 발급) — sa-key.json과
 * 같은 관례(SA_KEY_FILE 환경변수 오버라이드 패턴)를 그대로 따른다.
 *
 * 사용법:
 *   node scripts/jobs/sync-firestore-mirror.mjs            # 실제로 Firestore에 씀
 *   node scripts/jobs/sync-firestore-mirror.mjs --dry-run   # 빌드 결과만 출력
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { buildAllMirrors } from '../lib/firestore-mirror.mjs';
import { getFirestoreAdmin, FIREBASE_ADMIN_KEY_FILE } from '../lib/firestore-admin.mjs';

export { FIREBASE_ADMIN_KEY_FILE };

const DRY_RUN = process.argv.includes('--dry-run');

// dir 안의 모든 .md 파일 frontmatter를 파싱해 배열로 반환 — 디렉토리가 아직 없으면 빈 배열
// (Phase 8·9 전이라 State/Holdings·Allocation은 실제로 비어있을 수 있음, 정상 상태).
export function readVaultRecords(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

// Knowledge/Reports 중 가장 최신(파일명 YYYY-MM-DD.md) 리포트를 ReportTab.jsx가 기대하는
// {date, headline, summary, body} 형태로 반환. 2026-08-20 weekly-report.mjs v2 재작성
// 전까진 이 디렉토리가 항상 비어있어 latestReport 미러가 늘 빈 값이었다(원래 알려진 공백,
// sync-firestore-mirror.mjs 헤더 주석 참고) — 이제 실제 리포트가 쌓이므로 배선한다.
export function readLatestReport(dir = VAULT_PATHS.knowledge.reports) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse();
  if (!files.length) return null;
  const content = readFileSync(join(dir, files[0]), 'utf8');
  const fm = parseFrontmatter(content);
  const m = content.match(/^---\n[\s\S]*?\n---\n?/);
  const body = m ? content.slice(m[0].length).replace(/^\n+/, '') : content;
  return { date: fm.date || files[0].slice(0, 10), headline: fm.headline || '', summary: fm.summary || '', body };
}

export function collectMirrorInput({ now = new Date() } = {}) {
  const executionEvents = readVaultRecords(VAULT_PATHS.facts.ledger.executions);
  const dividendEvents = readVaultRecords(VAULT_PATHS.facts.ledger.dividends);
  // ⚠️ 버그 수정(2026-08-21 — 수익금 탭이 항상 빈 화면이던 원인) — buildProfitsMirror는
  // 처음부터 있었는데 이 잡이 profitEvents를 한 번도 안 넘겨서 늘 빈 배열로 빌드되고
  // 있었다. Facts/Ledger/Profits는 실제로 25건 존재(Phase 7 마이그레이션, 정확한
  // 매입가 대비 실현손익 기록) — 이제 연결.
  const profitEvents = readVaultRecords(VAULT_PATHS.facts.ledger.profits);
  const proposals = readVaultRecords(VAULT_PATHS.decisions.proposals);
  const pendingProposalCount = proposals.filter((p) => p.status === '대기').length;
  // State/Holdings·Allocation: Phase 8·9 전이라 실제 항목이 없을 수 있음 — 있으면
  // 그대로 반영(부서 로직이 생기면 이 잡은 코드 변경 없이 자동으로 진짜 값을 미러링).
  const holdings = readVaultRecords(VAULT_PATHS.state.holdings);
  const accounts = readVaultRecords(VAULT_PATHS.state.allocation);
  const report = readLatestReport();
  // 2026-08-21 추가(과거분은 migrate-monthly-balance.mjs 1회성 이관) — 2026-08-22부터
  // update-monthly-balance-snapshot.mjs가 이번 달분을 매일 갱신.
  const monthlyBalances = readVaultRecords(VAULT_PATHS.facts.ledger.monthlyBalances);
  return { executionEvents, dividendEvents, profitEvents, pendingProposalCount, holdings, accounts, report, monthlyBalances, now };
}

async function main() {
  const input = collectMirrorInput();
  const mirrors = buildAllMirrors(input);

  console.log(
    `📊 미러 빌드 — trades ${mirrors.trades.items.length}건 · dividends ${mirrors.dividends.items.length}건 · ` +
    `profits ${mirrors.profits.items.length}건 · holdings ${mirrors.holdings.items.length}건 · ` +
    `monthlyBalances ${mirrors.monthlyBalances.items.length}개월 · ` +
    `pendingProposal ${mirrors.home.pendingProposalCount}건`,
  );
  if (mirrors.holdings.items.length === 0) {
    console.log('  ⚠️ holdings·allocation·home 손익은 State/Holdings가 아직 없어 빈 값(Phase 8·9 이후 채워짐) — 정상.');
  }

  if (DRY_RUN) {
    console.log('\n(드라이런 — Firestore 쓰기 없음)');
    return;
  }

  const db = getFirestoreAdmin();

  for (const [docId, data] of Object.entries(mirrors)) {
    await db.collection('mirror').doc(docId).set(data);
    console.log(`  ✓ mirror/${docId} 씀`);
  }

  console.log('\n✅ Firestore 미러 동기화 완료');
}

// 직접 실행될 때만 main()을 돈다(health-watcher.mjs와 동일 관례) — collectMirrorInput을
// 테스트에서 import할 때 실제 Firestore 쓰기가 시도되는 사고를 막는다.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
}
