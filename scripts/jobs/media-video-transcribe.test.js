import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { lockFilePath, lockFilesFor } from '../lib/state-writer.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { filterVideoSegments, nameVideoSegments, parseVideoTranscriptArgs,
  restoreSourceTime, reviewVideoSegments, runMediaVideoTranscribe,
  selectVideoTranscriptTargets, speechAudioPlan, speechIntervals,
  VIDEO_TRANSCRIPT_VERSION } from './media-video-transcribe.mjs';
import { transcribe } from './media-transcribe.mjs';

const ID = '1234567890abcdef';
const record = { id: ID, kind: 'Camera', occurred: '2024-05-06T00:00:00Z',
  archivePath: 'Archive/test.mp4' };

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'video-transcribe-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const mediaRoot = join(base, 'media');
  const cacheDir = join(mediaRoot, 'AudioCues');
  const outputRoot = join(mediaRoot, 'VideoTranscripts');
  const video = join(mediaRoot, record.archivePath);
  const index = join(root, VAULT_REL.mediaArchiveIndex);
  for (const path of [video, index, join(cacheDir, `${ID}.json`)]) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(video, 'video');
  writeFileSync(index, `${JSON.stringify(record)}\n`);
  const source = statSync(video);
  const cue = { version: 2, size: source.size, mtimeMs: Math.round(source.mtimeMs),
    durationSec: 8, windows: [{ start: 0, end: 4, tags: { speech: 0.5 } }] };
  writeFileSync(join(cacheDir, `${ID}.json`), JSON.stringify(cue));
  return { root, mediaRoot, cacheDir, outputRoot, cue, source, video };
}

