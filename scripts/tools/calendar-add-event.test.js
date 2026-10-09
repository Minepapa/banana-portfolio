import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvent, main } from './calendar-add-event.mjs';
import { deleteOwnEvent, insertEvent, pantheonEventBody } from '../lib/google-calendar.mjs';

test('캘린더 입력: 실재 날짜, 시간, 종료 순서와 종일 종료일', () => {
  const { event } = buildEvent(['--title=회의', '--start=2026-10-13T15:00']);
  assert.equal(event.end.dateTime, '2026-10-13T16:00:00+09:00');
  assert.equal(buildEvent(['--title=휴가', '--date=2026-10-13']).event.end.date, '2026-10-14');
  for (const args of [['--title=x', '--date=2026-02-30'], ['--title=x', '--start=2026-10-13T25:00'], ['--title=x', '--start=2026-10-13T15:00', '--end=2026-10-13T14:00'], [`--title=${'x'.repeat(201)}`, '--date=2026-10-13']]) assert.throws(() => buildEvent(args));
});

test('표준입력 JSON과 CLI 인자는 같은 검증과 등록 본문을 쓴다', async () => {
  const json = JSON.stringify({ title: '회의', start: '2026-10-13T15:00', end: '2026-10-13T16:00', location: '사무실', description: '안건' });
  const fromJson = buildEvent(['--json=-'], json).event;
  const fromArgs = buildEvent(['--title=회의', '--start=2026-10-13T15:00', '--end=2026-10-13T16:00', '--location=사무실', '--description=안건']).event;
  assert.deepEqual(fromJson, fromArgs);
  let created;
  await main(['--json=-'], { readStdin: async () => json, getToken: async ({ requiredScopes }) => {
    assert.deepEqual(requiredScopes, ['https://www.googleapis.com/auth/calendar.events']);
    return 'fake';
  }, createEvent: async (event) => { created = pantheonEventBody(event); return { id: 'event' }; } });
  assert.deepEqual(created, pantheonEventBody(fromArgs));
  const lines = [];
  const originalLog = console.log;
  try {
    console.log = (line) => lines.push(line);
    await main(['--json=-', '--dry-run'], { readStdin: async () => json, getToken: async () => { throw new Error('dry-run token request'); } });
  } finally { console.log = originalLog; }
  assert.deepEqual(JSON.parse(lines[0]), created);
  assert.equal(buildEvent(['--json=-'], JSON.stringify({ title: '휴가', date: '2026-10-13', endDate: '2026-10-14' })).event.end.date, '2026-10-15');
});

test('날짜 순서, 제목 줄바꿈, 위치·설명 길이, JSON 인자 혼용을 거부한다', () => {
  assert.throws(() => buildEvent(['--title=x', '--start=2026-10-13T15:00', '--end=2026-10-13T14:00']), /종료 시각은 시작 시각보다/);
  assert.throws(() => buildEvent(['--title=x', '--date=2026-10-14', '--end-date=2026-10-13']), /종료 날짜는 시작 날짜와/);
  assert.throws(() => buildEvent(['--title=x', '--date=2026-13-01']), /날짜 오류: 2026-13-01/);
  assert.throws(() => buildEvent(['--json=-'], JSON.stringify({ title: 'x', date: '2026-13-01' })), /날짜 오류: 2026-13-01/);
  for (const value of ['a\nb', 'a\rb']) assert.throws(() => buildEvent(['--json=-'], JSON.stringify({ title: value, date: '2026-10-13' })), /줄바꿈/);
  assert.throws(() => buildEvent(['--title=x', '--date=2026-10-13', `--location=${'x'.repeat(501)}`]), /위치는 500자/);
  assert.throws(() => buildEvent(['--json=-'], JSON.stringify({ title: 'x', date: '2026-10-13', description: 'x'.repeat(2001) })), /설명은 2000자/);
  assert.throws(() => buildEvent(['--json=-', '--title=x'], JSON.stringify({ date: '2026-10-13' })), /다른 일정 인자/);
  assert.throws(() => buildEvent(['--json=-'], '{'), /JSON 형식 오류/);
});

test('캘린더 등록은 소유 표시를 쓰고 표시 없는 일정은 삭제 거부', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => options.method === 'POST' ? { id: 'event' } : { extendedProperties: { private: { pantheon: '0' } } } };
  };
  await insertEvent({ summary: '회의' }, { token: 'fake', fetchImpl });
  assert.equal(JSON.parse(calls[0].options.body).extendedProperties.private.pantheon, '1');
  await assert.rejects(() => deleteOwnEvent('event', { token: 'fake', fetchImpl }), /판테온이 등록한 일정만/);
  assert.equal(calls.filter((call) => call.options.method === 'DELETE').length, 0);
  await deleteOwnEvent('event', { token: 'fake', fetchImpl: async () => ({ ok: true, json: async () => ({ extendedProperties: { private: { pantheon: '1' } } }) }) });
});
