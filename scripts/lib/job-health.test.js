import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildJobHealthRecord, heartbeatWriteOptions, parseFrontmatter, isStale } from './job-health.mjs';
import { updateFrontmatter } from './vault-frontmatter.mjs';
import { writeIfChanged } from './write-if-changed.mjs';

test('buildJobHealthRecord: OK 상태 — failStreak 0, 알림 없음', () => {
  const r = buildJobHealthRecord({ job: 'parse-notifications-to-vault', status: 'OK', durationSec: 4.2 });
  assert.equal(r.filename, 'parse-notifications-to-vault.md');
  assert.equal(r.failStreak, 0);
  assert.equal(r.shouldAlert, false);
  assert.match(r.content, /job: "parse-notifications-to-vault"/);
  assert.match(r.content, /status: "OK"/);
  assert.match(r.content, /durationSec: 4.2/);
  assert.match(r.content, /related: \["\[\[90_Delphi\/Schema\/무인잡-카탈로그\]\]"\]/);
});

test('buildJobHealthRecord: 이전 기록 없이 첫 실패 — failStreak 1, 아직 알림 없음(1회는 무시)', () => {
  const r = buildJobHealthRecord({ job: 'x', status: 'FAIL', detail: '토큰 만료' });
  assert.equal(r.failStreak, 1);
  assert.equal(r.shouldAlert, false);
});

test('buildJobHealthRecord: 연속 2회째 실패 — 알림 발동', () => {
  const prior = { failStreak: 1 };
  const r = buildJobHealthRecord({ job: 'x', status: 'FAIL', detail: '재시도 소진' }, prior);
  assert.equal(r.failStreak, 2);
  assert.equal(r.shouldAlert, true);
});

test('buildJobHealthRecord: 실패가 이어지다 OK로 회복하면 0으로 리셋', () => {
  const prior = { failStreak: 5 };
  const r = buildJobHealthRecord({ job: 'x', status: 'OK' }, prior);
  assert.equal(r.failStreak, 0);
  assert.equal(r.shouldAlert, false);
});

test('buildJobHealthRecord: detail은 200자로 잘림', () => {
  const r = buildJobHealthRecord({ job: 'x', status: 'FAIL', detail: 'A'.repeat(300) });
  const parsed = parseFrontmatter(r.content);
  assert.equal(parsed.detail.length, 200);
});

test('연속 실패 경보는 2·6·12·24회이며 하루 최대 5건, 회복은 한 번 알린다', () => {
  let prior = null;
  const alerts = [];
  const start = new Date('2026-10-10T00:00:00.000Z');
  for (let count = 1; count <= 200; count++) {
    const now = new Date(start.getTime() + count * 60_000);
    const result = buildJobHealthRecord({ job: 'failing-job', status: 'FAIL', now }, prior);
    if (result.shouldAlert) alerts.push(count);
    prior = parseFrontmatter(result.shouldAlert
      ? updateFrontmatter(result.content, { failureAlertSent: true }) : result.content);
  }
  assert.deepEqual(alerts, [2, 6, 12, 24, 48]);
  const recovery = buildJobHealthRecord({ job: 'failing-job', status: 'OK',
    now: new Date(start.getTime() + 201 * 60_000) }, prior);
  assert.equal(recovery.shouldRecover, true);
  assert.equal(recovery.recoveredStreak, 200);
  assert.equal(recovery.failureDurationSec, 200 * 60);
  assert.equal(buildJobHealthRecord({ job: 'failing-job', status: 'OK' },
    parseFrontmatter(recovery.content)).shouldRecover, false);
});

test('parseFrontmatter: buildJobHealthRecord 출력을 그대로 되읽으면 원래 필드가 복원된다(왕복)', () => {
  const now = new Date('2026-08-05T09:00:00.000Z');
  const { content } = buildJobHealthRecord({ job: 'health-watcher', status: 'OK', durationSec: 1.5, now });
  const parsed = parseFrontmatter(content);
  assert.equal(parsed.job, 'health-watcher');
  assert.equal(parsed.status, 'OK');
  assert.equal(parsed.lastRun, '2026-08-05T09:00:00.000Z');
  assert.equal(parsed.durationSec, 1.5);
  assert.equal(parsed.failStreak, 0);
});

test('parseFrontmatter: frontmatter 없는 내용이면 빈 객체', () => {
  assert.deepEqual(parseFrontmatter('그냥 텍스트'), {});
});

test('isStale: 기대주기의 2배를 안 넘겼으면 false', () => {
  const now = new Date('2026-08-05T10:00:00.000Z');
  const lastRun = new Date('2026-08-05T09:30:00.000Z').toISOString(); // 30분 전
  assert.equal(isStale({ lastRun, expectedIntervalMs: 60 * 60 * 1000, now }), false); // 기대주기 1시간
});

