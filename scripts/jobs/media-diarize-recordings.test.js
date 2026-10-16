import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { recordingKind, RECORDING_DIALOGUE_KINDS, selectRecordings, assignRecordingNames,
  evaluatePersonCandidate, personCandidate, confirmPerson, runRecordings, parseArgs,
  MINE_RECORDING_RULE, selectYearlyPersonCalls,
  renderSpeakerNote, runPython, parsePythonOutput } from './media-diarize.mjs';
import { renderDialogue } from '../lib/media-dialogue.mjs';
import { buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';

const ID = '0000000000000001';
const QUIET = { log() {}, error() {} };
const RULES = [{ type: 'conversation', path: `${VAULT_REL.mediaConversations}/{YYYY}/`,
  pathRegex: /^20_Records\/23_Conversations\/\d{4}\/[^/]+\.md$/,
  titleRegex: /^\d{4}-\d{2}-\d{2} \S/,
  required: { bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'],
    extra: ['occurred', 'people', 'origin', 'convKind'] } }];
function put(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function npy(matrix) {
  const body = `{'descr': '<f4', 'fortran_order': False, 'shape': (${matrix.length}, ${matrix[0].length}), }`;
  const header = Buffer.from(`${body}${' '.repeat((16 - (10 + body.length + 1) % 16) % 16)}\n`, 'latin1');
  const buffer = Buffer.alloc(10 + header.length + matrix.length * matrix[0].length * 4);
  buffer.write('\x93NUMPY', 0, 'latin1'); buffer[6] = 1;
  buffer.writeUInt16LE(header.length, 8); header.copy(buffer, 10);
  let offset = 10 + header.length;
  for (const row of matrix) for (const value of row) { buffer.writeFloatLE(value, offset); offset += 4; }
  return buffer;
}

test('녹음 종류는 보관본 제목의 정확한 세 번째 단어만 사용한다', () => {
  for (const kind of RECORDING_DIALOGUE_KINDS) assert.equal(recordingKind({ archivePath:
    `Archive/2030/01/Recordings/2030-01-01 미네 ${kind} 주제.m4a` }), kind);
  for (const kind of ['노래', '동요', '연주', '알람', '동화', '웃음', '기도', '혼잣말'])
    assert.equal(RECORDING_DIALOGUE_KINDS.includes(recordingKind({ archivePath:
      `Archive/2030/01/Recordings/2030-01-01 미네 ${kind} 대화.m4a` })), false);
  assert.equal(recordingKind({ archivePath: 'Archive/2030/01/Recordings/미네 대화.m4a' }), null);
});

test('녹음 이름은 기준별 최고 유사 화자에게 한 번씩만 붙는다', () => {
  const refs = { 나: { mean: [1, 0, 0], minSimilarity: 0.5 },
    휘영: { mean: [0, 1, 0], minSimilarity: 0.5 } };
  assert.deepEqual(assignRecordingNames([[1, 0, 0], [0, 1, 0], [0, 0, 1]], ['미네'], refs).labels,
    { S0: '나', S1: '휘영', S2: '미네' });
  assert.deepEqual(assignRecordingNames([[1, 0, 0], [0, 0, 1]], ['미네'], refs).labels,
    { S0: '나', S1: '미네' });
  assert.deepEqual(assignRecordingNames([[0, 0, 1], [0, 0, -1]], ['미네', '지인'], refs).labels,
    { S0: '다른 사람 1', S1: '다른 사람 2' });
  assert.deepEqual(assignRecordingNames([[1, 0, 0]], ['미네'], refs).labels, { S0: '나' });
  assert.throws(() => assignRecordingNames([], [], refs), /1~3/);
  assert.throws(() => assignRecordingNames([[1], [1], [1], [1]], [], refs), /1~3/);
});

test('미네만 알려진 녹음은 나·휘영 외의 최장 발화 화자를 미네로 둔다', () => {
  const voices = [[1, 0, 0], [0, 0, 1], [0, 0, -1]];
  const references = { 나: { mean: [1, 0, 0], minSimilarity: 0.5 } };
  const turns = [
    { speaker: 'S0', start: 0, end: 8 },
    { speaker: 'S1', start: 8, end: 9 },
    { speaker: 'S2', start: 9, end: 13 },
    { speaker: 'S2', start: 14, end: 20 },
  ];
  assert.deepEqual(assignRecordingNames(voices, ['나', '휘영', '미네'], references, turns).labels,
    { S0: '나', S2: '미네', S1: '다른 사람' });
  assert.deepEqual(assignRecordingNames(voices.slice(0, 2), ['미네'], references, turns).labels,
    { S0: '나', S1: '미네' });
  assert.deepEqual(assignRecordingNames(voices, ['미네', '지인'], references, turns).labels,
    { S0: '나', S1: '다른 사람 1', S2: '다른 사람 2' });
  assert.deepEqual(assignRecordingNames(voices, [], references, turns).labels,
    { S0: '나', S1: '다른 사람 1', S2: '다른 사람 2' });
  assert.deepEqual(assignRecordingNames(voices, null, references, turns).labels,
    { S0: '나', S1: '다른 사람 1', S2: '다른 사람 2' });
  assert.deepEqual(assignRecordingNames(voices, ['[[People/미네|미네]]'], references, turns).labels,
    { S0: '나', S2: '미네', S1: '다른 사람' });
  assert.deepEqual(assignRecordingNames(voices, '[[People/미네|미네]]', references, turns).labels,
    { S0: '나', S2: '미네', S1: '다른 사람' });
});

test('휘영 녹음 기준선은 등록값보다 낮아지지 않고 0.45를 밑돌지 않는다', () => {
  const refs = { 휘영: { mean: [0, 1], minSimilarity: 0.236 } };
  const voice = (similarity) => [Math.sqrt(1 - similarity ** 2), similarity];
  assert.deepEqual(assignRecordingNames([voice(0.336)], ['미네'], refs).labels, { S0: '미네' });
  assert.deepEqual(assignRecordingNames([voice(0.336)], ['미네', '휘영'], refs).labels,
    { S0: '미네' });
  assert.deepEqual(assignRecordingNames([voice(0.48)], ['미네'], refs).labels, { S0: '휘영' });
  assert.deepEqual(assignRecordingNames([voice(0.48)], ['미네'], {
    휘영: { ...refs.휘영, minSimilarity: 0.5 } }).labels, { S0: '미네' });
});

test('미네 기준은 강한 목소리를 우선하고 약한 경우에는 발화 비율·기간을 결합한다', () => {
  const voice = (similarity) => [Math.sqrt(1 - similarity ** 2), similarity];
  const references = { 미네: { mean: [0, 1], minSimilarity: 0.8,
    period: { first: '2029-01-01', last: '2030-12-31' } } };
  const turns = [{ speaker: 'S0', start: 0, end: 35 }, { speaker: 'S1', start: 35, end: 100 }];
  const strong = assignRecordingNames([voice(0.9), voice(0.5)], [], references, turns, '2030-05-01');
  assert.equal(strong.labels.S0, '미네');
  assert.equal(strong.evidence.S0.basis, 'voice');
  assert.equal(strong.evidence.S0.share, 0.35);
  assert.equal(strong.evidence.S0.mineSimilarity > 0.89, true);
  const near = assignRecordingNames([voice(0.7), voice(0.3)], ['미네'], references, turns, '2030-05-01');
  assert.equal(near.labels.S0, '미네');
  assert.equal(near.evidence.S0.basis, 'voice+share');
  const far = assignRecordingNames([voice(0.7), voice(0.3)], ['미네'], references, turns, '2034-05-01');
  assert.equal(far.labels.S1, '미네');
  assert.equal(far.evidence.S1.basis, 'voice+share');
  assert.equal(MINE_RECORDING_RULE.farYears, 3);
  assert.equal(assignRecordingNames([voice(0.6), voice(0.5)], [], references, turns,
    '2030-05-01').labels.S0, '다른 사람 1');
  assert.equal(assignRecordingNames([voice(0.6), voice(0.5)], ['미네'], references,
    [{ speaker: 'S0', start: 0, end: 50 }, { speaker: 'S1', start: 50, end: 100 }],
    '2030-05-01').labels.S0, '다른 사람 1');
  assert.equal(assignRecordingNames([voice(0.9), voice(0.5)], ['지인'], references, turns,
    '2030-05-01').labels.S0, '미네');
});

test('미네는 녹음 날짜에 가까운 연도별 기준을 사용한다', () => {
  const references = { 미네: { mean: [0, 1, 0], vectors: [[0, 1, 0], [0, 0, 1]],
    years: [{ year: 2030, count: 4, index: 1 }], minSimilarity: 0.8,
    period: { first: '2029-01-01', last: '2030-12-31' } } };
  const result = assignRecordingNames([[0, 0, 1]], [], references, [], '2030-01-01');
  assert.equal(result.labels.S0, '미네');
  assert.equal(result.evidence.S0.mineSimilarity, 1);
});

test('미네 후보는 나·휘영과 구별되지 않거나 표본이 부족하면 관문을 넘지 못한다', () => {
  const calls = Array.from({ length: 6 }, (_, index) => ({ id: String(index), voice: [0, 1] }));
  assert.equal(evaluatePersonCandidate(calls, [1, 0], [0, 1]).passed, false);
  assert.equal(evaluatePersonCandidate(calls.slice(0, 5), [1, 0], [1, 0]).passed, false);
  assert.equal(evaluatePersonCandidate(calls, [0, 1], [1, 0]).passed, false);
});

test('미네 판정 기준선은 0.45 이상이고 휘영 유사도보다 높아야 한다', () => {
  const references = { 미네: { mean: [0, 1], minSimilarity: 0.2 } };
  const voice = (similarity) => [Math.sqrt(1 - similarity ** 2), similarity];
  assert.equal(assignRecordingNames([voice(0.44)], [], references).labels.S0, '다른 사람');
  assert.equal(assignRecordingNames([voice(0.46)], [], references).labels.S0, '미네');
  assert.equal(assignRecordingNames([voice(0.46)], [], { 미네: {
    ...references.미네, minSimilarity: 0.5 } }).labels.S0, '다른 사람');
  const calls = Array.from({ length: 6 }, (_, index) => ({ id: String(index),
    voice: index === 5 ? [0, -1] : [0, 1] }));
  const below = evaluatePersonCandidate(calls, [1, 0], voice(0.44), { minSimilarityFloor: 0.45 });
  assert.equal(below.minSimilarity, 0.45);
  assert.equal(below.passed, true);
  const above = evaluatePersonCandidate(calls, [1, 0], voice(0.46), { minSimilarityFloor: 0.45 });
  assert.equal(above.passed, false);
  assert.match(above.reasons.join(', '), /기준선 0\.450 <= 다른 기준 유사도 0\.460/);
});

test('미네 후보 표본은 연도별 최근 10건과 전체 최근 40건으로 제한한다', () => {
  const calls = [];
  for (let year = 2030; year >= 2026; year -= 1)
    for (let day = 12; day >= 1; day -= 1)
      calls.push({ item: { transcript: { occurred: `${year}-01-${String(day).padStart(2, '0')}` } } });
  const chosen = selectYearlyPersonCalls(calls);
  assert.equal(chosen.length, 40);
  assert.deepEqual([...new Set(chosen.map(({ item }) => item.transcript.occurred.slice(0, 4)))],
    ['2030', '2029', '2028', '2027']);
  for (const year of ['2030', '2029', '2028', '2027'])
    assert.deepEqual(chosen.filter(({ item }) => item.transcript.occurred.startsWith(year))
      .map(({ item }) => item.transcript.occurred.slice(8)),
    ['12', '11', '10', '09', '08', '07', '06', '05', '04', '03']);
});

test('녹음 엔진 요청은 1~3명 범위를 쓰고 S2 결과를 받는다', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  let sent = '';
  child.stdin.on('data', (chunk) => { sent += chunk; });
  const task = runPython('pyannote', [{ id: ID, wav: '/tmp/fake.wav' }], {
    recordings: true, python: '/fake/python', spawnProcess: () => child });
  child.stdout.write(`${JSON.stringify({ id: ID, backend: 'pyannote', ms: 1, audioSec: 1,
    turns: [{ start: 0, end: 1000, speaker: 'S2' }] })}\n`);
  child.emit('close', 0);
  assert.equal((await task)[0].turns[0].speaker, 'S2');
  assert.equal(JSON.parse(sent).minSpeakers, 1);
  assert.equal(JSON.parse(sent).maxSpeakers, 3);
  assert.equal(JSON.parse(sent).numSpeakers, undefined);
  assert.throws(() => parsePythonOutput(`${JSON.stringify({ id: ID, backend: 'pyannote', ms: 1,
    audioSec: 1, turns: [{ start: 0, end: 1000, speaker: 'S2' }] })}\n`, [{ id: ID }], 'pyannote'));
});

test('휘영 후보는 여섯 통화·응집·나와의 분리를 모두 통과해야 등록된다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'diarize-person-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const good = Array.from({ length: 6 }, (_, index) => ({ id: String(index), voice: [0, 1] }));
  assert.equal(evaluatePersonCandidate(good, [1, 0]).passed, true);
  assert.equal(evaluatePersonCandidate(good.slice(0, 5), [1, 0]).passed, false);
  assert.equal(evaluatePersonCandidate(good, [0, 1]).passed, false);
  const paths = { ownerVoice: join(base, 'owner.npy'), ownerMeta: join(base, 'owner.json'),
    personCandidate: join(base, 'candidate.npy'), personCandidateMeta: join(base, 'candidate.json'),
    personVoice: join(base, 'person.npy'), personMeta: join(base, 'person.json') };
  put(paths.ownerVoice, npy([[1, 0]])); put(paths.ownerMeta, JSON.stringify({ version: 'v1' }));
  put(paths.personCandidate, npy([[0, 1]]));
  put(paths.personCandidateMeta, JSON.stringify({ passed: false, calls: good.map((row) => row.id), ownerVersion: 'v1' }));
  await assert.rejects(() => confirmPerson({ paths, output: QUIET }), /관문 미달/);
  assert.equal(existsSync(paths.personVoice), false);
  put(paths.personCandidateMeta, JSON.stringify({ passed: true, calls: good.map((row) => row.id),
    ownerVersion: 'v1', minSimilarity: 0.4 }));
  await confirmPerson({ paths, now: new Date('2030-01-01'), output: QUIET });
  assert.equal(statSync(paths.personVoice).mode & 0o777, 0o600);
  assert.equal(statSync(paths.personMeta).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(paths.personMeta)).minSimilarity, 0.4);
});

