import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { VAULT_REL } from './vault-paths.mjs';
import { readDayPoints, detectStays, matchPlace, loadPlaces, describeStays } from './location-stays.mjs';
import { reverseGeocode, createCachedGeocoder, readKakaoKey } from './kakao-geocode.mjs';
import { updateCandidates, readCandidates } from './place-candidates.mjs';
import { computeRoute } from '../jobs/daily-note.mjs';

const fixture = (t) => { const root = mkdtempSync(join(tmpdir(), 'd89-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
const point = (minutes, lat = 12, lon = 34, acc = 5) => ({ tst: 1_780_000_000 + minutes * 60, lat, lon, acc });

test('손상 줄과 낮은 정확도는 제외하고 15분 경계와 긴 공백을 체류로 본다', (t) => {
  const root = fixture(t);
  const date = '2026-05-28';
  const directory = join(root, VAULT_REL.location, '2026');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${date}.jsonl`), `${JSON.stringify(point(0))}\n깨진 줄\n${JSON.stringify(point(15))}\n${JSON.stringify(point(20, 12, 34, 201))}\n`);
  const result = readDayPoints(date, { root });
  assert.equal(result.brokenLines, 1);
  assert.equal(result.points.length, 2);
  const stays = detectStays(result.points);
  assert.equal(stays.length, 1);
  assert.equal(stays[0].pointCount, 2);
  assert.equal(detectStays([point(0), point(120)]).length, 1);
  assert.equal(detectStays([point(0), point(14)]).length, 0);
  assert.equal(detectStays([point(0), point(15, 12.002)]).length, 1);
  const metersToDegrees = (meters) => meters / 6_371_000 * 180 / Math.PI;
  assert.equal(detectStays([point(0, 0, 0), point(15, 0, metersToDegrees(149.9))]).length, 1);
  assert.equal(detectStays([point(0, 0, 0), point(15, 0, metersToDegrees(150.1))]).length, 1);
});

test('튄 점을 건너뛰고 가까운 인접 체류를 합친다', () => {
  const stays = detectStays([point(0), point(10, 12.01), point(20), point(30), point(40, 12.002), point(50), point(65)]);
  assert.equal(stays.length, 1);
  assert.equal(stays[0].pointCount, 5);
  const separated = detectStays([point(0), point(15), point(20, 12.01), point(21, 12.01), point(25), point(40)]);
  assert.equal(separated.length, 1);
  assert.equal(separated[0].pointCount, 4);
});

test('자정 걸친 체류는 요청한 KST 날짜 범위로 자른다', () => {
  const first = Date.parse('2026-10-08T23:50:00+09:00') / 1000;
  const stays = detectStays([{ tst: first, lat: 12, lon: 34 }, { tst: first + 30 * 60, lat: 12, lon: 34 }], { date: '2026-10-09' });
  assert.equal(stays[0].start, '2026-10-08T15:00:00.000Z');
  assert.equal(stays[0].end, '2026-10-08T15:20:00.000Z');
});

test('데일리 계산은 자정 양쪽 날짜 기록을 이어 읽는다', async (t) => {
  const root = fixture(t);
  const before = Date.parse('2026-10-08T23:50:00+09:00') / 1000;
  const after = Date.parse('2026-10-09T00:20:00+09:00') / 1000;
  for (const [date, tst] of [['2026-10-08', before], ['2026-10-09', after]]) {
    const directory = join(root, VAULT_REL.location, '2026');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${date}.jsonl`), `${JSON.stringify({ tst, lat: 12, lon: 34, acc: 5 })}\n`);
  }
  const route = await computeRoute('2026-10-09', { root, geocode: async () => '건물' });
  assert.deepEqual([route[0].start, route[0].end], ['00:00', '00:20']);
});

test('자정에 끝난 체류는 24:00으로 표시하고 dry-run에서는 지오코딩을 부르지 않는다', async (t) => {
  const root = fixture(t);
  const date = '2026-10-09';
  const directory = join(root, VAULT_REL.location, '2026');
  mkdirSync(directory, { recursive: true });
  const first = Date.parse('2026-10-09T23:40:00+09:00') / 1000;
  writeFileSync(join(directory, `${date}.jsonl`), `${JSON.stringify({ tst: first, lat: 12, lon: 34 })}\n`);
  writeFileSync(join(directory, '2026-10-10.jsonl'), `${JSON.stringify({ tst: first + 20 * 60, lat: 12, lon: 34 })}\n`);
  const route = await computeRoute(date, { root, dryRun: true, geocode: async () => { throw new Error('지오코딩 호출'); } });
  assert.deepEqual([route[0].start, route[0].end, route[0].label], ['23:40', '24:00', '미등록 장소(dry-run)']);
  assert.equal(readdirSync(directory).length, 2);
});

test('가장 가까운 등록 장소를 고르고 좌표 없는 장소는 건너뛴다', async (t) => {
  const root = fixture(t);
  const directory = join(root, VAULT_REL.places);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '가게.md'), '---\nlat: 12\nlon: 34\n---\n');
  writeFileSync(join(directory, '빈 노트.md'), '---\ntype: place\n---\n');
  const places = loadPlaces(root);
  assert.equal(places.length, 1);
  assert.equal(matchPlace({ lat: 12, lon: 34 }, places).name, '가게');
  assert.equal((await describeStays([{ start: 'a', end: 'b', lat: 12, lon: 34 }], { places, geocode: () => { throw new Error('called'); } }))[0].registered, true);
});

