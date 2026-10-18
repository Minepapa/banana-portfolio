import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { recheckSpeaker, runRecheck, parseRecheckAnswers, renderRecheckReview,
  parseArgs } from './media-diarize.mjs';

const callId = 'abcdefabcdefabcd';
const owner = { mean: [1, 0] };
const reference = { vectors: [[0, 1]], years: [{ year: 2026, index: 0 }], minSimilarity: 0.45 };

test('counterpart lead confirms owner; contradiction, distance and small lead defer', () => {
  assert.equal(recheckSpeaker([[1, 0], [0, 1]], '미네', '2026-10-17', owner, reference).speaker, 'S0');
  assert.equal(recheckSpeaker([[0, 1], [1, 0]], '미네', '2026-10-17',
    { mean: [0, 1] }, reference).reason, '오너 기준 모순');
  assert.equal(recheckSpeaker([[1, 0], [0, 1]], '미네', '2023-10-17', owner, reference).reason,
    '미네 연도 기준 거리 초과');
  assert.equal(recheckSpeaker([[0.6, 0.8], [0.5, 0.866]], '휘영', '2026-10-17', owner, reference).reason,
    '상대 유사도 여유 부족');
  const nearest = recheckSpeaker([[1, 0], [0, 1]], '미네', '2025-01-01', owner,
    { vectors: [[0.7, 0.7], [1, 0], [0, 1]],
      years: [{ year: 2023, index: 1 }, { year: 2026, index: 2 }], minSimilarity: 0.45 });
  assert.equal(nearest.referenceYear, 2026);
  assert.equal(nearest.speaker, 'S0');
});

test('review HTML escapes transcript text; answers and CLI validate choices', () => {
  const html = renderRecheckReview([{ item: { id: callId, counterpart: '미네',
    transcript: { occurred: '2026-10-17', segments: [{ start: 0, end: 1000, text: '<img src=x>' }] } },
  speakers: { turns: [{ start: 0, end: 1000, speaker: 'S0' }] } }]);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.deepEqual(parseRecheckAnswers(JSON.stringify({ version: 1, answers: { [callId]: 'S1' } })),
    { [callId]: 'S1' });
  assert.throws(() => parseRecheckAnswers(JSON.stringify({ version: 1, answers: { [callId]: 'owner' } })));
  assert.equal(parseArgs(['--recheck-uncertain', '--dry-run']).dryRun, true);
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

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'speaker-recheck-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const paths = { root: join(base, 'Diarize'), mediaRoot: join(base, 'Media'),
    voices: join(base, 'Diarize', 'voices'), ownerVoice: join(base, 'Diarize', 'voices', 'owner.npy'),
    ownerMeta: join(base, 'Diarize', 'voices', 'owner.json'),
    mineVoice: join(base, 'Diarize', 'voices', 'mine.npy'),
    mineMeta: join(base, 'Diarize', 'voices', 'mine.json') };
  const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  const transcript = { id: callId, occurred: '2026-10-17T12:00:00+09:00',
    transcribedAt: '2026-10-17T15:00:00Z', people: ['미네'], speech: true, text: '안녕 응',
    segments: [{ start: 0, end: 1000, text: '안녕' }, { start: 1000, end: 2000, text: '응' }] };
  const archive = { id: callId, kind: 'Calls', occurred: transcript.occurred,
    archivePath: 'Archive/a.m4a' };
  put(join(root, VAULT_REL.mediaArchiveIndex), `${JSON.stringify(archive)}\n`);
  put(join(root, VAULT_REL.mediaTranscripts, '2026', `${callId}.json`), JSON.stringify(transcript));
  const speakerPath = join(root, VAULT_REL.mediaSpeakers, '2026', `${callId}.json`);
  put(speakerPath, JSON.stringify({ id: callId, transcribedAt: transcript.transcribedAt,
    check: '필요', turns: [{ start: 0, end: 1000, speaker: 'S0' },
      { start: 1000, end: 2000, speaker: 'S1' }],
    segments: [{ i: 0, speaker: 'other', uncertain: false },
      { i: 1, speaker: 'owner', uncertain: false }] }));
  const notePath = join(root, VAULT_REL.mediaConversations, '2026', 'test.md');
  put(notePath, `${buildFrontmatter({ type: 'conversation', origin: 'media-transcribe', people: ['미네'] })}\n<!-- media-transcribe:start -->\n# 통화\n\n<!-- media-transcribe:id ${callId} -->\n### 12:00\n\n[화자 확인 필요]\n미네: 안녕\n나: 응\n원본: a.m4a\n<!-- media-transcribe:end -->\n\n## 메모\n\n보존\n`);
  put(paths.ownerVoice, npy([[1, 0]])); put(paths.ownerMeta, JSON.stringify({ version: 'owner-1' }));
  put(paths.mineVoice, npy([[0, 1]])); put(paths.mineMeta, JSON.stringify({ version: 'mine-1',
    minSimilarity: 0.45, years: [{ year: 2026, index: 0 }] }));
  put(join(paths.voices, 'pyannote', `${callId}.npy`), npy([[1, 0], [0, 1]]));
  return { root, paths, speakerPath, notePath, put };
}

