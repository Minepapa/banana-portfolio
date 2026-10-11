// 야간 경고는 볼트 기계 데이터에 예약한 뒤 아침에 담당별 요약으로 한 번만 보낸다.
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { VAULT_REL, vaultAbs } from './vault-paths.mjs';
import { withLock, writeAtomic } from './state-writer.mjs';
import { appendWarningEvent, sanitizeWarningDetail } from './warning-event-journal.mjs';

const escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const QUIET_START_HOUR_KST = 23;
export const QUIET_END_HOUR_KST = 7;
export const DEFERRED_WARNINGS_FILE = vaultAbs(VAULT_REL.stateDeferredWarnings);

export function isQuietHour(now = Date.now()) {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(now)));
  return hour >= QUIET_START_HOUR_KST || hour < QUIET_END_HOUR_KST;
}

export function shouldDeferWarning({ kind, severity }, now = Date.now()) {
  return isQuietHour(now) && kind !== 'trade-safety' && severity !== 'critical';
}

function queuePath(path) {
  const selected = path ?? DEFERRED_WARNINGS_FILE;
  if (process.env.NODE_TEST_CONTEXT && selected === DEFERRED_WARNINGS_FILE) {
    const error = new Error('테스트에서 실볼트 보류 큐 경로 사용 금지');
    error.code = 'TEST_DEFAULT_PATH';
    throw error;
  }
  return selected;
}

function readQueue(path) {
  if (!existsSync(path)) return { pending: [], inFlight: [] };
  const raw = readFileSync(path, 'utf8');
  try {
    const queue = JSON.parse(raw);
    queue.inFlight ??= [];
    if (!Array.isArray(queue.pending) || !Array.isArray(queue.inFlight)) throw new Error('보류 경고 큐 형식 오류');
    for (const entry of [...queue.pending, ...queue.inFlight]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.id !== 'string' || typeof entry.agent !== 'string'
        || typeof entry.detail !== 'string' || !Number.isFinite(Date.parse(entry.at))
        || typeof entry.resolved !== 'boolean') throw new Error('보류 경고 항목 형식 오류');
    }
    return queue;
  } catch {
    renameSync(path, `${path}.corrupt-${Date.now()}`);
    const queue = { pending: [], inFlight: [] };
    Object.defineProperty(queue, 'corrupt', { value: true });
    return queue;
  }
}

async function notifyCorruption(sendCritical, logger) {
  if (!sendCritical) { logger.error('보류 경고 큐 손상 — 즉시 경보 발송 함수 없음'); return; }
  await sendCriticalWarning(sendCritical, { agent: 'zeus', kind: '판단', topic: '긴급 경고',
    facts: ['보류 경고 큐 손상', '손상 파일을 격리하고 빈 큐로 다시 시작했습니다. 원장과 격리 파일을 확인해 주세요.'] },
  { kind: 'operational', severity: 'critical', warningCode: 'DEFERRED_QUEUE_CORRUPT', subjectKey: 'queue' });
}

async function sendCriticalWarning(sendCritical, message, details) {
  const response = await sendCritical(message, details);
  if (response?.ok !== true || !Number.isSafeInteger(response.result?.message_id)) {
    throw new Error('보류 경고 critical 경보 전달 확인 불가');
  }
}

async function recordDigest(entry, status, messageId, journalRoot, logger, now) {
  let recorded = true;
  for (const source of entry.sources ?? (entry.source ? [entry.source] : [])) {
    if (!source.jobName) continue;
    const { jobName, warningCode, subjectKey, kind, severity, attemptId } = source;
    try {
      await appendWarningEvent({ eventId: randomUUID(), occurredAt: new Date(now).toISOString(),
        incidentId: source.incidentId ?? `deferred-${createHash('sha256').update(`${jobName}\0${warningCode}\0${subjectKey}`).digest('hex').slice(0, 32)}`,
        jobName, warningCode, subjectKey, kind, severity, eventType: 'delivery',
        deliveryStatus: status, deliveryAttemptId: attemptId,
        ...(status === 'sent' ? { telegramMessageId: messageId } : {}),
        detail: entry.detail,
      }, source.journalRoot || journalRoot ? { rootDir: source.journalRoot ?? journalRoot } : undefined);
    } catch (error) { logger.error(`아침 경고 정리 원장 기록 실패: ${error.message}`); recorded = false; }
  }
  return recorded;
}

