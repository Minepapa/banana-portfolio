import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { groupMoments, describeMoment, runMediaMoments, visionForMoment, loadVideoPeople } from './media-moments.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { parseFrontmatter, updateFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { buildMemo } from '../tools/inbox-memo.mjs';
import { linkPhotoMemos, matchPhotoMemo } from './media-photo-memos.mjs';

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
  const options = { root, videoPeoplePath: join(root, 'video-matches.jsonl'), registryRules: rules,
    routePoints: () => [], paymentsForDay: () => [],
    places: [], geocode: Object.assign(async () => null, { flush: async () => {} }),
    write: (path, content) => { writes.push(path); writeAtomic(path, content); }, output: silent,
    now: '2030-01-03T00:00:00.000Z' };
  return { root, index, writes, options };
}

test('순간 노트 영상 이름표는 오너 확인을 읽어 people에 반영한다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'media-moments-video-answer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sheetsPath = join(root, 'sheets');
  mkdirSync(sheetsPath);
  const videoPeoplePath = join(root, 'video-matches.jsonl');
  writeFileSync(videoPeoplePath, `${JSON.stringify({ id: 'a', people: [], hold: ['미네'],
    representatives: { 미네: { timestampSec: 4 } } })}\n`);
  writeFileSync(join(sheetsPath, 'video-hold-review-2030-01.json'), JSON.stringify({ videoAnswers: [
    { id: 'a', person: '미네', timestampSec: 4, confirmedPerson: true },
  ] }));
  assert.deepEqual(loadVideoPeople(videoPeoplePath, silent, sheetsPath).a,
    { people: ['미네'], hold: [] });
});

test('Vision 장면은 한국어 표·ignore·신뢰도와 등장 사진 수 순으로 고른다', () => {
  const records = [item('a', time('10:00')), item('b', time('10:01'))];
  const rows = new Map([
    ['a', { schema: 2, faces: 1, labels: [{ name: 'beach', confidence: 0.9 },
      { name: 'cake', confidence: 0.8 }, { name: 'unknown', confidence: 0.99 }] }],
    ['b', { schema: 2, faces: 3, labels: [{ name: 'beach', confidence: 0.4 },
      { name: 'adult', confidence: 0.99 }, { name: 'flower', confidence: 0.2 }] }],
  ]);
  assert.deepEqual(visionForMoment(records, rows, { labels: { beach: '해변', cake: '케이크',
    adult: '어른', flower: '꽃' }, ignore: ['adult'], minConfidence: 0.3 }),
  { scenes: ['해변', '케이크'], faces: 3, allPhotosAnalyzed: true });
});

test('Vision 보강은 제목을 이동하고 장면·얼굴을 기록하며 재실행은 쓰지 않는다', async (t) => {
  const f = fixture(t, [item('a', time('10:00'))]);
  await runMediaMoments(f.options);
  const statePath = join(f.root, VAULT_REL.mediaMomentsState);
  const before = JSON.parse(readFileSync(statePath, 'utf8')).a.notePath;
  const visionIndex = join(f.root, VAULT_REL.mediaVisionIndex);
  const labels = join(f.root, VAULT_REL.mediaVisionLabels);
  writeFileSync(visionIndex, `${JSON.stringify({ id: 'a', schema: 2, labels: [{ name: 'cake', confidence: 0.9 }], faces: 2 })}\n`);
  writeFileSync(labels, JSON.stringify({ labels: { cake: '케이크' }, ignore: [] }));
  const updated = await runMediaMoments(f.options);
  const after = JSON.parse(readFileSync(statePath, 'utf8')).a.notePath;
  assert.equal(updated.updated, 1);
  assert.match(after, /케이크 아침 순간/);
  assert.notEqual(after, before);
  const note = readFileSync(join(f.root, after), 'utf8');
  assert.deepEqual(parseFrontmatter(note).scenes, ['케이크']);
  assert.equal(parseFrontmatter(note).faces, 2);
  assert.deepEqual(parseFrontmatter(note).movedFrom, [before]);
  assert.match(note, /- 장면: 케이크/);
  assert.match(note, /- 장소·활동: 아침/);
  assert.doesNotMatch(note, /- 장소·활동: 케이크/);
  assert.equal(parseFrontmatter(note).titleScene, '케이크');
  assert.match(note, /# 2030-01-02 케이크 아침 순간/);
  assert.equal(parseFrontmatter(note).description, '2030-01-02 케이크 아침 순간');
  writeFileSync(labels, JSON.stringify({ labels: { cake: '파티' } }));
  await runMediaMoments(f.options);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).a.notePath, after);
  const writes = f.writes.length;
  assert.equal((await runMediaMoments(f.options)).skipped, 1);
  assert.equal(f.writes.length, writes);
});

