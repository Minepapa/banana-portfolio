import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { groupMoments, describeMoment, runMediaMoments } from './media-moments.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';

const gps = { lat: 0, lon: 0 };
const item = (id, time, location = gps) => ({ id, kind: 'Camera', capturedAt: time,
  archivePath: `Archive/2030/01/Camera/item-${id}.jpg`, gps: location });
const time = (clock) => `2030-01-02T${clock}:00+09:00`;
const silent = { log() {} };
const rules = [{ type: 'media', path: `${VAULT_REL.mediaMoments}/{YYYY}/`,
  pathRegex: /^20_Records\/24_Media\/\d{4}\/[^/]+\.md$/,
  titleRegex: /^\d{4}-\d{2}-\d{2} \S/, required: { bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'],
    extra: ['occurred', 'origin', 'mediaCount'] } }];

function fixture(t, records) {
  const root = mkdtempSync(join(tmpdir(), 'media-moments-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const index = join(root, VAULT_REL.mediaArchiveIndex);
  mkdirSync(dirname(index), { recursive: true });
  writeFileSync(index, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const writes = [];
  const options = { root, registryRules: rules, routePoints: () => [], paymentsForDay: () => [],
    places: [], geocode: Object.assign(async () => null, { flush: async () => {} }),
    write: (path, content) => { writes.push(path); writeAtomic(path, content); }, output: silent,
    now: '2030-01-03T00:00:00.000Z' };
  return { root, index, writes, options };
}

test('90분과 1.5km 경계에서 순간을 나눈다', () => {
  const records = [item('a', time('10:00')), item('b', time('11:30')),
    item('c', time('11:31'), { lat: 0, lon: 0.014 }), item('d', time('13:02'))];
  assert.deepEqual(groupMoments(records).map((moment) => moment.map((record) => record.id)), [['a', 'b'], ['c'], ['d']]);
});

test('동선이 GPS와 결제보다 우선하고 등록 장소가 지오코더보다 우선한다', async () => {
  const records = [item('a', time('10:00'))];
  const route = await describeMoment(records, { root: '/unused', dryRun: false,
    routePoints: () => [{ tst: 1 }], paymentsForDay: () => [{ at: time('10:00'), merchant: '가상 상점' }],
    routeForDay: async () => [{ kind: 'stay', startAt: time('09:00'), endAt: time('11:00'),
      label: '가상 체류', activity: '산책', placeName: '가상 체류' }],
    places: [{ name: '등록 장소', lat: 0, lon: 0 }], geocode: async () => { throw new Error('GPS 호출'); } });
  assert.equal(route.source, 'route');
  assert.match(route.summary, /가상 체류.*산책/);
  const unknown = await describeMoment(records, { root: '/unused', dryRun: true,
    routePoints: () => [{ tst: 1 }], paymentsForDay: () => [],
    routeForDay: async () => [{ kind: 'stay', startAt: time('09:00'), endAt: time('11:00'),
      label: '미등록 장소(dry-run)' }], places: [] });
  assert.equal(unknown.place, null);
  assert.equal(unknown.summary, '미등록 장소(dry-run)');
  const registered = await describeMoment(records, { root: '/unused', dryRun: false,
    routePoints: () => [], paymentsForDay: () => [{ at: time('10:00'), merchant: '가상 상점' }],
    places: [{ name: '등록 장소', lat: 0, lon: 0 }], geocode: async () => { throw new Error('지오코더 호출'); } });
  assert.equal(registered.place, '등록 장소');
  assert.equal(registered.source, 'gps');
  const payment = await describeMoment([{ ...records[0], gps: undefined }], { root: '/unused', dryRun: true,
    routePoints: () => [], paymentsForDay: () => [{ at: time('10:00'), merchant: '가상 상점' }], places: [] });
  assert.equal(payment.source, 'payment');
});

test('제목 충돌, 메모 보존, 이어 붙기, 멱등을 확인한다', async (t) => {
  const { root, index, writes, options } = fixture(t, [item('a', time('10:00')),
    item('b', time('11:00'), { lat: 1, lon: 1 })]);
  const first = await runMediaMoments(options);
  assert.equal(first.created, 2);
  const state = JSON.parse(readFileSync(join(root, VAULT_REL.mediaMomentsState), 'utf8'));
  assert.notEqual(state.a.notePath, state.b.notePath);
  const path = join(root, state.a.notePath);
  writeFileSync(path, readFileSync(path, 'utf8')
    .replace('momentId: "a"', 'ownerTag: "보존"\nplace: "옛 장소"\nmomentId: "a"')
    .replace('<!-- media-moments:start -->', '표식 앞의 오너 글\n<!-- media-moments:start -->') + '나의 메모\n');
  writeFileSync(index, [item('a', time('10:00')), item('c', time('10:20')),
    item('b', time('11:00'), { lat: 1, lon: 1 })].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const next = await runMediaMoments(options);
  assert.equal(next.updated, 1);
  assert.match(readFileSync(path, 'utf8'), /나의 메모/);
  assert.match(readFileSync(path, 'utf8'), /표식 앞의 오너 글/);
  assert.match(readFileSync(path, 'utf8'), /ownerTag: "보존"/);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /place: "옛 장소"/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, VAULT_REL.mediaMomentsState), 'utf8')).a.mediaIds, ['a', 'c']);
  const count = writes.length;
  assert.equal((await runMediaMoments(options)).skipped, 2);
  assert.equal(writes.length, count);
  assert.equal(writes.filter((written) => written === path).length, 2); // 서로 다른 두 실행에서 한 번씩
});