test('말소리 기준, 캐시 원본 일치, 실패 상한, 증분 선택', (t) => {
  const f = fixture(t);
  const options = { cacheDir: f.cacheDir, outputRoot: f.outputRoot, mediaRoot: f.mediaRoot };
  assert.equal(selectVideoTranscriptTargets([record], options).selected.length, 1);
  const path = join(f.outputRoot, '2024', `${ID}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: VIDEO_TRANSCRIPT_VERSION, sourceSize: f.source.size,
    sourceMtimeMs: Math.round(f.source.mtimeMs),
    model: join(process.env.HOME, 'Pantheon', 'Models', 'whisper', 'ggml-large-v3.bin') }));
  assert.equal(selectVideoTranscriptTargets([record], options).selected.length, 0);
  assert.equal(selectVideoTranscriptTargets([record], { ...options, ids: [ID] }).selected.length, 1);
  assert.equal(selectVideoTranscriptTargets([record], { ...options, model: '/tmp/another-model.bin' }).selected.length, 1);
  rmSync(path);
  assert.equal(selectVideoTranscriptTargets([record], { ...options, failures: { [ID]: [1, 2, 3] } }).selected.length, 0);
  assert.equal(selectVideoTranscriptTargets([record], { ...options, ids: [ID],
    failures: { [ID]: [1, 2, 3] } }).selected.length, 1);
  writeFileSync(join(f.cacheDir, `${ID}.json`), JSON.stringify({ ...f.cue, size: 999 }));
  assert.equal(selectVideoTranscriptTargets([record], options).selected.length, 0);
});

test('새 분석 영상을 먼저, 기존 전사 백필은 최근 순으로 선택한다', (t) => {
  const f = fixture(t);
  const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
  const records = [record];
  for (const [index, id] of ids.entries()) {
    const entry = { ...record, id, occurred: `202${index + 3}-01-01T00:00:00Z`,
      archivePath: `Archive/${id}.mp4` };
    records.push(entry);
    const path = join(f.mediaRoot, entry.archivePath);
    writeFileSync(path, 'video');
    const source = statSync(path);
    writeFileSync(join(f.cacheDir, `${id}.json`), JSON.stringify({ ...f.cue,
      size: source.size, mtimeMs: Math.round(source.mtimeMs) }));
  }
  const selected = selectVideoTranscriptTargets(records, { cacheDir: f.cacheDir,
    outputRoot: f.outputRoot, mediaRoot: f.mediaRoot,
    priorityIds: [ID], newestFirst: true }).selected;
  assert.deepEqual(selected.map((item) => item.record.id), [ID, ids[1], ids[0]]);
});

test('예산은 다음 영상을 시작하기 전에만 확인하고 끝난 영상 결과를 남긴다', async (t) => {
  const f = fixture(t);
  const second = { ...record, id: 'aaaaaaaaaaaaaaaa', archivePath: 'Archive/second.mp4' };
  const secondPath = join(f.mediaRoot, second.archivePath);
  writeFileSync(secondPath, 'video');
  const source = statSync(secondPath);
  writeFileSync(join(f.cacheDir, `${second.id}.json`), JSON.stringify({ ...f.cue,
    size: source.size, mtimeMs: Math.round(source.mtimeMs) }));
  writeFileSync(join(f.root, VAULT_REL.mediaArchiveIndex),
    `${JSON.stringify(record)}\n${JSON.stringify(second)}\n`);
  let time = 0;
  const result = await runMediaVideoTranscribe({ root: f.root, mediaRoot: f.mediaRoot,
    cacheDir: f.cacheDir, outputRoot: f.outputRoot,
    paths: { root: join(f.mediaRoot, 'Diarize'), voices: join(f.mediaRoot, 'voices') },
    maxMinutes: 1, clock: () => time, lock: async (_path, run) => run(),
    referencesLoader: () => ({}), execute: async () => ({}), output: { log() {}, error() {} },
    transcribeFn: async () => { time += 61_000; return { durationSec: 4,
      segments: [], timings: {} }; } });
  assert.equal(result.processed, 1);
  assert.equal(result.selected, 2);
  assert.equal(existsSync(join(f.outputRoot, '2024', `${ID}.json`)), true);
  assert.equal(existsSync(join(f.outputRoot, '2024', `${second.id}.json`)), false);
});

test('08:30 직전에는 예상 전사 시간과 하이라이트 여유가 모자라면 시작하지 않는다', async (t) => {
  const f = fixture(t);
  const common = { root: f.root, mediaRoot: f.mediaRoot, cacheDir: f.cacheDir,
    outputRoot: f.outputRoot, clock: () => 0, stopAtMs: 5 * 60_000 + 6_000,
    output: { log() {} } };
  const preview = await runMediaVideoTranscribe({ ...common, dryRun: true,
    previewStartMs: 0 });
  assert.equal(preview.selected, 1);
  assert.equal(preview.estimated, 0);
  assert.equal(existsSync(f.outputRoot), false);
  let called = false;
  const result = await runMediaVideoTranscribe({ ...common,
    paths: { root: join(f.mediaRoot, 'Diarize'), voices: join(f.mediaRoot, 'voices') },
    lock: async (_path, run) => run(),
    referencesLoader: () => ({}),
    transcribeFn: async () => { called = true; },
    execute: async () => { called = true; } });
  assert.equal(result.selected, 1);
  assert.equal(result.processed, 0);
  assert.equal(result.morningDeferred, 1);
  assert.equal(called, false);
  assert.equal(existsSync(join(f.outputRoot, '2024', `${ID}.json`)), false);
});

test('화자 파이썬 세션은 25개 처리 후 재시작하고 마지막 세션도 닫는다', async (t) => {
  const f = fixture(t);
  const records = Array.from({ length: 26 }, (_, index) => ({ ...record,
    id: index.toString(16).padStart(16, '0'), archivePath: `Archive/${index}.mp4` }));
  for (const entry of records) {
    const path = join(f.mediaRoot, entry.archivePath);
    writeFileSync(path, 'video');
    const source = statSync(path);
    writeFileSync(join(f.cacheDir, `${entry.id}.json`), JSON.stringify({ ...f.cue,
      size: source.size, mtimeMs: Math.round(source.mtimeMs) }));
  }
  writeFileSync(join(f.root, VAULT_REL.mediaArchiveIndex),
    `${records.map(JSON.stringify).join('\n')}\n`);
  let opened = 0;
  let closed = 0;
  const result = await runMediaVideoTranscribe({ root: f.root, mediaRoot: f.mediaRoot,
    cacheDir: f.cacheDir, outputRoot: f.outputRoot,
    paths: { root: join(f.mediaRoot, 'Diarize'), voices: join(f.mediaRoot, 'voices') },
    lock: async (_path, run) => run(), referencesLoader: () => ({}),
    execute: async () => ({}), output: { log() {}, error() {} },
    transcribeFn: async () => ({ durationSec: 4, segments: [{ start: 0, end: 2000,
      text: '안녕' }], timings: {} }),
    sessionFactory: () => { opened += 1; return {
      run: async () => [{ turns: [{ start: 0, end: 2000, speaker: 'S0' }] }],
      close: async () => { closed += 1; },
    }; }, voiceLoader: () => [[1, 0]] });
  assert.equal(result.processed, 26);
  assert.equal(opened, 2);
  assert.equal(closed, 2);
});

test('환각 문구와 말소리 바깥 전사 제거', () => {
  const intervals = speechIntervals({ windows: [
    { start: 0, end: 4, tags: { speech: 0.3 } },
    { start: 8, end: 12, tags: { speech: 0.29 } },
  ] });
  assert.deepEqual(intervals, [{ start: 0, end: 4 }]);
  assert.deepEqual(filterVideoSegments([
    { start: 0, end: 1000, text: '시청해 주셔서 감사합니다' },
    { start: 1000, end: 2000, text: '미네 안녕' },
    { start: 8000, end: 9000, text: '없는 말' },
  ], intervals), [{ start: 1000, end: 2000, text: '미네 안녕' }]);
});

test('말소리 창만 이어 붙이고 원본 시각으로 복원한다', () => {
  const intervals = speechIntervals({ windows: [
    { start: 0, end: 4, tags: { speech: 0.5, singing: 0 } },
    { start: 2, end: 6, tags: { speech: 0.6, singing: 0 } },
    { start: 6, end: 10, tags: { speech: 0.7, singing: 0.6 } },
    { start: 12, end: 14, tags: { speech: 0.6, singing: 0 } },
  ] });
  assert.deepEqual(intervals, [{ start: 0, end: 6 }, { start: 12, end: 14 }]);
  const plan = speechAudioPlan(intervals);
  assert.equal(plan.at(-1).audioEndMs, 8000);
  assert.deepEqual(restoreSourceTime([{ start: 6500, end: 7500, text: '안녕' }], plan),
    [{ start: 12500, end: 13500, text: '안녕' }]);
});

test('반복과 알려진 헛자막, no-speech 확률을 이유와 함께 버린다', () => {
  const segments = [
    { start: 0, end: 1000, text: '안녕' },
    { start: 1000, end: 2000, text: '안녕' },
    { start: 2000, end: 3000, text: '안녕' },
    { start: 3000, end: 4000, text: "'미리보기'는 미리보기입니다" },
    { start: 4000, end: 5000, text: '여보세요', noSpeechProb: 0.8 },
    { start: 5000, end: 6000, text: '실제 대화' },
  ];
  const result = reviewVideoSegments(segments, [{ start: 0, end: 6 }]);
  assert.deepEqual(result.kept.map((part) => part.text), ['실제 대화']);
  assert.deepEqual(result.dropped.map((part) => part.reason), [
    'repetition', 'repetition', 'repetition', 'known-hallucination', 'no-speech-probability',
  ]);
});

test('녹음 화자 기준을 쓰고 짧은 영상은 한 명만 판정', () => {
  const reference = { 미네: { mean: [1, 0], minSimilarity: 0.45,
    period: { first: '2024-01-01', last: '2024-12-31' } } };
  const segments = [{ start: 0, end: 2000, text: '안녕' }];
  const turns = [{ start: 0, end: 2000, speaker: 'S0' }];
  const result = nameVideoSegments(segments, turns, [[1, 0]], reference, record.occurred);
  assert.equal(result.segments[0].name, '미네');
  assert.equal(result.speakers.evidence.S0.basis, 'voice');
  const mixed = nameVideoSegments([
    { start: 0, end: 2000, text: '안녕' }, { start: 2000, end: 3000, text: '응' },
  ], [...turns, { start: 2000, end: 3000, speaker: 'S1' }], [[1, 0], [0, 1]],
  reference, record.occurred);
  assert.equal(mixed.segments[1].name, null);
  assert.equal(mixed.segments[1].uncertain, true);
});

test('dry-run 무쓰기, 결과 0600, 재실행 증분', async (t) => {
  const f = fixture(t);
  const options = { root: f.root, mediaRoot: f.mediaRoot, cacheDir: f.cacheDir,
    outputRoot: f.outputRoot, paths: { root: join(f.mediaRoot, 'Diarize'), voices: join(f.mediaRoot, 'voices') },
    output: { log() {}, error() {} }, lock: async (_path, run) => run(),
    referencesLoader: () => ({ 미네: { mean: [1, 0], minSimilarity: 0.45 } }),
    transcribeFn: async (_record, settings) => {
      assert.equal(settings.language, 'ko');
      assert.notEqual(settings.noGpu, true); // GPU 사용(2026-10-18 실측 8배)
      assert.equal(settings.inputDurationSec, 4);
      return { durationSec: 4, segments: [{ start: 0, end: 2000, text: '미네 안녕' }] };
    },
    diarizeFn: async (backend) => {
      assert.equal(backend, 'pyannote-single');
      return [{ id: ID, turns: [{ start: 0, end: 2000, speaker: 'S0' }] }];
    },
    voiceLoader: () => [[1, 0]], execute: async () => ({}) };
  const dry = await runMediaVideoTranscribe({ ...options, dryRun: true });
  assert.equal(dry.selected, 1);
  assert.equal(existsSync(f.outputRoot), false);
  const done = await runMediaVideoTranscribe(options);
  assert.equal(done.processed, 1);
  const path = join(f.outputRoot, '2024', `${ID}.json`);
  const result = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(result.segments[0].name, '미네');
  assert.equal(result.speakers.evidence.S0.basis, 'voice');
  assert.equal(lockFilesFor(join(f.root, VAULT_REL.mediaTranscribeState)).some((lock) => existsSync(lock)), false);
  assert.equal((await runMediaVideoTranscribe(options)).selected, 0);
  rmSync(path);
  // 전사 잡이 공용 락을 쥐고 있으면(새 점 파일 이름·전환 기간의 예전 이름 모두) 영상 전사는 양보한다.
  const transcribeState = join(f.root, VAULT_REL.mediaTranscribeState);
  for (const lock of lockFilesFor(transcribeState)) {
    writeFileSync(lock, `${process.pid}:test`);
    assert.equal((await runMediaVideoTranscribe(options)).busy, true, lock);
    rmSync(lock);
  }
  assert.equal(lockFilePath(transcribeState), join(f.root, '95_Etna', 'Media', '.transcribe-state.json.lock'));
  const noSpeaker = await runMediaVideoTranscribe({ ...options,
    diarizeFn: async () => [{ id: ID, error: 'expected 1..3 speakers with embeddings, found 0' }] });
  assert.equal(noSpeaker.processed, 1);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).segments[0].name, null);
  rmSync(path);
  const invalidVoice = await runMediaVideoTranscribe({ ...options, voiceLoader: () => [[NaN, 0]] });
  assert.equal(invalidVoice.processed, 1);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).speakers.reason, '목소리 특징값 오류');
});

test('CLI 옵션 검사', () => {
  assert.deepEqual(parseVideoTranscriptArgs(['--ids=1234567890abcdef', '--limit=10', '--max-minutes=2', '--dry-run']),
    { ids: [ID], limit: 10, maxMinutes: 2, dryRun: true });
  assert.throws(() => parseVideoTranscriptArgs(['--bad']), /옵션/);
});

test('자동 감지가 한국어·영어 밖이면 한국어로 다시 전사한다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'video-language-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const binary = (name, body) => {
    const path = join(base, name);
    writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const ffprobePath = binary('ffprobe', "process.stdout.write('5\\n')");
  const ffmpegPath = binary('ffmpeg', "require('fs').writeFileSync(process.argv.at(-1), 'wav')");
  const whisperPath = binary('whisper', `
const fs = require('fs');
const language = process.argv[process.argv.indexOf('-l') + 1];
const prefix = process.argv[process.argv.indexOf('-of') + 1];
fs.appendFileSync(${JSON.stringify(join(base, 'languages'))}, language + '\\n');
fs.writeFileSync(prefix + '.json', JSON.stringify({
  result: { language: language === 'auto' ? 'ro' : language },
  transcription: [{ offsets: { from: 0, to: 1000 },
    text: language === 'auto' ? 'străin' : '안녕하세요' }],
}));
`);
  const result = await transcribe({ ...record, path: join(base, 'video.mp4') }, {
    ffprobePath, ffmpegPath, whisperPath, model: join(base, 'model.bin'),
    temporaryRoot: base, now: '2026-10-18', language: 'auto', noGpu: true,
  });
  assert.equal(result.text, '안녕하세요');
  assert.equal(result.detectedLanguage, 'ko');
  assert.equal(result.languageFallback, 'ro');
  assert.equal(readFileSync(join(base, 'languages'), 'utf8'), 'auto\nko\n');
});

test('미네 기준 합치기: 녹음 기준 연도를 쓰고, 녹음에 없는 해만 통화 기준을 더한다', async () => {
  const { mergeMineReferences } = await import('./media-video-transcribe.mjs');
  const calls = { vectors: [[0, 1], [0, 2], [0, 3]], minSimilarity: 0.5,
    period: { first: '2024-12-26', last: '2026-10-16' },
    years: [{ year: 2024, index: 0 }, { year: 2025, index: 1 }, { year: 2026, index: 2 }] };
  const merged = mergeMineReferences(calls, [[1, 0], [2, 0]],
    { minSimilarity: 0.45, period: { first: '2017-01-20', last: '2025-09-20' }, years: [{ year: 2017, index: 0 }, { year: 2025, index: 1 }] });
  assert.deepEqual(merged.years.map((y) => y.year), [2017, 2025, 2024, 2026]);
  assert.deepEqual(merged.vectors[merged.years.find((y) => y.year === 2025).index], [2, 0]);
  assert.deepEqual(merged.vectors[merged.years.find((y) => y.year === 2026).index], [0, 3]);
  assert.deepEqual(merged.period, { first: '2017-01-20', last: '2026-10-16' });
  assert.equal(merged.minSimilarity, 0.45);
});