test('사진 하나가 미분석이면 제목에는 장면을 넣지 않는다', async (t) => {
  const f = fixture(t, [item('a', time('10:00')), item('b', time('10:01'))]);
  writeFileSync(join(f.root, VAULT_REL.mediaVisionIndex), `${JSON.stringify({ id: 'a', schema: 2,
    labels: [{ name: 'cake', confidence: 0.9 }] })}\n`);
  writeFileSync(join(f.root, VAULT_REL.mediaVisionLabels), JSON.stringify({ labels: { cake: '케이크' } }));
  await runMediaMoments(f.options);
  const rel = JSON.parse(readFileSync(join(f.root, VAULT_REL.mediaMomentsState), 'utf8')).a.notePath;
  assert.doesNotMatch(rel, /케이크/);
  assert.deepEqual(parseFrontmatter(readFileSync(join(f.root, rel), 'utf8')).scenes, ['케이크']);
});

test('기존 titleScene이 있어도 새 사진이 미분석이면 제목과 titleScene을 지운다', async (t) => {
  const f = fixture(t, [item('a', time('10:00'))]);
  const visionIndex = join(f.root, VAULT_REL.mediaVisionIndex);
  writeFileSync(visionIndex, `${JSON.stringify({ id: 'a', schema: 2,
    labels: [{ name: 'cake', confidence: 0.9 }] })}\n`);
  writeFileSync(join(f.root, VAULT_REL.mediaVisionLabels), JSON.stringify({ labels: { cake: '케이크' } }));
  await runMediaMoments(f.options);
  const statePath = join(f.root, VAULT_REL.mediaMomentsState);
  const oldRel = JSON.parse(readFileSync(statePath, 'utf8')).a.notePath;
  assert.match(oldRel, /케이크/);
  writeFileSync(f.index, [item('a', time('10:00')), item('b', time('10:01'))]
    .map((record) => JSON.stringify(record)).join('\n') + '\n');
  await runMediaMoments(f.options);
  const rel = JSON.parse(readFileSync(statePath, 'utf8')).a.notePath;
  assert.doesNotMatch(rel, /케이크/);
  assert.equal(parseFrontmatter(readFileSync(join(f.root, rel), 'utf8')).titleScene, undefined);
  assert.deepEqual(parseFrontmatter(readFileSync(join(f.root, rel), 'utf8')).scenes, ['케이크']);
});

test('schema 없는 레거시 행은 미분석으로 간주한다', () => {
  const result = visionForMoment([item('a', time('10:00'))], new Map([['a', {
    labels: [{ name: 'cake', confidence: 0.9 }], faces: 3 }]]),
  { labels: { cake: '케이크' }, ignore: [], minConfidence: 0.3 });
  assert.deepEqual(result, { scenes: [], faces: 0, allPhotosAnalyzed: false });
});

test('깨진 vision 설정은 보강만 끄고 순간 노트를 만든다', async (t) => {
  const f = fixture(t, [item('a', time('10:00'))]);
  writeFileSync(join(f.root, VAULT_REL.mediaVisionIndex), `${JSON.stringify({ id: 'a', schema: 2 })}\n`);
  writeFileSync(join(f.root, VAULT_REL.mediaVisionLabels), JSON.stringify({ labels: [], ignore: {} }));
  const logs = [];
  await runMediaMoments({ ...f.options, output: { log: (line) => logs.push(line) } });
  assert.equal(logs.filter((line) => line.startsWith('[media-moments] vision 설정 오류:')).length, 1);
  assert.equal(existsSync(join(f.root, VAULT_REL.mediaMomentsState)), true);
});

