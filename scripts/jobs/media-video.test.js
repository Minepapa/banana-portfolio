import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { loadFacePhotos, loadVideoPeople } from './media-moments.mjs';
import { fingerprintFrames, parseVideoArgs, runMediaVideo, runMediaVideoCli, savePrivate, selectVideos, videoPeople } from './media-video.mjs';
import { mergeMomentPeople, momentPeople } from '../lib/media-face-people.mjs';

test('CLI 옵션과 중복 영상 선택', () => {
  assert.deepEqual(parseVideoArgs(['--limit=2', '--ids=a,b', '--dry-run', '--faces']),
    { limit: 2, ids: ['a', 'b'], dryRun: true, faces: true, cues: false });
  assert.throws(() => parseVideoArgs(['--limit=abc']), /옵션/);
  assert.throws(() => parseVideoArgs(['--ids=../x']), /옵션/);
  const rows = [{ id: 'a', archivePath: 'Archive/a.mov' },
    { id: 'b', importPath: 'Imports/b.mp4', duplicateOf: 'a' },
    { id: 'c', archivePath: 'Archive/c.jpg' }];
  assert.deepEqual(selectVideos(rows).map((row) => row.id), ['a']);
});

test('private 저장은 기존 폴더 권한을 유지하고 이름 변경 실패의 임시 파일을 지운다', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-video-private-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const originalMode = statSync(base).mode & 0o777;
  const path = join(base, 'status.json');
  savePrivate(path, '{}');
  assert.equal(statSync(base).mode & 0o777, originalMode);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const directoryTarget = join(base, 'directory');
  mkdirSync(directoryTarget);
  assert.throws(() => savePrivate(directoryTarget, '{}'));
  assert.equal(readFileSync(path, 'utf8'), '{}');
  assert.equal(statSync(base).mode & 0o777, originalMode);
  assert.equal(readdirSync(base).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('CLI는 단계 실패가 있으면 종료 코드 1을 돌려준다', async () => {
  assert.equal(await runMediaVideoCli(['--faces'], { run: async () => ({ failed: 1 }) }), 1);
  assert.equal(await runMediaVideoCli(['--dry-run'], { run: async () => ({ failed: 0 }) }), 0);
});

test('완료된 앞 영상은 건너뛰어 다음 영상에 도달하고 단계·원본·갤러리 변경은 다시 고른다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-video-pending-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const index = join(root, VAULT_REL.mediaArchiveIndex);
  const gallery = join(root, VAULT_REL.mediaFaceGallery);
  mkdirSync(dirname(index), { recursive: true });
  mkdirSync(dirname(gallery), { recursive: true });
  mkdirSync(join(base, 'Archive'));
  const rows = ['a', 'b', 'c'].map((id) => ({ id, kind: 'Camera', archivePath: `Archive/${id}.mov` }));
  writeFileSync(index, `${rows.map(JSON.stringify).join('\n')}\n`);
  writeFileSync(gallery, '{}');
  const galleryHash = createHash('sha256').update('{}').digest('hex');
  const state = {};
  const matches = [];
  for (const id of ['a', 'b']) {
    const original = join(base, 'Archive', `${id}.mov`);
    writeFileSync(original, 'video');
    const source = { sourceSize: 5, sourceMtimeMs: Math.round(statSync(original).mtimeMs) };
    state[id] = { stages: { faces: { ok: true }, cues: { ok: true, ...source } } };
    matches.push({ id, ...source, galleryHash });
  }
  writeFileSync(join(base, 'Archive', 'c.mov'), 'video');
  const paths = { status: join(base, 'status.json'), matches: join(base, 'matches.jsonl') };
  writeFileSync(paths.status, JSON.stringify(state));
  writeFileSync(paths.matches, `${matches.map(JSON.stringify).join('\n')}\n`);
  const shown = [];
  const dry = (options) => runMediaVideo({ root, mediaRoot: base, paths, dryRun: true, limit: 1,
    output: { log: (line) => shown.push(line) }, ...options });
  await dry({ faces: true, cues: false });
  assert.match(shown.pop(), /dry-run c /);
  await dry({ faces: false, cues: true });
  assert.match(shown.pop(), /dry-run c /);
  await dry({ faces: true, cues: false, ids: ['a'] });
  assert.match(shown.pop(), /dry-run a /);
  writeFileSync(join(base, 'Archive', 'a.mov'), 'changed video');
  await dry({ faces: false, cues: true });
  assert.match(shown.pop(), /dry-run a /);
  writeFileSync(join(base, 'Archive', 'a.mov'), 'video');
  writeFileSync(gallery, '{"updated":true}');
  await dry({ faces: true, cues: false });
  assert.match(shown.pop(), /dry-run a /);
});

test('영상별 사람 최고점, 경계값, 보류와 대표 프레임', () => {
  const manifest = { id: 'v', original: 'Archive/v.mov', durationSec: 12,
    frames: [0, 5, 10].map((second) => ({ id: `v@${second}`, second })) };
  const matches = [
    { id: 'v@0', i: 0, score: 0.40 },
    { id: 'v@5', i: 1, score: 0.50 },
    { id: 'v@10', i: 0, person: '휘영', score: 0.35 },
    { id: 'v@5', i: 2, person: '나', score: 0.40 },
  ];
  const result = videoPeople(matches, manifest);
  assert.deepEqual(result.people, ['미네', '나']);
  assert.deepEqual(result.hold, ['휘영']);
  assert.equal(result.representatives.미네.second, 5);
  assert.equal(result.representatives.휘영.second, 10);
  assert.equal(result.basis, 'video-frames');
  assert.equal(result.frameCount, 3);
  assert.equal(result.representatives.미네.timestampSec, 5);
});

test('영상 이름표의 깨진 줄은 건너뛰고 사진 확인값을 우선한다', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-video-people-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const facePath = join(root, VAULT_REL.mediaFacePeople);
  const videoPath = join(base, 'video-matches.jsonl');
  mkdirSync(dirname(facePath), { recursive: true });
  writeFileSync(videoPath, [
    JSON.stringify({ id: 'shared', people: ['미네'] }),
    '{broken',
    JSON.stringify({ id: 'wrong', people: [4] }),
    JSON.stringify({ id: 'video', people: ['휘영'] }),
  ].join('\n'));
  const warnings = [];
  const output = { warn: (line) => warnings.push(line) };
  assert.equal(loadFacePhotos(root, { videoPeoplePath: videoPath, output }), null);
  writeFileSync(facePath, JSON.stringify({ photos: { shared: { people: ['나'] } } }));
  const photos = loadFacePhotos(root, { videoPeoplePath: videoPath, output });
  assert.deepEqual(photos.shared.people, ['나']);
  assert.deepEqual(photos.video.people, ['휘영']);
  assert.equal(photos.wrong, undefined);
  assert.equal(warnings.length, 2);
});

