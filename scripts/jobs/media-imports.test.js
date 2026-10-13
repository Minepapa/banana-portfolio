import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { indexImports, groupImportMoments, runImportMoments } from './media-imports.mjs';

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
  return { root, mediaRoot, add, records, output, metadataForFiles, geocode, registryRules };
}

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
  const geocode = Object.assign(async () => { calls += 1; return { address: '서울시 중구 을지로', buildingName: '카페' }; },
    { flush: async () => {} });
  const places = [{ lat: 37, lon: 127, name: '집', radius: 150 }];
  const preview = await runImportMoments({ ...f, dryRun: true, geocode, places });
  assert.equal(calls, 0);
  assert.ok(preview.examples.some((name) => name.includes('미네 · 집')));
  assert.ok(preview.examples.some((name) => name.includes('GPS 주소 미확인')));
  const result = await runImportMoments({ ...f, geocode, places });
  assert.equal(calls, 1);
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