test('기존 장면 제목은 vision 설정이 깨져도 유지한다', async (t) => {
  const f = fixture(t, [item('a', time('10:00'))]);
  const visionIndex = join(f.root, VAULT_REL.mediaVisionIndex);
  const labels = join(f.root, VAULT_REL.mediaVisionLabels);
  writeFileSync(visionIndex, `${JSON.stringify({ id: 'a', schema: 2,
    labels: [{ name: 'cake', confidence: 0.9 }] })}\n`);
  writeFileSync(labels, JSON.stringify({ labels: { cake: '케이크' } }));
  await runMediaMoments(f.options);
  const statePath = join(f.root, VAULT_REL.mediaMomentsState);
  const rel = JSON.parse(readFileSync(statePath, 'utf8')).a.notePath;
  writeFileSync(labels, '{broken');
  const logs = [];
  const result = await runMediaMoments({ ...f.options, output: { log: (line) => logs.push(line) } });
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).a.notePath, rel);
  assert.equal(parseFrontmatter(readFileSync(join(f.root, rel), 'utf8')).titleScene, '케이크');
  assert.equal(result.updated + result.skipped, 1);
  assert.equal(logs.filter((line) => line.startsWith('[media-moments] vision 설정 오류:')).length, 1);
});

test('90분과 1.5km 경계에서 순간을 나눈다', () => {
  const records = [item('a', time('10:00')), item('b', time('11:30')),
    item('c', time('11:31'), { lat: 0, lon: 0.014 }), item('d', time('13:02'))];
  assert.deepEqual(groupMoments(records).map((moment) => moment.map((record) => record.id)), [['a', 'b'], ['c'], ['d']]);
});

test('Camera와 EXIF 촬영 시각이 확인된 KakaoTalk 사진만 순간으로 묶는다', () => {
  const camera = item('camera', time('10:00'));
  const kakao = (id, capturedFrom, capturedConfidence) => ({ ...item(id, time('10:10')),
    kind: 'KakaoTalk', archivePath: `Archive/2030/01/KakaoTalk/item-${id}.jpg`,
    capturedFrom, capturedConfidence });
  const records = [camera, { ...camera, id: 'camera-estimated', capturedConfidence: 'estimated' },
    kakao('confirmed', 'exif', 'confirmed'), kakao('single', 'exif', 'single'),
    kakao('estimated', 'exif', 'estimated'), kakao('review', 'exif', 'review'),
    kakao('missing-confidence', 'exif'), kakao('missing-source', undefined, 'confirmed'),
    kakao('non-exif', 'filename', 'confirmed'),
    { ...item('call', time('10:20')), kind: 'Calls', capturedFrom: 'exif', capturedConfidence: 'confirmed' }];
  assert.deepEqual(groupMoments(records).map((moment) => moment.map((record) => record.id)),
    [['camera', 'camera-estimated', 'confirmed', 'single']]);
});

test('KakaoTalkMovie는 EXIF 시각이 확인된 경우만 순간에 포함한다', () => {
  const movie = (id, capturedFrom, capturedConfidence) => ({ ...item(id, time('10:10')),
    kind: 'KakaoTalkMovie', archivePath: `Archive/2030/01/KakaoTalkMovie/item-${id}.mp4`,
    capturedFrom, capturedConfidence });
  const records = [movie('confirmed', 'exif', 'confirmed'), movie('single', 'exif', 'single'),
    movie('estimated', 'filename', 'estimated'), movie('review', 'exif', 'review'),
    movie('no-source', undefined, 'confirmed')];

  assert.deepEqual(groupMoments(records).map((moment) => moment.map((record) => record.id)),
    [['confirmed', 'single']]);
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
  assert.equal(unknown.summary, '아침');
  const registered = await describeMoment(records, { root: '/unused', dryRun: false,
    routePoints: () => [], paymentsForDay: () => [{ at: time('10:00'), merchant: '가상 상점' }],
    places: [{ name: '등록 장소', lat: 0, lon: 0 }], geocode: async () => { throw new Error('지오코더 호출'); } });
  assert.equal(registered.place, '등록 장소');
  assert.equal(registered.source, 'gps');
  const payment = await describeMoment([{ ...records[0], gps: undefined }], { root: '/unused', dryRun: true,
    routePoints: () => [], paymentsForDay: () => [{ at: time('10:00'), merchant: '가상 상점' }], places: [] });
  assert.equal(payment.source, 'payment');
});

