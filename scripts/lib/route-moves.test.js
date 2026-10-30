import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMoveSegments, detectStays, movePaymentCoordinate } from './location-stays.mjs';
import { moveStopovers } from './route-activities.mjs';

const date = '2026-10-10';
const iso = (hour, minute) => `2026-10-10T${hour}:${minute}:00.000Z`;
const point = (hour, minute, lon, acc = 5) => ({ tst: Date.parse(iso(hour, minute)) / 1000, lat: 0, lon, acc });
const stay = (start, end, lon, extra = {}) => ({ start, end, lat: 0, lon, kind: 'stay', ...extra });
const pair = (destinationLon, middleLon = destinationLon / 2) => {
  const first = stay(iso('01', '00'), iso('01', '10'), 0);
  const second = stay(iso('01', '30'), iso('02', '00'), destinationLon);
  return { stays: [first, second], points: [point('01', '05', 0), point('01', '20', middleLon), point('01', '30', destinationLon)] };
};

test('이동은 3~10분 지속 속도로 도보·차량을 구분하고 짧은 이동은 제외한다', () => {
  const walk = pair(0.02);
  assert.match(buildMoveSegments(walk.stays, walk.points, { date })[0].label, /^이동 · 도보 약 2km$/);
  const car = pair(0.12);
  assert.match(buildMoveSegments(car.stays, car.points, { date })[0].label, /^이동 · 차량 약 13km$/);
  const slow = pair(0.04);
  assert.match(buildMoveSegments(slow.stays, slow.points, { date })[0].label, /^이동 · 약 4km$/);
  const shortWalk = pair(0.005);
  assert.match(buildMoveSegments(shortWalk.stays, shortWalk.points, { date })[0].label, /^이동 · 도보 약 0\.6km$/);
  const short = pair(0.001);
  assert.deepEqual(buildMoveSegments(short.stays, short.points, { date }), []);
});

test('긴 정차가 차량 평균을 낮춰도 빠른 5분 창은 차량으로 판정한다', () => {
  const stays = [stay(iso('01', '00'), iso('01', '10'), 0), stay(iso('02', '20'), iso('02', '40'), 0.04)];
  const points = [point('01', '05', 0), point('01', '20', 0), point('01', '25', 0.02),
    point('01', '50', 0.02), point('02', '00', 0.04), point('02', '20', 0.04)];
  assert.match(buildMoveSegments(stays, points, { date })[0].label, /^이동 · 차량 약 4km$/);
});

test('3~10분 창이 있는 도보는 도보로 판정한다', () => {
  const stays = [stay(iso('01', '00'), iso('01', '10'), 0), stay(iso('01', '30'), iso('02', '00'), 0.012)];
  const points = [point('01', '05', 0), point('01', '15', 0.003), point('01', '20', 0.006),
    point('01', '25', 0.009), point('01', '30', 0.012)];
  assert.match(buildMoveSegments(stays, points, { date })[0].label, /^이동 · 도보 약 1km$/);
});

test('150km/h를 넘는 튐은 거리와 속도에서 제외하고 결제 좌표에도 쓰지 않는다', () => {
  const stays = [stay(iso('01', '00'), iso('01', '10'), 0), stay(iso('01', '30'), iso('02', '00'), 0.06)];
  const points = [point('01', '05', 0), point('01', '15', 0.02), point('01', '16', 0.1),
    point('01', '20', 0.04), point('01', '30', 0.06)];
  const move = buildMoveSegments(stays, points, { date })[0];
  assert.match(move.label, /^이동 · 차량 약 7km$/);
  assert.deepEqual(movePaymentCoordinate(move, stays, points, Date.parse(iso('01', '16'))), { lat: 0, lon: 0.02 });
});

test('유일한 구간 점이 이상점이면 양 끝 체류만으로 거리와 수단을 추정하지 않는다', () => {
  const stays = [stay(iso('01', '00'), iso('01', '10'), 0), stay(iso('01', '30'), iso('02', '00'), 0.02)];
  const points = [point('01', '05', 0), point('01', '20', 1), point('01', '30', 0.02)];
  assert.equal(buildMoveSegments(stays, points, { date })[0].label, '이동');
});

test('하루 끝 이상점은 이동 종료 시각과 거리를 늘리지 않는다', () => {
  const stays = [stay(iso('01', '00'), iso('01', '10'), 0)];
  const points = [point('01', '05', 0), point('01', '11', 0.0001), point('01', '12', 1)];
  assert.deepEqual(buildMoveSegments(stays, points, { date }), []);
  const moving = [point('01', '05', 0), point('01', '15', 0.02), point('01', '16', 1)];
  const move = buildMoveSegments(stays, moving, { date })[0];
  assert.equal(move.end, iso('01', '15'));
  assert.equal(move.label, '이동 · 약 2km');
});

test('이동 결제는 결제 시각에 가장 가까운 구간 점을 쓰고 점이 없으면 시간상 가까운 체류를 쓴다', () => {
  const stays = [stay(iso('01', '00'), iso('01', '10'), 0), stay(iso('01', '30'), iso('02', '00'), 0.1)];
  const move = { start: iso('01', '10'), end: iso('01', '30'), lat: 0, lon: 0 };
  const points = [point('01', '05', 0), point('01', '15', 0.03), point('01', '24', 0.08)];
  assert.deepEqual(movePaymentCoordinate(move, stays, points, Date.parse(iso('01', '23'))), { lat: 0, lon: 0.08 });
  assert.deepEqual(movePaymentCoordinate(move, stays, [points[0]], Date.parse(iso('01', '26'))), { lat: 0, lon: 0.1 });
});

