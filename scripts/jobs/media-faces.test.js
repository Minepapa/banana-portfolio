import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { clusterMediaFaces, confirmMediaFaces, parseFaceOutput, runMediaFaces, runPythonFaces,
  runCropFaces, selectFaceTargets, sheetMediaFaces, matchMediaFaces, reportMediaFaces,
  goldSheetMediaFaces, parseGoldCorrections, recordGoldLabels, prebirthFalsePositiveRows,
  renderFaceSheet } from './media-faces.mjs';
import { ageBand, capturePeriod, buildGallery, clusterBand, confirmBand, mineAlbum, selectGalleryCandidates,
  selectSheetMembers, matchFaces, selectGoldSample, goldMetrics } from '../lib/media-face-gallery.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'media-faces-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const mediaRoot = join(base, 'media');
  const out = join(base, 'faces');
  const embeddingsPath = join(out, 'embeddings');
  const indexPath = join(out, 'faces-index.jsonl');
  const pathFor = (key) => join(root, VAULT_REL[key]);
  const save = (path, rows) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${rows.map(JSON.stringify).join('\n')}\n`);
  };
  return { root, mediaRoot, out, embeddingsPath, indexPath, pathFor, save,
    output: { log() {}, error() {} } };
}

test('대상은 얼굴 있는 원본 사진만 고르고 중복·스크린샷·완료 쌍을 제외한다', (t) => {
  const f = fixture(t);
  mkdirSync(f.embeddingsPath, { recursive: true });
  writeFileSync(join(f.embeddingsPath, 'done.npy'), 'test');
  const vision = ['done', 'missing', 'zero', 'video', 'dupe', 'screen', 'archiveScreen', 'heic', 'orphan']
    .map((id) => ({ id, faces: id === 'zero' ? 0 : 1 }));
  const media = [
    { id: 'done', archivePath: 'Archive/done.jpg' },
    { id: 'missing', archivePath: 'Archive/missing.png' },
    { id: 'zero', archivePath: 'Archive/zero.jpg' },
    { id: 'video', archivePath: 'Archive/video.mov' },
    { id: 'dupe', importPath: 'Imports/dupe.jpeg', duplicateOf: 'archive:other' },
    { id: 'screen', importPath: 'Imports/screen.png', screenshot: true },
    { id: 'archiveScreen', kind: 'Screenshots', archivePath: 'Archive/archiveScreen.jpg' },
    { id: 'heic', importPath: 'Imports/heic.HEIC' },
  ];
  const selected = selectFaceTargets(vision, media, [{ id: 'done', faces: [] },
    { id: 'missing', faces: [] }], { embeddingsPath: f.embeddingsPath });
  assert.deepEqual(selected.map((row) => row.id), ['missing', 'heic']);
  assert.deepEqual(selectFaceTargets(vision, media, [], { embeddingsPath: f.embeddingsPath,
    ids: ['heic'], limit: 1 }).map((row) => row.id), ['heic']);
});

test('파이썬 줄 파싱은 id 순서를 복원하고 누락·실패를 기록한다', () => {
  const inputs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(parseFaceOutput([
    JSON.stringify({ id: 'b', error: 'bad image' }),
    JSON.stringify({ id: 'a', faces: [{ i: 0 }], ms: 12 }),
  ], inputs), [
    { id: 'a', faces: [{ i: 0 }], ms: 12 },
    { id: 'b', error: 'bad image' },
    { id: 'c', error: '얼굴 도구 결과 누락' },
  ]);
  assert.throws(() => parseFaceOutput(['{'], inputs), /JSON 오류/);
  assert.throws(() => parseFaceOutput(['{"id":"other","faces":[],"ms":1}'], inputs), /id 오류/);
});

test('dry-run은 Python을 호출하지 않고 파일도 만들지 않는다', async (t) => {
  const f = fixture(t);
  f.save(f.pathFor('mediaArchiveIndex'), [{ id: 'a', archivePath: 'Archive/a.jpg' }]);
  f.save(f.pathFor('mediaVisionIndex'), [{ id: 'a', faces: 2 }]);
  let calls = 0;
  const result = await runMediaFaces({ ...f, dryRun: true, runner: () => { calls += 1; } });
  assert.equal(result.selected, 1);
  assert.equal(calls, 0);
  assert.equal(existsSync(f.out), false);
});

test('성공과 실패를 id별 원자적 색인에 남기고 성공 쌍은 다시 처리하지 않는다', async (t) => {
  const f = fixture(t);
  f.save(f.pathFor('mediaArchiveIndex'), [
    { id: 'a', archivePath: 'Archive/a.jpg' }, { id: 'b', archivePath: 'Archive/b.jpg' },
  ]);
  f.save(f.pathFor('mediaVisionIndex'), [{ id: 'a', faces: 1 }, { id: 'b', faces: 1 }]);
  let calls = 0;
  const runner = async (images) => {
    calls += 1;
    writeFileSync(join(f.embeddingsPath, 'a.npy'), 'test');
    return { lines: [JSON.stringify({ id: images[0].id, faces: [{ i: 0 }], ms: 10 }),
      JSON.stringify({ id: images[1].id, error: 'corrupt' })] };
  };
  const first = await runMediaFaces({ ...f, runner });
  assert.deepEqual(first, { selected: 2, processed: 1, faces: { 1: 1 }, failed: 1, averageMs: 10 });
  const rows = readFileSync(f.indexPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.find((row) => row.id === 'b').error, 'corrupt');
  const second = await runMediaFaces({ ...f, runner: async (images) => {
    calls += 1;
    assert.deepEqual(images.map((image) => image.id), ['b']);
    return { lines: [JSON.stringify({ id: 'b', error: 'corrupt' })] };
  } });
  assert.equal(second.selected, 1);
  assert.equal(calls, 2);
  assert.equal(existsSync(join(f.out, '.media-faces.lock')), false);
});

test('spawn 주입으로 Python 입출력을 모델 없이 확인한다', async () => {
  const spawnProcess = (command, args) => {
    assert.equal(command, '/fake/python');
    assert.match(args[0], /media_faces\.py$/);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let request = '';
    child.stdin.on('data', (chunk) => { request += chunk; });
    child.stdin.on('end', () => {
      assert.deepEqual(JSON.parse(request).images, [{ id: 'a', path: '/photo.jpg' }]);
      child.stdout.end('{"id":"a","faces":[],"ms":1}\n');
      child.emit('close', 0, null);
    });
    return child;
  };
  const result = await runPythonFaces([{ id: 'a', path: '/photo.jpg' }], {
    out: '/faces', python: '/fake/python', spawnProcess,
  });
  assert.equal(result.crashed, false);
  assert.deepEqual(parseFaceOutput(result.lines, [{ id: 'a' }]), [{ id: 'a', faces: [], ms: 1 }]);
});

test('조각 생성은 주입한 프로세스에 요청만 전달한다', async () => {
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.on('data', () => {});
    child.stdin.on('end', () => {
      child.stdout.end('"/tmp/crop.jpg"\n');
      child.emit('close', 0);
    });
    return child;
  };
  assert.deepEqual(await runCropFaces([{ id: 'a', i: 0, bbox: [0, 0, 1, 1],
    path: '/tmp/a.jpg', out: '/tmp/crop.jpg' }], { python: '/fake/python', spawnProcess }),
  ['/tmp/crop.jpg']);
});

test('서울 촬영 날짜의 만 나이 경계와 불확실한 날짜를 제외한다', () => {
  assert.equal(ageBand('2016-11-03'), null);
  assert.equal(ageBand('2016-11-04'), '0-6m');
  assert.equal(ageBand('2017-05-03'), '0-6m');
  assert.equal(ageBand('2017-05-04'), '6-12m');
  assert.equal(ageBand('2018-11-03'), '18-24m');
  assert.equal(ageBand('2018-11-04'), '2y');
  assert.equal(ageBand('2026-11-03'), '9y');
  assert.equal(ageBand('2026-11-04'), null);
  assert.equal(ageBand('2018-11-03T16:00:00Z'), '2y');
  assert.equal(ageBand('2017-01-01', 'estimated'), null);
  assert.equal(ageBand('2017-01-01', 'review'), null);
  assert.equal(ageBand(null), null);
  for (const confidence of [undefined, 'confirmed', 'single', 'estimated', 'review']) {
    assert.equal(capturePeriod('2016-11-03', confidence), 'prebirth');
    assert.equal(capturePeriod('2016-11-03T14:59:59Z', confidence), 'prebirth');
  }
  assert.equal(capturePeriod('2016-11-03T15:00:00Z', 'confirmed'), 'banded');
  assert.equal(capturePeriod('2016-11-04', 'single'), 'banded');
  assert.equal(capturePeriod('2016-11-04', 'estimated'), 'bandless');
  assert.equal(capturePeriod('2016-11-04', 'review'), 'bandless');
  assert.equal(capturePeriod(null, 'confirmed'), 'bandless');
});

test('미네 앨범과 얼굴 품질을 걸러 흐림 하위 10%를 제외한다', () => {
  const albums = { mine: { category: ['201 미네', '200 가족'] }, other: { category: '200 가족' },
    '미네 초음파': { category: '201 미네' } };
  assert.equal(mineAlbum('mine', albums), true);
  assert.equal(mineAlbum('미네 초음파', albums), false);
  const rows = Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`,
    faces: [{ i: 0, det: 0.8, size: 80, blur: index }] }));
  rows.push({ id: 'weak', faces: [{ i: 0, det: 0.69, size: 80, blur: 100 }] });
  rows.push({ id: 'small', faces: [{ i: 0, det: 0.8, size: 59, blur: 100 }] });
  rows.push({ id: 'ultra', faces: [{ i: 0, det: 0.8, size: 80, blur: 100 }] });
  rows.push({ id: 'missingDet', faces: [{ i: 0, size: 80, blur: 100 }] });
  rows.push({ id: 'stringDet', faces: [{ i: 0, det: '0.9', size: 80, blur: 100 }] });
  rows.push({ id: 'missingSize', faces: [{ i: 0, det: 0.9, blur: 100 }] });
  rows.push({ id: 'stringSize', faces: [{ i: 0, det: 0.9, size: '80', blur: 100 }] });
  const media = rows.map((row) => ({ id: row.id, album: row.id === 'ultra' ? '미네 초음파' : 'mine',
    importPath: `Imports/${row.id}.jpg`, capturedAt: '2019-01-01' }));
  const candidates = selectGalleryCandidates(rows, media, albums).get('2y');
  assert.equal(candidates.length, 9);
  assert.equal(candidates.some((member) => member.id === 'p0'), false);
});