test('영상 이름표는 순간 미디어 id로 병합되고 dry-run은 쓰지 않는다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-video-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const index = join(root, VAULT_REL.mediaArchiveIndex);
  mkdirSync(dirname(index), { recursive: true });
  writeFileSync(index, `${JSON.stringify({ id: 'v', kind: 'Camera', archivePath: 'Archive/v.mov' })}\n`);
  const output = { log() {}, error() {} };
  const result = await runMediaVideo({ root, dryRun: true, ids: ['v'],
    paths: { status: join(base, 'status.json'), matches: join(base, 'matches.jsonl') }, output });
  assert.equal(result.selected, 1);
  assert.throws(() => readFileSync(join(base, 'status.json')), /ENOENT/);
  const matches = join(base, 'matches.jsonl');
  writeFileSync(matches, `${JSON.stringify({ id: 'v', people: ['미네', '휘영'], hold: ['나'] })}\n`);
  const photos = { photo: { people: ['나'] }, ...loadVideoPeople(matches) };
  assert.deepEqual(momentPeople(['v', 'photo'], photos), { 미네: 1, 휘영: 1, 나: 1 });
  const merged = mergeMomentPeople({ category: [] }, ['v'], photos);
  assert.equal(merged.mineFaces, 1);
  assert.equal(merged.people.length, 2);
});

