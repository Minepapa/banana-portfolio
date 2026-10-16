import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { indexImports, groupImportMoments, runImportMoments, isDomesticGps, anniversariesForDay, calendarOccasions, selectOccasions } from './media-imports.mjs';

function fixture(t, albums = { A: { label: '미네', category: '201 미네', priority: 2, years: [2017, 2017] },
  B: { label: null, category: '100 나', priority: 1 } }) {
  const base = mkdtempSync(join(tmpdir(), 'media-imports-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const mediaRoot = join(base, 'media');
  mkdirSync(join(mediaRoot, 'Imports'), { recursive: true });
  mkdirSync(root);
  const albumsPath = join(root, VAULT_REL.mediaImportAlbums);
  mkdirSync(dirname(albumsPath), { recursive: true });
  writeFileSync(albumsPath, JSON.stringify({ albums }));
  const output = { log() {} };
  const metadataForFiles = async (files) => new Map(files.map((file) => [file.path,
    { DateTimeOriginal: file.path.includes('190000') ? '2017:05:03 19:00:00' : '2017:05:03 15:00:00' }]));
  const geocode = Object.assign(async () => null, { flush: async () => {} });
  const registryRules = [{ type: 'media', path: `${VAULT_REL.mediaMoments}/{YYYY}/`,
    pathRegex: /^20_Records\/24_Media\/\d{4}\/[^/]+\.md$/,
    titleRegex: /^\d{4}-\d{2}-\d{2} \S/,
    required: { bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'],
      extra: ['occurred', 'origin', 'mediaCount'] } }];
  function add(album, name, content) {
    const directory = join(mediaRoot, 'Imports', album);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, name);
    writeFileSync(path, content);
    return path;
  }
  const records = () => readFileSync(join(root, VAULT_REL.mediaImportsIndex), 'utf8').trim().split('\n').map(JSON.parse);
  return { root, mediaRoot, add, records, output, metadataForFiles, geocode, registryRules,
    videoPeoplePath: join(base, 'video-matches.jsonl'), noCalendar: true };
}

test('Imports Vision 장면은 이름표 뒤 시간대 앞에 넣고 장소·기념일 제목은 유지한다', async (t) => {
  const f = fixture(t);
  f.add('A', 'IMG_20170503_150000.jpg', 'one');
  await indexImports({ ...f, hash: async () => 'one' });
  await runImportMoments({ ...f, places: [] });
  const statePath = join(f.root, VAULT_REL.mediaImportMomentsState);
  const oldRel = JSON.parse(readFileSync(statePath, 'utf8')).one.notePath;
  writeFileSync(join(f.root, VAULT_REL.mediaVisionIndex), `${JSON.stringify({ id: 'one', schema: 2,
    labels: [{ name: 'cake', confidence: 0.8 }], faces: 1 })}\n`);
  writeFileSync(join(f.root, VAULT_REL.mediaVisionLabels), JSON.stringify({ labels: { cake: '케이크' } }));
  const result = await runImportMoments({ ...f, places: [] });
  const newRel = JSON.parse(readFileSync(statePath, 'utf8')).one.notePath;
  assert.equal(result.updated, 1);
  assert.match(newRel, /미네 케이크 오후 순간/);
  const visionNote = readFileSync(join(f.root, newRel), 'utf8');
  assert.deepEqual(parseFrontmatter(visionNote).movedFrom, [oldRel]);
  assert.equal(parseFrontmatter(visionNote).titleScene, '케이크');
  assert.match(visionNote, /# 2017-05-03 미네 케이크 오후 순간/);
  assert.equal(parseFrontmatter(visionNote).description, '2017-05-03 미네 케이크 오후 순간');
  assert.match(visionNote, /- 장소·활동: 미네 오후/);
  assert.doesNotMatch(visionNote, /- 장소·활동: 미네 케이크/);
  assert.equal((await runImportMoments({ ...f, places: [] })).skipped, 1);
  writeFileSync(join(f.root, VAULT_REL.mediaVisionLabels), JSON.stringify({ labels: { cake: '케이크/파티' } }));
  await runImportMoments({ ...f, places: [] });
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).one.notePath, newRel);
  const rows = f.records();
  rows[0].gps = { lat: 37, lon: 127 };
  writeFileSync(join(f.root, VAULT_REL.mediaImportsIndex), `${JSON.stringify(rows[0])}\n`);
  await runImportMoments({ ...f, places: [{ lat: 37, lon: 127, name: '집', radius: 150 }] });
  const withPlace = JSON.parse(readFileSync(statePath, 'utf8')).one.notePath;
  assert.match(withPlace, /미네 · 집 순간/);
  assert.doesNotMatch(withPlace, /케이크/);
});

