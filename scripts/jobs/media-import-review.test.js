import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync,
  symlinkSync, linkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { runImportMoments } from './media-imports.mjs';
import { candidateDates, groupReviewRecords, renderReviewHtml, writeReviewSheet, applyReview, thumbnail } from './media-import-review.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'import-review-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const mediaRoot = join(base, 'media');
  const indexPath = join(root, VAULT_REL.mediaImportsIndex);
  const albumPath = join(root, VAULT_REL.mediaImportAlbums);
  mkdirSync(dirname(indexPath), { recursive: true });
  mkdirSync(join(mediaRoot, 'Imports', 'A'), { recursive: true });
  writeFileSync(albumPath, JSON.stringify({ albums: { A: { label: '가족', years: [2017, 2017] } } }));
  function row(name, confidence = 'review', at = '2017-05-03T15:00:00+09:00') {
    const path = join(mediaRoot, 'Imports', 'A', name);
    writeFileSync(path, 'photo');
    const stat = statSync(path);
    return { kind: 'Import', id: name, importPath: `Imports/A/${name}`, album: 'A',
      size: stat.size, mtime: stat.mtimeMs, capturedAt: at, capturedConfidence: confidence };
  }
  function save(rows) { writeFileSync(indexPath, rows.map((record) => JSON.stringify(record)).join('\n') + '\n'); }
  const metadataForRecords = async () => new Map();
  return { root, mediaRoot, indexPath, row, save, metadataForRecords, output: { log() {} } };
}

test('후보 출처와 연사/앨범/기종 묶음, 확정 이웃', () => {
  const records = [
    { kind: 'Import', id: '1', album: 'A', importPath: 'Imports/A/IMG_20170503_150000.jpg',
      size: 1, mtime: Date.parse('2017-05-04'), capturedAt: '2017-05-03T15:00:00+09:00', capturedConfidence: 'review' },
    { kind: 'Import', id: '2', album: 'A', importPath: 'Imports/A/IMG_20170503_150100.jpg',
      size: 1, mtime: Date.parse('2017-05-04'), capturedAt: '2017-05-03T15:01:00+09:00', capturedConfidence: 'review' },
    { kind: 'Import', id: '3', album: 'A', importPath: 'Imports/A/IMG_20170503_170000.jpg',
      size: 1, mtime: Date.parse('2017-05-04'), capturedAt: '2017-05-03T17:00:00+09:00', capturedConfidence: 'estimated' },
  ];
  const candidates = candidateDates(records[0], { DateTimeOriginal: '2017:05:05 15:00:00' }, { years: [2017, 2017] });
  assert.ok(candidates.some((item) => item.date === '2017-05-05' && item.source === 'EXIF DateTimeOriginal'));
  assert.ok(candidates.some((item) => item.date === '2017-05-03' && item.source === '파일명'));
  assert.ok(candidates.some((item) => item.source.startsWith('파일 수정 시각')));
  assert.ok(candidates.some((item) => item.date === '2017' && item.source.startsWith('앨범')));
  const albums = { A: { label: '가족', years: [2017, 2017] } };
  assert.deepEqual(groupReviewRecords(records, albums).map((group) => group.records.length), [2]);
  assert.deepEqual(groupReviewRecords(records, albums, new Map(), { includeEstimated: true })
    .map((group) => group.records.length), [2, 1]);
});

test('중복·스크린샷도 판정 목록과 색인 반영에 포함하고 순간 필터는 유지한다', async (t) => {
  const f = fixture(t);
  const rows = [
    f.row('review-normal.jpg'),
    { ...f.row('review-duplicate.jpg'), duplicateOf: 'archive:original' },
    { ...f.row('review-screenshot.jpg'), screenshot: true },
    f.row('estimated-normal.jpg', 'estimated'),
    { ...f.row('estimated-duplicate.jpg', 'estimated'), duplicateOf: 'import:original' },
  ];
  f.save(rows);
  const albums = { A: { label: '가족' } };
  assert.equal(groupReviewRecords(rows, albums).flatMap((group) => group.records).length, 3);
  const allGroups = groupReviewRecords(rows, albums, new Map(), { includeEstimated: true });
  assert.equal(allGroups.flatMap((group) => group.records).length, 5);
  const sheet = await writeReviewSheet({ ...f, includeEstimated: true,
    thumbnailFor: async () => 'data:image/jpeg;base64,YQ==' });
  assert.equal(sheet.groups, allGroups.length);
  const answersPath = join(f.mediaRoot, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ version: 1, includeEstimated: true,
    answers: Object.fromEntries(allGroups.map((group) => [group.id,
      { action: 'custom', date: '2017-05-06' }])) }));
  let preview;
  const result = await applyReview({ ...f, answersPath, dryRun: true,
    runMoments: async (options) => { preview = options; return { created: 1 }; } });
  assert.equal(result.changed, 5);
  assert.equal(preview.indexRecords.filter((record) => record.reviewDecision === 'custom').length, 5);
  assert.equal(preview.indexRecords.filter((record) => !record.duplicateOf && !record.screenshot).length, 2);
});

