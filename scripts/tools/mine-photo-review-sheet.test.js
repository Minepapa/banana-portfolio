import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureCriteria } from '../lib/mine-emotion-criteria.fixture.js';
import { PHOTO_KINDS } from '../lib/mine-photo-kind.mjs';
import { anchorExclusions, boxPercent, bucketLabel, buildSheet, compareAnswers, compareFiles, fileStamp, modelReady, ownerReady,
  readModelRows, renderCompare, renderPhotoSheet, samplePhotos, sheetEmotions, sheetPhoto, FACE_PX_BUCKETS, KIND_QUOTAS } from './mine-photo-review-sheet.mjs';

const quiet = { log() {}, error() {} };
const row = (id, kind, px, momentId = `m-${id}`, momentDate = '2024-01-01') => ({ id, path: `p/${id}.jpg`, kind, momentId, momentDate,
  momentRel: `r/${momentId}.md`, metrics: px == null ? { mineFound: false, faceCount: 0 } : { mineFound: true, copyFacePx: px, faceCount: 1, comparableFaces: 1 },
  reason: '이유', chooseReason: '미네 이름표 확인', mineBox: px == null ? null : [10, 10, 20, 20],
  item: { id: momentId, rel: `r/${momentId}.md`, date: momentDate, title: 't', fields: { occurred: momentDate }, memo: '' } });

function pool() {
  const rows = [];
  let n = 0;
  const add = (kind, px, count) => { for (let i = 0; i < count; i += 1) rows.push(row(`${kind}-${px}-${n++}`, kind, px)); };
  add(PHOTO_KINDS.close, 150, 30); add(PHOTO_KINDS.group, 90, 15); add(PHOTO_KINDS.hidden, null, 15);
  for (const [low] of FACE_PX_BUCKETS) add(low < 48 ? PHOTO_KINDS.far : PHOTO_KINDS.close, low + 1, 15);
  add(PHOTO_KINDS.far, 15, 20);
  add(null, null, 5);
  return rows;
}

test('표본: 같은 씨앗이면 같은 결과, 종류 몫·구간 몫, 겹치지 않음, 기준 예시 사진과 그 날 제외', () => {
  const rows = [...pool(), row('anchor', PHOTO_KINDS.close, 200), row('sibling', PHOTO_KINDS.close, 200, 'm-s', '2023-06-03')];
  const exclude = { ids: new Set(['anchor']), dates: new Set(['2023-06-03']) };
  const first = samplePhotos(rows, { exclude, seed: 's' });
  assert.deepEqual(samplePhotos(rows, { exclude, seed: 's' }).picked.map((entry) => entry.id), first.picked.map((entry) => entry.id));
  assert.notDeepEqual(samplePhotos(rows, { exclude, seed: 't' }).picked.map((entry) => entry.id), first.picked.map((entry) => entry.id));
  const ids = first.picked.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, '같은 사진 두 번 없음');
  assert.ok(!ids.includes('anchor') && !ids.includes('sibling'));
  assert.ok(first.picked.every((entry) => entry.kind), '종류 없음은 뽑지 않음');
  for (const [kind, count] of Object.entries(KIND_QUOTAS)) {
    assert.equal(first.picked.filter((entry) => entry.pickedFor === `종류 ${kind}`).length, count);
  }
  for (const [low, high] of FACE_PX_BUCKETS) {
    const bucket = first.picked.filter((entry) => entry.pickedFor === `얼굴 ${low}~${high}px`);
    assert.equal(bucket.length, 5, `${low}~${high}`);
    assert.ok(bucket.every((entry) => entry.metrics.copyFacePx >= low && entry.metrics.copyFacePx < high));
    assert.ok(bucket.every((entry) => entry.kind === PHOTO_KINDS.close || entry.kind === PHOTO_KINDS.far));
  }
  assert.equal(first.picked.length, 80);
  assert.deepEqual(first.shortfalls, []);
});

