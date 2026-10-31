// 텔레그램 관문(telegram-gate) 설정 — 어느 봇을 쓰는지, 상태 파일을 어디에 두는지, 관문이 띄우는 자식 프로세스의
// 환경을 어떻게 만드는지를 한곳에서 정한다(2026-10-30, 관문 1단계. 설계: 볼트 Requests "2026-10-30 텔레그램 관문 설계" 3·6·10절).
//
// 두 모드:
// - live: 실제 봇. 토큰·수신자는 지금 상시 세션과 같은 ~/.claude/channels/telegram/.env·access.json(loadTelegramConfig).
// - test: 시험 봇. 토큰은 ~/.config/banana-portfolio-v2/telegram-gate-test.env에서만 읽는다.
//   ⚠️ 시험 모드에서 실제 봇 .env를 읽으면 시험 데몬이 실제 봇의 getUpdates를 가져가 상시 세션을 끊는다.
//   그래서 시험 설정 경로가 실제 .env와 같은 파일이면(심볼릭 링크 포함) 시작을 거부한다. 실제 .env는 열지도 않는다.
//   허용 사용자(오너 user id)는 토큰이 아니라서 access.json의 allowFrom을 함께 쓴다(시험 env에 TELEGRAM_GATE_ALLOW_FROM이 있으면 그것).
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadTelegramConfig } from './telegram.mjs';

const CHAT_ID_RE = /^-?[1-9]\d*$/;

export function defaultGatePaths({ home = homedir() } = {}) {
  return {
    liveEnv: join(home, '.claude', 'channels', 'telegram', '.env'),
    access: join(home, '.claude', 'channels', 'telegram', 'access.json'),
    testEnv: join(home, '.config', 'banana-portfolio-v2', 'telegram-gate-test.env'),
    liveStateDir: join(home, '.config', 'banana-portfolio-v2', 'telegram-gate'),
    // 시험 상태(시험 볼트 포함)는 ~/.cache에 둔다 — 관문 LLM은 ~/.config 전체를 읽지 못하게 막는데(자격증명),
    // 시험 볼트는 LLM이 읽어야 하기 때문이다(2단계 리뷰 HIGH-3).
    testStateDir: join(home, '.cache', 'banana-portfolio-v2', 'telegram-gate-test'),
    // 관문 LLM이 판독할 사진을 내려받는 곳(읽기 허용 뿌리, ~/.config 밖).
    liveLlmMediaDir: join(home, '.cache', 'banana-portfolio-v2', 'telegram-gate-media'),
    testLlmMediaDir: join(home, '.cache', 'banana-portfolio-v2', 'telegram-gate-test-media'),
  };
}

// 같은 파일인지: 경로(심볼릭 링크 풀기)와 inode(하드링크)를 함께 본다. 내용(토큰)은 읽지 않는다.
function sameFile(a, b) {
  try {
    if (realpathSync(a) === realpathSync(b)) return true;
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return a === b;
  }
}

