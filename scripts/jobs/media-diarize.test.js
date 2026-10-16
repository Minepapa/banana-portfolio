import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
  renameSync, symlinkSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { selectTrial, combineSegments, findOwner, parsePythonOutput, runPython,
  availableBackends, runTrial, parseArgs } from './media-diarize.mjs';

function candidate(id, date, counterpart, durationSec = 60) {
  return { id, kind: 'Calls', counterpart,
    transcript: { occurred: `${date}T12:00:00+09:00`, durationSec,
      segments: [{ start: 0, end: 1000, text: '안녕' }] } };
}

test('selectTrial chooses calls of distinct dates and both counterparts', () => {
  const rows = [candidate('a', '2026-10-10', '미네'), candidate('b', '2026-10-09', '미네'),
    candidate('c', '2026-10-08', '휘영'), candidate('d', '2026-10-07', '미네', 20),
    candidate('e', '2026-10-06', '휘영', 601)];
  assert.deepEqual(selectTrial(rows, { limit: 2 }).map((row) => row.id), ['a', 'c']);
  assert.deepEqual(selectTrial(rows, { ids: ['b'] }).map((row) => row.id), ['b']);
  assert.throws(() => selectTrial(rows, { ids: ['d'] }), /시험 대상/);
  assert.deepEqual(selectTrial(rows, { limit: 3 }).map((row) => row.id), ['a', 'c', 'b']);
});

test('zero or negative duration segments remain uncertain', () => {
  const rows = combineSegments([{ start: 1000, end: 1000, text: 'a' },
    { start: 2000, end: 1000, text: 'b' }], []);
  assert.deepEqual(rows.segments.map((row) => row.uncertain), [true, true]);
});

test('combineSegments assigns maximum overlap, uncertainty, and merges runs', () => {
  const segments = [
    { start: 0, end: 1000, text: '하나' }, { start: 1000, end: 2000, text: '둘' },
    { start: 2000, end: 3000, text: '셋' }];
  const result = combineSegments(segments, [
    { start: 0, end: 950, speaker: 'S0' }, { start: 1050, end: 1200, speaker: 'S0' },
    { start: 2100, end: 3000, speaker: 'S1' }]);
  assert.deepEqual(result.segments.map((row) => [row.speaker, row.uncertain]),
    [['S0', false], ['S0', true], ['S1', false]]);
  assert.deepEqual(result.utterances.map((row) => [row.text, row.uncertain]),
    [['하나 둘', true], ['셋', false]]);
});

test('findOwner finds common voice across different counterparts and records margin', () => {
  const rows = [
    { id: 'a', counterpart: '미네', voices: [[1, 0], [0, 1]] },
    { id: 'b', counterpart: '휘영', voices: [[0, -1], [0.99, 0.1]] },
    { id: 'c', counterpart: '미네', voices: [[0.97, 0.2], [-0.9, 0]] },
  ];
  const found = findOwner(rows);
  assert.deepEqual(found.map((row) => row.owner), ['S0', 'S1', 'S0']);
  assert.ok(found.every((row) => row.margin > 0));
});

test('findOwner evaluates 20 calls within a few seconds', () => {
  const calls = Array.from({ length: 20 }, (_, index) => ({ id: String(index),
    counterpart: index % 2 ? '휘영' : '미네',
    voices: index % 3 ? [[1, 0], [0, 1]] : [[0, 1], [1, 0]] }));
  const started = performance.now();
  assert.equal(findOwner(calls).length, 20);
  assert.ok(performance.now() - started < 5000);
});

test('parsePythonOutput handles missing rows, per-item errors, malformed output', () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  const parsed = parsePythonOutput('{"id":"a","error":"bad wav"}\n', items, 'sherpa');
  assert.equal(parsed[0].error, 'bad wav');
  assert.match(parsed[1].error, /누락/);
  assert.throws(() => parsePythonOutput('{broken', items, 'sherpa'));
  assert.throws(() => parsePythonOutput('{"id":"z","error":"bad"}', items, 'sherpa'));
});

test('parsePythonOutput accepts device metadata and legacy results without it', () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  const rows = [
    { id: 'a', backend: 'pyannote', device: 'mps', turns: [], ms: 8, audioSec: 70 },
    { id: 'b', backend: 'pyannote', turns: [], ms: 52, audioSec: 70 },
  ];
  assert.deepEqual(parsePythonOutput(rows.map((row) => JSON.stringify(row)).join('\n'),
    items, 'pyannote'), rows);
});

test('runPython sends JSON to injected process and parses response', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  let sent = '';
  child.stdin.on('data', (chunk) => { sent += chunk; });
  const oldToken = process.env.HF_TOKEN;
  process.env.HF_TOKEN = 'test-secret-never-forward';
  let workerEnvironment;
  const task = runPython('sherpa', [{ id: 'a', wav: '/tmp/a.wav' }], {
    spawnProcess: (_command, _args, options) => {
      workerEnvironment = options.env;
      return child;
    }, python: '/fake/python', voicesDir: '/chosen/voices' });
  if (oldToken === undefined) delete process.env.HF_TOKEN;
  else process.env.HF_TOKEN = oldToken;
  child.stdout.write('{"id":"a","backend":"sherpa","turns":[],"ms":1,"audioSec":2}\n');
  child.emit('close', 0);
  assert.equal((await task)[0].id, 'a');
  assert.equal(JSON.parse(sent).numSpeakers, 2);
  assert.equal(JSON.parse(sent).voicesDir, '/chosen/voices');
  assert.equal(workerEnvironment.HF_TOKEN, undefined);
  assert.equal(workerEnvironment.HF_HUB_OFFLINE, '1');
});

