// 텔레그램 관문 대화 줄(llm lane) — 자유 문장·담당 호출·사진 판독을 헤드리스 claude 한 번으로 처리하고, 진행 메시지를 단계별로
// 고치고, 최종 답을 발송 관문으로 보내고, 확인 대기(돈 지시)와 하루 인수인계를 다룬다(2026-10-30, 관문 2단계).
// 설계 6·7·9절, 결정 `텔레그램-관문` 3~8항. 네트워크·프로세스는 모두 주입받는다(시험은 가짜로).
import { buildGateClaudeArgs, buildGateMcpConfig, buildGateOutputSchema, GATE_EFFORT, GATE_MODEL, SOFT_TIMEOUT_MS } from './telegram-gate-llm.mjs';
import { gateBuiltinTools, gateMcpToolsFor } from './telegram-gate-tool-table.mjs';
import { keywordTarget } from './telegram-gate-keywords.mjs';
import { AGENT_IDS, agentTitle } from './agent-registry.mjs';
import { applyProgress, createAnswerPreview, createEditThrottle, describeEvent, initialProgress, renderProgress } from './telegram-gate-progress.mjs';
import { buildDepartmentSystemPrompt, buildGateSystemPrompt, buildMessagePrompt, businessDay, createActorTracker, fallbackMessage, previousDay, toGateMessages } from './telegram-gate-session.mjs';
import { buildHandoffNote, conversationTranscript, handoffSummaryPrompt, HANDOFF_SUMMARY_SCHEMA } from './telegram-gate-journal.mjs';
import { confirmPromptBody, isAnswerToConfirm } from './telegram-gate-confirm.mjs';
import { fakeOrderExecutor } from './telegram-gate-order-executor.mjs';
import { escapeHtml } from './telegram.mjs';

const PROGRESS_TOPIC = '진행';
// 담당 프로세스 모델·노력: 헌장 runtimeModel(deps.departmentModel)이 없으면 sonnet. 조회·정리형이 대부분이라 노력은 medium
// (2026-11-06 실측: 조회형 목표 20초 안). 제우스는 결정 `텔레그램-관문` 3항 그대로(opus·medium).
export const DEPARTMENT_MODEL = 'sonnet';
export const DEPARTMENT_EFFORT = 'medium';
const DIRECT_LOG_MAX = 6;

// 순수 함수: 이 묶음을 어느 프로세스가 처음 받는지. 담당 이름으로 시작한 메시지 하나면 그 담당(창구가 제우스를 거치지 않고 바로 연결),
// 기호 없는 사진 하나면 클리오(판독 기록은 볼트 기록 = 클리오, B안), 나머지(여러 건 합침·자유 문장)는 제우스.
// departments: 담당 프로세스를 띄울 수 있는 담당(세션 저장소가 있는 것). 없으면 늘 제우스(예전 하위 에이전트 방식).
export function routeTarget(items, departments = []) {
  if (items.length !== 1) return 'zeus';
  const { args } = items[0];
  const byTitle = args.department ? AGENT_IDS.find((id) => agentTitle(id) === args.department) : null;
  // 이름으로 부르지 않은 오너 글은 낱말 표로 고른다(한 담당 낱말만·판단 질문 아님일 때만, 속도 개선 2차 A-2).
  const target = byTitle ?? (args.kind === 'photo' ? 'clio' : args.kind === 'text' ? (keywordTarget(args.text) ?? 'zeus') : 'zeus');
  return target !== 'zeus' && departments.includes(target) ? target : 'zeus';
}
const NO_CONVERSATION_RE = /No conversation found|no conversation/i;

function shortReason(res) {
  if (/limit|한도/i.test(res.errorText ?? '')) return '사용량 한도';
  return '처리 중 오류(창구 로그 참고)';
}

