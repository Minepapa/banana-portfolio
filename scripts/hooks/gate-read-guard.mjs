#!/usr/bin/env node
// 텔레그램 관문 LLM 읽기 경로 제한(PreToolUse, 2026-10-30 관문 2단계 리뷰 HIGH-3).
//
// 왜 훅인가(실측): dontAsk 모드에서 Read 허용 규칙(`Read(//경로/**)`)은 다른 경로 읽기를 막지 못했다(읽기 도구는 기본 허용).
// 거부 규칙은 동작하지만 "이 경로만 허용"을 표현하지 못한다. 그래서 관문이 claude를 띄울 때 --settings로 이 훅을 붙여
// Read·Grep·Glob(하위 에이전트 포함)이 허용 뿌리(볼트·저장소·관문 사진 폴더) 안에서만 돌게 한다. 그 밖은 차단(exit 2).
// - 허용 뿌리는 관문이 env GATE_READ_ROOTS(경로 구분자 ':')로 넘긴다. 없으면 전부 막는다(fail-closed).
// - 허용 뿌리 안이라도 비밀 파일(.env·*.pem·*.key)과 금고는 막는다.
// - CLAUDE_TELEGRAM_GATE=1이 아니면 아무것도 하지 않는다(관문 실행 전용, 다른 세션에는 붙지 않지만 이중 안전).
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_FILE_RE = /^(\.env(\..*)?|.*\.env|.*\.pem|.*\.key|.*token.*\.json.*|credentials.*|.*secret.*)$/i;
const SECRET_DIR_RE = /(^|\/)scripts\/\.cache(\/|$)/;

function realish(path) {
  // 없는 파일(Glob 패턴의 앞부분 등)은 존재하는 가장 가까운 상위 폴더까지 풀어 비교한다.
  let current = path;
  const tail = [];
  for (let i = 0; i < 64; i += 1) {
    try { return resolve(realpathSync(current), ...tail.reverse()); } catch { /* 올라간다 */ }
    const parent = dirname(current);
    if (parent === current) return path;
    tail.push(basename(current));
    current = parent;
  }
  return path;
}

function within(path, root) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

// 순수에 가까운 판정: { block, reason }
// Grep의 glob·type, Glob의 pattern에 비밀 파일·폴더를 가리키는 말이 있으면 막는다. 저장소 전체 Grep이 .gitignore(rg가 숨김·무시
// 파일을 건너뜀)에 기대지 않게 가드가 직접 막는다(제우스 확인, 2단계 커밋 전 보완).
const SECRET_GLOB_RE = /token|credential|secret|\.cache|\.env|\.pem|\.key/i;
// rg 파일 종류(type)는 점 없이 온다(예: env).
const SECRET_TYPE_RE = /token|credential|secret|cache|env|pem|key/i;

// glob 패턴에서 와일드카드 앞 고정 부분(경로)만 꺼낸다. 'scripts/.cache/*' → 'scripts/.cache', '/a/b/**' → '/a/b'.
export function fixedPrefix(pattern) {
  const parts = [];
  for (const part of String(pattern).split('/')) {
    if (/[*?[{]/.test(part)) break;
    parts.push(part);
  }
  return parts.join('/');
}

export function decideGateRead({ toolName, toolInput = {}, cwd, roots, deniedRoots = [] }) {
  if (!['Read', 'Grep', 'Glob'].includes(toolName)) return { block: false };
  if (!roots.length) return { block: true, reason: '창구 읽기 허용 경로가 없어 막았습니다' };
  const target = toolName === 'Read' ? toolInput.file_path : (toolInput.path ?? cwd);
  if (typeof target !== 'string' || !target) return { block: true, reason: '읽을 경로가 없습니다' };
  const base = isAbsolute(target) ? target : resolve(cwd, target);
  const targets = [base];
  if (toolName === 'Glob') {
    const pattern = String(toolInput.pattern ?? '');
    if (SECRET_GLOB_RE.test(pattern)) return { block: true, reason: '비밀 파일·폴더 패턴은 찾을 수 없습니다' };
    // pattern의 고정 부분도 경로로 판정한다: 절대경로(/·~)면 그대로, 상대면 path에 이어 붙여서(재리뷰 LOW·제우스 확인).
    const prefix = fixedPrefix(pattern.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    if (prefix) targets.push(isAbsolute(prefix) ? prefix : resolve(base, prefix));
  }
  if (toolName === 'Grep') {
    if (toolInput.glob !== undefined && SECRET_GLOB_RE.test(String(toolInput.glob))) return { block: true, reason: '비밀 파일은 검색할 수 없습니다' };
    if (toolInput.type !== undefined && SECRET_TYPE_RE.test(String(toolInput.type))) return { block: true, reason: '비밀 파일은 검색할 수 없습니다' };
  }
  const realRoots = roots.map(realish);
  const realDenied = deniedRoots.map(realish);
  for (const raw of targets) {
    const abs = realish(raw);
    if (!realRoots.some((root) => within(abs, root))) {
      return { block: true, reason: `창구에서는 볼트·저장소 안만 읽을 수 있습니다(path를 그 안으로 지정): ${abs}` };
    }
    if (realDenied.some((root) => within(abs, root))) return { block: true, reason: '금고·토큰 캐시는 읽을 수 없습니다' };
    if (SECRET_DIR_RE.test(abs)) return { block: true, reason: '토큰 캐시 폴더는 읽을 수 없습니다' };
  }
  if ((toolName === 'Read' || toolName === 'Grep') && SECRET_FILE_RE.test(basename(realish(base)))) return { block: true, reason: '비밀 파일(.env·키)은 읽을 수 없습니다' };
  return { block: false };
}

async function main() {
  if (process.env.CLAUDE_TELEGRAM_GATE !== '1') return;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    process.stderr.write('창구 읽기 가드: 입력을 해석하지 못해 막았습니다\n');
    process.exitCode = 2;
    return;
  }
  const split = (v) => String(v ?? '').split(':').filter(Boolean);
  const decision = decideGateRead({
    toolName: data.tool_name ?? '',
    toolInput: data.tool_input ?? {},
    cwd: data.cwd ?? process.cwd(),
    roots: split(process.env.GATE_READ_ROOTS),
    deniedRoots: split(process.env.GATE_READ_DENIED),
  });
  if (decision.block) {
    process.stderr.write(`${decision.reason}\n`);
    process.exitCode = 2;
  }
}

const invoked = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return null; } })();
if (invoked && invoked === fileURLToPath(import.meta.url)) main();
