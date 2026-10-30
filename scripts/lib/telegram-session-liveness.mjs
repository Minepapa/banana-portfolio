// 상시 텔레그램 세션(com.banana2.telegram-session) 생존 판정 — 순수 프로세스/API
// 확인 로직만, 액션(재시작·알림)은 안 함. health-watcher.mjs(30분 간격, 알림만)와
// telegram-session-health-check.mjs(10분 간격, 알림+재시작) 둘 다 이 모듈을 쓴다
// (2026-08-31 — 원래 health-watcher.mjs에만 있던 isProcessAlive·isPollingStuck를
// 여기로 옮김. 코드리뷰 지적: 두 번째 소비자가 생기는 순간 "같은 개념을 두 번
// 정의" 위험이 생긴다 — 이 세션 내내 지켜온 원칙과 동일 이유로 신설 시점에 바로
// 공유 모듈로 분리).
//
// ⚠️ 설계 변경(2026-08-31, 코드리뷰 지적) — 처음엔 세션의 raw 터미널 로그
// (`/usr/bin/script` 캡처, ANSI 이스케이프 섞임)에서 실패 문구를 grep하는 방식으로
// 만들었다가, 그 로그가 TUI 차등 리페인트라 마커 문자열이 화면 갱신 경계에서 실제로
// 쪼개지는 걸 실측으로 확인해(예: "login" 다음에 커서이동 코드가 끼어들어
// "login\x1b[49Gexpired"가 되는 경우가 실제 로그에 존재) 폐기했다. 아래 두 신호는
// 전부 결정론적이고 ANSI 파싱이 필요 없다.
import { execSync } from 'node:child_process';

export const TELEGRAM_SESSION_PROCESS_PATTERN = 'claude.*--channels.*telegram';

// telegram MCP 서버(bun 서브프로세스)가 살아있는지 직접 확인 — 2026-08-31 실측
// 확인된 실제 장애 형태(부모 claude 프로세스는 안 죽은 채 이 서브프로세스만 조용히
// 사라짐, 에러 로그도 없음)를 가장 직접적으로 잡는 신호. `bun run --cwd .../telegram/
// {version} --shell=bun --silent start`(plugin .mcp.json의 command 그대로) 커맨드라인
// 패턴 — 버전 디렉터리 숫자가 바뀌어도 매치되게 버전 부분은 패턴에서 뺐다.
export const TELEGRAM_MCP_SUBPROCESS_PATTERN = 'bun.*telegram.*start';

export function isProcessAlive(pattern) {
  try {
    execSync(`pgrep -f "${pattern}"`, { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false; // pgrep이 못 찾으면 비영(exit 1) — 프로세스 없음
  }
}

// 좀비 감지(2026-08-13, task #34 — health-watcher.mjs에서 이관) — pgrep은 "프로세스가
// 존재하는가"만 보고 "실제로 메시지를 소비하고 있는가"는 못 본다. pending_update_count가
// 0보다 크면 텔레그램이 배달을 시도했는데 상시세션이 아직 안 가져간 업데이트가 큐에
// 남아있다는 뜻 — getUpdates 롱폴링이 정상이면 보통 즉시 소비되므로, 이 시점 스냅샷에서
// 잡힌다는 것 자체가 폴링이 멈췄다는 강한 신호다(오탐 여지: 체크 순간과 다음 폴링 사이의
// 아주 좁은 타이밍 경합 — 실무적으로 무시 가능한 수준).
//
// ⚠️ 한계 — 오너가 그 사이 메시지를 안 보냈으면 큐에 쌓일 게 없어 0으로 남는다(폴링이
// 죽었어도 못 잡음). TELEGRAM_MCP_SUBPROCESS_PATTERN 확인이 이 한계가 없는 더 직접적인
// 1차 신호이고, 이건 그걸로도 못 잡는 경우(서브프로세스는 떠있는데 내부적으로 멎은 경우)
// 를 잡는 보조 신호다.
export function isPollingStuck({ pendingUpdateCount }) {
  return Number.isFinite(pendingUpdateCount) && pendingUpdateCount > 0;
}

// raw 터미널 로그의 mtime만으로 정체 여부를 판정하는 순수함수. 로그가 갱신되지 않는
// 정상 유휴 시간도 있으므로, 호출부는 반드시 "미답변 오너 메시지" 신호와 함께 써야
// 한다(telegram-session-health-check.mjs 참고).
export function isSessionLogStale({ lastModifiedMs, nowMs, thresholdMs }) {
  if (!Number.isFinite(lastModifiedMs) || !Number.isFinite(nowMs) || !Number.isFinite(thresholdMs) || thresholdMs <= 0) return false;
  return nowMs - lastModifiedMs > thresholdMs;
}

// 봇 가로채기 감지(2026-10-30) — 플러그인 서버는 새로 뜰 때마다 bot.pid의 이전 폴러를
// SIGTERM한다. 그래서 다른 claude 세션이 플러그인을 띄우면 봇이 그 세션으로 넘어가는데,
// TELEGRAM_MCP_SUBPROCESS_PATTERN은 "어느 세션의 플러그인이든" 맞아서 헬스체크가 계속
// 정상으로 봤다(2026-10-30 11:46~15:47 KST 4시간 실사고). 플러그인 조상에 상시 세션
// 프로세스가 있는지로 소유를 판정한다.
const MAX_ANCESTRY_DEPTH = 12;

// `ps -axo pid=,ppid=,etime=,rss=,args=` 출력 → [{ pid, ppid, etimeSec, rssKb, args }].
export function parseProcessTable(text) {
  return String(text || '').split('\n').map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) return null;
    return { pid: Number(m[1]), ppid: Number(m[2]), etimeSec: parseEtime(m[3]), rssKb: Number(m[4]), args: m[5] };
  }).filter(Boolean);
}

