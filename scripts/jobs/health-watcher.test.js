import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJobHealthRecord } from '../lib/job-health.mjs';
import { sendDirectWarning } from '../lib/direct-warning-delivery.mjs';
import { deferWarning, drainDeferredWarnings } from '../lib/deferred-warnings.mjs';
import { findStaleJobs, isPollingStuck, formatStaleJobIssue, EXPECTED_INTERVALS_MS, processHealthIssues } from './health-watcher.mjs';

test('같은 이슈는 최초·6시간·24시간에만 보내고 복구는 한 번만 알린다', async (t) => {
  const dir = makeTmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'watcher.json');
  const queueFile = join(dir, 'deferred.json');
  const messages = [];
  const send = async (message) => { messages.push(message); return { ok: true, result: { message_id: messages.length } }; };
  const issue = [{ key: 'job:media-archive:silent', job: 'media-archive', text: '잡 media-archive가 조용합니다' }];
  const first = Date.parse('2026-10-11T03:00:00.000Z');
  for (const hours of [0, 0.5, 5.5, 6, 7, 23.5, 24, 25]) {
    await processHealthIssues(issue, { stateFile, queueFile, send, now: first + hours * 3600_000 });
  }
  assert.equal(messages.length, 3);
  assert.match(messages[0].facts[0], /새 이슈/);
  assert.match(messages[1].facts[0], /여전히 조용함/);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8'))[issue[0].key].sentCount, 3);
  await processHealthIssues([], { stateFile, queueFile, send, now: first + 25.5 * 3600_000 });
  await processHealthIssues([], { stateFile, queueFile, send, now: first + 26 * 3600_000 });
  assert.equal(messages.length, 4);
  assert.match(messages[3].facts[0], /복구됨/);
});

test('워처가 오래 멈췄다가 재개돼도 지난 리마인더를 연속 발송하지 않는다', async (t) => {
  const dir = makeTmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'watcher.json');
  const queueFile = join(dir, 'deferred.json');
  const sent = [];
  const send = async (message) => { sent.push(message); return { ok: true, result: { message_id: sent.length } }; };
  const issue = [{ key: 'job:media-archive:silent', job: 'media-archive', text: '조용함' }];
  const first = Date.parse('2026-10-11T03:00:00.000Z');
  for (const hours of [0, 25, 25.5, 26, 48]) {
    await processHealthIssues(issue, { stateFile, queueFile, send, now: first + hours * 3600_000 });
  }
  assert.equal(sent.length, 3);
});

test('손상된 watcher 상태를 격리하고 critical 경보 뒤 감시를 계속한다', async (t) => {
  const dir = makeTmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'watcher.json');
  writeFileSync(stateFile, '{bad');
  const messages = [];
  await processHealthIssues([{ key: 'job:one:silent', job: 'one', text: '조용함' }], {
    stateFile, queueFile: join(dir, 'queue.json'), now: Date.parse('2026-10-11T03:00:00Z'),
    send: async (message, details) => { messages.push({ message, details }); return { ok: true, result: { message_id: messages.length } }; },
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].details.severity, 'critical');
  assert.ok(readdirSync(dir).some((name) => name.startsWith('watcher.json.corrupt-')));
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8'))['job:one:silent'].sentCount, 1);
});

test('JSON 파싱은 되지만 null 이슈인 watcher 상태도 격리한다', async (t) => {
  const dir = makeTmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'watcher.json');
  writeFileSync(stateFile, JSON.stringify({ broken: null }));
  const messages = [];
  await processHealthIssues([], { stateFile, queueFile: join(dir, 'queue.json'),
    send: async (message, details) => { messages.push({ message, details });
      return { ok: true, result: { message_id: 1 } }; } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].details.severity, 'critical');
  assert.ok(readdirSync(dir).some((name) => name.startsWith('watcher.json.corrupt-')));
});