test('상태 경로의 momentId가 다르면 덮어쓰지 않는다', async (t) => {
  const { root, options } = fixture(t, [item('a', time('10:00'))]);
  await runMediaMoments(options);
  const state = JSON.parse(readFileSync(join(root, VAULT_REL.mediaMomentsState), 'utf8'));
  const path = join(root, state.a.notePath);
  const changed = readFileSync(path, 'utf8').replace('momentId: "a"', 'momentId: "other"');
  writeFileSync(path, changed);
  await assert.rejects(runMediaMoments(options), /momentId 불일치/);
  assert.equal(readFileSync(path, 'utf8'), changed);
});

test('dry-run은 파일과 캐시를 바꾸거나 카카오를 호출하지 않는다', async (t) => {
  const { root, writes, options } = fixture(t, [item('a', time('10:00'))]);
  let calls = 0;
  await runMediaMoments({ ...options, dryRun: true, places: [], geocode: Object.assign(async () => {
    calls += 1; throw new Error('호출 금지');
  }, { flush: async () => { calls += 1; } }) });
  assert.equal(calls, 0);
  assert.deepEqual(writes, []);
  assert.equal(readFileSync(join(root, VAULT_REL.mediaArchiveIndex), 'utf8').split('\n').filter(Boolean).length, 1);
});

test('같은 날짜 동선은 한 번 계산하고 지오코더 캐시는 실행당 한 번만 기록한다', async (t) => {
  const { options } = fixture(t, [item('a', time('10:00')), item('b', time('12:00'))]);
  let routeCalls = 0;
  let flushes = 0;
  const geocode = Object.assign(async () => null, { flush: async () => { flushes += 1; } });
  const deps = { ...options, geocode, routePoints: () => [{ tst: 1 }],
    routeForDay: async (_date, { geocode: routeGeocode }) => {
      routeCalls += 1;
      await routeGeocode.flush(); // computeRoute의 날짜별 flush를 흉내 낸다.
      return [];
    } };
  await runMediaMoments(deps);
  assert.equal(routeCalls, 1);
  assert.equal(flushes, 1);
});

test('dry-run은 append 중 마지막 미완성 색인 행을 건너뛰고 락 파일도 만들지 않는다', async (t) => {
  const { index, options } = fixture(t, [item('a', time('10:00'))]);
  writeFileSync(index, `${readFileSync(index, 'utf8')}{"id":"partial"`);
  const summary = await runMediaMoments({ ...options, dryRun: true });
  assert.equal(summary.created, 1);
  assert.equal(existsSync(`${index}.lock`), false);
});
