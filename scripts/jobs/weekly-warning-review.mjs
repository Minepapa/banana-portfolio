#!/usr/bin/env node
// 경고 원장의 개별 이벤트로 직전 일~토(KST)를 결정론적으로 검토한다.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_REL, VAULT_ROOT, categoryLink } from '../lib/vault-paths.mjs';
import { parseRegistry, checkNote } from '../lib/vault-registry.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { sanitizeWarningDetail } from '../lib/warning-event-journal.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { escapeHtml } from '../lib/telegram.mjs';

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;
const OWNER_HEADING = '## 오너 메모(원인 조사·조치·재검증)';
const REVIEW_START = '<!-- weekly-warning-review:aggregate:start -->';
const REVIEW_END = '<!-- weekly-warning-review:aggregate:end -->';

function dateString(utcMs) { return new Date(utcMs).toISOString().slice(0, 10); }
function startMs(week) { return Date.parse(`${week}T00:00:00.000Z`) - KST_OFFSET_MS; }
function kstStamp(iso) { return new Date(Date.parse(iso) + KST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16); }
function safeCell(value) { return String(value ?? '—').replace(/[\r\n\t|]/g, ' ').slice(0, 200); }

export function previousWeekSunday(now = new Date()) {
  const localDate = dateString(now.getTime() + KST_OFFSET_MS);
  const today = Date.parse(`${localDate}T00:00:00.000Z`);
  return dateString(today - (new Date(today).getUTCDay() + 7) * DAY_MS);
}

export function validateWeek(week) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || !Number.isFinite(Date.parse(`${week}T00:00:00.000Z`))
    || dateString(Date.parse(`${week}T00:00:00.000Z`)) !== week
    || new Date(`${week}T00:00:00.000Z`).getUTCDay() !== 0) {
    throw new Error('--week는 실제 일요일 YYYY-MM-DD여야 합니다');
  }
  return week;
}

function readJournalRange(root, start, end) {
  const months = new Set();
  for (let at = start; at < end; at = Math.min(end, at + 28 * DAY_MS)) {
    months.add(dateString(at + KST_OFFSET_MS).slice(0, 7));
  }
  if (end > start) months.add(dateString(end - 1 + KST_OFFSET_MS).slice(0, 7));
  const events = [];
  const seen = new Set();
  for (const month of months) {
    const path = join(root, VAULT_REL.logWarningEvents, `${month}.jsonl`);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { throw new Error(`경고 원장 JSON 행 손상: ${month}`); }
      const at = Date.parse(event.occurredAt);
      if (!Number.isFinite(at) || !event.eventId) throw new Error(`경고 원장 필수 필드 손상: ${month}`);
      if (at < start || at >= end || seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      events.push(event);
    }
  }
  return events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId));
}

export function readWeekEvents({ root = VAULT_ROOT, week }) {
  validateWeek(week);
  const start = startMs(week);
  const end = start + 7 * DAY_MS;
  return readJournalRange(root, start, end);
}

function targetJob(event) {
  if (event.targetJob) return event.targetJob;
  if (event.jobName === 'record-heartbeat-vault') return 'record-heartbeat-vault(대상 잡 미기록)';
  return event.jobName ?? '미분류';
}

function readStatus(root, relativePath) {
  if (!root) return null;
  try {
    return parseFrontmatter(readFileSync(join(root, relativePath), 'utf8'));
  } catch {
    return null;
  }
}

