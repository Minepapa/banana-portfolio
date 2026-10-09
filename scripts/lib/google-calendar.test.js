import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSelectedCalendars, listEventsForKstDay, normalizeEvent, formatEventLine } from './google-calendar.mjs';

test('selected calendar와 일정 페이지 처리, 취소 제외, 종일 우선, KST 범위', async () => {
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push(new URL(url));
    assert.equal(options.headers.Authorization, 'Bearer test');
    assert.ok(options.signal instanceof AbortSignal);
    const path = new URL(url).pathname;
    const page = new URL(url).searchParams.get('pageToken');
    let data;
    if (path.endsWith('/calendarList')) data = page ? { items: [{ id: 'B', summary: '가족', selected: true }] } : { items: [{ id: 'A', summary: '개인', selected: true, primary: true }, { id: 'X', selected: false }], nextPageToken: 'next' };
    else if (path.endsWith('/A/events')) data = page ? { items: [{ summary: '취소', status: 'cancelled', start: { dateTime: '2026-10-10T09:00:00+09:00' } }] } : { items: [{ summary: '치과', location: '서울치과', start: { dateTime: '2026-10-10T10:00:00+09:00' }, end: { dateTime: '2026-10-10T11:00:00+09:00' } }], nextPageToken: 'next' };
    else data = { items: [{ summary: '생일', start: { date: '2026-10-10' }, end: { date: '2026-10-11' } }] };
    return { ok: true, json: async () => data };
  };
  const calendars = await listSelectedCalendars({ token: 'test', fetchImpl: fakeFetch });
  assert.deepEqual(calendars, [{ id: 'A', summary: '개인', primary: true }, { id: 'B', summary: '가족', primary: false }]);
  const events = await listEventsForKstDay('2026-10-10', { token: 'test', fetchImpl: fakeFetch, calendars });
  assert.equal(events.length, 2);
  assert.equal(events[0].allDay, true);
  assert.equal(formatEventLine(events[0]), '- 종일 생일 · 가족');
  assert.equal(formatEventLine(events[1]), '- 10:00–11:00 치과 (서울치과) · 개인');
  assert.equal(requests.find((url) => url.pathname.endsWith('/A/events')).searchParams.get('timeMax'), '2026-10-11T00:00:00+09:00');
  assert.equal(formatEventLine(normalizeEvent({ start: { date: '2026-10-10' } }, '개인')), '- 종일 (제목 없음) · 개인');
});

test('잘못된 items, 반복 pageToken, 50페이지 초과는 오류로 드러난다', async () => {
  for (const items of [null, {}, 'wrong']) {
    await assert.rejects(() => listSelectedCalendars({ token: 'test', fetchImpl: async () => ({ ok: true, json: async () => ({ items }) }) }), /items가 배열이 아님/);
    await assert.rejects(() => listEventsForKstDay('2026-10-10', { token: 'test', calendars: [{ id: 'A', summary: '개인' }], fetchImpl: async () => ({ ok: true, json: async () => ({ items }) }) }), /items가 배열이 아님/);
  }
  await assert.rejects(() => listSelectedCalendars({ token: 'test', fetchImpl: async () => ({ ok: true, json: async () => ({ items: [], nextPageToken: 'same' }) }) }), /pageToken 반복/);
  let pages = 0;
  await assert.rejects(() => listSelectedCalendars({ token: 'test', fetchImpl: async () => ({ ok: true, json: async () => ({ items: [], nextPageToken: String(++pages) }) }) }), /50개 초과/);
  assert.equal(pages, 50);
});

test('날짜 유효성 및 자정 넘는 일정의 종료 날짜 표시', async () => {
  await assert.rejects(() => listEventsForKstDay('2026-02-30', { token: 'test', calendars: [] }), /날짜 형식 오류/);
  assert.equal(formatEventLine({ allDay: false, start: '2026-10-10T23:00:00+09:00', end: '2026-10-11T01:00:00+09:00', title: '야간', calendar: '개인' }), '- 23:00–(다음날) 01:00 야간 · 개인');
});

test('다른 UTC offset으로 표현된 일정도 실제 시작 시각 순서로 정렬', async () => {
  const calendars = [{ id: 'A', summary: '개인' }];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ items: [
    { summary: '나중', start: { dateTime: '2026-10-10T09:00:00+09:00' }, end: { dateTime: '2026-10-10T10:00:00+09:00' } },
    { summary: '먼저', start: { dateTime: '2026-10-09T23:30:00Z' }, end: { dateTime: '2026-10-10T00:30:00Z' } },
  ] }) });
  const events = await listEventsForKstDay('2026-10-10', { token: 'test', fetchImpl, calendars });
  assert.deepEqual(events.map((event) => event.title), ['먼저', '나중']);
});

test('정규화한 캘린더 ID와 UID, 공유 일정 표시', () => {
  const event = normalizeEvent({ iCalUID: 'uid', summary: '가족 모임', start: { date: '2026-10-10' } }, '가족', 'a@example.com');
  assert.equal(event.calendarId, 'a@example.com');
  assert.equal(event.iCalUID, 'uid');
  assert.equal(formatEventLine({ ...event, sharedWith: ['휘영'] }, { owner: '나', showCalendar: false }), '- 종일 가족 모임 (나·휘영 함께)');
  assert.equal(formatEventLine({ ...event, owner: '나', sharedWith: ['휘영'] }, { showCalendar: false }), '- 종일 가족 모임 (나·휘영 함께)');
});
