import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { labelMediaFaces, parseFamilyConfirm, parseFamilyExclusions, renderFamilySheet, renderFaceSheet,
  parseHoldAnswers, renderHoldSheet, holdSampleHash, matchMediaFaces, runFacePipeline,
  parseFacePipelineArgs, selectPersonGoldSample, holdSheetMediaFaces,
  validatePersonGold, selectFamilyDisplay, confirmFamilyFaces, confirmHoldFaces } from './media-faces.mjs';
import { refreshMomentPeople, render as renderMoment } from './media-moments.mjs';

test('이름표 색인·보류 결과·가족 확인 시트는 임시 경로에서 이름과 ID만 기록한다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'faces-labels-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'vault');
  const out = join(temp, 'faces');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'matches.jsonl'), `${JSON.stringify({ id: 'p1', i: 0, score: 0.5, label: 'mine' })}\n`);
  const peoplePath = join(root, VAULT_REL.mediaFacePeople);
  mkdirSync(dirname(peoplePath), { recursive: true });
  const result = await labelMediaFaces({ root, out, now: '2026-10-14T00:00:00Z', output: { log() {} } });
  assert.deepEqual(result.photos.p1.people, ['미네']);
  assert.doesNotMatch(readFileSync(peoplePath, 'utf8'), /score|bbox|vector/);
  assert.deepEqual(parseFamilyConfirm('휘영:3,7;나:1', 7), { 휘영: [3, 7], 나: [1] });
  assert.throws(() => parseFamilyConfirm('휘영:1;나:1', 7));
  assert.deepEqual(parseHoldAnswers('미네: 1', [{ number: 1 }]), [1]);
  assert.match(renderHoldSheet([{ number: 1, id: 'p1', i: 0 }]), /아님/);
  const html = renderFamilySheet([[{ id: 'p1', i: 0 }]]);
  assert.match(html, /family-confirm/);
  assert.doesNotMatch(html, /https?:\/\/|bbox|vector|score/);
});

test('가족 골드 판정은 현재 사람·점수·예측과 시트가 바뀌면 리포트를 막는다', () => {
  const sample = [{ number: 1, id: 'photo', i: 0, person: '휘영', score: 0.55,
    predicted: 'mine', band: '0-6m' }];
  const gold = { sample, labels: { 1: true } };
  const sheet = { sample };
  const matches = [{ id: 'photo', i: 0, person: '휘영', score: 0.55, band: '0-6m' }];
  assert.doesNotThrow(() => validatePersonGold('휘영', gold, sheet, matches));
  assert.throws(() => validatePersonGold('휘영', gold, sheet,
    [{ ...matches[0], score: 0.48 }]), /gold-sheet --person=휘영/);
  assert.throws(() => validatePersonGold('휘영', gold, sheet,
    [{ ...matches[0], person: '나' }]), /gold-sheet --person=휘영/);
  assert.throws(() => validatePersonGold('휘영', gold, { sample: [] }, matches), /gold-sheet --person=휘영/);
});

test('가족 시트는 최대 24개를 안정적으로 보여주고 확인은 보인 얼굴만 기준으로 삼는다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'family-display-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'vault');
  const out = join(temp, 'faces');
  const members = Array.from({ length: 40 }, (_, index) => ({ id: `p${index}`, i: 0 }));
  const shown = selectFamilyDisplay(members, 1);
  assert.equal(shown.length, 24);
  assert.deepEqual(shown, selectFamilyDisplay(members, 1));
  assert.deepEqual(shown.slice(0, 12), members.slice(0, 12));
  assert.ok(shown.some((member) => Number(member.id.slice(1)) >= 24));
  const sheetPath = join(out, 'sheets', 'family.json');
  const galleryPath = join(root, VAULT_REL.mediaFaceGallery);
  mkdirSync(dirname(sheetPath), { recursive: true });
  mkdirSync(dirname(galleryPath), { recursive: true });
  writeFileSync(sheetPath, JSON.stringify({ clusters: [members], displayed: { 1: shown } }));
  writeFileSync(galleryPath, JSON.stringify({ bands: {} }));
  const gallery = await confirmFamilyFaces('휘영:1', { root, out, output: { log() {} } });
  assert.deepEqual(gallery.people.휘영.members, shown);
  // 오너가 누른 얼굴(묶음.얼굴번호)은 기준에서 빠진다.
  const trimmed = await confirmFamilyFaces('휘영:1;제외:1.2,1.24', { root, out, output: { log() {} } });
  assert.deepEqual(trimmed.people.휘영.members, shown.filter((_, index) => index !== 1 && index !== 23));
  await assert.rejects(confirmFamilyFaces('휘영:1;제외:2.1', { root, out, output: { log() {} } }), /제외 번호 오류/);
});

