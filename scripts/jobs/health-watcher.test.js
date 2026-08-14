import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildJobHealthRecord } from '../lib/job-health.mjs';
import { findStaleJobs, isPollingStuck } from './health-watcher.mjs';

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
