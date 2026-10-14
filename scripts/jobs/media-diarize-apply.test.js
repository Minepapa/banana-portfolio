import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { selectApply, identifyOwner, updateOwnerMean, renderSpeakerNote, parseArgs, runApply, confirmOwner,
  evaluateEnrollment, enrollmentCalls } from './media-diarize.mjs';
import { renderDialogue } from '../lib/media-dialogue.mjs';
import { buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';

const id = (n) => n.toString(16).padStart(16, '0');
function call(n, date, durationSec = 60, kind = 'Calls') {
  return { id: id(n), kind, transcript: { id: id(n), kind, occurred: `${date}T12:00:00+09:00`,
    durationSec, transcribedAt: `${date}T15:00:00Z`, speech: true, text: '예',
    segments: [{ start: 0, end: 1000, text: '예' }] } };
}

test('apply selection uses completed calls, transcript version, newest order and both caps', () => {
  const rows = [call(1, '2026-10-11'), call(2, '2026-10-13', 90),
    call(3, '2026-10-12', 60, 'Recordings'), call(4, '2026-10-10')];
  const saved = new Map([[id(1), { transcribedAt: rows[0].transcript.transcribedAt }],
    [id(2), { transcribedAt: 'old' }]]);
  assert.deepEqual(selectApply(rows, saved, { limit: 1 }).map((row) => row.id), [id(2)]);
  assert.deepEqual(selectApply(rows, saved, { maxMinutes: 1.5 }).map((row) => row.id), [id(2)]);
  const shortBudget = selectApply(rows, saved, { maxMinutes: 1 });
  assert.deepEqual(shortBudget.map((row) => row.id), [id(4)]);
  assert.deepEqual(shortBudget.oversized.map((row) => row.id), [id(2)]);
  assert.deepEqual(selectApply(rows, saved, { ids: [id(4)] }).map((row) => row.id), [id(4)]);
  // 음성 없음 전사는 대상이 아니다.
  const silent = call(6, '2026-10-14'); silent.transcript.speech = false;
  assert.deepEqual(selectApply([silent], new Map()).map((row) => row.id), []);
  // 영구 실패·3회 실패는 같은 전사 버전에서 다시 고르지 않고, 일시 실패는 다시 고른다.
  const state = { failures: {
    [id(4)]: { transcribedAt: rows[3].transcript.transcribedAt, attempts: 1, final: true },
    [id(2)]: { transcribedAt: 'old', attempts: 5, final: true } } };
  assert.deepEqual(selectApply(rows, saved, { state }).map((row) => row.id), [id(2)]);
  state.failures[id(4)] = { transcribedAt: rows[3].transcript.transcribedAt, attempts: 2, final: false };
  assert.deepEqual(selectApply(rows, saved, { state }).map((row) => row.id), [id(2), id(4)]);
  state.failures[id(4)].attempts = 3;
  assert.deepEqual(selectApply(rows, saved, { state }).map((row) => row.id), [id(2)]);
});

test('owner cosine margin marks uncertain calls and incremental mean stays bounded', () => {
  assert.deepEqual(identifyOwner([[1, 0], [0, 1]], [1, 0]).speaker, 'S0');
  assert.equal(identifyOwner([[1, 0], [0.999, 0.03]], [1, 0]).check, '필요');
  // 둘 다 등록 목소리와 멀면(둘 다 '나'가 아닐 수 있음) 확인 필요.
  assert.equal(identifyOwner([[0.6, 0.8], [0, 1]], [1, 0], { minSimilarity: 0.7 }).check, '필요');
  assert.equal(identifyOwner([[0.6, 0.8], [0, 1]], [1, 0], { minSimilarity: 0.5 }).check, undefined);
  const mean = updateOwnerMean([1, 0], [0, 1], 8);
  assert.ok(mean[1] > 0 && mean[1] < 0.06);
  assert.ok(Math.abs(Math.hypot(...mean) - 1) < 1e-9);
});

test('shared dialogue renderer groups speakers, marks uncertain text and uses counterpart', () => {
  const transcript = { transcribedAt: 'now', speech: true, segments: [{ text: '하나' }, { text: '둘' }, { text: '셋' }] };
  const speakers = { transcribedAt: 'now', segments: [
    { i: 0, speaker: 'owner', uncertain: false }, { i: 1, speaker: 'owner', uncertain: true },
    { i: 2, speaker: 'other', uncertain: false }] };
  assert.equal(renderDialogue(transcript, speakers, '미네'), '나: 하나 둘 [?]\n미네: 셋');
  assert.equal(renderDialogue(transcript, speakers), '나: 하나 둘 [?]\n상대: 셋');
  assert.equal(renderDialogue({ ...transcript, transcribedAt: 'later' }, speakers), null);
  assert.equal(renderDialogue({ ...transcript, speech: false }, speakers), null);
  assert.equal(renderDialogue(transcript, speakers, '미네', { looped: true }), null);
});

test('note rewrite preserves manual fields and owner memo; second pass changes nothing', () => {
  const idValue = id(5);
  const note = `${buildFrontmatter({ type: 'conversation', origin: 'media-transcribe',
    people: ['[[30_Wiki/People/미네]]'], convKind: '통화', athena: '보존' })}
<!-- media-transcribe:start -->
# 통화

<!-- media-transcribe:id ${idValue} -->
### 12:00 (1분 0초)

옛 전사

원본: Archive/a.m4a
<!-- media-transcribe:end -->

## 오너 메모

손으로 쓴 메모
`;
  const transcript = { transcribedAt: 'now', speech: true, text: '안녕 잘 지내', segments: [{ text: '안녕' }, { text: '잘 지내' }] };
  const speakers = { id: idValue, transcribedAt: 'now', check: '필요', segments: [
    { i: 0, speaker: 'owner', uncertain: false }, { i: 1, speaker: 'other', uncertain: true }] };
  const next = renderSpeakerNote(note, transcript, speakers);
  assert.match(next, /\[화자 확인 필요\]\n나: 안녕\n미네: 잘 지내 \[\?\]/);
  assert.match(next, /athena: "보존"/);
  assert.match(next, /## 오너 메모\n\n손으로 쓴 메모/);
  assert.equal(renderSpeakerNote(next, transcript, speakers), next);
});

test('apply flags and daytime plist are explicit', () => {
  assert.deepEqual(parseArgs(['--apply', '--limit=20', '--max-minutes=45']).maxMinutes, 45);
  assert.equal(parseArgs(['--render-notes', '--dry-run']).dryRun, true);
  assert.throws(() => parseArgs(['--apply', '--trial']), /필요/);
  const plist = readFileSync(new URL('../launchd/com.banana2.media-diarize.plist', import.meta.url), 'utf8');
  assert.equal((plist.match(/<key>Hour<\/key>/g) || []).length, 15);
  assert.equal((plist.match(/<integer>20<\/integer>/g) || []).length, 16); // 20:20 has two 20 values
});

function npy(matrix) {
  const headerBody = `{'descr': '<f4', 'fortran_order': False, 'shape': (${matrix.length}, ${matrix[0].length}), }`;
  const header = Buffer.from(`${headerBody}${' '.repeat((16 - (10 + headerBody.length + 1) % 16) % 16)}\n`, 'latin1');
  const buffer = Buffer.alloc(10 + header.length + matrix.length * matrix[0].length * 4);
  buffer.write('\x93NUMPY', 0, 'latin1'); buffer[6] = 1; buffer.writeUInt16LE(header.length, 8);
  header.copy(buffer, 10);
  let offset = 10 + header.length;
  for (const row of matrix) for (const value of row) { buffer.writeFloatLE(value, offset); offset += 4; }
  return buffer;
}

test('apply with injected worker stores no biometrics in Vault, updates note once, and skips repeat', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'diarize-apply-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault'); const mediaRoot = join(base, 'Media');
  const paths = { root: join(base, 'Diarize'), mediaRoot, voices: join(base, 'Diarize', 'voices'),
    ownerVoice: join(base, 'Diarize', 'voices', 'owner-pyannote.npy'),
    ownerMeta: join(base, 'Diarize', 'voices', 'owner-pyannote.json'),
    ownerCandidate: join(base, 'Diarize', 'voices', 'cand.npy'), ownerCandidateMeta: join(base, 'Diarize', 'voices', 'cand.json'),
    ownerReview: join(base, 'Diarize', 'review.md'), state: join(base, 'Diarize', 'state.json'),
    pyannote: join(base, 'models', 'pyannote') };
  const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  const item = call(9, '2026-10-14');
  item.archivePath = 'Archive/2030/a.m4a';
  item.occurred = item.transcript.occurred;
  item.transcript.people = ['미네'];
  put(join(root, VAULT_REL.mediaArchiveIndex), `${JSON.stringify(item)}\n`);
  put(join(root, VAULT_REL.mediaTranscripts, '2026', `${item.id}.json`), JSON.stringify(item.transcript));
  put(join(mediaRoot, item.archivePath), 'audio');
  put(join(paths.pyannote, 'speaker-diarization-community-1', 'config.yaml'), 'local');
  put(paths.ownerVoice, npy([[1, 0]]));
  put(paths.ownerMeta, JSON.stringify({ version: 'v1', callCount: 8 }));
  const notePath = join(root, VAULT_REL.mediaConversations, '2026', '2026-10-14 미네 통화.md');
  put(notePath, `${buildFrontmatter({ type: 'conversation', origin: 'media-transcribe',
    category: '[[01_Home/200 가족]]', description: '통화', sensitivity: '개인',
    created: '2026-10-14', modified: '2026-10-14', occurred: item.occurred,
    people: ['[[30_Wiki/People/미네]]'], convKind: '통화' })}<!-- media-transcribe:start -->
# 통화

<!-- media-transcribe:id ${item.id} -->
### 12:00 (1분 0초)

예

원본: ${item.archivePath}
<!-- media-transcribe:end -->

## 오너 메모

보존
`);
  let workerCalls = 0;
  const options = { root, paths, allowNight: true, registryRules: [{ type: 'conversation',
    pathRegex: /^20_Records\/23_Conversations\/\d{4}\/[^/]+\.md$/,
    titleRegex: /^\d{4}-\d{2}-\d{2} \S/,
    required: { bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'],
      extra: ['occurred', 'people', 'origin', 'convKind'] } }],
    output: { log() {}, error(message) { throw new Error(message); } },
    exec: async (_binary, args) => put(args.at(-1), 'wav'),
    runWorker: async (_backend, items, config) => {
      workerCalls += 1;
      put(join(config.voicesDir, 'pyannote', `${items[0].id}.npy`), npy([[1, 0], [0, 1]]));
      return [{ id: items[0].id, turns: [{ start: 0, end: 1000, speaker: 'S0' }] }];
    } };
  const first = await runApply(options);
  assert.equal(first.processed, 1);
  assert.equal(first.notes, 1);
  const speakerText = readFileSync(join(root, VAULT_REL.mediaSpeakers, '2026', `${item.id}.json`), 'utf8');
  assert.equal(speakerText.includes('voices'), false);
  assert.deepEqual(JSON.parse(speakerText).segments, [{ i: 0, speaker: 'owner', uncertain: false }]);
  assert.match(readFileSync(notePath, 'utf8'), /나: 예/);
  const second = await runApply(options);
  assert.equal(second.processed, 0);
  assert.equal(workerCalls, 1);
  assert.equal(existsSync(paths.ownerVoice), true);
});

