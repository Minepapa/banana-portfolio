import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreWindows, mergeHighlightWindows, selectHighlights, videoHighlights } from './media-video-highlights.mjs';

test('미네 얼굴은 소리보다 강하고 웃음·높은 소리의 근거가 붙는다', () => {
  const cues = [
    { start: 0, end: 4, tags: { speech: 0.8 }, pitch: 100, rms: 0.01 },
    { start: 0, end: 4, tags: {}, pitch: 110, rms: 0.012 },
    { start: 4, end: 8, tags: { laughter: 0.9, speech: 0.8 }, pitch: 210, rms: 0.03 },
  ];
  const bins = scoreWindows(12, { faces: [{ second: 5, people: ['미네'] }], cues });
  assert.ok(bins[2].score > bins[0].score + 4);
  assert.deepEqual(bins[2].evidence, ['미네 얼굴', '웃음', '말소리', '커진 소리', '높아진 목소리']);
});

test('인접 창을 합쳐 20초에서 끊고 겹치지 않는 상위 3개를 고른다', () => {
  const windows = Array.from({ length: 35 }, (_, index) => ({
    start: index * 2, end: index * 2 + 2,
    score: [1, 2, 3, 4, 5].includes(Math.floor(index / 5)) ? 0 : 2,
    evidence: ['웃음'],
  }));
  const merged = mergeHighlightWindows(windows, 70);
  assert.ok(merged.every((segment) => segment.endSec - segment.startSec <= 20));
  const selected = selectHighlights(merged, windows, 70);
  assert.ok(selected.length <= 3 && selected.length >= 1);
  assert.ok(selected.every((segment, index) => index === 0 || selected[index - 1].endSec <= segment.startSec));
});

test('21초 연속 활성 창은 마지막 1초를 3초로 늘려도 두 구간이 겹치지 않는다', () => {
  const windows = Array.from({ length: 11 }, (_, index) => ({
    start: index * 2, end: Math.min(21, index * 2 + 2), score: 2, evidence: ['웃음'],
  }));
  const merged = mergeHighlightWindows(windows, 21);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(({ startSec, endSec }) => [startSec, endSec]), [[0, 18], [18, 21]]);
  assert.equal(selectHighlights(merged, windows, 21).length, 2);
});

test('10초 미만은 전체 한 구간, 재료 일부가 없어도 구간을 만든다', () => {
  assert.deepEqual(videoHighlights({ durationSec: 8, people: [], representatives: {} }),
    [{ startSec: 0, endSec: 8, score: 0, evidence: ['짧은 영상'] }]);
  const long = videoHighlights({ durationSec: 30, people: ['미네'],
    representatives: { 미네: { timestampSec: 12 } } });
  assert.equal(long.length, 1);
  assert.ok(long[0].startSec <= 12 && long[0].endSec >= 12);
  assert.deepEqual(videoHighlights({ durationSec: 10 }),
    [{ startSec: 0, endSec: 3, score: 0, evidence: ['소리·얼굴 근거 없음'] }]);
});

test('선택 전사와 미네 목소리 구간은 해당 창만 보강한다', () => {
  const bins = scoreWindows(6, { transcripts: [{ start: 2, end: 4, text: '안녕' }],
    mineVoice: [{ start: 2, end: 4 }] });
  assert.equal(bins[0].score, 0);
  assert.deepEqual(bins[1].evidence, ['말소리', '미네 목소리']);
});
