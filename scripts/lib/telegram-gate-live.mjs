// 텔레그램 창구 상시 실행 — 메시지마다 `claude -p`를 새로 띄우지 않고, 하루 대화 프로세스를 `--input-format stream-json`으로
// 계속 띄워 둔 채 사용자 메시지를 stdin으로 넣는다(2026-11-06 오너 지시, 볼트 요청 `텔레그램 창구 답변 속도 개선`).
//
// 실측(2026-11-06, claude 2.1.319, sonnet low): 새로 띄우면 첫 글자 9~10초, 상시면 둘째 메시지부터 3.4~3.8초.
// 같은 날 같은 실측 스크립트로 확인한 것(--no-session-persistence, 도구 없음):
// - 턴마다 system/init·result가 따로 나온다. --json-schema는 턴마다 structured_output으로 실린다.
// - 중단 요청 {"type":"control_request","request":{"subtype":"interrupt"}}을 넣으면 control_response(success) 뒤
//   result(subtype error_during_execution, is_error true)로 그 턴이 끝나고, 프로세스는 살아서 다음 턴에 앞 대화를 기억한다.
//
// 지키는 것(한 번에 claude -p 하나를 띄우던 runGateClaude와 같은 보장):
// - 인자·자식 환경은 호출부가 만든다(buildGateClaudeArgs streamInput·buildGateSpawnEnv). 여기서는 바꾸지 않는다.
// - 한 프로세스에 한 번에 한 턴만(창구 직렬 처리). 턴 중에 다른 턴을 넣으면 거절한다.
// - 사용량 한도: rate_limit_event가 막힘이면, 프로세스가 한도 오류로 죽으면 setCooldown.
// - 취소·시간 초과: 먼저 중단 요청, INTERRUPT_GRACE_MS 안에 턴이 안 끝나면 프로세스 그룹 SIGTERM → 10초 뒤 SIGKILL.
//   죽인 프로세스는 버리고, 다음 메시지에서 같은 세션을 --resume으로 다시 띄운다(풀이 판단).
// - 프로세스가 턴 중에 죽으면 그 턴은 오류로 끝난다(조용히 다시 보내지 않는다 — 도구가 이미 실행됐을 수 있다).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveClaudeBin } from './headless-claude.mjs';
import { LIMIT_RE, parseResetTime, setCooldown } from './quota-cooldown.mjs';
import { parseStreamLine, rateLimitBlockedUntil, GATE_LLM_CWD, HARD_TIMEOUT_MS } from './telegram-gate-llm.mjs';

export const LIVE_IDLE_MS = 30 * 60 * 1000;
export const LIVE_MAX_PROCESSES = 3;
export const INTERRUPT_GRACE_MS = 5 * 1000;
const KILL_GRACE_MS = 10 * 1000;
// 상시 프로세스 타이머가 창구 종료를 붙잡지 않게 unref한다(창구는 수신 루프로 살아 있다).
const unrefTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };

// 창구가 띄운 상시 프로세스 전부(detached라 창구가 어떻게 끝나든 직접 정리해야 고아로 남지 않는다 — installExitCleanup).
const LIVE_CHILDREN = new Set();
export function killAllLiveClaude(signal = 'SIGKILL') {
  for (const child of LIVE_CHILDREN) {
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* 끝남 */ } }
  }
}

// 순수 함수: stdin에 넣는 한 줄(사용자 메시지·중단 요청).
export function userMessageLine(text) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}
export function interruptLine(requestId = randomUUID()) {
  return `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } })}\n`;
}

