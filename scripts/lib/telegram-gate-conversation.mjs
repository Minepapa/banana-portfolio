// 텔레그램 관문 대화 줄(llm lane) — 자유 문장·담당 호출·사진 판독을 헤드리스 claude 한 번으로 처리하고, 진행 메시지를 단계별로
// 고치고, 최종 답을 발송 관문으로 보내고, 확인 대기(돈 지시)와 하루 인수인계를 다룬다(2026-10-30, 관문 2단계).
// 설계 6·7·9절, 결정 `텔레그램-관문` 3~8항. 네트워크·프로세스는 모두 주입받는다(시험은 가짜로).
import { buildGateClaudeArgs, GATE_EFFORT, GATE_MODEL, GATE_TOOLS_SET, SOFT_TIMEOUT_MS } from './telegram-gate-llm.mjs';
import { applyProgress, createEditThrottle, describeEvent, initialProgress, renderProgress } from './telegram-gate-progress.mjs';
import { buildGateSystemPrompt, buildMessagePrompt, businessDay, fallbackMessage, previousDay, toGateMessages } from './telegram-gate-session.mjs';
import { buildHandoffNote, conversationTranscript, handoffSummaryPrompt, HANDOFF_SUMMARY_SCHEMA } from './telegram-gate-journal.mjs';
import { buildOrderCommand, confirmPromptBody, isAnswerToConfirm } from './telegram-gate-confirm.mjs';
import { escapeHtml } from './telegram.mjs';

const PROGRESS_TOPIC = '진행';
const NO_CONVERSATION_RE = /No conversation found|no conversation/i;

function shortReason(res) {
  if (/limit|한도/i.test(res.errorText ?? '')) return '사용량 한도';
  return '처리 중 오류(관문 로그 참고)';
}

