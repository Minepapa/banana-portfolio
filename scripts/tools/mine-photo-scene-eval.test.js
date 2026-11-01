import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureCriteria } from '../lib/mine-emotion-criteria.fixture.js';
import { DAILY_PHOTO_TEXT_CALLS } from '../lib/mine-photo-scene.mjs';
import { readModelRows, modelReady } from './mine-photo-review-sheet.mjs';
import { anchorPhotoIds, answerLine, answersFileFor, evalSplit, progress, run, scenesFileFor } from './mine-photo-scene-eval.mjs';

const STAMP = '2026-11-01-13-08';
const scene = (overrides = {}) => ({ mineVisible: '보임', mineFaceView: '정면', mineMask: '안 씀', faceCovered: '안 가려짐',
  mouthCorners: '올라감', mouthShape: '이가 보이게 벌림', eyeShape: '반달처럼 접힘', browShape: '편안함', tears: '없음', gaze: '카메라를 봄', bodyPose: '편안함',
  mineExpression: '입꼬리가 올라가고 이가 보임', mineAction: '서 있음', place: '실외', occasion: '놀이터', people: '없음', other: '없음', ...overrides });
const answer = (level = '보통') => ({ emotionState: '있음', nearestAnchor: 'joy-1', primary: '기쁨',
  levels: { 기쁨: level, 슬픔: '없음', 버럭: '없음', 까칠: '없음', 소심: '없음' }, emotionEvidence: '이가 보이게 웃음', secondFilmSignal: null,
  confidence: '보통', importance: 2, scene: '놀이터에 선 미네', titleSuggestion: '놀이터', coreMemoryCandidate: { value: false, reason: '일상' } });
const anchors = [{ id: 'joy-1', verdict: '기쁨 1', record: '2026-07-15 미네 통화', no: 2, why: '일상 기쁨' },
  { id: 'photo-joy-2a', verdict: '기쁨 2', record: '사진 b553faed17c2e6b4, 2023-06-03 웃음', no: 34, why: '큰 웃음' }];

function setup(t, kinds = ['얼굴 가까이', '멀리서', '얼굴 가까이']) {
  const dir = mkdtempSync(join(tmpdir(), 'photo-scene-eval-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cards = kinds.map((kind, index) => ({ no: index + 1, title: `2020-01-0${index + 1} p${index}.jpg`, photoId: `${index}`.padStart(16, 'a'),
    momentId: `m${index}`, date: `2020-01-0${index + 1}`, path: `Imports/p${index}.jpg`, kind, kindReason: 'r', mineBox: [10, 10, 50, 50], size: { width: 100, height: 100 } }));
  const moments = Object.fromEntries(cards.map((card) => [card.momentId, { id: card.momentId, rel: `20_Records/24_Media/2020/${card.momentId}.md`, date: card.date,
    title: card.title, fields: { occurred: card.date, description: `순간 ${card.no}` }, memo: '', album: null }]));
  const cardsPath = join(dir, `photo-cards-${STAMP}.json`);
  writeFileSync(cardsPath, JSON.stringify(cards));
  writeFileSync(join(dir, `photo-moments-${STAMP}.json`), JSON.stringify(moments));
  return { dir, cards, cardsPath, ledgerPath: join(dir, 'ledger.jsonl') };
}

function options(fixture, overrides = {}) {
  const calls = { ollama: [], claude: [] };
  let index = 0;
  const answers = overrides.answers ?? [answer()];
  delete overrides.answers;
  return { calls, options: { cardsPath: fixture.cardsPath, ledgerPath: fixture.ledgerPath, anchorRoot: fixture.dir, criteria: fixtureCriteria, anchors,
    charter: { model: 'sonnet', systemPrompt: '' }, now: () => Date.parse('2026-11-01T14:00:00+09:00'), cooldown: () => false,
    copyPhoto: () => ({ width: 100, height: 100 }), readImage: () => 'aGk=', output: { log() {}, error() {} }, stage: 'scene',
    invoke: async (request) => { calls.ollama.push(request); return { json: overrides.sceneOf?.(calls.ollama.length) ?? scene(), usage: {} }; },
    judge: async (prompt) => { calls.claude.push(prompt); const value = answers[Math.min(index, answers.length - 1)]; index += 1; return JSON.stringify(value); },
    ...overrides } };
}
const lines = (path) => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);