// 상시 프로세스 하나. meta: { key, day, sessionId } — 풀이 재사용 여부를 판단하는 값.
export function createLiveClaude({ args, env, meta = {}, cwd = GATE_LLM_CWD, claudeBin = resolveClaudeBin(), spawnImpl = spawn,
  cooldownWriter = setCooldown, now = () => Date.now(), setTimer = unrefTimer, clearTimer = clearTimeout,
  interruptGraceMs = INTERRUPT_GRACE_MS, log = () => {} }) {
  let child;
  let buffer = '';
  let stderr = '';
  let closed = false;
  let exitCode = null;
  let turn = null; // { out, onEvent, resolve, interrupted, timers }
  let lastActivityAt = now();
  let killTimer = null;

  const killGroup = () => {
    if (!child || closed) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* 이미 끝남 */ } }
    if (!killTimer) killTimer = setTimer(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 끝남 */ } } }, KILL_GRACE_MS);
  };

  const finishTurn = (extra = {}) => {
    if (!turn) return;
    const current = turn;
    turn = null;
    for (const t of current.timers) clearTimer(t);
    lastActivityAt = now();
    current.resolve({ ...current.out, ...extra, interrupted: current.interrupted, exitCode });
  };

  const handleLine = (line) => {
    const event = parseStreamLine(line);
    if (!event) return;
    lastActivityAt = now();
    if (!turn) return; // 턴 밖 이벤트(종료 직전 잔여 출력)는 버린다
    const { out } = turn;
    if (event.session_id && !out.sessionId) out.sessionId = event.session_id;
    if (event.type === 'rate_limit_event') {
      out.rateLimit = event.rate_limit_info ?? null;
      const until = rateLimitBlockedUntil(event);
      if (until) cooldownWriter(until, `창구 실행 중 사용량 한도(${event.rate_limit_info?.rateLimitType ?? '?'})`);
    }
    try { turn.onEvent(event); } catch { /* 진행 표시 실패가 실행을 막지 않는다 */ }
    if (event.type === 'result') {
      out.result = typeof event.result === 'string' ? event.result : null;
      out.structured = event.structured_output ?? null;
      out.permissionDenials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
      // 중단 요청으로 끝난 턴은 오류가 아니라 취소·시간 초과다.
      if (turn.interrupted) { out.isError = false; out.errorText = ''; } else {
        out.isError = Boolean(event.is_error);
        if (out.isError) out.errorText = String(event.result ?? event.subtype ?? '').slice(0, 500);
      }
      finishTurn();
    }
  };

  try {
    child = spawnImpl(claudeBin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  } catch (error) {
    closed = true;
    stderr = String(error?.message ?? error);
  }
  if (child) {
    LIVE_CHILDREN.add(child);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 20_000) stderr += chunk; });
    child.stdin.on?.('error', () => { /* 죽은 프로세스에 쓰기 — close에서 처리 */ });
    const onClosed = (code) => {
      if (closed) return;
      closed = true;
      LIVE_CHILDREN.delete(child);
      exitCode = code ?? null;
      if (killTimer) clearTimer(killTimer);
      if (buffer) { handleLine(buffer); buffer = ''; }
      if (LIMIT_RE.test(stderr)) cooldownWriter(parseResetTime(stderr, now()) ?? now() + 3600_000, stderr.trim().slice(-300));
      log(`[gate] 상시 프로세스 종료(${meta.key ?? '?'}, 코드 ${code})`);
      if (turn) {
        const interrupted = turn.interrupted;
        finishTurn(interrupted ? {} : { isError: true, errorText: (stderr.trim() || `claude 종료코드 ${code}`).split('\n').slice(-3).join('\n'), processDied: true });
      }
    };
    child.on('close', onClosed);
    child.on('error', (error) => { stderr += `\n${error.message}`; onClosed(null); });
  }

  const write = (text) => {
    try { child.stdin.write(text); return true; } catch { return false; }
  };

  return {
    meta,
    pid: () => child?.pid ?? null,
    alive: () => !closed,
    busy: () => Boolean(turn),
    lastActivityAt: () => lastActivityAt,
    stderrTail: () => stderr.trim().split('\n').slice(-3).join('\n'),
    // 턴 하나. 반환 { promise, cancel } — runGateClaude와 같은 결과 모양.
    turn({ text, onEvent = () => {}, hardTimeoutMs = HARD_TIMEOUT_MS }) {
      const out = { result: null, structured: null, sessionId: null, isError: false, errorText: '', permissionDenials: [], rateLimit: null };
      if (closed) {
        return { promise: Promise.resolve({ ...out, isError: true, errorText: stderr.trim().split('\n').slice(-3).join('\n') || '상시 프로세스가 이미 끝남', processDied: true, interrupted: null, exitCode }), cancel: () => {} };
      }
      if (turn) throw new Error('상시 프로세스에 이미 진행 중인 턴이 있습니다');
      let resolveTurn;
      const promise = new Promise((r) => { resolveTurn = r; });
      turn = { out, onEvent, resolve: resolveTurn, interrupted: null, timers: [] };
      const current = turn;
      const stop = (reason) => {
        if (turn !== current || current.interrupted) return;
        current.interrupted = reason;
        // 먼저 중단 요청. 못 넣었거나 유예 안에 턴이 안 끝나면 프로세스를 죽인다(다음 메시지에서 --resume으로 다시 띄움).
        if (!write(interruptLine())) { killGroup(); return; }
        current.timers.push(setTimer(() => { if (turn === current) killGroup(); }, interruptGraceMs));
      };
      current.timers.push(setTimer(() => stop('timeout'), hardTimeoutMs));
      lastActivityAt = now();
      if (!write(userMessageLine(text))) killGroup();
      return { promise, cancel: () => stop('cancel') };
    },
    // 무활동·날짜 변경·창구 종료. stdin을 닫아 스스로 끝나게 하고, 남아 있으면 그룹을 죽인다.
    close(reason = '') {
      if (closed) return;
      log(`[gate] 상시 프로세스 닫음(${meta.key ?? '?'}${reason ? `, ${reason}` : ''})`);
      try { child.stdin.end(); } catch { /* 이미 닫힘 */ }
      killGroup();
    },
  };
}