test('카카오 역지오코딩 우선순위, 캐시, 키 없음, 실패', async (t) => {
  const root = fixture(t);
  const keyPath = join(root, 'kakao.key');
  const key = randomBytes(16).toString('base64url');
  let calls = 0;
  const fetchImpl = async (url, options) => { calls += 1; assert.match(String(url), /x=34/); assert.equal(options.headers.Authorization, `KakaoAK ${key}`); return { ok: true, json: async () => ({ documents: [{ road_address: { building_name: '건물', address_name: '도로' }, address: { address_name: '지번' } }] }) }; };
  assert.equal(await reverseGeocode(12, 34, { key, fetchImpl }), '건물');
  const missing = createCachedGeocoder({ root, keyPath, fetchImpl });
  assert.match((await missing(12, 34)).reason, /키 없음/);
  writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
  symlinkSync(keyPath, join(root, 'key-link'));
  assert.throws(() => readKakaoKey(join(root, 'key-link')), /링크/);
  const geocode = createCachedGeocoder({ root, keyPath, fetchImpl });
  assert.equal((await geocode(12, 34)).address, '건물');
  assert.equal((await geocode(12, 34)).address, '건물');
  await geocode.flush();
  assert.equal(calls, 2);
  const failed = createCachedGeocoder({ root, keyPath, fetchImpl: async () => { throw new Error('offline'); } });
  assert.match((await failed(13, 35)).reason, /조회 실패/);
  assert.equal(failed.failureCount(), 1);
});

test('지오코딩 캐시는 실행 중 순차 조회하고 한 번에 저장하며 손상본을 격리한다', async (t) => {
  const root = fixture(t);
  const keyPath = join(root, 'key');
  writeFileSync(keyPath, 'secret', { mode: 0o600 });
  const cachePath = join(root, VAULT_REL.locationGeocodeCache);
  mkdirSync(join(cachePath, '..'), { recursive: true });
  writeFileSync(cachePath, '{broken');
  let active = 0;
  const geocode = createCachedGeocoder({ root, keyPath, fetchImpl: async () => {
    active += 1;
    assert.equal(active, 1);
    await Promise.resolve();
    active -= 1;
    return { ok: true, json: async () => ({ documents: [{ address: { address_name: '주소' } }] }) };
  } });
  await Promise.all([geocode(12, 34), geocode(13, 35)]);
  assert.equal(readdirSync(join(cachePath, '..')).some((name) => name.startsWith('geocode-cache.json.corrupt-')), true);
  await geocode.flush();
  assert.equal(Object.keys(JSON.parse(readFileSync(cachePath, 'utf8'))).length, 2);
});

test('데일리 동선은 지오코딩 실패 건수를 로그로 남긴다', async (t) => {
  const root = fixture(t);
  const date = '2026-10-09';
  const directory = join(root, VAULT_REL.location, '2026');
  mkdirSync(directory, { recursive: true });
  const first = Date.parse('2026-10-09T10:00:00+09:00') / 1000;
  writeFileSync(join(directory, `${date}.jsonl`), `${JSON.stringify({ tst: first, lat: 12, lon: 34 })}\n${JSON.stringify({ tst: first + 900, lat: 12, lon: 34 })}\n`);
  const warnings = [];
  const prior = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const geocode = async () => ({ reason: '조회 실패' });
    geocode.failureCount = () => 1;
    await computeRoute(date, { root, geocode });
  } finally { console.warn = prior; }
  assert.match(warnings.join('\n'), /지오코딩 실패 1건/);
});

test('손상된 후보 JSON은 예외로 알리고 보존한다', (t) => {
  const root = fixture(t);
  const path = join(root, VAULT_REL.locationCandidates);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '{broken');
  assert.throws(() => readCandidates(root), SyntaxError);
  assert.equal(readFileSync(path, 'utf8'), '{broken');
  writeFileSync(path, '[null]');
  assert.throws(() => readCandidates(root), /형식 오류/);
});

test('후보는 날짜별 방문을 중복하지 않고 3일 또는 일정 겹침에서 ready', (t) => {
  const root = fixture(t);
  const stay = { lat: 12, lon: 34, address: '건물', registered: false, start: '2026-10-09T01:00:00Z', end: '2026-10-09T02:00:00Z' };
  for (const date of ['2026-10-07', '2026-10-08', '2026-10-09']) updateCandidates({ date, stays: [stay, stay], root });
  assert.equal(readCandidates(root)[0].visits.length, 3);
  assert.equal(updateCandidates({ date: '2026-10-09', stays: [], root }).ready.length, 1);
  const secondRoot = fixture(t);
  const event = { title: '운동', start: '2026-10-09T01:30:00Z', end: '2026-10-09T02:30:00Z', allDay: false };
  assert.equal(updateCandidates({ date: '2026-10-09', stays: [stay], events: [event], root: secondRoot }).ready.length, 1);
});
