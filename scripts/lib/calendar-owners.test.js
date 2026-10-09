import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupEventsByOwner, parseCalendarOwners } from './calendar-owners.mjs';

const table = '| 캘린더 ID | 소유자 | 위키 |\n| --- | --- | --- |\n| a@example.com | 나 | [[나]] |\n| b@example.com | 휘영 | [[휘영]] |\n| c@example.com | 미네 | [[미네]] |';
const owners = parseCalendarOwners(table);

test('소유자 표 파싱과 잘못된 표 거부', () => {
  assert.deepEqual(owners, [
    { calendarId: 'a@example.com', owner: '나' },
    { calendarId: 'b@example.com', owner: '휘영' },
    { calendarId: 'c@example.com', owner: '미네' },
  ]);
  assert.throws(() => parseCalendarOwners('표 없음'), /표 형식 오류/);
  assert.throws(() => parseCalendarOwners(`${table}\n| | 미네 | [[미네]] |`), /빈 행/);
  assert.throws(() => parseCalendarOwners(`${table}\n\n| d@example.com | 나 | [[나]] |`), /빈 행/);
  assert.throws(() => parseCalendarOwners(`${table}\nd@example.com | 나 | [[나]] |`), /형식 오류/);
});

test('중복 UID는 첫 소유자에 모으고 기타는 끝, 빈 그룹은 제외', () => {
  const grouped = groupEventsByOwner([
    { calendarId: 'b@example.com', iCalUID: 'shared', title: '공유' },
    { calendarId: 'x@example.com', iCalUID: 'outside', title: '기타' },
    { calendarId: 'a@example.com', iCalUID: 'shared', title: '공유' },
    { calendarId: 'b@example.com', title: '개별1' },
    { calendarId: 'b@example.com', title: '개별2' },
  ], owners);
  assert.deepEqual(grouped.map(({ owner }) => owner), ['나', '휘영', '기타']);
  assert.deepEqual(grouped[0].events[0].sharedWith, ['휘영']);
  assert.equal(grouped[0].events[0].owner, '나');
  assert.equal(grouped[1].events.length, 2);
  assert.equal(grouped[2].events[0].title, '기타');
});

test('한 소유자의 여러 캘린더는 표 순서보다 원래 시간순으로 표시한다', () => {
  const sameOwner = [
    { calendarId: 'a@example.com', owner: '나' },
    { calendarId: 'b@example.com', owner: '나' },
    { calendarId: 'c@example.com', owner: '휘영' },
  ];
  const grouped = groupEventsByOwner([
    { calendarId: 'b@example.com', iCalUID: 'early', title: '09:00' },
    { calendarId: 'c@example.com', iCalUID: 'shared', title: '공유 사본' },
    { calendarId: 'a@example.com', iCalUID: 'late', title: '15:00' },
    { calendarId: 'a@example.com', iCalUID: 'shared', title: '공유 원본' },
  ], sameOwner);
  assert.deepEqual(grouped.map(({ owner }) => owner), ['나']);
  assert.deepEqual(grouped[0].events.map(({ title }) => title), ['09:00', '15:00', '공유 원본']);
  assert.deepEqual(grouped[0].events[2].sharedWith, ['휘영']);
});

test('반복 일정: 같은 iCalUID라도 시작 시각이 다르면 각각 남고, 같은 회차는 공유로 묶인다', () => {
  const grouped = groupEventsByOwner([
    { calendarId: 'a@example.com', iCalUID: 'rep', start: '2026-10-13T09:00:00+09:00', title: '복약' },
    { calendarId: 'a@example.com', iCalUID: 'rep', start: '2026-10-13T21:00:00+09:00', title: '복약' },
    { calendarId: 'b@example.com', iCalUID: 'rep', start: '2026-10-13T21:00:00+09:00', title: '복약' },
  ], owners);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].events.length, 2);
  assert.deepEqual(grouped[0].events[1].sharedWith, ['휘영']);
});