// 상시 프로세스 풀 — 키(담당 id)마다 하나. 같은 업무일·같은 세션이고 살아 있으면 재사용하고, 아니면 닫고 새로 띄운다.
// 동시에 최대 maxProcesses개(제우스 포함). 넘으면 쉬고 있는 것 중 가장 오래 쉰 것을 닫는다(진행 중인 턴은 닫지 않는다).
// spawnLive({ key, args, env, meta }) → createLiveClaude 결과(시험은 가짜).
export function createLivePool({ spawnLive, idleMs = LIVE_IDLE_MS, maxProcesses = LIVE_MAX_PROCESSES, now = () => Date.now(), log = () => {} }) {
  const procs = new Map();

  function evictFor(key) {
    const others = [...procs.entries()].filter(([k, p]) => k !== key && p.alive());
    while (others.length + 1 > maxProcesses) {
      const idle = others.filter(([, p]) => !p.busy()).sort((a, b) => a[1].lastActivityAt() - b[1].lastActivityAt());
      if (!idle.length) break;
      const [k, p] = idle[0];
      p.close('동시 실행 한도');
      procs.delete(k);
      others.splice(others.findIndex(([ok]) => ok === k), 1);
    }
  }

  return {
    // { key, day, sessionId, args(새로 띄울 때만 씀), env, text, onEvent, hardTimeoutMs } → { promise, cancel, spawned }
    turn({ key, day, sessionId, args, env, text, onEvent, hardTimeoutMs }) {
      let proc = procs.get(key);
      if (proc && proc.alive() && proc.busy()) throw new Error(`상시 프로세스(${key})에 이미 진행 중인 턴이 있습니다`);
      const reusable = proc && proc.alive() && !proc.busy() && proc.meta.day === day && proc.meta.sessionId === sessionId;
      let spawned = false;
      if (!reusable) {
        if (proc) { proc.close(proc.alive() ? '세션·날짜 바뀜' : '죽은 프로세스 정리'); procs.delete(key); }
        evictFor(key);
        proc = spawnLive({ key, args, env, meta: { key, day, sessionId } });
        procs.set(key, proc);
        spawned = true;
      }
      return { ...proc.turn({ text, onEvent, hardTimeoutMs }), spawned };
    },
    // 호출(예열): 이 키의 같은 날·같은 세션 프로세스가 이미 살아 있는지.
    isWarm({ key, day, sessionId }) {
      const proc = procs.get(key);
      return Boolean(proc && proc.alive() && proc.meta.day === day && proc.meta.sessionId === sessionId);
    },
    // 1분 점검: 30분 무활동·업무일 바뀜·죽은 프로세스를 정리한다.
    sweep({ day } = {}) {
      for (const [key, proc] of [...procs.entries()]) {
        if (!proc.alive()) { procs.delete(key); continue; }
        if (proc.busy()) continue;
        if (day && proc.meta.day !== day) { proc.close('업무일 바뀜'); procs.delete(key); continue; }
        if (now() - proc.lastActivityAt() >= idleMs) { proc.close('30분 무활동'); procs.delete(key); }
      }
    },
    closeAll(reason = '창구 종료') {
      for (const [key, proc] of procs.entries()) { proc.close(reason); procs.delete(key); }
    },
    list: () => [...procs.values()].filter((p) => p.alive()).map((p) => ({ ...p.meta, pid: p.pid(), busy: p.busy() })),
  };
}
