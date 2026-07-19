import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextReportDday } from './reportSchedule.js';

// 주간리포트는 매주 일요일 03:00 고정 발행(JOB_INTERVALS['weekly-report']). D-day는 오늘부터
// 다음 일요일까지 남은 일수 — now의 요일에서만 계산(발행 이력과 무관한 고정 주기).

test('nextReportDday: 월요일 입력이면 D-6', () => {
  const monday = new Date('2026-07-13T09:00:00+09:00'); // 2026-07-13은 월요일
  const { days } = nextReportDday([], monday);
  assert.equal(days, 6);
});

test('nextReportDday: 토요일 입력이면 D-1', () => {
  const saturday = new Date('2026-07-18T09:00:00+09:00'); // 2026-07-18은 토요일
  const { days } = nextReportDday([], saturday);
  assert.equal(days, 1);
});

test('nextReportDday: 일요일 입력이면 D-0(오늘)', () => {
  const sunday = new Date('2026-07-19T09:00:00+09:00'); // 2026-07-19는 일요일
  const { days } = nextReportDday([], sunday);
  assert.equal(days, 0);
});

test('nextReportDday: weeklyReports 최신 발행일을 lastDate로 반환', () => {
  const reports = [{ date: '2026-07-13' }, { date: '2026-07-06' }]; // 최신순 가정
  const { lastDate } = nextReportDday(reports, new Date('2026-07-15T09:00:00+09:00'));
  assert.equal(lastDate, '2026-07-13');
});

test('nextReportDday: weeklyReports 비어있으면 lastDate null(추정 금지)', () => {
  const { lastDate } = nextReportDday([], new Date('2026-07-15T09:00:00+09:00'));
  assert.equal(lastDate, null);
});

test('nextReportDday: weeklyReports가 null/undefined여도 안전', () => {
  const r1 = nextReportDday(null, new Date('2026-07-15T09:00:00+09:00'));
  assert.equal(r1.lastDate, null);
  const r2 = nextReportDday(undefined, new Date('2026-07-15T09:00:00+09:00'));
  assert.equal(r2.lastDate, null);
});
