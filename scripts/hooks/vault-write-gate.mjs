#!/usr/bin/env node
/**
 * PreToolUse 훅 — 볼트 쓰기 관문(D48 ②, 2026-10-08). AI 세션이 볼트 노트를 Write/Edit하기 **직전에**
 * 결과 내용을 경로 등록부(`90_Delphi/Schema/경로 등록부`) 규칙으로 검사하고, 어긋나면 막는다.
 *
 * - 검사: type 등록 여부 · type별 경로 · 제목 형식 · 필수 필드(scripts/lib/vault-registry.mjs, lint와 같은 함수).
 * - 범위 밖: 볼트 밖 파일 · .md 아닌 파일 · 80_Archive(보관본) · 95_Etna(코드가 쓰는 기계 데이터) ·
 *   99_Adyton(금고 — 내용을 읽지 않음) · 볼트 루트의 CLAUDE.md·AGENTS.md(헌법).
 * - 등록부를 읽거나 해석하지 못하면 막는다(확신이 없으면 멈춘다). 단 모듈 로드 실패·node 실행 실패·타임아웃은
 *   Claude Code가 비차단 오류로 처리해 통과된다 — 그런 경우와 Bash·Codex 쓰기는 매일 lint(backup-vault)가 안전망이다.
 * - Edit는 현재 파일에 old_string→new_string을 적용한 결과를 검사한다. 적용할 수 없으면(old_string 없음)
 *   도구 자체가 실패할 것이므로 통과시킨다.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdin } from './telegram-reply-guard.mjs';
import { VAULT_ROOT, VAULT_REL } from '../lib/vault-paths.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';

const SKIP_TOP = new Set([VAULT_REL.archiveRoot, VAULT_REL.etnaRoot, VAULT_REL.adytonRoot]);
const ROOT_RULE_FILES = new Set(['CLAUDE.md', 'AGENTS.md']);

// 심볼릭 링크(옛 ~/banana-vault 등)를 풀어 실제 경로로 — 아직 없는 파일은 존재하는 가장 가까운 상위 폴더 기준.
function realPath(p) {
  let dir = p;
  const rest = [];
  while (!existsSync(dir)) {
    rest.unshift(basename(dir));
    const parent = dirname(dir);
    if (parent === dir) return p;
    dir = parent;
  }
  return join(realpathSync.native(dir), ...rest); // native: APFS 대소문자 차이까지 실제 표기로 정규화
}

// 볼트 상대 경로(검사 대상) 또는 null(범위 밖).
export function vaultRelForCheck(filePath, vaultRoot) {
  if (!filePath.toLowerCase().endsWith('.md')) return null;
  const rel = relative(realPath(vaultRoot), realPath(filePath));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (SKIP_TOP.has(rel.split('/')[0]) || ROOT_RULE_FILES.has(rel)) return null;
  if (rel.split('/').some((part) => part.startsWith('.'))) return null;
  return rel;
}

// 도구 입력으로 쓰일 최종 내용. null이면 판단 불가(도구가 스스로 실패할 경우).
export function resultingContent(toolName, toolInput, currentContent) {
  if (toolName === 'Write') return typeof toolInput.content === 'string' ? toolInput.content : null;
  if (toolName !== 'Edit') return null;
  const { old_string: oldStr, new_string: newStr, replace_all: all } = toolInput;
  if (currentContent == null) return oldStr === '' && typeof newStr === 'string' ? newStr : null; // 빈 old_string Edit = 새 파일 생성
  if (typeof oldStr !== 'string' || typeof newStr !== 'string' || !currentContent.includes(oldStr)) return null;
  return all ? currentContent.split(oldStr).join(newStr) : currentContent.replace(oldStr, () => newStr);
}

// 판정(순수) — { block: false } 또는 { block: true, reason }.
// 등록부 자체를 쓸 때는 디스크의 옛 등록부가 아니라 새 내용으로 판정한다 — 깨진 등록부가 들어가면 그 뒤로
// 고치는 쓰기까지 전부 막히므로(리뷰 HIGH), 새 내용이 해석되지 않으면 그 쓰기를 막는다.
export function decideWrite({ relPath, content, registryText }) {
  const isRegistry = relPath === VAULT_REL.registryFile;
  let rules;
  try {
    rules = parseRegistry(isRegistry ? content : registryText);
  } catch (e) {
    return { block: true, reason: isRegistry
      ? `새 경로 등록부 내용을 해석할 수 없어 막았습니다(${e.message}). 2절 표 형식(| type | 경로 | 제목 | 필수 |)을 확인하세요.`
      : `경로 등록부를 해석하지 못해 볼트 쓰기를 막았습니다(${e.message}). ${VAULT_REL.registryFile}를 확인하세요.` };
  }
  const problems = checkNote(relPath, content, rules);
  if (!problems.length) return { block: false };
  return {
    block: true,
    reason: [
      `볼트 쓰기 관문: ${relPath}가 경로 등록부 규칙에 맞지 않아 막았습니다.`,
      ...problems.map((p) => `- ${p}`),
      `규칙: ${VAULT_REL.registryFile} (type별 경로·제목·필수 머리말). 같은 폴더의 기존 노트 머리말을 참고해 맞춰서 다시 쓰세요.`,
    ].join('\n'),
  };
}

async function main() {
  let data;
  try { data = JSON.parse(await readStdin(3000)); } catch { return; }
  const toolName = data.tool_name || data.toolName || '';
  if (toolName !== 'Write' && toolName !== 'Edit') return;
  const toolInput = data.tool_input || data.toolInput || {};
  const rawPath = toolInput.file_path || toolInput.path;
  if (!rawPath) return;
  const filePath = isAbsolute(rawPath) ? rawPath : join(data.cwd || process.cwd(), rawPath);
  const relPath = vaultRelForCheck(filePath, VAULT_ROOT);
  if (!relPath) return;

  const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
  const content = resultingContent(toolName, toolInput, current);
  if (content == null) return;

  let registryText;
  try { registryText = readFileSync(join(VAULT_ROOT, VAULT_REL.registryFile), 'utf8'); } catch (e) { registryText = ''; }
  const decision = decideWrite({ relPath, content, registryText });
  if (decision.block) {
    process.stderr.write(`${decision.reason}\n`);
    process.exit(2); // PreToolUse에서 2 = 도구 호출 차단, stderr가 모델에게 전달된다
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    process.stderr.write(`볼트 쓰기 관문 훅 오류로 쓰기를 막았습니다: ${e.message}\n`);
    process.exit(2);
  });
}