function operationalStatus(item, root, events, laterEvents) {
  if (item.job === 'health-watcher' && item.code === 'JOB_HEALTH_ISSUES') {
    const state = readStatus(root, `${VAULT_REL.jobHealth}/health-watcher.md`);
    const lastRun = Date.parse(state?.lastRun);
    // run.sh는 경고를 낸 바로 그 실행 직후에도 하트비트를 쓴다. 다음 30분 주기의
    // 실행 기록이 있어야 재경고 없이 정상 실행됐다는 근거로 삼을 수 있다.
    if (!Number.isFinite(lastRun) || lastRun < Date.parse(item.latest) + 30 * 60_000) return '확인 불가';
    const redetected = [...events, ...laterEvents].some((event) => event.jobName === 'health-watcher'
      && event.warningCode === item.code && event.eventType === 'detected'
      && event.occurredAt > item.latest && Date.parse(event.occurredAt) <= lastRun);
    return redetected ? '미해결' : '복구됨';
  }
  if (item.job === 'telegram-session-health-check' && item.code === 'TELEGRAM_SESSION_UNHEALTHY') {
    const state = readStatus(root, `${VAULT_REL.stateTelegramSessionHealth}/status.md`);
    const checkedAt = Date.parse(state?.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt < Date.parse(item.latest)) return '확인 불가';
    // 정상 실행 뒤에도 장애 시각을 몇 시간 보존하므로 값이 남아 있으면 단정할 수 없다.
    if (state.status === 'OK') return '복구됨';
    if (state.status === 'FAIL') return '미해결';
    return state.lastUnhealthyAtMs === null ? '복구됨' : '확인 불가';
  }
  if (item.job.endsWith('(대상 잡 미기록)')) return '확인 불가';
  const state = readStatus(root, `${VAULT_REL.jobHealth}/${item.job}.md`);
  const lastRun = Date.parse(state?.lastRun);
  if (typeof state?.status !== 'string' || !state.status.trim()) return '확인 불가';
  if (state.status !== 'OK') return '미해결';
  return Number.isFinite(lastRun) && lastRun >= Date.parse(item.latest) ? '복구됨' : '확인 불가';
}

export function summarizeWeek(events, { root = null, laterEvents = [] } = {}) {
  const groups = new Map();
  for (const event of events) {
    if (['JOB_HEARTBEAT_RECOVERED', 'JOB_HEALTH_RECOVERED'].includes(event.warningCode)
      && event.eventType === 'detected') {
      continue;
    }
    const job = targetJob(event);
    const code = event.warningCode ?? '미분류';
    const key = JSON.stringify([job, code]);
    if (!groups.has(key)) groups.set(key, { job, code, incidents: new Set(), kind: event.kind, severity: event.severity,
      detected: 0, first: null, latest: null,
      delivery: { sent: 0, suppressed: 0, failed: 0, unknown: 0, deferred: 0 }, detail: '', events: [],
      status: '—', unclassified: false, reasons: [] });
    const group = groups.get(key);
    group.events.push(event);
    if (event.eventType === 'detected') {
      group.kind = event.kind;
      if (!group.detected) group.severity = event.severity;
      group.detected++;
      group.incidents.add(event.incidentId ?? event.incidentKey ?? event.eventId);
      if (event.severity === 'high' || event.severity === 'critical') group.severity = event.severity;
      if (!group.first || event.occurredAt < group.first) group.first = event.occurredAt;
      if (!group.latest || event.occurredAt > group.latest) group.latest = event.occurredAt;
      if (!group.detail && event.detail) group.detail = sanitizeWarningDetail(event.detail);
    }
  }
  const items = [...groups.values()].filter((group) => group.detected > 0);
  for (const item of items) {
    const attemptIds = new Set(item.events.filter((event) => event.eventType === 'delivery')
      .map((event) => event.deliveryAttemptId).filter(Boolean));
    item.events.push(...laterEvents.filter((event) => event.eventType === 'delivery'
      && attemptIds.has(event.deliveryAttemptId)
      && targetJob(event) === item.job && event.warningCode === item.code));
  }
  for (const item of items) {
    item.incidentCount = item.incidents.size;
    delete item.incidents;
    // 한 시도의 reserved/sending 중간 이벤트는 최종 결과가 있으면 중복 집계하지 않는다.
    const attempts = new Map();
    for (const event of item.events.filter((row) => row.eventType === 'delivery')) {
      if (event.deliveryStatus === 'suppressed') { item.delivery.suppressed++; continue; }
      const id = event.deliveryAttemptId ?? event.eventId;
      const prior = attempts.get(id);
      const terminal = (status) => ['sent', 'rejected', 'unknown', 'deferred'].includes(status);
      // 입력 행 순서보다 시도별 최종 결과를 우선한다. 같은 시도의 늦은
      // sending 행이 이미 확정된 발송 결과를 불명으로 되돌리면 안 된다.
      if (!prior || (terminal(event.deliveryStatus) && !terminal(prior.deliveryStatus))
        || (terminal(event.deliveryStatus) === terminal(prior.deliveryStatus)
          && event.occurredAt >= prior.occurredAt)) attempts.set(id, event);
    }
    for (const { deliveryStatus: status } of attempts.values()) {
      if (status === 'sent') item.delivery.sent++;
      else if (status === 'rejected') item.delivery.failed++;
      else if (status === 'deferred') { item.delivery.deferred++; item.delivery.unknown++; }
      else item.delivery.unknown++;
    }
    if (!attempts.size && !item.delivery.suppressed) item.delivery.unknown++;
    item.unclassified = item.kind === 'legacy-unstructured';
    if (item.kind === 'operational') {
      item.status = operationalStatus(item, root, events, laterEvents);
      if (item.detected >= 3) item.reasons.push('반복');
      if (item.status !== '복구됨') item.reasons.push(item.status);
    } else if (item.kind === 'trade-safety') {
      item.status = '미해결';
      item.reasons.push('실거래 안전');
    } else if (item.kind === 'data-quality') {
      if (item.detected >= 3) item.reasons.push('반복');
      if (['high', 'critical'].includes(item.severity)) item.reasons.push('높은 심각도');
      item.status = item.reasons.includes('반복') ? '반복' : item.reasons.length ? '미해결' : '—';
    }
    delete item.events;
  }
  items.sort((a, b) => a.job.localeCompare(b.job) || a.code.localeCompare(b.code));
  return { items, anomalies: items.filter((item) => item.reasons.length && !item.unclassified),
    totalDetected: items.reduce((sum, item) => sum + item.detected, 0) };
}

