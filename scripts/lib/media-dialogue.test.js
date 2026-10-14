import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseRepeatedParts, renderDialogue, shortenSegmentRepetition,
  speakerParts, splitDialogueParts } from './media-dialogue.mjs';

test('맞장구를 낀 10회 반복을 두 노트 경로에서 같은 규칙으로 줄인다', () => {
  const phrase = '왜냐면 자기 아니면은 우리 팀이 이길 수 있어';
  const segments = Array.from({ length: 10 }, (_, index) => [
    { start: index * 2000, end: index * 2000 + 1000, text: `- ${phrase.slice(0, -2)}` },
    { start: index * 2000 + 1000, end: index * 2000 + 1800, text: `있어. - ${index % 2 ? '응?' : '응.'}` },
  ]).flat();
  const transcript = { speech: true, transcribedAt: 'now', segments };
  const speakers = { transcribedAt: 'now', segments: segments.map((_, i) => ({
    i, speaker: 'owner', uncertain: false })) };
  const dialogue = renderDialogue(transcript, speakers, '미네');
  assert.equal(dialogue, `나: ${phrase}. (같은 문장 10회 반복 — 전사 오류로 줄임) 응?`);
  const plain = shortenSegmentRepetition(segments.map((segment) => segment.text).join(' '), segments);
  assert.equal(plain, `${phrase}. (같은 문장 10회 반복 — 전사 오류로 줄임) 응?`);
});

test('끝 하이픈과 빈 하위 구간은 발화에 남지 않는다', () => {
  const segments = [{ start: 0, end: 1000, text: '- 같이 하는 거야. -' },
    { start: 1000, end: 2000, text: '- - 넘겨줬어? -' }];
  assert.deepEqual(splitDialogueParts(segments).map((part) => part.text),
    ['같이 하는 거야.', '넘겨줬어?']);
});

test('하나의 Whisper 구간 안의 화자를 저장된 turns로 다시 나눈다', () => {
  const transcript = { speech: true, transcribedAt: 'now', segments: [
    { start: 0, end: 2000, text: '- 우리 반이거든. - 응. [?]' },
  ] };
  const speakers = { transcribedAt: 'now', turns: [
    { start: 0, end: 1600, speaker: 'S0' }, { start: 1600, end: 2000, speaker: 'S1' },
  ], segments: [{ i: 0, speaker: 'owner', uncertain: true }] };
  assert.deepEqual(splitDialogueParts(transcript.segments).map(({ text, start, end }) => [text, start, end]),
    [['우리 반이거든.', 0, 1600], ['응. [?]', 1600, 2000]]);
  assert.deepEqual(speakerParts(transcript, speakers).map(({ speaker }) => speaker), ['owner', 'other']);
  assert.equal(renderDialogue(transcript, speakers, '미네'), '나: 우리 반이거든.\n미네: 응.');
  assert.equal(renderDialogue(transcript, { ...speakers, parts: speakerParts(transcript, speakers) }, '미네'),
    renderDialogue(transcript, speakers, '미네'));
});

test('주석 [?]는 하위 구간 시간 비율에서 빼서 짧은 맞장구 화자를 지킨다', () => {
  const transcript = { speech: true, transcribedAt: 'now', segments: [
    { start: 0, end: 1000, text: '- 안녕하세요. - 응. [?]' },
  ] };
  const speakers = { transcribedAt: 'now', turns: [
    { start: 0, end: 750, speaker: 'S0' }, { start: 750, end: 1000, speaker: 'S1' },
  ], segments: [{ i: 0, speaker: 'owner', uncertain: true }] };
  assert.deepEqual(splitDialogueParts(transcript.segments).map(({ start, end }) => [start, end]),
    [[0, 750], [750, 1000]]);
  assert.deepEqual(speakerParts(transcript, speakers).map(({ speaker }) => speaker), ['owner', 'other']);
  assert.equal(renderDialogue(transcript, speakers, '미네'), '나: 안녕하세요.\n미네: 응.');
});

test('짧은 맞장구와 두 번 나온 후렴은 그대로 둔다', () => {
  const parts = [{ text: '응' }, { text: '응' }, { text: '노래 후렴이 이어집니다' },
    { text: '노래 후렴이 이어집니다' }];
  assert.deepEqual(collapseRepeatedParts(parts), parts);
});

test('일반 문장이 끼면 반복 묶음을 분리하고 그 문장은 보존한다', () => {
  const phrase = '왜냐면 우리 팀이 이길 수 있어';
  const parts = [{ text: phrase }, { text: '오늘 일정도 확인했어.' },
    { text: `${phrase}.` }, { text: '응' }, { text: `${phrase}!` }];
  assert.deepEqual(collapseRepeatedParts(parts), parts);
});

test('긴 연속 반복도 하나로 묶고 다음 일반 문장을 지킨다', () => {
  const phrase = '왜냐면 우리 팀이 이길 수 있어';
  const parts = Array.from({ length: 15 }, () => [{ text: `${phrase}.` }, { text: '응.' }]).flat();
  parts.push({ text: '오늘 일정도 확인했어.' });
  assert.deepEqual(collapseRepeatedParts(parts).map((part) => part.text), [
    `${phrase}.`, '(같은 문장 15회 반복 — 전사 오류로 줄임)', '오늘 일정도 확인했어.',
  ]);
});
