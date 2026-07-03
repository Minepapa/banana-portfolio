import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJobStatus, computeJobHealth } from './jobHealth.js';

const T0 = Date.parse('2026-06-04 12:00');

test('parseJobStatus: A2:F 행을 객체로 (failStreak 포함)', () => {
  const rows = [['drain', '2026-06-04 06:00', 'OK', '', '5', '0']];
  assert.deepEqual(parseJobStatus(rows), [
    { job: 'drain', lastRun: '2026-06-04 06:00', status: 'OK', detail: '', durationSec: '5', failStreak: 0 },
  ]);
});

test('parseJobStatus: 구형 5열 행은 failStreak 0으로 안전 파싱', () => {
  const rows = [['drain', '2026-06-04 06:00', 'FAIL', 'err', '5']];
  assert.equal(parseJobStatus(rows)[0].failStreak, 0);
});

test('computeJobHealth: status FAIL 은 fail 문제 (failStreak 전달)', () => {
  const rows = [{ job: 'risk-d', lastRun: '2026-06-04 07:00', status: 'FAIL', detail: 'limit', failStreak: 3 }];
  assert.deepEqual(computeJobHealth(rows, { 'risk-d': 80 }, T0), [{ job: 'risk-d', problem: 'fail', detail: 'limit', failStreak: 3 }]);
});

test('computeJobHealth: 최근 OK 는 문제 없음', () => {
  const rows = [{ job: 'drain', lastRun: '2026-06-04 09:00', status: 'OK', detail: '' }];
  assert.deepEqual(computeJobHealth(rows, { drain: 6 }, T0), []);
});

test('computeJobHealth: cadence 초과 OK 는 stale', () => {
  const rows = [{ job: 'parse-notifications', lastRun: '2026-06-04 09:00', status: 'OK', detail: '' }];
  // parse cadence 1h, 3h 경과 → stale
  assert.deepEqual(computeJobHealth(rows, { 'parse-notifications': 1 }, T0), [{ job: 'parse-notifications', problem: 'stale', detail: '' }]);
});

test('computeJobHealth: cadence 미정의 잡은 stale 판정 제외', () => {
  const rows = [{ job: 'unknown', lastRun: '2000-01-01 00:00', status: 'OK', detail: '' }];
  assert.deepEqual(computeJobHealth(rows, {}, T0), []);
});

test('computeJobHealth: lastRun 파싱 불가 + cadence 있으면 stale', () => {
  const rows = [{ job: 'drain', lastRun: '', status: 'OK', detail: '' }];
  assert.deepEqual(computeJobHealth(rows, { drain: 6 }, T0), [{ job: 'drain', problem: 'stale', detail: '' }]);
});

test('computeJobHealth: cadence 정의됐는데 시트에 행 없으면 missing(침묵 실패)', () => {
  assert.deepEqual(computeJobHealth([], { drain: 6 }, T0), [{ job: 'drain', problem: 'missing', detail: '' }]);
});

test('computeJobHealth: 일부 잡만 보고하면 나머지 필수 잡은 missing', () => {
  const rows = [{ job: 'drain', lastRun: '2026-06-04 09:00', status: 'OK', detail: '' }];
  assert.deepEqual(computeJobHealth(rows, { drain: 6, 'risk-d': 80 }, T0), [{ job: 'risk-d', problem: 'missing', detail: '' }]);
});