test('Imports 기존 titleScene 뒤 미분석 사진이 추가되면 장면 없는 제목으로 이동한다', async (t) => {
  const f = fixture(t);
  f.add('A', 'IMG_20170503_150000.jpg', 'one');
  await indexImports({ ...f, hash: async () => 'one' });
  writeFileSync(join(f.root, VAULT_REL.mediaVisionIndex), `${JSON.stringify({ id: 'one', schema: 2,
    labels: [{ name: 'cake', confidence: 0.8 }] })}\n`);
  writeFileSync(join(f.root, VAULT_REL.mediaVisionLabels), JSON.stringify({ labels: { cake: '케이크' } }));
  await runImportMoments({ ...f, places: [] });
  const statePath = join(f.root, VAULT_REL.mediaImportMomentsState);
  assert.match(JSON.parse(readFileSync(statePath, 'utf8')).one.notePath, /케이크/);
  const records = f.records();
  const added = { ...records[0], id: 'two', importPath: 'Imports/A/IMG_20170503_150100.jpg',
    capturedAt: '2017-05-03T15:01:00+09:00' };
  writeFileSync(join(f.root, VAULT_REL.mediaImportsIndex), `${records.map((row) => JSON.stringify(row)).join('\n')}\n${JSON.stringify(added)}\n`);
  await runImportMoments({ ...f, places: [] });
  const rel = JSON.parse(readFileSync(statePath, 'utf8')).one.notePath;
  assert.doesNotMatch(rel, /케이크/);
  assert.equal(parseFrontmatter(readFileSync(join(f.root, rel), 'utf8')).titleScene, undefined);
});

test('Imports 기존 장면 제목은 vision index가 없어져도 유지한다', async (t) => {
  const f = fixture(t);
  f.add('A', 'IMG_20170503_150000.jpg', 'one');
  await indexImports({ ...f, hash: async () => 'one' });
  const visionIndex = join(f.root, VAULT_REL.mediaVisionIndex);
  writeFileSync(visionIndex, `${JSON.stringify({ id: 'one', schema: 2,
    labels: [{ name: 'cake', confidence: 0.8 }] })}\n`);
  writeFileSync(join(f.root, VAULT_REL.mediaVisionLabels), JSON.stringify({ labels: { cake: '케이크' } }));
  await runImportMoments({ ...f, places: [] });
  const statePath = join(f.root, VAULT_REL.mediaImportMomentsState);
  const rel = JSON.parse(readFileSync(statePath, 'utf8')).one.notePath;
  rmSync(visionIndex);
  const result = await runImportMoments({ ...f, places: [] });
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).one.notePath, rel);
  assert.equal(parseFrontmatter(readFileSync(join(f.root, rel), 'utf8')).titleScene, '케이크');
  assert.equal(result.updated + result.skipped, 1);
});

test('국내 좌표 경계와 기념일·윤일·여러 인물', () => {
  assert.equal(isDomesticGps({ lat: 33, lon: 124.5 }), true);
  assert.equal(isDomesticGps({ lat: 38.7, lon: 131.9 }), true);
  assert.equal(isDomesticGps({ lat: 39, lon: 127 }), false);
  const people = [{ title: '휘영', birthday: '2016-02-29', anniversaries: ['2016-02-29 결혼'] },
    { title: '미네', birthday: '2016-02-29', anniversaries: ['2016-02-29 결혼'] }];
  assert.deepEqual(anniversariesForDay('2016-02-29', people), ['미네 태어난 날', '결혼 당일', '휘영 태어난 날']);
  assert.deepEqual(anniversariesForDay('2017-02-28', people), ['미네 생일', '결혼 기념일', '휘영 생일']);
});

test('캘린더 종일·시간 겹침과 제외 규칙', () => {
  const group = [{ capturedAt: '2017-05-03T15:00:00+09:00' }, { capturedAt: '2017-05-03T15:10:00+09:00' }];
  const events = [
    { title: '종일', allDay: true, start: '2017-05-03', end: '2017-05-04' },
    { title: '종일', allDay: true, start: '2017-05-03', end: '2017-05-04' },
    { title: '가까운 일정', allDay: false, start: '2017-05-03T15:40:00+09:00', end: '2017-05-03T16:00:00+09:00' },
    { title: '먼 일정', allDay: false, start: '2017-05-03T15:41:00+09:00', end: '2017-05-03T16:00:00+09:00' },
    { title: '공휴일', allDay: true, start: '2017-05-03', end: '2017-05-04', calendarId: 'ko#holiday@group' },
    { title: '봇', allDay: true, start: '2017-05-03', end: '2017-05-04', pantheon: true },
  ];
  assert.deepEqual(calendarOccasions(group, events), ['종일']);
  assert.deepEqual(calendarOccasions(group, events.filter((event) => !event.allDay)), ['가까운 일정']);
});

