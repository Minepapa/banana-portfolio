import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureCriteria } from '../lib/mine-emotion-criteria.fixture.js';
import { DAILY_PHOTO_TEXT_CALLS } from '../lib/mine-photo-scene.mjs';
import { readModelRows, modelReady } from './mine-photo-review-sheet.mjs';
import { anchorPhotoIds, answerLine, answersFileFor, progress, run, scenesFileFor } from './mine-photo-scene-eval.mjs';

const STAMP = '2026-11-01-13-08';
const scene = (overrides = {}) => ({ mineVisible: '보임', mineFaceView: '정면', mineMask: '안 씀', faceCovered: '안 가려짐',
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
  const first = options(fixture);
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
