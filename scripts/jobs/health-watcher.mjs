#!/usr/bin/env node
/**
 * 독립 장애감지 워처 (v2) — docs/ARCHITECTURE-V2.md "장애감지 — 독립 워처 + 하트비트" 절.
 *
 * 다른 잡들의 성공 여부와 무관하게 **이 잡 스스로** 30분마다 launchd로 실행돼(다른
 * 잡·상시 세션과 완전히 독립) 두 가지를 확인한다:
 *   1) 각 잡의 하트비트(State/JobHealth/*.md)가 기대 주기의 2배 이상 조용한지
 *   2) 상시 텔레그램 세션(claude --channels ...) 프로세스가 살아있는지 — Phase 5에서
 *      그 세션이 실제로 생기기 전까지는 WATCH_TELEGRAM_SESSION=1 환경변수가 없으면
 *      건너뛴다(아직 없는 프로세스를 "죽었다"고 오탐하지 않기 위함)
 * 이상 감지 시 텔레그램으로 직접 알림을 보낸다(sendAgentMessage — 상시 세션과 무관하게
 * 독립 동작 가능, telegram.mjs 참고).
 *
 * 사용법: node scripts/jobs/health-watcher.mjs [--dry-run]
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, isStale } from '../lib/job-health.mjs';
import { getTelegramWebhookInfo } from '../lib/telegram.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { createDirectWarningSender, warningSubjectKey } from '../lib/direct-warning-delivery.mjs';
import { cancelDeferredWarnings, drainDeferredWarnings, hasDeferredIssue, resolveDeferredIssue } from '../lib/deferred-warnings.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';

import { describeJob, JOB_REMEDIATION } from '../lib/job-labels.mjs';
import { EXPECTED_INTERVALS_MS, EXPECTED_INTERVAL_DEFAULT_MS, JOB_FIRST_HEARTBEAT_BY, isInactiveJob } from '../lib/job-schedule.mjs';
import { DEFAULT_VAULT_ROOT, VAULT_PATHS, VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';
import { DATA_SOURCES } from '../lib/data-sources.mjs';
import { buildFreshnessDocument, createVaultReaders, currentDigestSlot, digestOpenSince, findStaleSources, formatSourceIssue,
  kstDateOf, planDigest, sourceIssueKey, trackDigestState, writeIfChanged } from '../lib/data-freshness.mjs';
import { readKrxTradingDayStatus } from '../lib/krx-trading-calendar.mjs';
import { STRATEGY_DECISION_KEY, strategySwitchStatus, switchedOffJobs } from '../lib/strategy-switch.mjs';
import { isProcessAlive, isPollingStuck, TELEGRAM_SESSION_PROCESS_PATTERN } from '../lib/telegram-session-liveness.mjs';

// telegram-session-health-check.mjs와 공유하는 isPollingStuck을 예전 import 경로
// (`from './health-watcher.mjs'`)로도 계속 쓸 수 있게 재수출(2026-08-31, 코드리뷰
// 지적으로 lib/telegram-session-liveness.mjs로 이관 — health-watcher.test.js가
// 기존 경로로 이미 import하고 있어 그 파일은 안 건드림).
export { isPollingStuck };

const DRY_RUN = process.argv.includes('--dry-run');

// 이 잡(health-watcher) 자체가 보내는 텔레그램 알림의 부서 라벨 — 판테온 조직에서
// "장부·데이터·인프라 배관"을 담당하는 운영실(Hermes) 소관(v1 JOB_DEPARTMENT 매핑의
// 'backup'·'parse-notifications'·'realtime-quotes' 등이 전부 hermes였던 것과 동일 원칙).
// 2026-08-14 오너 지적 — 알림에 어느 잡을 감시하는 건지·어느 부서 소관인지 표기 안 돼
// 있어 헷갈렸음, formatDepartmentMessage(기존 부서 메시지 포맷)로 통일.
// 시스템 운영 경보는 제우스 명의(D83, 2026-10-08 오너 결정 — 잡·인프라는 영역 담당이 아니라 시스템 운영 소관, 다른 영역 잡이 늘어도 같은 창구).
const SENDER_AGENT = 'zeus';
const WATCHER_STATE_FILE = fileURLToPath(new URL('../.cache/health-watcher.json', import.meta.url));
// 비긴급 데이터 신선도 묶음(09·19시) 상태. 감시 상태(WATCHER_STATE_FILE)와 형식이 달라 따로 둔다.
const FRESHNESS_DIGEST_STATE_FILE = fileURLToPath(new URL('../.cache/data-freshness-digest.json', import.meta.url));
const DATA_FRESHNESS_FILE = vaultAbs(VAULT_REL.dataFreshness);
export const REMINDER_HOURS = [6, 24];
const sendWarning = createDirectWarningSender(sendAgentMessage, {
  jobName: 'health-watcher', warningCode: 'JOB_HEALTH_ISSUES', subjectKey: 'batch',
  kind: 'operational', severity: 'high',
});
const sendFreshnessDigest = createDirectWarningSender(sendAgentMessage, {
  jobName: 'health-watcher', warningCode: 'DATA_FRESHNESS_DIGEST', subjectKey: 'digest',
  kind: 'operational', severity: 'medium', drainBeforeSend: false,
});

function readWatcherState(stateFile) {
  if (!existsSync(stateFile)) return {};
  const raw = readFileSync(stateFile, 'utf8');
  try {
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('감시 상태 형식 오류');
    for (const issue of Object.values(state)) {
      if (!issue || typeof issue !== 'object' || Array.isArray(issue)
        || !Number.isFinite(issue.firstSeenAt)
        || (issue.lastSentAt !== null && !Number.isFinite(issue.lastSentAt))
        || !Number.isInteger(issue.sentCount) || issue.sentCount < 0) {
        throw new Error('감시 상태 항목 형식 오류');
      }
    }
    return state;
  } catch {
    renameSync(stateFile, `${stateFile}.corrupt-${Date.now()}`);
    return { __corrupt: true };
  }
}

// 복구 문구. 데이터 출처(source:<id>:stale|error) 키는 사람이 읽는 출처 이름으로 바꾼다. 나머지(잡 등)는 예전 그대로 키.
export function recoveryText(key) {
  const match = /^source:([^:]+):(stale|error)$/.exec(key);
  const source = match && DATA_SOURCES.find((item) => item.id === match[1]);
  if (!source) return `복구됨: ${key}`;
  return match[2] === 'error' ? `판정 정상화: 데이터 <code>${source.label}</code>` : `복구됨: 데이터 <code>${source.label}</code>`;
}

// switchedOff: 꺼진 전략의 잡(결정 `전략-가동`). 폐지된 잡과 같이 다뤄, 이미 보낸 '조용함' 경고는
// '복구됨' 알림 없이 상태에서 지운다(실제로 복구된 게 아니라 끈 것이라서).
function isInactiveJobIssue(key, switchedOff = new Set()) {
  const match = /^job:([^:]+):silent$/.exec(key);
  return match !== null && (isInactiveJob(match[1]) || switchedOff.has(match[1]));
}

export async function processHealthIssues(issues, { stateFile = WATCHER_STATE_FILE,
  send = sendWarning, now = Date.now(), queueFile, switchedOff = new Set() } = {}) {
  const isInactiveIssue = (key) => isInactiveJobIssue(key, switchedOff);
  if (process.env.NODE_TEST_CONTEXT && stateFile === WATCHER_STATE_FILE) {
    throw new Error('테스트에서 실 감시 상태 경로 사용 금지');
  }
  mkdirSync(dirname(stateFile), { recursive: true });
  const sendWithoutDrain = (message, details = {}) => send(message, {
    ...details, drainBeforeSend: false,
  });
  const corrupt = await withLock(stateFile, () => {
    const state = readWatcherState(stateFile);
    const wasCorrupt = !!state.__corrupt;
    delete state.__corrupt;
    writeAtomic(stateFile, JSON.stringify(state));
    return wasCorrupt;
  });
  if (corrupt) {
    try {
      await send({ agent: SENDER_AGENT, kind: '판단', topic: '긴급 경고',
        facts: ['감시 상태 손상', '손상 파일을 격리하고 빈 상태로 다시 시작했습니다.'] },
      { warningCode: 'WATCHER_STATE_CORRUPT', subjectKey: 'state', severity: 'critical', queueFile,
        drainBeforeSend: false });
    } catch (error) { console.error(`감시 상태 손상 경보 실패: ${error.message}`); }
  }
  const current = new Set(issues.map((issue) => issue.key));
  try {
    const priorState = await withLock(stateFile, () => readWatcherState(stateFile));
    const retiredIssueKeys = new Set(Object.keys(priorState).filter(isInactiveIssue).map((key) =>
      `health-watcher|JOB_HEALTH_ISSUES|${warningSubjectKey('issue', key)}`));
    await cancelDeferredWarnings((entry) => {
      const source = entry.source;
      const sourceKey = source?.watcherIssueKey;
      if (sourceKey) return (!source.jobName || source.jobName === 'health-watcher')
        && (!source.warningCode || source.warningCode === 'JOB_HEALTH_ISSUES')
        && isInactiveIssue(sourceKey);
      return retiredIssueKeys.has(entry.issueKey);
    }, queueFile, sendWithoutDrain);
  } catch (error) {
    console.error(`폐지된 잡 보류 경고 정리 실패: ${error.message}`);
  }
  let sent = 0;
  for (const issue of issues) {
    try {
      const subjectKey = warningSubjectKey('issue', issue.key);
      let queued = false;
      try { queued = await hasDeferredIssue(`health-watcher|JOB_HEALTH_ISSUES|${subjectKey}`, queueFile, sendWithoutDrain); }
      catch (error) { console.error(`보류 큐 확인 실패 (${issue.key}): ${error.message}`); }
      const claim = await withLock(stateFile, () => {
        const state = readWatcherState(stateFile);
        const prior = state[issue.key] ?? { firstSeenAt: now, lastSentAt: null, sentCount: 0 };
        state[issue.key] = prior;
        const elapsed = now - prior.firstSeenAt;
        const elapsedHours = elapsed / 3600_000;
        const milestoneHours = elapsedHours < REMINDER_HOURS[0] ? 0
          : elapsedHours < REMINDER_HOURS[1] ? REMINDER_HOURS[0]
            : REMINDER_HOURS[1] + Math.floor((elapsedHours - REMINDER_HOURS[1]) / 24) * 24;
        // 실행이 건너뛰어져도 지난 임계값을 연속해서 따라잡지 않는다.
        // 전송 중 프로세스가 종료되면 표시가 남는다. 30분 지난 claim은 다시 시도한다.
        const sending = prior.sending && now - (prior.sendingAt ?? 0) < 30 * 60_000;
        const due = !queued && !sending
          && !(prior.sentCount && prior.lastSentAt >= prior.firstSeenAt + milestoneHours * 3600_000);
        const claimId = due ? randomUUID() : null;
        if (due) { prior.sending = true; prior.sendingAt = now; prior.sendingId = claimId; }
        writeAtomic(stateFile, JSON.stringify(state));
        return due ? { label: prior.sentCount ? '여전히 조용함' : '새 이슈', claimId } : null;
      });
      if (!claim) continue;
      let result;
      try {
        result = await send({ agent: SENDER_AGENT, kind: '판단', topic: '경고',
          facts: [`장애감지: ${claim.label}`, issue.text] },
        { subjectKey, targetJob: issue.job, queueFile, drainBeforeSend: false,
          watcherStateFile: stateFile, watcherIssueKey: issue.key });
      } finally {
        await withLock(stateFile, () => {
          const state = readWatcherState(stateFile);
          const prior = state[issue.key];
          if (prior?.sendingId === claim.claimId) {
            delete prior.sending;
            delete prior.sendingAt;
            delete prior.sendingId;
            if (result && !result.deferred) {
              prior.lastSentAt = now;
              prior.sentCount++;
              sent++;
            }
            writeAtomic(stateFile, JSON.stringify(state));
          }
        });
      }
    } catch (error) {
      console.error(`감시 이슈 경고 실패 (${issue.key}): ${error.message}`);
    }
  }
  const state = await withLock(stateFile, () => readWatcherState(stateFile));
  for (const [key, prior] of Object.entries(state)) {
    if (current.has(key)) continue;
    try {
      const subjectKey = warningSubjectKey('issue', key);
      const retired = isInactiveIssue(key);
      if (prior.sending && now - (prior.sendingAt ?? 0) < 30 * 60_000) continue;
      const issueKey = `health-watcher|JOB_HEALTH_ISSUES|${subjectKey}`;
      const queued = retired ? false : await hasDeferredIssue(issueKey, queueFile, sendWithoutDrain);
      const claimId = randomUUID();
      const claimed = await withLock(stateFile, () => {
        const latest = readWatcherState(stateFile);
        if (!latest[key] || (latest[key].sending && now - (latest[key].sendingAt ?? 0) < 30 * 60_000)) return false;
        latest[key].sending = true;
        latest[key].sendingAt = now;
        latest[key].sendingId = claimId;
        writeAtomic(stateFile, JSON.stringify(latest));
        return true;
      });
      if (!claimed) continue;
      try {
        if (!retired && (prior.sentCount > 0 || queued)) {
          await resolveDeferredIssue(issueKey, queueFile, sendWithoutDrain);
          if (!queued) {
            await send({ agent: SENDER_AGENT, kind: '판단', topic: '복구',
              facts: [recoveryText(key)] }, { warningCode: 'JOB_HEALTH_RECOVERED', subjectKey, queueFile,
              drainBeforeSend: false });
            sent++;
          }
        }
        await withLock(stateFile, () => {
          const latest = readWatcherState(stateFile);
          if (latest[key]?.sendingId === claimId) {
            delete latest[key];
            writeAtomic(stateFile, JSON.stringify(latest));
          }
        });
      } catch (error) {
        await withLock(stateFile, () => {
          const latest = readWatcherState(stateFile);
          if (latest[key]?.sendingId === claimId) {
            delete latest[key].sending;
            delete latest[key].sendingAt;
            delete latest[key].sendingId;
          }
          writeAtomic(stateFile, JSON.stringify(latest));
        });
        throw error;
      }
    } catch (error) { console.error(`감시 이슈 복구 실패 (${key}): ${error.message}`); }
    }
  return { sent };
}


// 텔레그램 상시세션 프로세스 감시 — 그 세션 자체가 Phase 5 산출물이라 아직 없다.
// 환경변수로 명시적으로 켜지 않으면 이 체크는 건너뛴다(오탐 방지).
const WATCH_TELEGRAM_SESSION = process.env.WATCH_TELEGRAM_SESSION === '1';

// switchedOff: 꺼진 전략의 잡 이름 집합(strategy-switch.mjs switchedOffJobs). 기대 주기 표는 그대로 두고
// 여기서만 거르므로, 전략을 다시 켜면 감시가 저절로 돌아온다.
// 2026-11-03: 기대 주기 표에는 있는데 하트비트 파일이 한 번도 생기지 않은 잡도 잡는다(예전엔 폴더의 .md만 봐서
// 처음부터 안 도는 잡을 못 봤다). 아직 가동 전인 잡은 job-schedule.mjs JOB_FIRST_HEARTBEAT_BY 날짜(KST)까지 유예한다.
// includeMissing: 파일 없는 잡까지 볼지. main()은 켠다. 끄면 예전처럼 폴더에 있는 파일만 본다(일부 파일만 둔 시험용).
export function findStaleJobs(jobHealthDir, { now = new Date(), expectedIntervals = EXPECTED_INTERVALS_MS,
  defaultIntervalMs = EXPECTED_INTERVAL_DEFAULT_MS, switchedOff = new Set(),
  includeMissing = false, firstHeartbeatBy = JOB_FIRST_HEARTBEAT_BY } = {}) {
  if (!existsSync(jobHealthDir)) return [];
  const stale = [];
  const seen = new Set();
  for (const file of readdirSync(jobHealthDir)) {
    if (!file.endsWith('.md')) continue;
    const job = file.replace(/\.md$/, '');
    seen.add(job);
    if (isInactiveJob(job) || switchedOff.has(job)) continue;
    const expectedIntervalMs = Object.hasOwn(expectedIntervals, job)
      ? expectedIntervals[job] : defaultIntervalMs;
    const record = parseFrontmatter(readFileSync(join(jobHealthDir, file), 'utf8'));
    if (isStale({ lastRun: record.lastRun, expectedIntervalMs, now })) {
      stale.push({ job, lastRun: record.lastRun ?? null, expectedIntervalMs });
    }
  }
  if (!includeMissing) return stale;
  const today = kstDateOf(now.getTime());
  for (const [job, expectedIntervalMs] of Object.entries(expectedIntervals)) {
    if (seen.has(job) || expectedIntervalMs === null || isInactiveJob(job) || switchedOff.has(job)) continue;
    if (firstHeartbeatBy[job] && today < firstHeartbeatBy[job]) continue;
    stale.push({ job, lastRun: null, expectedIntervalMs });
  }
  return stale;
}

// ── 데이터 신선도(2026-11-03, 데이터 체계 개선 ④) ──
// 표는 lib/data-sources.mjs, 판정은 lib/data-freshness.mjs. 긴급 출처는 위 잡 경보와 같은 processHealthIssues 일정으로,
// 나머지는 09·19시 담당별 묶음(runFreshnessDigest)으로 보낸다.
export function checkDataFreshness({ now = Date.now(), root = VAULT_PATHS.root, silentJobs = new Set(), openSince = {},
  sources = DATA_SOURCES, isTradingDay = (label) => krxTradingDayFromCache(label) } = {}) {
  const readers = createVaultReaders({ root, rel: VAULT_REL, isTradingDay });
  return findStaleSources({ now, sources, readers, silentJobs, openSince });
}

// 이미 경보 중인 출처의 처음 감지 시각 — 긴급은 감시 상태(source:<id>:stale), 비긴급은 묶음 상태에서 읽는다. 읽기만 한다.
export function readOpenSince({ watcherStateFile = WATCHER_STATE_FILE, digestStateFile = FRESHNESS_DIGEST_STATE_FILE } = {}) {
  const open = {};
  try { Object.assign(open, digestOpenSince(JSON.parse(readFileSync(digestStateFile, 'utf8')))); } catch { /* 없으면 빈 값 */ }
  try {
    for (const [key, issue] of Object.entries(JSON.parse(readFileSync(watcherStateFile, 'utf8')))) {
      const match = /^source:([^:]+):stale$/.exec(key);
      if (match && Number.isFinite(issue?.firstSeenAt)) open[match[1]] = issue.firstSeenAt;
    }
  } catch { /* 없으면 빈 값 */ }
  return open;
}