test('캘린더 설정은 긴 종일 일정을 거르고 여행을 유지하며 제외어를 우선한다', () => {
  const group = [{ capturedAt: '2017-05-03T15:00:00+09:00' }];
  const rules = { maxAllDayDays: 3, keepKeywords: ['여행'], excludeKeywords: ['회의', 'class'] };
  const allDay = (title) => ({ title, allDay: true, start: '2017-05-01', end: '2017-05-06' });
  assert.deepEqual(calendarOccasions(group, [allDay('봄 방학')], rules), []);
  assert.deepEqual(calendarOccasions(group, [allDay('가족 여행')], rules), ['가족 여행']);
  assert.deepEqual(calendarOccasions(group, [allDay('가족 여행 CLASS')], rules), []);
  assert.deepEqual(calendarOccasions(group, [{ title: '팀 회의', allDay: false,
    start: '2017-05-03T15:00:00+09:00', end: '2017-05-03T16:00:00+09:00' }], rules), []);
  assert.deepEqual(calendarOccasions(group, [allDay('봄 방학')]), ['봄 방학']);
});

test('import-albums.json의 잘못된 calendar 형식을 거부한다', async (t) => {
  const f = fixture(t);
  const albumsPath = join(f.root, VAULT_REL.mediaImportAlbums);
  const original = JSON.parse(readFileSync(albumsPath, 'utf8'));
  for (const calendar of [null, [], { maxAllDayDays: '3', keepKeywords: [], excludeKeywords: [] },
    { maxAllDayDays: 3, keepKeywords: ['여행'], excludeKeywords: [5] }]) {
    writeFileSync(albumsPath, JSON.stringify({ ...original, calendar }));
    await assert.rejects(runImportMoments({ ...f }), /calendar 형식 오류/);
  }
});

test('노트 생성 시 import-albums.json의 calendar 설정을 적용한다', async (t) => {
  const f = fixture(t);
  f.add('A', 'IMG_20170503_150000.jpg', 'one');
  await indexImports({ ...f, hash: async () => 'one' });
  const albumsPath = join(f.root, VAULT_REL.mediaImportAlbums);
  const original = JSON.parse(readFileSync(albumsPath, 'utf8'));
  writeFileSync(albumsPath, JSON.stringify({ ...original,
    calendar: { maxAllDayDays: 3, keepKeywords: ['여행'], excludeKeywords: ['CLASS'] } }));
  const calendarFetch = async (url) => ({ ok: true, json: async () => new URL(url).pathname.endsWith('calendarList')
    ? { items: [{ id: 'personal', selected: true }] }
    : { items: [
      { summary: '봄방학', start: { date: '2017-05-01' }, end: { date: '2017-05-06' } },
      { summary: '여행 class', start: { date: '2017-05-01' }, end: { date: '2017-05-06' } },
      { summary: '가족 여행', start: { date: '2017-05-01' }, end: { date: '2017-05-06' } },
    ] } });
  await runImportMoments({ ...f, noCalendar: false, accessToken: async () => 'fake', calendarFetch });
  const state = JSON.parse(readFileSync(join(f.root, VAULT_REL.mediaImportMomentsState), 'utf8'));
  const note = readFileSync(join(f.root, state.one.notePath), 'utf8');
  assert.deepEqual(parseFrontmatter(note).occasions, ['가족 여행']);
  assert.match(state.one.notePath, /가족 여행/);
});

test('당일·태어난 날 우선, 반복 기념 제외, 일정 최대 하나와 전체 최대 둘', () => {
  assert.deepEqual(selectOccasions(
    ['첫 만남 기념일', '미네 생일', '결혼 당일'], ['영호랑 데이트', '다른 일정']),
  ['결혼 당일', '영호랑 데이트']);
  assert.deepEqual(selectOccasions(['미네 생일', '첫 만남 기념일'], ['영호랑 데이트']),
    ['영호랑 데이트', '미네 생일']);
  assert.deepEqual(selectOccasions(['미네 태어난 날', '결혼 당일', '휘영 태어난 날'], ['영호랑 데이트']),
    ['미네 태어난 날', '결혼 당일']);
});