test('HTML은 버튼 판정, 즉시 결과, 진행률, JSON 내보내기를 포함한다', () => {
  const html = renderReviewHtml([{ id: 'abc', label: '<가족>', device: '폰', records: [{}],
    candidates: [{ date: '2017-05-03', source: 'EXIF' }], neighbors: [], thumbnails: [] }]);
  for (const text of ['data-action="date"', 'data-action="custom"', 'data-action="album"',
    'data-action="exclude"', 'JSON 내보내기', '진행률', 'class="result"', 'Blob']) assert.ok(html.includes(text));
  assert.ok(html.includes('&lt;가족&gt;'));
  assert.ok(!html.includes('<가족>'));
});

test('시트는 0600 단일 파일이며 썸네일은 별도 파일을 만들지 않는다', async (t) => {
  const f = fixture(t);
  const rows = [f.row('IMG_20170503_150000.jpg')];
  f.save(rows);
  const outputDir = join(f.mediaRoot, 'ImportReview');
  mkdirSync(outputDir, { mode: 0o755 });
  const result = await writeReviewSheet({ ...f, outputDir, thumbnailFor: async () => 'data:image/jpeg;base64,YQ==' });
  assert.equal(result.groups, 1);
  assert.equal(statSync(result.path).mode & 0o777, 0o600);
  assert.equal(statSync(outputDir).mode & 0o777, 0o700);
  assert.match(readFileSync(result.path, 'utf8'), /data:image\/jpeg;base64,YQ==/);
  assert.equal(existsSync(join(outputDir, 'thumb.jpg')), false);
});

test('시트 출력 파일 심링크를 따라 쓰지 않는다', async (t) => {
  const f = fixture(t);
  f.save([f.row('x.jpg')]);
  const outputDir = join(f.mediaRoot, 'ImportReview');
  mkdirSync(outputDir);
  const target = join(f.mediaRoot, 'outside.txt');
  writeFileSync(target, 'keep');
  symlinkSync(target, join(outputDir, 'import-review.html'));
  await assert.rejects(writeReviewSheet({ ...f, outputDir, thumbnailFor: async () => 'data:image/jpeg;base64,YQ==' }),
    /ELOOP|symbolic link/i);
  assert.equal(readFileSync(target, 'utf8'), 'keep');
});