test('watcher 상태 잠금 안에서는 아침 drain을 재진입시키지 않는다', async (t) => {
  const dir = makeTmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'watcher.json');
  const queueFile = join(dir, 'queue.json');
  const journalRoot = join(dir, 'journal');
  const night = Date.parse('2026-10-11T15:00:00Z');
  const morning = Date.parse('2026-10-11T22:00:00Z');
  const send = (message, details) => sendDirectWarning({ message, ...details,
    jobName: 'health-watcher', warningCode: 'JOB_HEALTH_ISSUES', kind: 'operational', severity: 'high',
    journalRoot, queueFile, clock: () => current,
    send: async () => ({ ok: true, result: { message_id: 1 } }) });
  let current = night;
  await processHealthIssues([{ key: 'old', text: 'old' }], { stateFile, queueFile, send, now: current });
  current = morning;
  await processHealthIssues([{ key: 'old', text: 'old' }, { key: 'new', text: 'new' }],
    { stateFile, queueFile, send, now: current });
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).pending.length, 1);
  await drainDeferredWarnings({ queueFile, journalRoot, now: morning,
    send: async () => ({ ok: true, result: { message_id: 2 } }) });
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).old.sentCount, 1);
});

test('잠금 안의 큐 손상 경보도 다른 확인 대기 큐의 drain을 재진입시키지 않는다', async (t) => {
  const dir = makeTmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'watcher.json');
  const corruptQueue = join(dir, 'corrupt-queue.json');
  const inFlightQueue = join(dir, 'other-queue.json');
  const journalRoot = join(dir, 'journal');
  const night = Date.parse('2026-10-11T15:00:00Z');
  const morning = Date.parse('2026-10-11T22:00:00Z');
  writeFileSync(corruptQueue, '{broken');
  await deferWarning({ queueFile: inFlightQueue, agent: 'zeus', detail: '기존 경고', at: night,
    source: { watcherStateFile: stateFile, watcherIssueKey: 'old' } });
  let corruptionAlerts = 0;
  const send = (message, details = {}) => {
    if (details.warningCode === 'DEFERRED_QUEUE_CORRUPT') {
      corruptionAlerts++;
      assert.equal(details.drainBeforeSend, false);
    }
    return sendDirectWarning({ message, ...details, jobName: 'health-watcher',
      warningCode: details.warningCode ?? 'JOB_HEALTH_ISSUES',
      subjectKey: details.subjectKey ?? 'batch', kind: 'operational',
      severity: details.severity ?? 'high', journalRoot,
      queueFile: details.queueFile ?? inFlightQueue, clock: () => morning,
      send: async () => ({ ok: true, result: { message_id: 1 } }) });
  };
  await processHealthIssues([{ key: 'old', text: '조용함' }],
    { stateFile, queueFile: corruptQueue, now: morning, send });
  assert.equal(corruptionAlerts, 1);
  assert.equal(JSON.parse(readFileSync(inFlightQueue, 'utf8')).pending.length, 1);
  await drainDeferredWarnings({ queueFile: inFlightQueue, now: morning,
    send: async () => ({ ok: true, result: { message_id: 2 } }) });
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).old.sentCount, 2);
});

test('테스트에서는 기본 감시 상태 경로를 거부한다', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT);
  await assert.rejects(() => processHealthIssues([], { send: async () => ({ ok: true, result: { message_id: 1 } }) }),
    /실 감시 상태 경로/);
});

test('한 이슈 전송 실패가 다음 이슈와 복구를 막지 않는다', async (t) => {
  const dir = makeTmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'watcher.json');
  const queueFile = join(dir, 'queue.json');
  const first = Date.parse('2026-10-11T03:00:00Z');
  const send = async (message, details) => {
    if (details.subjectKey && message.facts?.[1] === '실패') throw new Error('send failed');
    return { ok: true, result: { message_id: 1 } };
  };
  await processHealthIssues([{ key: 'bad', text: '실패' }, { key: 'good', text: '성공' }],
    { stateFile, queueFile, now: first, send });
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.bad.sentCount, 0);
  assert.equal(state.good.sentCount, 1);
});

test('워처 전송 중에는 상태 잠금을 놓고 겹친 실행은 같은 이슈를 건너뛴다', async (t) => {
  const dir = makeTmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'watcher.json');
  const queueFile = join(dir, 'queue.json');
  const issue = [{ key: 'job:sample:silent', job: 'sample', text: '가상 잡 조용함' }];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const sending = new Promise((resolve) => { entered = resolve; });
  let sends = 0;
  const send = async () => {
    sends++;
    assert.equal(readdirSync(dir).includes('watcher.json.lock'), false);
    entered();
    await gate;
    return { ok: true, result: { message_id: 1 } };
  };
  const first = processHealthIssues(issue, { stateFile, queueFile, send, now: Date.parse('2026-10-11T03:00:00Z') });
  await sending;
  await processHealthIssues(issue, { stateFile, queueFile, send, now: Date.parse('2026-10-11T03:00:00Z') });
  release();
  await first;
  assert.equal(sends, 1);
});