function parseEnvFile(raw) {
  const out = {};
  for (const line of String(raw).split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function readAllowFrom(accessPath, readFile) {
  const access = JSON.parse(readFile(accessPath, 'utf8'));
  return (access.allowFrom ?? []).map(String);
}

// 반환: { mode, config: { botToken, chatId }, allowFrom: Set<string>, stateDir, heartbeatJob }
// heartbeatJob이 null이면 볼트 JobHealth에 하트비트를 쓰지 않는다(시험 데몬이 health-watcher 경보를 만들지 않게).
export function loadGateConfig({ mode = 'live', env = process.env, paths = defaultGatePaths(),
  readFile = readFileSync, exists = existsSync, loadLive = loadTelegramConfig } = {}) {
  if (mode === 'live') {
    const config = loadLive({ envPath: paths.liveEnv, accessPath: paths.access });
    const allowFrom = new Set(readAllowFrom(paths.access, readFile));
    if (!allowFrom.size) throw new Error('창구 허용 사용자가 없습니다(access.json allowFrom)');
    return { mode, config, allowFrom, stateDir: env.TELEGRAM_GATE_STATE_DIR || paths.liveStateDir, heartbeatJob: 'telegram-gate', vaultRoot: null, llmMediaDir: paths.liveLlmMediaDir };
  }
  if (mode !== 'test') throw new Error(`창구 모드는 live 또는 test: ${mode}`);
  const testEnvPath = env.TELEGRAM_GATE_TEST_ENV || paths.testEnv;
  if (sameFile(testEnvPath, paths.liveEnv)) throw new Error('시험 모드는 실제 봇 설정 파일을 읽지 않습니다');
  if (!exists(testEnvPath)) throw new Error(`시험 봇 설정 파일이 없습니다: ${testEnvPath}`);
  const parsed = parseEnvFile(readFile(testEnvPath, 'utf8'));
  const botToken = parsed.TELEGRAM_BOT_TOKEN;
  if (!botToken || !/^\S+:\S+$/.test(botToken)) throw new Error('시험 봇 설정에 TELEGRAM_BOT_TOKEN이 없습니다');
  const allowList = parsed.TELEGRAM_GATE_ALLOW_FROM
    ? parsed.TELEGRAM_GATE_ALLOW_FROM.split(',').map((s) => s.trim()).filter(Boolean)
    : readAllowFrom(paths.access, readFile);
  if (!allowList.length || !allowList.every((id) => CHAT_ID_RE.test(id))) throw new Error('시험 봇 허용 사용자가 올바르지 않습니다');
  const stateDir = env.TELEGRAM_GATE_STATE_DIR || paths.testStateDir;
  // 시험 상태 폴더가 실전 상태 폴더와 같으면 실전 offset·대기열을 섞는다 — 거부한다.
  if (sameFile(stateDir, paths.liveStateDir) || stateDir === paths.liveStateDir) throw new Error('시험 모드 상태 폴더가 실전 창구 상태 폴더와 같습니다');
  return {
    mode,
    config: { botToken, chatId: allowList[0] },
    allowFrom: new Set(allowList),
    stateDir,
    heartbeatJob: null,
    // 시험 모드의 볼트: 스위치·기록·질문 큐·장부 쓰기가 전부 여기로 간다(데몬이 VAULT_PATH를 이 폴더로 두고 다시 뜬다).
    vaultRoot: join(stateDir, 'vault'),
    llmMediaDir: paths.testLlmMediaDir,
  };
}

// 관문이 띄우는 모든 자식 프로세스(결정론 도구 CLI, 2단계의 헤드리스 claude)의 환경은 이 함수에서만 만든다.
// 불변식(0단계 리뷰 LOW, 설계 6-1):
// - CLAUDE_TELEGRAM_GATE=1이 반드시 있다. 빠지면 금고 가드가 오너 대화형 세션으로 판정해 해제 중 읽기가 열린다.
// - CLAUDE_TELEGRAM_SESSION은 없다. 있으면 reply 도구에 묶인 훅(reply-guard 등)이 관문 실행을 막는다.
// - TELEGRAM_BOT_TOKEN은 넘기지 않는다. 자식이 토큰을 환경변수로 볼 이유가 없고, 훅(progress-reaction)은 env 토큰을 우선 쓴다.
function resolvedPath(path) {
  try { return realpathSync(path); } catch { return path; }
}

// 시험 모드 격리 확인: 시험 모드인데 이 프로세스의 볼트 경로가 시험 볼트가 아니면 시작하지 않는다.
// 심볼릭 링크로 시험 볼트가 실제 볼트를 가리키는 경우도 막으려고 실제 경로로 풀어 비교한다(1단계 재리뷰 LOW-B).
export function assertTestIsolation({ mode, vaultRoot, processVaultRoot, realVaultRoot, resolve = resolvedPath }) {
  if (mode !== 'test') return;
  const processReal = processVaultRoot ? resolve(processVaultRoot) : null;
  if (!vaultRoot || !processReal || processReal !== resolve(vaultRoot) || processReal === resolve(realVaultRoot)) {
    throw new Error(`시험 모드는 시험 볼트(${vaultRoot})에서만 돈다 — 실제 볼트에 쓰지 않는다`);
  }
}

// stateDir(선택): 관문 MCP 도구(확인 대기 접수)가 관문 상태 폴더를 찾게 TELEGRAM_GATE_STATE_DIR로 넘긴다.
export function buildGateSpawnEnv(base = process.env, { stateDir } = {}) {
  const env = { ...base };
  delete env.CLAUDE_TELEGRAM_SESSION;
  delete env.TELEGRAM_BOT_TOKEN;
  env.CLAUDE_TELEGRAM_GATE = '1';
  if (stateDir) env.TELEGRAM_GATE_STATE_DIR = stateDir;
  return env;
}
