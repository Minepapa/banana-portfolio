#!/usr/bin/env node
/**
 * Vault(Facts/State/Decisions) → Firestore mirror/* 7종 문서 동기화 (v2, Phase 6)
 *
 * 문서 스키마 자체는 scripts/lib/firestore-mirror.mjs(순수함수)가 정의한다 — 이
 * 파일은 Vault를 읽어 그 함수들에 넣고 firebase-admin으로 쓰는 I/O 글루만 담당
 * (parse-notifications-to-vault.mjs와 같은 역할 분담).
 *
 * ⚠️ 범위(2026-08-05, Phase 6): State/Holdings·State/Allocation은 아직 자산분배·
 * 퀀트 트랙 부서 로직(Phase 8·9)이 없어 실제로 채워지지 않는다 — 그래서 holdings·
 * allocation·home 미러는 지금 정직하게 빈 값(0·[])으로 나간다(가짜 숫자를 만들지
 * 않는다). Facts/Ledger(체결·배당)는 Phase 2에서 이미 실제로 기록되므로 trades·
 * dividends 미러는 진짜 데이터로 채워진다. Knowledge/Reports도 아직 없어
 * latestReport는 빈 값.
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
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { buildAllMirrors } from '../lib/firestore-mirror.mjs';

export const FIREBASE_ADMIN_KEY_FILE = process.env.FIREBASE_ADMIN_KEY_FILE
  || `${process.env.HOME}/.config/banana-portfolio-v2/firebase-adminsdk-key.json`;

const DRY_RUN = process.argv.includes('--dry-run');

// dir 안의 모든 .md 파일 frontmatter를 파싱해 배열로 반환 — 디렉토리가 아직 없으면 빈 배열
// (Phase 8·9 전이라 State/Holdings·Allocation은 실제로 비어있을 수 있음, 정상 상태).
export function readVaultRecords(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

export function collectMirrorInput({ now = new Date() } = {}) {
  const executionEvents = readVaultRecords(VAULT_PATHS.facts.ledger.executions);
  const dividendEvents = readVaultRecords(VAULT_PATHS.facts.ledger.dividends);
  const proposals = readVaultRecords(VAULT_PATHS.decisions.proposals);
  const pendingProposalCount = proposals.filter((p) => p.status === '대기').length;
  // State/Holdings·Allocation: Phase 8·9 전이라 실제 항목이 없을 수 있음 — 있으면
  // 그대로 반영(부서 로직이 생기면 이 잡은 코드 변경 없이 자동으로 진짜 값을 미러링).
  const holdings = readVaultRecords(VAULT_PATHS.state.holdings);
  const accounts = readVaultRecords(VAULT_PATHS.state.allocation);
  return { executionEvents, dividendEvents, pendingProposalCount, holdings, accounts, now };
}

async function main() {
  const input = collectMirrorInput();
  const mirrors = buildAllMirrors(input);

  console.log(
    `📊 미러 빌드 — trades ${mirrors.trades.items.length}건 · dividends ${mirrors.dividends.items.length}건 · ` +
    `holdings ${mirrors.holdings.items.length}건 · pendingProposal ${mirrors.home.pendingProposalCount}건`,
  );
  if (mirrors.holdings.items.length === 0) {
    console.log('  ⚠️ holdings·allocation·home 손익은 State/Holdings가 아직 없어 빈 값(Phase 8·9 이후 채워짐) — 정상.');
  }

  if (DRY_RUN) {
    console.log('\n(드라이런 — Firestore 쓰기 없음)');
    return;
  }

  if (!existsSync(FIREBASE_ADMIN_KEY_FILE)) {
    throw new Error(`Firebase Admin 키 파일이 없습니다: ${FIREBASE_ADMIN_KEY_FILE}`);
  }
  const serviceAccount = JSON.parse(readFileSync(FIREBASE_ADMIN_KEY_FILE, 'utf8'));
  const app = initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore(app);

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