test('중단된 워처 전송 표시는 30분 뒤 다시 시도한다', async (t) => {
  const dir = makeTmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'watcher.json');
  const first = Date.parse('2026-10-11T03:00:00Z');
  writeFileSync(stateFile, JSON.stringify({ stale: { firstSeenAt: first, lastSentAt: null,
    sentCount: 0, sending: true, sendingAt: first } }));
  let sends = 0;
  await processHealthIssues([{ key: 'stale', text: '가상 잡' }], {
    stateFile, queueFile: join(dir, 'queue.json'), now: first + 31 * 60_000,
    send: async () => { sends++; return { ok: true, result: { message_id: 1 } }; },
  });
  assert.equal(sends, 1);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).stale.sending, undefined);
});

test('만료된 전송의 늦은 완료는 새 전송 표시를 지우지 않는다', async (t) => {
  const dir = makeTmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'watcher.json');
  const queueFile = join(dir, 'queue.json');
  const issue = [{ key: 'stale', text: '가상 잡' }];
  const firstAt = Date.parse('2026-10-11T03:00:00Z');
  const releases = [];
  let wake;
  const entered = new Promise((resolve) => { wake = resolve; });
  const send = async () => {
    const gate = new Promise((resolve) => { releases.push(resolve); });
    wake();
    await gate;
    return { ok: true, result: { message_id: 1 } };
  };
  const first = processHealthIssues(issue, { stateFile, queueFile, now: firstAt, send });
  await entered;
  const second = processHealthIssues(issue, { stateFile, queueFile, now: firstAt + 31 * 60_000, send });
  while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  releases[0]();
  await first;
  await processHealthIssues(issue, { stateFile, queueFile, now: firstAt + 31 * 60_000, send });
  assert.equal(releases.length, 2);
  releases[1]();
  await second;
});

test('07시 첫 실행은 밤새 보류된 이슈를 요약하고 별도 리마인더를 중복 발송하지 않는다', async (t) => {
  const dir = makeTmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'watcher.json');
  const queueFile = join(dir, 'deferred.json');
  const journalRoot = join(dir, 'journal');
  const direct = [];
  const send = (message, details) => sendDirectWarning({
    message, ...details, journalRoot, queueFile, jobName: 'health-watcher',
    warningCode: 'JOB_HEALTH_ISSUES', kind: 'operational', severity: 'high',
    clock: () => current,
    send: async (item) => { direct.push(item); return { ok: true, result: { message_id: direct.length } }; },
  });
  const issue = [{ key: 'job:media-archive:silent', job: 'media-archive', text: '조용함' }];
  let current = Date.parse('2026-10-11T14:30:00.000Z');
  await processHealthIssues(issue, { stateFile, queueFile, send, now: current });
  current = Date.parse('2026-10-11T22:00:00.000Z');
  await processHealthIssues(issue, { stateFile, queueFile, send, now: current });
  assert.equal(direct.length, 0);
  const digest = [];
  await drainDeferredWarnings({ queueFile, now: current,
    send: async (message) => { digest.push(message); return { ok: true, result: { message_id: 1 } }; } });
  assert.equal(direct.length, 0);
  assert.equal(digest.length, 1);
});