function kstTime(ms) {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

// 2단계 가짜 실행기: 실행할 명령을 보여 주기만 한다. 실제 실행 배선은 전환 전 별도 리뷰(설계 14절).
export async function fakeOrderExecutor(confirm) {
  const { tool, args } = buildOrderCommand(confirm);
  return { executed: false, text: `관문 2단계라 실제로 실행하지 않았습니다.\n· 실행할 명령: ${tool} ${args.join(' ')}` };
}

// deps: send(message, chatId) → Bot API 응답, edit(messageId, message, chatId), del(messageId, chatId), downloadPhoto(fileId) → path,
//       runner({args, env, onEvent}) → {promise, cancel}, spawnEnv, cooldown() → {resetAt}|null, readRules() → {inputRules, sessionRules},
//       readHandoff(day) → text|null, writeHandoff(day, content), journal, sessionStore, confirmStore, isLive() → bool, orderExecutor, mcpToolNames,
//       now, log, setTimer, clearTimer
export function createConversation(deps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const orderExecutor = deps.orderExecutor ?? fakeOrderExecutor;
  // handoffFailures: 날짜별 { count, nextAt, warned } — 노트 쓰기 실패 뒤 백오프 재시도. handoffFallback: 쓰지 못한 날의 노트 본문
  // (다음 첫 대화에 직접 넣는다 — 인수인계가 조용히 사라지지 않게, 2단계 재리뷰 MEDIUM).
  const state = { running: null, queued: 0, lastRun: null, lastRateLimit: null, handoffDays: new Set(), handoffInFlight: null,
    handoffFailures: new Map(), handoffFallback: new Map() };
  const isStopping = deps.isStopping ?? (() => false);

  const progressMessage = (body) => ({ agent: 'zeus', kind: '정보', topic: PROGRESS_TOPIC, body });

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

  async function runOnce({ items, session, handoffText, handoffMissing, chatId, run }) {
    const prompt = buildMessagePrompt({ items, handoffText, handoffMissing, now: now() });
    const args = buildGateClaudeArgs({
      prompt, sessionId: session.sessionId, resume: session.resume,
      appendSystemPrompt: buildGateSystemPrompt(deps.readRules()),
      allowedTools: [...GATE_TOOLS_SET, ...deps.mcpToolNames],
      // 모델·노력은 결정 `텔레그램-관문` 3항(opus·medium). 실측 시험만 haiku로 낮춘다(deps.model).
      ...(deps.model ? { model: deps.model } : {}),
      ...(deps.effort ? { effort: deps.effort } : {}),
    });
    if (run.cancelRequested) return { interrupted: 'cancel', isError: false, permissionDenials: [] };
    let started = false;
    deps.sessionStore.markStarted?.(session.sessionId);
    const handle = deps.runner({
      args,
      env: deps.spawnEnv,
      onEvent: (event) => {
        if (event.type === 'system' && event.subtype === 'init') started = true;
        if (event.type === 'rate_limit_event') state.lastRateLimit = event.rate_limit_info ?? null;
        if (event.type === 'assistant' && !event.parent_tool_use_id) {
          for (const use of (event.message?.content ?? []).filter((c) => c?.type === 'tool_use' && c.name !== 'StructuredOutput')) {
            deps.journal.append({ type: 'tool', name: use.name, input: JSON.stringify(use.input ?? {}).slice(0, 300) });
          }
        }
        run.progress = applyProgress(run.progress, describeEvent(event));
        run.throttle.update(renderProgress(run.progress, now().getTime()));
      },
    });
    run.cancel = handle.cancel;
    // 진행 메시지 발송·사진 내려받기 사이에 온 "취소"도 놓치지 않는다(2단계 리뷰 MEDIUM).
    if (run.cancelRequested) handle.cancel();
    const res = await handle.promise;
    if (started) deps.sessionStore.recordTurn(session.sessionId);
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
      const cooldown = deps.cooldown();
      if (cooldown) {
        await finishProgress(`사용량 한도 쿨다운 중이라 처리하지 않았습니다. ${kstTime(cooldown.resetAt)} 이후 다시 보내 주세요.`);
        deps.journal.append({ type: 'llm', status: '쿨다운', input: inputText });
        state.lastRun = { ok: true, at: now().toISOString(), status: '쿨다운' };
        return { status: '완료', detail: '쿨다운 — 처리 안 함' };
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
      let session = deps.sessionStore.forDay(day);
      let handoffText = null;
      let handoffMissing = false;
      if (session.firstOfDay) {
        handoffText = deps.readHandoff(previousDay(day)) ?? state.handoffFallback.get(previousDay(day)) ?? null;
        handoffMissing = !handoffText;
      }
      deps.confirmStore.setActiveBatch?.(items.map((i) => i.meta.messageId));
      const soft = setTimer(() => {
        run.progress = { ...run.progress, slow: true };
        run.throttle.update(renderProgress(run.progress, now().getTime()));
      }, SOFT_TIMEOUT_MS);
      let res;
      try {
        res = await runOnce({ items, session, handoffText, handoffMissing, chatId, run });
        if (res.isError && session.resume && NO_CONVERSATION_RE.test(res.errorText ?? '')) {
          // 이어 붙일 세션 기록이 사라졌다 — 같은 날 새 세션으로 한 번만 다시(인수인계는 다시 넣는다).
          session = deps.sessionStore.reset(day);
          const text = deps.readHandoff(previousDay(day));
          res = await runOnce({ items, session, handoffText: text, handoffMissing: !text, chatId, run });
        }
      } finally {
        clearTimer(soft);
      }

      const seconds = Math.round((now().getTime() - startedAt) / 1000);
      const lastStep = run.progress.steps.at(-1) ?? run.progress.stage;
      if (res.permissionDenials?.length) {
        log(`[gate] 허용되지 않은 도구 요청 ${res.permissionDenials.length}건: ${res.permissionDenials.map((d) => d.tool_name).join(', ')}`);
        deps.journal.append({ type: 'denied', tools: res.permissionDenials.map((d) => d.tool_name) });
      }
      if (res.interrupted && res.interrupted !== 'timeout') {
        dropUnannouncedConfirm(startedAt);
        if (isStopping()) {
          // 관문 재시작으로 끊김 — 입력은 '처리중'으로 남겨 재시작 때 확인필요 안내로 간다.
          await finishProgress('관문이 다시 시작되느라 멈췄습니다. 재시작 뒤 안내를 확인해 주세요.');
          deps.journal.append({ type: 'llm', status: '중단', input: inputText });
          return { status: '중단', detail: '관문 종료로 끊김', interruptedByShutdown: true };
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

      const { messages, problem } = toGateMessages(res.structured, res.result);
      const outgoing = problem ? [fallbackMessage(res.result)] : messages;
      if (problem) {
        log(`[gate] 출력 계약 위반(${problem}) — 원문을 감싸 보냄`);
        deps.journal.append({ type: 'contract', problem });
      }
      await run.throttle.close();
      try {
        for (const message of outgoing) {
          await deps.send(message, chatId);
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
      if (progressId) {
        const deleted = await safe(() => deps.del(progressId, chatId), '진행 메시지 삭제');
        if (deleted === null) await safe(() => deps.edit(progressId, progressMessage(`처리 끝(${seconds}초)`), chatId), '진행 메시지 마무리');
      }
      deps.journal.append({ type: 'llm', status: '완료', input: inputText, seconds });
      state.lastRun = { ok: true, at: now().toISOString(), status: '완료' };
      await announceStagedConfirm(startedAt, chatId);
      return { status: '완료', detail: `대화 ${outgoing.length}건 답` };
    } finally {
      run.throttle?.close();
      deps.confirmStore.setActiveBatch?.(null);
      state.running = null;
    }
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
    const result = await orderExecutor(confirm);
    deps.confirmStore.update({ status: result.executed ? '실행됨' : '실행 안 함(2단계)', result: String(result.text ?? '').slice(0, 500) }, { id: confirm.id });
    await reply('주문 접수', escapeHtml(result.text));
    return { status: '완료', detail: result.executed ? '주문 실행' : '주문 확인(가짜 실행기)' };
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
    const note = buildHandoffNote({ day, entries, summary, summaryError, now: at });
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
        await safe(() => deps.warn?.({ agent: 'zeus', kind: '정보', topic: '경고', body: `${day} 텔레그램 인수인계 노트를 ${count}번 쓰지 못했습니다. 다음 첫 대화에는 관문이 직접 넘깁니다.\n· 자세한 원인은 telegram-gate.log` }), '인수인계 경고');
      }
      return null;
    }
    state.handoffFailures.delete(day);
    state.handoffFallback.delete(day);
    state.handoffDays.add(day);
    log(`[gate] ${day} 인수인계 노트 작성${summary ? '' : `(요약 실패: ${summaryError})`}`);
    return note;
  }

  return {
    state,
    processBatch,
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