test('장면 낱말 → Claude 판단: 검수 시트 --compare가 읽는 모델 답 줄, 표정 못 읽는 카드는 Claude 없이 모름', async (t) => {
  const fixture = setup(t);
  // 0.2: 멀리서 카드(2번)라도 얼굴 단서가 보이면 판단한다. 표정 못 읽는 카드는 장면 낱말이 얼굴 안 보임인 카드.
  const first = options(fixture, { sceneOf: (n) => (n === 2 ? scene({ mineFaceView: '얼굴 안 보임' }) : scene()) });
  await run(first.options);
  assert.equal(first.calls.ollama.length, 3);
  assert.equal(lines(scenesFileFor(fixture.dir, STAMP)).length, 3);
  const second = options(fixture, { stage: 'judge' });
  const summary = await run(second.options);
  assert.deepEqual([summary.judged, summary.forced, summary.calls], [2, 1, 4]);
  assert.equal(second.calls.ollama.length, 0, '판단 단계는 사진을 다시 보지 않는다');
  for (const prompt of second.calls.claude) for (const leak of ['aGk=', 'Imports/', '.jpg', 'b553faed17c2e6b4']) assert.equal(prompt.includes(leak), false, leak);
  const rows = readModelRows(answersFileFor(fixture.dir, STAMP), { error() {} });
  assert.equal(rows.size, 3);
  assert.ok([...rows.values()].every(modelReady));
  assert.deepEqual([rows.get(1).state, rows.get(1).primaryEmotion, rows.get(1).intensity, rows.get(1).photoId], ['있음', '기쁨', 2, fixture.cards[0].photoId]);
  assert.deepEqual([rows.get(2).state, rows.get(2).forcedUnknown, rows.get(2).calls], ['모름', true, 0]);
  const ledger = lines(fixture.ledgerPath);
  assert.deepEqual(ledger.map((row) => [row.mode, row.sheet, row.no, row.calls, row.status]), [['review', STAMP, 1, 2, 'judged'], ['review', STAMP, 3, 2, 'judged']]);
  // 다시 돌리면 끝난 카드는 묻지 않는다(이어 하기).
  const third = options(fixture, { stage: 'judge' });
  await run(third.options);
  assert.equal(third.calls.claude.length, 0);
});

test('마스크 장면 낱말은 가려짐으로 정정돼 Claude를 부르지 않는다, 두 답이 다르면 애매함 줄(대조에서 빠짐)', async (t) => {
  const fixture = setup(t, ['얼굴 가까이', '얼굴 가까이']);
  await run(options(fixture, { sceneOf: (n) => (n === 1 ? scene({ mineMask: '씀' }) : scene()) }).options);
  const judged = options(fixture, { stage: 'judge', answers: [answer('보통'), answer('짙음')] });
  const summary = await run(judged.options);
  assert.deepEqual([summary.forced, summary.ambiguous, judged.calls.claude.length], [1, 1, 2]);
  const rows = readModelRows(answersFileFor(fixture.dir, STAMP), { error() {} });
  assert.deepEqual([rows.get(1).photoKind, rows.get(1).kindCorrected, rows.get(1).state], ['가려짐', true, '모름']);
  assert.deepEqual([rows.get(2).error, rows.get(2).ambiguous, rows.get(2).answers.map((a) => a.intensity)], ['애매함', true, [2, 3]]);
});