test('밤사이 복구된 이슈는 07시 요약에 복구됨으로 한 번만 표시한다', async (t) => {
  const dir = makeTmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'watcher.json');
  const queueFile = join(dir, 'deferred.json');
  const journalRoot = join(dir, 'journal');
  const direct = [];
  let current = Date.parse('2026-10-11T14:30:00.000Z');
  const send = (message, details) => sendDirectWarning({
    message, ...details, journalRoot, queueFile, jobName: 'health-watcher',
    warningCode: details.warningCode ?? 'JOB_HEALTH_ISSUES', kind: 'operational', severity: 'high',
    clock: () => current,
    send: async (item) => { direct.push(item); return { ok: true, result: { message_id: direct.length } }; },
  });
  const issue = [{ key: 'job:media-archive:silent', job: 'media-archive', text: '조용함' }];
  await processHealthIssues(issue, { stateFile, queueFile, send, now: current });
  current = Date.parse('2026-10-11T16:00:00.000Z');
  await processHealthIssues([], { stateFile, queueFile, send, now: current });
  current = Date.parse('2026-10-11T22:00:00.000Z');
  const digest = [];
  await drainDeferredWarnings({ queueFile, now: current,
    send: async (message) => { digest.push(message); return { ok: true, result: { message_id: 1 } }; } });
  assert.equal(direct.length, 0);
  assert.equal(digest.length, 1);
  assert.match(digest[0].facts[1], /복구됨/);
});

const __dirname = dirname(fileURLToPath(import.meta.url));

// run.sh의 case문에서 실제로 디스패치되는 잡 이름만 뽑는다(usage 안내줄의 '*'는 제외).
// 예: "  backup-vault)   CMD=(scripts/jobs/backup-vault-snapshot.mjs) ;;" → "backup-vault"
function listDispatchedJobs() {
  const runSh = readFileSync(join(__dirname, '..', 'launchd', 'run.sh'), 'utf8');
  return [...runSh.matchAll(/^\s*([a-z][a-z0-9-]*)\)\s+CMD=/gm)].map((m) => m[1]);
}

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'health-watcher-test-'));
}

test('findStaleJobs: 존재하지 않는 디렉토리는 빈 배열(잡이 하나도 안 돈 초기 상태)', () => {
  assert.deepEqual(findStaleJobs('/no/such/dir'), []);
});

test('findStaleJobs: 최근에 돈 잡은 stale 목록에 없다', () => {
  const dir = makeTmpDir();
  const now = new Date('2026-08-05T10:00:00.000Z');
  const { content } = buildJobHealthRecord({ job: 'ok-job', status: 'OK', now: new Date('2026-08-05T09:50:00.000Z') });
  writeFileSync(join(dir, 'ok-job.md'), content);
  const stale = findStaleJobs(dir, { now, expectedIntervals: { 'ok-job': 60 * 60 * 1000 } });
  assert.deepEqual(stale, []);
  rmSync(dir, { recursive: true, force: true });
});

test('findStaleJobs: 기대주기의 2배 이상 조용한 잡은 stale 목록에 잡힌다', () => {
  const dir = makeTmpDir();
  const now = new Date('2026-08-05T12:01:00.000Z');
  const { content } = buildJobHealthRecord({ job: 'quiet-job', status: 'OK', now: new Date('2026-08-05T09:00:00.000Z') }); // 3시간 1분 전
  writeFileSync(join(dir, 'quiet-job.md'), content);
  const stale = findStaleJobs(dir, { now, expectedIntervals: { 'quiet-job': 60 * 60 * 1000 } }); // 기대 1시간
  assert.equal(stale.length, 1);
  assert.equal(stale[0].job, 'quiet-job');
});

test('findStaleJobs: 여러 잡 중 일부만 stale이면 그것만 반환', () => {
  const dir = makeTmpDir();
  const now = new Date('2026-08-05T12:00:00.000Z');
  writeFileSync(join(dir, 'fresh.md'), buildJobHealthRecord({ job: 'fresh', status: 'OK', now: new Date('2026-08-05T11:55:00.000Z') }).content);
  writeFileSync(join(dir, 'stale.md'), buildJobHealthRecord({ job: 'stale', status: 'OK', now: new Date('2026-08-05T08:00:00.000Z') }).content);
  const stale = findStaleJobs(dir, { now, expectedIntervals: { fresh: 60 * 60 * 1000, stale: 60 * 60 * 1000 } });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].job, 'stale');
  rmSync(dir, { recursive: true, force: true });
});

