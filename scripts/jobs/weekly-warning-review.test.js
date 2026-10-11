import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildJobHealthRecord } from '../lib/job-health.mjs';
import { buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { renderAgentMessage } from '../lib/pantheon-send.mjs';
import { previousWeekSunday, readWeekEvents, summarizeWeek, buildMessage, renderAggregate, run } from './weekly-warning-review.mjs';

const WEEK = '2026-03-29'; // 일~토 사이에 월 경계가 있다.
function event(at, incident, type = 'detected', extra = {}) {
  return { eventId: randomUUID(), occurredAt: at, jobName: 'example-job', warningCode: 'EXAMPLE_WARNING',
    incidentId: incident, eventType: type, kind: 'operational', severity: 'medium', detail: '가린 요약', ...extra };
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'warning-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writeMonth = (month, events) => {
    const path = join(root, VAULT_REL.logWarningEvents, `${month}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, events.map((row) => JSON.stringify(row)).join('\n') + '\n');
  };
  const rules = [{ type: 'report', pathRegex: /^50_Outputs\/Reports\/\d{4}\/.*\.md$/,
    required: { bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'], extra: ['author', 'model'] }, titleRegex: /^\d{4}-\d{2}-\d{2} \S/ }];
  return { root, writeMonth, rules };
}

test('주·월 경계와 eventId 중복을 KST 개별 이벤트로 거른다', (t) => {
  const { root, writeMonth } = fixture(t);
  const before = event('2026-03-28T14:59:59.999Z', 'before');
  const first = event('2026-03-28T15:00:00.000Z', 'first');
  const across = event('2026-03-31T15:00:00.000Z', 'across');
  const last = event('2026-04-04T14:59:59.999Z', 'last');
  const after = event('2026-04-04T15:00:00.000Z', 'after');
  writeMonth('2026-03', [before, first, across]);
  writeMonth('2026-04', [across, last, after]);
  assert.deepEqual(readWeekEvents({ root, week: WEEK }).map((row) => row.incidentId), ['first', 'across', 'last']);
  assert.equal(previousWeekSunday(new Date('2026-04-05T00:00:00.000Z')), WEEK);
  assert.throws(() => readWeekEvents({ root, week: '2026-03-30' }), /일요일/);
});

function writeHealth(root, job, status, at = '2026-04-05T00:00:00.000Z') {
  const path = join(root, VAULT_REL.jobHealth, `${job}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildJobHealthRecord({ job, status, now: new Date(at) }).content);
}

test('성격별 판정, JobHealth 복구 및 확인 불가를 구분한다', (t) => {
  const { root } = fixture(t);
  writeHealth(root, 'example-job', 'OK');
  const rows = [
    event('2026-03-29T01:00:00.000Z', 'op'),
    event('2026-03-29T02:00:00.000Z', 'market', 'detected', { jobName: 'market', kind: 'market-signal' }),
    event('2026-03-29T03:00:00.000Z', 'trade', 'detected', { jobName: 'trade', kind: 'trade-safety' }),
    event('2026-03-29T04:00:00.000Z', 'data', 'detected', { jobName: 'data', kind: 'data-quality', severity: 'high' }),
    event('2026-03-29T05:00:00.000Z', 'missing', 'detected', { jobName: 'missing' }),
    event('2026-03-29T06:00:00.000Z', 'legacy', 'detected', { jobName: 'old', warningCode: 'LEGACY_WARNING_BATCH', kind: 'legacy-unstructured' }),
  ];
  const result = summarizeWeek(rows, { root });
  assert.equal(result.items.find((item) => item.job === 'example-job').status, '복구됨');
  assert.equal(result.items.find((item) => item.job === 'missing').status, '확인 불가');
  assert.deepEqual(result.anomalies.map((item) => item.job), ['data', 'missing', 'trade']);
  assert.equal(result.items.find((item) => item.job === 'old').unclassified, true);
});

test('잡×코드로 묶고 3회부터 반복이며 미기록 하트비트 대상은 추정하지 않는다', (t) => {
  const { root } = fixture(t);
  writeHealth(root, 'example-job', 'OK');
  const rows = [
    event('2026-03-29T01:00:00.000Z', 'one'),
    event('2026-03-29T02:00:00.000Z', 'two'),
    event('2026-03-29T03:00:00.000Z', 'three'),
    event('2026-03-29T04:00:00.000Z', 'old', 'detected', { jobName: 'record-heartbeat-vault', warningCode: 'JOB_HEARTBEAT_FAILED' }),
  ];
  const result = summarizeWeek(rows, { root });
  const repeated = result.items.find((item) => item.job === 'example-job');
  assert.equal(repeated.detected, 3);
  assert.equal(repeated.incidentCount, 3);
  assert.deepEqual(repeated.reasons, ['반복']);
  assert.equal(result.items.find((item) => item.job.includes('대상 잡 미기록')).status, '확인 불가');
});

test('2회는 반복이 아니고 전체 표의 사건 수는 숫자로 표시된다', (t) => {
  const { root } = fixture(t);
  writeHealth(root, 'example-job', 'OK');
  const result = summarizeWeek([
    event('2026-03-29T01:00:00.000Z', 'one'),
    event('2026-03-29T02:00:00.000Z', 'two'),
  ], { root });
  assert.equal(result.anomalies.length, 0);
  assert.match(renderAggregate(WEEK, result), /\| example-job \| EXAMPLE_WARNING \| 2 \| 2 \|/);
});

test('텔레그램 이상은 5줄까지만, 나머지 수와 미분류 총합은 한 줄로 보인다', () => {
  const rows = Array.from({ length: 7 }, (_, index) => event(
    `2026-03-29T0${index + 1}:00:00.000Z`, `trade-${index}`, 'detected',
    { jobName: `trade-${index}`, kind: 'trade-safety' },
  ));
  rows.push(event('2026-03-29T08:00:00.000Z', 'legacy-1', 'detected',
    { jobName: 'old', warningCode: 'LEGACY_WARNING_BATCH', kind: 'legacy-unstructured' }));
  rows.push(event('2026-03-29T09:00:00.000Z', 'legacy-2', 'detected',
    { jobName: 'old', warningCode: 'LEGACY_WARNING_BATCH', kind: 'legacy-unstructured' }));
  const message = buildMessage(WEEK, summarizeWeek(rows));
  assert.equal(message.facts.filter((fact) => fact.includes(' · ')).length, 5);
  assert.ok(message.facts.includes('외 2건(노트 참고)'));
  assert.ok(message.facts.includes('미분류 2건(잡 1개)'));
});

test('미분류와 시장 신호만 있으면 노트만 쓰고 발송하지 않는다', async (t) => {
  const { root, writeMonth, rules } = fixture(t);
  writeMonth('2026-03', [
    event('2026-03-29T01:00:00.000Z', 'legacy', 'detected',
      { jobName: 'old', warningCode: 'LEGACY_WARNING_BATCH', kind: 'legacy-unstructured' }),
    event('2026-03-29T02:00:00.000Z', 'market', 'detected', { kind: 'market-signal' }),
  ]);
  const sent = [];
  const result = await run({ root, week: WEEK, rules, send: async (message) => { sent.push(message); } });
  assert.equal(result.message, null);
  assert.equal(result.sent, false);
  assert.deepEqual(sent, []);
  assert.match(result.note, /## 미분류\n\n- old: 1건/);
});

test('텔레그램 세션 상태와 health-watcher 재경고를 반영한다', (t) => {
  const { root } = fixture(t);
  writeHealth(root, 'health-watcher', 'OK', '2026-03-29T04:00:00.000Z');
  const path = join(root, VAULT_REL.stateTelegramSessionHealth, 'status.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildFrontmatter({ checkedAt: '2026-03-29T01:10:00.000Z', lastUnhealthyAtMs: Date.parse('2026-03-29T01:00:00.000Z') }));
  const session = event('2026-03-29T01:00:00.000Z', 'session', 'detected', { jobName: 'telegram-session-health-check', warningCode: 'TELEGRAM_SESSION_UNHEALTHY' });
  const watcher = event('2026-03-29T02:00:00.000Z', 'watch', 'detected', { jobName: 'health-watcher', warningCode: 'JOB_HEALTH_ISSUES' });
  const result = summarizeWeek([session, watcher], { root });
  assert.equal(result.items.find((item) => item.job === 'telegram-session-health-check').status, '확인 불가');
  assert.equal(result.items.find((item) => item.job === 'health-watcher').status, '복구됨');
  const rewarning = event('2026-03-29T03:00:00.000Z', 'again', 'detected',
    { jobName: 'health-watcher', warningCode: 'JOB_HEALTH_ISSUES' });
  assert.equal(summarizeWeek([watcher], { root, laterEvents: [rewarning] }).items[0].status, '미해결');
  writeFileSync(path, buildFrontmatter({ checkedAt: '2026-03-29T05:00:00.000Z', lastUnhealthyAtMs: null }));
  assert.equal(summarizeWeek([session], { root }).items[0].status, '복구됨');
});

test('health-watcher의 같은 실행 하트비트는 복구 근거가 아니며 주간 이후 재경고도 읽는다', async (t) => {
  const { root, writeMonth, rules } = fixture(t);
  const warning = event('2026-03-29T01:00:00.000Z', 'watch', 'detected',
    { jobName: 'health-watcher', warningCode: 'JOB_HEALTH_ISSUES' });
  writeMonth('2026-03', [warning]);
  writeHealth(root, 'health-watcher', 'OK', '2026-03-29T01:00:05.000Z');
  assert.equal(summarizeWeek([warning], { root }).items[0].status, '확인 불가');

  writeHealth(root, 'health-watcher', 'OK', '2026-04-05T02:00:00.000Z');
  writeMonth('2026-04', [event('2026-04-05T01:00:00.000Z', 'later', 'detected',
    { jobName: 'health-watcher', warningCode: 'JOB_HEALTH_ISSUES' })]);
  const rewarned = await run({ root, week: WEEK, rules, dryRun: true });
  assert.equal(rewarned.summary.items[0].status, '미해결');

  writeMonth('2026-04', []);
  const clean = await run({ root, week: WEEK, rules, dryRun: true });
  assert.equal(clean.summary.items[0].status, '복구됨');
});

test('JobHealth FAIL은 마지막 실행 시각이 이전이어도 미해결이다', (t) => {
  const { root } = fixture(t);
  writeHealth(root, 'example-job', 'FAIL', '2026-03-28T01:00:00.000Z');
  assert.equal(summarizeWeek([event('2026-03-29T01:00:00.000Z', 'one')], { root }).items[0].status, '미해결');
});

test('JobHealth WARN도 미해결이고 빈 상태는 확인 불가다', (t) => {
  const { root } = fixture(t);
  const warning = event('2026-03-29T01:00:00.000Z', 'one');
  writeHealth(root, 'example-job', 'WARN');
  assert.equal(summarizeWeek([warning], { root }).items[0].status, '미해결');
  writeHealth(root, 'example-job', '');
  assert.equal(summarizeWeek([warning], { root }).items[0].status, '확인 불가');
});

test('같은 전달 시도의 확정 결과는 원장 입력 순서가 뒤집혀도 유지된다', () => {
  const rows = [
    event('2026-03-29T01:00:00.000Z', 'one'),
    event('2026-03-29T01:02:00.000Z', 'one', 'delivery', { deliveryStatus: 'sent', deliveryAttemptId: 'attempt' }),
    event('2026-03-29T01:01:00.000Z', 'one', 'delivery', { deliveryStatus: 'sending', deliveryAttemptId: 'attempt' }),
  ];
  const result = summarizeWeek(rows);
  assert.deepEqual(result.items[0].delivery, { sent: 1, suppressed: 0, failed: 0, unknown: 0, deferred: 0 });
});

test('보류된 전달은 정리 발송 확정 전까지 불명으로 센다', () => {
  const rows = [
    event('2026-03-29T01:00:00.000Z', 'night'),
    event('2026-03-29T01:01:00.000Z', 'night', 'delivery', { deliveryStatus: 'deferred', deliveryAttemptId: 'attempt' }),
  ];
  const delivery = summarizeWeek(rows).items[0].delivery;
  assert.equal(delivery.deferred, 1);
  assert.equal(delivery.unknown, 1);
});

test('아침 정리 발송 확정 결과가 같은 시도에 기록되면 보류를 sent로 집계한다', () => {
  const rows = [
    event('2026-03-29T01:00:00.000Z', 'night'),
    event('2026-03-29T01:01:00.000Z', 'night', 'delivery', { deliveryStatus: 'deferred', deliveryAttemptId: 'attempt' }),
    event('2026-03-29T22:01:00.000Z', 'night', 'delivery', { deliveryStatus: 'sent', deliveryAttemptId: 'attempt' }),
  ];
  const delivery = summarizeWeek(rows).items[0].delivery;
  assert.equal(delivery.sent, 1);
  assert.equal(delivery.unknown, 0);
});

test('일요일 밤 보류를 다음 주 월요일 아침에 확정해도 지난 주 sent로 집계한다', () => {
  const rows = [
    event('2026-03-29T14:30:00.000Z', 'sunday'),
    event('2026-03-29T14:31:00.000Z', 'sunday', 'delivery',
      { deliveryStatus: 'deferred', deliveryAttemptId: 'cross-week' }),
  ];
  const laterEvents = [event('2026-03-29T22:01:00.000Z', 'sunday', 'delivery',
    { deliveryStatus: 'sent', deliveryAttemptId: 'cross-week' })];
  const delivery = summarizeWeek(rows, { laterEvents }).items[0].delivery;
  assert.equal(delivery.sent, 1);
  assert.equal(delivery.unknown, 0);
});

test('0건 주도 노트를 쓰고 미발송하며, 재생성해도 오너 메모가 남는다', async (t) => {
  const { root, writeMonth, rules } = fixture(t);
  const sent = [];
  const initial = await run({ root, week: WEEK, rules, send: (message) => sent.push(message) });
  assert.match(initial.note, /경고 없음/);
  assert.deepEqual(sent, []);
  const path = join(root, initial.reportRel);
  const edited = readFileSync(path, 'utf8').replace('### 원인 조사\n\n- ', '### 원인 조사\n\n- 오너가 기록한 조사');
  writeFileSync(path, edited);
  writeMonth('2026-03', [event('2026-03-29T01:00:00.000Z', 'one')]);
  await run({ root, week: WEEK, rules, noSend: true, send: (message) => sent.push(message) });
  const saved = readFileSync(path, 'utf8');
  assert.match(saved, /오너가 기록한 조사/);
  assert.match(saved, /총 발생: 1건/);
  assert.equal(sent.length, 0);
});

test('발생은 있지만 발송·복구가 확인된 조용한 주는 노트만 쓴다', async (t) => {
  const { root, writeMonth, rules } = fixture(t);
  writeHealth(root, 'example-job', 'OK');
  writeMonth('2026-03', [
    event('2026-03-29T01:00:00.000Z', 'one'),
    event('2026-03-29T01:01:00.000Z', 'one', 'delivery', {
      deliveryStatus: 'sent', deliveryAttemptId: 'attempt',
    }),
    event('2026-03-29T01:02:00.000Z', 'one', 'status', { incidentStatus: 'resolved' }),
  ]);
  const sent = [];
  const result = await run({ root, week: WEEK, rules, send: async (message) => { sent.push(message); } });
  assert.equal(result.summary.totalDetected, 1);
  assert.equal(result.summary.anomalies.length, 0);
  assert.equal(result.written, true);
  assert.equal(result.sent, false);
  assert.equal(result.message, null);
  assert.deepEqual(sent, []);
  assert.match(readFileSync(join(root, result.reportRel), 'utf8'), /총 발생: 1건 · 이상 항목: 0건/);
});

test('dry-run은 쓰거나 발송하지 않고 no-send는 노트만 쓴다; 판단 4단 형식', async (t) => {
  const { root, writeMonth, rules } = fixture(t);
  writeMonth('2026-03', [event('2026-03-29T01:00:00.000Z', 'one', 'detected', { kind: 'trade-safety' })]);
  const sent = [];
  const preview = await run({ root, week: WEEK, rules, dryRun: true, send: (message) => sent.push(message) });
  assert.equal(preview.written, false);
  assert.equal(preview.sent, false);
  assert.equal(sent.length, 0);
  assert.match(renderAgentMessage(preview.message), /\[결론\][\s\S]*\[사실\][\s\S]*\[맥락\][\s\S]*\[의사결정\]/);
  const saved = await run({ root, week: WEEK, rules, noSend: true, send: (message) => sent.push(message) });
  assert.equal(saved.written, true);
  assert.equal(saved.sent, false);
  assert.equal(sent.length, 0);
});

test('이상이 있으면 주입한 발송 함수에 한 번 전달한다', async (t) => {
  const { root, writeMonth, rules } = fixture(t);
  writeMonth('2026-03', [event('2026-03-29T01:00:00.000Z', 'one', 'detected', { kind: 'trade-safety' })]);
  const sent = [];
  const result = await run({ root, week: WEEK, rules, send: async (message) => { sent.push(message); } });
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].agent, 'zeus');
  assert.equal(sent[0].kind, '판단');
});