function kstTime(ms) {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

// 가짜 실행기(시험 모드 기본값). 실전 실행기는 telegram-gate-order-executor의 createOrderExecutor(mode=live)를 주입한다.
export { fakeOrderExecutor };

// deps: send(message, chatId) → Bot API 응답, edit(messageId, message, chatId), del(messageId, chatId), downloadPhoto(fileId) → path,
//       runner({args, env, onEvent}) → {promise, cancel}, spawnEnv, cooldown() → {resetAt}|null, readRules() → {inputRules, sessionRules},
//       readHandoff(day) → text|null, writeHandoff(day, content), journal, sessionStore, confirmStore, isLive() → bool, orderExecutor, mcpToolNames,
//       now, log, setTimer, clearTimer
// 순수 함수: 진행 메시지 시각 기록 한 줄. 지연은 관문이 받은 시각(inbox 저장, ms)부터 잰다 — 텔레그램 message.date는 초 단위로 잘리고
// 서버 시계 차이가 섞여서(리뷰 L1) 참고로만 남긴다. 0·null 같은 값은 쓰지 않는다(L2). kind·항목 수·대기 건수로 통계에서 거른다.
export function progressRecord(items, { sentAtMs, ok, queued = 0 }) {
  const earliest = (values) => { const v = values.filter((n) => Number.isFinite(n) && n > 0); return v.length ? Math.min(...v) : null; };
  const receivedMs = earliest(items.map((i) => Number(i.meta?.receivedAtMs)));
  const telegramSec = earliest(items.map((i) => Number(i.meta?.date)));
  return {
    type: 'progress', ok, sentAt: new Date(sentAtMs).toISOString(),
    kinds: [...new Set(items.map((i) => i.args?.kind ?? '?'))], items: items.length, queued,
    ...(receivedMs ? { receivedAt: new Date(receivedMs).toISOString(), delayMs: sentAtMs - receivedMs } : {}),
    ...(telegramSec ? { telegramDate: new Date(telegramSec * 1000).toISOString() } : {}),
  };
}

export function createConversation(deps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const orderExecutor = deps.orderExecutor ?? fakeOrderExecutor;
  // handoffFailures: 날짜별 { count, nextAt, warned } — 노트 쓰기 실패 뒤 백오프 재시도. handoffFallback: 쓰지 못한 날의 노트 본문
  // (다음 첫 대화에 직접 넣는다 — 인수인계가 조용히 사라지지 않게, 2단계 재리뷰 MEDIUM).
  const state = { running: null, queued: 0, lastRun: null, lastRateLimit: null, handoffDays: new Set(), handoffInFlight: null,
    handoffFailures: new Map(), handoffFallback: new Map(), directLog: [] };
  const isStopping = deps.isStopping ?? (() => false);

  const progressMessage = (body) => ({ agent: 'zeus', kind: '정보', topic: PROGRESS_TOPIC, body });

  function safeList(fn) {
    if (!fn) return null;
    try { return fn(); } catch (error) { log(`[gate] 약속 대기열 읽기 실패: ${error.message}`); return null; }
  }

  function safeSync(fn, label) {
    try { return fn(); } catch (error) { log(`[gate] ${label} 실패: ${error.message}`); return null; }
  }

  async function safe(fn, label) {
    try { return await fn(); } catch (error) { log(`[gate] ${label} 실패: ${error.message}`); return null; }
  }

  function setQueued(n) {
    state.queued = n;
    const run = state.running;
    if (run) {
      run.progress = { ...run.progress, queued: n };
      run.throttle?.update(renderProgress(run.progress, now().getTime()));
    }
  }

  const departments = () => (deps.sessionStoreFor ? AGENT_IDS.filter((id) => id !== 'zeus') : []);
  const storeFor = (agent) => (agent === 'zeus' ? deps.sessionStore : deps.sessionStoreFor(agent));
  // 도구 표를 적용할 담당. 담당 프로세스가 없는 옛 방식(시험 deps)에서는 제우스가 넘길 곳이 없으니 창구 도구 전부를 그대로 쓴다.
  const tableAgent = (agent) => (agent === 'zeus' && !departments().length ? null : agent);
  const allowedMcp = (agent) => {
    if (!tableAgent(agent)) return deps.mcpToolNames;
    const names = new Set(gateMcpToolsFor(agent));
    return deps.mcpToolNames.filter((n) => names.has(n.replace(/^mcp__gate__/, '')));
  };

  // 프로세스 하나의 실행 인자. 제우스: 입력 규칙 전체 + 넘김 안내, Agent 포함. 담당: 헌장 + 출력 계약, 읽기 도구 + 도구 표의 MCP만.
  function argsFor(agent, session, prompt) {
    const live = Boolean(deps.live);
    const rules = deps.readRules();
    const isZeus = agent === 'zeus';
    const handoffTo = isZeus ? departments() : [];
    return buildGateClaudeArgs({
      ...(live ? { streamInput: true } : { prompt }), sessionId: session.sessionId, resume: session.resume,
      appendSystemPrompt: isZeus ? buildGateSystemPrompt({ ...rules, handoffTo })
        : buildDepartmentSystemPrompt({ agent, charter: deps.readCharter?.(agent) ?? '', sessionRules: rules.sessionRules, vaultRoot: rules.vaultRoot }),
      tools: gateBuiltinTools(agent),
      allowedTools: [...gateBuiltinTools(agent), ...allowedMcp(agent)],
      mcpConfig: buildGateMcpConfig({ agent: tableAgent(agent) }),
      schema: buildGateOutputSchema({ agents: isZeus ? AGENT_IDS : [agent], handoffTo }),
      // 모델·노력은 결정 `텔레그램-관문` 3항(제우스 opus·medium). 실측 시험만 haiku로 낮춘다(deps.model).
      ...(deps.model ? { model: deps.model } : isZeus ? {} : { model: deps.departmentModel?.(agent) ?? DEPARTMENT_MODEL }),
      ...(deps.effort ? { effort: deps.effort } : isZeus ? {} : { effort: DEPARTMENT_EFFORT }),
    });
  }

  async function runOnce({ agent = 'zeus', items, session, handoffText, handoffMissing, run, directExchanges = [], handoffRequest = null, warmup = false, facts = null }) {
    const prompt = buildMessagePrompt({ items, handoffText, handoffMissing, now: now(), directExchanges, handoffRequest, warmup, facts });
    // 상시 실행(deps.live 풀)이면 프롬프트 없이 띄우고 메시지를 stdin으로 넣는다. 인자는 새로 띄울 때만 쓰인다.
    const live = deps.live ?? null;
    const args = argsFor(agent, session, prompt);
    if (run.cancelRequested) return { interrupted: 'cancel', isError: false, permissionDenials: [] };
    let started = false;
    const tracker = createActorTracker();
    const preview = createAnswerPreview();
    const store = storeFor(agent);
    store.markStarted?.(session.sessionId);
    const onEvent = (event) => {
      tracker.observe(event);
      if (event.type === 'system' && event.subtype === 'init') started = true;
      if (event.type === 'rate_limit_event') state.lastRateLimit = event.rate_limit_info ?? null;
      if (event.type === 'assistant' && !event.parent_tool_use_id) {
        for (const use of (event.message?.content ?? []).filter((c) => c?.type === 'tool_use' && c.name !== 'StructuredOutput')) {
          deps.journal.append({ type: 'tool', agent, name: use.name, input: JSON.stringify(use.input ?? {}).slice(0, 300) });
        }
      }
      // 실시간 답(B-7): 쓰고 있는 답을 진행 메시지에 흘린다(편집 빈도 제한은 throttle이 지킨다).
      const partial = preview.feed(event);
      run.progress = applyProgress(partial === null ? run.progress : { ...run.progress, preview: partial }, describeEvent(event));
      run.throttle.update(renderProgress(run.progress, now().getTime()));
    };
    const handle = live
      ? live.turn({ key: agent, day: session.day, sessionId: session.sessionId, args, env: deps.spawnEnv, text: prompt, onEvent })
      : deps.runner({ args, env: deps.spawnEnv, onEvent });
    run.cancel = handle.cancel;
    // 진행 메시지 발송·사진 내려받기 사이에 온 "취소"도 놓치지 않는다(2단계 리뷰 MEDIUM).
    if (run.cancelRequested) handle.cancel();
    const res = await handle.promise;
    if (started) store.recordTurn(session.sessionId);
    return { ...res, actors: tracker.actors() };
  }

  // 담당(또는 제우스) 한 턴: 그 담당 하루 세션을 열고, 이어 붙일 기록이 사라졌으면 같은 날 새 세션으로 한 번만 다시.
  // 인수인계 노트는 제우스 하루 대화에만 넣는다(담당 프로세스는 그날 처음 불릴 때 빈 대화로 시작한다).
  async function runAgentTurn({ agent, items, day, run, handoffRequest, warmup = false, facts = null }) {
    const store = storeFor(agent);
    const isZeus = agent === 'zeus';
    let session = store.forDay(day);
    let handoffText = null;
    let handoffMissing = false;
    if (isZeus && session.firstOfDay) {
      handoffText = deps.readHandoff(previousDay(day)) ?? state.handoffFallback.get(previousDay(day)) ?? null;
      handoffMissing = !handoffText;
    }
    const directExchanges = isZeus ? state.directLog.slice() : [];
    let res = await runOnce({ agent, items, session, handoffText, handoffMissing, run, directExchanges, handoffRequest, warmup, facts });
    if (res.isError && session.resume && NO_CONVERSATION_RE.test(res.errorText ?? '')) {
      session = store.reset(day);
      const text = isZeus ? deps.readHandoff(previousDay(day)) : null;
      res = await runOnce({ agent, items, session, handoffText: text, handoffMissing: isZeus && !text, run, directExchanges, handoffRequest, warmup, facts });
    }
    if (isZeus && !res.isError && !res.interrupted) state.directLog = [];
    return res;
  }

  async function processBatch(items) {
    const chatId = items[0].meta.chatId;
    const startedAt = now().getTime();
    const day = businessDay(now());
    const inputText = items.map((i) => i.args.text ?? i.args.caption ?? '').join(' / ');
    for (const item of items) deps.journal.append({ type: 'in', messageId: item.meta.messageId, kind: item.args.kind, text: String(item.args.text ?? item.args.caption ?? '').slice(0, 2000) });

    const run = { startedAt, progress: initialProgress({ startedAt, queued: state.queued }), cancel: null, cancelRequested: false, throttle: null, items };
    state.running = run;
    const firstText = renderProgress(run.progress, startedAt);
    const sent = await safe(() => deps.send(progressMessage(firstText), chatId), '진행 메시지 발송');
    const progressId = sent?.result?.message_id ?? null;
    const sentAtMs = now().getTime();
    run.throttle = createEditThrottle({
      initialText: firstText,
      edit: (text) => (progressId ? deps.edit(progressId, progressMessage(text), chatId) : Promise.resolve()),
      now: () => now().getTime(), setTimer, clearTimer, log,
    });
    const finishProgress = async (text) => {
      await run.throttle.close();
      if (progressId) await safe(() => deps.edit(progressId, progressMessage(text), chatId), '진행 메시지 마무리');
    };

    try {
      // 진행 메시지 첫 발송 시각을 남긴다 — "1초 안" 기준 측정용(2026-10-31 시험 봇 실측). try 안에서 하고 실패는 로그만:
      // 기록이 실패해도 finally가 state.running을 풀어야 한다(리뷰 M2).
      safeSync(() => deps.journal.append(progressRecord(items, { sentAtMs, ok: Boolean(progressId), queued: state.queued })), '진행 시각 기록');
      const cooldown = deps.cooldown();
      if (cooldown) {
        // 한도가 풀리면 관문이 먼저 알린다(Q11: 사용량 한도 해제 알림). 그래서 몇 건을 못 했는지 센다.
        state.cooldownRefused = (state.cooldownRefused ?? 0) + items.filter((i) => i.args.kind !== 'promise').length;
        await finishProgress(`사용량 한도 쿨다운 중이라 처리하지 않았습니다. ${kstTime(cooldown.resetAt)} 이후 한도가 풀리면 창구가 알려 드립니다.`);
        deps.journal.append({ type: 'llm', status: '쿨다운', input: inputText });
        state.lastRun = { ok: true, at: now().toISOString(), status: '쿨다운' };
        // refused: 약속 이행기가 "이행"으로 착각하지 않고 고정 문구로 대신하게(3단계 리뷰 M4).
        return { status: '완료', detail: '쿨다운 — 처리 안 함', refused: true };
      }

      for (const item of items) {
        if (item.args.kind !== 'photo') continue;
        try { item.imagePath = await deps.downloadPhoto(item.args.fileId); } catch (error) { item.imageError = '사진 내려받기 실패'; log(`[gate] 사진 받기 실패: ${error.message}`); }
      }

      // 업무일 첫 대화가 1분 점검보다 먼저 와도 인수인계가 빠지지 않게, 세션을 열기 전에 전날 노트를 먼저 챙긴다(2단계 리뷰 MEDIUM).
      if (!state.handoffDays.has(previousDay(day))) {
        run.progress = applyProgress(run.progress, { step: '전날 인수인계 정리 중' });
        run.throttle.update(renderProgress(run.progress, now().getTime()));
      }
      await writeHandoffIfDue(now());
      deps.confirmStore.setActiveBatch?.(items.map((i) => i.meta.messageId));
      const soft = setTimer(() => {
        run.progress = { ...run.progress, slow: true };
        run.throttle.update(renderProgress(run.progress, now().getTime()));
      }, SOFT_TIMEOUT_MS);
      // 단계: 처음 받는 프로세스(routeTarget) → 제우스가 handoff로 넘기면 그 담당 프로세스(한 번만). 한 번에 한 턴씩(직렬).
      // "{담당} 호출" 뒤 다음 메시지 하나(30분 안)는 그 담당이 바로 받는다(호출한 프로세스로 이어 넣기).
      // 오너가 직접 친 글(kind text, 수신 기록 있음)에만 적용·소거한다 — 약속 이행·사진·전달은 직통 상태를 쓰지 않는다(리뷰 MEDIUM).
      const ownerText = items.some((i) => i.args.kind === 'text' && i.updateId != null);
      const pinned = ownerText && items.length === 1 && !items[0].args.department && state.pinned && now().getTime() < state.pinned.until
        ? state.pinned.agent : null;
      if (ownerText) state.pinned = null;
      let agent = pinned && departments().includes(pinned) ? pinned : routeTarget(items, departments());
      let handoffRequest = null;
      let sentCount = 0;
      // 재료 미리 붙이기(B-5): 오너 글에서 날짜·낱말로 사실을 Node로 읽어 [창구 사실]로 붙인다(넘김 단계에도 같은 사실).
      const ownerTexts = items.filter((i) => i.args.kind === 'text').map((i) => i.args.text ?? '').join('\n');
      const facts = ownerTexts.trim() ? safeSync(() => deps.prefetch?.(ownerTexts) ?? null, '사실 미리 읽기') : null;
      if (facts) deps.journal.append({ type: 'prefetch', chars: facts.length });
      try {
        for (let stage = 0; agent; stage += 1) {
          if (agent !== 'zeus') {
            run.progress = applyProgress(run.progress, { step: handoffRequest ? `${agentTitle(agent)}에게 넘김` : `${agentTitle(agent)} 직통` });
            run.throttle.update(renderProgress(run.progress, now().getTime()));
          }
          deps.journal.append({ type: 'route', agent, via: handoffRequest ? 'handoff' : stage === 0 && agent !== 'zeus' ? 'direct' : 'zeus' });
          const res = await runAgentTurn({ agent, items, day, run, handoffRequest, facts });

          const seconds = Math.round((now().getTime() - startedAt) / 1000);
          const lastStep = run.progress.steps.at(-1) ?? run.progress.stage;
          if (res.permissionDenials?.length) {
            log(`[gate] 허용되지 않은 도구 요청 ${res.permissionDenials.length}건: ${res.permissionDenials.map((d) => d.tool_name).join(', ')}`);
            deps.journal.append({ type: 'denied', agent, tools: res.permissionDenials.map((d) => d.tool_name) });
          }
          if (res.interrupted && res.interrupted !== 'timeout') {
            dropUnannouncedConfirm(startedAt);
            if (isStopping()) {
              // 관문 재시작으로 끊김 — 입력은 '처리중'으로 남겨 재시작 때 확인필요 안내로 간다.
              await finishProgress('창구가 다시 시작되느라 멈췄습니다. 재시작 뒤 안내를 확인해 주세요.');
              deps.journal.append({ type: 'llm', status: '중단', input: inputText });
              return { status: '중단', detail: '창구 종료로 끊김', interruptedByShutdown: true };
            }
            await finishProgress(`취소함(경과 ${seconds}초, 마지막 단계: ${escapeHtml(lastStep)})`);
            deps.journal.append({ type: 'llm', status: '취소', input: inputText });
            state.lastRun = { ok: true, at: now().toISOString(), status: '취소' };
            return { status: '완료', detail: '취소' };
          }
          if (res.interrupted === 'timeout') {
            dropUnannouncedConfirm(startedAt);
            await finishProgress(`시간 초과로 멈췄습니다(${Math.round(seconds / 60)}분, 마지막 단계: ${escapeHtml(lastStep)}). 다시 보내 주세요.`);
            deps.journal.append({ type: 'llm', status: '시간 초과', input: inputText });
            state.lastRun = { ok: false, at: now().toISOString(), status: '시간 초과' };
            return { status: '실패', detail: '시간 초과' };
          }
          if (res.isError) {
            dropUnannouncedConfirm(startedAt);
            await finishProgress(`처리하지 못했습니다(${shortReason(res)}).`);
            deps.journal.append({ type: 'llm', status: '실패', input: inputText, error: String(res.errorText ?? '').slice(0, 300) });
            state.lastRun = { ok: false, at: now().toISOString(), status: '실패' };
            log(`[gate] 대화 실패: ${res.errorText}`);
            return { status: '실패', detail: String(res.errorText ?? '').slice(0, 200) };
          }

          // 이름표는 창구가 정한다: 이 프로세스(self)와 이 턴에 실제로 답한 하위 에이전트만 그 담당 이름을 단다(2026-11-06 오너).
          // 넘김은 제우스 첫 단계에서만 받는다(담당끼리 다시 넘기지 않는다 — 고리 방지).
          const { messages, problem, handoff } = toGateMessages(res.structured, res.result,
            { labels: { self: agent, actors: res.actors ?? [] }, handoffTo: agent === 'zeus' && stage === 0 ? departments() : [] });
          const outgoing = problem ? [fallbackMessage(res.result, agent)] : messages;
          if (problem) {
            log(`[gate] 출력 계약 위반(${problem}) — 원문을 감싸 보냄`);
            deps.journal.append({ type: 'contract', agent, problem });
          }
          if (!handoff) await run.throttle.close();
          try {
            for (const message of outgoing) {
              await deps.send(message, chatId);
              sentCount += 1;
              deps.journal.append({ type: 'out', agent: message.agent, text: String(message.body ?? message.conclusion ?? (message.facts ?? []).join(' / ')).slice(0, 2000) });
            }
          } catch (error) {
            // 최종 답을 못 보냈어도 확인 질문은 보낸다 — 확인 문구는 코드가 만든 자기완결 문장이라 답 없이도 뜻이 통한다
            // (제우스 방향, 2단계 리뷰 MEDIUM). 진행 메시지에 실패를 남긴다.
            await safe(() => announceStagedConfirm(startedAt, chatId), '확인 질문 발송');
            await finishProgress('답을 만들었지만 보내지 못했습니다. 다시 보내 주세요.');
            deps.journal.append({ type: 'llm', status: '실패', input: inputText, error: `발송 실패: ${String(error?.message ?? error).slice(0, 200)}` });
            state.lastRun = { ok: false, at: now().toISOString(), status: '발송 실패' };
            log(`[gate] 최종 답 발송 실패: ${error.message}`);
            return { status: '실패', detail: '최종 답 발송 실패' };
          }
          // 제우스가 모르는 담당 대화(직통·넘김)는 다음 제우스 턴에 참고로 넘긴다.
          if (agent !== 'zeus') {
            const output = outgoing.map((m) => String(m.body ?? m.conclusion ?? (m.facts ?? []).join(' / '))).join(' / ').replace(/<[^>]+>/g, '');
            state.directLog = [...state.directLog, { agent, input: handoffRequest ? `(${agentTitle('zeus')} 넘김) ${handoffRequest}` : inputText, output }].slice(-DIRECT_LOG_MAX);
          }
          agent = handoff?.agent ?? null;
          handoffRequest = handoff?.request ?? null;
        }
      } finally {
        clearTimer(soft);
      }
      const seconds = Math.round((now().getTime() - startedAt) / 1000);
      if (progressId) {
        const deleted = await safe(() => deps.del(progressId, chatId), '진행 메시지 삭제');
        if (deleted === null) await safe(() => deps.edit(progressId, progressMessage(`처리 끝(${seconds}초)`), chatId), '진행 메시지 마무리');
      }
      deps.journal.append({ type: 'llm', status: '완료', input: inputText, seconds });
      state.lastRun = { ok: true, at: now().toISOString(), status: '완료' };
      await announceStagedConfirm(startedAt, chatId);
      return { status: '완료', detail: `대화 ${sentCount}건 답` };
    } finally {
      run.throttle?.close();
      deps.confirmStore.setActiveBatch?.(null);
      state.running = null;
    }
  }

  // "호출"·"{담당} 호출"(2026-11-06 오너): 그 상시 프로세스를 미리 띄우고 아주 짧은 예열 턴으로 init·캐시까지 마친 뒤 결정론 답장.
  // 예열 턴 답은 오너에게 보내지 않는다. 이미 떠 있으면 "이미 준비됨". 담당 호출이면 다음 메시지 하나를 그 담당으로 보낸다.
  // 상시 실행이 아니면(시험 deps) 띄울 프로세스가 없으니 안내만 한다.
  async function warmup({ agent: wanted = 'zeus' }, meta) {
    const agent = wanted !== 'zeus' && departments().includes(wanted) ? wanted : 'zeus';
    const reply = (body) => deps.send({ agent, kind: '정보', topic: '호출', body }, meta.chatId);
    const startedAt = now().getTime();
    // 새 호출은 앞 담당 직통을 지운다. 직통은 준비가 끝났을 때만 건다(쿨다운·실패면 걸지 않음, 리뷰 LOW).
    state.pinned = null;
    const pin = () => { if (agent !== 'zeus') state.pinned = { agent, until: now().getTime() + 30 * 60_000 }; };
    const pinnedNote = agent !== 'zeus' ? `\n· 다음 메시지 하나는 ${agentTitle(agent)}가 바로 받습니다.` : '';
    if (!deps.live) {
      await reply('상시 실행이 꺼져 있어 미리 띄울 프로세스가 없습니다.');
      return { status: '완료', detail: '호출 — 상시 실행 없음' };
    }
    const cooldown = deps.cooldown();
    if (cooldown) {
      await reply(`사용량 한도 쿨다운 중이라 띄우지 않았습니다. ${kstTime(cooldown.resetAt)} 이후 다시 보내 주세요.`);
      return { status: '완료', detail: '호출 — 쿨다운' };
    }
    const day = businessDay(now());
    await writeHandoffIfDue(now());
    const session = storeFor(agent).forDay(day);
    if (deps.live.isWarm({ key: agent, day, sessionId: session.sessionId })) {
      pin();
      await reply(`이미 준비됨${pinnedNote}`);
      deps.journal.append({ type: 'warmup', agent, status: '이미 준비됨' });
      return { status: '완료', detail: '호출 — 이미 준비됨' };
    }
    const run = { startedAt, progress: initialProgress({ startedAt, queued: 0 }), cancel: null, cancelRequested: false,
      throttle: { update() {}, close: async () => {} }, items: [] };
    state.running = run;
    let res;
    try {
      res = await runAgentTurn({ agent, items: [], day, run, handoffRequest: null, warmup: true });
    } finally {
      state.running = null;
    }
    const seconds = Math.round((now().getTime() - startedAt) / 1000);
    if (res.interrupted || res.isError) {
      const why = res.interrupted ? '취소' : shortReason(res);
      await reply(`준비하지 못했습니다(${why}).`);
      deps.journal.append({ type: 'warmup', agent, status: '실패', seconds, error: String(res.errorText ?? why).slice(0, 200) });
      return { status: res.interrupted ? '완료' : '실패', detail: `호출 — ${why}` };
    }
    pin();
    await reply(`준비됨 · ${seconds}초${pinnedNote}`);
    deps.journal.append({ type: 'warmup', agent, status: '준비됨', seconds });
    return { status: '완료', detail: `호출 — 준비됨 ${seconds}초` };
  }

  // 이번 실행 중에 LLM이 order_stage로 접수한 건이 있으면 관문이 고정 문구로 다시 묻는다.
  async function announceStagedConfirm(sinceMs, chatId) {
    const confirm = deps.confirmStore.pending(now());
    if (!confirm || confirm.announced || Date.parse(confirm.createdAt) < sinceMs) return;
    await deps.send({ agent: 'zeus', kind: '정보', topic: '주문 확인', body: escapeHtml(confirmPromptBody(confirm, { live: deps.isLive() })) }, chatId);
    // 이 시각 뒤에 온 "응"만 확인 답으로 인정한다(isAnswerToConfirm).
    deps.confirmStore.update({ announced: true, announcedAt: now().toISOString() }, { id: confirm.id });
    deps.journal.append({ type: 'confirm', id: confirm.id, status: '대기', summary: confirm.summary });
  }

  // 실행이 끝나지 않았는데(취소·시간 초과·오류·발송 실패) 그 사이 접수된 확인 대기는 묻지 않은 채 닫는다(2단계 리뷰 HIGH-1).
  function dropUnannouncedConfirm(sinceMs) {
    const confirm = deps.confirmStore.pending(now());
    if (!confirm || confirm.announced || Date.parse(confirm.createdAt) < sinceMs) return;
    deps.confirmStore.update({ status: '닫힘(대화 미완료)', closedAt: now().toISOString() }, { id: confirm.id });
    deps.journal.append({ type: 'confirm', id: confirm.id, status: '닫힘(대화 미완료)', summary: confirm.summary });
  }

  async function handleConfirm({ yes }, meta) {
    const confirm = deps.confirmStore.pending(now());
    const reply = (topic, body) => deps.send({ agent: 'zeus', kind: '정보', topic, body }, meta.chatId);
    if (confirm && !isAnswerToConfirm(confirm, meta.date)) {
      // 라우터가 이미 거르지만, 돈 경로라 실행 직전에 한 번 더 본다: 확인 질문을 보낸 뒤의 답이어야 한다.
      await reply('주문 확인', '확인 질문보다 먼저 온 답이라 접수하지 않았습니다. 확인 질문을 본 뒤 다시 답해 주세요.');
      return { status: '완료', detail: '확인 질문 전 답 — 무시' };
    }
    if (!confirm) {
      await reply('주문 확인', '확인을 기다리는 주문이 없습니다.');
      return { status: '완료', detail: '확인 대기 없음' };
    }
    if (!yes) {
      deps.confirmStore.update({ status: '거절', closedAt: now().toISOString() }, { id: confirm.id });
      deps.journal.append({ type: 'confirm', id: confirm.id, status: '거절', summary: confirm.summary });
      await reply('주문 확인', `접수하지 않았습니다.\n· ${escapeHtml(confirm.summary)}`);
      return { status: '완료', detail: '확인 거절' };
    }
    deps.confirmStore.update({ status: '확인됨', confirmedAt: now().toISOString(), confirmMessageId: meta.messageId }, { id: confirm.id });
    deps.journal.append({ type: 'confirm', id: confirm.id, status: '확인됨', summary: confirm.summary });
    let result;
    try {
      result = await orderExecutor(confirm);
    } catch (error) {
      // 실행 전 단계 오류(명령 조립 등) — 돈은 나가지 않았다. 확인 대기가 '확인됨'으로 남아 답이 없지 않게 고정 문구로 알린다(리뷰 LOW-9).
      log(`[gate] 주문 실행기 오류: ${error.message}`);
      result = { executed: false, status: '실행 안 함(오류)', text: `주문을 실행하지 못했습니다(창구 오류, 로그 참고).\n· ${confirm.summary}` };
    }
    const status = result.status ?? (result.executed ? '실행됨' : '실행 안 함');
    deps.confirmStore.update({ status, result: String(result.text ?? '').slice(0, 500) }, { id: confirm.id });
    deps.journal.append({ type: 'confirm', id: confirm.id, status, summary: confirm.summary });
    await reply('주문 접수', escapeHtml(result.text));
    return { status: '완료', detail: `주문 ${status}` };
  }

  // 만료됐거나 다른 주제가 와서 닫는 건. reason: '만료' | '다른 주제'
  async function closeConfirm(reason, chatId) {
    const confirm = reason === '만료' ? deps.confirmStore.expired(now()) : deps.confirmStore.pending(now());
    if (!confirm) return false;
    deps.confirmStore.update({ status: reason, closedAt: now().toISOString() }, { id: confirm.id });
    deps.journal.append({ type: 'confirm', id: confirm.id, status: reason, summary: confirm.summary });
    await safe(() => deps.send({ agent: 'zeus', kind: '정보', topic: '주문 확인', body: `${reason === '만료' ? '확인 시간(10분)이 지나' : '다른 이야기가 와서'} 접수하지 않았습니다.\n· ${escapeHtml(confirm.summary)}` }, chatId), '확인 닫기 알림');
    return true;
  }

  // 업무일이 바뀌면 전날 인수인계 노트를 쓴다. 이미 썼거나 기록이 없으면 건너뛴다.
  // 한 번에 하나만 돈다(1분 점검이 앞 요약을 기다리지 않아 같은 날 요약이 겹치던 문제, 2단계 리뷰 HIGH-2).
  function writeHandoffIfDue(at = now()) {
    if (state.handoffInFlight) return state.handoffInFlight;
    state.handoffInFlight = writeHandoffOnce(at).finally(() => { state.handoffInFlight = null; });
    return state.handoffInFlight;
  }

  async function writeHandoffOnce(at) {
    const day = previousDay(businessDay(at));
    if (state.handoffDays.has(day) || deps.readHandoff(day)) { state.handoffDays.add(day); return null; }
    const failure = state.handoffFailures.get(day);
    if (failure && at.getTime() < failure.nextAt) return null; // 백오프 중
    const entries = deps.journal.read(day);
    if (!entries.length) { state.handoffDays.add(day); return null; }
    let summary = null;
    let summaryError = null;
    if (deps.cooldown()) summaryError = '사용량 한도 쿨다운 중';
    else {
      try { summary = await deps.summarize(day, entries); } catch (error) { summaryError = error.message; }
    }
    const note = buildHandoffNote({ day, entries, summary, summaryError, now: at, pendingPromises: safeList(deps.listPendingPromises) });
    try {
      deps.writeHandoff(day, note.content);
    } catch (error) {
      // 쓰지 못한 날은 완료로 표시하지 않는다. 5·10·20…분(최대 2시간) 뒤 다시 쓰고, 3번 넘게 실패하면 하루 한 번 경고한다.
      const count = (failure?.count ?? 0) + 1;
      const delay = Math.min(5 * 60_000 * 2 ** (count - 1), 2 * 3600_000);
      state.handoffFailures.set(day, { count, nextAt: at.getTime() + delay, warned: failure?.warned ?? false });
      state.handoffFallback.set(day, note.body);
      log(`[gate] ${day} 인수인계 노트 쓰기 실패(${count}회): ${error.message}`);
      if (count >= 3 && !state.handoffFailures.get(day).warned) {
        state.handoffFailures.get(day).warned = true;
        await safe(() => deps.warn?.({ agent: 'zeus', kind: '정보', topic: '경고', body: `${day} 텔레그램 인수인계 노트를 ${count}번 쓰지 못했습니다. 다음 첫 대화에는 창구가 직접 넘깁니다.\n· 자세한 원인은 telegram-gate.log` }), '인수인계 경고');
      }
      return null;
    }
    state.handoffFailures.delete(day);
    state.handoffFallback.delete(day);
    state.handoffDays.add(day);
    log(`[gate] ${day} 인수인계 노트 작성${summary ? '' : `(요약 실패: ${summaryError})`}`);
    return note;
  }

  // 쿨다운 때문에 처리하지 못한 메시지가 있었고 이제 한도가 풀렸으면 한 번 알린다(먼저 보내기 범위 Q11).
  // 다른 잡은 한도 해제를 알리지 않아 겹치지 않는다. 알리는 것은 관문이 실제로 처리를 거절했을 때뿐이다.
  async function checkCooldownRelease(chatId) {
    if (!state.cooldownRefused || deps.cooldown()) return false;
    const count = state.cooldownRefused;
    state.cooldownRefused = 0;
    await safe(() => deps.send({ agent: 'zeus', kind: '정보', topic: '한도 해제', body: `사용량 한도가 풀렸습니다. 한도 때문에 처리하지 못한 메시지 ${count}건은 필요하면 다시 보내 주세요.` }, chatId), '한도 해제 알림');
    return true;
  }

  return {
    state,
    processBatch,
    warmup,
    // 결정론으로 처리된 오너 글(자주 묻는 질문)도 직통 상태를 소비한다(리뷰 LOW: 호출 직후 FAQ가 오면 직통이 남던 것).
    clearPinned: () => { state.pinned = null; },
    checkCooldownRelease,
    handleConfirm,
    closeConfirm,
    writeHandoffIfDue,
    setQueued,
    cancel() {
      const run = state.running;
      if (!run) return false;
      run.cancelRequested = true;
      run.cancel?.();
      return true;
    },
    isRunning: () => Boolean(state.running),
    // 상시 프로세스: 1분 점검에서 30분 무활동·업무일 바뀜을 정리하고, 창구 종료 때 모두 닫는다.
    sweepLive: () => deps.live?.sweep({ day: businessDay(now()) }),
    shutdownLive: (reason) => deps.live?.closeAll(reason),
    liveProcesses: () => deps.live?.list() ?? [],
  };
}

// 인수인계 요약 LLM 호출 인자(세션 없음, 도구 없음, 구조화 출력).
export function buildHandoffSummaryArgs(day, entries) {
  return [
    '-p', handoffSummaryPrompt(day, conversationTranscript(entries)),
    '--output-format', 'stream-json', '--verbose',
    '--model', GATE_MODEL, '--effort', GATE_EFFORT,
    '--permission-mode', 'dontAsk', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--no-session-persistence',
    // 요약에는 도구가 없어 금고 가드가 필요 없다. 설정 훅(라우팅 사실 붙이기·위키 답 자동 적용)이 요약 원문에 반응하지 않게
    // 사용자·프로젝트 설정을 읽지 않는다(2단계 리뷰 MEDIUM).
    '--setting-sources', 'local',
    '--json-schema', JSON.stringify(HANDOFF_SUMMARY_SCHEMA),
  ];
}
