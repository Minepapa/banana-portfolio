import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runFacesNightly } from './media-faces-nightly.mjs';

test('밤 잡은 얼굴 파이프라인(증분) 뒤에 순간 노트 이름표를 갱신하고 실패 수를 돌려준다', async () => {
  const calls = [];
  const result = await runFacesNightly({
    pipeline: async ({ limit }) => { calls.push(['pipeline', limit]); return { photos: { a: {}, b: {} } }; },
    refresh: async () => { calls.push(['refresh']); return { changed: 3, failed: 0 }; },
    output: { log() {} },
  });
  assert.deepEqual(calls, [['pipeline', 500], ['refresh']]);
  assert.equal(result.photoCount, 2);
  assert.equal(result.notes.changed, 3);
});

test('파이프라인이 실패하면 노트를 건드리지 않는다', async () => {
  let refreshed = false;
  await assert.rejects(runFacesNightly({
    pipeline: async () => { throw new Error('얼굴 모델 없음'); },
    refresh: async () => { refreshed = true; return { changed: 0, failed: 0 }; },
    output: { log() {} },
  }), /얼굴 모델 없음/);
  assert.equal(refreshed, false);
});