test('설정에 없는 앨범을 거부하고 Imports 파일을 건드리지 않는다', async (t) => {
  const f = fixture(t);
  const source = f.add('unknown', 'x.jpg', 'photo');
  const before = statSync(source);
  await assert.rejects(indexImports({ ...f }), /설정에 없는 Imports 앨범/);
  assert.equal(readFileSync(source, 'utf8'), 'photo');
  assert.equal(statSync(source).mtimeMs, before.mtimeMs);
});

test('폴더 연도 검사, archive·Imports 중복, 재색인 해시 생략', async (t) => {
  const f = fixture(t);
  const first = f.add('A', 'IMG_20170503_150000.jpg', 'same');
  f.add('B', 'IMG_20170503_150001.jpg', 'same');
  const other = f.add('A', 'IMG_20170503_150002.jpg', 'other');
  const archiveIndexPath = join(f.root, VAULT_REL.mediaArchiveIndex);
  writeFileSync(archiveIndexPath, `${JSON.stringify({ id: 'archive-id', archivePath: 'Archive/x' })}\n`);
  let hashCalls = 0;
  const hash = async (path) => { hashCalls += 1; return path === other ? 'archive-id' : 'import-id'; };
  const metadataForFiles = async (files) => new Map(files.map((file) => [file.path,
    { DateTimeOriginal: file.path === other ? '2018:01:01 10:00:00' : '2017:05:03 15:00:00' }]));
  await indexImports({ ...f, metadataForFiles, hash });
  const records = f.records();
  assert.equal(records.find((r) => r.importPath.endsWith('150002.jpg')).capturedConfidence, 'review');
  assert.match(records.find((r) => r.importPath.endsWith('150002.jpg')).capturedReason, /폴더 연도 2017와 다름/);
  assert.equal(records.find((r) => r.importPath.endsWith('150002.jpg')).duplicateOf, 'archive:archive-id');
  assert.equal(records.find((r) => r.importPath.endsWith('150000.jpg')).duplicateOf, 'import:Imports/B/IMG_20170503_150001.jpg');
  assert.equal(records.find((r) => r.importPath.endsWith('150001.jpg')).duplicateOf, undefined);
  await indexImports({ ...f, metadataForFiles: async () => { throw Error('unexpected exif'); },
    hash: async () => { throw Error('unexpected hash'); } });
  assert.equal(hashCalls, 3);
  assert.equal(readFileSync(first, 'utf8'), 'same');
});

test('앨범별로 묶고 estimated·review·스크린샷·중복을 제외한다', () => {
  const base = { kind: 'Import', id: '1', capturedAt: '2017-05-03T15:00:00+09:00',
    capturedConfidence: 'single', importPath: 'Imports/A/a.jpg', album: 'A' };
  const records = [base, { ...base, id: '2', album: 'B', importPath: 'Imports/B/b.jpg' },
    { ...base, id: '3', capturedConfidence: 'estimated' },
    { ...base, id: '4', capturedConfidence: 'review' },
    { ...base, id: '5', screenshot: true }, { ...base, id: '6', duplicateOf: 'archive:x' }];
  assert.equal(groupImportMoments(records).length, 2);
  assert.deepEqual(groupImportMoments(records).map((group) => group.length), [1, 1]);
});

test('색인 dry-run은 해시와 쓰기를 하지 않고, 앨범 재색인은 다른 앨범을 보존한다', async (t) => {
  const f = fixture(t);
  const a = f.add('A', 'a.jpg', 'a');
  const b = f.add('B', 'b.jpg', 'b');
  const before = [a, b].map((path) => ({ path, data: readFileSync(path), mtime: statSync(path).mtimeMs }));
  await indexImports({ ...f, dryRun: true, hash: async () => { throw Error('dry-run hashed'); },
    metadataForFiles: f.metadataForFiles });
  assert.equal(existsSync(join(f.root, VAULT_REL.mediaImportsIndex)), false);
  await indexImports({ ...f, hash: async (path) => path === a ? 'a-id' : 'b-id' });
  await indexImports({ ...f, album: 'A', hash: async () => { throw Error('unchanged hashed'); },
    metadataForFiles: async () => { throw Error('unchanged exif'); } });
  assert.equal(f.records().length, 2);
  assert.equal(f.records().find((row) => row.album === 'B').id, 'b-id');
  for (const source of before) {
    assert.deepEqual(readFileSync(source.path), source.data);
    assert.equal(statSync(source.path).mtimeMs, source.mtime);
  }
});