test('얼굴 실패 후에도 소리를 처리하고 단계별 실패 상태를 남긴다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-video-stages-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const index = join(root, VAULT_REL.mediaArchiveIndex);
  const gallery = join(root, VAULT_REL.mediaFaceGallery);
  mkdirSync(dirname(index), { recursive: true });
  mkdirSync(dirname(gallery), { recursive: true });
  writeFileSync(index, `${JSON.stringify({ id: 'v', kind: 'Camera', archivePath: 'Archive/v.mov' })}\n`);
  writeFileSync(gallery, '{}');
  mkdirSync(join(base, 'Archive'));
  writeFileSync(join(base, 'Archive', 'v.mov'), 'video');
  const paths = { frameRoot: join(base, 'frames'), facesRoot: join(base, 'faces'),
    embeddings: join(base, 'faces', 'video', 'embeddings'), matches: join(base, 'faces', 'video-matches.jsonl'),
    status: join(base, 'status.json') };
  writeFileSync(paths.status, JSON.stringify({ v: { stages: { frames: { ok: true, durationSec: 999 } } } }));
  let cueCalls = 0;
  let probeTimeout;
  let time = 0;
  const result = await runMediaVideo({ root, paths, mediaRoot: base, budgetMs: 1000,
    now: () => time, durationFor: async (_path, options) => { probeTimeout = options.timeoutMs; return 12; },
    framesFor: async () => {
    throw new Error('frame unavailable');
  }, cueWorker: async () => { cueCalls += 1; time = 900; return { sound: 'none', windows: [] }; },
  output: { log() {}, error() {} } });
  assert.equal(cueCalls, 1);
  assert.equal(result.failed, 1);
  const state = JSON.parse(readFileSync(paths.status, 'utf8'));
  assert.equal(state.v.stages.frames.ok, false);
  assert.equal(state.v.stages.faces.ok, false);
  assert.equal(state.v.stages.cues.summary, '소리 없음');
  assert.equal(state.v.stages.cues.videoDurationSec, 12);
  assert.equal(probeTimeout, 100);
});

test('소리 단독 실행은 이전 프레임 길이를 재사용하지 않고 현재 영상을 확인한다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-video-cues-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const index = join(root, VAULT_REL.mediaArchiveIndex);
  mkdirSync(dirname(index), { recursive: true });
  writeFileSync(index, `${JSON.stringify({ id: 'v', kind: 'Camera', archivePath: 'Archive/v.mov' })}\n`);
  mkdirSync(join(base, 'Archive'));
  writeFileSync(join(base, 'Archive', 'v.mov'), 'current video');
  const status = join(base, 'status.json');
  writeFileSync(status, JSON.stringify({ v: { stages: { frames: { ok: true, durationSec: 999 } } } }));
  let probes = 0;
  const summary = await runMediaVideo({ root, mediaRoot: base,
    paths: { status, matches: join(base, 'matches.jsonl') }, faces: false, cues: true,
    cueWorker: async () => ({ sound: 'none', windows: [] }),
    durationFor: async () => { probes += 1; return 12; }, output: { log() {}, error() {} } });
  assert.equal(summary.processed, 1);
  assert.equal(probes, 1);
  assert.equal(JSON.parse(readFileSync(status, 'utf8')).v.stages.cues.videoDurationSec, 12);
});

