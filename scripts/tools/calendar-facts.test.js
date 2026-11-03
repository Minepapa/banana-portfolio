import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarFacts, describeCalendarDay } from './calendar-facts.mjs';
import { factsFor } from '../lib/facts-catalog.mjs';

test('헤르메스 호출 때 일정 사실이 항상 붙는다(자기 선언)', () => {
  assert.ok(factsFor('hermes').always.some((e) => e.filename === 'calendar-facts.mjs'));
});

test('describeCalendarDay: 파일 없음·일정 없음·시각·종일·사람·장소', () => {
  assert.match(describeCalendarDay('2026-11-04', null)[0], /아직 조회 전/);
  assert.deepEqual(describeCalendarDay('2026-11-04', { events: [] }), ['2026-11-04: 일정 없음']);
  const lines = describeCalendarDay('2026-11-04', { events: [
    { allDay: true, title: '휴가', person: '가족' },
    { allDay: false, start: '2026-11-04T20:00:00+09:00', end: '2026-11-04T21:30:00+09:00', title: '저녁', location: '집' },
  ] });
  assert.deepEqual(lines, ['2026-11-04: 2건', '- 종일 [가족] 휴가', '- 20:00~21:30 저녁 @집']);
});

test('calendarFacts: KST 기준 오늘·내일(자정 경계)', () => {
  const asked = [];
  const out = calendarFacts({ now: new Date('2026-11-03T15:30:00Z'), read: (d) => { asked.push(d); return { events: [] }; } });
  assert.deepEqual(asked, ['2026-11-04', '2026-11-05']);
  assert.match(out, /오늘·내일/);
});