test('표본: 구간이 종류 몫과 겹치면 다음 사진으로 채우고, 모자라면 모자람으로 남김', () => {
  // 30~40 구간 사진이 6장뿐 — 멀리서 몫이 먼저 가져가면 구간은 남은 것만 받는다.
  const rows = Array.from({ length: 6 }, (_, i) => row(`f${i}`, PHOTO_KINDS.far, 35));
  const result = samplePhotos(rows, { kindQuotas: { [PHOTO_KINDS.far]: 3 }, buckets: [[30, 40]], bucketCount: 5 });
  assert.equal(result.picked.filter((entry) => entry.pickedFor === '얼굴 30~40px').length, 3);
  assert.deepEqual(result.shortfalls, [{ pickedFor: '얼굴 30~40px', want: 5, got: 3 }]);
});

test('표본: 한 순간에서는 먼저 한 장씩, 모자라면 같은 순간 사진으로 채움', () => {
  const rows = [row('a1', PHOTO_KINDS.close, 100, 'A'), row('a2', PHOTO_KINDS.close, 100, 'A'), row('b1', PHOTO_KINDS.close, 100, 'B')];
  const two = samplePhotos(rows, { kindQuotas: { [PHOTO_KINDS.close]: 2 }, buckets: [] });
  assert.deepEqual(new Set(two.picked.map((entry) => entry.momentId)), new Set(['A', 'B']));
  assert.equal(samplePhotos(rows, { kindQuotas: { [PHOTO_KINDS.close]: 3 }, buckets: [] }).picked.length, 3);
});

test('기준 예시 제외 목록: photo: 참조의 id와 날짜만', () => {
  const result = anchorExclusions([{ ref: 'photo:0123456789abcdef', date: '2023-06-03' }, { ref: '20_Records/a.md', date: '2020-01-01' }, {}]);
  assert.deepEqual([...result.ids], ['0123456789abcdef']);
  assert.deepEqual([...result.dates], ['2023-06-03']);
});

test('얼굴 상자 %: 세운 원본 크기 기준, 어긋나면 null', () => {
  assert.deepEqual(boxPercent([300, 400, 600, 800], { width: 3000, height: 4000 }), { left: 10, top: 10, width: 10, height: 10 });
  assert.equal(boxPercent([600, 0, 300, 10], { width: 3000, height: 4000 }), null);
  assert.equal(boxPercent(null, { width: 1, height: 1 }), null);
});

