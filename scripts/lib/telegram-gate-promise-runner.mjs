// 텔레그램 관문 약속 이행기 — 1분 점검마다 약속 요청을 대기열로 옮기고, 조건이 충족된 약속을 이행하고, 기한이 지난 약속을 닫는다
// (2026-10-30, 관문 3단계. 설계 9-1, Q10: 기본 고정 문구, 맥락이 필요할 때만 LLM).
// 네트워크·파일·LLM은 모두 주입받는다(시험은 가짜 시계·가짜 발송).
//
// 반복 발송 방지(3단계 리뷰 M1·M2, 제우스 방향):
// - 발송과 볼트 기록을 따로 다룬다. 보낸(또는 닫기로 한) 약속은 즉시 관문 상태 폴더의 promise-fired.json(볼트 밖)에 적는다.
//   볼트 기록이 실패하거나 그 사이 관문이 재시작돼도 이 파일을 보고 다시 보내지 않고 볼트 기록만 다시 시도한다.
// - LLM 이행은 약속마다 한 번만 시도한다. 예외·실패·쿨다운 거절이면 고정 문구로 지킨다.
import { existsSync, readFileSync } from 'node:fs';
import { describeTrigger, promiseExpiredBody, promiseMet, promiseNotifyBody } from './telegram-gate-promises.mjs';
import { escapeHtml } from './telegram.mjs';
import { writeAtomic } from './state-writer.mjs';

// 보낸 약속 기록(볼트 밖, 원자적 쓰기). { id: { status, detail, at } }. path가 없으면 메모리만(시험).
export function createFiredLog(path) {
  const read = () => {
    if (!path || !existsSync(path)) return {};
    try { return JSON.parse(readFileSync(path, 'utf8')) ?? {}; } catch { return {}; }
  };
  let data = read();
  const save = () => { if (path) writeAtomic(path, `${JSON.stringify(data)}\n`); };
  return {
    has: (id) => Object.hasOwn(data, id),
    entries: () => Object.entries(data).map(([id, o]) => ({ id, ...o })),
    add(id, outcome) { data = { ...data, [id]: { ...outcome, at: new Date().toISOString() } }; save(); },
    remove(ids) {
      if (!ids.length) return;
      data = Object.fromEntries(Object.entries(data).filter(([id]) => !ids.includes(id)));
      save();
    },
  };
}

const MAX_SEND_FAILURES = 5;

