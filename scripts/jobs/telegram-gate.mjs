#!/usr/bin/env node
/**
 * 텔레그램 관문(telegram-gate) — 봇의 유일한 수신·발신자가 되는 상시 데몬(2026-10-30, 관문 1단계).
 * 설계·결정: 볼트 Requests "2026-10-30 텔레그램 관문 설계", 결정 `텔레그램-관문`(초안, 4단계 전환 때 확정).
 *
 * 왜: 지금 상시 세션(`claude --channels`)은 (1) 다른 claude가 플러그인을 띄우면 봇을 빼앗기고, (2) 답장이 모델의 reply
 * 도구 호출에 달려 있고, (3) 다운 중 메시지를 잃을 수 있다. 관문은 수신을 Node가 직접 맡아 결정론 입력을 즉시 처리하고,
 * 대화(LLM)는 2단계에서 메시지마다 헤드리스 claude로 붙인다.
 *
 * 구조(두 루프):
 * - 수신 루프: getUpdates(롱폴링 50초) → inbox.jsonl 저장(fsync) → offset 확정. 처리하지 않는다.
 * - 처리 루프: inbox의 "받음"을 update_id 순으로 하나씩 라우터 → 처리기. 오래 걸리는 처리(음성 전사)가 있어도
 *   수신은 멈추지 않는다.
 * - 감시견: 수신 루프가 정해진 시간 넘게 진척이 없거나 이벤트 루프가 멈추면 exit(1) → launchd KeepAlive가 다시 띄운다.
 * - 하트비트: 5분마다 상태 파일(상태 폴더 heartbeat.json)과, 실전 모드면 볼트 JobHealth/telegram-gate.
 *
 * 1단계 범위: 결정론 입력(안녕·상태·취소·스위치 3종·📜·📎·🪶·음성 기록·WQ·체결확인·장소). 'llm' route는 고정 안내.
 * 제안 승인·직접 주문·사진 판독·자유 대화는 2단계.
 *
 * 사용법:
 *   node scripts/jobs/telegram-gate.mjs --mode=test       시험 봇(~/.config/banana-portfolio-v2/telegram-gate-test.env)
 *   node scripts/jobs/telegram-gate.mjs                   실전(전환 뒤 launchd만). 상시 세션이 떠 있으면 봇을 빼앗으니 금지
 *   node scripts/jobs/telegram-gate.mjs --self-test       네트워크 없이 실행 환경(node·claude 경로·버전)만 출력
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTestIsolation, loadGateConfig } from '../lib/telegram-gate-config.mjs';
import { createGateInbox } from '../lib/telegram-gate-inbox.mjs';
import { laneOf, routeUpdate, sanitizeUpdate } from '../lib/telegram-gate-router.mjs';
import { createGateHandlers, gateMediaDir, killRunningGateTools, pruneGateMedia } from '../lib/telegram-gate-handlers.mjs';
import { classifyPollError, pollOnce, pollRetryDelayMs, shouldAlertPollError, POLL_TIMEOUT_SEC } from '../lib/telegram-gate-poller.mjs';
import { getTelegramUpdates, setTelegramReaction, getTelegramFile, downloadTelegramFile, escapeHtml, TelegramApiError } from '../lib/telegram.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { createDirectWarningSender } from '../lib/direct-warning-delivery.mjs';
import { getCooldown } from '../lib/quota-cooldown.mjs';
import { resolveClaudeBin } from '../lib/headless-claude.mjs';
import { resolveWikiQuestion, applyWikiQuestion } from '../lib/wiki-question-queue.mjs';
import { buildJobHealthRecord, parseFrontmatter } from '../lib/job-health.mjs';
import { writeStateFile, writeAtomic } from '../lib/state-writer.mjs';
import { DEFAULT_VAULT_ROOT, VAULT_PATHS, VAULT_REL, VAULT_ROOT } from '../lib/vault-paths.mjs';

// 발신 카탈로그 대조용(vault-job-catalog-audit): 관문의 답장·경고는 제우스 이름으로 나간다(세부 담당 답은 처리기가 담당 헤더로).
const SENDER_AGENT = 'zeus';
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 15 * 1000;
// 롱폴링 50초 + fetch 여유 15초 + 판정 여유. 이보다 오래 수신 루프 진척이 없으면 멈춘 것으로 본다.
export const POLL_STALL_MS = (POLL_TIMEOUT_SEC + 15 + 60) * 1000;
const TICK_STALL_MS = 2 * 60 * 1000;
// 받은 지 이만큼 지난 스위치 명령 중 위험해지는 방향(router risky)만 실행하지 않고 다시 묻는다(설계 9-2).
export const STALE_COMMAND_MS = 10 * 60 * 1000;
const BACKLOG_NOTICE_MS = 2 * 60 * 1000;
// 409와 성공이 번갈아 오는 가로채기에서 경고·복구가 반복되지 않게, 복구 알림은 이만큼 연속 정상일 때만 보낸다.
export const RECOVERY_CONFIRM_MS = 5 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function sleepChunked(ms, { onBeat, isStopping, sleep }) {
  return (async () => {
    let left = ms;
    while (left > 0 && !isStopping()) {
      const step = Math.min(left, 5000);
      await sleep(step);
      left -= step;
      onBeat();
    }
  })();
}

// deps는 시험에서 가짜로 바꾼다: api{getUpdates, react, getFile, download}, send(message), now, sleep, exit, heartbeatWriter …
export function createGateDaemon({ gate, inbox, api, send, warn = null, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  exit = (code) => process.exit(code), selfCheck, statusExtras = () => ({}), runTool, wiki, writeHeartbeat = async () => {},
  log = (line) => console.log(line), listPollers = () => [] } = {}) {
  const startedAt = now().getTime();
  const state = {
    stopping: false,
    lastPollOkAt: null,
    lastPollProgressAt: startedAt,
    lastTickAt: startedAt,
    pollFailures: 0,
    lastAlert: { at: null, kind: null },
    alertOpen: false,
    healthySince: null,
    lastPollError: null,
    backlogChecked: false,
    processing: { main: null, media: null },
  };
  let pollAbort = null;
  const waiters = new Set();
  const wakeAll = () => { for (const w of waiters) w(); };

  const reply = (chatId) => (agent, topic, body) => send({ agent, kind: '정보', topic, body }, chatId);

  async function notifyOwner(agent, topic, body) {
    try { await send({ agent, kind: '정보', topic, body }, gate.config.chatId); } catch (error) { log(`[gate] 오너 알림 실패: ${error.message}`); }
  }

  // 운영 경고(가로채기·수신 멈춤)는 실전에서 경고 원장(direct-warning-delivery)을 거친다. 시험 모드는 원장 없이 시험 봇으로만.
  async function warnOwner(body) {
    const message = { agent: SENDER_AGENT, kind: '정보', topic: '경고', body };
    try {
      if (warn) await warn(message);
      else await send(message, gate.config.chatId);
    } catch (error) {
      log(`[gate] 경고 발송 실패: ${error.message}`);
    }
  }

  function buildHandlers(meta, lane) {
    return createGateHandlers({
      lane,
      reply: reply(meta.chatId),
      react: (emoji) => api.react({ chatId: meta.chatId, messageId: meta.messageId, emoji }),
      runTool,
      telegram: { getFile: api.getFile, download: api.download },
      wiki,
      selfCheck: () => selfCheck({ state, now: now() }),
      status: () => ({
        startedAt, now: now().getTime(), lastPollOkAt: state.lastPollOkAt, counts: inbox.counts(), mode: gate.mode, ...statusExtras(),
      }),
      mediaDir: gateMediaDir(gate.stateDir),
      testMode: gate.mode === 'test',
      isStopping: () => state.stopping,
      now,
    });
  }

  async function processItem(item, lane = 'main') {
    const decision = routeUpdate(item.update, { allowFrom: gate.allowFrom });
    if (decision.action === 'drop') {
      inbox.markStatus(item.updateId, '버림', decision.reason);
      return;
    }
    const { route, args, meta } = decision;
    inbox.markStatus(item.updateId, '처리중', route);
    state.processing[lane] = { updateId: item.updateId, route, since: now().toISOString() };
    try {
      const ageMs = Number.isFinite(meta.date) ? now().getTime() - meta.date * 1000 : 0;
      if (route === 'switch' && args.risky && ageMs > STALE_COMMAND_MS) {
        await reply(meta.chatId)(SENDER_AGENT, '스위치', `${Math.round(ageMs / 60000)}분 전에 받은 명령이라 실행하지 않았습니다. 지금도 원하면 다시 보내 주세요.\n· ${escapeHtml(args.text)}`);
        inbox.markStatus(item.updateId, '완료', '오래된 스위치 명령 — 실행 안 함');
        return;
      }
      const result = await buildHandlers(meta, lane)(route, args);
      // 종료로 끊긴 건은 '처리중'으로 둔다 — 재시작 때 확인필요 안내 경로를 탄다.
      if (!result.interruptedByShutdown) inbox.markStatus(item.updateId, result.status, result.detail ?? '');
    } catch (error) {
      // 처리기 자체가 실패 답장까지 못 보낸 경우(네트워크 등). 다시 실행하지 않는다.
      inbox.markStatus(item.updateId, '실패', error.message);
      log(`[gate] 처리 실패 update ${item.updateId}: ${error.message}`);
    } finally {
      state.processing[lane] = null;
    }
  }

  // 줄(lane)마다 하나씩 처리한다. main: 스위치·기록·상태 등, media: 음성·사진(오래 걸림). 같은 건을 두 줄이 집지 않게
  // 고르는 즉시 processItem이 '처리중'으로 바꾼다(await 전 동기 구간).
  function nextFor(lane) {
    return inbox.pending().find((item) => laneOf(routeUpdate(item.update, { allowFrom: gate.allowFrom })) === lane) ?? null;
  }

  async function workerLoop(lane = 'main') {
    while (!state.stopping) {
      const next = nextFor(lane);
      if (!next) {
        await new Promise((r) => {
          const done = () => { waiters.delete(done); clearTimeout(t); r(); };
          const t = setTimeout(done, 1000);
          waiters.add(done);
        });
        continue;
      }
      await processItem(next, lane);
    }
  }

  async function handlePollError(error) {
    const kind = classifyPollError(error);
    if (kind === 'aborted') return;
    state.pollFailures += 1;
    state.lastPollError = { kind, message: error.message, at: now().toISOString() };
    log(`[gate] 수신 오류(${kind}, ${state.pollFailures}회): ${error.message}`);
    state.healthySince = null;
    state.lastPollProgressAt = now().getTime();
    if (shouldAlertPollError(error, { lastAlertAt: state.lastAlert.at, lastKind: state.lastAlert.kind, now: now().getTime() })) {
      state.lastAlert = { at: now().getTime(), kind };
      state.alertOpen = true;
      const cause = error instanceof TelegramApiError
        ? `Bot API 오류 코드 ${error.errorCode ?? error.status ?? '알 수 없음'}`
        : '관문 내부 오류(저장 실패 등)';
      const body = kind === 'conflict'
        ? ['다른 프로그램이 같은 봇을 받고 있어 관문이 메시지를 못 받습니다(409).', '관문은 계속 다시 잡습니다.',
          ...listPollers().slice(0, 3).map((line) => `· ${escapeHtml(line)}`)].join('\n')
        : `관문 수신이 멈췄습니다. 사람이 확인해야 합니다.\n· ${cause}(자세한 원인은 telegram-gate.log)`;
      await warnOwner(body);
      state.lastPollProgressAt = now().getTime();
    }
    await sleepChunked(pollRetryDelayMs(error, state.pollFailures), {
      onBeat: () => { state.lastPollProgressAt = now().getTime(); },
      isStopping: () => state.stopping,
      sleep,
    });
  }

  async function pollLoop() {
    while (!state.stopping) {
      state.lastPollProgressAt = now().getTime();
      pollAbort = new AbortController();
      const timer = setTimeout(() => pollAbort?.abort(), (POLL_TIMEOUT_SEC + 15) * 1000);
      try {
        const { fresh } = await pollOnce({
          inbox, getUpdates: api.getUpdates, signal: pollAbort.signal, sanitize: (u) => sanitizeUpdate(u, { allowFrom: gate.allowFrom }),
        });
        const nowMs = now().getTime();
        state.lastPollOkAt = new Date(nowMs).toISOString();
        state.lastPollProgressAt = nowMs;
        state.pollFailures = 0;
        state.lastPollError = null;
        if (state.healthySince === null) state.healthySince = nowMs;
        // 경고를 보낸 뒤 5분 연속 정상일 때만 복구를 알린다. lastAlert.at은 지우지 않아 같은 종류 재경고는 30분 간격을 지킨다.
        if (state.alertOpen && nowMs - state.healthySince >= RECOVERY_CONFIRM_MS) {
          state.alertOpen = false;
          await notifyOwner(SENDER_AGENT, '복구', '관문 수신이 다시 정상입니다.');
        }
        // 다운 중 서버에 쌓였던 메시지는 첫 수신에서 들어온다 — 그때 한 번 안내한다(설계 9-2).
        if (!state.backlogChecked) {
          state.backlogChecked = true;
          await announceBacklog();
        }
        if (fresh) wakeAll();
      } catch (error) {
        if (error?.name === 'AbortError' && !state.stopping) {
          await handlePollError(Object.assign(new Error('getUpdates 응답 시간 초과'), { network: true }));
        } else {
          await handlePollError(error);
        }
      } finally {
        clearTimeout(timer);
        pollAbort = null;
      }
    }
  }

  // 순수에 가까운 판정(시험용으로 노출): 수신 진척·이벤트 루프 지연을 보고 멈췄는지.
  function watchdogCheck(nowMs = now().getTime()) {
    const tickGap = nowMs - state.lastTickAt;
    state.lastTickAt = nowMs;
    if (tickGap > TICK_STALL_MS) return `이벤트 루프 지연 ${Math.round(tickGap / 1000)}초`;
    if (nowMs - state.lastPollProgressAt > POLL_STALL_MS) return `수신 루프 진척 없음 ${Math.round((nowMs - state.lastPollProgressAt) / 1000)}초`;
    return null;
  }

  async function heartbeat() {
    const nowMs = now().getTime();
    const healthy = state.lastPollOkAt !== null && nowMs - Date.parse(state.lastPollOkAt) < 3 * 60 * 1000;
    const counts = inbox.counts();
    const detail = healthy
      ? `수신 정상 · 밀린 것 ${(counts['받음'] ?? 0) + (counts['처리중'] ?? 0)}`
      : `수신 오류 ${state.lastPollError?.kind ?? '시작 전'}: ${state.lastPollError?.message ?? ''}`;
    await writeHeartbeat({ healthy, detail, state: { ...state }, counts, at: new Date(nowMs).toISOString() });
  }

  async function announceRecovered() {
    const interrupted = inbox.recoverInterrupted();
    if (interrupted.length) {
      const lines = interrupted.slice(0, 5).map((i) => `· ${escapeHtml(String(i.update?.message?.text ?? i.update?.message?.caption ?? '(글 없음)').slice(0, 30))}`);
      await notifyOwner(SENDER_AGENT, '확인 필요', [
        `처리 중에 관문이 멈춘 메시지 ${interrupted.length}건이 있습니다. 두 번 실행되지 않게 다시 처리하지 않았습니다.`,
        '기록이 이미 남았을 수 있으니 확인한 뒤 필요할 때만 다시 보내 주세요.',
        ...lines,
      ].join('\n'));
    }
  }

  async function announceBacklog() {
    const pending = inbox.pending();
    const oldest = pending[0]?.update?.message?.date;
    if (pending.length && Number.isFinite(oldest) && now().getTime() - oldest * 1000 > BACKLOG_NOTICE_MS) {
      await notifyOwner(SENDER_AGENT, '밀린 메시지', `관문이 멈춘 동안 온 메시지 ${pending.length}건을 지금 처리합니다.`);
    }
  }

  return {
    state,
    processItem,
    watchdogCheck,
    heartbeat,
    announceRecovered,
    announceBacklog,
    pollLoop,
    workerLoop,
    stop() {
      state.stopping = true;
      pollAbort?.abort();
      // media 줄(음성 전사)만 끝낸다 — 노트는 전사가 끝난 뒤에만 생겨 끊어도 기록 중복이 없다. main 줄 도구(기록·스위치)는
      // 끝날 때까지 기다려 상태를 완료로 남긴다(main()이 최대 10초 기다린 뒤 종료).
      killRunningGateTools('SIGTERM', { group: 'media' });
      wakeAll();
    },
    async run() {
      inbox.compact();
      pruneGateMedia(gateMediaDir(gate.stateDir), { now: now() });
      await writeHeartbeat({ healthy: false, detail: '시작', state: { ...state }, counts: inbox.counts(), at: now().toISOString(), startup: true })
        .catch((e) => log(`[gate] 시작 하트비트 실패: ${e.message}`));
      await announceRecovered();
      // 시작 알림 발송이 오래 걸려도 첫 감시견 판정이 오탐하지 않게 기준 시각을 지금으로 맞춘다.
      state.lastTickAt = now().getTime();
      state.lastPollProgressAt = now().getTime();
      const maintenance = setInterval(() => {
        try { inbox.compact(); pruneGateMedia(gateMediaDir(gate.stateDir), { now: now() }); } catch (e) { log(`[gate] 정리 실패: ${e.message}`); }
      }, MAINTENANCE_INTERVAL_MS);
      const watchdog = setInterval(() => {
        const reason = watchdogCheck();
        if (reason) { log(`[gate] 감시견: ${reason} — 종료(launchd가 다시 띄움)`); exit(1); }
      }, WATCHDOG_INTERVAL_MS);
      const beat = setInterval(() => { heartbeat().catch((e) => log(`[gate] 하트비트 실패: ${e.message}`)); }, HEARTBEAT_INTERVAL_MS);
      try {
        // 첫 하트비트는 5분 뒤 — 시작 직후엔 수신 성공 전이라 FAIL로 남아 재시작마다 잡음이 생긴다.
        await Promise.all([pollLoop(), workerLoop('main'), workerLoop('media')]);
      } finally {
        clearInterval(watchdog);
        clearInterval(beat);
        clearInterval(maintenance);
      }
    },
  };
}

// 안녕 점검: 관문 수신 정상 + 2단계 LLM 경로의 전제(claude 실행 파일, 사용량 쿨다운 없음). LLM은 부르지 않는다.
export function gateSelfCheck({ state, now, claudeBin = resolveClaudeBin(), exists = existsSync, cooldown = getCooldown() }) {
  const problems = [];
  if (!state.lastPollOkAt || now.getTime() - Date.parse(state.lastPollOkAt) > 3 * 60 * 1000) problems.push('수신 루프가 최근 3분 안에 성공하지 않음');
  if (!(claudeBin.startsWith('/') ? exists(claudeBin) : true)) problems.push(`claude 실행 파일 없음: ${claudeBin}`);
  if (cooldown) problems.push(`사용량 한도 쿨다운 중(해제 ${new Date(cooldown.resetAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })})`);
  return { ok: problems.length === 0, problems };
}

async function writeVaultHeartbeat(job, { healthy, detail }) {
  const path = join(VAULT_PATHS.root, VAULT_REL.jobHealth, `${job}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const prior = existsSync(path) ? parseFrontmatter(readFileSync(path, 'utf8')) : null;
  const { content } = buildJobHealthRecord({ job, status: healthy ? 'OK' : 'FAIL', detail }, prior);
  await writeStateFile(path, content);
}

function listTelegramPollers() {
  try {
    return execFileSync('pgrep', ['-fl', 'bun.*telegram'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
      .map((line) => line.slice(0, 80));
  } catch {
    return [];
  }
}

// 관문 프로세스가 어떤 경로로 끝나든(감시견 exit(1)·처리 안 된 예외·정상 종료) detached로 띄운 도구 그룹을 함께 끝낸다.
// detached 자식은 자기 프로세스 그룹이라 launchd의 그룹 정리에서도 빠지므로 여기서 직접 정리해야 한다(1단계 재리뷰 MEDIUM-N1).
// node 자체가 SIGKILL되는 경우는 막을 수 없다 — 4단계 실측 항목("kickstart -k 뒤 whisper 고아 없음").
export function installExitCleanup({ proc = process, kill = killRunningGateTools, log = (line) => console.error(line) } = {}) {
  proc.on('exit', () => { kill('SIGKILL'); });
  proc.on('uncaughtException', (error) => {
    log(`[gate] 처리 안 된 예외 — 도구 정리 후 종료: ${error?.message ?? error}`);
    kill('SIGKILL');
    proc.exit(1);
  });
}

function selfTest() {
  const claudeBin = resolveClaudeBin();
  let claudeVersion = '(확인 실패)';
  try { claudeVersion = execFileSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim(); } catch { /* 출력만 */ }
  console.log(JSON.stringify({ node: process.version, execPath: process.execPath, claudeBin, claudeVersion, PATH: process.env.PATH }, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) { selfTest(); return; }
  const mode = argv.find((a) => a.startsWith('--mode='))?.slice(7) ?? 'live';
  const gate = loadGateConfig({ mode });
  // 시험 모드: 볼트 경로는 모듈을 불러올 때 정해진다. 시험 볼트로 정해져 있지 않으면 VAULT_PATH를 시험 볼트로 두고
  // 자기 자신을 다시 띄운다 — 데몬 안(위키 질문 큐)과 자식 도구(스위치·기록·장부)가 모두 시험 볼트만 보게 된다.
  if (gate.mode === 'test' && process.env.VAULT_PATH !== gate.vaultRoot) {
    mkdirSync(gate.vaultRoot, { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, VAULT_PATH: gate.vaultRoot } });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
    child.on('exit', (code) => process.exit(code ?? 1));
    return;
  }
  assertTestIsolation({ mode: gate.mode, vaultRoot: gate.vaultRoot, processVaultRoot: VAULT_ROOT, realVaultRoot: DEFAULT_VAULT_ROOT });
  const inbox = createGateInbox({ dir: gate.stateDir });
  const options = { config: gate.config };
  const daemon = createGateDaemon({
    gate,
    inbox,
    api: {
      getUpdates: (params, extra = {}) => getTelegramUpdates(params, { ...options, ...extra }),
      react: (params) => setTelegramReaction(params, options),
      getFile: (fileId) => getTelegramFile(fileId, options),
      download: (filePath) => downloadTelegramFile(filePath, options),
    },
    send: (message, chatId) => sendAgentMessage(message, chatId, options),
    warn: gate.mode === 'live'
      ? createDirectWarningSender(sendAgentMessage, {
        jobName: 'telegram-gate', warningCode: 'TELEGRAM_GATE_POLL', subjectKey: 'telegram-gate', kind: 'operational', severity: 'high',
      })
      : null,
    selfCheck: ({ state, now }) => gateSelfCheck({ state, now }),
    statusExtras: () => ({ cooldown: getCooldown(), freeMemPct: Math.round((freemem() / totalmem()) * 100) }),
    wiki: { resolve: resolveWikiQuestion, apply: applyWikiQuestion },
    writeHeartbeat: async (beat) => {
      writeAtomic(join(gate.stateDir, 'heartbeat.json'), `${JSON.stringify({ at: beat.at, healthy: beat.healthy, detail: beat.detail, pid: process.pid, mode: gate.mode })}\n`);
      // 시작 직후 기록은 볼트에 쓰지 않는다(수신 성공 전이라 FAIL로 남아 재시작마다 잡음). 바깥 감시용 상태 파일만.
      if (gate.heartbeatJob && !beat.startup) await writeVaultHeartbeat(gate.heartbeatJob, beat);
    },
    listPollers: listTelegramPollers,
  });
  installExitCleanup();
  console.log(`[gate] 시작 mode=${gate.mode} node=${process.version} claude=${resolveClaudeBin()} state=${gate.stateDir}`);
  const stop = (signal) => { console.log(`[gate] ${signal} — 종료`); daemon.stop(); setTimeout(() => process.exit(0), 10_000).unref(); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  await daemon.run();
}

const invokedPath = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return null; } })();
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[gate] 시작 실패: ${error.message}`); process.exit(1); });
}
