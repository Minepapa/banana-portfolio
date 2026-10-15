import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { recordingKind, RECORDING_DIALOGUE_KINDS, selectRecordings, assignRecordingNames,
  evaluatePersonCandidate, personCandidate, confirmPerson, runRecordings, parseArgs,
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
  assert.equal(renderSpeakerNote(updated, transcript, stored), updated);
  assert.equal(renderSpeakerNote(note, transcript, { ...stored, labels: { S0: '나' },
    segments: [{ i: 0, speaker: 'S0' }], parts: [] }), note);
  const second = await runRecordings({ ...options, ids: null, write });
  assert.equal(second.notes, 0);
  assert.equal(readFileSync(notePath, 'utf8'), updated);
  assert.equal(parseArgs(['--recordings', '--trial', '--limit=10']).recordings, true);
  assert.equal(parseArgs(['--recordings', '--apply', '--dry-run']).dryRun, true);
});
