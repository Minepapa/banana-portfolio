import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { runMediaVision, runSwiftVision, loadVisionConfig, groupVisionDuplicates } from './media-vision.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'media-vision-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const mediaRoot = join(base, 'media');
  mkdirSync(join(mediaRoot, 'Archive'), { recursive: true });
  mkdirSync(join(mediaRoot, 'Imports'), { recursive: true });
  const archive = join(root, VAULT_REL.mediaArchiveIndex);
  const imports = join(root, VAULT_REL.mediaImportsIndex);
  mkdirSync(dirname(archive), { recursive: true });
  const index = join(root, VAULT_REL.mediaVisionIndex);
  const prints = join(base, 'prints');
  const silent = { log() {} };
  const save = (path, records) => writeFileSync(path, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return { root, mediaRoot, archive, imports, index, prints, save, output: silent };
}

const record = (id, source = 'archive', time = '2030-01-02T10:00:00+09:00') => ({
  id, capturedAt: time, ...(source === 'archive' ? { archivePath: `Archive/${id}.jpg` }
    : { importPath: `Imports/${id}.mov`, kind: 'Import' }),
});

function runnerFor(f, results, calls) {
  return async (inputs) => {
    calls.push(inputs.map((item) => item.id));
    return inputs.map((item) => {
      const result = results[item.id];
      if (result.print) {
        const bytes = Buffer.alloc(result.print.length * 4);
        result.print.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
        writeFileSync(item.printPath, bytes);
      }
      return JSON.stringify({ id: item.id, labels: [], text: '', textLength: 0, faces: 0,
        aesthetic: null, isUtility: null, printDims: result.print?.length ?? null, ...result });
    });
  };
}

test('source·limit·이미 분석한 id·dry-run·재분석과 실패 한 줄', async (t) => {
  const f = fixture(t);
  f.save(f.archive, [record('a'), record('b'), record('c')]);
  f.save(f.imports, [record('d', 'imports')]);
  f.save(f.index, [{ id: 'a', schema: 2, source: 'archive', text: '이전' }]);
  const calls = [];
  const runner = runnerFor(f, { a: { text: '새 분석' }, b: { error: '손상' },
    c: { textLength: 80 }, d: { frames: 2 } }, calls);
  const dry = await runMediaVision({ ...f, source: 'all', limit: 2, dryRun: true, runner });
  assert.equal(dry.selected, 2);
  assert.deepEqual(calls, []);
  const first = await runMediaVision({ ...f, source: 'archive', limit: 2, runner });
  assert.deepEqual(calls[0], ['b', 'c']);
  assert.equal(first.failed, 1);
  let rows = readFileSync(f.index, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.find((row) => row.id === 'b').error, '손상');
  assert.equal(rows.find((row) => row.id === 'c').utility, true);
  assert.equal(rows.find((row) => row.id === 'a').text, '이전');
  await runMediaVision({ ...f, source: 'imports', runner });
  rows = readFileSync(f.index, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.find((row) => row.id === 'd').frames, 2);
  await runMediaVision({ ...f, ids: ['a'], runner });
  rows = readFileSync(f.index, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter((row) => row.id === 'a').length, 1);
  assert.equal(rows.find((row) => row.id === 'a').text, '새 분석');
  assert.equal(existsSync(join(f.mediaRoot, 'Archive', 'a.jpg')), false);
});

test('설정 기본값과 Vision isUtility 우선', async (t) => {
  const f = fixture(t);
  assert.equal(loadVisionConfig(join(f.root, VAULT_REL.mediaVisionLabels)).duplicateWindowSec, 120);
  f.save(f.archive, [record('a')]);
  await runMediaVision({ ...f, runner: runnerFor(f, { a: { isUtility: true, textLength: 1 } }, []) });
  assert.equal(JSON.parse(readFileSync(f.index, 'utf8')).utility, true);
});

test('깨진 labels 설정은 기본값으로 분석을 계속한다', async (t) => {
  const f = fixture(t);
  f.save(f.archive, [record('a')]);
  writeFileSync(join(f.root, VAULT_REL.mediaVisionLabels), JSON.stringify({ labels: [], ignore: {} }));
  const logs = [];
  const result = await runMediaVision({ ...f, output: { log: (line) => logs.push(line) },
    runner: runnerFor(f, { a: {} }, []) });
  assert.equal(result.analyzed, 1);
  assert.equal(logs.filter((line) => line.startsWith('[media-vision] vision 설정 오류:')).length, 1);
});

test('연사 거리와 시간 창: 가까운 두 장만 묶고 창 밖은 비교하지 않는다', async (t) => {
  const f = fixture(t);
  mkdirSync(f.prints, { recursive: true });
  const times = new Map([['a', '2030-01-02T00:00:00Z'], ['b', '2030-01-02T00:01:00Z'],
    ['c', '2030-01-02T00:01:30Z'], ['d', '2030-01-02T00:10:00Z']]);
  for (const [id, value] of [['a', 0], ['b', 0.1], ['c', 1], ['d', 0]]) {
    const bytes = Buffer.alloc(4); bytes.writeFloatLE(value);
    writeFileSync(join(f.prints, `${id}.f32`), bytes);
  }
  const rows = [...times.keys()].map((id) => ({ id, printDims: 1 }));
  groupVisionDuplicates(rows, times, f.prints, { duplicateWindowSec: 120, duplicateDistance: 0.35 });
  assert.deepEqual(rows.map((row) => row.duplicateGroup), ['a', 'a', undefined, undefined]);
});

