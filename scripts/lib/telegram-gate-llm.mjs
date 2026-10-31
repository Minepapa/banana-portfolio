// 텔레그램 관문 LLM 실행기 — 메시지마다 헤드리스 `claude -p`를 하루 대화(--session-id/--resume)로 이어 붙여 돌리고,
// stream-json 이벤트를 줄 단위로 넘겨 진행 표시에 쓴다(2026-10-30, 관문 2단계. 설계 6절, 실측 1-1 F3~F11).
//
// 지키는 것:
// - --strict-mcp-config + 관문 MCP 서버만 붙인다(텔레그램 플러그인이 뜨지 않아 봇을 가로채지 않는다, F8).
// - --restricted는 쓰지 않는다. 쓰면 설정 파일 훅(금고 가드)이 꺼진다(F10).
// - --tools는 Read·Grep·Glob·Agent만(Bash·Write·Edit 없음). 하위 에이전트도 이 집합을 넘지 못한다(실측).
//   실행은 관문 MCP 도구로만 한다(telegram-gate-mcp-tools.mjs).
// - 자식 환경은 buildGateSpawnEnv(CLAUDE_TELEGRAM_GATE=1, 상시 세션 변수·봇 토큰 없음).
// - 사용량 한도: 실행 전 getCooldown, 실행 중 rate_limit_event가 allowed가 아니거나 한도 오류면 setCooldown.
// - 취소·시간 초과: 프로세스 그룹에 SIGTERM, 10초 뒤 SIGKILL. 세션은 다음 --resume에서 정상으로 이어진다(F6).
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaudeBin } from './headless-claude.mjs';
import { LIMIT_RE, parseResetTime, setCooldown } from './quota-cooldown.mjs';
import { buildGateSpawnEnv } from './telegram-gate-config.mjs';
import { AGENT_IDS } from './agent-registry.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GATE_LLM_CWD = resolve(REPO_ROOT, '..', '..'); // ~/Pantheon — 루트 CLAUDE.md·담당 정의·루트 훅, 세션 기록 위치 고정(F7)
export const GATE_MODEL = 'opus';
export const GATE_EFFORT = 'medium';
export const GATE_TOOLS_SET = Object.freeze(['Read', 'Grep', 'Glob', 'Agent']);
export const SOFT_TIMEOUT_MS = 3 * 60 * 1000;
export const HARD_TIMEOUT_MS = 15 * 60 * 1000;
const KILL_GRACE_MS = 10 * 1000;

// 자격증명 경로 읽기 금지(2단계 리뷰 HIGH-3). 금고 가드는 금고만 막으므로, 관문 LLM의 Read·Grep·Glob이
// ~/.config(증권사·OAuth 토큰)·~/.claude(봇 토큰)·.env 같은 비밀 파일을 읽지 못하게 거부 규칙을 둔다.
// 실측(2026-10-30): 이 형식의 거부 규칙이 Read·Grep·Glob 모두를 막았다.
// 저장소 안 토큰 캐시(scripts/.cache의 kis-token.json·nhplug-token.json 등)도 막는다(2단계 재리뷰 HIGH).
export const SECRET_PATTERNS = Object.freeze(['~/.config/**', '~/.claude/**', '~/.ssh/**', '~/.aws/**', '~/Library/**', '**/.env', '**/.env.*', '**/*.env', '**/*.pem', '**/*.key',
  '**/*token*.json*', '**/scripts/.cache/**', '**/credentials*', '**/*secret*']);
export const GATE_DENY_RULES = Object.freeze(['Read', 'Grep', 'Glob'].flatMap((tool) => SECRET_PATTERNS.map((p) => `${tool}(${p})`)));
const MCP_SERVER_PATH = join(REPO_ROOT, 'scripts', 'tools', 'telegram-gate-mcp.mjs');

// 최종 답 계약(--json-schema, 실측: StructuredOutput 도구로 result.structured_output에 실린다).
export const GATE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    messages: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: [...AGENT_IDS] },
          topic: { type: 'string', maxLength: 40 },
          kind: { type: 'string', enum: ['정보', '판단'] },
          body: { type: 'string' },
          facts: { type: 'array', items: { type: 'string' } },
          conclusion: { type: 'string' },
          context: { type: 'string' },
          decisions: { type: 'array', items: { type: 'string' } },
        },
        required: ['agent', 'topic', 'kind'],
      },
    },
  },
  required: ['messages'],
});

// 읽기 경로 제한 훅(scripts/hooks/gate-read-guard.mjs)을 이 실행에만 붙인다. 전역 설정은 바꾸지 않는다.
// 허용 뿌리는 env GATE_READ_ROOTS로 넘긴다(buildGateReadEnv).
export function buildGateReadGuardSettings({ nodePath = process.execPath, hookPath = join(REPO_ROOT, 'scripts', 'hooks', 'gate-read-guard.mjs') } = {}) {
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read|Grep|Glob', hooks: [{ type: 'command', command: `"${nodePath}" "${hookPath}"`, timeout: 10 }] }] } });
}

