import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AUDIO_STEPS, runAudioNightly } from './media-audio-nightly.mjs';
import { EXPECTED_INTERVALS_MS } from '../lib/job-schedule.mjs';

test('음성 블록: 전사 → 화자 분리 순서, 화자 분리는 인자 없이(정기 옵션), 앞 단계 실패해도 뒤 단계는 돈다', () => {
  const calls = [];
  const out = runAudioNightly({ output: { log() {} }, run: (step) => { calls.push([step.script, step.args]); return { status: step.script === 'media-transcribe.mjs' ? 1 : 0 }; } });
  assert.deepEqual(calls, [['media-transcribe.mjs', ['--max-minutes=15']], ['media-diarize.mjs', []]]);
  assert.equal(out.failed, 1);
  assert.deepEqual(AUDIO_STEPS.map((s) => s.name), ['통화·녹음 전사', '화자 분리']);
});

test('media-audio plist·디스패치·감시 주기는 매일 02:00으로 일치하고 옛 잡은 감시에서 빠진다', () => {
  const plist = readFileSync(new URL('../launchd/com.banana2.media-audio.plist', import.meta.url), 'utf8');
  const runSh = readFileSync(new URL('../launchd/run.sh', import.meta.url), 'utf8');
  const slots = [...plist.matchAll(/<dict><key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer><\/dict>/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
  assert.deepEqual(slots, [[2, 0]]);
  assert.match(runSh, /media-audio\) CMD=\(scripts\/jobs\/media-audio-nightly\.mjs\)/);
  assert.equal(EXPECTED_INTERVALS_MS['media-audio'], 24 * 60 * 60 * 1000);
  assert.equal(EXPECTED_INTERVALS_MS['media-transcribe'], undefined);
  assert.equal(EXPECTED_INTERVALS_MS['media-diarize'], undefined);
});