async function markConfirmed(entry, now) {
  const { watcherStateFile, watcherIssueKey, batchStateFile, batchJobName, batchSig } = entry.source ?? {};
  if (watcherStateFile && watcherIssueKey) {
    await withLock(watcherStateFile, () => {
      if (!existsSync(watcherStateFile)) return;
      const state = JSON.parse(readFileSync(watcherStateFile, 'utf8'));
      if (!state[watcherIssueKey]) return;
      state[watcherIssueKey].lastSentAt = now;
      state[watcherIssueKey].sentCount = (state[watcherIssueKey].sentCount ?? 0) + 1;
      writeAtomic(watcherStateFile, JSON.stringify(state));
    });
  }
  if (batchStateFile && batchJobName && batchSig) {
    await withLock(batchStateFile, () => {
      const state = existsSync(batchStateFile) ? JSON.parse(readFileSync(batchStateFile, 'utf8')) : {};
      state[batchJobName] ??= {};
      state[batchJobName].sig = batchSig;
      state[batchJobName].ts = now;
      writeAtomic(batchStateFile, JSON.stringify(state));
    });
  }
}

async function confirmDigestEntry(entry, queueFile, journalRoot, logger, now) {
  if (!await recordDigest(entry, 'sent', entry.digestSentMessageId, journalRoot, logger,
    Date.parse(entry.digestSentAt) || now)) return false;
  try { await markConfirmed(entry, now); }
  catch (error) { logger.error(`정리 발송 후 상태 기록 실패: ${error.message}`); return false; }
  await withLock(queueFile, () => {
    const queue = readQueue(queueFile);
    queue.inFlight = queue.inFlight.filter((item) => item.id !== entry.id);
    writeAtomic(queueFile, JSON.stringify(queue));
  });
  return true;
}

export async function deferWarning({ agent, detail, facts, source, sources, issueKey = null, at = Date.now(),
  queueFile, sendCritical, logger = console }) {
  queueFile = queuePath(queueFile);
  mkdirSync(dirname(queueFile), { recursive: true });
  const entry = { id: randomUUID(), agent: agent ?? 'zeus', detail: sanitizeWarningDetail(detail),
    ...(Array.isArray(facts) ? { facts: facts.map(sanitizeWarningDetail) } : {}),
    ...(source ? { source } : {}), issueKey, at: new Date(at).toISOString(), resolved: false };
  if (sources) entry.sources = sources;
  let corrupt = false;
  await withLock(queueFile, () => {
    const queue = readQueue(queueFile);
    corrupt = !!queue.corrupt;
    queue.pending.push(entry);
    writeAtomic(queueFile, JSON.stringify(queue));
  });
  if (corrupt) await notifyCorruption(sendCritical, logger);
  return entry;
}

export async function resolveDeferredIssue(issueKey, queueFile = DEFERRED_WARNINGS_FILE, sendCritical) {
  queueFile = queuePath(queueFile);
  if (!existsSync(queueFile)) return;
  let corrupt = false;
  await withLock(queueFile, () => {
    const queue = readQueue(queueFile);
    corrupt = !!queue.corrupt;
    for (const entry of queue.pending) if (entry.issueKey === issueKey) entry.resolved = true;
    writeAtomic(queueFile, JSON.stringify(queue));
  });
  if (corrupt) await notifyCorruption(sendCritical, console);
}

export async function hasDeferredIssue(issueKey, queueFile = DEFERRED_WARNINGS_FILE, sendCritical) {
  queueFile = queuePath(queueFile);
  if (!existsSync(queueFile)) return false;
  let corrupt = false;
  const has = await withLock(queueFile, () => {
    const queue = readQueue(queueFile);
    corrupt = !!queue.corrupt;
    return queue.pending.some((entry) => entry.issueKey === issueKey);
  });
  if (corrupt) await notifyCorruption(sendCritical, console);
  return has;
}