// 읽기 허용 뿌리: 볼트(시험 모드면 시험 볼트)·이 저장소·관문 사진 폴더. 금고는 뿌리 안이라도 막는다.
// 저장소의 scripts/.cache(증권사 토큰 캐시 kis-token.json·nhplug-token.json)는 뿌리째 거부한다(2단계 재리뷰 HIGH).
export function buildGateReadEnv({ vaultRoot, mediaDir, adytonDir, repoRoot = REPO_ROOT }) {
  return {
    GATE_READ_ROOTS: [vaultRoot, repoRoot, mediaDir].filter(Boolean).join(':'),
    GATE_READ_DENIED: [adytonDir, join(repoRoot, 'scripts', '.cache')].filter(Boolean).join(':'),
  };
}

export function buildGateMcpConfig({ nodePath = process.execPath, serverPath = MCP_SERVER_PATH } = {}) {
  return JSON.stringify({ mcpServers: { gate: { command: nodePath, args: [serverPath] } } });
}

// 순수 함수: claude 인자. sessionId는 항상 넘긴다 — 새 대화면 --session-id, 이어 붙이면 --resume.
export function buildGateClaudeArgs({ prompt, sessionId, resume, appendSystemPrompt, allowedTools, model = GATE_MODEL, effort = GATE_EFFORT,
  mcpConfig = buildGateMcpConfig(), schema = GATE_OUTPUT_SCHEMA, readGuardSettings = buildGateReadGuardSettings() }) {
  if (!sessionId) throw new Error('sessionId 필요');
  return [
    '-p', prompt,
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', model, '--effort', effort,
    '--permission-mode', 'dontAsk',
    '--tools', GATE_TOOLS_SET.join(','),
    '--allowedTools', ...allowedTools,
    '--disallowedTools', 'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', ...GATE_DENY_RULES,
    '--strict-mcp-config', '--mcp-config', mcpConfig,
    '--settings', readGuardSettings,
    '--json-schema', JSON.stringify(schema),
    ...(appendSystemPrompt ? ['--append-system-prompt', appendSystemPrompt] : []),
    '--name', '판테온 텔레그램 창구',
  ];
}

export function parseStreamLine(line) {
  if (!line.trim()) return null;
  try { return JSON.parse(line); } catch { return null; }
}

// 순수 함수: rate_limit_event가 "막힘"이면 해제 시각(ms), 아니면 null.
export function rateLimitBlockedUntil(event) {
  const info = event?.rate_limit_info;
  if (!info || info.status === 'allowed' || info.status === 'allowed_warning') return null;
  return Number.isFinite(info.resetsAt) ? info.resetsAt * 1000 : Date.now() + 3600_000;
}

// 실행 하나. 반환: { result, structured, sessionId, isError, errorText, interrupted('cancel'|'timeout'|null), permissionDenials, rateLimit, exitCode }
export function runGateClaude({ args, env = buildGateSpawnEnv(), cwd = GATE_LLM_CWD, onEvent = () => {}, claudeBin = resolveClaudeBin(),
  spawnImpl = spawn, hardTimeoutMs = HARD_TIMEOUT_MS, cooldownWriter = setCooldown, now = () => Date.now() }) {
  let child;
  let interrupted = null;
  let killTimer = null;
  const stop = (reason) => {
    if (interrupted || !child) return;
    interrupted = reason;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* 이미 끝남 */ } }
    killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 끝남 */ } }, KILL_GRACE_MS);
  };
  const promise = new Promise((resolvePromise, reject) => {
    try {
      child = spawnImpl(claudeBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) { reject(error); return; }
    const out = { result: null, structured: null, sessionId: null, isError: false, errorText: '', permissionDenials: [], rateLimit: null };
    let buffer = '';
    let stderr = '';
    const hard = setTimeout(() => stop('timeout'), hardTimeoutMs);
    const handleLine = (line) => {
      const event = parseStreamLine(line);
      if (!event) return;
      if (event.session_id && !out.sessionId) out.sessionId = event.session_id;
      if (event.type === 'rate_limit_event') {
        out.rateLimit = event.rate_limit_info ?? null;
        const until = rateLimitBlockedUntil(event);
        if (until) cooldownWriter(until, `창구 실행 중 사용량 한도(${event.rate_limit_info?.rateLimitType ?? '?'})`);
      }
      if (event.type === 'result') {
        out.result = typeof event.result === 'string' ? event.result : null;
        out.structured = event.structured_output ?? null;
        out.isError = Boolean(event.is_error);
        out.permissionDenials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
        if (out.isError) out.errorText = String(event.result ?? event.subtype ?? '').slice(0, 500);
      }
      try { onEvent(event); } catch { /* 진행 표시 실패가 실행을 막지 않는다 */ }
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 20_000) stderr += chunk; });
    child.on('error', (error) => { clearTimeout(hard); reject(error); });
    child.on('close', (code) => {
      clearTimeout(hard);
      if (killTimer) clearTimeout(killTimer);
      if (buffer) handleLine(buffer);
      const detail = `${out.errorText} ${stderr}`;
      if (LIMIT_RE.test(detail)) cooldownWriter(parseResetTime(detail, now()) ?? now() + 3600_000, detail.trim().slice(-300));
      if (code !== 0 && !out.isError && !interrupted) {
        out.isError = true;
        out.errorText = (stderr.trim() || `claude 종료코드 ${code}`).split('\n').slice(-3).join('\n');
      }
      resolvePromise({ ...out, interrupted, exitCode: code });
    });
  });
  return { promise, cancel: () => stop('cancel'), pid: () => child?.pid ?? null };
}