test('findStaleJobs: 설정 안 된 잡은 기본 기대주기(defaultIntervalMs)를 쓴다', () => {
  const dir = makeTmpDir();
  const now = new Date('2026-08-05T12:01:00.000Z');
  writeFileSync(join(dir, 'unlisted.md'), buildJobHealthRecord({ job: 'unlisted', status: 'OK', now: new Date('2026-08-05T09:00:00.000Z') }).content);
  const stale = findStaleJobs(dir, { now, expectedIntervals: {}, defaultIntervalMs: 60 * 60 * 1000 });
  assert.equal(stale.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('findStaleJobs: .md 아닌 파일(예: 락파일 잔재)은 무시', () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, 'something.lock'), 'x');
  assert.deepEqual(findStaleJobs(dir, { expectedIntervals: {} }), []);
  rmSync(dir, { recursive: true, force: true });
});

// ── backup-vault 실제 설정값 회귀 테스트(2026-08-14, 오너 신고로 발견) ───────
// expectedIntervals를 안 넘겨서 모듈의 실제 EXPECTED_INTERVALS_MS(기본 파라미터)가
// 쓰이게 한다 — "설정에 backup-vault가 빠져 기본 1시간이 적용되던" 버그가 재발하면
// 이 테스트가 바로 잡는다.
test('[막아야 함] findStaleJobs: backup-vault는 하루 1회 잡이라 20시간 조용해도 stale 아님', () => {
  const dir = makeTmpDir();
  const now = new Date('2026-08-14T10:00:00.000Z');
  writeFileSync(join(dir, 'backup-vault.md'), buildJobHealthRecord({ job: 'backup-vault', status: 'OK', now: new Date('2026-08-13T14:50:00.000Z') }).content); // 19시간 10분 전(밤 23:50 KST 실행 다음날 낮)
  const stale = findStaleJobs(dir, { now });
  assert.deepEqual(stale, []);
  rmSync(dir, { recursive: true, force: true });
});

test('findStaleJobs: backup-vault가 이틀 넘게(48시간+) 조용하면 진짜 stale', () => {
  const dir = makeTmpDir();
  const now = new Date('2026-08-16T00:00:00.000Z');
  writeFileSync(join(dir, 'backup-vault.md'), buildJobHealthRecord({ job: 'backup-vault', status: 'OK', now: new Date('2026-08-13T14:50:00.000Z') }).content); // 57시간 전
  const stale = findStaleJobs(dir, { now });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].job, 'backup-vault');
  rmSync(dir, { recursive: true, force: true });
});

// ── update-monthly-balance-snapshot·weekly-report 실제 설정값 회귀 테스트
// (2026-08-23, 오너 신고 — 리포트는 실제로 발행됐는데 "조용하다" 오알람). backup-vault
// 때와 같은 클래스: 두 잡을 EXPECTED_INTERVALS_MS에 등록 안 해 기본 1시간이 적용되던
// 버그. expectedIntervals를 안 넘겨 모듈의 실제 기본 파라미터가 쓰이게 한다.
test('[막아야 함] findStaleJobs: update-monthly-balance-snapshot은 매일 23:50 1회 잡이라 20시간 조용해도 stale 아님', () => {
  const dir = makeTmpDir();
  const now = new Date('2026-08-23T19:00:00.000Z'); // 다음날 낮(KST 04:00)
  writeFileSync(join(dir, 'update-monthly-balance-snapshot.md'), buildJobHealthRecord({ job: 'update-monthly-balance-snapshot', status: 'OK', now: new Date('2026-08-22T14:50:06.052Z') }).content);
  const stale = findStaleJobs(dir, { now });
  assert.deepEqual(stale, []);
  rmSync(dir, { recursive: true, force: true });
});

test('[막아야 함] findStaleJobs: weekly-report는 매주 1회 잡이라 며칠 조용해도 stale 아님', () => {
  const dir = makeTmpDir();
  const now = new Date('2026-08-26T00:00:00.000Z'); // 발행 3일 후
  writeFileSync(join(dir, 'weekly-report.md'), buildJobHealthRecord({ job: 'weekly-report', status: 'OK', now: new Date('2026-08-22T18:05:47.649Z') }).content);
  const stale = findStaleJobs(dir, { now });
  assert.deepEqual(stale, []);
  rmSync(dir, { recursive: true, force: true });
});

// ── isPollingStuck (좀비 세션 감지, task #34) ─────────────────────
test('[막아야 함] isPollingStuck: 미수신 업데이트가 큐에 남아있으면 좀비로 판정', () => {
  assert.equal(isPollingStuck({ pendingUpdateCount: 3 }), true);
});

