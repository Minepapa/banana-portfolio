import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJobHealthRecord, parseFrontmatter, isStale } from './job-health.mjs';

test('buildJobHealthRecord: OK 상태 — failStreak 0, 알림 없음', () => {
  const r = buildJobHealthRecord({ job: 'parse-notifications-to-vault', status: 'OK', durationSec: 4.2 });
  assert.equal(r.filename, 'parse-notifications-to-vault.md');
  assert.equal(r.failStreak, 0);
  assert.equal(r.shouldAlert, false);
  assert.match(r.content, /job: "parse-notifications-to-vault"/);
  assert.match(r.content, /status: "OK"/);
  assert.match(r.content, /durationSec: 4.2/);
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
