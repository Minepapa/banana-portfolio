import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunToday } from './daily-breakout-signal-scan.mjs';

// KST 기준 날짜 확인: 2026-09-14는 월요일, 2026-09-12는 토요일, 2026-09-13은 일요일.
// UTC 06:32는 KST 15:32(같은 달력일, 자정 넘김 없음)로 이 시각을 기준으로 삼는다.
const MONDAY_1532_KST = new Date('2026-09-14T06:32:00Z');
const SATURDAY_1532_KST = new Date('2026-09-12T06:32:00Z');
const SUNDAY_1532_KST = new Date('2026-09-13T06:32:00Z');

// [핵심 안전장치] 코드리뷰 HIGH 지적(2026-09-13) 재발방지 — 하루 여러 번 실행돼도
// 이미 오늘 돌았으면 다시 신호스캔+발주를 안 해야 이중매수를 막는다.
test('shouldRunToday: 평일이고 아직 오늘 실행 기록이 없으면(lastRunDayLabel=null) true', () => {
  assert.equal(shouldRunToday(MONDAY_1532_KST, null), true);
});

test('shouldRunToday: 평일이지만 이미 오늘 실행됐으면(lastRunDayLabel=오늘) false — 재실행 방지', () => {
  assert.equal(shouldRunToday(MONDAY_1532_KST, '2026-09-14'), false);
});

test('shouldRunToday: 평일이고 마지막 실행 기록이 어제면 true', () => {
  assert.equal(shouldRunToday(MONDAY_1532_KST, '2026-09-11'), true);
});

test('shouldRunToday: 토요일이면 실행 기록과 무관하게 항상 false', () => {
  assert.equal(shouldRunToday(SATURDAY_1532_KST, null), false);
});

test('shouldRunToday: 일요일이면 실행 기록과 무관하게 항상 false', () => {
  assert.equal(shouldRunToday(SUNDAY_1532_KST, null), false);
});
