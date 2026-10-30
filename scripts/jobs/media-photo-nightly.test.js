import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PHOTO_STEPS, runPhotoNightly } from './media-photo-nightly.mjs';
import { EXPECTED_INTERVALS_MS } from '../lib/job-schedule.mjs';

test('사진 블록: 장면 분석 → 얼굴 이름표 순서, 앞 단계가 실패해도 뒤 단계는 돌고 실패 수를 센다', () => {
  const calls = [];
  const out = runPhotoNightly({ output: { log() {} }, run: (script) => { calls.push(script); return { status: script === 'media-vision.mjs' ? 1 : 0 }; } });
  assert.deepEqual(calls, ['media-vision.mjs', 'media-faces-nightly.mjs']);
  assert.equal(out.failed, 1);
  assert.deepEqual(PHOTO_STEPS.map((s) => s.name), ['장면 분석', '얼굴 이름표']);
});

test('media-photo plist·디스패치·감시 주기는 매일 03:00으로 일치한다', () => {
  const plist = readFileSync(new URL('../launchd/com.banana2.media-photo.plist', import.meta.url), 'utf8');
  const runSh = readFileSync(new URL('../launchd/run.sh', import.meta.url), 'utf8');
  assert.match(plist, /<key>Hour<\/key><integer>3<\/integer><key>Minute<\/key><integer>0<\/integer>/);
  assert.match(runSh, /media-photo\) CMD=\(scripts\/jobs\/media-photo-nightly\.mjs\)/);
  assert.equal(EXPECTED_INTERVALS_MS['media-photo'], 24 * 60 * 60 * 1000);
  assert.equal(EXPECTED_INTERVALS_MS['media-vision'], undefined);
  assert.equal(EXPECTED_INTERVALS_MS['media-faces-nightly'], undefined);
});
