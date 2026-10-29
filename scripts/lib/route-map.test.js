import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { circledNumber, planMap, renderMapSvg, renderRouteMapFile, routePathPoints, worldPixel, MAP_WIDTH, MAP_HEIGHT }
  from './route-map.mjs';

// 좌표는 실제 장소가 아닌 가상 값이다(공개 저장소).
const day = '2040-02-03';
const at = (clock) => Date.parse(`${day}T${clock}+09:00`) / 1000;
const points = [
  { lat: 10.0, lon: 20.0, tst: at('08:00:00'), acc: 10 },
  { lat: 10.01, lon: 20.01, tst: at('09:00:00'), acc: 10 },
  { lat: 10.02, lon: 20.0, tst: at('10:00:00'), acc: 500 },
  { lat: 10.02, lon: 20.02, tst: at('11:00:00'), acc: 10 },
  { lat: 30.0, lon: 40.0, tst: at('00:00:00') + 86_400, acc: 10 },
];
const route = [
  { kind: 'stay', lat: 10.0, lon: 20.0, label: '가상 장소 A' },
  { kind: 'move', lat: 10.0, lon: 20.0, label: '이동' },
  { kind: 'stay', lat: 10.02, lon: 20.02, label: '가상 장소 B' },
];

test('세계 픽셀 좌표: 0,0은 확대 0에서 타일 가운데', () => {
  assert.deepEqual(worldPixel(0, 0, 0), { x: 128, y: 128 });
  assert.equal(worldPixel(180, 0, 1).x, 512);
});

test('번호는 ①부터, 20 넘으면 괄호 숫자', () => {
  assert.equal(circledNumber(1), '①');
  assert.equal(circledNumber(20), '⑳');
  assert.equal(circledNumber(21), '(21)');
});

test('경로 점: 그날 KST 점만, 정확도 나쁜 점 제외, 시간순', () => {
  const kept = routePathPoints([...points].reverse(), day);
  assert.deepEqual(kept.map((point) => point.tst), [at('08:00:00'), at('09:00:00'), at('11:00:00')]);
});

test('지도 계획: 모든 점이 여백 안에 들어가는 가장 큰 확대, 화면을 덮는 타일만', () => {
  const plan = planMap(routePathPoints(points, day));
  for (const point of routePathPoints(points, day)) {
    const pixel = worldPixel(point.lon, point.lat, plan.zoom);
    assert.ok(pixel.x - plan.originX >= 0 && pixel.x - plan.originX <= MAP_WIDTH);
    assert.ok(pixel.y - plan.originY >= 0 && pixel.y - plan.originY <= MAP_HEIGHT);
  }
  const tighter = planMap(routePathPoints(points, day).slice(0, 2));
  assert.ok(tighter.zoom >= plan.zoom);
  assert.ok(plan.tiles.length <= 12);
  assert.equal(planMap([]), null);
});

test('SVG: 경로·번호 핀·축척·OSM 출처를 그리고, 없는 타일은 비운다', () => {
  const pathPoints = routePathPoints(points, day);
  const plan = planMap(pathPoints);
  const first = plan.tiles[0];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const svg = renderMapSvg(plan, { pathPoints, places: route.filter((entry) => entry.kind !== 'move'),
    tileImages: new Map([[`${first.z}/${first.x}/${first.y}`, png]]) });
  assert.equal((svg.match(/<image /g) ?? []).length, 1);
  assert.equal((svg.match(/<polyline /g) ?? []).length, 2);
  assert.equal((svg.match(/<rect [^>]*rx="11"/g) ?? []).length, 2);
  assert.match(svg, />1<\/text>[\s\S]*>2<\/text>/);
  assert.match(svg, /© OpenStreetMap contributors/);
  assert.match(svg, /(\d+m|\d+km)<\/text>/);
  assert.doesNotMatch(svg, /가상 장소/); // 지도에는 장소 이름을 쓰지 않는다(글은 동선 칸에)
});

test('파일 쓰기: 연도 폴더에 저장하고 볼트 상대 경로를 돌려준다. 그릴 것이 없으면 null', async () => {
  const root = mkdtempSync(join(tmpdir(), 'route-map-'));
  try {
    const requested = [];
    const fetcher = { get: async (tile) => { requested.push(tile); return null; } };
    let written = null;
    const write = (path, content) => { written = { path, content }; };
    const { rel, missingTiles } = await renderRouteMapFile({ date: day, route, points, root, fetcher, write });
    assert.equal(rel, '95_Etna/Location/Maps/2040/2040-02-03.svg');
    assert.equal(missingTiles, requested.length);
    assert.equal(written.path, join(root, rel));
    assert.match(written.content, /^<svg /);
    assert.ok(requested.length > 0 && requested.every((tile) => Number.isInteger(tile.z)));
    assert.equal(await renderRouteMapFile({ date: day, route: [], points, root, fetcher, write }), null);
    // 같은 내용이면 다시 쓰지 않는다.
    mkdirSync(join(root, '95_Etna/Location/Maps/2040'), { recursive: true });
    writeFileSync(join(root, rel), written.content);
    written = null;
    await renderRouteMapFile({ date: day, route, points, root, fetcher, write });
    assert.equal(written, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('겹치는 핀은 번호를 합친다(집 출발·귀가)', async () => {
  const { groupPins } = await import('./route-map.mjs');
  assert.deepEqual(groupPins([{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 105, y: 102 }]),
    [{ x: 100, y: 100, numbers: [1, 3] }, { x: 300, y: 100, numbers: [2] }]);
});
