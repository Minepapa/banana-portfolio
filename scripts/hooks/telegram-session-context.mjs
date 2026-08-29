#!/usr/bin/env node
/**
 * SessionStart 훅 — 텔레그램 상시세션이 재시작될 때, telegram-session-handoff.mjs가
 * 전날 03:55에 남긴 인수인계 노트를 새 세션 컨텍스트에 조용히 주입한다(2026-08-29,
 * 오너 지시 "가상세션 기록은 므네모시네로 흡수하자... 재시작 시 이전 어떤 기록을
 * 읽어왔다고 메모 남겨줘").
 *
 * ⚠️ CLAUDE_TELEGRAM_SESSION 가드 — 이 훅은 `.claude/settings.json`에 등록돼 이
 * 프로젝트 cwd로 뜨는 **모든** Claude Code 세션(오너의 인터랙티브 터미널 세션 포함)
 * 에서 실행된다. `com.banana2.telegram-session.plist`가 이 env var를 세팅해서
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
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';

// 순수함수(테스트 가능) — Log/TelegramSession/*.md 파일명(YYYY-MM-DD.md) 중 가장
// 최신 날짜를 고른다. 파일명 자체가 날짜라 문자열 정렬이 곧 날짜순 정렬(mtime보다
// 신뢰성 있음 — git 체크아웃·백업 복원 등으로 mtime이 뒤틀려도 파일명은 안 바뀜).
export function findLatestHandoffFilename(filenames) {
  const dated = filenames.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
  if (!dated.length) return null;
  return dated.sort().at(-1);
}

// 순수함수 — last-read 마커 State 파일 내용.
export function buildLastReadMarker({ filename, readAt }) {
  return buildFrontmatter({ type: 'telegram-session-last-read', filename, readAt });
}

function main() {
  if (!process.env.CLAUDE_TELEGRAM_SESSION) { process.exit(0); }

  const dir = VAULT_PATHS.log.telegramSession;
  const filenames = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  const latest = findLatestHandoffFilename(filenames);
  if (!latest) { process.exit(0); }

  const filepath = join(dir, latest);
  let content;
  try {
    content = readFileSync(filepath, 'utf8');
  } catch {
    process.exit(0);
  }

  const now = new Date().toISOString();
  try {
    mkdirSync(join(VAULT_PATHS.root, 'State', 'TelegramSession'), { recursive: true });
    writeAtomic(VAULT_PATHS.state.telegramSessionLastRead, buildLastReadMarker({ filename: latest, readAt: now }));
  } catch {
    // 마커 기록 실패해도 컨텍스트 주입 자체는 계속 — 부가 기능이 본 기능을 막으면 안 됨.
  }

  const additionalContext = `[므네모시네 인수인계] 전날 텔레그램 세션 요약(${latest})을 자동으로 읽었다 — ` +
    `아래 내용을 참고해 오늘 대화를 이어가되, 오너가 먼저 묻지 않는 한 이 내용을 그대로 텔레그램에 ` +
    `요약해서 보내지는 마라(불필요한 알림 방지).\n\n${content}`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
  }) + '\n');
  process.exit(0);
}

main();