test('isPollingStuck: 큐가 비어있으면(정상 폴링 중) 좀비 아님', () => {
  assert.equal(isPollingStuck({ pendingUpdateCount: 0 }), false);
});

test('isPollingStuck: 값이 없거나 숫자가 아니면(조회 자체가 이상) 추정하지 않고 false', () => {
  assert.equal(isPollingStuck({ pendingUpdateCount: undefined }), false);
  assert.equal(isPollingStuck({ pendingUpdateCount: null }), false);
  assert.equal(isPollingStuck({ pendingUpdateCount: NaN }), false);
});

// ── 평일 전용 잡의 주말 간격 회귀 테스트(2026-08-23, 오너 지시로 전수 재점검 중 발견)
// — 24h로만 등록돼 있으면 금요일 실행→월요일 실행 사이(사흘) 중 토요일 낮부터 매주
// "조용하다"고 오판했을 것. 실측: 2026-08-23(일요일) 낮 시점 daily-asset-allocation-
// check가 이미 41시간 경과, 48h 문턱을 몇 시간 안에 넘길 뻔했다.
test('[막아야 함] findStaleJobs: 평일전용 잡(daily-asset-allocation-check)은 금→일 41시간 조용해도 stale 아님(주말 간격)', () => {
  const dir = makeTmpDir();
  const now = new Date('2026-08-23T00:33:00.000Z'); // 실사고 재현: 금요일 실행 후 약 41시간
  writeFileSync(join(dir, 'daily-asset-allocation-check.md'), buildJobHealthRecord({ job: 'daily-asset-allocation-check', status: 'OK', now: new Date('2026-08-21T07:30:13.425Z') }).content);
  const stale = findStaleJobs(dir, { now });
  assert.deepEqual(stale, []);
  rmSync(dir, { recursive: true, force: true });
});

test('findStaleJobs: 평일전용 잡도 진짜 며칠(96시간+) 조용하면 stale', () => {
  const dir = makeTmpDir();
  const now = new Date('2026-08-25T08:00:00.000Z'); // 금요일 실행 후 약 97시간(화요일까지 이어진 진짜 장애)
  writeFileSync(join(dir, 'reconcile-irp.md'), buildJobHealthRecord({ job: 'reconcile-irp', status: 'OK', now: new Date('2026-08-21T07:07:09.410Z') }).content);
  const stale = findStaleJobs(dir, { now });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].job, 'reconcile-irp');
  rmSync(dir, { recursive: true, force: true });
});

// ── 30분·5분 주기 잡 등록 회귀 테스트(2026-08-23, 같은 전수 재점검) — 등록 전엔
// 기본값(60분)이 적용돼 진짜 장애도 최대 2시간까지 못 잡았다(false negative 쪽 갭).
test('[막아야 함] findStaleJobs: sync-firestore-mirror(2026-08-25부터 10분 주기)는 25분만 조용해도 stale — 예전 30분 주기(×2=60분)였다면 못 잡았을 것', () => {
  const dir = makeTmpDir();
  const now = new Date('2026-08-23T01:25:00.000Z'); // 25분 전 실행
  writeFileSync(join(dir, 'sync-firestore-mirror.md'), buildJobHealthRecord({ job: 'sync-firestore-mirror', status: 'OK', now: new Date('2026-08-23T01:00:00.000Z') }).content);
  const stale = findStaleJobs(dir, { now });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].job, 'sync-firestore-mirror');
  rmSync(dir, { recursive: true, force: true });
});

test('[막아야 함] findStaleJobs: execute-quant(5분 주기)는 12분만 조용해도 stale', () => {
  const dir = makeTmpDir();
  const now = new Date('2026-08-23T01:12:00.000Z');
  writeFileSync(join(dir, 'execute-quant.md'), buildJobHealthRecord({ job: 'execute-quant', status: 'OK', now: new Date('2026-08-23T01:00:00.000Z') }).content);
  const stale = findStaleJobs(dir, { now });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].job, 'execute-quant');
  rmSync(dir, { recursive: true, force: true });
});

