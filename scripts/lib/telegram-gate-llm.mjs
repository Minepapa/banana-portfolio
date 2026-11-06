// 텔레그램 관문 LLM 실행기 — 메시지마다 헤드리스 `claude -p`를 하루 대화(--session-id/--resume)로 이어 붙여 돌리고,
// stream-json 이벤트를 줄 단위로 넘겨 진행 표시에 쓴다(2026-10-30, 관문 2단계. 설계 6절, 실측 1-1 F3~F11).
//
// 지키는 것:
// - --strict-mcp-config + 관문 MCP 서버만 붙인다(텔레그램 플러그인이 뜨지 않아 봇을 가로채지 않는다, F8).
// - --restricted는 쓰지 않는다. 쓰면 설정 파일 훅(금고 가드)이 꺼진다(F10).
// - --tools는 Read·Grep·Glob만(Bash·Write·Edit·Agent 없음). 담당 일은 하위 에이전트 대신 담당 상시 프로세스로 넘긴다(handoff).
// - 가벼운 실행(속도 개선 2차 A-4): cwd는 창구 전용 빈 폴더, --setting-sources local(사용자·프로젝트 설정·플러그인·CLAUDE.md·
//   자동 메모리를 싣지 않음), --disable-slash-commands. 꼭 필요한 규칙은 --append-system-prompt로만 넣고, 금고 가드·읽기 가드 훅은
//   --settings로 명시해 붙인다(프로젝트 설정을 안 읽으므로 금고 가드도 여기서 직접).
//   실행은 관문 MCP 도구로만 한다(telegram-gate-mcp-tools.mjs).
// - 자식 환경은 buildGateSpawnEnv(CLAUDE_TELEGRAM_GATE=1, 상시 세션 변수·봇 토큰 없음).
// - 사용량 한도: 실행 전 getCooldown, 실행 중 rate_limit_event가 allowed가 아니거나 한도 오류면 setCooldown.
// - 취소·시간 초과: 프로세스 그룹에 SIGTERM, 10초 뒤 SIGKILL. 세션은 다음 --resume에서 정상으로 이어진다(F6).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaudeBin } from './headless-claude.mjs';
import { LIMIT_RE, parseResetTime, setCooldown } from './quota-cooldown.mjs';
import { buildGateSpawnEnv } from './telegram-gate-config.mjs';
import { AGENT_IDS } from './agent-registry.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// 창구 전용 빈 폴더(2026-11-06 A-4): 판테온 루트에서 띄우면 루트 CLAUDE.md·메모리·플러그인·스킬 목록까지 실려 지시문이 약 5만 토큰이었다.
// 세션 기록은 이 폴더 기준(~/.claude/projects/<이 경로>)으로 이어진다(F7: cwd가 같아야 --resume이 된다 — 늘 이 상수만 쓴다).
// ~/.config·~/Library는 읽기 거부 대상이라 피한다(읽을 일은 없지만 헷갈리지 않게).
export const GATE_LLM_CWD = join(homedir(), '.cache', 'banana-portfolio-v2', 'telegram-gate-cwd');
export function ensureGateCwd(dir = GATE_LLM_CWD) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export const GATE_MODEL = 'opus';
export const GATE_EFFORT = 'medium';
export const GATE_TOOLS_SET = Object.freeze(['Read', 'Grep', 'Glob']);
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
// agents: 이 프로세스가 쓸 수 있는 이름표(담당 프로세스는 자기 이름 하나). handoffTo: 제우스가 담당 프로세스로 넘길 수 있는 담당 —
// 넘길 때는 messages가 비어도 된다(toGateMessages가 다시 검사).
export function buildGateOutputSchema({ agents = AGENT_IDS, handoffTo = [] } = {}) {
  return {
    type: 'object',
    properties: {
      messages: {
        type: 'array',
        minItems: handoffTo.length ? 0 : 1,
        maxItems: 6,
        items: {
          type: 'object',
          properties: {
            agent: { type: 'string', enum: [...agents] },
            topic: { type: 'string', maxLength: 40 },
            kind: { type: 'string', enum: ['정보', '판단'] },
            body: { type: 'string', description: '정보형: 결론 한 줄 + 근거 2~3줄(짧게)' },
            facts: { type: 'array', items: { type: 'string' }, description: '판단형에만(4단 구조)' },
            conclusion: { type: 'string' },
            context: { type: 'string' },
            decisions: { type: 'array', items: { type: 'string' } },
          },
          required: ['agent', 'topic', 'kind'],
        },
      },
      ...(handoffTo.length ? { handoff: {
        type: 'object',
        description: '담당 프로세스로 넘길 때만. 그 담당이 오너 원문과 이 요청을 받아 직접 답한다.',
        properties: { agent: { type: 'string', enum: [...handoffTo] }, request: { type: 'string' } },
        required: ['agent', 'request'],
      } } : {}),
    },
    required: ['messages'],
  };
}
export const GATE_OUTPUT_SCHEMA = Object.freeze(buildGateOutputSchema());