test('기존 시트가 다른 파일과 하드링크여도 원본은 보존하고 0600 시트로 교체한다', async (t) => {
  const f = fixture(t);
  f.save([f.row('x.jpg')]);
  const outputDir = join(f.mediaRoot, 'ImportReview');
  mkdirSync(outputDir);
  const vaultFile = join(f.root, 'protected.txt');
  writeFileSync(vaultFile, 'keep');
  const sheetPath = join(outputDir, 'import-review.html');
  linkSync(vaultFile, sheetPath);
  await writeReviewSheet({ ...f, outputDir, thumbnailFor: async () => 'data:image/jpeg;base64,YQ==' });
  assert.equal(readFileSync(vaultFile, 'utf8'), 'keep');
  assert.match(readFileSync(sheetPath, 'utf8'), /과거 앨범 날짜 판정/);
  assert.notEqual(statSync(vaultFile).ino, statSync(sheetPath).ino);
  assert.equal(statSync(sheetPath).mode & 0o777, 0o600);
  assert.equal(readdirSync(outputDir).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('썸네일은 긴 변 512 이하이고 GPS 메타데이터를 포함하지 않는다', async (t) => {
  const f = fixture(t);
  const source = join(f.mediaRoot, 'Imports', 'A', 'location.jpg');
  execFileSync('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'color=c=red:s=640x480', '-frames:v', '1', source]);
  execFileSync('/opt/homebrew/bin/exiftool', ['-overwrite_original', '-GPSLatitude=37.5',
    '-GPSLongitude=127.1', source]);
  const stat = statSync(source);
  const record = { kind: 'Import', id: 'gps', album: 'A', importPath: 'Imports/A/location.jpg',
    size: stat.size, mtime: stat.mtimeMs };
  const dataUrl = await thumbnail(record, f.mediaRoot);
  const result = join(f.mediaRoot, 'thumbnail.jpg');
  writeFileSync(result, Buffer.from(dataUrl.slice('data:image/jpeg;base64,'.length), 'base64'));
  const dimensions = JSON.parse(execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error',
    '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', result]));
  assert.ok(Math.max(dimensions.streams[0].width, dimensions.streams[0].height) <= 512);
  const gps = execFileSync('/opt/homebrew/bin/exiftool', ['-GPSLatitude', '-GPSLongitude', result], { encoding: 'utf8' });
  assert.equal(gps.trim(), '');
});

test('dry-run은 색인/순간을 쓰지 않고 예상 색인을 전달한다; 재실행은 변경 0', async (t) => {
  const f = fixture(t);
  const rows = [f.row('IMG_20170503_150000.jpg')];
  f.save(rows);
  const group = groupReviewRecords(rows, { A: { label: '가족', years: [2017, 2017] } })[0];
  const answersPath = join(f.mediaRoot, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ version: 1, includeEstimated: false,
    answers: { [group.id]: { action: 'custom', date: '2017-05-06' } } }));
  let preview;
  const runMoments = async (options) => { preview = options; return { created: 1 }; };
  const before = readFileSync(f.indexPath, 'utf8');
  const dry = await applyReview({ ...f, answersPath, dryRun: true, runMoments });
  assert.equal(dry.changed, 1);
  assert.equal(readFileSync(f.indexPath, 'utf8'), before);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.indexRecords[0].capturedAt.slice(0, 10), '2017-05-06');
  assert.equal(preview.limit, 300);
  const applied = await applyReview({ ...f, answersPath, runMoments });
  assert.equal(applied.changed, 1);
  assert.equal(preview.dryRun, false);
  assert.equal(preview.noCalendar, undefined);
  assert.equal(preview.noPoi, undefined);
  assert.equal((await applyReview({ ...f, answersPath, runMoments })).changed, 0);
  assert.equal(JSON.parse(readFileSync(f.indexPath, 'utf8')).capturedConfidence, 'single');
});

test('301묶음 제한 뒤 같은 답안 재실행에서 301개를 다시 순간 범위에 넣는다', async (t) => {
  const f = fixture(t);
  const base = Date.parse('2017-05-03T00:00:00+09:00');
  const rows = Array.from({ length: 301 }, (_, index) => f.row(`file${index}.jpg`, 'review',
    new Date(base + index * 11 * 60_000).toISOString()));
  f.save(rows);
  const groups = groupReviewRecords(rows, { A: { label: '가족' } });
  assert.equal(groups.length, 301);
  const answersPath = join(f.mediaRoot, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ version: 1, includeEstimated: false,
    answers: Object.fromEntries(groups.map((group) => [group.id, { action: 'custom', date: '2017-05-06' }])) }));
  const calls = [];
  const runMoments = async (options) => {
    calls.push({ dryRun: options.dryRun, count: options.reviewIds.size, limit: options.limit });
    return { unprocessed: options.dryRun ? 301 : calls.length === 2 ? 1 : 0 };
  };
  assert.equal((await applyReview({ ...f, answersPath, runMoments })).changed, 301);
  assert.equal((await applyReview({ ...f, answersPath, runMoments })).changed, 0);
  assert.deepEqual(calls, [
    { dryRun: true, count: 301, limit: 300 }, { dryRun: false, count: 301, limit: 300 },
    { dryRun: true, count: 301, limit: 300 }, { dryRun: false, count: 301, limit: 300 },
  ]);
});

test('제외 유지는 색인에 기록되어 재생성 시트에서 빠지고 재실행 변경 0', async (t) => {
  const f = fixture(t);
  const rows = [f.row('x.jpg')];
  f.save(rows);
  const group = groupReviewRecords(rows, { A: { label: '가족' } })[0];
  const answersPath = join(f.mediaRoot, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ version: 1, includeEstimated: false,
    answers: { [group.id]: { action: 'exclude', date: null } } }));
  assert.equal((await applyReview({ ...f, answersPath })).changed, 1);
  assert.equal((await applyReview({ ...f, answersPath })).changed, 0);
  const sheet = await writeReviewSheet({ ...f, thumbnailFor: async () => 'data:image/jpeg;base64,YQ==' });
  assert.equal(sheet.groups, 0);
});

