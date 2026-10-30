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
 * 사용법(GATE_USAGE와 같게 유지):
 *   node scripts/jobs/telegram-gate.mjs --mode=test       시험 봇(~/.config/banana-portfolio-v2/telegram-gate-test.env)
 *   node scripts/jobs/telegram-gate.mjs --mode=live       실전 — 전환 뒤 launchd만(실전 가드 통과 필요)
 *   node scripts/jobs/telegram-gate.mjs --self-test       네트워크 없이 실행 환경(node·claude 경로·버전)만 출력
 *   node scripts/jobs/telegram-gate.mjs --help            사용법만 출력
 *
 * 실전 가드(2026-10-31 사고: `--help`가 무시되고 기본값 live로 떠 실제 봇을 2분 가져감, 상시 세션 409 5회):
 * 모르는 인자는 거부(exit 2), --mode는 필수. live는 아래를 모두 만족할 때만 시작한다.
 *   TELEGRAM_GATE_LIVE_CUTOVER=1 · launchd에 관문 plist 등록 + launchd가 아는 pid가 자기 자신이나 부모(run.sh) ·
 *   상시 세션(--channels)·텔레그램 플러그인 폴러·다른 관문이 없음 · 프로세스 표를 정상으로 읽음(못 읽으면 거부).
 * 거부는 수신을 시작하지 않고 exit 0으로 끝낸다(사유는 로그 → run.sh가 JobHealth detail에 남김). plist KeepAlive가
 * {SuccessfulExit:false}라 거부(0)는 다시 띄우지 않고, 감시견 exit(1) 같은 비정상 종료만 다시 띄운다 — 10초마다 거부·FAIL이 쌓이지 않게(재리뷰 M1).
 */
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import { readProcessTable, TELEGRAM_MCP_SUBPROCESS_PATTERN, TELEGRAM_SESSION_PROCESS_PATTERN } from '../lib/telegram-session-liveness.mjs';
import { fileURLToPath } from 'node:url';
import { assertTestIsolation, buildGateSpawnEnv, defaultGatePaths, loadGateConfig } from '../lib/telegram-gate-config.mjs';
import { createGateInbox } from '../lib/telegram-gate-inbox.mjs';
import { laneOf, routeUpdate, sanitizeUpdate } from '../lib/telegram-gate-router.mjs';
import { createGateHandlers, gateMediaDir, killRunningGateTools, pruneGateMedia } from '../lib/telegram-gate-handlers.mjs';
import { classifyPollError, pollOnce, pollRetryDelayMs, shouldAlertPollError, POLL_TIMEOUT_SEC } from '../lib/telegram-gate-poller.mjs';
import { getTelegramUpdates, setTelegramReaction, getTelegramFile, downloadTelegramFile, deleteTelegramMessage, escapeHtml, TelegramApiError } from '../lib/telegram.mjs';
import { sendAgentMessage, editAgentMessage } from '../lib/pantheon-send.mjs';
import { createDirectWarningSender } from '../lib/direct-warning-delivery.mjs';
import { getCooldown } from '../lib/quota-cooldown.mjs';
import { resolveClaudeBin } from '../lib/headless-claude.mjs';
import { resolveWikiQuestion, applyWikiQuestion } from '../lib/wiki-question-queue.mjs';
import { buildJobHealthRecord, parseFrontmatter } from '../lib/job-health.mjs';
import { writeStateFile, writeAtomic } from '../lib/state-writer.mjs';
import { DEFAULT_VAULT_ROOT, VAULT_PATHS, VAULT_REL, VAULT_ROOT, vaultAbs } from '../lib/vault-paths.mjs';
import { buildHandoffSummaryArgs, createConversation } from '../lib/telegram-gate-conversation.mjs';
import { buildGateReadEnv, runGateClaude } from '../lib/telegram-gate-llm.mjs';
// 종료코드 규칙(llm-run-outcome) 대상 아님: 상시 데몬이라 종료코드로 성패를 남기지 않는다. LLM 실패는 메시지마다 오너에게 알리고 inbox에 실패로 적는다.
import { businessDay, createSessionStore } from '../lib/telegram-gate-session.mjs';
import { createJournal, handoffNoteRelPath } from '../lib/telegram-gate-journal.mjs';
import { confirmOpenSinceSec, createConfirmStore } from '../lib/telegram-gate-confirm.mjs';
import { createGateMcpTools, gateMcpToolNames, promiseRequestDir } from '../lib/telegram-gate-mcp-tools.mjs';
import { createPromiseStore, describeTrigger } from '../lib/telegram-gate-promises.mjs';
import { createFiredLog, createPromiseRunner } from '../lib/telegram-gate-promise-runner.mjs';
import { JOB_LABELS } from '../lib/job-labels.mjs';
import { isShadowMode } from '../lib/shadow-mode.mjs';

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
const TICK_INTERVAL_MS = 60 * 1000;

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
  log = (line) => console.log(line), listPollers = () => [], conversation = null, confirmStore = null, journal = null, promiseRunner = null } = {}) {
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
    processing: { main: null, media: null, llm: null },
    // 대화 줄과 약속 이행(LLM)이 동시에 claude를 띄우지 않게 하는 표시(같은 하루 세션을 이어 붙이므로).
    llmBusy: false,
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
      selfCheck: () => selfCheck({ state, now: now(), lastRun: conversation?.state.lastRun ?? null }),
      status: () => ({
        startedAt, now: now().getTime(), lastPollOkAt: state.lastPollOkAt, counts: inbox.counts(), mode: gate.mode,
        llm: conversation ? { running: conversation.isRunning(), queued: llmQueue().length, lastRun: conversation.state.lastRun, rateLimit: conversation.state.lastRateLimit } : null,
        promises: promiseRunner ? promiseRunner.summary() : null,
        ...statusExtras(),
      }),
      mediaDir: gateMediaDir(gate.stateDir),
      testMode: gate.mode === 'test',
      isStopping: () => state.stopping,
      now,
    });
  }

  // 확인 질문을 실제로 보낸 확인 대기만 연다(보낸 시각 이후 메시지만 응·아니로 본다, 2단계 리뷰 HIGH-1).
  const confirmOpenSince = () => confirmOpenSinceSec(confirmStore?.pending(now()));
  const routeOf = (item) => routeUpdate(item.update, { allowFrom: gate.allowFrom, confirmOpenSince: confirmOpenSince() });
  // 확인 질문 뒤, 이 "응"보다 먼저 보낸 다른 입력이 있으면(줄 처리 순서와 무관하게) 다른 주제로 본다(2단계 리뷰 MEDIUM).
  function hasEarlierOtherInput(item, since) {
    const me = item.update.message;
    return [...inbox.pending(), ...inbox.inFlight()].some((other) => {
      const m = other.update?.message;
      if (!m || other.updateId === item.updateId || !Number.isFinite(m.date) || m.date <= since) return false;
      const earlier = m.date < me.date || (m.date === me.date && m.message_id < me.message_id);
      if (!earlier) return false;
      const r = routeOf(other);
      return r.action === 'handle' && !KEEPS_CONFIRM.has(r.route);
    });
  }
  const llmQueue = () => inbox.pending().filter((item) => laneOf(routeOf(item)) === 'llm');
  // 확인 대기 중에도 닫지 않는 입력(상태 확인·생존 확인). 그 밖의 오너 입력은 "다른 주제"로 확인 대기를 닫는다.
  const KEEPS_CONFIRM = new Set(['confirm', 'status', 'greeting']);

  async function cancelRoute(args, meta) {
    const runningCancelled = conversation?.cancel() ?? false;
    let queuedCancelled = 0;
    if (args.all) {
      for (const item of llmQueue()) { inbox.markStatus(item.updateId, '완료', '취소 전부로 취소됨'); queuedCancelled += 1; }
      conversation?.setQueued(0);
    }
    if (!runningCancelled && !queuedCancelled) return null; // 처리기의 "취소할 작업 없음" 답으로
    // 실행 중인 대화는 대화 줄이 진행 메시지를 "취소함"으로 고친다. 대기분만 여기서 알린다.
    if (queuedCancelled) await reply(meta.chatId)(SENDER_AGENT, '취소', `기다리던 메시지 ${queuedCancelled}건도 처리하지 않습니다.`);
    return { status: '완료', detail: `취소(실행 중 ${runningCancelled ? 1 : 0}, 대기 ${queuedCancelled})` };
  }

  async function processItem(item, lane = 'main') {
    const decision = routeOf(item);
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
      // 확인 질문 뒤에 온 다른 입력만 확인 대기를 닫는다(질문 전에 보낸 메시지가 늦게 처리돼도 닫지 않음).
      const openSince = confirmOpenSince();
      if (conversation && !KEEPS_CONFIRM.has(route) && openSince !== null && Number.isFinite(meta.date) && meta.date > openSince) {
        await conversation.closeConfirm('다른 주제', meta.chatId);
      }
      let result = null;
      if (route === 'confirm' && conversation) {
        const since = confirmOpenSince();
        if (since !== null && hasEarlierOtherInput(item, since)) {
          await conversation.closeConfirm('다른 주제', meta.chatId);
          result = { status: '완료', detail: '확인 답보다 먼저 온 다른 입력 — 접수 안 함' };
        } else {
          result = await conversation.handleConfirm(args, meta);
        }
      }
      else if (route === 'cancel') result = await cancelRoute(args, meta);
      if (!result) result = await buildHandlers(meta, lane)(route, args);
      // 종료로 끊긴 건은 '처리중'으로 둔다 — 재시작 때 확인필요 안내 경로를 탄다.
      if (!result.interruptedByShutdown) inbox.markStatus(item.updateId, result.status, result.detail ?? '');
      journal?.append({ type: 'det', route, status: result.status, detail: String(result.detail ?? '').slice(0, 200) });
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
    return inbox.pending().find((item) => laneOf(routeOf(item)) === lane) ?? null;
  }

  // 대화 줄: 쌓인 대화 입력을 모두 집어 한 번에 처리한다(Q6). 고르는 즉시 전부 '처리중'.
  async function processLlmBatch() {
    if (state.llmBusy) return false;
    const batch = llmQueue();
    if (!batch.length) return false;
    state.llmBusy = true;
    const items = [];
    for (const item of batch) {
      const decision = routeOf(item);
      inbox.markStatus(item.updateId, '처리중', 'llm');
      items.push({ updateId: item.updateId, meta: decision.meta, args: decision.args });
    }
    state.processing.llm = { updateIds: items.map((i) => i.updateId), since: now().toISOString() };
    conversation.setQueued(0);
    try {
      // 확인 질문 뒤에 온 대화가 있으면 다른 주제로 닫는다(질문 전에 보낸 대화는 닫지 않음).
      const openSince = confirmOpenSince();
      if (openSince !== null && items.some((i) => Number.isFinite(i.meta.date) && i.meta.date > openSince)) {
        await conversation.closeConfirm('다른 주제', items[0].meta.chatId);
      }
      const result = await conversation.processBatch(items);
      // 관문 종료로 끊긴 대화는 '처리중'으로 둔다 — 재시작 때 확인필요 안내로 간다.
      if (!result.interruptedByShutdown) for (const item of items) inbox.markStatus(item.updateId, result.status, result.detail ?? '');
    } catch (error) {
      for (const item of items) inbox.markStatus(item.updateId, '실패', error.message);
      log(`[gate] 대화 줄 실패: ${error.message}`);
    } finally {
      state.processing.llm = null;
      state.llmBusy = false;
    }
    return true;
  }

  // 약속 이행(LLM 보고형): 대화 줄이 쉬고 있을 때만 같은 하루 세션으로 한 번 돌린다. 바쁘면 null — 다음 1분 점검에서 다시.
  function runPromiseLlm(promise, describe) {
    if (!conversation || state.llmBusy || conversation.isRunning()) return null;
    state.llmBusy = true;
    const item = { updateId: null, meta: { chatId: gate.config.chatId, messageId: null, date: Math.floor(now().getTime() / 1000) },
      args: { kind: 'promise', text: `약속 이행 시점이다: ${promise.text}\n조건 충족: ${describe(promise)}` } };
    return conversation.processBatch([item]).finally(() => { state.llmBusy = false; });
  }

  async function workerLoop(lane = 'main') {
    while (!state.stopping) {
      if (lane === 'llm' && conversation) {
        if (!(await processLlmBatch())) {
          await new Promise((r) => { const done = () => { waiters.delete(done); clearTimeout(t); r(); }; const t = setTimeout(done, 1000); waiters.add(done); });
        }
        continue;
      }
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
        if (fresh) {
          // 대화 실행 중에 새 대화 입력이 오면 진행 메시지에 대기 건수를 보인다.
          if (conversation?.isRunning()) conversation.setQueued(llmQueue().length);
          wakeAll();
        }
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

  async function minuteTick() {
    if (promiseRunner) await promiseRunner.tick().catch((e) => log(`[gate] 약속 점검 실패: ${e.message}`));
    if (!conversation) return;
    await conversation.closeConfirm('만료', gate.config.chatId);
    await conversation.checkCooldownRelease(gate.config.chatId);
    await conversation.writeHandoffIfDue(now());
  }

  return {
    state,
    processItem,
    processLlmBatch,
    runPromiseLlm,
    minuteTick,
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
      // 대화도 멈춘다(세션은 다음 --resume에서 이어진다). 끊긴 대화 입력은 재시작 때 확인필요 안내로 간다.
      conversation?.cancel();
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
        try {
          inbox.compact();
          pruneGateMedia(gateMediaDir(gate.stateDir), { now: now() });
          if (gate.llmMediaDir) pruneGateMedia(gate.llmMediaDir, { now: now() });
        } catch (e) { log(`[gate] 정리 실패: ${e.message}`); }
      }, MAINTENANCE_INTERVAL_MS);
      const watchdog = setInterval(() => {
        const reason = watchdogCheck();
        if (reason) { log(`[gate] 감시견: ${reason} — 종료(launchd가 다시 띄움)`); exit(1); }
      }, WATCHDOG_INTERVAL_MS);
      const beat = setInterval(() => { heartbeat().catch((e) => log(`[gate] 하트비트 실패: ${e.message}`)); }, HEARTBEAT_INTERVAL_MS);
      // 1분 틱: 확인 대기 만료, 업무일이 바뀌면 전날 인수인계 노트.
      const tick = setInterval(() => { minuteTick().catch((e) => log(`[gate] 1분 점검 실패: ${e.message}`)); }, TICK_INTERVAL_MS);
      try {
        // 첫 하트비트는 5분 뒤 — 시작 직후엔 수신 성공 전이라 FAIL로 남아 재시작마다 잡음이 생긴다.
        await Promise.all([pollLoop(), workerLoop('main'), workerLoop('media'), workerLoop('llm')]);
      } finally {
        clearInterval(tick);
        clearInterval(watchdog);
        clearInterval(beat);
        clearInterval(maintenance);
      }
    },
  };
}