test('가족 시트는 버튼·얼굴 제외·즉시 결과를 갖고 제외 형식을 해석한다', () => {
  const displayed = { 1: [{ id: 'a', i: 0 }, { id: 'b', i: 1 }], 2: [{ id: 'c', i: 0 }] };
  assert.deepEqual(parseFamilyConfirm('휘영:1;나:2;제외:1.2', 2), { 휘영: [1], 나: [2] });
  assert.deepEqual([...parseFamilyExclusions('휘영:1;제외:1.2', displayed).get(1)], [2]);
  assert.equal(parseFamilyExclusions('휘영:1', displayed).size, 0);
  assert.throws(() => parseFamilyExclusions('제외:1.3', displayed), /제외 번호 오류/);
  assert.throws(() => parseFamilyExclusions('제외:1.1;제외:1.2', displayed), /한 번만/);
  const html = renderFamilySheet(Object.values(displayed));
  assert.match(html, /data-name="휘영"/);
  assert.match(html, /data-name="기타"/);
  assert.match(html, /data-face="2"/);
  assert.match(html, /localStorage/);
  assert.match(html, /제외:/);
  assert.doesNotMatch(html, /https?:\/\/|bbox|vector|score|<select/);
});

test('보류함 미네 0개 답은 명시 플래그 전까지 쓰지 않는다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'hold-all-no-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'vault');
  const out = join(temp, 'faces');
  const sheetPath = join(out, 'sheets', 'hold-2020-01.json');
  const input = join(temp, 'hold-2020-01.txt');
  const peoplePath = join(root, VAULT_REL.mediaFacePeople);
  const galleryPath = join(root, VAULT_REL.mediaFaceGallery);
  for (const path of [sheetPath, peoplePath, galleryPath]) mkdirSync(dirname(path), { recursive: true });
  const sample = [{ number: 1, id: 'p', i: 0 }];
  writeFileSync(sheetPath, JSON.stringify({ sample, sampleHash: holdSampleHash(sample) }));
  writeFileSync(input, `해시: ${holdSampleHash(sample)}\n미네: `);
  writeFileSync(peoplePath, JSON.stringify({ photos: {} }));
  writeFileSync(galleryPath, JSON.stringify({ bands: {} }));
  assert.equal(await confirmHoldFaces(input, { root, out, output: { log() {} } }), null);
  assert.deepEqual(JSON.parse(readFileSync(peoplePath, 'utf8')), { photos: {} });
  const applied = await confirmHoldFaces(input, { root, out, allNo: true, output: { log() {} } });
  assert.equal(applied.confirmations.p.미네, false);
});

