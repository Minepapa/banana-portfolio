import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locationMetrics, compareTracks, compareDay, interpolateAt, GAP_MIN, INTERP_MAX_SEC } from './argos-location-compare.mjs';

const T = 1_793_000_000;
const pt = (dtSec, acc, extra = {}) => ({ tst: T + dtSec, lat: 37.5, lon: 127.0, acc, ...extra });

test('정확도 비율·중앙값은 acc가 숫자인 점만, 공백은 위치 점만과 체류 확인 포함 둘 다', () => {
  const points = [pt(0, 5), pt(600, 150), pt(600 + (GAP_MIN + 1) * 60, 5), pt(9000, null)];
  const alive = [{ tst: T + 600 + GAP_MIN * 30 }];
  const m = locationMetrics(points, alive);
  assert.equal(m.points, 4);
  assert.equal(m.precisePoints, 2);
  assert.equal(m.coarsePct, 33);
  assert.equal(m.accP50, 5);
  assert.equal(m.gaps.length, 2);
  assert.equal(m.gapsWithAlive.length, 1);
  assert.equal(locationMetrics(points).gapsWithAlive, null);
});

test('같은 tst는 측정값 공유로 따로 세고 거리 통계에 넣지 않는다', () => {
  const r = compareTracks([pt(0, 5)], [pt(0, 5)]);
  assert.deepEqual([r.shared, r.sharedSameFix, r.interpolated], [1, 1, 0]);
  assert.equal(r.distanceP50, null);
});

test('[리뷰 HIGH] 등속 이동 중 5초 어긋난 점은 보간하면 거리 약 0 m다(속도×시각차를 재지 않는다)', () => {
  // 북쪽으로 초당 약 22 m(80 km/h): 위도 0.0002도 ≈ 22 m
  const moving = (dt) => ({ tst: T + dt, lat: 37.5 + dt * 0.0002, lon: 127.0, acc: 5 });
  const argos = [moving(0), moving(10), moving(20)];
  const own = [moving(5), moving(15)];
  const r = compareTracks(own, argos);
  assert.equal(r.interpolated, 2);
  assert.ok(r.distanceP50 <= 1, `거리 ${r.distanceP50}`);
});

test('아르고스 앞뒤 점이 멀면 보간하지 않는다', () => {
  assert.equal(interpolateAt([pt(0, 5), pt(INTERP_MAX_SEC + 10, 5)], T + 30), null);
  assert.equal(interpolateAt([pt(0, 5), pt(60, 5)], T - 1), null);
});

test('하루 대조 결과에 좌표가 들어가지 않는다', () => {
  const r = compareDay([pt(0, 5)], { points: [pt(0, 5)], alive: [] });
  assert.equal(JSON.stringify(r).includes('37.5'), false);
});