// 거래일 캐시는 그날 조회한 파일만 믿는다(krx-trading-calendar.mjs). 없으면 null → 판정 쪽이 주말만 쉬는 날로 본다.
function krxTradingDayFromCache(label) {
  return readKrxTradingDayStatus(new Date(`${label}T12:00:00+09:00`)).isOpen;
}

// 감시 상태에서 지금 경보 중인 출처 키를 읽는다. 읽기만 한다(손상 격리는 processHealthIssues 몫).
export function readPriorSourceKeys(stateFile = WATCHER_STATE_FILE) {
  try {
    return new Set(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8'))).filter((key) => key.startsWith('source:')));
  } catch { return new Set(); }
}

// 긴급 출처 → 감시 이슈(processHealthIssues 일정 — 처음·6시간·24시간·하루 한 번).
// - stale → source:<id>:stale, 판정 실패(error) → source:<id>:error.
// - 판정을 못 했거나(error) 다른 경보로 묶였는데(suppressed) 이미 stale 경보 중이던 출처는 그 이슈를 유지한다 —
//   빠지면 processHealthIssues가 "복구됨"을 보낸다(가짜 복구).
// - results가 null(검사 전체 실패)이면 freshness:check-failed를 내고 경보 중이던 source:* 이슈를 모두 유지한다.
export function sourceIssuesFor(results, priorKeys) {
  if (!results) {
    return [{ key: 'freshness:check-failed', text: '데이터 신선도 검사 전체가 실패했습니다 — health-watcher 로그 확인' },
      ...[...priorKeys].map((key) => ({ key, text: `데이터 신선도 검사 실패 — 이전 경보 유지(${key})` }))];
  }
  const issues = [];
  for (const r of results) {
    if (!r.urgent) continue;
    const key = sourceIssueKey(r.id);
    if (r.status === 'stale') issues.push({ key, text: formatSourceIssue(r) });
    if (r.status === 'error') issues.push({ key: `source:${r.id}:error`, text: formatSourceIssue(r) });
    if ((r.status === 'error' || r.status === 'suppressed') && priorKeys.has(key)) {
      issues.push({ key, text: `${formatSourceIssue({ ...r, status: 'stale' })} (판정 보류 — 이전 경보 유지)` });
    }
  }
  return issues;
}

// 비긴급 출처 묶음 발송. 30분마다 상태를 갱신하고, 09·19시 슬롯(3시간 안)에 처음 도는 실행만 담당별로 한 번 보낸다.
// 슬롯 처리 표시는 발송 전에 남긴다 — 발송 중 죽어도 같은 슬롯에 두 번 보내지 않는다.
export async function runFreshnessDigest(results, { stateFile = FRESHNESS_DIGEST_STATE_FILE, send = sendFreshnessDigest,
  now = Date.now() } = {}) {
  if (process.env.NODE_TEST_CONTEXT && stateFile === FRESHNESS_DIGEST_STATE_FILE) {
    throw new Error('테스트에서 실 신선도 묶음 상태 경로 사용 금지');
  }
  mkdirSync(dirname(stateFile), { recursive: true });
  const slot = currentDigestSlot(now);
  const plan = await withLock(stateFile, () => {
    let prior = {};
    try { prior = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* 없거나 깨졌으면 빈 상태 */ }
    const next = trackDigestState(prior, results, now);
    let planned = null;
    if (slot && next.lastSlot !== slot) {
      planned = planDigest(next, results, now);
      next.lastSlot = slot;
      for (const id of planned.dropped) delete next.sources[id];
    }
    writeAtomic(stateFile, JSON.stringify(next));
    return planned;
  });
  if (!plan) return { sent: 0 };
  const owners = new Map();
  for (const r of plan.due) owners.set(r.owner, [...(owners.get(r.owner) ?? []), { r, line: `${r.reminder ? '계속' : '새 경보'}: ${formatSourceIssue(r)}` }]);
  for (const r of plan.recovered) owners.set(r.owner, [...(owners.get(r.owner) ?? []), { r, line: `복구됨: 데이터 <code>${r.label}</code>(${r.id})`, recovered: true }]);
  let sent = 0;
  for (const [owner, items] of owners) {
    try {
      await send({ agent: owner, kind: '판단', topic: '데이터 신선도', llm: false, facts: items.map((item) => item.line) },
        { subjectKey: `digest:${owner}` });
    } catch (error) {
      console.error(`데이터 신선도 묶음 발송 실패 (${owner}): ${error.message}`);
      continue;
    }
    sent += 1;
    await withLock(stateFile, () => {
      let state = {};
      try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return; }
      state.sources ??= {};
      for (const item of items) {
        if (item.recovered) delete state.sources[item.r.id];
        else if (state.sources[item.r.id]) state.sources[item.r.id].lastSentAt = now;
      }
      writeAtomic(stateFile, JSON.stringify(state));
    });
  }
  return { sent };
}