test('runPython waits for worker close after cancellation', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  const controller = new AbortController();
  let closed = false;
  const task = runPython('sherpa', [{ id: 'a', wav: '/tmp/a.wav' }], {
    signal: controller.signal,
    spawnProcess: (_command, _args, options) => {
      options.signal.addEventListener('abort', () => {
        child.emit('error', new Error('cancelled'));
        setTimeout(() => { closed = true; child.emit('close', null); }, 10);
      }, { once: true });
      return child;
    } });
  controller.abort();
  await assert.rejects(task, /cancelled/);
  assert.equal(closed, true);
});

test('parseArgs rejects duplicate IDs and more than 20 IDs', () => {
  assert.throws(() => parseArgs(['--trial', '--ids=aaaaaaaaaaaaaaaa,aaaaaaaaaaaaaaaa']));
  assert.throws(() => parseArgs(['--trial', '--ids=aaaaaaaaaaaaaaaa,']));
  assert.throws(() => parseArgs(['--trial', `--ids=${Array.from({ length: 21 },
    (_, i) => i.toString(16).padStart(16, '0')).join(',')}`]));
});

test('both worker failures still write summary; invalid archive row is skipped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'diarize-test-'));
  const mediaRoot = join(root, 'media');
  const paths = { mediaRoot, trial: join(root, 'trial'), voices: join(root, 'voices'),
    pyannote: join(root, 'pyannote') };
  const rows = [
    { id: 'aaaaaaaaaaaaaaaa', kind: 'Calls', occurred: '2026-01-01', archivePath: 'Archive/a.wav', person: '미네' },
    { id: 'bbbbbbbbbbbbbbbb', kind: 'Calls', occurred: '2026-01-02', archivePath: 'Archive/b.wav', person: '휘영' },
    { id: 'cccccccccccccccc', kind: 'Calls', occurred: '2026-01-03', archivePath: '../outside.wav', person: '미네' },
  ];
  const indexPath = join(root, VAULT_REL.mediaArchiveIndex);
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  for (const row of rows) {
    const transcript = { occurred: `${row.occurred}T12:00:00+09:00`, durationSec: 60,
      people: [row.person], segments: [{ start: 0, end: 1000, text: 'test' }] };
    const transcriptPath = join(root, VAULT_REL.mediaTranscripts, '2026', `${row.id}.json`);
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, JSON.stringify(transcript));
    if (row.archivePath.startsWith('Archive/')) {
      const audioPath = join(mediaRoot, row.archivePath);
      mkdirSync(dirname(audioPath), { recursive: true });
      writeFileSync(audioPath, 'fake');
    }
  }
  mkdirSync(join(paths.pyannote, 'speaker-diarization-community-1'), { recursive: true });
  writeFileSync(join(paths.pyannote, 'speaker-diarization-community-1', 'config.yaml'), 'fake');
  const warnings = [];
  const called = [];
  try {
    await assert.rejects(runTrial({ root, paths, limit: 3,
      output: { warn: (message) => warnings.push(message), log() {} },
      exec: async (_cmd, _args, options) => { assert.equal(options.timeout, 300_000); },
      runWorker: async (name, items, options) => {
        called.push([name, items.length, options.voicesDir]);
        throw new Error('mock reject');
      } }), /시험 성공 통화/);
    assert.deepEqual(called, [['sherpa', 2, paths.voices], ['pyannote', 2, paths.voices]]);
    assert.match(warnings.join('\n'), /Archive 경로 오류/);
    assert.match(readFileSync(join(paths.trial, 'summary.md'), 'utf8'), /통화 화자 분리 시험/);

    renameSync(join(mediaRoot, 'Archive'), join(mediaRoot, 'Original'));
    symlinkSync(join(mediaRoot, 'Original'), join(mediaRoot, 'Archive'));
    warnings.length = 0;
    await assert.rejects(runTrial({ root, paths, ids: [rows[0].id], backend: 'sherpa',
      output: { warn: (message) => warnings.push(message), log() {} },
      runWorker: async () => { throw new Error('mock reject'); } }), /시험 성공 통화/);
    assert.match(warnings.join('\n'), /Archive 심볼릭 링크/);
    unlinkSync(join(mediaRoot, 'Archive'));
    renameSync(join(mediaRoot, 'Original'), join(mediaRoot, 'Archive'));

    const controller = new AbortController();
    let wav;
    let childClosed = false;
    await assert.rejects(runTrial({ root, paths, ids: [rows[0].id], backend: 'sherpa',
      signal: controller.signal, output: { warn() {}, log() {} },
      exec: (_command, args, options) => new Promise((_resolve, reject) => {
        wav = args.at(-1);
        assert.equal(options.signal.aborted, false);
        options.signal.addEventListener('abort', () => setTimeout(() => {
          childClosed = true;
          reject(new Error('aborted'));
        }, 20), { once: true });
        controller.abort();
      }) }), /aborted/);
    assert.equal(childClosed, true);
    assert.equal(existsSync(dirname(wav)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pyannote is skipped without token/model for both selection', () => {
  assert.deepEqual(availableBackends('both', false), ['sherpa']);
  assert.throws(() => availableBackends('pyannote', false), /모델 없음/);
});