test('미등록 주소는 짧은 제목으로 쓰고 전체 주소를 분리한다', async (t) => {
  const { root, options } = fixture(t, [item('a', time('10:00'))]);
  const address = '서울특별시 강서구 공항대로 165';
  await runMediaMoments({ ...options, routePoints: () => [{ tst: 1 }],
    routeForDay: async () => [{ kind: 'stay', startAt: time('09:00'), endAt: time('11:00'),
      label: `미등록: ${address}`, address }] });
  const state = JSON.parse(readFileSync(join(root, VAULT_REL.mediaMomentsState), 'utf8'));
  const note = readFileSync(join(root, state.a.notePath), 'utf8');
  assert.match(state.a.notePath, /강서구 공항대로 일대 순간\.md$/);
  assert.doesNotMatch(note, /미등록/);
  assert.match(note, /place: "서울특별시 강서구 공항대로 165"/);
  assert.match(note, /address: "서울특별시 강서구 공항대로 165"/);
  assert.match(note, /- 장소·활동: 강서구 공항대로 일대\n- 주소: 서울특별시 강서구 공항대로 165/);
});

test('동선 장소·활동과 GPS 주소를 본문과 머리말에 나누어 쓴다', async (t) => {
  const { root, options } = fixture(t, [item('a', time('10:00'))]);
  await runMediaMoments({ ...options, routePoints: () => [{ tst: 1 }],
    routeForDay: async () => [{ kind: 'stay', startAt: time('09:00'), endAt: time('11:00'),
      label: '이집트경양식 본점', placeName: '이집트경양식 본점', activity: '식사',
      address: '가상시 가상구 가상로 1' }] });
  const state = JSON.parse(readFileSync(join(root, VAULT_REL.mediaMomentsState), 'utf8'));
  const note = readFileSync(join(root, state.a.notePath), 'utf8');
  assert.match(note, /place: "이집트경양식 본점"/);
  assert.match(note, /address: "가상시 가상구 가상로 1"/);
  assert.match(note, /- 장소·활동: 이집트경양식 본점 · 식사\n- 주소: 가상시 가상구 가상로 1/);
  assert.match(note, /created: "2030-01-03"\nmodified: "2030-01-03"/);
  assert.match(note, /startAt: "2030-01-02T10:00:00\+09:00"/);
});

test('GPS 지오코더 건물명과 주소를 분리한다', async (t) => {
  const { root, options } = fixture(t, [item('a', time('10:00'))]);
  await runMediaMoments({ ...options, geocode: Object.assign(async () => ({ buildingName: '가상 식당',
    address: '가상시 가상구 가상로 1' }), { flush: async () => {} }) });
  const state = JSON.parse(readFileSync(join(root, VAULT_REL.mediaMomentsState), 'utf8'));
  const note = readFileSync(join(root, state.a.notePath), 'utf8');
  assert.match(note, /place: "가상 식당"/);
  assert.match(note, /address: "가상시 가상구 가상로 1"/);
  assert.match(note, /- 장소·활동: 가상 식당\n- 주소: 가상시 가상구 가상로 1/);
});

test('시각만 있는 순간은 여섯 시간대 이름을 제목에 쓴다', async () => {
  for (const [hour, period] of [[0, '새벽'], [6, '아침'], [11, '낮'], [14, '오후'],
    [18, '저녁'], [22, '밤']]) {
    const record = item(String(hour), time(`${String(hour).padStart(2, '0')}:00`));
    const result = await describeMoment([record], { root: '/unused', dryRun: true,
      routePoints: () => [], paymentsForDay: () => [], places: [] });
    assert.equal(result.summary, period);
    assert.equal(result.source, 'time');
  }
});

