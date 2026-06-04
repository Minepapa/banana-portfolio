import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJobStatus, computeJobHealth } from './jobHealth.js';

const CADENCE = { 'parse-notifications': 1, drain: 6, 'risk-d': 80, 'risk-b': 200 };
const T0 = Date.parse('2026-06-04 12:00');

test('parseJobStatus: A2:E 행을 객체로', () => {
  const rows = [['drain', '2026-06-04 06:00', 'OK', '', '5']];
  assert.deepEqual(parseJobStatus(rows), [
    { job: 'drain', lastRun: '2026-06-04 06:00', status: 'OK', detail: '', durationSec: '5' },
  ]);
});

test('computeJobHealth: status FAIL 은 fail 문제', () => {
  const rows = [{ job: 'risk-d', lastRun: '2026-06-04 07:00', status: 'FAIL', detail: 'limit' }];
  assert.deepEqual(computeJobHealth(rows, CADENCE, T0), [{ job: 'risk-d', problem: 'fail', detail: 'limit' }]);
});

test('computeJobHealth: 최근 OK 는 문제 없음', () => {
  const rows = [{ job: 'drain', lastRun: '2026-06-04 09:00', status: 'OK', detail: '' }];
  assert.deepEqual(computeJobHealth(rows, CADENCE, T0), []);
});

test('computeJobHealth: cadence 초과 OK 는 stale', () => {
  const rows = [{ job: 'parse-notifications', lastRun: '2026-06-04 09:00', status: 'OK', detail: '' }];
  // parse cadence 1h, 3h 경과 → stale
  assert.deepEqual(computeJobHealth(rows, CADENCE, T0), [{ job: 'parse-notifications', problem: 'stale', detail: '' }]);
});

test('computeJobHealth: cadence 미정의 잡은 stale 판정 제외', () => {
  const rows = [{ job: 'unknown', lastRun: '2000-01-01 00:00', status: 'OK', detail: '' }];
  assert.deepEqual(computeJobHealth(rows, CADENCE, T0), []);
});

test('computeJobHealth: lastRun 파싱 불가 + cadence 있으면 stale', () => {
  const rows = [{ job: 'drain', lastRun: '', status: 'OK', detail: '' }];
  assert.deepEqual(computeJobHealth(rows, CADENCE, T0), [{ job: 'drain', problem: 'stale', detail: '' }]);
});
