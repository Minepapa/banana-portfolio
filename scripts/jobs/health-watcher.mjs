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
import { EXPECTED_INTERVALS_MS, EXPECTED_INTERVAL_DEFAULT_MS, isInactiveJob } from '../lib/job-schedule.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
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
export const REMINDER_HOURS = [6, 24];
const sendWarning = createDirectWarningSender(sendAgentMessage, {
  jobName: 'health-watcher', warningCode: 'JOB_HEALTH_ISSUES', subjectKey: 'batch',
  kind: 'operational', severity: 'high',
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

function isInactiveJobIssue(key) {
  const match = /^job:([^:]+):silent$/.exec(key);
  return match !== null && isInactiveJob(match[1]);
}

export async function processHealthIssues(issues, { stateFile = WATCHER_STATE_FILE,
  send = sendWarning, now = Date.now(), queueFile } = {}) {
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
    const retiredIssueKeys = new Set(Object.keys(priorState).filter(isInactiveJobIssue).map((key) =>
      `health-watcher|JOB_HEALTH_ISSUES|${warningSubjectKey('issue', key)}`));
    await cancelDeferredWarnings((entry) => {
      const source = entry.source;
      const sourceKey = source?.watcherIssueKey;
      if (sourceKey) return (!source.jobName || source.jobName === 'health-watcher')
        && (!source.warningCode || source.warningCode === 'JOB_HEALTH_ISSUES')
        && isInactiveJobIssue(sourceKey);
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
      const retired = isInactiveJobIssue(key);
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
              facts: [`복구됨: ${key}`] }, { warningCode: 'JOB_HEALTH_RECOVERED', subjectKey, queueFile,
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

export function findStaleJobs(jobHealthDir, { now = new Date(), expectedIntervals = EXPECTED_INTERVALS_MS,
  defaultIntervalMs = EXPECTED_INTERVAL_DEFAULT_MS } = {}) {
  if (!existsSync(jobHealthDir)) return [];
  const stale = [];
  for (const file of readdirSync(jobHealthDir)) {
    if (!file.endsWith('.md')) continue;
    const job = file.replace(/\.md$/, '');
    if (isInactiveJob(job)) continue;
    const expectedIntervalMs = Object.hasOwn(expectedIntervals, job)
      ? expectedIntervals[job] : defaultIntervalMs;
    const record = parseFrontmatter(readFileSync(join(jobHealthDir, file), 'utf8'));
    if (isStale({ lastRun: record.lastRun, expectedIntervalMs, now })) {
      stale.push({ job, lastRun: record.lastRun ?? null, expectedIntervalMs });
    }
  }
  return stale;
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
    const issues = findStaleJobs(VAULT_PATHS.state.jobHealth).map((stale) => ({
      key: `job:${stale.job}:silent`, job: stale.job, text: formatStaleJobIssue(stale),
    }));

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
    if (DRY_RUN) return;
    try { await processHealthIssues(issues); }
    catch (error) { console.error('텔레그램 알림 실패:', error.message); }
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