test('dry-run writes nothing; apply regenerates note; reviewed answer overrides voice result', async (t) => {
  const data = fixture(t);
  const speakerBefore = readFileSync(data.speakerPath, 'utf8');
  const noteBefore = readFileSync(data.notePath, 'utf8');
  const output = { log() {}, error(message) { throw new Error(message); } };
  const rules = [{ type: 'conversation', path: 'conversation test',
    pathRegex: /^20_Records\/23_Conversations\/\d{4}\/[^/]+\.md$/,
    required: { bundle: [], extra: [] } }];
  const options = { ...data, output, registryRules: rules };
  const dry = await runRecheck({ ...options, dryRun: true });
  assert.equal(dry.target, 1); assert.equal(dry.confirmed, 1);
  assert.equal(readFileSync(data.speakerPath, 'utf8'), speakerBefore);
  assert.equal(readFileSync(data.notePath, 'utf8'), noteBefore);
  assert.equal(existsSync(join(data.paths.root, 'speaker-recheck-log.jsonl')), false);
  assert.equal(existsSync(join(data.paths.root, '.media-diarize.lock')), false);
  assert.equal(existsSync(join(data.paths.root, 'speaker-recheck-review.html')), false);
  const applied = await runRecheck(options);
  assert.equal(applied.notes, 1);
  assert.equal(JSON.parse(readFileSync(data.speakerPath, 'utf8')).check, undefined);
  assert.doesNotMatch(readFileSync(data.notePath, 'utf8'), /\[화자 확인 필요\]/);
  assert.match(readFileSync(data.notePath, 'utf8'), /## 메모\n\n보존/);
  const second = fixture(t);
  const answersPath = join(second.paths.root, 'answers.json');
  second.put(answersPath, JSON.stringify({ version: 1, answers: { [callId]: 'S1' } }));
  await runRecheck({ ...second, output, registryRules: rules, answersPath });
  assert.equal(JSON.parse(readFileSync(second.speakerPath, 'utf8')).segments[0].speaker, 'other');
});

test("answer 'none': 상대 한 사람이 둘로 쪼개진 통화는 모든 구간을 상대로 두고 확인 표시를 지운다", async (t) => {
  const data = fixture(t);
  const output = { log() {}, error(message) { throw new Error(message); } };
  const rules = [{ type: 'conversation', path: 'conversation test',
    pathRegex: /^20_Records\/23_Conversations\/\d{4}\/[^/]+\.md$/, required: { bundle: [], extra: [] } }];
  const answersPath = join(data.paths.root, 'answers.json');
  data.put(answersPath, JSON.stringify({ version: 1, answers: { [callId]: 'none' } }));
  const result = await runRecheck({ ...data, output, registryRules: rules, answersPath });
  assert.equal(result.confirmed, 1);
  const saved = JSON.parse(readFileSync(data.speakerPath, 'utf8'));
  assert.ok(saved.segments.every((segment) => segment.speaker === 'other'));
  assert.equal(saved.recheckOwnerSpeaker, 'none');
  assert.equal(saved.check, undefined);
  assert.doesNotMatch(readFileSync(data.notePath, 'utf8'), /\[화자 확인 필요\]/);
  assert.match(renderRecheckReview([]), /둘 다 아빠 아님/);
  assert.deepEqual(parseRecheckAnswers(JSON.stringify({ version: 1, answers: { [callId]: 'none' } })), { [callId]: 'none' });
});

test('failed note write is recovered from stored speaker decision', async (t) => {
  const data = fixture(t);
  const rules = [{ type: 'conversation', path: 'conversation test',
    pathRegex: /^20_Records\/23_Conversations\/\d{4}\/[^/]+\.md$/,
    required: { bundle: [], extra: [] } }];
  const options = { ...data, registryRules: rules, output: { log() {}, error() {} } };
  await assert.rejects(runRecheck({ ...options, write(path, content) {
    if (path === data.notePath) throw new Error('injected note failure');
    writeFileSync(path, content);
  } }), /injected note failure/);
  assert.equal(JSON.parse(readFileSync(data.speakerPath, 'utf8')).check, undefined);
  assert.match(readFileSync(data.notePath, 'utf8'), /\[화자 확인 필요\]/);
  const recovered = await runRecheck(options);
  assert.equal(recovered.confirmed, 1);
  assert.doesNotMatch(readFileSync(data.notePath, 'utf8'), /\[화자 확인 필요\]/);
});

test('unrenderable transcript keeps Speakers and note uncertain', async (t) => {
  const data = fixture(t);
  const transcriptPath = join(data.root, VAULT_REL.mediaTranscripts, '2026', `${callId}.json`);
  const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8'));
  transcript.speech = false;
  data.put(transcriptPath, JSON.stringify(transcript));
  const before = readFileSync(data.speakerPath, 'utf8');
  const summary = await runRecheck({ ...data, dryRun: true,
    registryRules: [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/[^/]+\.md$/,
      required: { bundle: [], extra: [] } }], output: { log() {}, error() {} } });
  assert.equal(summary.confirmed, 0);
  assert.equal(summary.remaining, 1);
  assert.equal(readFileSync(data.speakerPath, 'utf8'), before);
});