test('연결 요소의 가장 큰 묶음을 택하고 같은 사진은 중심 가까운 얼굴만 남긴다', () => {
  const members = [{ id: 'a', i: 0 }, { id: 'a', i: 1 }, { id: 'b', i: 0 },
    { id: 'c', i: 0 }, { id: 'other', i: 0 }];
  const vectors = [[1, 0], [0.8, 0.6], [0.9, 0.435], [0.7, 0.714], [-1, 0]];
  const result = clusterBand(members, (member) => vectors[members.indexOf(member)]);
  assert.deepEqual(result.clusterSizes, [4, 1]);
  assert.equal(result.members.length, 3);
  assert.deepEqual(result.members.filter((member) => member.id === 'a'), [{ id: 'a', i: 1 }]);
});

test('gallery는 생체값을 직렬화하지 않고 confirmed 및 removed를 보존한다', () => {
  const candidates = new Map([['2y', [{ id: 'a', i: 0, bbox: [1, 2, 3, 4], blur: 20 }]],
    ['3y', [{ id: 'b', i: 0, blur: 20 }, { id: 'c', i: 0, blur: 20 }]]]);
  const previous = { bands: { '2y': { members: [{ id: 'old', i: 1 }], candidateCount: 7,
    clusterSizes: [7], confirmed: true, removed: [{ id: 'bad', i: 0 }] },
  '3y': { members: [], candidateCount: 0, clusterSizes: [], confirmed: false,
    removed: [{ id: 'b', i: 0 }] } } };
  const { gallery } = buildGallery(previous, candidates, () => [1, 0], 'now');
  assert.deepEqual(gallery.bands['2y'], previous.bands['2y']);
  assert.deepEqual(gallery.bands['3y'].members, [{ id: 'c', i: 0 }]);
  assert.deepEqual(gallery.bands['3y'].removed, [{ id: 'b', i: 0 }]);
  assert.doesNotMatch(JSON.stringify(gallery), /"(?:bbox|blur|embedding|vector|kps)"/);
});

