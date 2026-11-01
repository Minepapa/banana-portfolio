import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 볼트에서 돌린다 — vault-paths를 읽는 모듈은 VAULT_PATH를 정한 뒤에 동적으로 불러온다(실제 볼트에 쓰지 않게).
const vault = mkdtempSync(join(tmpdir(), 'route-today-vault-'));
process.env.VAULT_PATH = vault;
const { buildRouteToday, routeTodayPath, writeRouteToday } = await import('../lib/route-today.mjs');
const { ROUTE_DAY_SCHEMA } = await import('../lib/route-days.mjs');
const { main, parseArgs, readOnlyGeocoder, runRouteToday } = await import('./route-today.mjs');

const date = '2026-11-01';
const tst = (hhmm) => Date.parse(`${date}T${hhmm}:00+09:00`) / 1000;
const route = [
  { kind: 'stay', start: '00:00', end: '08:10', label: '집', registered: true, placeName: '집', lat: 37.1, lon: 126.1,
    outings: [] },
  { kind: 'move', start: '08:10', end: '08:50', label: '이동', distanceKm: 12.3, track: [] },
  { kind: 'stay', start: '08:50', end: '', current: true, label: '회사', registered: true, placeName: '회사',
    lat: 37.2, lon: 126.2, outings: [] },
];

test('오늘 동선은 Days 3판 모양에 provisional·asOf를 붙이고, 지금 머무는 곳은 마지막 점까지로 센다', () => {
  // 전날 점(자정 양쪽을 함께 읽는다)은 asOf가 되지 않는다.
  const points = [{ tst: tst('00:00') - 60 }, { tst: tst('08:00') }, { tst: tst('10:20') }];
  const today = buildRouteToday({ date, route, points });
  assert.equal(today.schemaVersion, ROUTE_DAY_SCHEMA);
  assert.equal(today.provisional, true);
  assert.equal(today.asOf, new Date(tst('10:20') * 1000).toISOString());
  const current = today.entries.at(-1);
  assert.equal(current.current, true);
  assert.equal(current.end, null);
  assert.equal(current.minutes, 90, '08:50 → 10:20');
  assert.equal(current.order, 2);
  // 밖에 있던 시간 = 이동 40분 + 회사 90분(집 체류는 외출만 센다).
  assert.deepEqual(today.summary, { distanceKm: 12.3, stays: 2, outsideMinutes: 130 });
});

test('움직이는 중이면 마지막 이동이 current이고, 그 이동도 마지막 점까지 밖에 있던 시간에 든다', () => {
  const moving = [route[0], route[1], { ...route[2], end: '12:00', current: false },
    { kind: 'move', start: '12:00', end: '', current: true, label: '이동', distanceKm: 3, track: [] }];
  const today = buildRouteToday({ date, route: moving, points: [{ tst: tst('12:25') }] });
  const last = today.entries.at(-1);
  assert.equal(last.kind, 'move');
  assert.equal(last.current, true);
  assert.equal(last.end, null);
  assert.equal(last.minutes, 25);
  assert.equal(today.entries.filter((entry) => entry.current).length, 1);
  // 이동 40 + 회사 190(08:50~12:00) + 지금 이동 25
  assert.deepEqual(today.summary, { distanceKm: 15.3, stays: 2, outsideMinutes: 255 });
});

test('오늘 잡의 장소 조회기는 캐시를 파일로 쓰지 않는다', async () => {
  let flushed = 0;
  const made = [];
  const geocode = readOnlyGeocoder((options) => { made.push(options); return { flush: async () => { flushed += 1; } }; }, '/vault-root');
  await geocode.flush();
  assert.equal(flushed, 0);
  assert.deepEqual(made, [{ root: '/vault-root' }]);
});

test('오늘 점이 없으면 asOf는 null이고 항목도 비어 날짜만 넘어간다', () => {
  const today = buildRouteToday({ date, route: [], points: [{ tst: tst('00:00') - 60 }] });
  assert.equal(today.asOf, null);
  assert.deepEqual(today.entries, []);
  assert.deepEqual(today.summary, { distanceKm: 0, stays: 0, outsideMinutes: 0 });
});

test('같은 내용이면 다시 쓰지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'route-today-'));
  try {
    const today = buildRouteToday({ date, route, points: [{ tst: tst('10:20') }] });
    assert.equal(writeRouteToday(today, { root }), routeTodayPath(root));
    const saved = JSON.parse(readFileSync(routeTodayPath(root), 'utf8'));
    assert.equal(saved.date, date);
    assert.equal(saved.provisional, true);
    assert.equal(saved.entries.length, 3);
    assert.equal(writeRouteToday(today, { root }), null);
    const later = buildRouteToday({ date, route, points: [{ tst: tst('10:35') }] });
    assert.equal(writeRouteToday(later, { root }), routeTodayPath(root), '새 점이 오면 다시 쓴다');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('잡: 오늘(KST) 날짜로 계산하고, 일정 조회가 실패해도 일정 없이 쓴다', async () => {
  const seen = [];
  const warnings = [];
  const written = [];
  const result = await runRouteToday({ now: new Date('2026-10-31T16:30:00Z'), deps: {
    readPoints: (day) => { seen.push(['points', day]); return [{ tst: tst('01:00') }]; },
    readPayments: () => [],
    fetchEvents: async () => { throw new Error('calendar'); },
    computeRoute: async (day, { events }) => { seen.push(['compute', day, events.length]); return []; },
    write: (today) => { written.push(today.date); return 'path'; },
    warn: (message) => warnings.push(message), makeGeocoder: () => ({}),
  } });
  assert.equal(result.date, '2026-11-01', 'UTC 16:30 = KST 다음 날 01:30');
  assert.deepEqual(seen, [['points', '2026-11-01'], ['compute', '2026-11-01', 0]]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(written, ['2026-11-01']);
});

test('잡: 장소 조회 실패(degraded)면 쓰지 않고 종료 코드 1, 미리보기는 쓰지 않는다', async () => {
  const degraded = [];
  Object.defineProperty(degraded, 'degraded', { value: true });
  let writes = 0;
  const deps = { readPoints: () => [], readPayments: () => [], fetchEvents: async () => [],
    computeRoute: async () => degraded, write: () => { writes += 1; }, makeGeocoder: () => ({}) };
  assert.equal((await runRouteToday({ deps })).degraded, true);
  assert.equal(writes, 0);
  const errors = [];
  assert.equal(await main([], { run: () => runRouteToday({ deps }), log: () => {}, error: (m) => errors.push(m) }), 1);
  assert.match(errors[0], /장소 조회 실패/);
  const ok = { ...deps, computeRoute: async () => [] };
  assert.equal((await runRouteToday({ dryRun: true, deps: ok })).written, null);
  assert.equal(writes, 0);
});

test('잡 인자는 --dry-run만 받는다(모르는 인자는 실패 — 데몬을 인자로 떠보지 않게)', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false });
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true });
  assert.throws(() => parseArgs(['--help']), /모르는 인자/);
});

test('기본 경로는 임시 볼트를 가리키고, 테스트가 끝나도 Today 파일이 없다', () => {
  assert.equal(routeTodayPath(), join(vault, '95_Etna', 'Location', 'Today.json'));
  assert.equal(existsSync(routeTodayPath()), false);
  rmSync(vault, { recursive: true, force: true });
});
