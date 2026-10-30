import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeCalendarFetcher, parseArgs, runCalendarDays } from './calendar-days.mjs';
import { EXPECTED_INTERVALS_MS } from './health-watcher.mjs';

const owners = [{ calendarId: 'me@x', owner: '나' }];
const now = new Date('2026-10-30T23:00:00Z'); // KST 10-31 08:00

test('오늘(KST)부터 정한 날 수만큼 받아 모두 받은 뒤에 쓴다', async () => {
  const fetched = [];
  const written = [];
  const result = await runCalendarDays({ now, days: 3, readOwners: () => owners,
    makeFetcher: async () => async (date) => {
      fetched.push(date);
      assert.equal(written.length, 0);
      return date === '2026-11-01' ? [{ calendar: '내', calendarId: 'me@x', iCalUID: null, title: '모임',
        start: '2026-11-01T12:00:00+09:00', end: '2026-11-01T13:00:00+09:00', allDay: false, location: null }] : [];
    },
    write: (day) => { written.push(day.date); return day.date === '2026-10-31' ? null : `/x/${day.date}.json`; } });
  assert.deepEqual(fetched, ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(written, fetched);
  assert.deepEqual(result.written, ['/x/2026-11-01.json', '/x/2026-11-02.json']);
  assert.equal(result.days[1].events[0].title, '모임');
});

test('조회가 하나라도 실패하면 아무 날도 쓰지 않고 실패한다', async () => {
  const written = [];
  await assert.rejects(runCalendarDays({ now, days: 3, readOwners: () => owners,
    makeFetcher: async () => async (date) => { if (date === '2026-11-01') throw new Error('HTTP 503'); return []; },
    write: (day) => { written.push(day.date); return null; } }), /HTTP 503/);
  assert.deepEqual(written, []);
});

test('소유자 표를 못 읽거나 연결이 없으면 조회 전에 실패한다', async () => {
  let fetcherMade = false;
  await assert.rejects(runCalendarDays({ now, readOwners: () => { throw new Error('캘린더 소유자 표 형식 오류'); },
    makeFetcher: async () => { fetcherMade = true; return async () => []; } }), /형식 오류/);
  assert.equal(fetcherMade, false);
  await assert.rejects(runCalendarDays({ now, readOwners: () => owners,
    makeFetcher: async () => { throw new Error('캘린더 미연결'); } }), /미연결/);
});

test('미리보기는 쓰지 않고, 날 수는 1~31만 받는다', async () => {
  const result = await runCalendarDays({ now, days: 2, dryRun: true, readOwners: () => owners,
    makeFetcher: async () => async () => [], write: () => { throw new Error('쓰면 안 됨'); } });
  assert.deepEqual(result.days.map((day) => day.date), ['2026-10-31', '2026-11-01']);
  assert.deepEqual(result.written, []);
  await assert.rejects(runCalendarDays({ now, days: 0, readOwners: () => owners }), /1~31/);
  await assert.rejects(runCalendarDays({ now, days: Number.NaN, readOwners: () => owners }), /1~31/);
});

test('잡 등록: run.sh·plist 15분·헬스 30분', () => {
  const run = readFileSync(new URL('../launchd/run.sh', import.meta.url), 'utf8');
  assert.match(run, /calendar-days\) CMD=\(scripts\/jobs\/calendar-days\.mjs\) ;;/);
  const plist = readFileSync(new URL('../launchd/com.banana2.calendar-days.plist', import.meta.url), 'utf8');
  assert.match(plist, /<string>com\.banana2\.calendar-days<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/);
  assert.equal(EXPECTED_INTERVALS_MS['calendar-days'], 30 * 60 * 1000);
});

test('선택된 캘린더가 0개면 빈 일정으로 덮어쓰지 않고 실패한다', async () => {
  await assert.rejects(makeCalendarFetcher({ configured: () => true, getToken: async () => 't',
    listCalendars: async () => [], listDay: async () => { throw new Error('부르면 안 됨'); } }), /선택된 캘린더 0개/);
  await assert.rejects(makeCalendarFetcher({ configured: () => false }), /미연결/);
  const calls = [];
  const fetchDay = await makeCalendarFetcher({ configured: () => true, getToken: async () => 't',
    listCalendars: async () => [{ id: 'me@x', summary: '나' }],
    listDay: async (date, options) => { calls.push([date, options.token, options.calendars.length]); return []; } });
  await fetchDay('2026-10-31');
  assert.deepEqual(calls, [['2026-10-31', 't', 1]]);
});

test('인자: --days N·--days=N·--dry-run, 모르는 인자는 실패', () => {
  assert.deepEqual(parseArgs([]), { days: 7, dryRun: false });
  assert.deepEqual(parseArgs(['--days', '3', '--dry-run']), { days: 3, dryRun: true });
  assert.deepEqual(parseArgs(['--days=2']), { days: 2, dryRun: false });
  assert.throws(() => parseArgs(['--day=2']), /모르는 인자/);
  assert.ok(Number.isNaN(parseArgs(['--days']).days));
});