test('owner enrollment makes a gated candidate, notes change only after owner confirmation', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'diarize-enroll-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault'); const mediaRoot = join(base, 'Media');
  const paths = { root: join(base, 'Diarize'), mediaRoot, voices: join(base, 'Diarize', 'voices'),
    ownerVoice: join(base, 'Diarize', 'voices', 'owner-pyannote.npy'),
    ownerMeta: join(base, 'Diarize', 'voices', 'owner-pyannote.json'),
    ownerCandidate: join(base, 'Diarize', 'voices', 'cand.npy'), ownerCandidateMeta: join(base, 'Diarize', 'voices', 'cand.json'),
    ownerReview: join(base, 'Diarize', 'review.md'), state: join(base, 'Diarize', 'state.json'),
    pyannote: join(base, 'model') };
  const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  put(join(paths.pyannote, 'speaker-diarization-community-1', 'config.yaml'), 'local');
  const records = [];
  // 상대 둘이 같은 날 통화 → 노트는 상대별 하나에 통화 4건씩(한 노트에 여러 통화).
  const notes = { 미네: [], 휘영: [] };
  for (let n = 1; n <= 8; n += 1) {
    const who = n <= 4 ? '미네' : '휘영';
    const row = call(n, '2026-10-14');
    row.occurred = row.transcript.occurred;
    row.archivePath = `Archive/2026/${row.id}.m4a`;
    row.transcript.people = [who];
    records.push(row);
    notes[who].push(row);
    put(join(root, VAULT_REL.mediaTranscripts, '2026', `${row.id}.json`), JSON.stringify(row.transcript));
    put(join(mediaRoot, row.archivePath), 'audio');
  }
  for (const [who, rows] of Object.entries(notes)) {
    put(join(root, VAULT_REL.mediaConversations, '2026', `2026-10-14 ${who} 통화.md`),
      `${buildFrontmatter({ type: 'conversation', origin: 'media-transcribe',
        category: '[[01_Home/200 가족]]', description: '통화', sensitivity: '개인',
        created: '2026-10-14', modified: '2026-10-14', occurred: rows[0].occurred,
        people: [`[[30_Wiki/People/${who}]]`], convKind: '통화' })}<!-- media-transcribe:start -->
# 통화

${rows.map((row) => `<!-- media-transcribe:id ${row.id} -->
### 12:00 (1분 0초)

예

원본: ${row.archivePath}`).join('\n\n')}
<!-- media-transcribe:end -->

## 오너 메모

보존
`);
  }
  put(join(root, VAULT_REL.mediaArchiveIndex), `${records.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const rules = [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/[^/]+\.md$/,
    titleRegex: /^\d{4}-\d{2}-\d{2} \S/,
    required: { bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'],
      extra: ['occurred', 'people', 'origin', 'convKind'] } }];
  const writes = [];
  const options = { root, paths, allowNight: true, registryRules: rules,
    output: { log() {}, error(message) { throw new Error(message); } },
    write: (path, content) => { writes.push(path); writeFileSync(path, content); },
    exec: async (_binary, args) => put(args.at(-1), 'wav'),
    runWorker: async (_backend, items, config) => {
      // 오너 목소리는 S0 쪽에 [1, 0.1]과 비슷하게, 상대는 다르게.
      put(join(config.voicesDir, 'pyannote', `${items[0].id}.npy`), npy([[1, 0.1, 0], [0, 0.2, 1]]));
      return [{ id: items[0].id, turns: [{ start: 0, end: 1000, speaker: 'S0' }] }];
    } };
  const first = await runApply(options);
  assert.equal(first.processed, 8);
  assert.equal(first.notes, 0);
  assert.equal(existsSync(paths.ownerVoice), false);
  assert.equal(existsSync(paths.ownerCandidate), true);
  assert.equal(statSync(paths.ownerCandidate).mode & 0o777, 0o600);
  assert.match(readFileSync(paths.ownerReview, 'utf8'), /품질 관문: 통과/);
  assert.equal(writes.some((path) => path.includes(VAULT_REL.mediaConversations)), false);
  await confirmOwner({ paths, output: { log() {} } });
  assert.equal(statSync(paths.ownerVoice).mode & 0o777, 0o600);
  assert.ok(JSON.parse(readFileSync(paths.ownerMeta, 'utf8')).version);
  writes.length = 0;
  const enrolled = await runApply(options);
  assert.equal(enrolled.reassigned, 8);
  assert.equal(enrolled.notes, 2);
  // 통화 4건이 든 노트도 한 번만 쓴다.
  const noteWrites = writes.filter((path) => path.includes(VAULT_REL.mediaConversations));
  assert.equal(noteWrites.length, 2);
  assert.equal(new Set(noteWrites).size, 2);
  assert.match(readFileSync(join(root, VAULT_REL.mediaConversations, '2026', '2026-10-14 휘영 통화.md'), 'utf8'), /나: 예/);
  assert.equal((await runApply({ ...options, renderNotes: true })).notes, 0);
  const again = await runApply(options);
  assert.equal(again.reassigned + again.notes + again.processed, 0);
});

test('enrollment gate rejects incoherent owner voices and needs three calls per counterpart', () => {
  const rows = [1, 2, 3, 4, 5].map((n) => ({ id: id(n), counterpart: n <= 3 ? '미네' : '휘영',
    occurred: `2026-10-1${n}T12:00:00+09:00`, durationSec: 90 }));
  assert.deepEqual(enrollmentCalls(rows), []);
  rows.push({ id: id(6), counterpart: '휘영', occurred: '2026-10-16T12:00:00+09:00', durationSec: 30 });
  assert.deepEqual(enrollmentCalls(rows), []);
  rows[5].durationSec = 90;
  assert.equal(enrollmentCalls(rows).length, 6);
  // 통화마다 목소리가 제각각이면 응집이 낮아 관문 미달.
  const calls = Array.from({ length: 6 }, (_, i) => ({ id: id(i + 1), counterpart: i < 3 ? '미네' : '휘영',
    voices: [Array.from({ length: 6 }, (_, k) => (k === i ? 1 : 0)), Array.from({ length: 6 }, (_, k) => (k === (i + 3) % 6 ? 1 : 0))] }));
  const result = evaluateEnrollment(calls);
  assert.equal(result.passed, false);
});

test('busy media lock skips the hourly run quietly; failures are recorded and not retried forever', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'diarize-busy-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault'); const mediaRoot = join(base, 'Media');
  const paths = { root: join(base, 'Diarize'), mediaRoot, voices: join(base, 'Diarize', 'voices'),
    ownerVoice: join(base, 'Diarize', 'voices', 'o.npy'), ownerMeta: join(base, 'Diarize', 'voices', 'o.json'),
    ownerCandidate: join(base, 'Diarize', 'voices', 'c.npy'), ownerCandidateMeta: join(base, 'Diarize', 'voices', 'c.json'),
    ownerReview: join(base, 'Diarize', 'review.md'), state: join(base, 'Diarize', 'state.json'),
    pyannote: join(base, 'model') };
  const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  put(join(paths.pyannote, 'speaker-diarization-community-1', 'config.yaml'), 'local');
  const rows = [call(1, '2026-10-14'), call(2, '2026-10-13'), call(3, '2026-10-12', 4000)];
  for (const row of rows) {
    row.occurred = row.transcript.occurred; row.archivePath = `Archive/2026/${row.id}.m4a`;
    put(join(root, VAULT_REL.mediaTranscripts, '2026', `${row.id}.json`), JSON.stringify(row.transcript));
    put(join(mediaRoot, row.archivePath), 'audio');
  }
  put(join(root, VAULT_REL.mediaArchiveIndex), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const errors = [];
  let attempts = 0;
  const options = { root, paths, allowNight: true, registryRules: [], maxMinutes: 45,
    output: { log() {}, error(message) { errors.push(message); } },
    exec: async (_binary, args) => put(args.at(-1), 'wav'),
    runWorker: async (_backend, items, config) => {
      attempts += 1;
      if (items[0].id === id(1)) return [{ id: items[0].id, error: '화자 특징값 2개 아님' }];
      put(join(config.voicesDir, 'pyannote', `${items[0].id}.npy`), npy([[1, 0], [0, 1]]));
      return [{ id: items[0].id, turns: [{ start: 0, end: 1000, speaker: 'S0' }] }];
    } };
  // 전사 잡이 상태 잠금을 잡고 있으면 이번 회차는 조용히 건너뛴다.
  put(`${join(root, VAULT_REL.mediaTranscribeState)}.lock`, `${process.pid}:test`);
  assert.equal((await runApply(options)).busy, true);
  rmSync(`${join(root, VAULT_REL.mediaTranscribeState)}.lock`);
  const first = await runApply(options);
  assert.equal(first.processed, 1);
  assert.equal(first.failed, 0); // 영구 실패(2화자 아님)·긴 통화는 건너뜀으로만 센다
  assert.equal(first.skipped, 2);
  const state = JSON.parse(readFileSync(paths.state, 'utf8'));
  assert.equal(state.failures[id(1)].final, true);
  assert.equal(state.failures[id(3)].final, true);
  const before = attempts;
  const second = await runApply(options);
  assert.equal(second.processed + second.failed + second.skipped, 0);
  assert.equal(attempts, before);
});

test('night hours skip new diarization unless explicitly allowed; process failures are never final', async () => {
  const base = mkdtempSync(join(tmpdir(), 'diarize-night-test-'));
  try {
    const root = join(base, 'vault');
    const paths = { root: join(base, 'Diarize'), mediaRoot: join(base, 'Media'), voices: join(base, 'Diarize', 'voices'),
      ownerVoice: join(base, 'o.npy'), ownerMeta: join(base, 'o.json'), ownerCandidate: join(base, 'c.npy'),
      ownerCandidateMeta: join(base, 'c.json'), ownerReview: join(base, 'r.md'), state: join(base, 'Diarize', 'state.json'),
      pyannote: join(base, 'model') };
    const row = call(1, '2026-10-14'); row.archivePath = 'Archive/2026/a.m4a';
    mkdirSync(join(root, VAULT_REL.mediaTranscripts, '2026'), { recursive: true });
    writeFileSync(join(root, VAULT_REL.mediaTranscripts, '2026', `${row.id}.json`), JSON.stringify(row.transcript));
    mkdirSync(dirname(join(root, VAULT_REL.mediaArchiveIndex)), { recursive: true });
    writeFileSync(join(root, VAULT_REL.mediaArchiveIndex), `${JSON.stringify(row)}\n`);
    mkdirSync(join(paths.pyannote, 'speaker-diarization-community-1'), { recursive: true });
    writeFileSync(join(paths.pyannote, 'speaker-diarization-community-1', 'config.yaml'), 'x');
    mkdirSync(join(paths.mediaRoot, 'Archive', '2026'), { recursive: true });
    writeFileSync(join(paths.mediaRoot, row.archivePath), 'audio');
    let calls = 0;
    const options = { root, paths, registryRules: [], output: { log() {}, error() {} },
      exec: async (_b, args) => writeFileSync(args.at(-1), 'wav'),
      runWorker: async () => { calls += 1; throw new Error('화자 엔진 실패: speaker-diarization traceback'); } };
    // 03시(KST)는 건너뜀(00~07시 전사 시간대)
    const night = await runApply({ ...options, now: new Date('2026-10-14T18:00:00Z') });
    assert.equal(night.processed + night.failed, 0);
    assert.equal(calls, 0);
    const day = await runApply({ ...options, now: new Date('2026-10-14T03:00:00Z') }); // 12시 KST
    assert.equal(day.failed, 1);
    const state = JSON.parse(readFileSync(paths.state, 'utf8'));
    assert.equal(state.failures[row.id].final, false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