test('제목·머리말·limit·dry-run·재실행 건너뜀', async (t) => {
  const f = fixture(t);
  const sources = [f.add('A', 'IMG_20170503_150000.jpg', 'one'),
    f.add('A', 'IMG_20170503_190000.jpg', 'two'),
    f.add('B', 'IMG_20170503_150000.jpg', 'three')];
  const originals = sources.map((source) => ({ source, bytes: readFileSync(source), mtime: statSync(source).mtimeMs }));
  await indexImports({ ...f, hash: async (path) => path.endsWith('190000.jpg') ? 'two' : path.includes('/A/') ? 'one' : 'three' });
  const places = [{ lat: 37, lon: 127, name: '집', radius: 150 }];
  const path = join(f.root, VAULT_REL.mediaImportsIndex);
  const records = f.records();
  records[0].gps = { lat: 37, lon: 127 };
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const dry = await runImportMoments({ ...f, dryRun: true, places });
  assert.equal(dry.created, 3);
  assert.ok(dry.examples.some((name) => name.includes('미네 · 집')));
  assert.ok(dry.examples.some((name) => name.includes('미네 저녁')));
  assert.ok(dry.examples.some((name) => name.includes('오후')));
  assert.equal(existsSync(join(f.root, VAULT_REL.mediaMoments)), false);
  const first = await runImportMoments({ ...f, limit: 1, places });
  assert.equal(first.created, 1);
  assert.equal(first.unprocessed, 2);
  const state = JSON.parse(readFileSync(join(f.root, VAULT_REL.mediaImportMomentsState), 'utf8'));
  const note = readFileSync(join(f.root, Object.values(state)[0].notePath), 'utf8');
  assert.match(note, /category: "\[\[01_Home\/201 미네\]\]"/);
  assert.match(note, /source: "import"/);
  assert.match(note, /album: "A"/);
  assert.match(note, /albumLabel: "미네"/);
  assert.match(note, /origin: "media:Imports\/A\//);
  const second = await runImportMoments({ ...f, places });
  assert.equal(second.skipped, 1);
  assert.equal(second.created, 2);
  const third = await runImportMoments({ ...f, places });
  assert.equal(third.skipped, 3);
  for (const original of originals) {
    assert.deepEqual(readFileSync(original.source), original.bytes);
    assert.equal(statSync(original.source).mtimeMs, original.mtime);
  }
});

test('앨범 category 배열을 쓰고 설정 변경 시 기존 순간 노트를 갱신한다', async (t) => {
  const f = fixture(t);
  f.add('A', 'IMG_20170503_150000.jpg', 'one');
  await indexImports({ ...f, hash: async () => 'one' });
  await runImportMoments({ ...f, places: [] });
  const state = JSON.parse(readFileSync(join(f.root, VAULT_REL.mediaImportMomentsState), 'utf8'));
  const path = join(f.root, state.one.notePath);
  assert.equal(parseFrontmatter(readFileSync(path, 'utf8')).category, '[[01_Home/201 미네]]');
  const albumsPath = join(f.root, VAULT_REL.mediaImportAlbums);
  const config = JSON.parse(readFileSync(albumsPath, 'utf8'));
  config.albums.A.category = ['200 가족', '202 휘영'];
  writeFileSync(albumsPath, JSON.stringify(config));
  const updated = await runImportMoments({ ...f, places: [] });
  assert.equal(updated.updated, 1);
  assert.deepEqual(parseFrontmatter(readFileSync(path, 'utf8')).category,
    ['[[01_Home/200 가족]]', '[[01_Home/202 휘영]]']);
  const repeated = await runImportMoments({ ...f, places: [] });
  assert.equal(repeated.skipped, 1);
});

test('Imports 순간 재실행은 영상 이름표를 지우지 않는다', async (t) => {
  const f = fixture(t);
  f.add('A', 'VID_20170503_150000.mp4', 'video');
  await indexImports({ ...f, hash: async () => 'video' });
  const facePath = join(f.root, VAULT_REL.mediaFacePeople);
  mkdirSync(dirname(facePath), { recursive: true });
  writeFileSync(facePath, JSON.stringify({ photos: {} }));
  const videoId = f.records()[0].id;
  writeFileSync(f.videoPeoplePath, `${JSON.stringify({ id: videoId, people: ['휘영'] })}\n`);
  await runImportMoments({ ...f, places: [] });
  const state = JSON.parse(readFileSync(join(f.root, VAULT_REL.mediaImportMomentsState), 'utf8'));
  const notePath = join(f.root, state[videoId].notePath);
  assert.ok(parseFrontmatter(readFileSync(notePath, 'utf8')).people.includes(`[[${VAULT_REL.people}/휘영]]`));
  assert.equal((await runImportMoments({ ...f, places: [] })).skipped, 1);
  assert.ok(parseFrontmatter(readFileSync(notePath, 'utf8')).people.includes(`[[${VAULT_REL.people}/휘영]]`));
});

test('사진 이름표 파일이 없으면 영상 결과가 있어도 미네 앨범 얼굴 근거를 새로 계산하지 않는다', async (t) => {
  const f = fixture(t);
  f.add('A', 'VID_20170503_150000.mp4', 'video');
  await indexImports({ ...f, hash: async () => 'video' });
  const videoId = f.records()[0].id;
  writeFileSync(f.videoPeoplePath, `${JSON.stringify({ id: videoId, people: ['미네'] })}\n`);
  await runImportMoments({ ...f, places: [] });
  const state = JSON.parse(readFileSync(join(f.root, VAULT_REL.mediaImportMomentsState), 'utf8'));
  const fields = parseFrontmatter(readFileSync(join(f.root, state[videoId].notePath), 'utf8'));
  assert.equal(fields.mineFaces, undefined);
  assert.equal(fields.mineBasis, undefined);
  assert.equal(fields.autoPeople, undefined);
});

test('등록 장소를 먼저 쓰고, 미등록 GPS만 주소 변환하며 dry-run은 네트워크를 호출하지 않는다', async (t) => {
  const f = fixture(t);
  f.add('A', 'IMG_20170503_150000.jpg', 'registered');
  f.add('A', 'IMG_20170503_190000.jpg', 'unregistered');
  await indexImports({ ...f, hash: async (path) => path.includes('190000') ? 'two' : 'one' });
  const indexPath = join(f.root, VAULT_REL.mediaImportsIndex);
  const rows = f.records();
  rows[0].gps = { lat: 37, lon: 127 };
  rows[1].gps = { lat: 38, lon: 128 };
  writeFileSync(indexPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  let calls = 0;
  let poiCalls = 0;
  const geocode = Object.assign(async () => { calls += 1; return { address: '서울시 중구 을지로', buildingName: '카페' }; },
    { nearbyPlace: async () => { poiCalls += 1; return null; }, flush: async () => {} });
  const places = [{ lat: 37, lon: 127, name: '집', radius: 150 }];
  const preview = await runImportMoments({ ...f, dryRun: true, geocode, places });
  assert.equal(calls, 0);
  assert.ok(preview.examples.some((name) => name.includes('미네 · 집')));
  assert.ok(preview.examples.some((name) => name.includes('GPS 주소 미확인')));
  const result = await runImportMoments({ ...f, geocode, places });
  assert.equal(calls, 1);
  assert.equal(poiCalls, 1);
  assert.equal(result.created, 2);
  assert.ok(result.examples.some((name) => name.includes('미네 · 카페')));
});

test('노트 이동 뒤 상태 쓰기가 끊겨도 momentId로 복구하고 이전 경로를 남긴다', async (t) => {
  const f = fixture(t);
  f.add('A', 'IMG_20170503_150000.jpg', 'one');
  await indexImports({ ...f, hash: async () => 'one' });
  await runImportMoments({ ...f, places: [] });
  const statePath = join(f.root, VAULT_REL.mediaImportMomentsState);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const oldRel = state.one.notePath;
  const newRel = oldRel.replace('미네 오후', '가족 오후');
  renameSync(join(f.root, oldRel), join(f.root, newRel));
  const albumsPath = join(f.root, VAULT_REL.mediaImportAlbums);
  const config = JSON.parse(readFileSync(albumsPath, 'utf8'));
  config.albums.A.label = '가족';
  writeFileSync(albumsPath, JSON.stringify(config));
  const result = await runImportMoments({ ...f, places: [] });
  assert.equal(result.updated, 1);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).one.notePath, newRel);
  const note = readFileSync(join(f.root, newRel), 'utf8');
  assert.match(note, /movedFrom:/);
  assert.match(note, /albumLabel: "가족"/);
  config.albums.A.label = null;
  writeFileSync(albumsPath, JSON.stringify(config));
  await runImportMoments({ ...f, places: [] });
  const newState = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.doesNotMatch(readFileSync(join(f.root, newState.one.notePath), 'utf8'), /^albumLabel:/m);
});