test('기존 노트 제목이 바뀌면 메모와 이전 경로를 보존하며 상태 경로를 갱신한다', async (t) => {
  const { root, options } = fixture(t, [item('a', time('10:00'))]);
  await runMediaMoments(options);
  const statePath = join(root, VAULT_REL.mediaMomentsState);
  const oldRel = JSON.parse(readFileSync(statePath, 'utf8')).a.notePath;
  writeFileSync(join(root, oldRel), `${readFileSync(join(root, oldRel), 'utf8')}오너 메모\n`);
  const named = { ...options, now: '2030-01-04T00:00:00.000Z', routePoints: () => [{ tst: 1 }],
    routeForDay: async () => [{ kind: 'stay', startAt: time('09:00'), endAt: time('11:00'),
      label: '가상 식당', placeName: '가상 식당', activity: '식사' }] };
  assert.equal((await runMediaMoments(named)).updated, 1);
  const newRel = JSON.parse(readFileSync(statePath, 'utf8')).a.notePath;
  assert.notEqual(newRel, oldRel);
  assert.equal(existsSync(join(root, oldRel)), false);
  const note = readFileSync(join(root, newRel), 'utf8');
  assert.match(note, /오너 메모/);
  assert.match(note, /created: "2030-01-03"\nmodified: "2030-01-04"/);
  assert.deepEqual(parseFrontmatter(note).movedFrom, [oldRel]);
  assert.equal((await runMediaMoments(named)).skipped, 1);
});

test('노트 이동 뒤 상태 쓰기가 중단돼도 다음 실행에서 새 경로를 찾는다', async (t) => {
  const { root, options } = fixture(t, [item('a', time('10:00'))]);
  await runMediaMoments(options);
  const statePath = join(root, VAULT_REL.mediaMomentsState);
  const oldRel = JSON.parse(readFileSync(statePath, 'utf8')).a.notePath;
  const named = { ...options, routePoints: () => [{ tst: 1 }],
    routeForDay: async () => [{ kind: 'stay', startAt: time('09:00'), endAt: time('11:00'),
      label: '가상 식당', placeName: '가상 식당' }] };
  await assert.rejects(runMediaMoments({ ...named, write: (path, content) => {
    if (path === statePath) throw new Error('상태 쓰기 중단');
    writeAtomic(path, content);
  } }), /상태 쓰기 중단/);
  assert.equal(existsSync(join(root, oldRel)), false);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).a.notePath, oldRel);
  assert.equal((await runMediaMoments(named)).skipped, 1);
  const newRel = JSON.parse(readFileSync(statePath, 'utf8')).a.notePath;
  assert.notEqual(newRel, oldRel);
  assert.deepEqual(parseFrontmatter(readFileSync(join(root, newRel), 'utf8')).movedFrom, [oldRel]);
});

test('파일명 이동 직후 노트 쓰기가 중단돼도 이전 경로를 복구한다', async (t) => {
  const { root, options } = fixture(t, [item('a', time('10:00'))]);
  await runMediaMoments(options);
  const statePath = join(root, VAULT_REL.mediaMomentsState);
  const oldRel = JSON.parse(readFileSync(statePath, 'utf8')).a.notePath;
  const named = { ...options, routePoints: () => [{ tst: 1 }],
    routeForDay: async () => [{ kind: 'stay', startAt: time('09:00'), endAt: time('11:00'),
      label: '가상 식당', placeName: '가상 식당' }] };
  await assert.rejects(runMediaMoments({ ...named, write: (path, content) => {
    if (path !== statePath) throw new Error('노트 쓰기 중단');
    writeAtomic(path, content);
  } }), /노트 쓰기 중단/);
  assert.equal(existsSync(join(root, oldRel)), false);
  assert.equal((await runMediaMoments(named)).updated, 1);
  const newRel = JSON.parse(readFileSync(statePath, 'utf8')).a.notePath;
  assert.deepEqual(parseFrontmatter(readFileSync(join(root, newRel), 'utf8')).movedFrom, [oldRel]);
});