test('시트는 가까운 절반과 먼 절반을 섞고 번호 확인은 현재 기준에 묶인다', () => {
  const members = Array.from({ length: 40 }, (_, index) => ({ id: `p${index}`, i: 0 }));
  const selected = selectSheetMembers(members, ({ id }) => [1, Number(id.slice(1)) / 40]);
  assert.equal(selected.length, 30);
  assert.equal(selected.some((member) => member.id === 'p0'), true);
  const gallery = { bands: { '2y': { members: [{ id: 'a', i: 0 }, { id: 'b', i: 1 }],
    candidateCount: 2, clusterSizes: [2], confirmed: false, removed: [] } } };
  const mapping = { members: gallery.bands['2y'].members,
    sheet: [{ id: 'b', i: 1 }, { id: 'a', i: 0 }] };
  const confirmed = confirmBand(gallery, '2y', mapping, [1], 'now');
  assert.deepEqual(confirmed.bands['2y'].members, [{ id: 'a', i: 0 }]);
  assert.deepEqual(confirmed.bands['2y'].removed, [{ id: 'b', i: 1 }]);
  assert.equal(confirmed.bands['2y'].confirmed, true);
  assert.throws(() => confirmBand(gallery, '2y', { ...mapping, members: [] }, [], 'now'), /다릅니다/);
  assert.throws(() => confirmBand(gallery, '2y', mapping, [3], 'now'), /번호 오류/);
});