test('export review writes only explicit outside-vault HTML', async (t) => {
  const data = fixture(t);
  const reviewPath = join(data.paths.root, 'sample.html');
  data.put(join(data.paths.voices, 'pyannote', `${callId}.npy`),
    npy([[0.5, 0.866], [0.48, 0.877]]));
  const speakerBefore = readFileSync(data.speakerPath, 'utf8');
  const noteBefore = readFileSync(data.notePath, 'utf8');
  const result = await runRecheck({ ...data, reviewPath, answersPath: null,
    registryRules: [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/[^/]+\.md$/,
      required: { bundle: [], extra: [] } }], output: { log() {}, error() {} } });
  assert.equal(result.remaining, 1);
  assert.match(readFileSync(reviewPath, 'utf8'), new RegExp(`data-id="${callId}"`));
  assert.match(readFileSync(reviewPath, 'utf8'), /A가 아빠/);
  assert.equal(readFileSync(data.speakerPath, 'utf8'), speakerBefore);
  assert.equal(readFileSync(data.notePath, 'utf8'), noteBefore);
  assert.equal(existsSync(join(data.paths.root, 'speaker-recheck-log.jsonl')), false);
  await assert.rejects(runRecheck({ ...data, reviewPath: join(data.root, '99_Adyton', 'sample.html') }),
    /볼트 밖/);
  const link = join(data.paths.root, 'linked-vault');
  symlinkSync(data.root, link);
  await assert.rejects(runRecheck({ ...data, reviewPath: join(link, 'sample.html') }),
    /볼트 밖/);
  assert.equal(existsSync(join(data.root, 'sample.html')), false);
});

test('uncertain marker belongs only to its call in a shared note', async (t) => {
  const data = fixture(t);
  const secondId = 'bbbbbbbbbbbbbbbb';
  const archivePath = join(data.root, VAULT_REL.mediaArchiveIndex);
  const archive = JSON.parse(readFileSync(archivePath, 'utf8').trim());
  data.put(archivePath, `${JSON.stringify(archive)}\n${JSON.stringify({ ...archive, id: secondId })}\n`);
  const firstTranscriptPath = join(data.root, VAULT_REL.mediaTranscripts, '2026', `${callId}.json`);
  const transcript = JSON.parse(readFileSync(firstTranscriptPath, 'utf8'));
  data.put(join(data.root, VAULT_REL.mediaTranscripts, '2026', `${secondId}.json`),
    JSON.stringify({ ...transcript, id: secondId }));
  const firstSpeakers = JSON.parse(readFileSync(data.speakerPath, 'utf8'));
  data.put(join(data.root, VAULT_REL.mediaSpeakers, '2026', `${secondId}.json`),
    JSON.stringify({ ...firstSpeakers, id: secondId }));
  data.put(join(data.paths.voices, 'pyannote', `${secondId}.npy`), npy([[1, 0], [0, 1]]));
  data.put(data.notePath, `${buildFrontmatter({ type: 'conversation', origin: 'media-transcribe', people: ['미네'] })}\n<!-- media-transcribe:start -->\n# 통화\n\n<!-- media-transcribe:id ${callId} -->\n### 11:00\n\n나: 안녕\n<!-- media-transcribe:id ${secondId} -->\n### 12:00\n\n[화자 확인 필요]\n나: 안녕\n원본: a.m4a\n<!-- media-transcribe:end -->\n`);
  const summary = await runRecheck({ ...data, dryRun: true,
    registryRules: [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/[^/]+\.md$/,
      required: { bundle: [], extra: [] } }], output: { log() {}, error() {} } });
  assert.equal(summary.target, 1);
});