test('POI·기념일·일정 제목과 머리말, 기존 노트 이동을 함께 반영한다', async (t) => {
  const f = fixture(t);
  f.add('A', 'IMG_20170503_150000.jpg', 'one');
  await indexImports({ ...f, hash: async () => 'one' });
  const indexPath = join(f.root, VAULT_REL.mediaImportsIndex);
  const rows = f.records();
  rows[0].gps = { lat: 37, lon: 127 };
  writeFileSync(indexPath, `${JSON.stringify(rows[0])}\n`);
  await runImportMoments({ ...f, places: [] });
  const statePath = join(f.root, VAULT_REL.mediaImportMomentsState);
  const oldRel = JSON.parse(readFileSync(statePath, 'utf8')).one.notePath;
  const peoplePath = join(f.root, VAULT_REL.people);
  mkdirSync(peoplePath, { recursive: true });
  writeFileSync(join(peoplePath, '미네.md'), '---\nbirthday: "2017-05-03"\nanniversaries: ["2017-05-03 결혼"]\n---\n');
  let poiCalls = 0;
  let addressCalls = 0;
  const geocode = Object.assign(async () => { addressCalls += 1; return { buildingName: '건물', address: '서울시 중구 을지로' }; }, {
    nearbyPlace: async () => { poiCalls += 1; return { name: '카페', category: 'CE7', distance: 5 }; },
    flush: async () => {},
  });
  const urls = [];
  const calendarFetch = async (url) => {
    const parsed = new URL(url);
    urls.push(parsed);
    if (parsed.pathname.endsWith('calendarList')) return { ok: true, json: async () => ({ items: [{ id: 'personal', summary: '개인', selected: true }] }) };
    return { ok: true, json: async () => ({ items: [{ summary: '여행', start: { date: '2017-05-03' }, end: { date: '2017-05-04' } }] }) };
  };
  const result = await runImportMoments({ ...f, noCalendar: false, accessToken: async () => 'fake', calendarFetch,
    geocode, places: [] });
  assert.equal(result.updated, 1);
  assert.equal(poiCalls, 1);
  assert.equal(addressCalls, 1);
  assert.equal(urls.filter((url) => url.pathname.endsWith('/events')).length, 1);
  const newRel = JSON.parse(readFileSync(statePath, 'utf8')).one.notePath;
  assert.notEqual(newRel, oldRel);
  assert.equal(existsSync(join(f.root, oldRel)), false);
  const note = readFileSync(join(f.root, newRel), 'utf8');
  const fields = parseFrontmatter(note);
  assert.equal(fields.place, '카페');
  assert.equal(fields.address, '서울시 중구 을지로');
  assert.equal(fields.placeCategory, 'CE7');
  assert.deepEqual(fields.occasions, ['미네 태어난 날', '결혼 당일']);
  assert.deepEqual(fields.occasionSource, ['anniversary']);
  assert.deepEqual(fields.movedFrom, [oldRel]);
  assert.match(note, /기념일·일정: 미네 태어난 날 · 결혼 당일/);
  assert.match(newRel, /미네 · 미네 태어난 날 · 결혼 당일 · 카페/);
});