test('호출 상한(--max-calls·하루 상한)과 회차 시간·쿨다운 가드', async (t) => {
  const fixture = setup(t, ['얼굴 가까이', '얼굴 가까이', '얼굴 가까이']);
  await run(options(fixture).options);
  const capped = options(fixture, { stage: 'judge', maxCalls: 3 });
  const summary = await run(capped.options);
  assert.deepEqual([summary.calls, summary.capped], [2, true], '카드 하나에 두 번 — 남은 1번으로는 시작하지 않는다');
  writeFileSync(fixture.ledgerPath, `${JSON.stringify({ engine: 'claude', at: '2026-11-01', calls: DAILY_PHOTO_TEXT_CALLS - 1 })}\n`);
  const daily = options(fixture, { stage: 'judge' });
  assert.equal((await run(daily.options)).capped, true);
  assert.equal(daily.calls.claude.length, 0);
  const morning = options(fixture, { stage: 'all', now: () => Date.parse('2026-11-01T07:00:00+09:00') });
  assert.equal((await run(morning.options)).blockedWindow, true);
  assert.equal(morning.calls.ollama.length + morning.calls.claude.length, 0);
  rmSync(fixture.ledgerPath);
  const cooled = options(fixture, { stage: 'judge', cooldown: () => true });
  assert.equal((await run(cooled.options)).cooldown, true);
  assert.equal(cooled.calls.claude.length, 0);
});

test('--limit은 이번에 할 카드 수에만 — 앞 회차 줄이 더 있어도 이어 한다', async (t) => {
  const fixture = setup(t);
  await run(options(fixture).options);
  const limited = options(fixture, { stage: 'judge', limit: 1 });
  const summary = await run(limited.options);
  assert.equal(summary.judged + summary.forced, 1);
  const again = options(fixture, { stage: 'scene', limit: 1 });
  await run(again.options);
  assert.equal(again.calls.ollama.length, 0);
});

test('dry-run은 호출·파일 쓰기가 없다', async (t) => {
  const fixture = setup(t);
  const dry = options(fixture, { stage: 'all', dryRun: true });
  await run(dry.options);
  assert.equal(dry.calls.ollama.length + dry.calls.claude.length, 0);
  assert.equal(existsSync(scenesFileFor(fixture.dir, STAMP)), false);
  assert.equal(existsSync(answersFileFor(fixture.dir, STAMP)), false);
});

test('progress·answerLine·anchorPhotoIds', () => {
  const cards = [{ no: 1, photoId: 'a' }, { no: 2, photoId: 'b' }];
  const state = progress([{ no: 1, photoId: 'a', ok: true }, { no: 2, photoId: 'b' }, { no: 2, photoId: 'b' }], cards, { done: (row) => row.ok });
  assert.deepEqual([state.finished.size, state.failures.get(2)], [1, 2]);
  assert.throws(() => progress([{ no: 1, photoId: 'z' }], cards, { done: () => true }), /번호표와 다름/);
  assert.deepEqual(answerLine({ no: 1, photoId: 'a', title: 't' }, null, { forcedKind: { kind: '멀리서' } }).state, '모름');
  assert.deepEqual(anchorPhotoIds(anchors), [{ anchorId: 'photo-joy-2a', photoId: 'b553faed17c2e6b4', date: '2023-06-03' }]);
});

test('평가 세트 나누기: 사진 종류별로 번호 순서대로 번갈아 tune·holdout, --set은 그 세트 카드만 묻는다', async (t) => {
  const split = evalSplit([{ no: 4, kind: '멀리서' }, { no: 1, kind: '얼굴 가까이' }, { no: 2, kind: '멀리서' }, { no: 3, kind: '얼굴 가까이' }, { no: 5 }]);
  assert.deepEqual([...split.entries()].sort((a, b) => a[0] - b[0]), [[1, 'tune'], [2, 'tune'], [3, 'holdout'], [4, 'holdout'], [5, 'tune']]);
  const fixture = setup(t, ['얼굴 가까이', '얼굴 가까이', '얼굴 가까이']);
  await run(options(fixture, { stage: 'scene' }).options);
  const tune = options(fixture, { stage: 'judge', set: 'tune' });
  const summary = await run(tune.options);
  assert.equal(summary.judged, 2, '1·3번이 tune');
  const holdout = options(fixture, { stage: 'judge', set: 'holdout' });
  assert.equal((await run(holdout.options)).judged, 1);
  await assert.rejects(run(options(fixture, { stage: 'judge', set: 'all' }).options), /--set은/);
});