test('앞 체류에 원시 점이 없어도 그 체류 좌표를 기준으로 첫 이동 이상점을 버린다', () => {
  const stays = [stay(iso('01', '00'), iso('01', '10'), 0), stay(iso('01', '30'), iso('02', '00'), 0.01)];
  const move = { start: iso('01', '10'), end: iso('01', '30'), lat: 0, lon: 0 };
  const points = [point('01', '11', 1), point('01', '12', 0.01)];
  assert.deepEqual(movePaymentCoordinate(move, stays, points, Date.parse(iso('01', '12'))), { lat: 0, lon: 0.01 });
});

test('구간 점이 없으면 먼 체류 사이 이동만 표시하고 같은 등록 장소는 제외한다', () => {
  const { stays, points } = pair(0.12);
  assert.equal(buildMoveSegments(stays, [points[0], points[2]], { date })[0].label, '이동');
  const nearby = pair(0.001);
  assert.deepEqual(buildMoveSegments(nearby.stays, [nearby.points[0], nearby.points[2]], { date }), []);
  const samePlace = stays.map((item) => ({ ...item, registered: true, placeName: '가상 장소' }));
  assert.deepEqual(buildMoveSegments(samePlace, [points[0], points[2]], { date }), []);
});

test('정확도 초과 점은 경로에서 제외하고 이동 중 결제에는 분류와 가맹점만 붙인다', async () => {
  const { stays, points } = pair(0.12);
  assert.equal(buildMoveSegments(stays, [points[0], { ...points[1], acc: 201 }, points[2]], { date })[0].label, '이동');
  const start = Date.parse(stays[0].end);
  const end = Date.parse(stays[1].start);
  const payments = [{ at: iso('01', '20'), merchant: '가상주유소', amount: 1234 },
    { at: iso('01', '21'), merchant: '가상잡화점', amount: 5678 }];
  const suffix = await moveStopovers(start, end, payments, async (merchant) => merchant === '가상주유소' ? { category: 'OL7' } : null);
  assert.equal(suffix, ' (주유: 가상주유소, 가상잡화점)');
  assert.doesNotMatch(suffix, /1234|5678/);
  for (const [category, activity] of [['CS2', '편의점'], ['CE7', '카페'], ['FD6', '식사']]) {
    assert.equal(await moveStopovers(start, end, [{ at: iso('01', '20'), merchant: '가상가게' }],
      async () => ({ category })), ` (${activity}: 가상가게)`);
  }
});

test('하루 끝을 넘는 이동은 24:00에 자른다', () => {
  const stays = [stay(iso('14', '00'), iso('14', '50'), 0), stay('2026-10-10T15:10:00.000Z', '2026-10-10T16:00:00.000Z', 0.12)];
  const points = [point('14', '45', 0), point('14', '55', 0.03), point('14', '59', 0.07), point('15', '10', 0.12)];
  const moves = buildMoveSegments(stays, points, { date });
  assert.equal(moves[0].end, '2026-10-10T15:00:00.000Z');
  assert.equal(moves[0].label, '이동 · 차량 약 8km');
});

test('다음 날 체류 앞 자정 직전 이상점은 오늘 이동의 도착점과 거리에 쓰지 않는다', () => {
  const stays = [stay(iso('14', '00'), iso('14', '50'), 0),
    stay('2026-10-10T15:10:00.000Z', '2026-10-10T16:00:00.000Z', 1)];
  const spikeOnly = [point('14', '45', 0), point('14', '55', 0.0001), point('14', '59', 1)];
  assert.deepEqual(buildMoveSegments(stays, spikeOnly, { date }), []);
  const moving = [point('14', '45', 0), point('14', '55', 0.02), point('14', '59', 1)];
  const move = buildMoveSegments(stays, moving, { date })[0];
  assert.equal(move.end, '2026-10-10T15:00:00.000Z');
  assert.equal(move.label, '이동 · 약 2km');
});

test('익명화 위치 픽스처의 마지막 체류 뒤 관측 구간은 차량 이동이다', () => {
  const points = JSON.parse(readFileSync(new URL('./location-stays.fixture-2026-10-10.json', import.meta.url)));
  const moves = buildMoveSegments(detectStays(points, { date }), points, { date });
  assert.equal(moves.at(-1).start, '2026-10-10T10:57:02.000Z');
  assert.equal(moves.at(-1).end, '2026-10-10T11:10:54.000Z');
  assert.match(moves.at(-1).label, /^이동 · 차량 약 \d+km$/);
});

test('자정에 잘린 집 체류도 전날 점을 출발점으로 써서 출근 이동 거리를 낸다', () => {
  // 2026-10-12 실측 모양: 집 점은 전날 밤 하나뿐이고, 05:52부터 차로 2분마다 점이 찍히며 수원으로 간다.
  const at = (date, time, lat, lon) => ({ tst: Date.parse(`${date}T${time}+09:00`) / 1000, lat, lon, acc: 10 });
  const drive = Array.from({ length: 20 }, (_, index) => {
    const minutes = 52 + index * 2;
    const time = `${String(5 + Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
    return at('2026-10-12', time, 37.3877 - index * 0.0065, 126.6400 + index * 0.0221);
  });
  const points = [at('2026-10-11', '22:00:00', 37.3877, 126.6335), ...drive,
    ...['07:40:00', '08:10:00', '08:40:00'].map((time) => at('2026-10-12', time, 37.2574, 127.0546))];
  const stays = detectStays(points, { date: '2026-10-12' });
  assert.equal(stays[0].start, '2026-10-11T15:00:00.000Z');
  const [commute] = buildMoveSegments(stays, points, { date: '2026-10-12' });
  assert.match(commute.label, /약 \d+km/);
});