// ps etime `[[DD-]HH:]MM:SS` → 초. 형식이 다르면 NaN.
export function parseEtime(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime || ''));
  if (!m) return NaN;
  const [, d = 0, h = 0, min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

// 순수함수 — 플러그인 프로세스마다 조상에 상시 세션이 있는지 본다. 오너가 터미널에서
// 직접 띄운 --channels 세션도 소유로 본다(플러그인 가드와 같은 기준, 의도된 동작). 상시 세션 밖의
// 플러그인은 가장 가까운 claude 조상을 가로챈 세션으로 보고한다.
export function classifyPluginOwnership(processes, {
  sessionPattern = TELEGRAM_SESSION_PROCESS_PATTERN, pluginPattern = TELEGRAM_MCP_SUBPROCESS_PATTERN,
} = {}) {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const sessionRe = new RegExp(sessionPattern);
  const pluginRe = new RegExp(pluginPattern);
  const claudeRe = /(^|\/)claude(\s|$)/;
  const owned = [];
  const foreign = [];
  for (const plugin of processes.filter((p) => pluginRe.test(p.args))) {
    let underSession = false;
    let ownerPid = null;
    let cursor = byPid.get(plugin.ppid);
    for (let depth = 0; cursor && depth < MAX_ANCESTRY_DEPTH; depth++) {
      if (sessionRe.test(cursor.args)) { underSession = true; break; }
      if (ownerPid === null && claudeRe.test(cursor.args)) ownerPid = cursor.pid;
      cursor = byPid.get(cursor.ppid);
    }
    if (underSession) owned.push(plugin.pid);
    else foreign.push({ pid: plugin.pid, ownerPid });
  }
  return { ownedPluginPids: owned, foreignPlugins: foreign };
}

// 순수함수 — 상시 세션이 아닌 오래된 claude 세션 요약(메모리 부족이 끊김 원인 후보,
// 장애 시점 여유 메모리 0.5~2% 실측). 프로세스를 끄지 않는다 — 오너가 직접 정리한다.
export function summarizeStaleClaudeSessions(processes, { minAgeSec = 2 * 86_400, sessionPattern = TELEGRAM_SESSION_PROCESS_PATTERN } = {}) {
  const sessionRe = new RegExp(sessionPattern);
  // 데스크톱 세션은 disclaimer 래퍼 줄에도 claude 경로가 들어 있어 두 번 세지 않게 뺀다.
  const stale = processes.filter((p) => /(^|\/)claude(\s|$)/.test(p.args) && !/\/disclaimer\s/.test(p.args) && !sessionRe.test(p.args) &&
    Number.isFinite(p.etimeSec) && p.etimeSec >= minAgeSec);
  return { count: stale.length, totalRssMb: Math.round(stale.reduce((sum, p) => sum + (p.rssKb || 0), 0) / 1024) };
}

export function readProcessTable() {
  return parseProcessTable(execSync('ps -axo pid=,ppid=,etime=,rss=,args=', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 }));
}
