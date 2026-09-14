#!/usr/bin/env node
/**
 * PostToolUse 훅 — 므네모시네 `Log/Implementation/*.md` 파일을 쓰거나 고칠 때마다
 * `progress:` frontmatter 필드가 정해진 4종 값(완료/진행중/보류/폐기) 중 하나인지
 * 그 자리에서 검사한다(2026-09-14, 오너 지시 — "구조적으로 기록 누락을 막자").
 *
 * ⚠️ 왜 필요한가 — Knowledge/Meta/Index.md가 스스로 "새 문서엔 progress: 반드시
 * 채운다"고 못박아 뒀는데도(2026-09-01 확정 규칙), 2026-09-13 므네모시네 정합성
 * 점검에서 실측한 결과 92개 Implementation 문서 중 **9개**가 필드 자체 결측이거나
 * ("부분완료"·"완료(코드) — ..." 같은) 자유서술 변형이었다 — "새 문서 쓸 때 채운다"는
 * 규칙을 세션이 매번 기억하는 방식은 이미 최소 9회 실패가 증명됐다(이 프로젝트의
 * 다른 영역(EXPECTED_INTERVALS_MS 등)에서 반복돼온 것과 같은 패턴). 이 훅은
 * "쓰는 순간" 바로 잡아 몇 주 뒤 정기점검에서야 발견되는 지연을 없앤다 — Facts/
 * State 폴더가 코드로 매번 새로 쓰여 항상 최신인 것과 같은 원리를, 사람이 쓰는
 * 문서에도 구조적으로 적용하는 것(2단계 방어선의 1단계 — 2단계는 weekly-vault-
 * health-check.mjs의 백스톱 스윕).
 *
 * 계약(Claude Code PostToolUse 훅) — stdin JSON({session_id, cwd, tool_name,
 * tool_input:{file_path,...}, ...}), stdout JSON({continue:true,
 * hookSpecificOutput:{hookEventName:'PostToolUse', additionalContext:'...'}}
 * 또는 {continue:true, suppressOutput:true}). oh-my-claudecode
 * post-tool-rules-injector.mjs와 동일 계약(이 런타임에 실제로 설치돼 검증된
 * 형태) — 훅 자체가 실패해도 세션을 절대 막지 않는다(항상 continue:true).
 *
 * 이 훅은 파일 경로가 므네모시네(Vault) `Log/Implementation/` 밑의 `.md`일 때만
 * 개입한다 — 그 외 모든 Write/Edit(이 프로젝트 코드 포함)는 그냥 통과.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStdin } from './telegram-reply-guard.mjs';
import { parseFrontmatter, CANONICAL_PROGRESS_VALUES } from '../lib/vault-frontmatter.mjs';
import { VAULT_ROOT } from '../lib/vault-paths.mjs';

export { CANONICAL_PROGRESS_VALUES }; // 이 파일을 직접 import하던 기존 코드/테스트 호환용 재수출

function pass(reason) {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  if (reason && process.env.VAULT_PROGRESS_GUARD_DEBUG) console.error(`vault-progress-guard: pass(${reason})`);
}

function warn(message) {
  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
  }));
}

// 순수함수 — 테스트 가능. relPath: VAULT_ROOT 기준 상대경로("Log/Implementation/x.md" 형태).
export function shouldCheck(relPath) {
  if (!relPath) return false;
  const normalized = relPath.replace(/\\/g, '/');
  return normalized.startsWith('Log/Implementation/') && normalized.endsWith('.md');
}

// 순수함수 — frontmatter 객체를 받아 문제가 있으면 사람이 읽을 경고 문자열을,
// 없으면 null을 반환.
export function checkProgressField(frontmatter, relPath) {
  const value = frontmatter?.progress;
  if (value == null || value === '') {
    return `⚠️ 므네모시네 정합성 — ${relPath}에 progress: 필드가 없습니다. ` +
      `Knowledge/Meta/Index.md 규칙(완료 상태 추적)에 따라 ${CANONICAL_PROGRESS_VALUES.join('/')} 중 하나를 지금 추가하세요.`;
  }
  if (!CANONICAL_PROGRESS_VALUES.includes(value)) {
    return `⚠️ 므네모시네 정합성 — ${relPath}의 progress: "${value}"는 정해진 4종(${CANONICAL_PROGRESS_VALUES.join('/')}) 밖의 자유서술입니다. ` +
      `세부 사정은 status: 필드에 그대로 적고, progress: 자체는 4종 중 하나로 정규화하세요(예: 일부만 끝났으면 "진행중").`;
  }
  return null;
}

async function main() {
  let data;
  try {
    data = JSON.parse(await readStdin(3000));
  } catch { pass('stdin-parse-fail'); return; }

  const toolName = data.tool_name || data.toolName || '';
  if (toolName !== 'Write' && toolName !== 'Edit') { pass('not-write-or-edit'); return; }

  const toolInput = data.tool_input || data.toolInput || {};
  const rawPath = toolInput.file_path || toolInput.path;
  if (!rawPath) { pass('no-file-path'); return; }

  const cwd = data.cwd || process.cwd();
  const filePath = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);

  // VAULT_ROOT 밖이면(이 프로젝트 코드 포함) 대상 아님 — relative()가 '..'로
  // 시작하면 밖에 있다는 뜻.
  const relPath = relative(VAULT_ROOT, filePath);
  if (relPath.startsWith('..') || !shouldCheck(relPath)) { pass('not-in-scope'); return; }

  if (!existsSync(filePath)) { pass('file-missing'); return; } // 삭제 등 — 검사 대상 아님

  let content;
  try { content = readFileSync(filePath, 'utf8'); } catch { pass('read-fail'); return; }

  const frontmatter = parseFrontmatter(content);
  const message = checkProgressField(frontmatter, relPath.replace(/\\/g, '/'));
  if (message) warn(message); else pass('ok');
}

// entrypoint 가드 — 없으면 테스트가 이 파일을 import(shouldCheck·checkProgressField
// 등 순수함수 사용)만 해도 main()이 실행돼 stdin 대기로 멈춘다(telegram-reply-
// guard.mjs와 동일 관례). pathToFileURL 사용 이유도 그 파일 주석과 동일(경로에
// 공백·비ASCII 있으면 수동 file:// 조합이 깨져 훅이 조용히 no-op될 수 있음).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // 훅 자체 예외는 항상 통과(post-tool-rules-injector.mjs와 동일 안전원칙) —
    // 이 훅이 죽어서 세션의 다른 작업을 막으면 안 된다.
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  });
}