// 안녕 점검: 관문 수신 정상 + 2단계 LLM 경로의 전제(claude 실행 파일, 사용량 쿨다운 없음). LLM은 부르지 않는다.
export function gateSelfCheck({ state, now, claudeBin = resolveClaudeBin(), exists = existsSync, cooldown = getCooldown(), lastRun = null }) {
  const problems = [];
  if (lastRun && lastRun.ok === false) problems.push(`마지막 대화 처리가 ${lastRun.status}로 끝남`);
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

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// 대화 줄 조립(실제 네트워크·프로세스). 시험은 createConversation에 가짜를 넣는다.
function buildConversationDeps({ gate, options, journal, confirmStore }) {
  // 시험 모드면 관문 MCP 도구가 외부 서비스(구글 캘린더·할 일)에 쓰지 않게 모드를 넘긴다(2단계 리뷰 MEDIUM).
  const mediaDir = gate.llmMediaDir;
  const spawnEnv = {
    ...buildGateSpawnEnv(process.env, { stateDir: gate.stateDir }),
    TELEGRAM_GATE_MODE: gate.mode,
    // 읽기 경로 제한 훅의 허용 뿌리(볼트·저장소·사진 폴더)와 금고(2단계 리뷰 HIGH-3).
    ...buildGateReadEnv({ vaultRoot: VAULT_ROOT, mediaDir, adytonDir: vaultAbs(VAULT_REL.adytonRoot) }),
  };
  const handoffPath = (day) => handoffNoteRelPath(VAULT_PATHS.log.telegramSession, day);
  const send = (message, chatId) => sendAgentMessage(message, chatId, options);
  return {
    send,
    // 인수인계 노트를 반복해서 못 쓰면 알린다. 실전은 경고 원장, 시험은 원장 없이 시험 봇으로만.
    warn: gate.mode === 'live'
      ? createDirectWarningSender(sendAgentMessage, { jobName: 'telegram-gate', warningCode: 'TELEGRAM_GATE_HANDOFF', subjectKey: 'telegram-gate-handoff', kind: 'operational', severity: 'medium' })
      : (message) => send(message, gate.config.chatId),
    edit: (messageId, message, chatId) => editAgentMessage(messageId, message, chatId, options),
    del: (messageId, chatId) => deleteTelegramMessage({ chatId, messageId }, options),
    downloadPhoto: async (fileId) => {
      const file = await getTelegramFile(fileId, options);
      const buffer = await downloadTelegramFile(file.file_path, options);
      mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
      const path = join(mediaDir, `${Date.now()}-${String(file.file_unique_id ?? 'photo').replace(/[^A-Za-z0-9_-]/g, '_')}.jpg`);
      writeAtomic(path, buffer);
      return path;
    },
    runner: ({ args, env, onEvent }) => runGateClaude({ args, env, onEvent }),
    spawnEnv,
    cooldown: () => getCooldown(),
    readRules: () => ({
      inputRules: readText(vaultAbs(VAULT_REL.telegramInputRulesFile)) ?? '',
      sessionRules: readText(vaultAbs(VAULT_REL.telegramChannelFile)) ?? '',
    }),
    readHandoff: (day) => {
      const text = readText(handoffPath(day));
      return text ? text.replace(/^---\n[\s\S]*?\n---\n/, '').trim() : null;
    },
    writeHandoff: (day, content) => {
      const path = handoffPath(day);
      // 멱등: 같은 날 노트가 이미 있으면 덮어쓰지 않는다(겹친 호출·옛 잡과의 충돌, 2단계 리뷰 HIGH-2).
      if (existsSync(path)) return;
      // 볼트 쓰기 관문과 같은 검사(경로 등록부). 어긋나면 쓰지 않는다.
      const problems = checkNote(relative(VAULT_PATHS.root, path), content, parseRegistry(readFileSync(vaultAbs(VAULT_REL.registryFile), 'utf8')));
      if (problems.length) throw new Error(`등록부 검사 실패: ${problems.join('; ')}`);
      mkdirSync(dirname(path), { recursive: true });
      writeAtomic(path, content);
    },
    summarize: async (day, entries) => {
      // 요약은 3분 안에 끝나야 한다(겹침 방지와 함께 사용량 보호, 2단계 리뷰 HIGH-2).
      const res = await runGateClaude({ args: buildHandoffSummaryArgs(day, entries), env: spawnEnv, hardTimeoutMs: 3 * 60 * 1000 }).promise;
      if (res.isError || !res.structured) throw new Error(res.isError ? '요약 실행 실패' : '요약 구조화 출력 없음');
      return res.structured;
    },
    // 확인 문구에 "실제 주문이 나간다"를 붙일지. 파일이 없거나 이상하면 섀도우로 본다(shadow-mode 안전 기본값).
    isLive: () => !isShadowMode(readText(VAULT_PATHS.state.executionMode) ?? ''),
    mcpToolNames: gateMcpToolNames(createGateMcpTools()),
    journal,
    sessionStore: createSessionStore({ stateDir: gate.stateDir }),
    confirmStore,
    log: (line) => console.log(line),
  };
}

function selfTest() {
  const claudeBin = resolveClaudeBin();
  let claudeVersion = '(확인 실패)';
  try { claudeVersion = execFileSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim(); } catch { /* 출력만 */ }
  console.log(JSON.stringify({ node: process.version, execPath: process.execPath, claudeBin, claudeVersion, PATH: process.env.PATH }, null, 2));
}

export const GATE_USAGE = [
  '사용법: node scripts/jobs/telegram-gate.mjs --mode=test|live | --self-test | --help',
  '  --mode=test   시험 봇(시험 볼트로 격리)',
  '  --mode=live   실전 — 전환 뒤 launchd만. TELEGRAM_GATE_LIVE_CUTOVER=1·launchd 실행·plist 등록·상시 세션 없음이 모두 필요',
  '  --self-test   네트워크 없이 실행 환경만 출력',
].join('\n');
export const GATE_LIVE_LABEL = 'com.banana2.telegram-gate';

// 순수 함수: 인자 해석. 모르는 인자·중복·값 없는 --mode는 오류. { action: 'help'|'self-test'|'run', mode } 또는 { error }.
export function parseGateArgs(argv) {
  if (argv.some((a) => a === '--help' || a === '-h')) return { action: 'help' };
  const unknown = argv.filter((a) => a !== '--self-test' && !/^--mode=(test|live)$/.test(a));
  if (unknown.length) return { error: `모르는 인자: ${unknown.join(' ')}` };
  const modes = argv.filter((a) => a.startsWith('--mode='));
  if (argv.includes('--self-test')) return modes.length ? { error: '--self-test는 --mode와 함께 쓰지 않습니다' } : { action: 'self-test' };
  if (modes.length !== 1) return { error: modes.length ? '--mode는 한 번만' : '--mode=test 또는 --mode=live가 필요합니다(기본값 없음)' };
  return { action: 'run', mode: modes[0].slice(7) };
}

// 순수 함수: launchctl print 출력에서 실행 중인 pid(최상위 "\tpid = N" 줄). 없으면 null(등록만 돼 있고 안 도는 상태 포함).
export function parseLaunchdPid(text) {
  const m = /^\tpid = (\d+)$/m.exec(String(text ?? ''));
  return m ? Number(m[1]) : null;
}

// 순수 함수: 실전 시작 허용 여부. { ok, reasons: [{ code, text }], rivalOnly }.
// - launchd: launchctl print 결과 { loaded, pid }. 실전은 launchd가 이 라벨로 띄운 프로세스만 — launchd가 아는 pid가
//   자기 자신이나 부모(run.sh bash)여야 한다. XPC_SERVICE_NAME은 bash로 run.sh를 감싸는 잡에서 0으로 들어와 쓸 수 없다(재리뷰 HIGH 실측).
// - processes: telegram-session-liveness의 프로세스 표. 상시 세션(claude --channels telegram)·텔레그램 플러그인 폴러(bun)·
//   다른 관문(시험·자가 점검이 아닌 telegram-gate.mjs 줄 — 옛 코드의 인자 없는 실행·--help 실행도 실전이었다)이 있으면 409가 난다.
// - 경쟁자는 실제 실행 파일로 좁힌다: 상시 세션은 claude(버전 경로 ~/.local/share/claude/versions/… 포함) 또는 node로 띄운 claude,
//   플러그인은 bun 또는 node, 관문은 node 또는 bun(버전 붙은 이름 포함). 명령 문자열에 그 이름을 담기만 한 셸 래퍼(sh -c·zsh -c —
//   감시 명령, Claude 세션의 Bash 도구)와 pgrep·grep 같은 감시 명령은 실행 파일이 달라 저절로 빠진다(실측: 도구 래퍼가 걸렸다).
//   줄 전체에서 감시 도구 이름을 찾아 빼지 않는다 — 진짜 세션 인자에 그 단어가 있으면 놓치기 때문(재리뷰 2차 L1).
// - 표가 비었거나 자기 자신이 없으면 제대로 읽지 못한 것으로 보고 거부한다(fail-closed).
const GATE_SCRIPT_RE = /telegram-gate\.mjs\b/;
const NON_LIVE_GATE_RE = /--mode=test\b|--self-test\b/;
const PLUGIN_PATH_RE = /\/plugins\/\S*\/telegram\//; // 플러그인을 bun 대신 node로 띄워도 플러그인 폴더 경로로 알아본다
const firstToken = (args) => String(args).trim().split(/\s+/)[0];
const executableOf = (args) => firstToken(args).split('/').pop();
const isNodeLike = (exe) => /^(node|bun)(\d[\w.-]*)?$/.test(exe);
const isClaudeExe = (args) => executableOf(args) === 'claude' || firstToken(args).includes('/claude/versions/');
export function decideLiveStart({ env = {}, launchd = { loaded: false, pid: null }, processes = [], selfPid = null, parentPid = null }) {
  const reasons = [];
  if (env.TELEGRAM_GATE_LIVE_CUTOVER !== '1') reasons.push({ code: 'NO_CUTOVER_FLAG', text: 'TELEGRAM_GATE_LIVE_CUTOVER=1이 없음(4단계 전환 때만 plist에 넣는다)' });
  if (!launchd.loaded) reasons.push({ code: 'NOT_LOADED', text: `launchd에 ${GATE_LIVE_LABEL}이 등록돼 있지 않음` });
  else if (launchd.pid === null || (launchd.pid !== selfPid && launchd.pid !== parentPid)) {
    reasons.push({ code: 'NOT_LAUNCHD', text: `launchd(${GATE_LIVE_LABEL})가 띄운 프로세스가 아님(launchd pid ${launchd.pid ?? '없음'}) — 실전은 터미널에서 띄우지 않는다` });
  }
  if (!processes.length || (selfPid !== null && !processes.some((p) => p.pid === selfPid))) {
    reasons.push({ code: 'PS_UNREADABLE', text: '프로세스 표를 확인하지 못함(비었거나 자기 자신이 없음)' });
  }
  const sessionRe = new RegExp(TELEGRAM_SESSION_PROCESS_PATTERN);
  const pluginRe = new RegExp(TELEGRAM_MCP_SUBPROCESS_PATTERN);
  const rivals = processes.filter((p) => {
    if (p.pid === selfPid || p.pid === parentPid) return false;
    const exe = executableOf(p.args);
    return ((isClaudeExe(p.args) || isNodeLike(exe)) && sessionRe.test(p.args))
      || (isNodeLike(exe) && (pluginRe.test(p.args) || PLUGIN_PATH_RE.test(p.args)))
      || (isNodeLike(exe) && GATE_SCRIPT_RE.test(p.args) && !NON_LIVE_GATE_RE.test(p.args));
  });
  if (rivals.length) reasons.push({ code: 'RIVAL', text: `텔레그램 상시 세션·플러그인 폴러·다른 관문이 살아 있음(pid ${rivals.map((p) => p.pid).join(', ')})` });
  return { ok: reasons.length === 0, reasons, rivalOnly: reasons.length > 0 && reasons.every((r) => r.code === 'RIVAL') };
}

// 읽기만 한다(launchctl print). 등록돼 있지 않거나 시간 초과·실행 실패면 { loaded: false }(막는 쪽).
export function readLaunchdGate({ uid = typeof process.getuid === 'function' ? process.getuid() : null, run = spawnSync } = {}) {
  if (uid === null) return { loaded: false, pid: null };
  try {
    const res = run('launchctl', ['print', `gui/${uid}/${GATE_LIVE_LABEL}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    if (res.status !== 0) return { loaded: false, pid: null };
    return { loaded: true, pid: parseLaunchdPid(res.stdout) };
  } catch { return { loaded: false, pid: null }; }
}

// 프로세스 표를 못 읽으면 빈 표 — decideLiveStart가 확인 실패로 거부한다.
export function readProcessTableSafe({ read = readProcessTable } = {}) {
  try { return read(); } catch { return []; }
}

// 거부를 관문 상태 폴더 refusal.json에 짧은 코드와 함께 남긴다. heartbeat.json과 분리한다 — 바깥 감시(telegram-gate-health-check)가
// 하트비트를 '살아 있음'으로 읽어 15분마다 재시작·경고를 되풀이하지 않게, 거부는 따로 읽어 재시작 없이 한 번만 알린다(재리뷰 2차 M1).
// 상태 폴더가 없으면 만들지 않는다(관문이 한 번도 안 돈 기계에서 바깥 감시의 '폴더 없으면 건너뜀'을 깨지 않게). 실패해도 거부는 그대로.
export function writeRefusalRecord(decision, { env = process.env, now = () => new Date(), pid = process.pid } = {}) {
  try {
    const dir = env.TELEGRAM_GATE_STATE_DIR || defaultGatePaths().liveStateDir;
    if (!existsSync(dir)) return false;
    const codes = decision.reasons.map((r) => r.code);
    writeAtomic(join(dir, 'refusal.json'), `${JSON.stringify({ at: now().toISOString(), codes, detail: `LIVE_REFUSED ${codes.join(',')}`, pid, mode: 'live' })}\n`);
    return true;
  } catch { return false; }
}

// 진입점: 인자·가드를 통과해야만 launch(실제 수신 시작)를 부른다. 종료코드를 돌려준다(시작하면 데몬이 끝날 때까지 기다린다).
// 거부는 exit 0: plist KeepAlive가 {SuccessfulExit:false}라 다시 띄우지 않는다(10초마다 거부·FAIL 반복 방지).
// 로그 한 줄은 'LIVE_REFUSED 코드…'로 시작해 run.sh가 JobHealth detail 앞에 남긴다(상태는 OK라 detail로 구분). 상태 폴더에는 refusal.json.
// 같은 이유로 SIGTERM 정상 종료(사람이 node에 TERM)도 다시 띄우지 않는다 — 의도다. 다시 올리기는 kickstart -k(관문 health-check가 쓰는 방식).
export async function main({ argv = process.argv.slice(2), env = process.env, out = console,
  liveChecks = () => ({ launchd: readLaunchdGate(), processes: readProcessTableSafe() }),
  launch = launchGate, runSelfTest = selfTest, wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  recordRefusal = (decision) => writeRefusalRecord(decision, { env }) } = {}) {
  const parsed = parseGateArgs(argv);
  if (parsed.error) { out.error(`[gate] ${parsed.error}\n${GATE_USAGE}`); return 2; }
  if (parsed.action === 'help') { out.log(GATE_USAGE); return 0; }
  if (parsed.action === 'self-test') { runSelfTest(); return 0; }
  if (parsed.mode === 'live') {
    const check = () => decideLiveStart({ env, ...liveChecks(), selfPid: process.pid, parentPid: process.ppid });
    let decision = check();
    // 경쟁자만 걸렸으면 1초 뒤 다시 읽어 두 번 다 걸릴 때만 거부한다(잠깐 스친 프로세스로 재시작 없는 정지가 되지 않게).
    if (!decision.ok && decision.rivalOnly) { await wait(1000); decision = check(); }
    if (!decision.ok) {
      // 상태 파일은 launchd가 띄운 관문일 때만 쓴다 — 터미널에서 잘못 띄운 실행이 돌고 있는 실전 관문의 하트비트를 덮지 않게.
      if (!decision.reasons.some((r) => r.code === 'NOT_LAUNCHD' || r.code === 'NOT_LOADED')) recordRefusal(decision);
      out.error(`LIVE_REFUSED ${decision.reasons.map((r) => r.code).join(',')} [gate] 실전 시작 거부 — 수신을 시작하지 않습니다: ${decision.reasons.map((r) => r.text).join(' / ')}`);
      return 0;
    }
  }
  await launch(parsed.mode);
  return 0;
}

async function launchGate(mode) {
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
  const journal = createJournal({ stateDir: gate.stateDir, dayOf: businessDay });
  const confirmStore = createConfirmStore({ stateDir: gate.stateDir });
  let daemonRef = null;
  let promiseRunner = null;
  const conversationDeps = buildConversationDeps({ gate, options, journal, confirmStore });
  const conversation = createConversation({
    ...conversationDeps,
    isStopping: () => Boolean(daemonRef?.state.stopping),
    listPendingPromises: () => promiseRunner?.pendingForHandoff() ?? null,
  });
  promiseRunner = createPromiseRunner({
    store: createPromiseStore({ vaultFile: vaultAbs(VAULT_REL.telegramGatePromises), requestDir: promiseRequestDir(gate.stateDir) }),
    knownJobs: Object.keys(JOB_LABELS),
    // 보낸 약속 기록(볼트 밖) — 볼트 기록 전에 관문이 재시작돼도 다시 보내지 않게(3단계 리뷰 M1).
    firedLog: createFiredLog(join(gate.stateDir, 'promise-fired.json')),
    jobHealth: (job) => {
      const text = readText(join(VAULT_PATHS.state.jobHealth, `${job}.md`));
      return text ? parseFrontmatter(text) : null;
    },
    // 약속 조건의 파일 경로는 볼트 상대 경로로만 받는다(금고 제외, validateTrigger). 링크로 볼트 밖을 가리키면 보지 않는다(리뷰 L4).
    fileMtime: (path) => {
      try {
        const real = realpathSync(vaultAbs(path));
        const root = realpathSync(VAULT_ROOT);
        return real.startsWith(`${root}/`) ? statSync(real).mtimeMs : null;
      } catch { return null; }
    },
    send: conversationDeps.send,
    chatId: gate.config.chatId,
    runLlm: (promise) => daemonRef?.runPromiseLlm(promise, (p) => `${describeTrigger(p.trigger)}${p.or ? ` 또는 ${describeTrigger(p.or)}` : ''}`) ?? null,
    cooldown: () => getCooldown(),
    log: (line) => console.log(line),
  });
  const daemon = createGateDaemon({
    promiseRunner,
    conversation,
    confirmStore,
    journal,
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
    selfCheck: ({ state, now, lastRun }) => gateSelfCheck({ state, now, lastRun }),
    statusExtras: () => ({ cooldown: getCooldown(), freeMemPct: Math.round((freemem() / totalmem()) * 100) }),
    wiki: { resolve: resolveWikiQuestion, apply: applyWikiQuestion },
    writeHeartbeat: async (beat) => {
      writeAtomic(join(gate.stateDir, 'heartbeat.json'), `${JSON.stringify({ at: beat.at, healthy: beat.healthy, detail: beat.detail, pid: process.pid, mode: gate.mode })}\n`);
      // 시작 직후 기록은 볼트에 쓰지 않는다(수신 성공 전이라 FAIL로 남아 재시작마다 잡음). 바깥 감시용 상태 파일만.
      if (gate.heartbeatJob && !beat.startup) await writeVaultHeartbeat(gate.heartbeatJob, beat);
    },
    listPollers: listTelegramPollers,
  });
  daemonRef = daemon;
  installExitCleanup();
  console.log(`[gate] 시작 mode=${gate.mode} node=${process.version} claude=${resolveClaudeBin()} state=${gate.stateDir}`);
  const stop = (signal) => { console.log(`[gate] ${signal} — 종료`); daemon.stop(); setTimeout(() => process.exit(0), 10_000).unref(); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  await daemon.run();
}

const invokedPath = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return null; } })();
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().then((code) => { if (code) process.exit(code); })
    .catch((error) => { console.error(`[gate] 시작 실패: ${error.message}`); process.exit(1); });
}
