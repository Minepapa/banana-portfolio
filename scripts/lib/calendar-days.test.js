import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCalendarDay, calendarDayPath, kstDate, nextDates, writeCalendarDay } from './calendar-days.mjs';

const owners = [{ calendarId: 'me@x', owner: '나' }, { calendarId: 'wife@x', owner: '휘영' }];
const event = (fields) => ({ calendar: '내 캘린더', calendarId: 'me@x', iCalUID: null, title: '일정',
  start: '2026-10-30T10:00:00+09:00', end: '2026-10-30T11:00:00+09:00', allDay: false, location: null, ...fields });

test('함께 쓰는 일정은 소유자 표 첫 소유자로 묶고 종일 먼저, 시작 시각 순이다', () => {
  const day = buildCalendarDay({ date: '2026-10-30', owners, events: [
    event({ title: '저녁', start: '2026-10-30T19:00:00+09:00', end: '2026-10-30T20:00:00+09:00', iCalUID: 'u1' }),
    event({ title: '저녁', calendarId: 'wife@x', calendar: '휘영', start: '2026-10-30T19:00:00+09:00', end: '2026-10-30T20:00:00+09:00', iCalUID: 'u1' }),
    event({ title: '병원', calendarId: 'wife@x', calendar: '휘영', location: '송도' }),
    event({ title: '휴가', allDay: true, start: '2026-10-30', end: '2026-10-31' }),
  ] });
  assert.equal(day.schemaVersion, 1);
  assert.equal(day.date, '2026-10-30');
  assert.deepEqual(day.events.map((item) => [item.title, item.owner, item.sharedWith]),
    [['휴가', '나', []], ['병원', '휘영', []], ['저녁', '나', ['휘영']]]);
  assert.deepEqual(Object.keys(day.events[1]), ['owner', 'sharedWith', 'title', 'start', 'end', 'allDay', 'location', 'calendar']);
  assert.equal(day.events[1].location, '송도');
});

test('시작이 같으면 소유자 표 순서·끝·제목으로 정해 API 순서와 무관하게 같은 결과다', () => {
  const items = [
    event({ title: '나-나중끝', end: '2026-10-30T12:00:00+09:00' }),
    event({ title: '휘영', calendarId: 'wife@x', calendar: '휘영' }),
    event({ title: '나-B' }),
    event({ title: '나-A' }),
  ];
  const forward = buildCalendarDay({ date: '2026-10-30', owners, events: items });
  const backward = buildCalendarDay({ date: '2026-10-30', owners, events: [...items].reverse() });
  assert.deepEqual(forward.events.map((item) => item.title), ['나-A', '나-B', '나-나중끝', '휘영']);
  assert.deepEqual(backward, forward);
});

test('표에 없는 캘린더는 기타 소유자다', () => {
  const day = buildCalendarDay({ date: '2026-10-30', owners, events: [event({ calendarId: 'holiday@x', calendar: '공휴일' })] });
  assert.equal(day.events[0].owner, '기타');
  assert.equal(day.events[0].calendar, '공휴일');
});

test('같은 내용이면 다시 쓰지 않고, 바뀌면 쓰고, 일정 없는 날도 빈 목록으로 남긴다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'calendar-days-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const empty = buildCalendarDay({ date: '2026-10-30', owners, events: [] });
  const path = calendarDayPath('2026-10-30', root);
  assert.equal(path, join(root, '95_Etna', 'Calendar', '2026', '2026-10-30.json'));
  assert.equal(writeCalendarDay(empty, { root }), path);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { schemaVersion: 1, date: '2026-10-30', events: [] });
  let writes = 0;
  const counting = () => { writes += 1; };
  assert.equal(writeCalendarDay(empty, { root, write: counting }), null);
  assert.equal(writes, 0);
  const changed = buildCalendarDay({ date: '2026-10-30', owners, events: [event({})] });
  assert.equal(writeCalendarDay(changed, { root }), path);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).events[0].title, '일정');
});

test('KST 날짜는 UTC 15:00에 넘어가고 날짜 목록은 달·해를 넘긴다', () => {
  assert.equal(kstDate(new Date('2026-10-30T14:59:00Z')), '2026-10-30');
  assert.equal(kstDate(new Date('2026-10-30T15:00:00Z')), '2026-10-31');
  assert.deepEqual(nextDates('2026-12-30', 3), ['2026-12-30', '2026-12-31', '2027-01-01']);
});