// 먼저 claim을 영속화한다. 불명 응답이나 프로세스 중단 후 재실행해도 중복 발송하지 않는다.
export async function drainDeferredWarnings({ send, sendCritical = (message) => send(message),
  queueFile = DEFERRED_WARNINGS_FILE, now = Date.now(), logger = console, journalRoot } = {}) {
  queueFile = queuePath(queueFile);
  if (!existsSync(queueFile)) return { status: 'not-due' };
  let corrupt = false;
  const aged = await withLock(queueFile, () => {
    const queue = readQueue(queueFile);
    corrupt = !!queue.corrupt;
    return queue.pending.some((entry) => !entry.staleNotified && now - Date.parse(entry.at) > 9 * 3600_000);
  });
  if (corrupt) await notifyCorruption(sendCritical, logger);
  if (aged) await sendCriticalWarning(sendCritical, { agent: 'zeus', kind: '판단', topic: '긴급 경고',
    facts: ['보류 경고 큐 지연', '가장 오래된 경고가 9시간을 넘었습니다. 큐와 원장을 확인해 주세요.'] },
  { kind: 'operational', severity: 'critical', warningCode: 'DEFERRED_QUEUE_STALE', subjectKey: 'queue' });
  if (aged) await withLock(queueFile, () => {
    const queue = readQueue(queueFile);
    for (const entry of queue.pending) if (now - Date.parse(entry.at) > 9 * 3600_000) entry.staleNotified = true;
    writeAtomic(queueFile, JSON.stringify(queue));
  });
  if (isQuietHour(now)) return { status: 'not-due' };
  const confirmed = await withLock(queueFile, () => readQueue(queueFile).inFlight
    .filter((entry) => Number.isSafeInteger(entry.digestSentMessageId)));
  for (const entry of confirmed) await confirmDigestEntry(entry, queueFile, journalRoot, logger, now);
  const stale = await withLock(queueFile, () => {
    const queue = readQueue(queueFile);
    const overdue = queue.inFlight.filter((entry) => !entry.digestSentMessageId && !entry.unknownNotified
      && now - Date.parse(entry.claimedAt ?? entry.at) >= 30 * 60_000);
    return overdue;
  });
  if (stale.length) {
    const byAgent = Map.groupBy(stale, (entry) => entry.agent);
    for (const [agent, entries] of byAgent) {
      await sendCriticalWarning(sendCritical, { agent, kind: '판단', topic: '긴급 경고',
        facts: [`전달 확인 불가 — 밤사이 경고 ${entries.length}건, 원장 확인`] },
      { kind: 'operational', severity: 'critical', warningCode: 'DEFERRED_DIGEST_UNKNOWN', subjectKey: 'digest' });
      const ids = new Set(entries.map((entry) => entry.id));
      await withLock(queueFile, () => {
        const queue = readQueue(queueFile);
        for (const entry of queue.inFlight) if (ids.has(entry.id)) entry.unknownNotified = true;
        writeAtomic(queueFile, JSON.stringify(queue));
      });
    }
  }
  let count = 0;
  while (true) {
    const batch = await withLock(queueFile, () => {
      const queue = readQueue(queueFile);
      const agent = queue.pending[0]?.agent;
      if (!agent) return null;
      const entries = queue.pending.filter((entry) => entry.agent === agent);
      // 전송 전 inFlight로 옮긴다. 중단 후 자동 재전송은 하지 않지만 항목은 보존한다.
      queue.pending = queue.pending.filter((entry) => entry.agent !== agent);
      queue.inFlight.push(...entries.map((entry) => ({ ...entry, claimedAt: new Date(now).toISOString() })));
      writeAtomic(queueFile, JSON.stringify(queue));
      return { agent, entries };
    });
    if (!batch) break;
    const { agent, entries } = batch;
    const facts = [`밤사이 경고 ${entries.length}건`, ...entries.slice(0, 8).flatMap((entry) =>
      (entry.facts?.length ? entry.facts : [entry.detail]).map((fact) =>
        `${entry.resolved ? '복구됨: ' : ''}${escapeHtml(fact)}`))];
    if (entries.length > 8) facts.push(`외 ${entries.length - 8}건(경고 원장 확인)`);
    let response;
    try {
      response = await send({ agent, kind: '판단', topic: '경고', facts,
        conclusion: `밤사이 경고 ${entries.length}건을 정리했습니다.`,
        context: '23:00~07:00 KST에 보류한 경고입니다.',
        decisions: '미복구 항목을 확인해 주세요.' });
      if (response?.ok !== true || !Number.isSafeInteger(response.result?.message_id)) {
        const error = new Error('아침 경고 정리 전달 확인 불가');
        if (response?.ok === false) error.confirmedNotSent = true;
        throw error;
      }
    } catch (error) {
      if (!error.confirmedNotSent && !error.telegramExplicitRejection) {
        for (const entry of entries) await recordDigest(entry, 'unknown', null, journalRoot, logger, now);
      }
      if (error.confirmedNotSent || error.telegramExplicitRejection) {
        await withLock(queueFile, () => {
          const queue = readQueue(queueFile);
          const ids = new Set(entries.map((entry) => entry.id));
          queue.inFlight = queue.inFlight.filter((entry) => !ids.has(entry.id));
          queue.pending.unshift(...entries);
          writeAtomic(queueFile, JSON.stringify(queue));
        });
      }
      logger.error('아침 경고 정리 발송 실패 — 중복 발송 방지를 위해 자동 재시도하지 않음');
      return { status: 'unknown', error };
    }
    await withLock(queueFile, () => {
      const queue = readQueue(queueFile);
      const ids = new Set(entries.map((entry) => entry.id));
      for (const entry of queue.inFlight) if (ids.has(entry.id)) {
        entry.digestSentMessageId = response.result.message_id;
        entry.digestSentAt = new Date(now).toISOString();
      }
      writeAtomic(queueFile, JSON.stringify(queue));
    });
    for (const entry of entries) {
      const confirmedEntry = { ...entry, digestSentMessageId: response.result.message_id,
        digestSentAt: new Date(now).toISOString() };
      await confirmDigestEntry(confirmedEntry, queueFile, journalRoot, logger, now);
    }
    count += entries.length;
  }
  return { status: 'sent', count };
}
