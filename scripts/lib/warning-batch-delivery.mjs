// job-alerts의 기존 잡·배치 서명 억제를 보존하면서 전달 결과를 원장에 남긴다.
// 상태 예약은 네트워크 호출 전에 영속화한다. 응답 불명은 자동 재전송하지 않는다.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withLock, writeAtomic } from './state-writer.mjs';
import { appendWarningEvent, readWarningEvents, sanitizeWarningDetail, WARNING_JOURNAL_ROOT } from './warning-event-journal.mjs';

const SUPPRESS_MS = 24 * 3600 * 1000;
const RESERVATION_MAX_AGE_MS = 5 * 60 * 1000;

export function shouldNotify(state, jobName, sig, now = Date.now()) {
  const prev = state?.[jobName];
  return !(prev && prev.sig === sig && now - prev.ts < SUPPRESS_MS);
}

function readState(stateFile) {
  if (!existsSync(stateFile)) return {};
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('경고 발송 상태 형식 오류');
  return state;
}

function persistState(stateFile, state) {
  writeAtomic(stateFile, JSON.stringify(state));
  // 발송 예약을 디스크에 확정한 뒤에만 네트워크를 호출한다. 파일 내용과 rename
  // 양쪽을 동기화하지 않으면 전원 장애 후 예약만 사라져 같은 경고가 재발송될 수 있다.
  for (const path of [stateFile, dirname(stateFile)]) {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function reservationIsActive(reservation, now) {
  return reservation.phase !== 'unknown'
    && Number.isFinite(reservation.createdAt)
    && now - reservation.createdAt < RESERVATION_MAX_AGE_MS
    && processAlive(reservation.pid);
}

function eventBase(jobName, sig, clock, detail) {
  return {
    eventId: randomUUID(), occurredAt: new Date(clock()).toISOString(),
    incidentId: `legacy-${createHash('sha256').update(`${jobName}\0${sig}`).digest('hex').slice(0, 32)}`,
    jobName, warningCode: 'LEGACY_WARNING_BATCH', subjectKey: 'batch',
    kind: 'legacy-unstructured', severity: 'unclassified', legacyFingerprint: sig,
    detail: sanitizeWarningDetail(detail),
  };
}

function structuredEventBase(jobName, warning, clock) {
  const { warningCode, subjectKey, kind, severity } = warning;
  return {
    eventId: randomUUID(), occurredAt: new Date(clock()).toISOString(),
    incidentId: `coded-${createHash('sha256')
      .update(`${jobName}\0${warningCode}\0${subjectKey}`).digest('hex').slice(0, 32)}`,
    jobName, warningCode, subjectKey, kind, severity,
    detail: sanitizeWarningDetail(warning.detail),
  };
}

async function recordEvent(jobName, sig, event, { journalRoot, clock, logger, structuredWarnings, detail }) {
  const options = journalRoot ? { rootDir: journalRoot } : undefined;
  const uniqueWarnings = [...new Map((structuredWarnings ?? []).map((warning) => [
    `${warning.warningCode}|${warning.subjectKey}`, warning,
  ])).values()];
  const structuredBases = uniqueWarnings.map((warning) => structuredEventBase(jobName, warning, clock));
  // 실제 전송 결과를 복구 기준인 레거시 배치 사건에 마지막으로 쓴다. 중단 뒤 레거시
  // sent가 보이면 같은 시도의 원인별 사건들도 이미 sent 기록을 마친 상태여야 한다.
  const bases = ['sent', 'rejected', 'unknown'].includes(event.deliveryStatus)
    ? [...structuredBases, eventBase(jobName, sig, clock, detail)]
    : [eventBase(jobName, sig, clock, detail), ...structuredBases];
  let recorded = true;
  for (const base of bases) {
    if (['sent', 'rejected', 'unknown'].includes(event.deliveryStatus)
      && base.warningCode === 'LEGACY_WARNING_BATCH' && !recorded) {
      // 원인별 결과가 빠졌으면 복구 기준인 배치 결과도 완료로 확정하지 않는다.
      break;
    }
    try {
      if (event.eventType === 'detected' && base.warningCode === 'MACRO_YFINANCE_QUERY_FAILED') {
        // 다섯 지표 정상 조회의 회복 판정과 같은 잠금을 사용한다. 회복 확인과
        // 새 실패 감지 사이에 끼어드는 기록은 반드시 회복 앞 또는 뒤로 직렬화된다.
        const root = journalRoot ?? WARNING_JOURNAL_ROOT;
        mkdirSync(root, { recursive: true, mode: 0o700 });
        await withLock(join(root, '.macro-read-retry'), () => appendWarningEvent({
          ...base, ...event, occurredAt: new Date(clock()).toISOString(),
        }, options));
      } else {
        await appendWarningEvent({ ...base, ...event }, options);
      }
    } catch {
      // 기록 장애를 다시 경고 파이프라인에 넣으면 재귀하므로 stderr만 사용한다.
      logger.error('경고 원장 기록 실패 — 경고 발송은 계속 진행, 원장 경로 확인 필요');
      recorded = false;
    }
  }
  return recorded;
}

function lastAttemptOutcome(attemptId, journalRoot) {
  try {
    const options = journalRoot ? { rootDir: journalRoot } : undefined;
    const { events } = readWarningEvents(options);
    return events.filter((event) => event.warningCode === 'LEGACY_WARNING_BATCH'
      && event.deliveryAttemptId === attemptId
      && ['sent', 'rejected', 'unknown'].includes(event.deliveryStatus)).at(-1) ?? null;
  } catch {
    return null;
  }
}

function removeReservation(state, jobName, sig) {
  const job = state[jobName];
  if (!job?.reservations) return;
  delete job.reservations[sig];
  if (!Object.keys(job.reservations).length) delete job.reservations;
  if (!job.reservations && !job.sig) delete state[jobName];
}

// 반환 상태는 발송·억제·응답불명을 구분한다. 실채널 대신 sendImpl을 주입해 검증 가능.
export async function deliverWarningBatch({
  jobName, sig, message, sendImpl, stateFile, journalRoot,
  structuredWarnings = [],
  clock = Date.now, logger = console,
}) {
  const lockOptions = { retries: 20, retryDelayMs: 25 };
  const detail = Array.isArray(message?.facts) ? message.facts.slice(1).join(' | ') : message?.body;
  const recordContext = { journalRoot, clock, logger, structuredWarnings, detail };
  let reservation;
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    reservation = await withLock(stateFile, async () => {
      const state = readState(stateFile);
      const job = state[jobName] ?? {};
      const pending = job.reservations?.[sig];
      await recordEvent(jobName, sig, { eventType: 'detected' }, recordContext);

      if (pending) {
        if (reservationIsActive(pending, clock())) {
          await recordEvent(jobName, sig, {
            eventType: 'delivery', deliveryStatus: 'suppressed', suppressedBy: 'active-reservation',
          }, recordContext);
          return { send: false, status: 'suppressed', reason: 'active-reservation' };
        }
        const terminal = lastAttemptOutcome(pending.attemptId, journalRoot);
        if (terminal?.deliveryStatus === 'sent') {
          job.sig = sig;
          job.ts = Date.parse(terminal.occurredAt);
          removeReservation(state, jobName, sig);
          persistState(stateFile, state);
        } else if (terminal?.deliveryStatus === 'rejected') {
          removeReservation(state, jobName, sig);
          persistState(stateFile, state);
        } else {
          pending.phase = 'unknown';
          persistState(stateFile, state);
          if (!terminal || terminal.deliveryStatus !== 'unknown') {
            await recordEvent(jobName, sig, {
              eventType: 'delivery', deliveryStatus: 'unknown', deliveryAttemptId: pending.attemptId,
            }, recordContext);
          }
          await recordEvent(jobName, sig, {
            eventType: 'delivery', deliveryStatus: 'suppressed', suppressedBy: 'unknown-delivery',
          }, recordContext);
          return { send: false, status: 'suppressed', reason: 'unknown-delivery' };
        }
      }

      if (!shouldNotify(state, jobName, sig, clock())) {
        await recordEvent(jobName, sig, {
          eventType: 'delivery', deliveryStatus: 'suppressed', suppressedBy: 'recent-send',
        }, recordContext);
        return { send: false, status: 'suppressed', reason: 'recent-send' };
      }

      const attemptId = randomUUID();
      const current = state[jobName] ?? {};
      current.reservations ??= {};
      current.reservations[sig] = {
        attemptId, phase: 'reserved', createdAt: clock(), pid: process.pid,
      };
      state[jobName] = current;
      persistState(stateFile, state); // 먼저 예약을 기록해야 중단 후 중복 전송을 막는다.
      await recordEvent(jobName, sig, {
        eventType: 'delivery', deliveryStatus: 'reserved', deliveryAttemptId: attemptId,
      }, recordContext);
      return { send: true, attemptId };
    }, lockOptions);
  } catch {
    // 락/예약 상태를 확인하지 못하면 다른 프로세스가 이미 전송 중일 수 있다.
    logger.error('경고 예약 상태 확인 실패 — 중복 발송 방지를 위해 전송 보류');
    return { status: 'unavailable' };
  }
  if (!reservation.send) return { status: reservation.status, reason: reservation.reason };

  try {
    await withLock(stateFile, async () => {
      const state = readState(stateFile);
      const pending = state[jobName]?.reservations?.[sig];
      if (pending?.attemptId !== reservation.attemptId) throw new Error('전달 예약 소실');
      pending.phase = 'sending';
      persistState(stateFile, state);
      await recordEvent(jobName, sig, {
        eventType: 'delivery', deliveryStatus: 'sending', deliveryAttemptId: reservation.attemptId,
      }, recordContext);
    }, lockOptions);
  } catch {
    logger.error('경고 발송 직전 예약 확인 실패 — 중복 발송 방지를 위해 전송 보류');
    return { status: 'unavailable' };
  }

  let outcome;
  let telegramMessageId;
  try {
    const response = await sendImpl(message);
    if (response?.ok === false) outcome = 'rejected';
    else if (response?.ok === true && Number.isSafeInteger(response.result?.message_id)
      && response.result.message_id > 0) {
      outcome = 'sent';
      telegramMessageId = response.result.message_id;
    } else outcome = 'unknown';
  } catch (error) {
    outcome = error.telegramExplicitRejection || error.confirmedNotSent ? 'rejected' : 'unknown';
    logger.error('경고 텔레그램 발송 실패 — 전달 상태를 원장에 기록');
  }

  try {
    await withLock(stateFile, async () => {
      await recordEvent(jobName, sig, {
        eventType: 'delivery', deliveryStatus: outcome,
        deliveryAttemptId: reservation.attemptId,
        ...(outcome === 'sent' ? { telegramMessageId } : {}),
      }, recordContext);
      const state = readState(stateFile);
      if (outcome === 'sent') {
        state[jobName] ??= {};
        state[jobName].sig = sig;
        state[jobName].ts = clock();
        removeReservation(state, jobName, sig);
      } else if (outcome === 'rejected') removeReservation(state, jobName, sig);
      else {
        const pending = state[jobName]?.reservations?.[sig];
        if (pending?.attemptId === reservation.attemptId) pending.phase = 'unknown';
      }
      persistState(stateFile, state);
    }, lockOptions);
  } catch {
    logger.error('경고 전달 결과 상태 기록 실패 — 자동 재전송 금지, 기록 확인 필요');
  }
  return { status: outcome };
}
