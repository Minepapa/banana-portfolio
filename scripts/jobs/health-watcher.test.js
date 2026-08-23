import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildJobHealthRecord } from '../lib/job-health.mjs';
import { findStaleJobs, isPollingStuck, formatStaleJobIssue } from './health-watcher.mjs';

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
test('[막아야 함] findStaleJobs: sync-firestore-mirror(30분 주기)는 70분만 조용해도 stale — 예전 기본값(60분×2=120분)이면 못 잡았을 것', () => {
  const dir = makeTmpDir();
  const now = new Date('2026-08-23T02:10:00.000Z'); // 70분 전 실행
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