test('보류 콜라주는 갤러리에서 제외한 얼굴 대신 살아남은 얼굴을 보여 준다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'faces-hold-collage-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'vault');
  const out = join(temp, 'faces');
  const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  put(join(root, VAULT_REL.mediaFaceGallery), JSON.stringify({ bands: { '0-6m': { confirmed: true,
    members: [], removed: [{ id: 'collage', i: 0 }] } } }));
  put(join(root, VAULT_REL.mediaArchiveIndex), `${JSON.stringify({ id: 'collage', capturedAt: '2020-01-01', archivePath: 'Archive/collage.jpg' })}\n`);
  put(join(out, 'matches.jsonl'), `${JSON.stringify({ id: 'collage', i: 0, score: 0.49, label: 'uncertain' })}\n${JSON.stringify({ id: 'collage', i: 1, score: 0.42, label: 'uncertain' })}\n`);
  put(join(out, 'faces-index.jsonl'), `${JSON.stringify({ id: 'collage', faces: [
    { i: 0, bbox: [0, 0, 1, 1] }, { i: 1, bbox: [0, 0, 1, 1] }] })}\n`);
  await holdSheetMediaFaces({ root, out, indexPath: join(out, 'faces-index.jsonl'),
    cropper: async (images) => images.map((image) => image.out), output: { log() {} } });
  const sheet = JSON.parse(readFileSync(join(out, 'sheets', 'hold-2020-01.json'), 'utf8'));
  assert.deepEqual(sheet.sample.map((item) => item.i), [1]);
});

test('합친 명령은 detect→match→label 순서이고 dry-run은 detect까지만 수행한다', async () => {
  assert.deepEqual(parseFacePipelineArgs(['--detect', '--match', '--label', '--limit=4', '--ids=a,b']),
    { limit: 4, ids: ['a', 'b'], dryRun: false });
  assert.throws(() => parseFacePipelineArgs(['--detect', '--match', '--label', '--report']));
  const calls = [];
  const runners = { detect: async (options) => { calls.push(['detect', options.dryRun]); },
    match: async () => { calls.push(['match']); }, label: async () => { calls.push(['label']); } };
  await runFacePipeline(runners);
  assert.deepEqual(calls, [['detect', false], ['match'], ['label']]);
  calls.length = 0;
  await runFacePipeline({ ...runners, dryRun: true });
  assert.deepEqual(calls, [['detect', true]]);
});

test('가족 골드 표본은 사진별 하나만 선택하고 충분하면 40+20을 채운다', () => {
  const matches = [
    ...Array.from({ length: 50 }, (_, index) => ({ id: `high-${index}`, i: 0, person: '휘영', score: 0.6 })),
    ...Array.from({ length: 30 }, (_, index) => ({ id: `hold-${index}`, i: 0, person: '휘영', score: 0.45 })),
    { id: 'high-0', i: 1, person: '휘영', score: 0.9 },
  ];
  const sample = selectPersonGoldSample(matches, '휘영');
  assert.equal(sample.length, 60);
  assert.equal(new Set(sample.map((item) => item.id)).size, 60);
  assert.equal(sample.filter((item) => item.predicted === 'mine').length, 40);
  assert.equal(sample.filter((item) => item.predicted === 'uncertain').length, 20);
});