export function writeDataFreshnessFile(results, { file = DATA_FRESHNESS_FILE, now = Date.now() } = {}) {
  if (process.env.NODE_TEST_CONTEXT && file === DATA_FRESHNESS_FILE) throw new Error('테스트에서 실볼트 신선도 파일 경로 사용 금지');
  return writeIfChanged(file, buildFreshnessDocument(results, now), { now, vaultRoot: DEFAULT_VAULT_ROOT });
}

// s: findStaleJobs()가 반환한 { job, lastRun, expectedIntervalMs } 하나. 순수 함수 —
// describeJob·JOB_REMEDIATION 조회만 하고 I/O 없음. 잡 이름만 영어로 나오면 오너가
// 어떤 잡인지 못 알아본다(2026-08-17 지적) — describeJob으로 한글 설명을 괄호로
// 덧붙인다. 2026-08-23(오너 지시) — 알려진 조치사항이 있는 잡이면 바로 뭘 확인해야
// 하는지 덧붙인다(JOB_REMEDIATION). 없는 잡은 그냥 안 붙는다 — 근거 없는 일반론을
// 채우지 않는다는 그 파일의 원칙 그대로.
export function formatStaleJobIssue(s) {
  const lastRunDesc = s.lastRun ? `마지막 실행 ${s.lastRun}` : '실행 기록 없음';
  let line = `잡 <code>${describeJob(s.job)}</code>이(가) 조용합니다 — ${lastRunDesc}(기대주기 ${Math.round(s.expectedIntervalMs / 60000)}분의 2배 초과)`;
  const remediation = JOB_REMEDIATION[s.job];
  if (remediation) line += `\n  → 확인: ${remediation}`;
  return line;
}