test('isStale: 기대주기의 2배를 넘기면 true', () => {
  const now = new Date('2026-08-05T12:01:00.000Z');
  const lastRun = new Date('2026-08-05T09:00:00.000Z').toISOString(); // 3시간 1분 전
  assert.equal(isStale({ lastRun, expectedIntervalMs: 60 * 60 * 1000, now }), true); // 2시간 넘김
});

test('isStale: 정확히 2배 지점은 아직 stale 아님(초과만 stale)', () => {
  const now = new Date('2026-08-05T11:00:00.000Z');
  const lastRun = new Date('2026-08-05T09:00:00.000Z').toISOString(); // 정확히 2시간 전
  assert.equal(isStale({ lastRun, expectedIntervalMs: 60 * 60 * 1000, now }), false);
});

test('isStale: lastRun 기록 자체가 없으면 stale(잡이 한 번도 안 돎)', () => {
  assert.equal(isStale({ lastRun: null, expectedIntervalMs: 60 * 60 * 1000 }), true);
});

test('isStale: 파싱 불가한 lastRun도 안전하게 stale 취급', () => {
  assert.equal(isStale({ lastRun: '이상한값', expectedIntervalMs: 60 * 60 * 1000 }), true);
});

// ── 같은 내용이면 하트비트를 다시 쓰지 않기(2026-11-03, ⑤) ──
const MIN = 60 * 1000;
function heartbeatFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-skip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'sim.md');
}
// run.sh → record-heartbeat-vault와 같은 순서: 앞 파일을 읽어 기록을 만들고, 같은 내용이면 쓰지 않는다.
function beat(file, { at, status = 'OK', detail = '같음', intervals = { sim: 10 * MIN } }) {
  let prior = null;
  try { prior = parseFrontmatter(readFileSync(file, 'utf8')); } catch { /* 첫 실행 */ }
  const now = new Date(at);
  const record = buildJobHealthRecord({ job: 'sim', status, detail, durationSec: 1, now }, prior);
  return writeIfChanged(file, record.content,
    heartbeatWriteOptions({ job: 'sim', now, intervals, force: record.shouldAlert || record.shouldRecover }));
}
const T = Date.parse('2026-11-03T03:00:00Z'); // 12:00 KST

test('heartbeatWriteOptions: 기대 주기의 절반 안에 다시 돌면 lastRun만 다른 하트비트는 쓰지 않는다', (t) => {
  const file = heartbeatFile(t);
  assert.equal(beat(file, { at: T }), true);
  assert.equal(beat(file, { at: T + 4 * MIN }), false, '4분 < 10분/2');
  assert.equal(parseFrontmatter(readFileSync(file, 'utf8')).lastRun, new Date(T).toISOString());
  assert.equal(beat(file, { at: T + 5 * MIN }), true, '마지막으로 쓴 지 E/2면 다시 쓴다');
});

test('heartbeatWriteOptions: 기대 주기대로 도는 잡(간격 = E)은 한 번도 건너뛰지 않는다', (t) => {
  const file = heartbeatFile(t);
  for (let i = 0; i < 20; i += 1) assert.equal(beat(file, { at: T + i * 10 * MIN }), true);
});

test('heartbeatWriteOptions: 상태·연속 실패·detail·날짜가 바뀌면 E/2 안이어도 바로 쓴다', (t) => {
  const file = heartbeatFile(t);
  beat(file, { at: T });
  assert.equal(beat(file, { at: T + 1 * MIN, status: 'FAIL' }), true, 'OK → FAIL');
  assert.equal(beat(file, { at: T + 2 * MIN, status: 'FAIL' }), true, '연속 실패 1 → 2(알림 실행)');
  assert.equal(beat(file, { at: T + 3 * MIN, status: 'FAIL' }), true, '연속 실패 2 → 3');
  assert.equal(beat(file, { at: T + 4 * MIN }), true, 'FAIL → OK(복구)');
  assert.equal(beat(file, { at: T + 4.5 * MIN }), false);
  assert.equal(beat(file, { at: T + 4.6 * MIN, detail: '달라짐' }), true, 'detail이 바뀌면');
  const beforeMidnight = Date.parse('2026-11-03T14:58:00Z');
  beat(file, { at: beforeMidnight, detail: '날짜' });
  assert.equal(beat(file, { at: beforeMidnight + 3 * MIN, detail: '날짜' }), true, 'KST 날짜(alertDate)가 바뀌면');
});

test('heartbeatWriteOptions: 기대 주기가 없거나(null) 알림을 보내는 실행이면 늘 쓴다', () => {
  assert.equal(heartbeatWriteOptions({ job: 'off', intervals: { off: null } }).refreshMs, 0);
  assert.equal(heartbeatWriteOptions({ job: 'sim', intervals: { sim: 10 * MIN }, force: true }).refreshMs, 0);
  assert.equal(heartbeatWriteOptions({ job: 'unknown', intervals: {}, defaultIntervalMs: 60 * MIN }).refreshMs, 30 * MIN);
});
