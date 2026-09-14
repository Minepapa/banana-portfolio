#!/usr/bin/env node
/**
 * PostToolUse 훅 — Write/Edit로 건드린 파일이 Knowledge/Meta/므네모시네-파일배선도.md
 * 의 어느 클러스터에 속하면, 그 자리에서 "같이 확인할 나머지 파일" 목록을
 * 알려준다(2026-09-14, 오너 지시 — "파일배선도를 만든 이유가 하나 고칠 때 연관된
 * 걸 알려주려는 거였는데, 그걸 실제로 활용해서 전체를 다 안 훑어도 되게 하자").
 *
 * 이 훅이 왜 필요한가 — 파일배선도.md는 지금까지 "세션이 기억해서 열어보는" 문서
 * 였다. vault-progress-guard.mjs(progress 필드 검사)가 "쓰는 순간 즉시 감지"로
 * 므네모시네 정합성 문제 하나를 구조적으로 해소한 것과 같은 원리를, "연관 파일
 * 알림"에도 적용한다 — 방금 건드린 파일과 같은 클러스터의 나머지, 특히 **가드가
 * "수동"인(기계적 검증 수단이 없는)** 것들을 우선순위로 보여준다("테스트" 가드가
 * 있는 건 npm test가 알아서 잡아주므로 상대적으로 덜 급함).
 *
 * 계약(Claude Code PostToolUse 훅) — vault-progress-guard.mjs와 동일(stdin JSON,
 * stdout {continue:true, hookSpecificOutput:{...}} 또는 {continue:true,
 * suppressOutput:true}), oh-my-claudecode post-tool-rules-injector.mjs 검증된 형태.
 *
 * 한계(파일 상단 wiring-map-parser.mjs 주석 참고) — 완전한 마크다운 파서가 아니라
 * 이 문서의 실제 표 구조에 맞춘 라이트 파서다. 클러스터 5처럼 표가 없는 프로즈
 * 전용 섹션은 정본 추출이 지저분할 수 있음 — 그래도 advisory(경고가 아니라 참고
 * 알림)라 잘못된 긍정의 비용이 낮다고 판단, 완벽한 파서보다 지금 있는 실제 클러스터
 * 1~4(표 구조 갖춘 것들)를 정확히 잡는 쪽을 우선했다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readStdin } from './telegram-reply-guard.mjs';
import { VAULT_ROOT } from '../lib/vault-paths.mjs';
import { parseWiringMapClusters, findRelatedClusters } from '../lib/wiring-map-parser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_REPO_ROOT = join(HERE, '..', '..'); // scripts/hooks/ 기준 2단계 위
const WIRING_MAP_PATH = join(VAULT_ROOT, 'Knowledge', 'Meta', '므네모시네-파일배선도.md');
const MAX_OTHERS_SHOWN = 8;

function pass() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function warn(message) {
  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
  }));
}

// 순수함수 — 두 후보(vault 기준·code repo 기준) 상대경로 중 실제로 그 루트 "안"에
// 있는 것만 남긴다('..'로 시작하면 그 루트 밖).
export function candidateRelPaths(filePath, vaultRoot, codeRepoRoot) {
  const out = [];
  const vRel = relative(vaultRoot, filePath);
  if (!vRel.startsWith('..')) out.push(vRel);
  const cRel = relative(codeRepoRoot, filePath);
  if (!cRel.startsWith('..')) out.push(cRel);
  return out;
}

// 순수함수 — findRelatedClusters 결과를 사람이 읽을 알림 문자열로 조립. others가
// 하나도 없으면(정본만 있고 종속파일이 아직 없는 등) null.
export function buildReminderMessage(relPath, relatedClusters) {
  const withOthers = relatedClusters.filter((c) => c.others.length > 0);
  if (!withOthers.length) return null;
  const lines = [`📎 파일배선도 — 방금 건드린 ${relPath}이(가) 다음 클러스터에 속합니다:`];
  for (const c of withOthers) {
    const manual = c.others.filter((o) => o.guard === '수동');
    const rest = c.others.filter((o) => o.guard !== '수동');
    const parts = [];
    if (manual.length) parts.push(`⚠️ 수동가드(기계검증 없음): ${manual.slice(0, MAX_OTHERS_SHOWN).map((o) => o.path).join(', ')}`);
    if (rest.length) parts.push(`그 외: ${rest.slice(0, MAX_OTHERS_SHOWN).map((o) => o.path).join(', ')}`);
    lines.push(`- ${c.name}${c.isSource ? '(정본)' : ''} — ${parts.join(' / ')}`);
  }
  lines.push('므네모시네-파일배선도.md 참고, 필요하면 같이 갱신할 것.');
  return lines.join('\n');
}

async function main() {
  let data;
  try {
    data = JSON.parse(await readStdin(3000));
  } catch { pass(); return; }

  const toolName = data.tool_name || data.toolName || '';
  if (toolName !== 'Write' && toolName !== 'Edit') { pass(); return; }

  const toolInput = data.tool_input || data.toolInput || {};
  const rawPath = toolInput.file_path || toolInput.path;
  if (!rawPath) { pass(); return; }

  const cwd = data.cwd || process.cwd();
  const filePath = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);

  if (!existsSync(WIRING_MAP_PATH)) { pass(); return; }

  const candidates = candidateRelPaths(filePath, VAULT_ROOT, CODE_REPO_ROOT);
  if (!candidates.length) { pass(); return; }

  let content;
  try { content = readFileSync(WIRING_MAP_PATH, 'utf8'); } catch { pass(); return; }
  const clusters = parseWiringMapClusters(content);

  for (const relPath of candidates) {
    const related = findRelatedClusters(clusters, relPath);
    const message = buildReminderMessage(relPath, related);
    if (message) { warn(message); return; }
  }
  pass();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  });
}
