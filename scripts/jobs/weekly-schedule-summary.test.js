import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklyScheduleText, SCHEDULE } from './weekly-schedule-summary.mjs';

test('SCHEDULE: 4건(주기적 보고 4개) — 이벤트기반은 포함되지 않는다', () => {
  assert.equal(SCHEDULE.length, 4);
});

test('buildWeeklyScheduleText: 제목과 4건 부서·시각이 전부 본문에 포함된다', () => {
  const text = buildWeeklyScheduleText();
  assert.match(text, /<b>주간 보고 스케쥴<\/b>/);
  assert.match(text, /평일 08:00 \[운영실 Hermes\]/);
  assert.match(text, /평일 16:30 \[투자전략실 Athena\]/);
  assert.match(text, /일요일 07:00 \[리스크관리실 Themis\]/);
  assert.match(text, /일요일 08:00 \[비서실 Apollo\]/);
});

test('buildWeeklyScheduleText: 커스텀 schedule 배열을 받으면 그것만 반영(순수함수)', () => {
  const text = buildWeeklyScheduleText([{ day: '화요일', time: '09:00', dept: '테스트부서', what: '테스트 보고' }]);
  assert.match(text, /화요일 09:00 \[테스트부서\] 테스트 보고/);
  assert.doesNotMatch(text, /운영실 Hermes/);
});
