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
import { lintVault } from '../lib/vault-registry.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';

const SENDER_AGENT = 'clio'; // 볼트 등록부 위반 알림(D48 ③) — 볼트·성향 담당

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

// 등록부 lint 결과를 알림 본문으로(순수). 위반이 없으면 null(알리지 않음).
export function buildLintNotice({ checked, results }, maxItems = 10) {
  if (!results.length) return null;
  const lines = results.slice(0, maxItems).map(({ rel, problems }) => `- ${rel}: ${problems.join(' / ')}`);
  const more = results.length > maxItems ? [`- 외 ${results.length - maxItems}개(전체: node scripts/tools/vault-registry-lint.mjs --list)`] : [];
  return [`<b>볼트 등록부 위반 ${results.length}개</b> (검사 ${checked}개)`, '', '■ 위반 노트', ...lines, ...more, '',
    '■ 할 일', `- 경로 등록부(${VAULT_REL.registryFile})에 맞게 type·경로·제목·필수 머리말을 고친다.`].join('\n');
}

function git(args) {
  return execFileSync('git', args, { cwd: VAULT_PATHS.root, encoding: 'utf8' });
}

async function main() {
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
    await notifyRegistryLint();
    return;
  }
  const dateStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
  git(['commit', '-m', `snapshot ${dateStr}`, '--quiet']);
  const changedLines = status.trim().split('\n').length;
  console.log(`✅ 스냅샷 커밋 완료 — snapshot ${dateStr} (변경 ${changedLines}건)`);
  await notifyRegistryLint();
}

async function notifyRegistryLint() {
  // 등록부 lint(D48 ③) — AI 쓰기는 훅이 막지만, 폰·옵시디언·코드가 쓴 노트의 어긋남을 매일 잡는다.
  // lint·알림 실패가 백업을 막으면 안 되므로 오류는 알리고 백업은 이미 끝난 뒤에 돈다(알림 지연이 백업을 늦추지 않게).
  try {
    const notice = buildLintNotice(lintVault(VAULT_PATHS.root));
    console.log(notice ? `🔎 등록부 위반 있음 — 클리오 알림` : '🔎 등록부 위반 없음');
    if (notice) await sendAgentMessage({ agent: SENDER_AGENT, kind: '정보', topic: '점검', body: notice });
  } catch (e) {
    console.error('⚠️ 등록부 lint 실패(백업은 이미 끝남):', e);
  }

}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error('❌ 백업 실패:', e); process.exit(1); });
}
