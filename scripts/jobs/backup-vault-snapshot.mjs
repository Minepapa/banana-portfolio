#!/usr/bin/env node
/**
 * Vault 야간 백업 스냅샷 (v2) — docs/ARCHITECTURE-V2.md "백업 — 매일 밤 비공개 git
 * 스냅샷" 절.
 *
 * Google Drive 동기화는 복제일 뿐 백업이 아니다(삭제·손상이 그대로 전파됨). Vault
 * 폴더 자체를 별도의 로컬 전용 git 리포지토리로 만들어(banana-portfolio-v2 코드
 * 리포와 완전히 무관) 매일 밤 커밋한다 — git이 버전별 diff·복구 지점을 무료로 제공.
 * 원격 push는 하지 않는다(로컬 히스토리만으로 이미 "삭제·손상 즉시 전파" 문제는
 * 해결됨 — 원격 저장은 별도 결정 사항, 지금 범위 아님).
 *
 * 사용법: node scripts/jobs/backup-vault-snapshot.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

function git(args) {
  return execFileSync('git', args, { cwd: VAULT_PATHS.root, encoding: 'utf8' });
}

function main() {
  if (!existsSync(VAULT_PATHS.root)) {
    console.error(`❌ Vault 경로가 없습니다: ${VAULT_PATHS.root}`);
    process.exit(1);
  }
  if (!existsSync(`${VAULT_PATHS.root}/.git`)) {
    console.error(`❌ ${VAULT_PATHS.root}가 아직 git 리포지토리가 아닙니다 — 먼저 초기화 필요(1회성, "git init" 참고)`);
    process.exit(1);
  }

  git(['add', '-A']);
  const status = git(['status', '--porcelain']);
  if (!status.trim()) {
    console.log('✅ 변경 없음 — 스냅샷 스킵');
    return;
  }
  const dateStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
  git(['commit', '-m', `snapshot ${dateStr}`, '--quiet']);
  const changedLines = status.trim().split('\n').length;
  console.log(`✅ 스냅샷 커밋 완료 — snapshot ${dateStr} (변경 ${changedLines}건)`);
}

main();
