import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRouteDay, routeDayPath, routeMinutes, writeRouteDay } from './route-days.mjs';

const route = [
  { kind: 'stay', start: '00:00', end: '06:23', startAt: '2026-10-28T15:00:00.000Z', endAt: '2026-10-28T21:23:00.000Z',
    label: '집', registered: true, placeName: '집', lat: 37.38771234567, lon: 126.6335 },
  { kind: 'move', start: '06:23', end: '07:34', startAt: 'a', endAt: 'b', label: '이동 · 차량 약 41km', distanceKm: 41.2, mode: '차량', lat: 1, lon: 2 },
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
  assert.equal(day.schemaVersion, 1);
  assert.deepEqual(day.entries.map(({ kind, minutes }) => [kind, minutes]), [['stay', 383], ['move', 71], ['stay', 680], ['stay', 254]]);
  assert.equal(day.entries[0].lat, 37.387712);
  assert.deepEqual(day.entries[1], { kind: 'move', start: '06:23', end: '07:34', startAt: 'a', endAt: 'b', minutes: 71,
    label: '이동 · 차량 약 41km', lat: 1, lon: 2, distanceKm: 41.2, mode: '차량' });
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