function table(items) {
  if (!items.length) return '없음';
  return '| 잡 | 경고코드 | 사건 수 | 발생 | 최초 KST | 최근 KST | 발송/억제/실패/불명/보류 | 현재 상태 | 이상 사유 | 기록된 요약 |\n'
    + '| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- |\n'
    + items.map((item) => `| ${safeCell(item.job)} | ${safeCell(item.code)} | ${item.incidentCount} | ${item.detected} | ${kstStamp(item.first)} | ${kstStamp(item.latest)} | ${Object.values(item.delivery).join('/')} | ${item.status} | ${item.reasons.join('·') || '—'} | ${safeCell(item.detail)} |`).join('\n');
}

export function renderAggregate(week, summary) {
  const end = dateString(Date.parse(`${week}T00:00:00.000Z`) + 6 * DAY_MS);
  const unclassified = summary.items.filter((item) => item.unclassified);
  return `${REVIEW_START}\n## 요약\n\n기간: ${week} 00:00 ~ ${end} 24:00 KST\n총 발생: ${summary.totalDetected}건 · 이상 항목: ${summary.anomalies.length}건\n${summary.totalDetected ? '' : '\n경고 없음\n'}\n## 이상 항목\n\n${table(summary.anomalies)}\n\n## 잡별 전체\n\n${table(summary.items)}\n\n## 미분류\n\n${unclassified.length ? unclassified.map((item) => `- ${safeCell(item.job)}: ${item.detected}건`).join('\n') : '없음'}\n${REVIEW_END}`;
}