test('날짜 미상은 확정으로 표시하지 않고 앨범 순간 대상으로 전달한다', async (t) => {
  const f = fixture(t);
  const rows = [f.row('IMG_20170503_150000.jpg')];
  f.save(rows);
  const group = groupReviewRecords(rows, { A: { label: '가족' } })[0];
  const answersPath = join(f.mediaRoot, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ version: 1, includeEstimated: false,
    answers: { [group.id]: { action: 'album', date: null } } }));
  let preview;
  await applyReview({ ...f, answersPath, dryRun: true,
    runMoments: async (options) => { preview = options.indexRecords[0]; } });
  assert.equal(preview.capturedConfidence, 'album');
  assert.equal(preview.capturedReason, '날짜 미상: 앨범 기준');
  assert.equal(preview.capturedAt, rows[0].capturedAt);
  const rules = [{ type: 'media', path: `${VAULT_REL.mediaMoments}/{YYYY}/`,
    pathRegex: /^20_Records\/24_Media\/\d{4}\/[^/]+\.md$/,
    titleRegex: /^\d{4}-\d{2}-\d{2} \S/,
    required: { bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'],
      extra: ['occurred', 'origin', 'mediaCount'] } }];
  const moments = await runImportMoments({ root: f.root, indexRecords: [preview], reviewIds: new Set([preview.id]),
    noCalendar: true, dryRun: true, places: [], registryRules: rules, output: f.output });
  assert.match(moments.examples[0], /날짜 미상 · 가족/);
  const deferred = await runImportMoments({ root: f.root, indexRecords: [preview], reviewIds: new Set([preview.id]),
    noCalendar: true, places: [], registryRules: rules, output: f.output });
  assert.equal(deferred.deferred, 1);
  assert.equal(existsSync(join(f.root, VAULT_REL.mediaImportMomentsState)), false);
  mkdirSync(dirname(join(f.root, VAULT_REL.registryFile)), { recursive: true });
  writeFileSync(join(f.root, VAULT_REL.registryFile),
    '| `media` | `20_Records/24_Media/0000/` | `0000-00-00 날짜 미상 순간` | `occurred: 날짜 미상` · `dateCertainty` |\n');
  await runImportMoments({ root: f.root, indexRecords: [preview], reviewIds: new Set([preview.id]),
    noCalendar: true, places: [], registryRules: rules, output: f.output });
  const state = JSON.parse(readFileSync(join(f.root, VAULT_REL.mediaImportMomentsState), 'utf8'));
  assert.match(state[preview.id].notePath, /\/0000\/0000-00-00 날짜 미상 · 가족/);
  const note = readFileSync(join(f.root, state[preview.id].notePath), 'utf8');
  assert.match(note, /dateCertainty: "unknown"/);
  assert.match(note, /occurred: "날짜 미상"/);
  assert.doesNotMatch(note, /^startAt:|^endAt:/m);
  assert.doesNotMatch(note, /occurred: "2017-05-03/);
  assert.match(note, /infoSource: "album"/);
  assert.match(note, /촬영 날짜 미상 \(앨범 기준/);
});

test('임의 ID/경로 삽입과 잘못된 날짜를 거부한다', async (t) => {
  const f = fixture(t);
  const rows = [f.row('IMG_20170503_150000.jpg')];
  f.save(rows);
  const answersPath = join(f.mediaRoot, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ version: 1, includeEstimated: false,
    answers: { forged: { action: 'date', date: '2017-05-03', importPath: '../../evil' } } }));
  await assert.rejects(applyReview({ ...f, answersPath }), /묶음 불일치/);
  const group = groupReviewRecords(rows, { A: { label: '가족', years: [2017, 2017] } })[0];
  writeFileSync(answersPath, JSON.stringify({ version: 1, includeEstimated: false,
    answers: { [group.id]: { action: 'custom', date: '2017-02-30' } } }));
  await assert.rejects(applyReview({ ...f, answersPath }), /날짜 오류/);
  writeFileSync(answersPath, JSON.stringify({ version: 1, includeEstimated: false,
    answers: { [group.id]: null } }));
  await assert.rejects(applyReview({ ...f, answersPath }), /판정 선택 오류/);
  writeFileSync(answersPath, JSON.stringify({ version: 1, includeEstimated: false,
    answers: { [group.id]: { action: 'custom', date: '2999-01-01' } } }));
  await assert.rejects(applyReview({ ...f, answersPath }), /날짜 오류/);
});

test('앨범 연도에서 크게 벗어난 직접 입력은 경고하고 유효한 판정을 유지한다', async (t) => {
  const f = fixture(t);
  const rows = [f.row('old.jpg')];
  f.save(rows);
  const group = groupReviewRecords(rows, { A: { years: [2017, 2017] } })[0];
  const answersPath = join(f.mediaRoot, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ version: 1, includeEstimated: false,
    answers: { [group.id]: { action: 'custom', date: '2020-05-03' } } }));
  const warnings = [];
  await applyReview({ ...f, answersPath, dryRun: true,
    output: { log() {}, warn(message) { warnings.push(message); } } });
  assert.match(warnings[0], /판정 연도 경고.*2020/);
});

