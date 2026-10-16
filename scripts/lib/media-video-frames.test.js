import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractVideoFrames, frameTimes, probeVideo, safeVideoPath } from './media-video-frames.mjs';

test('ffprobe는 전달된 남은 시간 이내에서 끝난다', async () => {
  let timeout;
  await probeVideo('/safe/video.mov', { timeoutMs: 75, run: async (_command, _args, options) => {
    timeout = options.timeout;
    return { stdout: '{"format":{"duration":"2"}}' };
  } });
  assert.equal(timeout, 75);
});

test('영상 길이에 따라 최대 30장, 짧은 영상은 약 1초 간격', () => {
  assert.deepEqual(frameTimes(3), [0, 1, 2]);
  assert.equal(frameTimes(300).length, 30);
  assert.equal(frameTimes(0.2).length, 1);
  assert.throws(() => frameTimes(0), /길이/);
});

test('원본 경로는 Archive 안의 실제 파일만 허용한다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'video-path-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'Archive'));
  writeFileSync(join(root, 'Archive', 'a.mov'), 'video');
  assert.equal(safeVideoPath(root, { id: 'a', archivePath: 'Archive/a.mov' }), join(root, 'Archive', 'a.mov'));
  assert.throws(() => safeVideoPath(root, { id: 'a', archivePath: 'Archive/../../a.mov' }), /경로/);
  writeFileSync(join(root, 'outside.mov'), 'video');
  symlinkSync(join(root, 'outside.mov'), join(root, 'Archive', 'outside.mov'));
  assert.throws(() => safeVideoPath(root, { id: 'a', archivePath: 'Archive/outside.mov' }), /경로/);
});

test('프레임 캐시는 원본 크기·mtime이 같으면 재사용하고 바뀌면 무효화한다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'video-frames-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mediaRoot = join(root, 'Media');
  const frameRoot = join(root, 'Frames');
  mkdirSync(join(mediaRoot, 'Archive'), { recursive: true });
  const original = join(mediaRoot, 'Archive', 'a.mov');
  writeFileSync(original, 'first');
  let calls = 0;
  const run = async (_command, args) => { calls += 1; writeFileSync(args.at(-1), 'jpeg'); return {}; };
  const record = { id: 'a', archivePath: 'Archive/a.mov' };
  const first = await extractVideoFrames(record, { mediaRoot, frameRoot, probe: async () => 2, run });
  assert.deepEqual(first.frames.map((frame) => frame.id), ['a@0', 'a@1']);
  assert.equal(statSync(first.frames[0].path).mode & 0o777, 0o600);
  assert.equal(statSync(join(frameRoot, 'a')).mode & 0o777, 0o700);
  assert.equal(JSON.parse(readFileSync(join(frameRoot, 'a', 'manifest.json'))).size, 5);
  await extractVideoFrames(record, { mediaRoot, frameRoot, probe: async () => { throw new Error('cache missed'); }, run });
  assert.equal(calls, 2);
  writeFileSync(original, 'changed');
  await extractVideoFrames(record, { mediaRoot, frameRoot, probe: async () => 2, run });
  assert.equal(calls, 4);
});