test('시트: 종류·모델 답을 넣지 않고, 감정은 결정 문서의 경보 전 감정, 글자는 이스케이프', () => {
  const emotions = sheetEmotions(fixtureCriteria);
  assert.deepEqual(emotions, ['기쁨', '슬픔', '버럭', '까칠', '소심']);
  const html = renderPhotoSheet([{ no: 1, title: '<b>제목</b>', photoId: 'abc', date: '2024-01-01', age: '만 7세', image: 'data:image/jpeg;base64,AA==',
    box: { left: 1, top: 2, width: 3, height: 4 }, kind: PHOTO_KINDS.far }, { no: 2, title: 't2', photoId: 'def', date: '2024-01-02', image: 'data:,', box: null }],
  { title: '시험', storageKey: 'k', downloadName: 'photo-review-answers-2026-11-01-12-00.json', emotions });
  assert.ok(!html.includes('<b>제목</b>') && html.includes('&lt;b&gt;제목&lt;/b&gt;'));
  for (const word of Object.values(PHOTO_KINDS)) assert.ok(!html.includes(word), `종류 글자 없음: ${word}`);
  for (const emotion of emotions) assert.ok(html.includes(`data-v="${emotion}"`));
  assert.ok(!html.includes('불안'), '2편 감정 없음');
  assert.ok(html.includes('data-v="미네가 안 보임"') && html.includes('data-v="감정 없음"'));
  assert.ok(html.includes('left:1%;top:2%;width:3%;height:4%'));
  assert.equal(html.match(/<button class="toggle">/g).length, 2, '상자 없는 카드도 같은 버튼(기본 화면 차이 없음)');
  assert.equal(html.match(/<span class="none" hidden>/g).length, 2);
  assert.ok(html.includes('data-id="abc"') && html.includes('photo-review-answers-2026-11-01-12-00.json'));
  assert.ok(/try\{A=JSON\.parse\(localStorage/.test(html), '저장소 읽기는 try로 감쌈');
});

test('판 이름: 번호표·답 파일 이름에서 같은 분 단위 판, 브라우저 (1) 허용', () => {
  assert.equal(fileStamp('/x/photo-cards-2026-11-01-12-59.json', 'photo-cards'), '2026-11-01-12-59');
  assert.equal(fileStamp('photo-review-answers-2026-11-01-12-59 (1).json', 'photo-review-answers'), '2026-11-01-12-59');
  assert.equal(fileStamp('review-answers-2026-11-01-12-59.json', 'photo-review-answers'), null);
});

const card = (no, kind, px, extra = {}) => ({ no, title: `t${no}`, photoId: `p${no}`, kind, copyFacePx: px, ...extra });
const owner = (no, read, state, emo, int) => ({ t: `t${no}`, id: `p${no}`, read, state, ...(emo ? { emo, int } : {}) });

test('대조: 종류별 상태·감정·강도 일치, 구간별 표정 읽힘, 가려짐에 미네가 보이는 수', () => {
  const cards = [card(1, PHOTO_KINDS.close, 150), card(2, PHOTO_KINDS.close, 150), card(3, PHOTO_KINDS.far, 35), card(4, PHOTO_KINDS.hidden, null),
    card(5, PHOTO_KINDS.hidden, null), card(6, PHOTO_KINDS.far, 45), card(7, PHOTO_KINDS.close, 70)];
  const answers = { 1: owner(1, '예', '있음', '기쁨', 2), 2: owner(2, '예', '있음', '슬픔', 1), 3: owner(3, '아니오', '모름'),
    4: owner(4, '미네가 안 보임', '모름'), 5: owner(5, '예', '있음', '기쁨', 1), 6: owner(6, '예', '감정 없음'),
    7: { t: 'other', id: 'p7', read: '예', state: '모름' } };
  const model = (no, state, primaryEmotion = null, intensity = null) => [no, { no, state, primaryEmotion, intensity }];
  const modelRows = new Map([model(1, '있음', '기쁨', 2), model(2, '있음', '기쁨', 1), model(3, '있음', '기쁨', 2), model(4, '모름'), model(5, '모름'),
    model(6, '있음', '기쁨', 1), [7, { no: 7, error: '시간 초과' }]]);
  const stats = compareAnswers({ cards, answers, modelRows });
  const close = Object.fromEntries(stats.byKind)[PHOTO_KINDS.close];
  assert.deepEqual([close.cards, close.owner, close.both, close.stateSame, close.emotionSame, close.intensityBase, close.intensitySame], [3, 2, 2, 2, 1, 1, 1]);
  const hidden = Object.fromEntries(stats.byKind)[PHOTO_KINDS.hidden];
  assert.deepEqual([hidden.stateSame, hidden.emotionSame], [1, 1]);
  assert.deepEqual(stats.hidden, { answered: 2, mineVisible: 1, readable: 1 });
  const buckets = Object.fromEntries(stats.byBucket);
  assert.deepEqual(buckets['30~40'].read, { 아니오: 1 });
  assert.deepEqual(buckets['40~50'].read, { 예: 1 });
  assert.equal(buckets['120~'].owner, 2);
  assert.equal(stats.mismatches.length, 1, '7번 오너 답 제목 다름');
  assert.deepEqual([stats.all.both, stats.all.stateSame, stats.all.emotionSame], [6, 3, 2]);
  const report = renderCompare(stats, { stamp: 's', modelRowCount: 7 });
  assert.ok(report.includes('| 얼굴 가까이 | 3 | 2 | 2 | 2/2 (100%) | 1/2 (50%) | 1/1 (100%) | 2/2 (100%) |'));
  assert.ok(report.includes('가려짐 2장 중 미네가 보임 1장'));
  assert.ok(report.includes('모델 답 줄 7개 중 대조에 쓴 6장(사진 id로 대조 0장)'));
  assert.ok(report.includes('| 30~40 | 1 | 0 | 1 | 0 | 0/1 (0%) | 0/1 (0%) |'));
});

test('대조: 모델 답 모양·사진 대조, 오너 답 완료 조건', () => {
  assert.equal(modelReady({ state: '있음', primaryEmotion: '기쁨', intensity: 2 }), true);
  // 가려짐은 읽힘 답만 있어도 센다, 안 보임 + 감정 있음은 경고.
  const partial = compareAnswers({ cards: [card(1, PHOTO_KINDS.hidden, null), card(2, PHOTO_KINDS.hidden, null)],
    answers: { 1: { t: 't1', id: 'p1', read: '예' }, 2: owner(2, '미네가 안 보임', '있음', '기쁨', 1) } });
  assert.deepEqual(partial.hidden, { answered: 2, mineVisible: 1, readable: 1 });
  assert.equal(partial.mismatches.length, 1);
  assert.equal(modelReady({ state: '있음', primaryEmotion: '기쁨' }), false);
  assert.equal(modelReady({ state: '모름', primaryEmotion: '기쁨' }), false);
  assert.equal(modelReady({ state: '기쁨' }), false);
  assert.equal(ownerReady({ read: '예', state: '있음', emo: '기쁨' }), false);
  assert.equal(ownerReady({ read: '예', state: '감정 없음' }), true);
  const stats = compareAnswers({ cards: [card(1, PHOTO_KINDS.close, 100), card(2, PHOTO_KINDS.close, 100)], answers: {},
    modelRows: new Map([[1, { no: 1, photoId: 'other', state: '모름' }], [2, { no: 2, state: '있음' }]]) });
  assert.equal(stats.mismatches.length, 2);
  assert.equal(stats.all.both, 0);
  assert.equal(bucketLabel(0), '0~20');
  assert.equal(bucketLabel(Number.NaN), null);
});

test('대조 파일: 판 이름이 다르면 멈춤, 모델 답 깨진 줄은 건너뛰고 마지막 줄이 이김, 보고서는 번호표 옆', () => {
  const dir = mkdtempSync(join(tmpdir(), 'photo-compare-'));
  try {
    const cardsPath = join(dir, 'photo-cards-2026-11-01-12-59.json');
    writeFileSync(cardsPath, JSON.stringify([card(1, PHOTO_KINDS.close, 100)]));
    const answersPath = join(dir, 'photo-review-answers-2026-11-01-12-59.json');
    writeFileSync(answersPath, JSON.stringify({ 1: owner(1, '예', '있음', '기쁨', 2) }));
    const modelPath = join(dir, 'model.jsonl');
    writeFileSync(modelPath, `${JSON.stringify({ no: 1, state: '모름' })}\n{깨짐\n${JSON.stringify({ no: 1, state: '있음', primaryEmotion: '기쁨', intensity: 2 })}\n`);
    assert.equal(readModelRows(modelPath, quiet).get(1).state, '있음');
    const { stats, reportPath } = compareFiles({ answersPath, cardsPath, modelPath, output: quiet });
    assert.equal(stats.all.intensitySame, 1);
    assert.ok(readFileSync(reportPath, 'utf8').includes('# 미네 사진 검수 대조 2026-11-01-12-59'));
    const otherAnswers = join(dir, 'photo-review-answers-2026-11-01-13-00.json');
    writeFileSync(otherAnswers, '{}');
    assert.throws(() => compareFiles({ answersPath: otherAnswers, cardsPath, output: quiet }), /같은 시트가 아님/);
    assert.throws(() => compareFiles({ answersPath, cardsPath, modelPath: join(dir, 'none.jsonl'), output: quiet }), /모델 답 파일 없음/);
    const otherModel = join(dir, 'model-answers-2026-11-01-13-00.jsonl');
    writeFileSync(otherModel, '');
    assert.throws(() => compareFiles({ answersPath, cardsPath, modelPath: otherModel, output: quiet }), /다른 시트 판/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('사진 사본: 세우기 → 메타데이터 지우기 → 남은 태그 확인, 넘치는 크기·남은 태그는 거부', () => {
  const calls = [];
  const tool = (copyLong = 1024, tags = {}) => (command, args) => {
    calls.push(command);
    if (command.endsWith('python')) { writeFileSync(args[3], 'jpeg'); return JSON.stringify({ upright: { width: 3000, height: 4000 }, copy: { width: copyLong * 0.75, height: copyLong } }); }
    if (args[0] === '-j') return JSON.stringify([{ SourceFile: args.at(-1), 'File:FileSize': 1, ...tags }]);
    return '';
  };
  const result = sheetPhoto('/src.heic', { python: '/venv/python', tool: tool() });
  assert.equal(result.dataUrl, `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`);
  assert.deepEqual(result.upright, { width: 3000, height: 4000 });
  assert.deepEqual(calls, ['/venv/python', 'exiftool', 'exiftool']);
  assert.throws(() => sheetPhoto('/src', { python: '/venv/python', tool: tool(2000) }), /초과/);
  assert.throws(() => sheetPhoto('/src', { python: '/venv/python', tool: tool(1024, { 'IFD0:Make': 'x' }) }), /메타데이터 잔류/);
});

test('시트 만들기: 분 단위 폴더 한 번만, 번호표·순간 사본·시트, 사본 실패한 사진은 뺌', () => {
  const base = mkdtempSync(join(tmpdir(), 'photo-sheet-'));
  try {
    const anchorRoot = join(base, 'anchors');
    mkdirSync(anchorRoot);
    writeFileSync(join(anchorRoot, 'items-2026-10-19.json'), JSON.stringify([{ ref: 'photo:aaaaaaaaaaaaaaaa', date: '2023-06-03' }]));
    const rows = pool();
    const candidates = []; // collectPhotoRows를 건너뛰려고 rows를 직접 쓰지 않는다 — 고르기는 실제 함수로.
    const byMoment = new Map();
    for (const entry of rows) byMoment.set(entry.momentId, entry);
    for (const [momentId, entry] of byMoment) {
      candidates.push({ id: momentId, rel: entry.momentRel, date: entry.momentDate, title: 't', fields: { occurred: entry.momentDate }, memo: '',
        photos: [{ id: entry.id, path: entry.path, confirmedMine: true }] });
    }
    const faces = new Map(rows.filter((entry) => entry.kind).map((entry) => [entry.id, entry.metrics.mineFound
      ? [{ i: 0, bbox: [0, 0, entry.kind === PHOTO_KINDS.group ? 100 : entry.metrics.copyFacePx * 4000 / 768, 4000], det: 0.9, blur: 1 },
        ...(entry.kind === PHOTO_KINDS.group ? [{ i: 1, bbox: [0, 0, 100, 100] }, { i: 2, bbox: [0, 0, 100, 100] }] : [])] : []]));
    const mine = new Map(rows.filter((entry) => entry.metrics.mineFound).map((entry) => [entry.id, { i: 0, bbox: faces.get(entry.id)?.[0]?.bbox }]));
    const sizes = (paths) => new Map(paths.map((path) => [path, { width: 3000, height: 4000 }]));
    let failed = 0;
    const photo = () => { if (failed++ === 0) throw new Error('깨진 사진'); return { dataUrl: 'data:image/jpeg;base64,AA==', upright: { width: 3000, height: 4000 }, bytes: 1 }; };
    const options = { root: base, mediaRoot: base, anchorRoot, out: join(base, 'review'), now: new Date('2026-11-01T03:59:30Z'), criteria: fixtureCriteria,
      candidates, sizes, faces, mine, photo, output: quiet };
    const dry = buildSheet({ ...options, dryRun: true });
    assert.ok(dry.picked.length > 0);
    assert.throws(() => readdirSync(join(base, 'review')));
    const result = buildSheet(options);
    assert.equal(result.stamp, '2026-11-01-12-59');
    assert.equal(result.cards.length, dry.picked.length - 1, '사본 실패 한 장 뺌');
    const index = JSON.parse(readFileSync(result.cardsPath, 'utf8'));
    assert.deepEqual(index.map((entry) => entry.no), index.map((_, i) => i + 1));
    assert.ok(index.every((entry) => entry.title && entry.photoId && entry.kind && !('image' in entry)));
    assert.ok(Object.keys(JSON.parse(readFileSync(result.momentsPath, 'utf8'))).length > 0);
    const sample = JSON.parse(readFileSync(join(base, 'review', 'photo-2026-11-01-12-59', 'photo-sample-2026-11-01-12-59.json'), 'utf8'));
    assert.equal(sample.seed, 'photo-review-2026-11-01');
    assert.equal(sample.cards, result.cards.length);
    assert.throws(() => buildSheet(options), /이미 있는 시트 폴더/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
