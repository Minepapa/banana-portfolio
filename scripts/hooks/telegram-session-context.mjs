#!/usr/bin/env node
/**
 * SessionStart 훅 — 텔레그램 상시세션이 재시작될 때, telegram-session-handoff.mjs가
 * 전날 03:55에 남긴 인수인계 노트를 새 세션 컨텍스트에 조용히 주입한다(2026-08-29,
 * 오너 지시 "가상세션 기록은 므네모시네로 흡수하자... 재시작 시 이전 어떤 기록을
 * 읽어왔다고 메모 남겨줘").
 *
 * ⚠️ CLAUDE_TELEGRAM_SESSION 가드 — 이 훅은 저장소와 Pantheon 루트의
 * `.claude/settings.json`에 등록돼 각 작업 폴더의 **모든** Claude Code 세션에서
 * 실행된다. `com.banana2.telegram-session.plist`가 이 env var를 세팅해서
 * 띄우는 세션에서만 실제 동작하고, 그 외(내 터미널 세션 등)에서는 조용히 스킵한다
 * — handoff-load 훅을 텔레그램 세션에서 스킵시켰던 것과 정반대 방향의 같은 패턴.
 *
 * ⚠️ systemMessage를 의도적으로 안 씀 — handoff-load 훅이 systemMessage로 텔레그램에
 * 배너를 누출시켰던 사고(2026-08-29 발견·수정)를 여기서 재현하지 않기 위해서다. 이
 * 훅은 additionalContext(모델 컨텍스트에만 조용히 주입)만 쓰고, "무엇을 읽었다"는
 * 기록은 오너에게 텔레그램으로 말 거는 대신 State/TelegramSession/last-read.md에
 * 메모로만 남긴다(오너가 원하는 시점에 직접 확인 가능, 매일 아침 알림 스팸 아님).
 *
 * 사용법(Claude Code SessionStart 훅 계약): stdin으로 JSON 받음(안 씀), stdout에
 * JSON({hookSpecificOutput:{hookEventName,additionalContext}}) 방출. 항상 exit 0.
 */
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL, vaultAbs, vaultYearFiles } from '../lib/vault-paths.mjs';
import { buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';

// 순수함수(테스트 가능) — 날짜만 있는 옛 파일명과 주제가 붙은 새 파일명 중
// 최신 날짜를 고른다. 같은 날짜라면 새 제목을 우선한다(mtime은 백업 복원 때 변함).
export function findLatestHandoffFilename(filenames) {
  const dated = filenames.filter((f) => /^\d{4}-\d{2}-\d{2}(?: 텔레그램 세션 인수인계)?\.md$/.test(f));
  if (!dated.length) return null;
  return dated.sort((a, b) => a.slice(0, 10).localeCompare(b.slice(0, 10))
    || Number(a.includes(' 텔레그램')) - Number(b.includes(' 텔레그램'))).at(-1);
}

// 순수함수 — 세션에 주입할 컨텍스트. 입력 규칙 표(텔레그램 입력 형식 정본)는 인수인계 유무와 무관하게 항상 넣는다
// (2026-10-10 오너 지시: 텔레그램 입력 규칙이 흩어져 누락되지 않게 — 채널 문서를 "읽으라"는 지시만으로는 보장되지 않는다).
export function buildSessionContext({ inputRules = null, handoff = null, handoffName = null }) {
  const parts = [];
  if (inputRules) {
    const rulesDoc = VAULT_REL.telegramInputRulesFile.replace(/\.md$/, '');
    const sessionDoc = VAULT_REL.telegramChannelFile.replace(/\.md$/, '');
    parts.push(`[텔레그램 입력 규칙] 오너 메시지는 아래 문서(${rulesDoc})의 1절 처리 순서대로 대조하고 4절 세부 절차대로 처리한다. `
      + `세션 자체의 규칙(구현 금지·재시작·답장 형식)은 ${sessionDoc}에 있다.\n\n` + inputRules.replace(/^---\n[\s\S]*?\n---\n/, '').trim());
  }
  if (handoff) {
    parts.push(`[므네모시네 인수인계] 전날 텔레그램 세션 요약(${handoffName})을 자동으로 읽었다 — `
      + '아래 내용을 참고해 오늘 대화를 이어가되, 오너가 먼저 묻지 않는 한 이 내용을 그대로 텔레그램에 '
      + `요약해서 보내지는 마라(불필요한 알림 방지).\n\n${handoff}`);
  }
  return parts.join('\n\n---\n\n');
}

// 순수함수 — last-read 마커 State 파일 내용.
export function buildLastReadMarker({ filename, readAt }) {
  return buildFrontmatter({ type: 'telegram-session-last-read', filename, readAt });
}

function main() {
  if (!process.env.CLAUDE_TELEGRAM_SESSION) { process.exit(0); }

  let inputRules = null;
  try { inputRules = readFileSync(vaultAbs(VAULT_REL.telegramInputRulesFile), 'utf8'); } catch { /* 없으면 인수인계만 */ }

  const files = vaultYearFiles(VAULT_PATHS.log.telegramSession);
  const latest = findLatestHandoffFilename(files.map((file) => file.split('/').at(-1)));
  let content = null;
  if (latest) {
    try { content = readFileSync(files.find((file) => file.endsWith(`/${latest}`)), 'utf8'); } catch { content = null; }
  }
  if (!inputRules && !content) { process.exit(0); }

  if (content) {
    try {
      mkdirSync(vaultAbs(VAULT_REL.stateTelegramSession), { recursive: true });
      writeAtomic(VAULT_PATHS.state.telegramSessionLastRead, buildLastReadMarker({ filename: latest, readAt: new Date().toISOString() }));
    } catch {
      // 마커 기록 실패해도 컨텍스트 주입 자체는 계속 — 부가 기능이 본 기능을 막으면 안 됨.
    }
  }

  const additionalContext = buildSessionContext({ inputRules, handoff: content, handoffName: latest });

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
  }) + '\n');
  process.exit(0);
}

// 직접 실행될 때만 main() — import(테스트)될 때 process.exit로 테스트 프로세스를 끝내지 않게(2026-10-10 발견:
// 이전엔 import 즉시 exit(0)해서 이 파일의 테스트가 한 번도 실행되지 않았다). 훅 명령 경로가 임시 바로가기
// (~/Stockproject/…)를 거칠 수 있어 realpath로 비교한다.
const invokedPath = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return null; } })();
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) main();