test('2016-02-20 결혼식은 반복 기념일을 빼고 당일과 일정만 제목·머리말에 쓴다', async (t) => {
  const f = fixture(t, { A: { label: '결혼 웨딩사진', category: '100 나', priority: 1, years: [2016, 2016] } });
  f.add('A', 'IMG_20160220_150000.jpg', 'wedding');
  const metadataForFiles = async (files) => new Map(files.map((file) => [file.path,
    { DateTimeOriginal: '2016:02:20 15:00:00' }]));
  await indexImports({ ...f, metadataForFiles, hash: async () => 'wedding' });
  const indexPath = join(f.root, VAULT_REL.mediaImportsIndex);
  const [record] = f.records();
  writeFileSync(indexPath, `${JSON.stringify({ ...record, gps: { lat: 35.85, lon: 128.6 } })}\n`);
  const peoplePath = join(f.root, VAULT_REL.people);
  mkdirSync(peoplePath, { recursive: true });
  writeFileSync(join(peoplePath, '나.md'), '---\nanniversaries: ["2015-02-20 첫 만남", "2016-02-20 결혼"]\n---\n');
  const calendarFetch = async (url) => ({ ok: true, json: async () => new URL(url).pathname.endsWith('calendarList')
    ? { items: [{ id: 'personal', selected: true }] }
    : { items: [{ summary: '영호랑 데이트', start: { date: '2016-02-20' }, end: { date: '2016-02-21' } },
      { summary: '다른 일정', start: { date: '2016-02-20' }, end: { date: '2016-02-21' } }] } });
  await runImportMoments({ ...f, noCalendar: false, accessToken: async () => 'fake', calendarFetch,
    places: [{ lat: 35.85, lon: 128.6, name: '수성구 두산동 일대', radius: 150 }] });
  const state = JSON.parse(readFileSync(join(f.root, VAULT_REL.mediaImportMomentsState), 'utf8'));
  const notePath = state.wedding.notePath;
  const note = readFileSync(join(f.root, notePath), 'utf8');
  assert.match(notePath, /2016-02-20 결혼 웨딩사진 · 결혼 당일 · 영호랑 데이트 · 수성구 두산동 일대 순간\.md$/);
  assert.deepEqual(parseFrontmatter(note).occasions, ['결혼 당일', '영호랑 데이트']);
  assert.match(note, /기념일·일정: 결혼 당일 · 영호랑 데이트/);
  assert.doesNotMatch(note, /첫 만남 기념일|다른 일정/);
});