// 읽기 경로 제한 훅(scripts/hooks/gate-read-guard.mjs)과 금고 가드(scripts/hooks/adyton-guard.mjs)를 이 실행에만 붙인다. 전역 설정은 바꾸지 않는다.
// 허용 뿌리는 env GATE_READ_ROOTS로 넘긴다(buildGateReadEnv). 금고 가드는 원래 판테온 프로젝트 설정에서 왔는데, 창구는 이제
// 프로젝트 설정을 읽지 않으므로(--setting-sources local) 같은 matcher로 여기서 명시한다(A-4, 빠지면 금고 이중 방어가 사라진다).
export function buildGateReadGuardSettings({ nodePath = process.execPath, hookPath = join(REPO_ROOT, 'scripts', 'hooks', 'gate-read-guard.mjs'),
  adytonHookPath = join(REPO_ROOT, 'scripts', 'hooks', 'adyton-guard.mjs') } = {}) {
  const hook = (path) => ({ type: 'command', command: `"${nodePath}" "${path}"`, timeout: 10 });
  return JSON.stringify({ hooks: { PreToolUse: [
    { matcher: 'Read|Grep|Glob', hooks: [hook(hookPath)] },
    { matcher: 'Read|Write|Edit|NotebookEdit|Grep|Glob|Bash', hooks: [hook(adytonHookPath)] },
  ] } });
}

// 읽기 허용 뿌리: 볼트(시험 모드면 시험 볼트)·이 저장소·관문 사진 폴더. 금고는 뿌리 안이라도 막는다.
// 저장소의 scripts/.cache(증권사 토큰 캐시 kis-token.json·nhplug-token.json)는 뿌리째 거부한다(2단계 재리뷰 HIGH).
export function buildGateReadEnv({ vaultRoot, mediaDir, adytonDir, repoRoot = REPO_ROOT }) {
  return {
    GATE_READ_ROOTS: [vaultRoot, repoRoot, mediaDir].filter(Boolean).join(':'),
    GATE_READ_DENIED: [adytonDir, join(repoRoot, 'scripts', '.cache')].filter(Boolean).join(':'),
  };
}

// agent: 이 MCP 서버를 쓰는 프로세스의 담당 — 서버가 도구 표(telegram-gate-tool-table)에 있는 그 담당 도구만 내보낸다.
export function buildGateMcpConfig({ nodePath = process.execPath, serverPath = MCP_SERVER_PATH, agent = null } = {}) {
  return JSON.stringify({ mcpServers: { gate: { command: nodePath, args: [serverPath, ...(agent ? [`--agent=${agent}`] : [])] } } });
}

// 순수 함수: claude 인자. sessionId는 항상 넘긴다 — 새 대화면 --session-id, 이어 붙이면 --resume.
// streamInput: 상시 실행(telegram-gate-live) — 프롬프트 없이 -p --input-format stream-json으로 띄우고 메시지는 stdin으로 넣는다.
export function buildGateClaudeArgs({ prompt, streamInput = false, sessionId, resume, appendSystemPrompt, allowedTools, model = GATE_MODEL, effort = GATE_EFFORT,
  tools = GATE_TOOLS_SET, mcpConfig = buildGateMcpConfig(), schema = GATE_OUTPUT_SCHEMA, readGuardSettings = buildGateReadGuardSettings() }) {
  if (!sessionId) throw new Error('sessionId 필요');
  if (!streamInput && typeof prompt !== 'string') throw new Error('prompt 필요(상시 실행이 아니면)');
  return [
    ...(streamInput ? ['-p', '--input-format', 'stream-json'] : ['-p', prompt]),
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', model, '--effort', effort,
    '--permission-mode', 'dontAsk',
    '--tools', tools.join(','),
    '--allowedTools', ...allowedTools,
    '--disallowedTools', 'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', ...GATE_DENY_RULES,
    '--strict-mcp-config', '--mcp-config', mcpConfig,
    '--setting-sources', 'local', '--disable-slash-commands',
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
  if (cwd === GATE_LLM_CWD) ensureGateCwd(cwd);
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