async function main() {
  try {
    // 결정 문서를 못 읽으면 전부 꺼짐(fail-closed)이라 전략 잡 경보가 빠진다. 칸이 없는 것(끈 상태)과 달리
    // 문서 고장은 원인 모를 꺼짐이므로 따로 경보한다.
    const switchStatus = strategySwitchStatus();
    const switchedOff = switchedOffJobs(switchStatus.switches);
    const staleJobs = findStaleJobs(VAULT_PATHS.state.jobHealth, { switchedOff, includeMissing: true });
    const issues = staleJobs.map((stale) => ({
      key: `job:${stale.job}:silent`, job: stale.job, text: formatStaleJobIssue(stale),
    }));
    // 데이터 신선도 — 잡 검사 다음, 따로 감싼다. 여기서 throw해도 잡 감시는 계속된다.
    const freshnessNow = Date.now();
    let freshness = null;
    try {
      freshness = checkDataFreshness({ now: freshnessNow, silentJobs: new Set(staleJobs.map((stale) => stale.job)),
        openSince: readOpenSince() });
    }
    catch (error) { console.error('데이터 신선도 검사 실패:', error.message); }
    issues.push(...sourceIssuesFor(freshness?.results ?? null, readPriorSourceKeys()));
    if (switchStatus.fault) {
      issues.push({ key: 'strategy-switch:unreadable', text:
        `전략 스위치(결정 ${STRATEGY_DECISION_KEY})를 읽지 못해 모든 전략을 꺼짐으로 처리 중입니다 — ${switchStatus.reason}` });
    }

    if (WATCH_TELEGRAM_SESSION) {
      if (!isProcessAlive(TELEGRAM_SESSION_PROCESS_PATTERN)) {
        issues.push({ key: 'telegram:process:missing', text: '텔레그램 상시 세션이 응답하지 않습니다(프로세스 없음).' });
      } else {
        // 프로세스는 살아있어도 폴링이 멈췄을 수 있다(좀비 상태, 위 isPollingStuck 주석
        // 참고) — 이 체크는 실패해도(네트워크 오류 등) 다른 잡의 stale 판정을 막지 않게
        // 별도로 감싼다.
        try {
          const info = await getTelegramWebhookInfo();
          if (isPollingStuck({ pendingUpdateCount: info.pending_update_count })) {
            issues.push({ key: 'telegram:polling:stuck', text:
              `텔레그램 상시 세션이 좀비 상태로 보입니다 — 프로세스는 살아있지만\n` +
              `미수신 메시지 ${info.pending_update_count}건이 큐에 쌓여있습니다(폴링 중단 의심).\n세션 재시작 필요.` });
          }
        } catch (e) {
          console.error('텔레그램 폴링 상태 확인 실패(getWebhookInfo) —', e.message);
          issues.push({ key: 'telegram:polling:check-failed', text: '텔레그램 폴링 상태 확인 실패(getWebhookInfo) — 로그 확인 필요' });
        }
      }
    }

    if (!issues.length) console.log('✅ health-watcher: 이상 없음');
    else {
      console.log(`🚨 health-watcher: 이상 ${issues.length}건 감지`);
      issues.forEach((i) => console.log(`  ${i.text}`));
    }
    if (freshness) {
      console.log('데이터 신선도:');
      for (const r of freshness.results) {
        const last = r.lastAt === null ? '-' : new Date(r.lastAt).toISOString();
        console.log(`  ${r.id.padEnd(22)} ${r.status.padEnd(13)} ${last} ${r.detail}`);
      }
    }
    if (DRY_RUN) return;
    try { await processHealthIssues(issues, { switchedOff }); }
    catch (error) { console.error('텔레그램 알림 실패:', error.message); }
    if (freshness) {
      try { if (writeDataFreshnessFile(freshness.results, { now: freshnessNow })) console.log('데이터 신선도 파일 갱신'); }
      catch (error) { console.error('데이터 신선도 파일 쓰기 실패:', error.message); }
      try { await runFreshnessDigest(freshness.results, { now: freshnessNow }); }
      catch (error) { console.error('데이터 신선도 묶음 실패:', error.message); }
    }
  } finally {
    // 스캔·장애 알림 어느 단계가 실패해도 보류 큐를 독립적으로 확인한다.
    if (!DRY_RUN) {
      try { await drainDeferredWarnings({ send: sendAgentMessage }); }
      catch (error) { console.error('아침 보류 경고 정리 실패:', error.message); }
    }
  }
}

// 직접 실행될 때만 main()을 돈다 — findStaleJobs를 테스트에서 import할 때 전체 잡이
// 실행되고 텔레그램까지 시도되는 사고를 막는다(drain-eval-queue.mjs와 동일 관례).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ health-watcher 오류:', e.message); process.exit(1); });
}