test('얼굴 캐시는 프레임 집합이 달라지면 다시 판정한다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-video-cache-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const index = join(root, VAULT_REL.mediaArchiveIndex);
  const galleryPath = join(root, VAULT_REL.mediaFaceGallery);
  mkdirSync(dirname(index), { recursive: true });
  mkdirSync(dirname(galleryPath), { recursive: true });
  writeFileSync(index, `${JSON.stringify({ id: 'v', kind: 'Camera', archivePath: 'Archive/v.mov' })}\n`);
  writeFileSync(galleryPath, '{}');
  const paths = { frameRoot: join(base, 'frames'), embeddings: join(base, 'faces', 'video', 'embeddings'),
    matches: join(base, 'faces', 'video-matches.jsonl'), status: join(base, 'status.json') };
  const manifest = { id: 'v', original: 'Archive/v.mov', size: 5, mtimeMs: 12, durationSec: 10,
    frames: [{ id: 'v@0', second: 0, path: join(base, 'frames', 'v', '0.jpg') }] };
  const galleryHash = createHash('sha256').update('{}').digest('hex');
  mkdirSync(dirname(paths.matches), { recursive: true });
  writeFileSync(paths.matches, `${JSON.stringify({ ...videoPeople([], manifest), galleryHash })}\n`);
  let workerCalls = 0;
  const common = { root, paths, faces: true, cues: false, output: { log() {}, error() {} },
    faceWorker: async () => { workerCalls += 1; throw new Error('worker called'); } };
  const hit = await runMediaVideo({ ...common, framesFor: async () => manifest });
  assert.equal(hit.processed, 1);
  assert.equal(workerCalls, 0);
  const changed = { ...manifest, frames: [{ id: 'v@1', second: 1, path: join(base, 'frames', 'v', '1.jpg') }] };
  assert.notEqual(fingerprintFrames(manifest), fingerprintFrames(changed));
  const miss = await runMediaVideo({ ...common, framesFor: async () => changed });
  assert.equal(miss.failed, 1);
  assert.equal(workerCalls, 1);
  assert.equal(readFileSync(paths.matches, 'utf8').trim(), '');
});

test('원본이 바뀐 얼굴 재분석 실패는 이전 영상 이름표만 지운다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-video-stale-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const index = join(root, VAULT_REL.mediaArchiveIndex);
  const galleryPath = join(root, VAULT_REL.mediaFaceGallery);
  mkdirSync(dirname(index), { recursive: true });
  mkdirSync(dirname(galleryPath), { recursive: true });
  writeFileSync(index, `${JSON.stringify({ id: 'v', kind: 'Camera', archivePath: 'Archive/v.mov' })}\n`);
  writeFileSync(galleryPath, '{}');
  mkdirSync(join(base, 'Archive'));
  const source = join(base, 'Archive', 'v.mov');
  writeFileSync(source, 'new video');
  const paths = { status: join(base, 'status.json'), matches: join(base, 'matches.jsonl') };
  const old = { id: 'v', people: ['미네'], sourceSize: 3, sourceMtimeMs: 1, galleryHash: 'old' };
  const other = { id: 'other', people: ['나'] };
  writeFileSync(paths.matches, `${JSON.stringify(old)}\n${JSON.stringify(other)}\n`);
  const result = await runMediaVideo({ root, mediaRoot: base, paths, faces: true, cues: false,
    ids: ['v'], framesFor: async () => { throw new Error('frame failure'); },
    output: { log() {}, error() {} } });
  assert.equal(result.failed, 1);
  assert.deepEqual(readFileSync(paths.matches, 'utf8').trim().split('\n').map(JSON.parse), [other]);
  const current = { ...old, sourceSize: statSync(source).size,
    sourceMtimeMs: Math.round(statSync(source).mtimeMs),
    galleryHash: createHash('sha256').update('{}').digest('hex') };
  writeFileSync(paths.matches, `${JSON.stringify(current)}\n${JSON.stringify(other)}\n`);
  await runMediaVideo({ root, mediaRoot: base, paths, faces: true, cues: false,
    ids: ['v'], framesFor: async () => { throw new Error('temporary frame failure'); },
    output: { log() {}, error() {} } });
  assert.deepEqual(readFileSync(paths.matches, 'utf8').trim().split('\n').map(JSON.parse), [current, other]);
});
