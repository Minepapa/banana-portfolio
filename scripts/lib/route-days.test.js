import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildRouteDay, routeDayCurrent, routeDayPath, routeDayText, routeMinutes, writeRouteDay } from './route-days.mjs';

const route = [
  { kind: 'stay', start: '00:00', end: '06:23', startAt: '2026-10-28T15:00:00.000Z', endAt: '2026-10-28T21:23:00.000Z',
    label: '집', registered: true, placeName: '집', lat: 37.38771234567, lon: 126.6335 },
  { kind: 'move', start: '06:23', end: '07:34', startAt: 'a', endAt: 'b', label: '이동 · 차량 약 41km', distanceKm: 41.2, mode: '차량', lat: 1, lon: 2,
    track: [{ lat: 37.12345678, lon: 126.98765432, tst: 1793300000 }, { lat: 37.2, lon: 127, tst: 1793300060 }] },
  { kind: 'stay', start: '07:34', end: '18:54', label: '회사(서울)', registered: true, placeName: '회사(서울)', lat: 3, lon: 4,
    outings: [{ start: '10:11', end: '10:24', startAt: 'c', endAt: 'd', area: '낙성대동', lat: 5, lon: 6 }] },
  { kind: 'stay', start: '19:46', end: '24:00', label: '집', registered: true, placeName: '집', lat: 1, lon: 1 },
];

test('표시 시각(HH:MM, 끝 24:00)으로 걸린 분을 낸다', () => {
  assert.equal(routeMinutes('07:34', '18:54'), 680);
  assert.equal(routeMinutes('19:46', '24:00'), 254);
  assert.equal(routeMinutes('20:22', ''), null);
  assert.equal(routeMinutes('10:00', '09:00'), null);
});

test('머문 곳·이동·외출을 걸린 분과 함께 구조화한다', () => {
  const day = buildRouteDay({ date: '2026-10-29', route });
  assert.equal(day.schemaVersion, 2);
  assert.deepEqual(day.entries.map(({ kind, minutes }) => [kind, minutes]), [['stay', 383], ['move', 71], ['stay', 680], ['stay', 254]]);
  assert.equal(day.entries[0].lat, 37.387712);
  assert.deepEqual(day.entries[1], { kind: 'move', start: '06:23', end: '07:34', startAt: 'a', endAt: 'b', minutes: 71,
    label: '이동 · 차량 약 41km', lat: 1, lon: 2, distanceKm: 41.2, mode: '차량',
    track: [[37.123457, 126.987654, 1793300000], [37.2, 127, 1793300060]] });
  assert.deepEqual(day.entries[2].outings, [{ start: '10:11', end: '10:24', startAt: 'c', endAt: 'd', minutes: 13,
    area: '낙성대동', lat: 5, lon: 6 }]);
  assert.equal(day.entries[2].placeName, '회사(서울)');
});

test('같은 내용이면 다시 쓰지 않는다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'route-days-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = writeRouteDay({ date: '2026-10-29', route, root });
  assert.equal(first, routeDayPath('2026-10-29', root));
  assert.equal(JSON.parse(readFileSync(first, 'utf8')).entries.length, 4);
  assert.equal(writeRouteDay({ date: '2026-10-29', route, root }), null);
  assert.ok(writeRouteDay({ date: '2026-10-29', route: route.slice(0, 2), root }));
});

test('옛 판·깨진 파일은 지금 판이 아니라서 재계산이 다시 쓴다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'route-days-current-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = routeDayPath('2026-10-29', root);
  assert.equal(routeDayCurrent('2026-10-29', root), false);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, date: '2026-10-29', entries: [] }));
  assert.equal(routeDayCurrent('2026-10-29', root), false);
  writeFileSync(path, '{');
  assert.equal(routeDayCurrent('2026-10-29', root), false);
  writeRouteDay({ date: '2026-10-29', route, root });
  assert.equal(routeDayCurrent('2026-10-29', root), true);
});

test('파일은 항목마다 한 줄이고 그대로 다시 읽힌다(track 없는 이동은 빈 배열)', () => {
  const day = buildRouteDay({ date: '2026-10-29', route: [...route, { kind: 'move', start: '19:00', end: '19:10', label: '이동' }] });
  const text = routeDayText(day);
  assert.deepEqual(JSON.parse(text), day);
  assert.equal(text.split('\n').length, day.entries.length + 7);
  assert.deepEqual(day.entries.at(-1).track, []);
  assert.equal(routeDayText({ schemaVersion: 2, date: '2026-10-29', entries: [] }), '{\n  "schemaVersion": 2,\n  "date": "2026-10-29",\n  "entries": []\n}\n');
});
