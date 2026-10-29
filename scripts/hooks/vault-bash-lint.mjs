#!/usr/bin/env node
/**
 * Bash 볼트 쓰기 감지 훅(3단 처리의 가, 2026-10-24 오너 승인 — 볼트 Requests `2026-10-24 볼트 등록부 위반 즉시 감지와
 * 안전 자동 수정`). 쓰기 관문(vault-write-gate)은 Write/Edit만 보므로 sed·heredoc·스크립트로 쓴 볼트 노트는 야간
 * lint에서야 드러났다(2026-10-24 경고 3건). 이 훅은 Bash 명령이 끝난 직후 그 사이 바뀐 볼트 노트만 검사해 같은
 * 세션에 알린다 — 맥락을 가진 작성자가 바로 고치게 하는 것이 목적이다.
 *
 * - PreToolUse(Bash): 시작 시각 표식을 남긴다(tool_use_id별, 병렬 Bash 구분).
 * - PostToolUse·PostToolUseFailure(Bash): 실패한 명령도 쓰고 나서 실패했을 수 있어 같이 본다. 볼트 git 상태의 변경·새 파일 중 표식 뒤에 고친 .md만 checkNote + 작업 문서 최신성으로 검사.
 *   위반이 있으면 additionalContext로 알린다. 막지 않는다(이미 쓴 뒤라서) — 항상 continue:true.
 * - 범위는 쓰기 관문과 같다(vaultRelForCheck: 80_Archive·95_Etna·99_Adyton·헌법·숨김 제외). 금고는 경로만 보고 걸러
 *   내용을 읽지 않는다. 같은 시각 폰·태블릿이 고친 노트가 섞일 수 있다 — 알림일 뿐이라 해가 없다.
 * - 어떤 오류가 나도 세션을 막지 않는다(조용히 통과).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdin } from './telegram-reply-guard.mjs';
import { vaultRelForCheck } from './vault-write-gate.mjs';
import { VAULT_ROOT, VAULT_REL } from '../lib/vault-paths.mjs';
import { parseRegistry } from '../lib/vault-registry.mjs';
import { problemsFor, suggestFixes } from '../lib/vault-lint-fix.mjs';

const MARK_DIR = join(tmpdir(), 'vault-bash-lint');
const FALLBACK_WINDOW_MS = 2 * 60 * 1000; // 표식이 없을 때(Pre 훅 누락) 최근 2분
const MAX_FILES = 200;
const STALE_MARK_MS = 24 * 60 * 60 * 1000;

// Post가 오지 않아 남은 표식(세션 중단 등)을 하루 지나면 지운다.
function cleanStaleMarks(now) {
  for (const name of readdirSync(MARK_DIR)) {
    const path = join(MARK_DIR, name);
    try { if (now - statSync(path).mtimeMs > STALE_MARK_MS) rmSync(path, { force: true }); } catch { /* 이미 지워짐 */ }
  }
}

function markPath(data) {
  const key = String(data.tool_use_id || data.session_id || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
  return join(MARK_DIR, `${key}.json`);
}

// `git status --porcelain -z` 출력 → 경로 목록. 이름 바꾸기(R/C)는 새 경로만, 지운 파일은 뺀다.
export function parseStatusZ(output) {
  const parts = output.split('\0');
  const paths = new Set();
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    if (code.includes('R') || code.includes('C')) i += 1; // 다음 칸은 옛 경로
    if (!code.includes('D')) paths.add(entry.slice(3));
  }
  return [...paths];
}

// 표식 뒤에 고친 볼트 노트(상대 경로). stat 실패(지워짐)는 뺀다.
export function changedVaultNotes(vaultRoot, sinceMs, statusOutput) {
  const out = [];
  for (const gitRel of parseStatusZ(statusOutput)) {
    const full = join(vaultRoot, gitRel);
    const rel = vaultRelForCheck(full, vaultRoot);
    if (!rel) continue;
    try { if (statSync(full).mtimeMs < sinceMs - 1000) continue; } catch { continue; }
    out.push(rel);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

// 순수 판정 — 위반 노트 목록 → 알림 문구(없으면 null).
export function buildBashLintMessage(findings) {
  if (!findings.length) return null;
  return [
    `볼트 쓰기 점검(Bash): 방금 명령으로 바뀐 볼트 노트 ${findings.length}개가 경로 등록부 규칙에 맞지 않습니다. 지금 고치세요.`,
    ...findings.flatMap(({ rel, problems, suggestions }) => [
      `- ${rel}: ${problems.join(' / ')}`,
      ...suggestions.map((s) => `  → 추천: ${s}`),
    ]),
    `규칙: ${VAULT_REL.registryFile} · ${VAULT_REL.statusStandardFile}. 볼트 노트는 Write/Edit로 쓰면 쓰기 관문이 미리 막아 준다.`,
  ].join('\n');
}

export function lintChanged(vaultRoot, rels, registryText, today) {
  const rules = parseRegistry(registryText);
  const findings = [];
  for (const rel of rels) {
    let content;
    try { content = readFileSync(join(vaultRoot, rel), 'utf8'); } catch { continue; }
    const problems = problemsFor(vaultRoot, rel, content, rules);
    if (problems.length) findings.push({ rel, problems, suggestions: suggestFixes(rel, content, problems, rules, { today }) });
  }
  return findings;
}

function pass() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function main() {
  let data;
  try { data = JSON.parse(await readStdin(3000)); } catch { return pass(); }
  if ((data.tool_name || data.toolName) !== 'Bash') return pass();
  const event = data.hook_event_name || data.hookEventName;
  const mark = markPath(data);
  if (event === 'PreToolUse') {
    mkdirSync(MARK_DIR, { recursive: true });
    writeFileSync(mark, JSON.stringify({ start: Date.now() }));
    try { cleanStaleMarks(Date.now()); } catch { /* 정리 실패는 무시 */ }
    return pass();
  }
  if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') return pass();
  let since = Date.now() - FALLBACK_WINDOW_MS;
  try { since = JSON.parse(readFileSync(mark, 'utf8')).start ?? since; rmSync(mark, { force: true }); } catch { /* 표식 없음 */ }
  const status = execFileSync('git', ['-C', VAULT_ROOT, 'status', '--porcelain', '-z', '--untracked-files=all'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  const rels = changedVaultNotes(VAULT_ROOT, since, status);
  if (!rels.length) return pass();
  const registryText = readFileSync(join(VAULT_ROOT, VAULT_REL.registryFile), 'utf8');
  const today = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
  const message = buildBashLintMessage(lintChanged(VAULT_ROOT, rels, registryText, today));
  if (!message) return pass();
  console.log(JSON.stringify({ continue: true, hookSpecificOutput: { hookEventName: event, additionalContext: message } }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => pass());
}