// ── formatStaleJobIssue (2026-08-23, 오너 지시 — 조치사항 등록) ──────────
test('formatStaleJobIssue: 조치사항이 등록된 잡은 알림에 확인할 것이 같이 붙는다', () => {
  const line = formatStaleJobIssue({ job: 'backup-vault', lastRun: '2026-08-22T14:50:06.552Z', expectedIntervalMs: 24 * 60 * 60 * 1000 });
  assert.match(line, /조용합니다/);
  assert.match(line, /확인: Vault 경로/);
});

test('formatStaleJobIssue: 조치사항이 없는 잡은 기존과 동일하게 조치 줄이 안 붙는다', () => {
  const line = formatStaleJobIssue({ job: 'weekly-report', lastRun: '2026-08-22T18:05:47.649Z', expectedIntervalMs: 7 * 24 * 60 * 60 * 1000 });
  assert.match(line, /조용합니다/);
  assert.doesNotMatch(line, /확인:/);
});

test('formatStaleJobIssue: 실행 기록 자체가 없으면 "실행 기록 없음"으로 정직하게 표시', () => {
  const line = formatStaleJobIssue({ job: 'execute-quant', lastRun: null, expectedIntervalMs: 5 * 60 * 1000 });
  assert.match(line, /실행 기록 없음/);
});

// ── EXPECTED_INTERVALS_MS 누락 방지 구조적 가드(2026-08-24) ──────────────
// "새 v2 잡이 생길 때마다 여기 추가한다"는 이 파일 안의 프로즈 주석이 2026-08-14부터
// 있었는데도 그 뒤로 다섯 번(backup-vault·daily-asset-allocation-check·update-monthly-
// balance-snapshot·weekly-report·이번 6개)이나 같은 누락이 반복됐다 — 기본값(60분)이
// 하루 1회~분기 1회 잡에 조용히 적용돼 몇 시간~며칠 뒤 오알람이 나가는 패턴. 프로즈
// 규칙은 안 지켜진다는 게 다섯 번으로 증명됐으니, run.sh가 실제로 디스패치하는 잡은
// 전부 EXPECTED_INTERVALS_MS에 등록돼 있어야 한다는 걸 테스트로 강제한다 — 새 잡을
// run.sh case문에 추가하고 이 등록을 빠뜨리면 npm test가 그 자리에서 실패한다.
test('EXPECTED_INTERVALS_MS: run.sh가 디스패치하는 잡은 전부 등록돼 있어야 함(기본값 60분 오알람 재발 방지)', () => {
  const dispatched = listDispatchedJobs();
  assert.ok(dispatched.length > 10, 'run.sh case문 파싱이 깨졌을 가능성 — 잡 이름이 거의 안 뽑힘');
  const missing = dispatched.filter((job) => !(job in EXPECTED_INTERVALS_MS));
  assert.deepEqual(missing, [], `EXPECTED_INTERVALS_MS에 등록 안 된 잡: ${missing.join(', ')} — health-watcher.mjs에 실제 launchd 주기에 맞는 값을 추가할 것(기본값 60분을 그대로 두면 몇 시간 안에 오알람 발생)`);
});

test('미디어 잡은 매일 실행하고 화자 분리는 전사 잠금으로 건너뛴 회차를 감안한다', () => {
  assert.equal(EXPECTED_INTERVALS_MS['media-transcribe'], 24 * 60 * 60 * 1000);
  assert.equal(EXPECTED_INTERVALS_MS['media-diarize'], 26 * 60 * 60 * 1000);
});

test('media-memory-orb plist·디스패치·감시 주기는 매일 02:20으로 일치한다', () => {
  const plist = readFileSync(new URL('../launchd/com.banana2.media-memory-orb.plist', import.meta.url), 'utf8');
  const runSh = readFileSync(new URL('../launchd/run.sh', import.meta.url), 'utf8');
  assert.match(plist, /<string>com\.banana2\.media-memory-orb<\/string>/);
  assert.match(plist, /<key>Hour<\/key><integer>2<\/integer><key>Minute<\/key><integer>20<\/integer>/);
  assert.match(plist, /<string>media-memory-orb<\/string>/);
  assert.match(runSh, /media-memory-orb\) CMD=\(scripts\/jobs\/media-memory-orb\.mjs\)/);
  assert.equal(EXPECTED_INTERVALS_MS['media-memory-orb'], 24 * 60 * 60 * 1000);
});