export function renderNote(week, summary, existing = null) {
  const aggregate = renderAggregate(week, summary);
  if (existing) {
    const start = existing.indexOf(REVIEW_START);
    const end = existing.indexOf(REVIEW_END);
    if (start < 0 || end < start) throw new Error('기존 노트의 집계 경계가 없어 오너 메모를 안전하게 보존할 수 없음');
    return existing.slice(0, start) + aggregate + existing.slice(end + REVIEW_END.length);
  }
  return buildFrontmatter({ type: 'report', reportKind: 'weekly-warning-review',
    category: [categoryLink('500 기술')], description: '경고 원장 주간 검토', sensitivity: '일반',
    created: week, modified: week, author: 'zeus', model: '없음' })
    + `\n# ${week} 경고 주간 검토\n\n${aggregate}\n\n${OWNER_HEADING}\n\n### 원인 조사\n\n- \n\n### 조치\n\n- \n\n### 재검증\n\n- \n`;
}

export function buildMessage(week, summary) {
  const facts = summary.anomalies.slice(0, 5).map((item) => `${escapeHtml(item.job)} · ${escapeHtml(item.code)} · ${item.detected}회 · ${item.reasons.includes('반복') ? '반복' : item.status}`);
  if (summary.anomalies.length > 5) facts.push(`외 ${summary.anomalies.length - 5}건(노트 참고)`);
  const unclassified = summary.items.filter((item) => item.unclassified);
  if (unclassified.length) facts.push(`미분류 ${unclassified.reduce((sum, item) => sum + item.detected, 0)}건(잡 ${unclassified.length}개)`);
  return { agent: 'zeus', kind: '판단', topic: '경고',
    conclusion: `${week} 경고 주간 검토: 이상 ${summary.anomalies.length}건`,
    facts, context: `총 발생 ${summary.totalDetected}건. 원장 분류와 잡 현재 상태를 검토했습니다.`,
    decisions: ['오너 메모의 원인 조사·조치·재검증 칸을 확인해 주세요.'] };
}

export async function run({ root = VAULT_ROOT, week = previousWeekSunday(), dryRun = false, noSend = false,
  rules, write = writeAtomic, send = (message) => sendAgentMessage(message) } = {}) {
  validateWeek(week);
  const weekEvents = readWeekEvents({ root, week });
  const weekEnd = startMs(week) + 7 * DAY_MS;
  const laterEvents = weekEvents.some((event) => event.deliveryStatus === 'deferred'
    || (event.jobName === 'health-watcher' && event.warningCode === 'JOB_HEALTH_ISSUES'))
    ? readJournalRange(root, weekEnd, Date.now()) : [];
  const summary = summarizeWeek(weekEvents, { root, laterEvents });
  const reportRel = `${VAULT_REL.logReports}/${week.slice(0, 4)}/${week} 경고 주간 검토.md`;
  const path = join(root, reportRel);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const note = renderNote(week, summary, existing);
  const activeRules = rules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  const problems = checkNote(reportRel, note, activeRules);
  if (problems.length) throw new Error(`경로 등록부 위반: ${problems.join(' / ')}`);
  if (!dryRun) { mkdirSync(dirname(path), { recursive: true }); write(path, note); }
  const message = summary.anomalies.length ? buildMessage(week, summary) : null;
  if (message && !dryRun && !noSend) await send(message);
  return { week, reportRel, summary, note, message, written: !dryRun, sent: !!message && !dryRun && !noSend };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const weekArg = args.find((arg) => arg.startsWith('--week='));
  run({ week: weekArg ? weekArg.slice(7) : previousWeekSunday(), dryRun: args.includes('--dry-run'),
    noSend: args.includes('--no-send') }).then((result) => {
    console.log(`${result.week} 경고 ${result.summary.totalDetected}건, 이상 ${result.summary.anomalies.length}건, 노트 ${result.written ? '저장' : '미리보기'}, 발송 ${result.sent ? '완료' : '없음'}`);
  }).catch((error) => { console.error(`경고 주간 검토 실패: ${error.message}`); process.exitCode = 1; });
}