test('휘영 후보는 확인된 통화의 상대 특징값과 전사 예시만 사용한다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'diarize-person-calls-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const paths = { mediaRoot: join(base, 'Media'), voices: join(base, 'Diarize', 'voices'),
    ownerVoice: join(base, 'Diarize', 'voices', 'owner.npy'),
    ownerMeta: join(base, 'Diarize', 'voices', 'owner.json'),
    personCandidate: join(base, 'Diarize', 'voices', 'candidate.npy'),
    personCandidateMeta: join(base, 'Diarize', 'voices', 'candidate.json'),
    personReview: join(base, 'Diarize', 'person-review.md') };
  put(paths.ownerVoice, npy([[1, 0]])); put(paths.ownerMeta, JSON.stringify({ version: 'v1' }));
  const index = [];
  for (let number = 1; number <= 7; number += 1) {
    const id = number.toString(16).padStart(16, '0');
    const occurred = `2030-01-${String(number).padStart(2, '0')}T12:00:00+09:00`;
    const straddled = number === 1;
    const transcript = { id, kind: 'Calls', occurred, transcribedAt: 'v1', speech: true,
      people: ['휘영'], durationSec: 60, segments: straddled ? [
        { start: 0, end: 1000, text: '교차한 말' }, { start: 1000, end: 2000, text: '나의 말' },
        { start: 2000, end: 3000, text: '휘영의 말' }] : [
        { start: 0, end: 1000, text: '나의 말' }, { start: 1000, end: 2000, text: '휘영의 말' }] };
    index.push({ id, kind: 'Calls', occurred, archivePath: `Archive/2030/${id}.m4a` });
    put(join(root, VAULT_REL.mediaTranscripts, '2030', `${id}.json`), JSON.stringify(transcript));
    put(join(root, VAULT_REL.mediaSpeakers, '2030', `${id}.json`), JSON.stringify({ id, transcribedAt: 'v1',
      ownerVersion: 'v1', ownerMargin: 0.2,
      turns: straddled ? [{ start: 0, end: 500, speaker: 'S0' },
        { start: 500, end: 2000, speaker: 'S1' }, { start: 2000, end: 3000, speaker: 'S0' }]
        : [{ start: 0, end: 1000, speaker: 'S0' }, { start: 1000, end: 2000, speaker: 'S1' }],
      segments: straddled ? [{ i: 0, speaker: 'owner' }, { i: 1, speaker: 'owner' },
        { i: 2, speaker: 'other' }] : number === 7
        ? [{ i: 0, speaker: 'other' }, { i: 1, speaker: 'owner' }]
        : [{ i: 0, speaker: 'owner' }, { i: 1, speaker: 'other' }] }));
    put(join(paths.voices, 'pyannote', `${id}.npy`), npy(straddled ? [[0, 1], [1, 0]] : [[1, 0], [0, 1]]));
  }
  put(join(root, VAULT_REL.mediaArchiveIndex), `${index.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const result = await personCandidate({ root, paths, now: new Date('2030-02-01'), output: QUIET });
  assert.equal(result.passed, true);
  assert.ok(Math.abs(result.mean[0]) < 1e-6 && result.mean[1] > 0.99);
  const meta = JSON.parse(readFileSync(paths.personCandidateMeta, 'utf8'));
  assert.equal(meta.calls.length, 6);
  assert.equal(statSync(paths.personCandidate).mode & 0o777, 0o600);
  assert.equal(statSync(paths.personCandidateMeta).mode & 0o777, 0o600);
  assert.equal(statSync(paths.personReview).mode & 0o777, 0o600);
  assert.match(readFileSync(paths.personReview, 'utf8'), /휘영: 휘영의 말/);
});

test('미네 후보는 최근 확인 통화만 사용해 기간·연도별 기준을 만들고 확인 뒤 0600으로 등록한다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'diarize-mine-calls-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const paths = { mediaRoot: join(base, 'Media'), voices: join(base, 'Diarize', 'voices'),
    ownerVoice: join(base, 'Diarize', 'voices', 'owner.npy'),
    ownerMeta: join(base, 'Diarize', 'voices', 'owner.json'),
    personVoice: join(base, 'Diarize', 'voices', 'person.npy'),
    personMeta: join(base, 'Diarize', 'voices', 'person.json'),
    mineCandidate: join(base, 'Diarize', 'voices', 'mine-candidate.npy'),
    mineCandidateMeta: join(base, 'Diarize', 'voices', 'mine-candidate.json'),
    mineVoice: join(base, 'Diarize', 'voices', 'mine.npy'),
    mineMeta: join(base, 'Diarize', 'voices', 'mine.json'),
    mineReview: join(base, 'Diarize', 'mine-review.md') };
  put(paths.ownerVoice, npy([[1, 0, 0]]));
  put(paths.ownerMeta, JSON.stringify({ version: 'v1', minSimilarity: 0.5 }));
  put(paths.personVoice, npy([[0, 0, -1]]));
  put(paths.personMeta, JSON.stringify({ version: 'v1' }));
  const index = [];
  for (let number = 1; number <= 9; number += 1) {
    const id = number.toString(16).padStart(16, '0');
    const year = number <= 4 ? 2028 : 2030;
    const day = String(number <= 4 ? number : number - 4).padStart(2, '0');
    const occurred = `${year}-01-${day}T12:00:00+09:00`;
    const transcript = { id, kind: 'Calls', occurred, transcribedAt: 'v1', speech: true,
      people: ['미네'], durationSec: 60, segments: [
        { start: 0, end: 1000, text: '나의 말' }, { start: 1000, end: 2000, text: '미네의 말' }] };
    index.push({ id, kind: 'Calls', occurred, archivePath: `Archive/${year}/${id}.m4a` });
    put(join(root, VAULT_REL.mediaTranscripts, String(year), `${id}.json`), JSON.stringify(transcript));
    put(join(root, VAULT_REL.mediaSpeakers, String(year), `${id}.json`), JSON.stringify({
      id, transcribedAt: 'v1', ownerVersion: 'v1', ownerMargin: number === 9 ? 0.05 : 0.2,
      turns: [{ start: 0, end: 1000, speaker: 'S0' }, { start: 1000, end: 2000, speaker: 'S1' }],
      segments: [{ i: 0, speaker: 'owner' }, { i: 1, speaker: 'other' }] }));
    put(join(paths.voices, 'pyannote', `${id}.npy`), npy([[1, 0, 0],
      year === 2028 ? [0, 1, 0] : number === 8 ? [0, -1, 0] : [0, 0.8, 0.6]]));
  }
  put(join(root, VAULT_REL.mediaArchiveIndex), `${index.map((row) => JSON.stringify(row)).join('\n')}\n`);
  assert.equal(parseArgs(['--person-candidate=미네']).personCandidate, '미네');
  assert.equal(parseArgs(['--confirm-person=미네']).confirmPerson, '미네');
  const result = await personCandidate({ root, paths, name: '미네',
    now: new Date('2030-02-01'), output: QUIET });
  assert.equal(result.passed, true);
  const meta = JSON.parse(readFileSync(paths.mineCandidateMeta, 'utf8'));
  assert.deepEqual(meta.period, { first: '2028-01-01', last: '2030-01-04' });
  assert.deepEqual(meta.years.map(({ year, count }) => [year, count]), [[2028, 4], [2030, 4]]);
  assert.equal(meta.calls.length, 8);
  assert.equal(meta.minSimilarity, 0.45);
  assert.match(readFileSync(paths.mineReview, 'utf8'), /연도별 표본 2028년 4건, 2030년 4건/);
  const candidateVoice = readFileSync(paths.mineCandidate);
  const dataStart = 10 + candidateVoice.readUInt16LE(8);
  assert.match(candidateVoice.toString('latin1', 10, dataStart), /'shape': \(3, 3\)/);
  assert.ok(candidateVoice.readFloatLE(dataStart + 4 * 4) > 0.99);
  assert.ok(candidateVoice.readFloatLE(dataStart + 4 * 8) > 0.59);
  assert.equal(existsSync(paths.mineVoice), false);
  assert.match(readFileSync(paths.mineReview, 'utf8'), /미네: 미네의 말/);
  for (const path of [paths.mineCandidate, paths.mineCandidateMeta, paths.mineReview])
    assert.equal(statSync(path).mode & 0o777, 0o600);
  put(paths.personMeta, JSON.stringify({ version: 'v2' }));
  await assert.rejects(() => confirmPerson({ paths, name: '미네', output: QUIET }), /휘영 기준 목소리 버전 변경/);
  put(paths.personMeta, JSON.stringify({ version: 'v1' }));
  await confirmPerson({ paths, name: '미네', now: new Date('2030-02-02'), output: QUIET });
  for (const path of [paths.mineVoice, paths.mineMeta])
    assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(paths.mineMeta)).years, meta.years);
  put(paths.personVoice, npy([[0, 0.75, -Math.sqrt(1 - 0.75 ** 2)]]));
  const tooSimilar = await personCandidate({ root, paths, name: '미네',
    now: new Date('2030-02-03'), output: QUIET });
  assert.equal(tooSimilar.passed, false);
  assert.match(tooSimilar.reasons.join(', '), /기준선 0\.450 <= 다른 기준 유사도/);
  const noReferencePaths = { ...paths, personVoice: join(base, 'missing-person.npy') };
  const blocked = await personCandidate({ root, paths: noReferencePaths, name: '미네',
    now: new Date('2030-02-04'), output: QUIET });
  assert.equal(blocked.passed, false);
  await assert.rejects(() => confirmPerson({ paths, name: '미네', output: QUIET }), /관문 미달/);
});

test('녹음 렌더는 세 화자와 하위 발화를 표시하고 두 번째 결과가 같다', () => {
  const transcript = { speech: true, transcribedAt: 'v1', segments: [
    { start: 0, end: 1000, text: '안녕 - 응' }, { start: 1000, end: 2000, text: '잘 지내' }] };
  const speakers = { id: ID, kind: 'Recordings', transcribedAt: 'v1', labels: { S0: '나', S1: '휘영', S2: '미네' },
    segments: [{ i: 0, speaker: 'S0' }, { i: 1, speaker: 'S2' }], parts: [
      { i: 0, k: 0, speaker: 'S0' }, { i: 0, k: 1, speaker: 'S1' }, { i: 1, k: 0, speaker: 'S2' }] };
  assert.equal(renderDialogue(transcript, speakers), '나: 안녕\n휘영: 응\n미네: 잘 지내');
  assert.equal(renderDialogue(transcript, speakers), renderDialogue(transcript, speakers));
  assert.equal(renderDialogue(transcript, { ...speakers, labels: { S0: '나' } }), null);
});

test('녹음 시험은 볼트 쓰기 없이 미리보기만 만들고 적용은 노트를 한 번 갱신한다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'diarize-rec-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault'); const mediaRoot = join(base, 'Media');
  const paths = { root: join(base, 'Diarize'), mediaRoot, voices: join(base, 'Diarize', 'voices'),
    trialRec: join(base, 'Diarize', 'trial-rec'), state: join(base, 'Diarize', 'state.json'),
    pyannote: join(base, 'models'), ownerVoice: join(base, 'Diarize', 'voices', 'owner.npy'),
    ownerMeta: join(base, 'Diarize', 'voices', 'owner.json'),
    personVoice: join(base, 'Diarize', 'voices', 'person.npy'), personMeta: join(base, 'Diarize', 'voices', 'person.json') };
  const archivePath = 'Archive/2030/01/Recordings/2030-01-01 미네 대화 놀이.m4a';
  const occurred = '2030-01-01T12:00:00+09:00';
  const transcript = { id: ID, kind: 'Recordings', occurred, transcribedAt: 'v1', speech: true,
    durationSec: 2, text: '안녕 응', people: ['미네'], segments: [
      { start: 0, end: 1000, text: '안녕' }, { start: 1000, end: 2000, text: '응' }] };
  put(join(root, VAULT_REL.mediaArchiveIndex), `${JSON.stringify({ id: ID, kind: 'Recordings', archivePath, occurred })}\n`);
  put(join(root, VAULT_REL.mediaTranscripts, '2030', `${ID}.json`), JSON.stringify(transcript));
  put(join(mediaRoot, archivePath), 'audio');
  put(join(paths.pyannote, 'speaker-diarization-community-1', 'config.yaml'), 'local');
  put(paths.ownerVoice, npy([[1, 0]])); put(paths.ownerMeta, JSON.stringify({ version: 'v1', minSimilarity: 0.5 }));
  const notePath = join(root, VAULT_REL.mediaConversations, '2030', '2030-01-01 미네 대화 놀이 녹음.md');
  const note = `${buildFrontmatter({ type: 'conversation', origin: 'media-transcribe',
    category: '[[01_Home/200 가족]]', description: '녹음', sensitivity: '개인',
    created: '2030-01-01', modified: '2030-01-01', occurred,
    people: ['[[30_Wiki/People/미네]]'], convKind: '녹음', athena: '보존' })}<!-- media-transcribe:start -->
# 녹음

<!-- media-transcribe:id ${ID} -->
### 0분 2초

안녕 응

원본: ${archivePath}
<!-- media-transcribe:end -->

## 오너 메모

보존
`;
  put(notePath, note);
  const worker = async (_backend, items, options) => {
    assert.equal(options.recordings, true);
    put(join(paths.voices, 'pyannote-rec', `${ID}.npy`), npy([[1, 0], [0, 1]]));
    return [{ id: items[0].id, backend: 'pyannote', turns: [
      { start: 0, end: 1000, speaker: 'S0' }, { start: 1000, end: 2000, speaker: 'S1' }] }];
  };
  const exec = async (_command, args) => put(args.at(-1), 'wav');
  const options = { root, paths, ids: [ID], output: QUIET, runWorker: worker, exec,
    registryRules: RULES, now: new Date('2030-01-01T04:00:00Z') };
  assert.deepEqual(selectRecordings([{ id: ID, kind: 'Recordings', archivePath, transcript }], new Map(),
    { ids: [ID] }).map((row) => row.id), [ID]);
  const saved = new Map([[ID, { transcribedAt: transcript.transcribedAt }]]);
  const records = [{ id: ID, kind: 'Recordings', archivePath, transcript }];
  assert.deepEqual(selectRecordings(records, saved).map((row) => row.id), []);
  assert.deepEqual(selectRecordings(records, saved, { ids: [ID] }).map((row) => row.id), [ID]);
  const blockedNight = await runRecordings({ ...options, trial: true, allowNight: true,
    now: new Date('2030-01-01T16:00:00Z'), runWorker: () => { throw new Error('야간 실행'); } });
  assert.equal(blockedNight.processed, 0);
  assert.equal(existsSync(paths.trialRec), false);
  const transcribeLock = `${join(root, VAULT_REL.mediaTranscribeState)}.lock`;
  put(transcribeLock, 'active');
  const blockedLock = await runRecordings({ ...options, trial: true,
    runWorker: () => { throw new Error('전사 잠금 중 실행'); } });
  assert.equal(blockedLock.busy, true);
  rmSync(transcribeLock);
  await runRecordings({ ...options, trial: true });
  assert.equal(readFileSync(notePath, 'utf8'), note);
  assert.equal(existsSync(join(root, VAULT_REL.mediaSpeakers, '2030', `${ID}.json`)), false);
  assert.equal(existsSync(`${join(root, VAULT_REL.mediaTranscribeState)}.lock`), false);
  assert.match(readFileSync(join(paths.trialRec, `${ID}.md`), 'utf8'), /나: 안녕\n미네: 응/);
  const trialSummary = readFileSync(join(paths.trialRec, 'summary.md'), 'utf8');
  assert.match(trialSummary, /화자별 미네 유사도 \| 발화 비율 \| 판정 근거/);
  assert.match(trialSummary, /S1 미네:share/);
  assert.equal(statSync(join(paths.trialRec, `${ID}.md`)).mode & 0o777, 0o600);
  let failNote = true;
  const write = (path, content) => {
    if (path === notePath && failNote) { failNote = false; throw new Error('주입된 노트 쓰기 실패'); }
    put(path, content);
  };
  const first = await runRecordings({ ...options, write });
  assert.equal(first.notes, 0);
  assert.equal(readFileSync(notePath, 'utf8'), note);
  const retry = await runRecordings({ ...options, ids: null, write });
  assert.equal(retry.notes, 1);
  const updated = readFileSync(notePath, 'utf8');
  assert.match(updated, /나: 안녕\n미네: 응/);
  assert.match(updated, /athena: "보존"/);
  assert.match(updated, /## 오너 메모\n\n보존/);
  assert.equal(JSON.parse(readFileSync(join(root, VAULT_REL.mediaSpeakers, '2030', `${ID}.json`))).kind, 'Recordings');
  const stored = JSON.parse(readFileSync(join(root, VAULT_REL.mediaSpeakers, '2030', `${ID}.json`)));
  assert.deepEqual(stored.evidence.S1,
    { label: '미네', basis: 'share', mineSimilarity: null, share: 0.5 });
  assert.equal(renderSpeakerNote(updated, transcript, stored), updated);
  assert.equal(renderSpeakerNote(note, transcript, { ...stored, labels: { S0: '나' },
    segments: [{ i: 0, speaker: 'S0' }], parts: [] }), note);
  const second = await runRecordings({ ...options, ids: null, write });
  assert.equal(second.notes, 0);
  assert.equal(readFileSync(notePath, 'utf8'), updated);
  paths.mineVoice = join(base, 'Diarize', 'voices', 'mine.npy');
  paths.mineMeta = join(base, 'Diarize', 'voices', 'mine.json');
  put(paths.mineVoice, npy([[0, 1]]));
  put(paths.mineMeta, JSON.stringify({ minSimilarity: 0.8,
    period: { first: '2029-01-01', last: '2030-12-31' }, years: [] }));
  await runRecordings({ ...options, trial: true });
  const withMine = readFileSync(join(paths.trialRec, 'summary.md'), 'utf8');
  assert.match(withMine, /S1 1\.000/);
  assert.match(withMine, /S1 미네:voice/);
  assert.equal(readFileSync(notePath, 'utf8'), updated);
  assert.equal(parseArgs(['--recordings', '--trial', '--limit=10']).recordings, true);
  assert.equal(parseArgs(['--recordings', '--apply', '--dry-run']).dryRun, true);
});

test('엔진의 화자 수 범위 문구(expected N..M speakers … found 1)도 영구 실패로 본다', async () => {
  const source = (await import('node:fs')).readFileSync(new URL('./media-diarize.mjs', import.meta.url), 'utf8');
  const pattern = new RegExp(source.match(/const FINAL_ERROR = \/(.+)\/;/)[1]);
  assert.ok(pattern.test('expected 2..2 speakers with embeddings, found 1'));
  assert.ok(pattern.test('expected two speakers, found 1'));
  assert.ok(!pattern.test('화자 엔진 실패: CUDA out of memory'));
});