test('200개씩 저장하고 두 번째 묶음 크래시의 미응답 첫 id를 기록한다', async (t) => {
  const f = fixture(t);
  f.save(f.archive, Array.from({ length: 202 }, (_, index) => record(`a${String(index).padStart(3, '0')}`)));
  const calls = [];
  const runner = async (inputs) => {
    calls.push(inputs.map((input) => input.id));
    if (calls.length === 2) {
      assert.equal(readFileSync(f.index, 'utf8').trim().split('\n').length, 200);
      return { lines: [JSON.stringify({ id: inputs[0].id, labels: [] })], crashed: true };
    }
    return inputs.map((input) => JSON.stringify({ id: input.id, labels: [] }));
  };
  const result = await runMediaVision({ ...f, runner });
  const rows = readFileSync(f.index, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map((call) => call.length), [200, 2]);
  assert.equal(result.analyzed, 201);
  assert.equal(result.failed, 1);
  assert.equal(rows.find((row) => row.id === 'a201').error, 'crash');
  assert.equal(rows[0].schema, 2);
});

test('schema 1 재분석, 새 파일 우선, error 세 번까지만 재시도', async (t) => {
  const f = fixture(t);
  f.save(f.archive, [record('old'), record('fresh'), record('failed'), record('done')]);
  f.save(f.imports, [record('imported', 'imports')]);
  f.save(f.index, [{ id: 'old', schema: 1 }, { id: 'failed', schema: 2, error: 'crash', attempts: 2 },
    { id: 'done', schema: 2 }]);
  const calls = [];
  const runner = async (inputs) => {
    calls.push(inputs.map((input) => input.id));
    return inputs.map((input) => JSON.stringify({ id: input.id, ...(input.id === 'failed' ? { error: 'crash' } : {}) }));
  };
  await runMediaVision({ ...f, runner });
  assert.deepEqual(calls[0], ['old', 'fresh', 'imported', 'failed']);
  let rows = readFileSync(f.index, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.find((row) => row.id === 'failed').attempts, 3);
  assert.equal(rows.find((row) => row.id === 'old').schema, 2);
  await runMediaVision({ ...f, runner });
  assert.equal(calls.length, 1);
  rows = readFileSync(f.index, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.find((row) => row.id === 'failed').attempts, 3);
});

test('Swift 타임아웃은 crash로 보고하고 잘린 줄을 버린다', async (t) => {
  const f = fixture(t);
  const binary = join(f.root, 'slow-runner');
  writeFileSync(binary, '#!/bin/sh\necho \'{"id":"a","labels":[]}\'\nprintf \'{"id":"b"\'\nwhile :; do :; done\n', { mode: 0o755 });
  const result = await runSwiftVision([{ id: 'a' }, { id: 'b' }], { binary, timeoutMs: 300 });
  assert.equal(result.crashed, true);
  assert.equal(result.lines.every((line) => JSON.parse(line).id === 'a'), true);
});

test('연쇄 거리로 대표 시간 창을 넘는 사진은 합치지 않는다', (t) => {
  const f = fixture(t);
  mkdirSync(f.prints, { recursive: true });
  const times = new Map([['a', '2030-01-02T00:00:00Z'], ['b', '2030-01-02T00:01:00Z'],
    ['c', '2030-01-02T00:02:00Z']]);
  for (const id of times.keys()) {
    const bytes = Buffer.alloc(4); bytes.writeFloatLE(0);
    writeFileSync(join(f.prints, `${id}.f32`), bytes);
  }
  const rows = [...times.keys()].map((id) => ({ id, printDims: 1 }));
  groupVisionDuplicates(rows, times, f.prints, { duplicateWindowSec: 90, duplicateDistance: 0.35 });
  assert.deepEqual(rows.map((row) => row.duplicateGroup), ['a', 'a', undefined]);
});

test('Swift 빌드 스모크: 설치 도구/SDK가 맞으면 컴파일', (t) => {
  try { execFileSync('swiftc', ['--version'], { stdio: 'pipe' }); }
  catch { t.skip('swiftc 없음'); return; }
  const f = fixture(t);
  const binary = join(f.root, 'media-vision');
  try {
    execFileSync('swiftc', ['-O', 'scripts/tools/vision/media-vision.swift', '-o', binary],
      { stdio: 'pipe', timeout: 120000, env: { ...process.env,
        CLANG_MODULE_CACHE_PATH: join(f.root, 'clang-cache'),
        SWIFT_MODULE_CACHE_PATH: join(f.root, 'swift-cache') } });
    assert.equal(existsSync(binary), true);
  } catch (error) {
    const message = String(error.stderr || error.message);
    if (/SDK is not supported by the compiler|Operation not permitted/.test(message)) {
      t.skip(`Swift SDK/샌드박스 제한: ${message.split('\n').find((line) => /SDK is not supported|Operation not permitted/.test(line))}`);
      return;
    }
    throw error;
  }
});