test('match는 갤러리가 같으면 이미 판정한 사진 ID를 다시 계산하지 않는다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'faces-match-incremental-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'vault');
  const out = join(temp, 'faces');
  const indexPath = join(out, 'faces-index.jsonl');
  const galleryPath = join(root, VAULT_REL.mediaFaceGallery);
  const mediaPath = join(root, VAULT_REL.mediaArchiveIndex);
  for (const path of [indexPath, galleryPath, mediaPath]) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(indexPath, `${JSON.stringify({ id: 'photo', faces: [{ i: 0 }] })}\n${JSON.stringify({ id: 'recovered', error: 'detect failed' })}\n`);
  writeFileSync(galleryPath, JSON.stringify({ bands: { '0-6m': { members: [{ id: 'reference', i: 0 }] } } }));
  writeFileSync(mediaPath, `${JSON.stringify({ id: 'photo', capturedAt: '2017-01-01' })}\n${JSON.stringify({ id: 'recovered', capturedAt: '2017-01-01' })}\n`);
  let called = 0;
  const options = { root, out, indexPath, galleryPath, vectorFor: () => { called += 1; return [1, 0]; },
    output: { log() {} } };
  await matchMediaFaces(options);
  assert.equal(called, 2);
  writeFileSync(indexPath, `${JSON.stringify({ id: 'photo', faces: [{ i: 0 }] })}\n${JSON.stringify({ id: 'recovered', faces: [{ i: 0 }] })}\n`);
  await matchMediaFaces(options);
  assert.equal(called, 4);
  // matches 저장 직후 state 저장 전에 중단된 상태를 재현한다.
  writeFileSync(join(out, 'matches-state.json'), '{}');
  await matchMediaFaces(options);
  assert.equal(called, 4);
  assert.equal(readFileSync(join(out, 'matches.jsonl'), 'utf8').trim().split('\n').length, 2);
  await matchMediaFaces(options);
  assert.equal(called, 4);
  // 얼굴이 0개였던 사진도 새 얼굴 검출이나 촬영 시각 수정이 생기면 다시 판정한다.
  writeFileSync(indexPath, `${JSON.stringify({ id: 'photo', faces: [{ i: 0 }] })}\n${JSON.stringify({ id: 'recovered', faces: [{ i: 0 }] })}\n${JSON.stringify({ id: 'empty', faces: [] })}\n`);
  await matchMediaFaces(options);
  assert.equal(called, 4);
  writeFileSync(indexPath, `${JSON.stringify({ id: 'photo', faces: [{ i: 0 }] })}\n${JSON.stringify({ id: 'recovered', faces: [{ i: 0 }] })}\n${JSON.stringify({ id: 'empty', faces: [{ i: 0 }] })}\n`);
  await matchMediaFaces(options);
  assert.equal(called, 6);
  writeFileSync(mediaPath, `${JSON.stringify({ id: 'photo', capturedAt: '2018-01-01' })}\n${JSON.stringify({ id: 'recovered', capturedAt: '2017-01-01' })}\n${JSON.stringify({ id: 'empty', capturedAt: '2017-01-01' })}\n`);
  await matchMediaFaces(options);
  assert.equal(called, 9);
});

test('매칭 상태가 완료여도 사진 얼굴 결과가 하나라도 빠지면 다시 판정한다', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'faces-match-truncated-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'vault');
  const out = join(temp, 'faces');
  const indexPath = join(out, 'faces-index.jsonl');
  const galleryPath = join(root, VAULT_REL.mediaFaceGallery);
  const mediaPath = join(root, VAULT_REL.mediaArchiveIndex);
  for (const path of [indexPath, galleryPath, mediaPath]) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(indexPath, `${JSON.stringify({ id: 'p', faces: [{ i: 0 }, { i: 1 }] })}\n`);
  writeFileSync(galleryPath, JSON.stringify({ bands: {} }));
  writeFileSync(mediaPath, `${JSON.stringify({ id: 'p', capturedAt: '2020-01-01' })}\n`);
  let calls = 0;
  const options = { root, out, indexPath, galleryPath, vectorFor: () => { calls += 1; return [1, 0]; },
    output: { log() {} } };
  await matchMediaFaces(options);
  assert.equal(calls, 2);
  const matchesPath = join(out, 'matches.jsonl');
  const first = readFileSync(matchesPath, 'utf8').trim().split('\n')[0];
  writeFileSync(matchesPath, `${first}\n`);
  await matchMediaFaces(options);
  assert.equal(calls, 4);
  assert.equal(readFileSync(matchesPath, 'utf8').trim().split('\n').length, 2);
});