test('해외 GPS는 카카오를 건너뛰고 시간 출처를 쓰며 캘린더 실패 후에도 기념일을 쓴다', async (t) => {
  const f = fixture(t);
  f.add('A', 'IMG_20170503_150000.jpg', 'one');
  await indexImports({ ...f, hash: async () => 'one' });
  const indexPath = join(f.root, VAULT_REL.mediaImportsIndex);
  const rows = f.records();
  rows[0].gps = { lat: 48, lon: 2 };
  writeFileSync(indexPath, `${JSON.stringify(rows[0])}\n`);
  const geocode = Object.assign(async () => { throw Error('해외 주소 호출'); }, {
    nearbyPlace: async () => { throw Error('해외 POI 호출'); }, flush: async () => {},
  });
  await runImportMoments({ ...f, geocode, places: [] });
  const statePath = join(f.root, VAULT_REL.mediaImportMomentsState);
  const firstState = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(parseFrontmatter(readFileSync(join(f.root, firstState.one.notePath), 'utf8')).infoSource, 'time');
  const peoplePath = join(f.root, VAULT_REL.people);
  mkdirSync(peoplePath, { recursive: true });
  writeFileSync(join(peoplePath, '미네.md'), '---\nbirthday: "2017-05-03"\n---\n');
  const warnings = [];
  const output = { log() {}, warn: (line) => warnings.push(line) };
  await runImportMoments({ ...f, geocode, output, places: [], noCalendar: false,
    accessToken: async () => { throw Error('토큰 없음'); } });
  assert.deepEqual(warnings, ['[media-imports] 캘린더 미조회: 토큰 없음']);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const note = readFileSync(join(f.root, state.one.notePath), 'utf8');
  assert.equal(parseFrontmatter(note).infoSource, 'anniversary');
  assert.match(state.one.notePath, /미네 · 미네 태어난 날 순간/);
});

test('한 연도 두 순간은 일정 범위를 한 번 읽고 no-poi는 주소로 대체한다', async (t) => {
  const f = fixture(t);
  f.add('A', 'IMG_20170503_150000.jpg', 'one');
  f.add('A', 'IMG_20170503_190000.jpg', 'two');
  await indexImports({ ...f, hash: async (path) => path.includes('190000') ? 'two' : 'one' });
  const indexPath = join(f.root, VAULT_REL.mediaImportsIndex);
  const rows = f.records().map((row) => ({ ...row, gps: { lat: 37, lon: 127 } }));
  writeFileSync(indexPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  let poiCalls = 0;
  const geocode = Object.assign(async () => ({ buildingName: '건물', address: '서울시 중구 을지로' }), {
    nearbyPlace: async () => { poiCalls += 1; return { name: '카페', category: 'CE7' }; }, flush: async () => {},
  });
  const urls = [];
  const calendarFetch = async (url) => {
    const parsed = new URL(url);
    urls.push(parsed);
    return { ok: true, json: async () => parsed.pathname.endsWith('calendarList')
      ? { items: [{ id: 'personal', selected: true }] } : { items: [] } };
  };
  await runImportMoments({ ...f, noCalendar: false, noPoi: true, accessToken: async () => 'fake',
    calendarFetch, geocode, places: [] });
  assert.equal(urls.filter((url) => url.pathname.endsWith('/events')).length, 1);
  assert.equal(poiCalls, 0);
  const state = JSON.parse(readFileSync(join(f.root, VAULT_REL.mediaImportMomentsState), 'utf8'));
  for (const entry of Object.values(state)) {
    const fields = parseFrontmatter(readFileSync(join(f.root, entry.notePath), 'utf8'));
    assert.equal(fields.place, '건물');
    assert.equal(fields.placeCategory, undefined);
  }
});
