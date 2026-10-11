import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { VAULT_REL } from './vault-paths.mjs';
import { readDayPoints, detectStays, matchPlace, loadPlaces, describeStays, haversineM } from './location-stays.mjs';
import { reverseGeocode, createCachedGeocoder, readKakaoKey } from './kakao-geocode.mjs';
import { updateCandidates, readCandidates } from './place-candidates.mjs';
import { computeRoute } from '../jobs/daily-note.mjs';

const fixture = (t) => { const root = mkdtempSync(join(tmpdir(), 'd89-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
const point = (minutes, lat = 12, lon = 34, acc = 5) => ({ tst: 1_780_000_000 + minutes * 60, lat, lon, acc });
const kstPoint = (time, lat, lon, acc = 5) => ({ tst: Date.parse(`2026-10-10T${time}+09:00`) / 1000, lat, lon, acc });

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

test('가상 좌표 체류를 설명하고 주소 라벨을 유지한다', async () => {
  const points = [point(0, 1, 2), point(20, 1, 2), point(40, 1, 2)];
  const stays = detectStays(points);
  const described = await describeStays(stays, { places: [], geocode: async () => ({ address: '가상 도로 1', buildingName: null }) });
  assert.equal(described[0].label, '미등록: 가상 도로 1');
});

test('실측 픽스처: 2점 군집의 긴 머묾(공연장)을 병합 뒤에도 분리한다', async () => {
  // 2026-10-10 15:20–20:10 실제 점을 위도 −0.05°·경도 +2.5° 옮긴 익명화 데이터(공개 저장소, 집 구간 제외).
  // 작은 이동이라 반경 150m 판정은 원본과 같다. 군집이 [15:54,18:27] 2점 → 산책 3점 → 3점으로 쪼개져
  // 병합 전 분리로는 못 잡던 사례(머문 시간 가중 도입 시 실데이터에서 발견).
  const points = JSON.parse(readFileSync(new URL('./location-stays.fixture-2026-10-10.json', import.meta.url), 'utf8'));
  const stays = detectStays(points, { date: '2026-10-10' });
  const anchor = stays.find((stay) => stay.start === '2026-10-10T06:54:01.000Z');
  assert.ok(anchor);
  assert.equal(anchor.end, '2026-10-10T09:27:27.000Z');
  assert.ok(haversineM(anchor, { lat: 37.42583, lon: 129.12968 }) < 30);
  assert.equal(anchor.kind, 'stay');
  const walking = stays.filter((stay) => stay.start === anchor.end);
  assert.equal(walking.length, 1);
  assert.equal(walking[0].end, '2026-10-10T09:58:18.000Z');
  assert.equal(walking[0].kind, 'roam');
  const restaurant = stays.find((stay) => stay.start === walking[0].end);
  assert.equal(restaurant.end, '2026-10-10T10:57:02.000Z');
  assert.equal(restaurant.kind, 'stay');
  assert.equal('decisionCenter' in walking[0], false);
  const described = await describeStays(stays, { places: [], geocode: async () => '주입 주소' });
  assert.equal(described.find((stay) => stay.start === anchor.start).label, '미등록: 주입 주소');
});

test('같은 등록 장소의 긴 공백 분리는 설명 단계에서 다시 합친다', async () => {
  const stays = detectStays([point(0), point(120), point(140)], { date: undefined });
  assert.equal(stays.length, 2);
  const described = await describeStays(stays, { places: [{ name: '집', lat: 12, lon: 34 }],
    geocode: async () => { throw new Error('등록 장소 지오코딩 호출'); } });
  assert.equal(described.length, 1);
  assert.equal(described[0].pointCount, 3);
  assert.equal(described[0].dwellMs, stays[0].dwellMs + stays[1].dwellMs);
  assert.equal('splitBoundary' in described[0], false);
});

test('군집 좌표와 인접 체류 병합은 점 수가 아닌 시간으로 가중한다', () => {
  const stays = detectStays([point(0, 0, 0), point(40, 0, 0.001), point(45, 0, 0.001),
    point(60, 0, 0.01), point(70, 0, 0.0005), point(90, 0, 0.0005)]);
  assert.equal(stays.length, 2, '30분 넘는 첫 앵커는 분리한다');
  assert.ok(stays[1].lon > 0.0006, '뒤 구간 중심은 점 수보다 체류 시간으로 가중한다');
  assert.ok(stays[1].dwellMs > 0);
});

test('군집 밖 먼 다음 점과의 긴 공백은 마지막 점의 체류로 늘리지 않는다', () => {
  const stays = detectStays([point(0), point(20), point(120, 13, 35)]);
  assert.equal(stays.length, 1);
  assert.deepEqual([stays[0].start, stays[0].end],
    [new Date(point(0).tst * 1000).toISOString(), new Date(point(20).tst * 1000).toISOString()]);
});

test('가까운 다음 군집이 15분 미만이면 긴 공백의 앵커를 분리하지 않는다', () => {
  const stays = detectStays([point(0, 0, 0), point(20, 0, 0.001),
    point(120, 0, 0.002), point(125, 0, 0.002)]);
  assert.equal(stays.length, 1);
  assert.equal(stays[0].end, new Date(point(20).tst * 1000).toISOString());
});

test('자정으로 잘린 뒤 구간이 15분 미만이면 긴 공백을 분리하지 않는다', () => {
  const date = '2026-10-10';
  const nextDayPoint = (time, lon) => ({ tst: Date.parse(`2026-10-11T${time}+09:00`) / 1000, lat: 0, lon });
  const terminal = detectStays([kstPoint('22:00:00', 0, 0), kstPoint('22:20:00', 0, 0.001),
    kstPoint('23:50:00', 0, 0.002), nextDayPoint('00:10:00', 0.002)], { date });
  assert.equal(terminal[0].end, '2026-10-10T13:20:00.000Z');
  assert.equal(terminal.some((stay) => stay.start === '2026-10-10T13:20:00.000Z'), false);

  const withinCluster = detectStays([kstPoint('22:00:00', 0, 0), kstPoint('22:30:00', 0, 0),
    kstPoint('23:50:00', 0, 0), nextDayPoint('00:05:00', 0)], { date });
  assert.equal(withinCluster.length, 2, '앞의 30분 앵커는 분리한다');
  assert.equal(withinCluster.at(-1).end, '2026-10-10T15:00:00.000Z');
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
  const route = await computeRoute('2026-10-09', { root, geocode: async () => ({ buildingName: '가상 건물', address: '가상 도로 1' }) });
  assert.deepEqual([route[0].start, route[0].end], ['00:00', '24:00']);
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

test('지난 날 마지막 체류는 다음 날 같은 장소 또는 데이터 부재면 24:00, 다른 장소면 마지막 점에서 끝난다', async (t) => {
  const root = fixture(t);
  const start = Date.parse('2026-10-10T20:22:00+09:00') / 1000;
  const samePlace = [
    { tst: start, lat: 12, lon: 34 }, { tst: start + 16 * 60, lat: 12, lon: 34 },
    { tst: Date.parse('2026-10-11T08:51:00+09:00') / 1000, lat: 12, lon: 34 },
  ];
  const base = { root, dryRun: true, now: new Date('2026-10-12T00:00:00+09:00') };
  assert.equal((await computeRoute('2026-10-10', { ...base, points: samePlace }))[0].end, '24:00');
  assert.equal((await computeRoute('2026-10-10', { ...base, points: samePlace.slice(0, 2) }))[0].end, '24:00');
  const otherPlace = [...samePlace.slice(0, 2), { ...samePlace[2], lat: 13 }];
  assert.equal((await computeRoute('2026-10-10', { ...base, points: otherPlace }))[0].end, '20:38');
});

test('오늘 마지막 체류는 진행 중으로 표시한다', async (t) => {
  const root = fixture(t);
  const start = Date.parse('2026-10-11T20:22:00+09:00') / 1000;
  const route = await computeRoute('2026-10-11', { root, dryRun: true, now: new Date('2026-10-11T21:00:00+09:00'),
    points: [{ tst: start, lat: 12, lon: 34 }, { tst: start + 16 * 60, lat: 12, lon: 34 }] });
  assert.deepEqual([route[0].start, route[0].end, route[0].current], ['20:22', '', true]);
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
  assert.deepEqual(await reverseGeocode(12, 34, { key, fetchImpl }), { buildingName: '건물', address: '도로' });
  const missing = createCachedGeocoder({ root, keyPath, fetchImpl });
  assert.match((await missing(12, 34)).reason, /키 없음/);
  writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
  symlinkSync(keyPath, join(root, 'key-link'));
  assert.throws(() => readKakaoKey(join(root, 'key-link')), /링크/);
  const geocode = createCachedGeocoder({ root, keyPath, fetchImpl });
  assert.deepEqual(await geocode(12, 34), { buildingName: '건물', address: '도로' });
  assert.deepEqual(await geocode(12, 34), { buildingName: '건물', address: '도로' });
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

test('건물명은 자동 라벨로 표시하고 후보에서 제외하며 주소는 2회 방문 뒤 질문 대상이다', async (t) => {
  const buildingStay = { start: '2026-10-09T01:00:00Z', end: '2026-10-09T02:00:00Z', lat: 0, lon: 0 };
  const building = await describeStays([buildingStay], { places: [], geocode: async () => ({ buildingName: '가상 건물', address: '가상 도로 1' }) });
  assert.equal(building[0].label, '가상 건물');
  assert.equal(building[0].autoNamed, true);
  const root = fixture(t);
  assert.equal(updateCandidates({ date: '2026-10-09', stays: building, root }).candidates.length, 0);
  const address = await describeStays([buildingStay], { places: [], geocode: async () => ({ buildingName: null, address: '가상 도로 1' }) });
  assert.equal(address[0].label, '미등록: 가상 도로 1');
  updateCandidates({ date: '2026-10-09', stays: address, root });
  assert.equal(updateCandidates({ date: '2026-10-10', stays: [], root }).ready.length, 0);
  updateCandidates({ date: '2026-10-10', stays: address, root });
  assert.equal(updateCandidates({ date: '2026-10-10', stays: [], root }).ready.length, 1);
});

test('옛 문자열 지오코딩 캐시는 무효화하고 새 객체로 다시 조회한다', async (t) => {
  const root = fixture(t);
  const keyPath = join(root, 'key');
  writeFileSync(keyPath, 'secret', { mode: 0o600 });
  const cachePath = join(root, VAULT_REL.locationGeocodeCache);
  mkdirSync(join(cachePath, '..'), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ '12.0000,34.0000': '옛 주소' }));
  let calls = 0;
  const geocode = createCachedGeocoder({ root, keyPath, fetchImpl: async () => {
    calls += 1;
    return { ok: true, json: async () => ({ documents: [{ road_address: { building_name: '새 건물', address_name: '가상 도로 2' } }] }) };
  } });
  assert.deepEqual(await geocode(12, 34), { buildingName: '새 건물', address: '가상 도로 2' });
  await geocode.flush();
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8'))['12.0000,34.0000'], { buildingName: '새 건물', address: '가상 도로 2' });
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

test('후보는 날짜별 방문을 중복하지 않고 체류와 겹치는 일정만 ready에 반영', (t) => {
  const root = fixture(t);
  const stay = { lat: 12, lon: 34, address: '가상 도로 1', registered: false, start: '2026-10-09T01:00:00Z', end: '2026-10-09T02:00:00Z' };
  for (const date of ['2026-10-07', '2026-10-08', '2026-10-09']) updateCandidates({ date, stays: [stay, stay], root });
  assert.equal(readCandidates(root)[0].visits.length, 3);
  assert.equal(updateCandidates({ date: '2026-10-09', stays: [], root }).ready.length, 1);
  const secondRoot = fixture(t);
  const events = [
    { title: '겹치는 일정', start: '2026-10-09T01:30:00Z', end: '2026-10-09T02:30:00Z', allDay: false },
    { title: '같은 날 다른 시간', start: '2026-10-09T03:00:00Z', end: '2026-10-09T04:00:00Z', allDay: false },
    { title: '종일 일정', start: '2026-10-09T00:00:00Z', end: '2026-10-10T00:00:00Z', allDay: true },
    { title: '잘못된 시각', start: '오전', end: '오후', allDay: false },
  ];
  assert.equal(updateCandidates({ date: '2026-10-09', stays: [stay], events, root: secondRoot }).ready.length, 0);
  assert.deepEqual(readCandidates(secondRoot)[0].eventTitles, ['겹치는 일정']);
});

test('일정은 30분 이상 또는 일정 길이의 절반 이상 겹칠 때만 후보에 연결한다', (t) => {
  const root = fixture(t);
  const stay = { lat: 12, lon: 34, registered: false, start: '2026-10-09T06:54:00Z', end: '2026-10-09T10:57:00Z' };
  const events = [
    { title: '송도 센트럴파크 벼룩시장', start: '2026-10-09T02:00:00Z', end: '2026-10-09T07:00:00Z' },
    { title: '체류 안 공연', start: '2026-10-09T08:00:00Z', end: '2026-10-09T09:00:00Z' },
  ];
  updateCandidates({ date: '2026-10-09', stays: [stay], events, root });
  assert.deepEqual(readCandidates(root)[0].eventTitles, ['체류 안 공연']);

  const shortRoot = fixture(t);
  const shortStay = { ...stay, start: '2026-10-09T06:35:00Z', end: '2026-10-09T07:00:00Z' };
  const shortEvent = { title: '짧은 일정', start: '2026-10-09T06:30:00Z', end: '2026-10-09T06:50:00Z' };
  updateCandidates({ date: '2026-10-09', stays: [shortStay], events: [shortEvent], root: shortRoot });
  assert.deepEqual(readCandidates(shortRoot)[0].eventTitles, ['짧은 일정']);
});

test('실내 GPS 튐(점 촘촘·누적거리만 큼)은 산책이 아니고, 갈라진 같은 미등록 장소는 지오코딩 전에 다시 합친다', async () => {
  const at = (minute, lat, lon) => ({ tst: Date.parse('2026-10-10T10:00:00+09:00') / 1000 + minute * 60, lat, lon, acc: 10 });
  // 2시간 동안 5분 간격, 반경 약 25m 안에서 이리저리 튐 → 누적은 200m를 넘지만 퍼진 범위는 작다.
  const jitter = Array.from({ length: 25 }, (_, index) => at(index * 5, 10 + (index % 2) * 0.0002, 20 + (index % 3) * 0.0002));
  const stays = detectStays(jitter, { date: '2026-10-10' });
  assert.equal(stays.length, 1);
  assert.equal(stays[0].kind, 'stay');
  let geocodes = 0;
  const split = [
    { start: '2026-10-10T01:00:00.000Z', end: '2026-10-10T02:00:00.000Z', lat: 10, lon: 20, kind: 'stay', dwellMs: 3_600_000, pointCount: 2 },
    { start: '2026-10-10T02:00:00.000Z', end: '2026-10-10T02:40:00.000Z', lat: 10.0003, lon: 20, kind: 'stay', dwellMs: 2_400_000, pointCount: 3, splitBoundary: true },
  ];
  const described = await describeStays(split, { places: [], geocode: async () => { geocodes += 1; return { address: '가상 주소' }; } });
  assert.equal(described.length, 1);
  assert.equal(described[0].end, '2026-10-10T02:40:00.000Z');
  assert.equal(geocodes, 1, '합친 뒤 한 번만 조회');
});