// deps: store(createPromiseStore), knownJobs, jobHealth(job), fileMtime(path), send(message, chatId), chatId,
//       runLlm(promise) → Promise<{status, refused?}> | null(대화 줄이 바쁘면 null — 다음 점검에서 다시), cooldown(), now, log
export function createPromiseRunner(deps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const failures = new Map();
  const llmTried = new Set();
  // 보냈지만 볼트에 아직 못 적은 것. 재시작에도 남게 파일로(deps.firedLog), 없으면 메모리.
  const fired = deps.firedLog ?? createFiredLog(null);
  let running = false;

  async function tell(agent, topic, body) {
    await deps.send({ agent, kind: '정보', topic, body }, deps.chatId);
  }

  // 반환: { status, detail } 이면 기록할 상태, null이면 이번엔 아무것도 하지 않음(다음 점검).
  async function fire(promise) {
    if (promise.action === 'llm' && !llmTried.has(promise.id) && !deps.cooldown()) {
      const pending = deps.runLlm(promise);
      if (!pending) return null; // 대화 줄이 바쁨 — 다음 점검
      llmTried.add(promise.id);
      try {
        const result = await pending;
        if (result?.status === '완료' && !result.refused) return { status: '이행', detail: 'LLM 보고' };
        log(`[gate] 약속 ${promise.id} LLM 이행 실패(${result?.detail ?? result?.status}) — 고정 문구로`);
      } catch (error) {
        log(`[gate] 약속 ${promise.id} LLM 이행 예외: ${error.message} — 고정 문구로`);
      }
    }
    try {
      await tell(promise.by ?? 'zeus', '약속', promiseNotifyBody(promise));
      failures.delete(promise.id);
      return { status: '이행', detail: '고정 문구' };
    } catch (error) {
      const count = (failures.get(promise.id) ?? 0) + 1;
      failures.set(promise.id, count);
      log(`[gate] 약속 ${promise.id} 알림 실패(${count}회): ${error.message}`);
      if (count >= MAX_SEND_FAILURES) {
        failures.delete(promise.id);
        return { status: '실패', detail: `알림 ${count}회 실패` };
      }
      return null;
    }
  }

  // 한 번에 하나만 돈다(1분 점검이 앞 점검을 기다리지 않을 수 있어서).
  async function tick() {
    if (running) return { skipped: true };
    running = true;
    const out = { added: 0, fired: 0, expired: 0, rejected: 0 };
    let consumed = [];
    try {
      const ingested = deps.store.ingest({ knownJobs: deps.knownJobs });
      consumed = ingested.consumed ?? [];
      out.added = ingested.added.length;
      out.rejected = ingested.rejected.length;
      for (const r of ingested.rejected) {
        // 오류 원문은 로그에만, 오너에게는 검사 메시지(safeReason)만(리뷰 M5).
        log(`[gate] 약속 요청 거절: ${r.reason}${r.error && r.error.message !== r.reason ? ` (원문: ${r.error.message})` : ''}`);
        try { await tell('zeus', '약속', `약속을 받아 두지 못했습니다.\n· 사유: ${escapeHtml(r.reason)}`); } catch { /* 다음에 알 수 있음 */ }
      }
      deps.store.removeRequests(ingested.rejectedPaths ?? []);
      const at = now();
      const ctx = { now: at, jobHealth: deps.jobHealth, fileMtime: deps.fileMtime };
      for (const entry of deps.store.pending()) {
        const { promise } = entry;
        if (fired.has(promise.id)) continue; // 이미 보냄(재시작 전 포함) — 아래에서 볼트 기록만 다시
        let met = false;
        try { met = promiseMet(promise, ctx); } catch (error) { log(`[gate] 약속 ${promise.id} 판정 실패: ${error.message}`); }
        // 조건 충족을 먼저 본다(시각 == 기한이면 이행, 리뷰 L5).
        if (met) {
          const outcome = await fire(promise);
          if (outcome) { fired.add(promise.id, outcome); if (outcome.status === '이행') out.fired += 1; }
          continue;
        }
        if (Date.parse(promise.expiresAt) <= at.getTime()) {
          try {
            await tell(promise.by ?? 'zeus', '약속', promiseExpiredBody(promise));
          } catch (error) {
            log(`[gate] 만료 알림 실패: ${error.message}`);
          }
          fired.add(promise.id, { status: '만료', detail: '기한 7일 지남' });
          out.expired += 1;
        }
      }
    } finally {
      // 이번 점검의 추가·상태를 볼트 파일 전체 재작성 한 번으로 반영한다(점검당 1회). 성공하면 보낸 기록과 처리한 요청 파일을 지운다.
      // 실패하면 둘 다 남겨 다음 점검에서 다시 한다(보낸 약속은 다시 보내지 않음).
      try {
        const pendingIds = new Set(deps.store.pending().map((p) => p.promise.id));
        const toRecord = fired.entries().filter((e) => pendingIds.has(e.id));
        const stale = fired.entries().filter((e) => !pendingIds.has(e.id)).map((e) => e.id);
        deps.store.markStatuses(toRecord);
        deps.store.flush();
        fired.remove([...toRecord.map((e) => e.id), ...stale]);
        deps.store.removeRequests(consumed);
      } catch (error) {
        log(`[gate] 약속 대기열 기록 실패(다음 점검에서 다시): ${error.message}`);
      }
      running = false;
    }
    return out;
  }

  // 상태 표용: 대기 수와 다음 시각 조건.
  // 상태 표용: 볼트 대기열의 대기 약속 + 아직 반영되지 않은 요청 파일('반영 중', 다음 1분 점검에서 볼트로 옮겨진다).
  // 취소 요청이 반영 중인 볼트 약속은 대기 수에서 뺀다(리뷰 L1). 지난 시각은 상태 표가 '곧'으로 보인다(nextAt은 그대로 둠).
  function summary() {
    let inflight = { added: [], cancelled: [] };
    try { inflight = deps.store.inflight?.({ knownJobs: deps.knownJobs }) ?? inflight; } catch (error) {
      log(`[gate] 반영 중 약속 읽기 실패: ${error.message}`);
    }
    const cancelling = new Set(inflight.cancelled);
    const pending = deps.store.pending().map((p) => p.promise).filter((p) => !cancelling.has(p.id));
    const times = [...pending, ...inflight.added].flatMap((p) => [p.trigger, p.or].filter((t) => t?.type === 'time').map((t) => Date.parse(t.at))).filter(Number.isFinite);
    return { pending: pending.length + inflight.added.length, inflight: inflight.added.length,
      nextAt: times.length ? new Date(Math.min(...times)).toISOString() : null };
  }

  function pendingForHandoff() {
    return deps.store.pending().map((p) => ({ id: p.promise.id, text: p.promise.text, expiresAt: p.promise.expiresAt,
      condition: `${describeTrigger(p.promise.trigger)}${p.promise.or ? ` 또는 ${describeTrigger(p.promise.or)}` : ''}` }));
  }

  return { tick, summary, pendingForHandoff };
}
