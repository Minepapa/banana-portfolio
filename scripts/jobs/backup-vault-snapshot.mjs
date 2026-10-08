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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';
import { buildVaultIndex } from '../lib/vault-index-builder.mjs';

// 루트 파일 사본(이관 4-7): ~/Pantheon의 CLAUDE.md·.claude/settings.json은 어떤 git에도 속하지 않는다.
// 볼트 안으로 복사해 볼트 git 이력과 암호화 외부 백업에 함께 태운다. 확장자를 .txt로 바꿔
// 볼트 안에 CLAUDE.md라는 이름이 생기지 않게 한다(그 폴더를 다루는 세션이 지침으로 읽는 것 방지).
export const ROOT_FILES = [['CLAUDE.md', 'CLAUDE.md.txt'], [join('.claude', 'settings.json'), 'claude-settings.json.txt']];

export function copyRootFiles(rootDir, destDir) {
  const copied = [];
  for (const [src, dest] of ROOT_FILES) {
    const from = join(rootDir, src);
    if (!existsSync(from)) continue;
    const content = readFileSync(from, 'utf8');
    const to = join(destDir, dest);
    if (existsSync(to) && readFileSync(to, 'utf8') === content) continue;
    mkdirSync(destDir, { recursive: true });
    writeFileSync(to, content);
    copied.push(dest);
  }
  return copied;
}

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

  try {
    const copied = copyRootFiles(dirname(VAULT_PATHS.root), vaultAbs(VAULT_REL.rootFilesBackup));
    if (copied.length) console.log(`📄 루트 파일 사본 갱신: ${copied.join(', ')}`);
  } catch (e) {
    console.error(`⚠️ 루트 파일 사본 실패(백업은 계속): ${e.message}`);
  }

  // 색인 자동 생성(이관 3-5) — 커밋 직전에 갱신해 같은 스냅샷에 담는다. 색인 실패가 백업을 막으면
  // 안 되므로 오류는 알리고 백업은 계속한다(백업이 색인보다 중요).
  try {
    const changed = buildVaultIndex(VAULT_PATHS.root);
    console.log(changed.length ? `🗂 색인 갱신 ${changed.length}개` : '🗂 색인 변경 없음');
  } catch (e) {
    console.error(`⚠️ 색인 자동 생성 실패(백업은 계속): ${e.message}`);
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