test('기존 ISO 생성일을 날짜로 보정한다', async (t) => {
  const { root, options } = fixture(t, [item('a', time('10:00'))]);
  await runMediaMoments(options);
  const state = JSON.parse(readFileSync(join(root, VAULT_REL.mediaMomentsState), 'utf8'));
  const path = join(root, state.a.notePath);
  writeFileSync(path, readFileSync(path, 'utf8').replace('created: "2030-01-03"',
    'created: "2030-01-03T00:00:00.000Z"'));
  assert.equal((await runMediaMoments(options)).updated, 1);
  assert.equal(parseFrontmatter(readFileSync(path, 'utf8')).created, '2030-01-03');
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

test('📎 지문은 30일 창·거리·2등 간격을 통과해야 하고 연결은 멱등이며 오너 메모를 보존한다', async (t) => {
  const f = fixture(t, [item('a', time('10:00'))]);
  await runMediaMoments(f.options);
  const state = JSON.parse(readFileSync(join(f.root, VAULT_REL.mediaMomentsState), 'utf8'));
  const momentRel = state.a.notePath;
  const momentPath = join(f.root, momentRel);
  writeFileSync(momentPath, readFileSync(momentPath, 'utf8').replace('## 오너 메모\n\n', '## 오너 메모\n\n원래 내 글\n'));
  const printsPath = join(f.root, 'prints');
  mkdirSync(printsPath);
  const print = (id, values) => {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
    writeFileSync(join(printsPath, `${id}.f32`), bytes);
  };
  print('memo-test', [0, 0]);
  print('a', [0.1, 0]);
  print('b', [0.15, 0]);
  const archive = [item('a', time('10:00')), item('b', time('09:00'))];
  const vision = new Map(['a', 'b'].map((id) => [id, { id, schema: 2, source: 'archive', printDims: 2 }]));
  const fields = { photoPrint: 'memo-test', capturedAt: '2030-01-03T09:00+09:00' };
  const config = { memoMatchDistance: 0.35, memoMatchMargin: 0.1 };
  assert.equal(matchPhotoMemo(fields, archive, vision, { printsPath, config }), null);
  assert.equal(matchPhotoMemo(fields, archive, new Map([
    ['a', { ...vision.get('a'), duplicateGroup: 'same' }],
    ['b', { ...vision.get('b'), duplicateGroup: 'same' }],
  ]), { printsPath, config }).id, 'a');
  assert.equal(matchPhotoMemo(fields, archive, vision, { printsPath, config,
    momentByPhoto: new Map([['a', 'same-moment'], ['b', 'same-moment']]) }).id, 'a');
  assert.equal(matchPhotoMemo(fields, [archive[0]], vision, { printsPath, config }).id, 'a');
  assert.equal(matchPhotoMemo(fields, [{ ...archive[0], capturedAt: '2029-12-03T09:00+09:00' }], vision,
    { printsPath, config }), null);
  assert.equal(matchPhotoMemo(fields, [{ ...archive[0], capturedAt: '2030-01-04T09:00+09:00' }], vision,
    { printsPath, config }), null);
  assert.equal(matchPhotoMemo(fields, [archive[0]], vision,
    { printsPath, config: { memoMatchDistance: 0.05, memoMatchMargin: 0.1 } }), null);
  const inbox = join(f.root, VAULT_REL.inboxRoot);
  mkdirSync(inbox);
  const memoRel = `${VAULT_REL.inboxRoot}/📎.md`;
  const memoPath = join(f.root, memoRel);
  writeFileSync(memoPath, buildMemo('그날', { kind: '사진메모', now: new Date('2030-01-03T00:00:00Z'),
    photoPrint: 'memo-test', photoMatchUntil: '2030-02-02' }));
  const visionPath = join(f.root, VAULT_REL.mediaVisionIndex);
  writeFileSync(visionPath, `${JSON.stringify(vision.get('a'))}\n`);
  const options = { root: f.root, state, archive: [archive[0]], printsPath, now: '2030-01-03T00:00:00Z',
    registryRules: rules, output: silent };
  assert.deepEqual(await linkPhotoMemos({ ...options, state: {} }), { linked: 0, expired: 0, failed: 0 });
  assert.equal(parseFrontmatter(readFileSync(memoPath, 'utf8')).photoLink, '대기');
  assert.deepEqual(await linkPhotoMemos(options), { linked: 1, expired: 0, failed: 0 });
  const linked = readFileSync(memoPath, 'utf8');
  assert.equal(parseFrontmatter(linked).photoMatchedId, 'a');
  assert.equal(parseFrontmatter(linked).photoLink, `[[${momentRel.slice(0, -3)}]]`);
  assert.equal(parseFrontmatter(linked).photoMatchDistance, 0.1);
  const moment = readFileSync(momentPath, 'utf8');
  assert.deepEqual(parseFrontmatter(moment).memos, [`[[${memoRel.slice(0, -3)}]]`]);
  assert.match(moment, /- 📎 메모: \[\[00_Inbox\/📎\]\]/);
  assert.match(moment, /## 오너 메모\n\n원래 내 글/);
  assert.deepEqual(await linkPhotoMemos(options), { linked: 0, expired: 0, failed: 0 });
  await runMediaMoments(f.options);
  const rerendered = readFileSync(momentPath, 'utf8');
  assert.equal(rerendered.match(/- 📎 메모:/g).length, 1);
  assert.match(rerendered, /## 오너 메모\n\n원래 내 글/);
  const secondRel = `${VAULT_REL.inboxRoot}/두번째-$&-$$.md`;
  const secondPath = join(f.root, secondRel);
  print('memo-test', [0, 0]);
  writeFileSync(secondPath, buildMemo('다른 메모', { kind: '사진메모', now: new Date('2030-01-03T00:00:00Z'),
    photoPrint: 'memo-test', photoMatchUntil: '2030-02-02' }));
  assert.deepEqual(await linkPhotoMemos(options), { linked: 1, expired: 0, failed: 0 });
  assert.equal(readFileSync(momentPath, 'utf8').match(/- 📎 메모:/g).length, 2);
  writeFileSync(visionPath, `${JSON.stringify({ ...vision.get('a'),
    labels: [{ name: 'cake', confidence: 0.9 }] })}\n`);
  writeFileSync(join(f.root, VAULT_REL.mediaVisionLabels), JSON.stringify({ labels: { cake: '케이크' } }));
  await runMediaMoments(f.options);
  const movedState = JSON.parse(readFileSync(join(f.root, VAULT_REL.mediaMomentsState), 'utf8'));
  const movedRel = movedState.a.notePath;
  assert.notEqual(movedRel, momentRel);
  for (const path of [memoPath, secondPath]) {
    assert.equal(parseFrontmatter(readFileSync(path, 'utf8')).photoLink, `[[${movedRel.slice(0, -3)}]]`);
  }
  const movedMoment = readFileSync(join(f.root, movedRel), 'utf8');
  assert.equal(movedMoment.match(/- 📎 메모:/g).length, 2);
  assert.match(movedMoment, /## 오너 메모\n\n원래 내 글/);
  const linkedWrites = f.writes.length;
  await runMediaMoments(f.options);
  assert.equal(f.writes.length, linkedWrites);
  const movedMemoRel = `${VAULT_REL.recordsNotes}/2030/2030-01-03 두번째-$&-$$.md`;
  const movedMemoPath = join(f.root, movedMemoRel);
  mkdirSync(dirname(movedMemoPath), { recursive: true });
  renameSync(secondPath, movedMemoPath);
  const movedMemo = readFileSync(movedMemoPath, 'utf8');
  writeFileSync(movedMemoPath, movedMemo.replace(/^---\n[\s\S]*?\n---\n/,
    () => updateFrontmatter(movedMemo, { movedFrom: [secondRel.slice(0, -3)], type: 'note', category: '[[01_Home/100 나]]',
      description: '다른 메모', modified: '2030-01-03', occurred: '2030-01-03T09:00+09:00' })));
  assert.deepEqual(await linkPhotoMemos({ ...options, state: movedState, registryRules: null }),
    { linked: 1, expired: 0, failed: 0 });
  const relinkedMoment = readFileSync(join(f.root, movedRel), 'utf8');
  assert.deepEqual(parseFrontmatter(relinkedMoment).memos.sort(),
    [`[[${memoRel.slice(0, -3)}]]`, `[[${movedMemoRel.slice(0, -3)}]]`].sort());
  assert.doesNotMatch(relinkedMoment, /\[\[00_Inbox\/두번째-\$&-\$\$\]\]/);
  assert.equal(relinkedMoment.match(/- 📎 메모:/g).length, 2);
  assert.match(relinkedMoment, /## 오너 메모\n\n원래 내 글/);
  assert.deepEqual(await linkPhotoMemos({ ...options, state: movedState, registryRules: null }),
    { linked: 0, expired: 0, failed: 0 });
  await runMediaMoments(f.options);
  assert.equal(readFileSync(join(f.root, movedRel), 'utf8').match(/- 📎 메모:/g).length, 2);
  const pendingPath = join(inbox, 'invalid-config.md');
  writeFileSync(pendingPath, buildMemo('설정 오류 대기', { kind: '사진메모', now: new Date('2030-01-03T00:00:00Z'),
    photoPrint: 'memo-test', photoMatchUntil: '2030-02-02' }));
  writeFileSync(join(f.root, VAULT_REL.mediaVisionLabels), '{invalid');
  const configLogs = [];
  assert.deepEqual(await linkPhotoMemos({ ...options, state: movedState, output: { log: (line) => configLogs.push(line) } }),
    { linked: 0, expired: 0, failed: 0 });
  assert.equal(configLogs.length, 1);
  assert.match(configLogs[0], /vision 설정 오류/);
  assert.equal(parseFrontmatter(readFileSync(pendingPath, 'utf8')).photoLink, '대기');
  rmSync(pendingPath);
  writeFileSync(join(f.root, VAULT_REL.mediaVisionLabels), JSON.stringify({ labels: { cake: '케이크' } }));
  const movedDir = join(f.root, VAULT_REL.recordsNotes, '2030');
  mkdirSync(movedDir, { recursive: true });
  const expiredPath = join(movedDir, '2030-01-01 expired.md');
  writeFileSync(expiredPath, buildMemo('못 찾은 사진', { kind: '사진메모', now: new Date('2030-01-01T00:00:00Z'),
    photoPrint: 'memo-test', photoMatchUntil: '2030-01-31' }));
  assert.deepEqual(await linkPhotoMemos({ ...options, state: movedState, registryRules: null,
    now: '2030-02-02T00:00:00Z' }), { linked: 0, expired: 1, failed: 0 });
  assert.equal(parseFrontmatter(readFileSync(expiredPath, 'utf8')).photoLink, '못 찾음');
});

test('사진 메모 하나의 쓰기 실패를 기록하고 다음 메모 만료와 순간 잡을 계속한다', async (t) => {
  const f = fixture(t, [item('a', time('10:00'))]);
  await runMediaMoments(f.options);
  const inbox = join(f.root, VAULT_REL.inboxRoot);
  mkdirSync(inbox);
  const bad = join(inbox, 'a-bad.md');
  const good = join(inbox, 'b-good.md');
  for (const path of [bad, good]) writeFileSync(path, buildMemo('사진', {
    kind: '사진메모', now: new Date('2030-01-01T00:00:00Z'), photoMatchUntil: '2030-01-31' }));
  const logs = [];
  const options = { ...f.options, state: {}, archive: [], now: '2030-02-02T00:00:00Z',
    registryRules: null, output: { log: (line) => logs.push(line) },
    write: (path, content) => { if (path === bad) throw new Error('가상 쓰기 실패\nprivate stderr'); writeAtomic(path, content); } };
  assert.deepEqual(await linkPhotoMemos(options), { linked: 0, expired: 1, failed: 1 });
  assert.equal(parseFrontmatter(readFileSync(good, 'utf8')).photoLink, '못 찾음');
  assert.ok(logs.some((line) => /^\[media-photo-memos\] 실패: 00_Inbox\/a-bad.md — 가상 쓰기 실패$/.test(line)));
  const result = await runMediaMoments({ ...f.options, now: '2030-02-02T00:00:00Z', output: options.output,
    write: options.write });
  assert.equal(result.skipped, 1);
});

test('linkPhotoMemos: Inbox·Notes 폴더가 없으면 실패 로그 없이 0건(2026-10-23)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'photo-memos-noinbox-'));
  const logs = [];
  try {
    assert.deepEqual(await linkPhotoMemos({ root, state: {}, archive: [], dryRun: true, output: { log: (m) => logs.push(m) } }),
      { linked: 0, expired: 0, failed: 0 });
    assert.equal(logs.filter((m) => m.includes('실패')).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