test('이름표 갱신은 해석 불가 머리말과 쓰기 경합을 세고 다음 노트를 처리한다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'moment-refresh-errors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rels = ['bad.md', 'race.md', 'good.md'].map((name) => `${VAULT_REL.mediaMoments}/2020/${name}`);
  const put = (rel, value) => { const path = join(root, rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  put(VAULT_REL.mediaFacePeople, JSON.stringify({ photos: { p: { people: ['미네'] } } }));
  put(VAULT_REL.mediaMomentsState, JSON.stringify(Object.fromEntries(rels.map((notePath, index) =>
    [index, { notePath, mediaIds: ['p'] }]))));
  put(rels[0], '---\ntype: "media"\ncategory:\n  - "[[01_Home/201 미네]]"\n---\n본문');
  for (const rel of rels.slice(1)) put(rel, '---\ntype: "media"\ncategory: "[[01_Home/500 기술]]"\n---\n본문');
  const result = await refreshMomentPeople({ root, registryRules: [{ type: 'media',
    pathRegex: /^20_Records\/24_Media\//, required: { bundle: [], extra: [] } }],
  write: (path, value) => { if (path.endsWith('race.md')) throw new Error('simulated write race'); writeFileSync(path, value); },
  output: { log() {}, error() {} } });
  assert.equal(result.failed, 2);
  assert.equal(result.changed, 1);
  assert.match(readFileSync(join(root, rels[2]), 'utf8'), /autoPeople/);
  assert.doesNotMatch(readFileSync(join(root, rels[0]), 'utf8'), /autoPeople/);
});

test('기존 Archive·Imports 순간을 dry-run 후 갱신하며 메모와 아테나 필드를 보존한다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'moments-people-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel, value) => { const path = join(root, rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  const noteRel = `${VAULT_REL.mediaMoments}/2020/2020-01-01 순간.md`;
  const original = '---\ntype: "media"\ncategory: "[[01_Home/500 기술]]"\nmomentId: "m1"\nimportance: 4\nmovedFrom: ["old"]\n---\n<!-- media-moments:start -->본문<!-- media-moments:end -->\n오너 메모\n';
  put(noteRel, original);
  put(VAULT_REL.mediaMomentsState, JSON.stringify({ m1: { notePath: noteRel, mediaIds: ['p1'] } }));
  put(VAULT_REL.mediaImportMomentsState, JSON.stringify({}));
  put(VAULT_REL.mediaFacePeople, JSON.stringify({ photos: { p1: { people: ['미네'] } } }));
  const options = { root, registryRules: [{ type: 'media', pathRegex: /^20_Records\/24_Media\//,
    required: { bundle: [], extra: [] } }], output: { log() {} }, now: '2026-10-14T00:00:00Z' };
  const dry = await refreshMomentPeople({ ...options, dryRun: true });
  assert.equal(dry.changed, 1);
  assert.equal(readFileSync(join(root, noteRel), 'utf8'), original);
  const done = await refreshMomentPeople(options);
  assert.equal(done.changed, 1);
  const next = readFileSync(join(root, noteRel), 'utf8');
  assert.match(next, /오너 메모/);
  const fields = parseFrontmatter(next);
  assert.equal(fields.importance, 4);
  assert.deepEqual(fields.movedFrom, ['old']);
  assert.equal(fields.mineFaces, 1);
  assert.deepEqual(fields.people, ['[[30_Wiki/31_People/미네]]']);
  assert.equal((await refreshMomentPeople(options)).changed, 0);
});

test('기존 Imports 순간 갱신은 기본 카테고리 출처를 남겨 다음 렌더가 no-op이다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'moment-import-rerender-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rel = `${VAULT_REL.mediaMoments}/2020/import.md`;
  const path = join(root, rel);
  const record = { id: 'p', capturedAt: '2020-01-01T00:00:00Z', importPath: 'Imports/p.jpg' };
  const description = { summary: '아침', source: 'time' };
  const options = { category: '202 휘영', source: 'import', album: 'family',
    pathField: 'importPath', facePhotos: { p: { people: ['휘영'] } } };
  const initial = renderMoment([record], description, null, '2026-10-14T00:00:00Z', null, options);
  mkdirSync(dirname(path), { recursive: true });
  // 출처 필드가 없던 구형 노트에서 앨범 202 옆에 수동 500을 붙인 경우.
  writeFileSync(path, initial.replace(/^category:.*$/m,
    'category: ["[[01_Home/202 휘영]]", "[[01_Home/500 기술]]"]')
    .replace(/^autoBaseCategory:.*\n/m, ''));
  const put = (name, value) => { const target = join(root, name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, value); };
  put(VAULT_REL.mediaMomentsState, '{}');
  put(VAULT_REL.mediaImportAlbums, JSON.stringify({ albums: { family: { category: '202 휘영' } } }));
  put(VAULT_REL.mediaImportMomentsState, JSON.stringify({ p: { notePath: rel, mediaIds: ['p'] } }));
  put(VAULT_REL.mediaFacePeople, JSON.stringify({ photos: { p: { people: ['휘영'] } } }));
  await refreshMomentPeople({ root, registryRules: [{ type: 'media',
    pathRegex: /^20_Records\/24_Media\//, required: { bundle: [], extra: [] } }],
  output: { log() {}, error() {} }, now: '2026-10-14T00:00:00Z' });
  const refreshed = readFileSync(path, 'utf8');
  assert.deepEqual(parseFrontmatter(refreshed).autoBaseCategory, ['[[01_Home/202 휘영]]']);
  assert.deepEqual(parseFrontmatter(refreshed).category,
    ['[[01_Home/202 휘영]]', '[[01_Home/500 기술]]']);
  const rerendered = renderMoment([record], description, refreshed, '2026-10-14T00:00:00Z', null, options);
  assert.equal(rerendered, refreshed);
  const noFace = { ...record, id: 'q', importPath: 'Imports/q.jpg' };
  const noFaceRel = `${VAULT_REL.mediaMoments}/2020/no-face.md`;
  const noFaceInitial = renderMoment([noFace], description, null, '2026-10-14T00:00:00Z', null,
    { ...options, facePhotos: {} }).replace(/^autoBaseCategory:.*\n/m, '');
  put(noFaceRel, noFaceInitial);
  put(VAULT_REL.mediaImportMomentsState, JSON.stringify({
    p: { notePath: rel, mediaIds: ['p'] }, q: { notePath: noFaceRel, mediaIds: ['q'] },
  }));
  await refreshMomentPeople({ root, registryRules: [{ type: 'media',
    pathRegex: /^20_Records\/24_Media\//, required: { bundle: [], extra: [] } }],
  output: { log() {}, error() {} }, now: '2026-10-14T00:00:00Z' });
  const noFaceRefreshed = readFileSync(join(root, noFaceRel), 'utf8');
  assert.equal(renderMoment([noFace], description, noFaceRefreshed, '2026-10-14T00:00:00Z', null,
    { ...options, facePhotos: {} }), noFaceRefreshed);
});

test('갱신은 Imports 기본 카테고리만 소유하고 수동 카테고리와 오래된 얼굴 필드를 보존·정리한다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'moment-base-ownership-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const family = '[[01_Home/202 휘영]]';
  const manual = '[[01_Home/500 기술]]';
  const cases = [
    { id: 'import', source: 'import', album: 'family', category: [family, manual], mediaIds: ['p1'] },
    { id: 'archive', category: [manual], mediaIds: ['p2'] },
    { id: 'no-face', source: 'import', album: 'family', category: [family, manual], mediaIds: ['p3'] },
    { id: 'stale', category: [manual], mediaIds: ['p4'], mineFaces: 1, mineBasis: 'face',
      people: ['[[30_Wiki/31_People/친구]]'] },
  ];
  const put = (rel, value) => { const path = join(root, rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  const states = { archive: {}, import: {} };
  for (const entry of cases) {
    const rel = `${VAULT_REL.mediaMoments}/2020/${entry.id}.md`;
    put(rel, `${buildFrontmatter({ type: 'media', ...entry })}본문`);
    states[entry.source === 'import' ? 'import' : 'archive'][entry.id] =
      { notePath: rel, mediaIds: entry.mediaIds };
  }
  put(VAULT_REL.mediaMomentsState, JSON.stringify(states.archive));
  put(VAULT_REL.mediaImportMomentsState, JSON.stringify(states.import));
  put(VAULT_REL.mediaImportAlbums, JSON.stringify({ albums: { family: { category: '202 휘영' } } }));
  put(VAULT_REL.mediaFacePeople, JSON.stringify({ photos: {
    p1: { people: ['휘영'] }, p2: { people: ['미네'] },
  } }));
  const options = { root, registryRules: [{ type: 'media', pathRegex: /^20_Records\/24_Media\//,
    required: { bundle: [], extra: [] } }], output: { log() {}, error() {} }, now: '2026-10-14T00:00:00Z' };
  const first = await refreshMomentPeople(options);
  assert.equal(first.failed, 0);
  assert.deepEqual(parseFrontmatter(readFileSync(join(root, states.import.import.notePath), 'utf8')).autoBaseCategory,
    [family]);
  assert.deepEqual(parseFrontmatter(readFileSync(join(root, states.archive.archive.notePath), 'utf8')).autoBaseCategory,
    undefined);
  assert.deepEqual(parseFrontmatter(readFileSync(join(root, states.import['no-face'].notePath), 'utf8')).autoBaseCategory,
    [family]);
  const stale = parseFrontmatter(readFileSync(join(root, states.archive.stale.notePath), 'utf8'));
  assert.equal(stale.mineFaces, undefined);
  assert.equal(stale.mineBasis, undefined);
  assert.deepEqual(stale.people, ['[[30_Wiki/31_People/친구]]']);
  put(VAULT_REL.mediaFacePeople, JSON.stringify({ photos: {} }));
  const second = await refreshMomentPeople(options);
  assert.equal(second.failed, 0);
  for (const entry of cases.slice(0, 3)) {
    const rel = states[entry.source === 'import' ? 'import' : 'archive'][entry.id].notePath;
    const fields = parseFrontmatter(readFileSync(join(root, rel), 'utf8'));
    assert.ok(fields.category.includes(manual));
  }
  assert.equal((await refreshMomentPeople(options)).changed, 0);
});

test('일반 순간 렌더도 얼굴이 사라지면 남은 수동 링크를 보존하며 오래된 파생 필드를 지운다', () => {
  const record = { id: 'p', capturedAt: '2020-01-01T00:00:00Z', archivePath: 'Archive/p.jpg' };
  const description = { summary: '아침', source: 'time' };
  const initial = renderMoment([record], description, null, '2026-10-14T00:00:00Z');
  const withStaleFace = initial.replace(/^category:.*$/m,
    'category: "[[01_Home/500 기술]]"')
    .replace(/^mediaIds:.*$/m, (line) => `${line}\npeople: ["[[30_Wiki/31_People/친구]]"]\nmineFaces: 1\nmineBasis: "face"`);
  const refreshed = renderMoment([record], description, withStaleFace,
    '2026-10-14T00:00:00Z', null, { facePhotos: {} });
  const fields = parseFrontmatter(refreshed);
  assert.equal(fields.mineFaces, undefined);
  assert.equal(fields.mineBasis, undefined);
  assert.deepEqual(fields.people, ['[[30_Wiki/31_People/친구]]']);
  assert.ok(fields.category.includes('[[01_Home/500 기술]]'));
});

test('추가 확인 시트는 이미 보인 얼굴을 빼고 먼 순으로 고르고, 제외는 확인 상태를 유지한다', async () => {
  const { selectTailMembers, removeTailMembers } = await import('../lib/media-face-gallery.mjs');
  const members = [0, 1, 2, 3, 4].map((n) => ({ id: `m${n}`, i: 0 }));
  const vectors = { m0: [1, 0], m1: [1, 0], m2: [0.9, 0.1], m3: [0.2, 0.8], m4: [0, 1] };
  const tail = selectTailMembers(members, [{ id: 'm4', i: 0 }], ({ id }) => vectors[id], 2);
  assert.deepEqual(tail.map((member) => member.id), ['m3', 'm2']);
  const gallery = { bands: { '5y': { members, removed: [{ id: 'x', i: 0 }], confirmed: true } } };
  const updated = removeTailMembers(gallery, '5y', { members, sheet: tail }, [1], 'now');
  assert.deepEqual(updated.bands['5y'].members.map((member) => member.id), ['m0', 'm1', 'm2', 'm4']);
  assert.equal(updated.bands['5y'].confirmed, true);
  assert.equal(updated.bands['5y'].removed.length, 2);
  assert.throws(() => removeTailMembers(gallery, '5y', { members: members.slice(1), sheet: tail }, [1], 'now'), /다시 실행/);
  const html = renderFaceSheet({ band: '5y', state: { members }, sheet: tail, tail: true });
  assert.match(html, /--confirm-tail=/);
  assert.match(html, /추가 확인/);
});