test('--face-crop(0.4-face): 얼굴 상자가 있으면 확대 그림을 두 번째로, 없으면 사진 전체만 — 판 이름이 붙은 파일에 따로 쓴다', async (t) => {
  const fixture = setup(t, ['얼굴 가까이', '가려짐']);
  const cards = JSON.parse(readFileSync(fixture.cardsPath, 'utf8'));
  delete cards[1].mineBox; // 얼굴 인식이 미네를 못 찾은 사진
  writeFileSync(fixture.cardsPath, JSON.stringify(cards));
  const crops = [];
  const first = options(fixture, { faceCrop: true, readImage: (path) => (path.endsWith('-face.jpg') ? 'RkFDRQ==' : 'aGk='),
    cropFace: (source, target, box) => { crops.push([source, box]); return { width: 448, height: 448 }; } });
  await run(first.options);
  assert.deepEqual(crops.map(([, box]) => box), [[10, 10, 50, 50]]);
  assert.deepEqual(first.calls.ollama.map((request) => request.images), [['aGk=', 'RkFDRQ=='], ['aGk=']]);
  assert.match(first.calls.ollama[0].prompt, /두 번째는 첫 번째 사진에서 미네 얼굴 부분만 잘라 크게 키운 것/);
  assert.doesNotMatch(first.calls.ollama[1].prompt, /두 번째 그림/);
  const rows = lines(join(fixture.dir, `photo-scenes-photo-scene-ollama-0.4-face-${STAMP}.jsonl`));
  assert.deepEqual(rows.map((row) => [row.sceneVersion, row.faceCrop]), [['photo-scene/ollama-0.4-face', true], ['photo-scene/ollama-0.4-face', false]]);
  assert.equal(existsSync(scenesFileFor(fixture.dir, STAMP)), false, '기본 판 장면 파일은 건드리지 않는다');
  const judged = options(fixture, { stage: 'judge', faceCrop: true });
  await run(judged.options);
  const answers = lines(join(fixture.dir, `model-answers-photo-text-claude-0.3-photo-scene-ollama-0.4-face-${STAMP}.jsonl`));
  assert.ok(answers.every((row) => row.sceneVersion === 'photo-scene/ollama-0.4-face'));
  assert.equal(lines(fixture.ledgerPath)[0].scenePromptVersion, 'photo-scene/ollama-0.4-face');
});

test('--set은 장면 낱말 단계에도 걸리고, 답 줄에 세트를 남긴다(리뷰 LOW-5·MEDIUM-1)', async (t) => {
  const fixture = setup(t, ['얼굴 가까이', '얼굴 가까이', '얼굴 가까이']);
  const sceneRun = options(fixture, { stage: 'scene', set: 'holdout' });
  await run(sceneRun.options);
  assert.equal(sceneRun.calls.ollama.length, 1, '2번만 holdout');
  assert.deepEqual(lines(scenesFileFor(fixture.dir, STAMP)).map((row) => row.no), [2]);
  await run(options(fixture, { stage: 'judge', set: 'holdout' }).options);
  assert.deepEqual(lines(answersFileFor(fixture.dir, STAMP)).map((row) => [row.no, row.set]), [[2, 'holdout']]);
});

test('--face-crop: 확대 그림을 못 만들면 사진 전체로 장면 낱말을 뽑고 이유를 남긴다(실패로 세지 않음, 리뷰 LOW-7)', async (t) => {
  const fixture = setup(t, ['얼굴 가까이']);
  const run1 = options(fixture, { faceCrop: true, cropFace: () => { throw new Error('exiftool 없음'); } });
  const summary = await run(run1.options);
  assert.deepEqual([summary.scenes, summary.sceneFailures], [1, 0]);
  assert.deepEqual(run1.calls.ollama[0].images, ['aGk=']);
  const [row] = lines(join(fixture.dir, `photo-scenes-photo-scene-ollama-0.4-face-${STAMP}.jsonl`));
  assert.deepEqual([row.faceCrop, row.faceCropError], [false, 'exiftool 없음']);
});