test('cluster, sheets, confirm은 임시 경로에서만 실행하고 원본을 바꾸지 않는다', async (t) => {
  const f = fixture(t);
  const albumPath = f.pathFor('mediaImportAlbums');
  mkdirSync(dirname(albumPath), { recursive: true });
  writeFileSync(albumPath, JSON.stringify({ albums: { mine: { category: '201 미네' } } }));
  f.save(f.pathFor('mediaImportsIndex'), [{ id: 'a', album: 'mine',
    importPath: 'Imports/a.jpg', capturedAt: '2019-01-01' }]);
  f.save(f.indexPath, [{ id: 'a', faces: [{ i: 0, det: 0.9, size: 90,
    blur: 80, bbox: [10, 10, 90, 90] }], ms: 1 }]);
  mkdirSync(f.embeddingsPath, { recursive: true });
  const header = "{'descr': '<f4', 'fortran_order': False, 'shape': (1, 512), }";
  const padded = header.padEnd(Math.ceil((10 + header.length + 1) / 16) * 16 - 11, ' ') + '\n';
  const npy = Buffer.alloc(10 + padded.length + 512 * 4);
  npy.write('\x93NUMPY', 0, 'latin1');
  npy[6] = 1;
  npy.writeUInt16LE(padded.length, 8);
  npy.write(padded, 10);
  npy.writeFloatLE(1, 10 + padded.length);
  writeFileSync(join(f.embeddingsPath, 'a.npy'), npy);
  const galleryPath = f.pathFor('mediaFaceGallery');
  const options = { ...f, galleryPath, now: '2026-10-14T00:00:00Z' };
  await clusterMediaFaces(options);
  const gallery = JSON.parse(readFileSync(galleryPath, 'utf8'));
  assert.deepEqual(gallery.bands['2y'].members, [{ id: 'a', i: 0 }]);
  let cropCount = 0;
  await sheetMediaFaces({ ...options, cropper: async (images) => { cropCount = images.length;
    assert.equal(images[0].path, join(f.mediaRoot, 'Imports/a.jpg'));
    return images.map((image) => image.out);
  } });
  assert.equal(cropCount, 1);
  const mapping = JSON.parse(readFileSync(join(f.out, 'sheets', '2y.json'), 'utf8'));
  assert.deepEqual(mapping.sheet, [{ id: 'a', i: 0 }]);
  assert.match(readFileSync(join(f.out, 'sheets', '2y.html'), 'utf8'), /후보 1/);
  assert.doesNotMatch(readFileSync(join(f.out, 'sheets', 'index.html'), 'utf8'), /href="gold\.html"/);
  writeFileSync(join(f.out, 'sheets', 'gold.html'), 'gold');
  await sheetMediaFaces({ ...options, cropper: async (images) => images.map((image) => image.out) });
  assert.match(readFileSync(join(f.out, 'sheets', 'index.html'), 'utf8'), /href="gold\.html"/);
  await confirmMediaFaces('2y', [1], { ...options, sheetsPath: join(f.out, 'sheets') });
  const updated = JSON.parse(readFileSync(galleryPath, 'utf8'));
  assert.deepEqual(updated.bands['2y'].members, []);
  assert.deepEqual(updated.bands['2y'].removed, [{ id: 'a', i: 0 }]);
});

test('조각 실패·좌표 누락은 다른 얼굴의 시트 번호를 바꾸지 않는다', async (t) => {
  const f = fixture(t);
  const galleryPath = f.pathFor('mediaFaceGallery');
  mkdirSync(dirname(galleryPath), { recursive: true });
  writeFileSync(galleryPath, JSON.stringify({ bands: { '2y': {
    members: [{ id: 'a', i: 0 }, { id: 'b', i: 0 }, { id: 'c', i: 0 }], candidateCount: 3,
    clusterSizes: [3], confirmed: false, removed: [],
  } } }));
  f.save(f.pathFor('mediaImportsIndex'), [
    { id: 'a', importPath: 'Imports/a.jpg' }, { id: 'b', importPath: 'Imports/b.jpg' },
    { id: 'c', importPath: 'Imports/c.jpg' },
  ]);
  f.save(f.indexPath, [
    { id: 'a', faces: [{ i: 0, bbox: [0, 0, 5, 5] }] },
    { id: 'b', faces: [{ i: 0, bbox: [0, 0, 5, 5] }] },
    { id: 'c', faces: [{ i: 0 }] },
  ]);
  const header = "{'descr': '<f4', 'fortran_order': False, 'shape': (1, 512), }";
  const padded = header.padEnd(Math.ceil((10 + header.length + 1) / 16) * 16 - 11, ' ') + '\n';
  const npy = Buffer.alloc(10 + padded.length + 512 * 4);
  npy.write('\x93NUMPY', 0, 'latin1');
  npy[6] = 1;
  npy.writeUInt16LE(padded.length, 8);
  npy.write(padded, 10);
  mkdirSync(f.embeddingsPath, { recursive: true });
  for (const id of ['a', 'b', 'c']) writeFileSync(join(f.embeddingsPath, `${id}.npy`), npy);
  await sheetMediaFaces({ ...f, galleryPath, cropper: async (images) => {
    assert.deepEqual(images.map((image) => image.id), ['a', 'b']);
    return [images[1].out];
  } });
  const mapping = JSON.parse(readFileSync(join(f.out, 'sheets', '2y.json'), 'utf8'));
  assert.deepEqual(mapping.members, [{ id: 'a', i: 0 }, { id: 'b', i: 0 }, { id: 'c', i: 0 }]);
  assert.deepEqual(mapping.sheet, [{ id: 'b', i: 0 }]);
  const html = readFileSync(join(f.out, 'sheets', '2y.html'), 'utf8');
  assert.match(html, /b_0\.jpg/);
  assert.doesNotMatch(html, /a_0\.jpg/);
  assert.doesNotMatch(html, /c_0\.jpg/);
  assert.match(html, /<figcaption>1<\/figcaption>/);
});