test('기존 순간의 첫 파일이 바뀌어도 기존 노트와 오너 메모를 이관한다', async (t) => {
  const f = fixture(t);
  const old = f.row('old.jpg', 'single', '2017-05-03T15:01:00+09:00');
  const fresh = f.row('new.jpg', 'single', '2017-05-03T15:00:00+09:00');
  f.save([old]);
  const registryRules = [{ type: 'media', path: `${VAULT_REL.mediaMoments}/{YYYY}/`,
    pathRegex: /^20_Records\/24_Media\/\d{4}\/[^/]+\.md$/,
    titleRegex: /^\d{4}-\d{2}-\d{2} \S/,
    required: { bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'],
      extra: ['occurred', 'origin', 'mediaCount'] } }];
  const options = { root: f.root, noCalendar: true, places: [], registryRules, output: f.output };
  await runImportMoments(options);
  const statePath = join(f.root, VAULT_REL.mediaImportMomentsState);
  const oldPath = join(f.root, JSON.parse(readFileSync(statePath, 'utf8'))[old.id].notePath);
  writeFileSync(oldPath, readFileSync(oldPath, 'utf8') + '보존할 오너 메모\n');
  const nextRecords = [old, fresh];
  await runImportMoments({ ...options, dryRun: true, indexRecords: nextRecords, reviewIds: new Set([fresh.id]) });
  await runImportMoments({ ...options, indexRecords: nextRecords, reviewIds: new Set([fresh.id]) });
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state[old.id], undefined);
  assert.equal(Object.keys(state).length, 1);
  const note = readFileSync(join(f.root, state[fresh.id].notePath), 'utf8');
  assert.match(note, /보존할 오너 메모/);
  assert.match(note, /momentId: "new.jpg"/);
  assert.equal(readdirSync(join(f.root, VAULT_REL.mediaMoments, '2017')).filter((name) => name.endsWith('.md')).length, 1);
});

test('순간 사전 검증 실패 시 색인은 쓰지 않는다', async (t) => {
  const f = fixture(t);
  const rows = [f.row('x.jpg')];
  f.save(rows);
  const group = groupReviewRecords(rows, { A: { label: '가족' } })[0];
  const answersPath = join(f.mediaRoot, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ version: 1, includeEstimated: false,
    answers: { [group.id]: { action: 'custom', date: '2017-05-06' } } }));
  const before = readFileSync(f.indexPath, 'utf8');
  await assert.rejects(applyReview({ ...f, answersPath,
    runMoments: async ({ dryRun }) => { if (dryRun) throw Error('쓰기 관문 실패'); } }), /쓰기 관문 실패/);
  assert.equal(readFileSync(f.indexPath, 'utf8'), before);
});

test('두 기존 순간을 한 순간으로 합치는 판정은 색인 쓰기 전 보류한다', async (t) => {
  const f = fixture(t);
  const first = f.row('first.jpg', 'single', '2017-05-03T15:00:00+09:00');
  const middle = f.row('middle.jpg', 'review', '2017-05-03T16:00:00+09:00');
  const last = f.row('last.jpg', 'single', '2017-05-03T17:00:00+09:00');
  f.save([first, middle, last]);
  const registryRules = [{ type: 'media', path: `${VAULT_REL.mediaMoments}/{YYYY}/`,
    pathRegex: /^20_Records\/24_Media\/\d{4}\/[^/]+\.md$/,
    titleRegex: /^\d{4}-\d{2}-\d{2} \S/,
    required: { bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'],
      extra: ['occurred', 'origin', 'mediaCount'] } }];
  const runMoments = (options) => runImportMoments({ ...options, registryRules, places: [], output: f.output });
  await runMoments({ root: f.root, noCalendar: true });
  const group = groupReviewRecords([first, middle, last], { A: { label: '가족' } })[0];
  const answersPath = join(f.mediaRoot, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ version: 1, includeEstimated: false,
    answers: { [group.id]: { action: 'custom', date: '2017-05-03' } } }));
  const before = readFileSync(f.indexPath, 'utf8');
  await assert.rejects(applyReview({ ...f, answersPath, runMoments }), /순간 병합 판정 보류/);
  assert.equal(readFileSync(f.indexPath, 'utf8'), before);
});