test('클릭 시트는 표시값과 조각 경로만 포함하고 표본별 저장 키를 만든다', () => {
  const state = { members: [{ id: 'face-a', i: 0 }], candidateCount: 1, clusterSizes: [1] };
  const bandHtml = renderFaceSheet({ band: '2y', state, sheet: [{ id: 'face-a', i: 0 }] });
  assert.equal((bandHtml.match(/class="card /g) ?? []).length, 1);
  assert.match(bandHtml, /\.\.\/crops\/face-a_0\.jpg/);
  assert.match(bandHtml, /--confirm=/);
  assert.match(bandHtml, /--remove=/);
  assert.match(bandHtml, /const repoRoot = "\/.*banana-portfolio-v2\/"/);
  assert.match(bandHtml, /return 'cd ' \+ JSON\.stringify\(repoRoot\) \+ ' && node scripts\/jobs\/media-faces\.mjs/);
  assert.match(bandHtml, /결과 복사|파일로 저장|초기화/);
  assert.doesNotMatch(bandHtml, /https?:\/\/|bbox|score|archivePath/);

  const sample = [
    { number: 1, id: 'hidden-one', i: 0, predicted: 'mine', band: '2y', score: 0.91,
      bbox: [1, 2, 3, 4], archivePath: 'Archive/private.jpg' },
    { number: 2, id: 'hidden-two', i: 0, predicted: 'uncertain', band: '3y' },
    { number: 3, id: 'hidden-three', i: 0, predicted: 'other', band: null },
  ];
  const goldHtml = renderFaceSheet({ sample });
  assert.equal((goldHtml.match(/class="card /g) ?? []).length, 3);
  assert.match(goldHtml, /data-number="1" data-predicted="mine"/);
  assert.match(goldHtml, /data-number="2" data-predicted="uncertain"/);
  assert.match(goldHtml, /data-number="3" data-predicted="other"/);
  assert.match(goldHtml, /모델 mine · 2y/);
  assert.match(goldHtml, /data-predicted="uncertain"[\s\S]*?오너 답: 아님/);
  assert.match(goldHtml, /gold-answers\.txt/);
  assert.doesNotMatch(goldHtml, /hidden-one|hidden-two|hidden-three|private\.jpg|archivePath|bbox|score/);
  assert.doesNotMatch(goldHtml, /https?:\/\//);
  assert.notEqual(goldHtml.match(/media-faces:gold:[a-f0-9]{64}/)?.[0],
    renderFaceSheet({ sample: sample.slice(0, 2) }).match(/media-faces:gold:[a-f0-9]{64}/)?.[0]);
});

test('sheet script data and displayed numbers escape HTML and JavaScript delimiters', () => {
  const html = renderFaceSheet({ band: '</script>\u2028\u2029',
    state: { members: [], candidateCount: 0, clusterSizes: [] }, sheet: [] });
  assert.doesNotMatch(html, /const band = "<\/script>/);
  assert.match(html, /\\u003c\/script>/);
  assert.match(html, /\\u2028\\u2029/);
  const gold = renderFaceSheet({ sample: [{ number: '<img src=x>', predicted: 'other', band: '2y' }] });
  assert.match(gold, /&lt;img src=x&gt;/);
  assert.doesNotMatch(gold, /<figcaption><img/);
});

test('gold label input distinguishes missing file from inline corrections', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.out, 'sheets'), { recursive: true });
  writeFileSync(join(f.out, 'sheets', 'gold.json'), JSON.stringify({ sample: [
    { number: 1, predicted: 'mine' }] }));
  await assert.rejects(recordGoldLabels(join(f.out, 'missing.txt'), { out: f.out, output: f.output }),
    /파일을 찾을 수 없음/);
  const labels = await recordGoldLabels('미네가 아닌 번호: 1\n미네인데 아니라고 한 번호:',
    { out: f.out, output: f.output });
  assert.equal(labels.labels[1], false);
});

test('매칭은 인접 나이대 상위 5개 평균이며 같은 사진과 중복 미네를 제외한다', () => {
  const gallery = { bands: {
    '2y': { members: [{ id: 'self', i: 0 }, { id: 'a', i: 0 }] },
    '3y': { members: [{ id: 'b', i: 0 }] },
    '5y': { members: [{ id: 'far', i: 0 }] },
  } };
  const vectors = { 'self:0': [1, 0], 'self:1': [1, 0], 'a:0': [0.8, 0.6],
    'b:0': [0.8, 0.6], 'far:0': [-1, 0] };
  const rows = [{ id: 'self', faces: [{ i: 0 }, { i: 1 }] }];
  const media = [{ id: 'self', capturedAt: '2019-01-01', album: 'family' }];
  const result = matchFaces(rows, media, gallery, ({ id, i }) => vectors[`${id}:${i}`]);
  assert.equal(result[0].score, 0.8);
  assert.deepEqual(result.map((face) => face.label), ['mine', 'uncertain']);
  assert.equal(result[1].reason, 'same-photo-mine-limit');
  const bandless = matchFaces(rows, [], gallery, ({ id, i }) => vectors[`${id}:${i}`]);
  assert.deepEqual(bandless
    .map((face) => Number(face.score.toFixed(2))), [0.2, 0.2]);
  assert.equal(bandless[0].bandless, true);
  assert.deepEqual(Object.keys(result[0]), ['id', 'i', 'band', 'score', 'label']);
});

test('출생 이전 얼굴은 높은 점수도 보존하고 최종 판정은 아님으로 고정한다', () => {
  const gallery = { bands: { '2y': { members: [{ id: 'ref', i: 0 }] } } };
  const rows = [{ id: 'old', faces: [{ i: 0 }, { i: 1 }] }];
  const media = [{ id: 'old', capturedAt: '2016-11-03', capturedConfidence: 'estimated' }];
  const matches = matchFaces(rows, media, gallery, ({ id }) => id === 'ref' ? [1, 0] : [0.8, 0.6]);
  assert.deepEqual(matches.map(({ score, label, reason, prebirth, bandless }) =>
    ({ score, label, reason, prebirth, bandless })), [0, 1].map(() => ({
    score: 0.8, label: 'other', reason: '출생 이전', prebirth: true, bandless: undefined,
  })));
});

test('출생 이전 오탐률은 모든 얼굴을 분모로 하고 임계값 이상 점수를 센다', () => {
  const rows = prebirthFalsePositiveRows([
    ...[0.39, 0.4, 0.5, 0.7, null].map((score) => ({ prebirth: true, score })),
    { bandless: true, score: 0.9 },
  ]);
  assert.deepEqual(rows.map((row) => [row.threshold, row.falsePositive, row.rate]), [
    [0.4, 3, '60.0%'], [0.45, 2, '40.0%'], [0.5, 2, '40.0%'],
    [0.55, 1, '20.0%'], [0.6, 1, '20.0%'], [0.65, 1, '20.0%'], [0.7, 1, '20.0%'],
  ]);
});

test('골드 표본은 재현 가능하게 층화하고 무양성 임계값은 자료 없음으로 둔다', () => {
  const matches = ['2y', '3y'].flatMap((ageBand, band) => ['mine', 'uncertain', 'other']
    .flatMap((label, group) => Array.from({ length: 4 }, (_, index) => ({
      id: `p${band}${group}${index}`, i: 0, band: ageBand, label, score: 0.1,
    }))));
  const sample = selectGoldSample(matches, { mine: 4, uncertain: 4, other: 4 });
  assert.deepEqual(sample, selectGoldSample(matches, { mine: 4, uncertain: 4, other: 4 }));
  assert.deepEqual(Object.fromEntries(['mine', 'uncertain', 'other'].map((label) => [label,
    sample.filter((member) => member.predicted === label).length])), { mine: 4, uncertain: 4, other: 4 });
  assert.equal(new Set(sample.filter((member) => member.predicted === 'mine')
    .map((member) => member.band)).size, 2);
  const labels = Object.fromEntries(sample.map((member) => [member.number, member.predicted === 'mine']));
  const metrics = goldMetrics(sample, labels);
  assert.equal(metrics.atDefault.precision, null);
  assert.equal(metrics.recommended, null);
  assert.equal(metrics.thresholds[0].threshold, 0.30);
  assert.equal(metrics.thresholds.at(-1).threshold, 0.60);
  const onePhoto = [{ number: 1, id: 'same', i: 0, score: 0.6, winner: true, predicted: 'mine' },
    { number: 2, id: 'same', i: 1, score: 0.55, winner: false, predicted: 'uncertain' }];
  assert.equal(goldMetrics(onePhoto, { 1: true, 2: false }).atDefault.falsePositive, 0);
  assert.deepEqual(parseGoldCorrections('미네가 아닌 번호: \n미네인데 아니라고 한 번호: 2',
    onePhoto), { 1: true, 2: true });
  assert.deepEqual(parseGoldCorrections('미네가 아닌 번호: 1; 미네인데 아니라고 한 번호: 2',
    onePhoto), { 1: false, 2: true });
  assert.deepEqual(parseGoldCorrections('\uFEFF미네가 아닌 번호: 1  \n미네인데 아니라고 한 번호: 2  \n',
    onePhoto), { 1: false, 2: true });
  assert.deepEqual(parseGoldCorrections('\uFEFF미네가 아닌 번호:   \r\n미네인데 아니라고 한 번호:  \r\n',
    onePhoto), { 1: true, 2: false });
  assert.deepEqual(parseGoldCorrections('\uFEFF미네가 아닌 번호: 1, 2\n미네인데 아니라고 한 번호: 3  ', [
    { number: 1, predicted: 'mine' }, { number: 2, predicted: 'mine' },
    { number: 3, predicted: 'other' },
  ]), { 1: false, 2: false, 3: true });
  assert.throws(() => parseGoldCorrections('미네가 아닌 번호: 1', onePhoto), /두 교정 목록/);
  const weighted = goldMetrics([
    { number: 1, predicted: 'mine', winner: true, score: 0.55 },
    { number: 2, predicted: 'other', winner: true, score: 0.55 },
  ], { 1: true, 2: false }, [
    { label: 'mine' }, { label: 'other' }, { label: 'other' }, { label: 'other' },
  ]);
  assert.equal(weighted.atDefault.precision, 0.25);
  const bandWeighted = goldMetrics([
    { number: 1, predicted: 'mine', band: '2y', winner: true, score: 0.55 },
    { number: 2, predicted: 'mine', band: '3y', winner: true, score: 0.55 },
  ], { 1: true, 2: false }, [
    { label: 'mine', band: '2y' },
    ...Array.from({ length: 9 }, () => ({ label: 'mine', band: '3y' })),
  ]);
  assert.equal(bandWeighted.atDefault.precision, 0.1);
  const withPrebirth = [...matches, { id: 'old', i: 0, band: null, label: 'other',
    score: 0.9, prebirth: true }];
  assert.equal(selectGoldSample(withPrebirth, { mine: 0, uncertain: 0, other: 100 })
    .some((member) => member.id === 'old'), false);
  const populationWithoutPrebirth = goldMetrics([
    { number: 1, predicted: 'mine', winner: true, score: 0.55 },
    { number: 2, predicted: 'other', winner: true, score: 0.55 },
  ], { 1: true, 2: false }, [
    { label: 'mine' }, { label: 'other' }, { label: 'other', prebirth: true },
  ]);
  assert.equal(populationWithoutPrebirth.atDefault.precision, 0.5);
});

test('매칭·골드·리포트는 임시 경로만 쓰고 메모를 보존한다', async (t) => {
  const f = fixture(t);
  const galleryPath = f.pathFor('mediaFaceGallery');
  mkdirSync(dirname(galleryPath), { recursive: true });
  writeFileSync(galleryPath, JSON.stringify({ bands: {
    '2y': { members: [{ id: 'ref', i: 0 }], clusterSizes: [9, 3], confirmed: true },
    '3y': { members: [], clusterSizes: [2], confirmed: false },
  } }));
  f.save(f.indexPath, [{ id: 'photo', faces: [{ i: 0, bbox: [0, 0, 3, 3] }] }]);
  f.save(f.pathFor('mediaImportsIndex'), [{ id: 'photo', importPath: 'Imports/photo.jpg',
    capturedAt: '2019-01-01', album: 'family' }]);
  mkdirSync(dirname(f.pathFor('mediaImportAlbums')), { recursive: true });
  writeFileSync(f.pathFor('mediaImportAlbums'), JSON.stringify({ albums: {
    family: { category: '200 가족' },
  } }));
  const matches = await matchMediaFaces({ ...f, galleryPath,
    vectorFor: ({ id }) => id === 'ref' ? [1, 0] : [0.8, 0.6] });
  assert.equal(matches[0].label, 'mine');
  assert.doesNotMatch(readFileSync(join(f.out, 'matches.jsonl'), 'utf8'), /bbox|vector/);
  const sample = await goldSheetMediaFaces({ ...f, count: 10,
    cropper: async (images) => images.map((image) => image.out) });
  assert.equal(sample.length, 1);
  assert.equal(existsSync(join(f.out, 'sheets', 'gold.html')), true);
  assert.equal(existsSync(join(f.out, 'sheets', 'gold.json')), true);
  const labelsPath = join(f.out, 'input.txt');
  writeFileSync(labelsPath, '\uFEFF미네가 아닌 번호:  \n미네인데 아니라고 한 번호:  \n');
  await recordGoldLabels(labelsPath, { out: f.out, output: f.output });
  const rules = [{ type: 'report', path: '50_Outputs/Reports/{YYYY}/',
    pathRegex: /^50_Outputs\/Reports\/\d{4}\/[^/]+\.md$/,
    titleRegex: /^2026-10-14 /, required: {
      bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'],
      extra: ['author', 'model'],
    } }];
  const options = { ...f, galleryPath, registryRules: rules, now: '2026-10-14T03:00:00Z' };
  await reportMediaFaces(options);
  const path = join(f.root, VAULT_REL.mediaFaceReports, '2026', '2026-10-14 미네 얼굴 인식 검증.md');
  const first = readFileSync(path, 'utf8');
  assert.match(first, /2부/);
  assert.match(first, /미네 앨범 밖 미네 판정: 1장/);
  assert.match(first, /500 기술/);
  assert.match(first, /gold\.html/);
  assert.match(first, /0\.30.*0\.35.*0\.40/s);
  assert.match(first, /InsightFace buffalo_l/);
  assert.match(first, /검출 0\.7, 최소 크기 60px/);
  assert.match(first, /\| 3y \| 0 \| 1 \| 2 \| 0 \| 아니오 \| 0 \| 0 \| 0 \|/);
  writeFileSync(path, `${first}오너가 남긴 메모\n`);
  await reportMediaFaces(options);
  assert.match(readFileSync(path, 'utf8'), /오너가 남긴 메모/);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /photo|bbox|vector/);
  const saved = readFileSync(path, 'utf8');
  writeFileSync(path, saved.replace('<!-- media-faces:generated:end -->', ''));
  await assert.rejects(reportMediaFaces(options), /표식\/소유권/);
  writeFileSync(path, saved);
  f.save(join(f.out, 'matches.jsonl'), [{ ...matches[0], score: 0.2, label: 'other' }]);
  await assert.rejects(reportMediaFaces(options), /골드 표본과 현재 판정/);
});

test('리포트는 출생 이전 오탐률과 날짜 모름을 별도 집계한다', async (t) => {
  const f = fixture(t);
  const galleryPath = f.pathFor('mediaFaceGallery');
  mkdirSync(dirname(galleryPath), { recursive: true });
  writeFileSync(galleryPath, JSON.stringify({ bands: { '2y': { members: [{ id: 'ref', i: 0 }] } } }));
  const prebirthScores = [0.39, 0.4, 0.5, 0.7, null];
  const matches = prebirthScores.map((score, index) => ({ id: `old${index}`, i: 0,
    band: null, score, label: 'other', reason: '출생 이전', prebirth: true }));
  matches.push({ id: 'unknown', i: 0, band: null, score: 0.6, label: 'mine', bandless: true });
  f.save(join(f.out, 'matches.jsonl'), matches);
  f.save(f.pathFor('mediaImportsIndex'), [
    ...prebirthScores.map((_, index) => ({ id: `old${index}`, album: 'old',
      importPath: `Imports/old${index}.jpg`, capturedAt: '2016-11-03' })),
    { id: 'unknown', album: 'unknown', importPath: 'Imports/unknown.jpg' },
  ]);
  const registryRules = [{ type: 'report', path: '50_Outputs/Reports/{YYYY}/',
    pathRegex: /^50_Outputs\/Reports\/\d{4}\/[^/]+\.md$/,
    titleRegex: /^2026-10-14 /, required: {
      bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'],
      extra: ['author', 'model'],
    } }];
  await reportMediaFaces({ ...f, galleryPath, registryRules, now: '2026-10-14T00:00:00Z' });
  const path = join(f.root, VAULT_REL.mediaFaceReports, '2026', '2026-10-14 미네 얼굴 인식 검증.md');
  const report = readFileSync(path, 'utf8');
  assert.match(report, /출생 이전 사진으로 잰 오탐률\(오너 확인 불필요\)/);
  assert.match(report, /인접 나이대 기준이 5개 이상일 때는.*5개 미만이면 엄밀한 상한을 보장하지 않는다/);
  assert.match(report, /출생 이전 얼굴: 5개/);
  assert.match(report, /\| 0\.40 \| 3 \| 60\.0% \|/);
  assert.match(report, /\| 0\.70 \| 1 \| 20\.0% \|/);
  assert.match(report, /날짜 모름\(bandless\) 얼굴: 1개 · 미네 판정: 1개/);
  assert.match(report, /\| 출생 이전 \| 0 \| 1 \| 없음 \| 0 \| 아니오 \| 0 \| 0 \| 5 \|/);
  assert.match(report, /\| 날짜 모름\(bandless\) \| 0 \| 1 \| 없음 \| 0 \| 아니오 \| 1 \| 0 \| 0 \|/);
  assert.match(report, /\| old \| 5 \| 0 \| 100\.0% \|/);
});

test('출생 이전 얼굴이 남은 오래된 골드 표본은 점수와 레이블이 같아도 거부한다', async (t) => {
  const f = fixture(t);
  const galleryPath = f.pathFor('mediaFaceGallery');
  mkdirSync(dirname(galleryPath), { recursive: true });
  writeFileSync(galleryPath, JSON.stringify({ bands: {} }));
  const sample = [{ number: 1, id: 'old', i: 0, band: null, score: 0.2,
    predicted: 'other', winner: true }];
  f.save(join(f.out, 'matches.jsonl'), [{ id: 'old', i: 0, band: null, score: 0.2,
    label: 'other', reason: '출생 이전', prebirth: true }]);
  mkdirSync(join(f.out, 'sheets'), { recursive: true });
  writeFileSync(join(f.out, 'sheets', 'gold.json'), JSON.stringify({ sample }));
  writeFileSync(join(f.out, 'gold-labels.json'), JSON.stringify({ sample, labels: { 1: false } }));
  await assert.rejects(reportMediaFaces({ ...f, galleryPath }), /골드 표본과 현재 판정이 다릅니다.*--gold-sheet/);
});
