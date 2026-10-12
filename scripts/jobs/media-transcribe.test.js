import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseCallFilename, orderPending, runMediaTranscribe } from './media-transcribe.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { contactKey, isLinkedCall } from '../lib/media-people.mjs';

const QUIET = { log() {}, error() {} };
const RULES = [{ type: 'conversation', path: `${VAULT_REL.mediaConversations}/{YYYY}/`,
  pathRegex: /^20_Records\/23_Conversations\/\d{4}\/[^/]+\.md$/,
  titleRegex: /^\d{4}-\d{2}-\d{2} \S/,
  required: { bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'],
    extra: ['occurred', 'people', 'origin', 'convKind'] } }];
const ID = (number) => number.toString(16).padStart(16, '0');

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'media-transcribe-test-'));
  const root = join(base, 'vault');
  const mediaRoot = join(base, 'Media');
  const temporaryRoot = join(base, 'temporary');
  const binaries = join(base, 'bin');
  for (const path of [root, mediaRoot, temporaryRoot, binaries]) mkdirSync(path, { recursive: true });
  const model = join(base, 'model.bin');
  writeFileSync(model, 'model');
  const calls = join(base, 'calls.txt');
  const response = join(base, 'response.txt');
  writeFileSync(response, '가상의 대화입니다.');
  const executable = (name, source) => {
    const path = join(binaries, name);
    writeFileSync(path, `#!/usr/bin/env node\n${source}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const ffprobePath = executable('ffprobe', `process.stdout.write('61.2\\n');`);
  const ffmpegPath = executable('ffmpeg', `require('node:fs').writeFileSync(process.argv.at(-1), 'wav');`);
  const whisperPath = executable('whisper', `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, 'call\\n');
const prefix = process.argv[process.argv.indexOf('-of') + 1];
const lines = fs.readFileSync(${JSON.stringify(response)}, 'utf8').split('\\n');
fs.writeFileSync(prefix + '.json', JSON.stringify({ transcription: lines.map((text, index) => ({
  offsets: { from: index * 1000, to: index * 1000 + 900 }, text: ' ' + text })) }));`);
  const indexPath = join(root, VAULT_REL.mediaArchiveIndex);
  const statePath = join(root, VAULT_REL.mediaTranscribeState);
  const records = [];
  const options = { root, mediaRoot, temporaryRoot, model, ffprobePath, ffmpegPath, whisperPath,
    output: QUIET, now: new Date('2030-01-03T00:00:00Z'), registryRules: RULES };
  const put = (number, kind, filename, capturedAt = '2030-01-01T09:00:00+09:00') => {
    const archivePath = `Archive/2030/01/${kind}/${filename}`;
    const source = join(mediaRoot, archivePath);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, 'audio');
    const record = { id: ID(number), kind, archivePath, capturedAt };
    records.push(record);
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, `${records.map((item) => JSON.stringify(item)).join('\n')}\n`);
    return record;
  };
  const person = (title, fields) => {
    const path = join(root, VAULT_REL.people, `${title}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${buildFrontmatter(fields)}# ${title}\n`);
  };
  return { base, root, mediaRoot, temporaryRoot, calls, response, indexPath, statePath, options, put, person,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
    transcript: (number) => JSON.parse(readFileSync(join(root, VAULT_REL.mediaTranscripts, '2030', `${ID(number)}.json`), 'utf8')),
    note: (name) => readFileSync(join(root, VAULT_REL.mediaConversations, '2030', name), 'utf8') };
}

test('통화 파일명은 쉼표·이모지·#이 포함된 연락처와 KST 시각을 파싱한다', () => {
  assert.deepEqual(parseCallFilename('통화 녹음 가상,⭐#1_300101_123456.m4a'),
    { contact: '가상,⭐#1', occurred: '2030-01-01T12:34:56+09:00' });
  assert.equal(parseCallFilename('통화 가상_300230_123456.m4a'), null);
  assert.deepEqual(parseCallFilename('통화 녹음 가상,⭐#1_300101_123456.m4a'.normalize('NFD')),
    { contact: '가상,⭐#1', occurred: '2030-01-01T12:34:56+09:00' });
});

test('통화 연결은 정규화한 phoneContacts만 사용한다', () => {
  const people = [{ title: '가상별', aliases: ['가상별칭'], contacts: [' 가상\u200D별\uFE0F '.normalize('NFD')] }];
  assert.equal(contactKey(' 가상\u200B별\uFEFF '), '가상별');
  assert.equal(isLinkedCall('가상별', people), true);
  assert.equal(isLinkedCall('가상별칭', people), false);
});

test('제목과 별칭만 같은 통화는 전사 대상에서 제외한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상별', { aliases: ['가상별칭'], phoneContacts: ['가상연락처'] });
  f.put(1, 'Calls', '통화 가상별_300101_090000.m4a');
  f.put(2, 'Calls', '통화 가상별칭_300101_100000.m4a');
  const summary = await runMediaTranscribe({ ...f.options, dryRun: true });
  assert.equal(summary.excludedCalls, 2);
  assert.equal(summary.remaining, 0);
});

test('분해형 한글 파일명과 연락처·별칭을 정규화해 인물과 연결한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상별'.normalize('NFD'), {
    phoneContacts: ['가상,⭐#1'.normalize('NFD')], aliases: ['별이'.normalize('NFD')],
    category: '[[01_Home/200 가족]]',
  });
  f.put(1, 'Calls', '통화 녹음 가상,⭐#1_300101_090000.m4a'.normalize('NFD'));
  f.put(2, 'Recordings', '별이 노래.m4a'.normalize('NFD'));
  const summary = await runMediaTranscribe(f.options);
  assert.equal(summary.transcribed, 2);
  assert.deepEqual(f.transcript(1).people, ['가상별']);
  assert.deepEqual(f.transcript(2).people, ['가상별']);
  assert.equal(f.transcript(1).occurred, '2030-01-01T09:00:00+09:00');
  assert.ok(f.note('2030-01-01 가상별 통화.md').includes('### 09:00'));
});

test('연결된 최근 자료, 미연결 최근 자료, 오래된 자료 순으로 정렬한다', () => {
  const rows = [
    { id: 'old', occurred: '2028-01-01T00:00:00+09:00', people: ['가상'] },
    { id: 'unlinked', occurred: '2030-01-02T00:00:00+09:00', people: [] },
    { id: 'linked', occurred: '2030-01-01T00:00:00+09:00', people: ['가상'] },
  ];
  assert.deepEqual(orderPending(rows, new Date('2030-01-03T00:00:00Z')).map((row) => row.id),
    ['linked', 'unlinked', 'old']);
  assert.deepEqual(orderPending([
    { id: 'call', kind: 'Calls', occurred: '2030-01-02T00:00:00+09:00', people: ['가상'] },
    { id: 'recording', kind: 'Recordings', occurred: '2028-01-01T00:00:00+09:00', people: [] },
  ], new Date('2030-01-03T00:00:00Z')).map((row) => row.id), ['recording', 'call']);
});

test('통화 description 조사는 받침과 영문 이름에 맞춘다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  for (const title of ['가상봄', '가상나', 'MockAlex']) f.person(title, { phoneContacts: [title] });
  f.put(1, 'Calls', '통화 가상봄_300101_090000.m4a');
  f.put(2, 'Calls', '통화 가상나_300101_100000.m4a');
  f.put(3, 'Calls', '통화 MockAlex_300101_110000.m4a');
  await runMediaTranscribe(f.options);
  assert.equal(parseFrontmatter(f.note('2030-01-01 가상봄 통화.md')).description, '가상봄과 통화 1건, 총 2분');
  assert.equal(parseFrontmatter(f.note('2030-01-01 가상나 통화.md')).description, '가상나와 통화 1건, 총 2분');
  assert.equal(parseFrontmatter(f.note('2030-01-01 MockAlex 통화.md')).description, 'MockAlex와 통화 1건, 총 2분');
});

test('phoneContacts·aliases 연결, 하루 통화 묶음, 시각순, 멱등, 녹음 개별 노트', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상별', { phoneContacts: ['가상,⭐#1'], aliases: ['별이'], category: '[[01_Home/201 가상]]' });
  f.put(1, 'Calls', '통화 가상,⭐#1_300101_120000.m4a');
  f.put(2, 'Calls', '통화 녹음 가상,⭐#1_300101_090000.m4a');
  f.put(3, 'Recordings', '별이 노래.m4a');
  const first = await runMediaTranscribe(f.options);
  assert.equal(first.transcribed, 3);
  assert.equal(first.created, 2);
  assert.deepEqual(f.transcript(1).people, ['가상별']);
  assert.deepEqual(f.transcript(3).people, ['가상별']);
  const call = f.note('2030-01-01 가상별 통화.md');
  assert.ok(call.indexOf('### 09:00') < call.indexOf('### 12:00'));
  assert.equal(parseFrontmatter(call).category, '[[01_Home/200 가족]]');
  assert.equal(parseFrontmatter(call).created, '2030-01-01');
  assert.deepEqual(parseFrontmatter(call).people, [`[[${VAULT_REL.people}/가상별]]`]);
  assert.ok(call.includes('원본: Archive/'));
  assert.ok(f.note('2030-01-01 별이 노래 녹음.md').includes('가상의 대화입니다.'));
  const second = await runMediaTranscribe(f.options);
  assert.equal(second.transcribed, 0);
  assert.equal(readFileSync(f.calls, 'utf8').trim().split('\n').length, 3);
  assert.deepEqual(readdirSync(f.temporaryRoot), []);
});

test('기존 오너 영역과 미관리 머리말을 보존하고 새 통화만 합친다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상A', { phoneContacts: ['가상A'] });
  f.put(1, 'Calls', '통화 가상A_300101_090000.m4a');
  await runMediaTranscribe(f.options);
  const path = join(f.root, VAULT_REL.mediaConversations, '2030', '2030-01-01 가상A 통화.md');
  writeFileSync(path, f.note('2030-01-01 가상A 통화.md').replace('created: "2030-01-01"',
    'created: "2029-12-31"\nownerField: "남긴 값"') + '\n추가한 오너 문장\n');
  f.put(2, 'Calls', '통화 가상A_300101_100000.m4a');
  const summary = await runMediaTranscribe(f.options);
  assert.equal(summary.updated, 1);
  const result = f.note('2030-01-01 가상A 통화.md');
  assert.equal(parseFrontmatter(result).created, '2029-12-31');
  assert.equal(parseFrontmatter(result).ownerField, '남긴 값');
  assert.ok(result.includes('추가한 오너 문장'));
  assert.ok(result.includes('### 09:00') && result.includes('### 10:00'));
});

test('무음 문구는 speech:false로 저장하고 노트에 음성 없음으로 표시한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  writeFileSync(f.response, '시청해주셔서 감사합니다.\n구독과 좋아요.');
  f.put(1, 'Recordings', '가상 녹음.m4a');
  const summary = await runMediaTranscribe(f.options);
  assert.equal(summary.silent, 1);
  assert.equal(f.transcript(1).speech, false);
  assert.ok(f.note('2030-01-01 가상 녹음 녹음.md').includes('(음성 없음)'));
});

test('dry-run은 전사·상태·노트·잠금 파일을 쓰지 않고 예상 시간을 보고한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상A', { phoneContacts: ['가상A'] });
  f.put(1, 'Calls', '통화 가상A_300101_090000.m4a');
  const logs = [];
  const summary = await runMediaTranscribe({ ...f.options, dryRun: true, output: { log: (line) => logs.push(line), error() {} } });
  assert.equal(summary.buckets[0].count, 1);
  assert.equal(summary.buckets[0].expectedSec, 11);
  assert.equal(summary.upcoming[0].notePath, `${VAULT_REL.mediaConversations}/2030/2030-01-01 가상A 통화.md`);
  assert.equal(existsSync(f.statePath), false);
  assert.equal(existsSync(`${f.statePath}.lock`), false);
  assert.equal(existsSync(join(f.root, VAULT_REL.mediaTranscripts)), false);
  assert.equal(existsSync(f.calls), false);
  assert.ok(logs.some((line) => line.includes('upcoming')));
});

test('미연결 통화는 전사와 노트 복구에서 제외하고 미연결 녹음은 유지한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상연결', { phoneContacts: ['가상연결'] });
  f.put(1, 'Calls', '통화 가상연결_300101_090000.m4a');
  f.put(2, 'Calls', '통화 가상미연결_300101_100000.m4a');
  f.put(3, 'Calls', '통화 가상과거_300101_110000.m4a');
  f.put(4, 'Recordings', '가상 독백.m4a');
  const oldTranscript = join(f.root, VAULT_REL.mediaTranscripts, '2030', `${ID(3)}.json`);
  mkdirSync(dirname(oldTranscript), { recursive: true });
  writeFileSync(oldTranscript, JSON.stringify({ id: ID(3), occurred: '2030-01-01T11:00:00+09:00' }));

  const dryLogs = [];
  const dry = await runMediaTranscribe({ ...f.options, dryRun: true,
    output: { log: (line) => dryLogs.push(line), error() {} } });
  assert.deepEqual(dry.buckets.map((bucket) => bucket.count), [1, 1, 0]);
  assert.deepEqual(dry.upcoming.map((record) => record.id), [ID(4), ID(1)]);
  assert.equal(dry.remaining, 2);
  assert.equal(dry.excludedCalls, 2);
  assert.match(dryLogs.at(-1), /남은 대기 2, 미연결 통화 제외 2$/);

  const logs = [];
  const result = await runMediaTranscribe({ ...f.options,
    output: { log: (line) => logs.push(line), error() {} } });
  assert.equal(result.transcribed, 2);
  assert.equal(result.created, 2);
  assert.equal(result.remaining, 0);
  assert.equal(result.excludedCalls, 2);
  assert.equal(existsSync(join(f.root, VAULT_REL.mediaTranscripts, '2030', `${ID(2)}.json`)), false);
  assert.equal(existsSync(join(f.root, VAULT_REL.mediaConversations, '2030', '2030-01-01 가상미연결 통화.md')), false);
  assert.equal(existsSync(join(f.root, VAULT_REL.mediaConversations, '2030', '2030-01-01 가상과거 통화.md')), false);
  assert.ok(f.note('2030-01-01 가상 독백 녹음.md').includes('가상의 대화입니다.'));
  assert.equal(readFileSync(f.calls, 'utf8').trim().split('\n').length, 2);
  assert.match(logs.at(-1), /남은 대기 0, 미연결 통화 제외 2$/);
});

test('실패를 기록하고 세 번 실패한 항목은 건너뛴다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상A', { phoneContacts: ['가상A'] });
  f.put(1, 'Calls', '통화 가상A_300101_090000.m4a');
  const bad = join(f.base, 'bad');
  writeFileSync(bad, '#!/bin/sh\nexit 1\n'); chmodSync(bad, 0o755);
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await runMediaTranscribe({ ...f.options, whisperPath: bad });
    assert.equal(result.failed, 1);
  }
  assert.equal(JSON.parse(readFileSync(f.statePath, 'utf8')).failures[ID(1)].length, 3);
  const skipped = await runMediaTranscribe(f.options);
  assert.equal(skipped.transcribed, 0);
  assert.equal(existsSync(f.calls), false);
  assert.deepEqual(readdirSync(f.temporaryRoot), []);
});

test('전사 JSON 기록 후 중단되어 노트가 없으면 다음 실행에서 복구한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상A', { phoneContacts: ['가상A'] });
  f.put(1, 'Calls', '통화 가상A_300101_090000.m4a');
  await runMediaTranscribe(f.options);
  const path = join(f.root, VAULT_REL.mediaConversations, '2030', '2030-01-01 가상A 통화.md');
  rmSync(path);
  const result = await runMediaTranscribe(f.options);
  assert.equal(result.transcribed, 0);
  assert.equal(result.created, 1);
  assert.ok(existsSync(path));
});

test('기존 노트 갱신 실패도 저장된 전사에서 다음 실행에 복구한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상A', { phoneContacts: ['가상A'] });
  f.put(1, 'Calls', '통화 가상A_300101_090000.m4a');
  await runMediaTranscribe(f.options);
  f.put(2, 'Calls', '통화 가상A_300101_100000.m4a');
  const failed = await runMediaTranscribe({ ...f.options, write: (path, content) => {
    if (path.endsWith('.md')) throw new Error('가상 쓰기 실패');
    writeAtomic(path, content);
  } });
  assert.equal(failed.failed, 1);
  assert.equal(f.transcript(2).id, ID(2));
  const recovered = await runMediaTranscribe(f.options);
  assert.equal(recovered.transcribed, 0);
  assert.equal(recovered.updated, 1);
  assert.ok(f.note('2030-01-01 가상A 통화.md').includes('### 10:00'));
});

test('같은 날 같은 제목의 녹음도 각각 한 노트로 만든다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.put(1, 'Recordings', '가상 녹음.m4a');
  f.put(2, 'Recordings', '가상#녹음.m4a', '2030-01-01T10:00:00+09:00');
  f.put(3, 'Recordings', '다른 녹음.m4a');
  const result = await runMediaTranscribe(f.options);
  assert.equal(result.created, 3);
  const names = readdirSync(join(f.root, VAULT_REL.mediaConversations, '2030'));
  assert.equal(names.length, 3);
  assert.ok(names.some((name) => name.includes(`${ID(2)}.md`)));
});

test('녹음 제목 충돌은 색인 순서가 바뀌거나 새 항목이 생겨도 기존 노트 소유자를 유지한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const first = f.put(2, 'Recordings', '가상 녹음.m4a');
  const second = f.put(3, 'Recordings', '가상#녹음.m4a');
  await runMediaTranscribe(f.options);
  const base = join(f.root, VAULT_REL.mediaConversations, '2030', '2030-01-01 가상 녹음 녹음.md');
  writeFileSync(base, `${readFileSync(base, 'utf8')}\n오너 기록\n`);
  writeFileSync(f.indexPath, `${JSON.stringify(second)}\n${JSON.stringify(first)}\n`);
  const reordered = await runMediaTranscribe(f.options);
  assert.equal(reordered.updated, 0);
  assert.ok(readFileSync(base, 'utf8').includes(`<!-- media-transcribe:id ${ID(2)} -->`));
  assert.ok(readFileSync(base, 'utf8').includes('오너 기록'));
  const added = f.put(1, 'Recordings', '가상?녹음.m4a');
  writeFileSync(f.indexPath, [added, second, first].map((record) => JSON.stringify(record)).join('\n') + '\n');
  await runMediaTranscribe(f.options);
  assert.ok(readFileSync(base, 'utf8').includes(`<!-- media-transcribe:id ${ID(2)} -->`));
  assert.ok(readFileSync(base, 'utf8').includes('오너 기록'));
  assert.ok(f.note(`2030-01-01 가상 녹음 녹음 ${ID(1)}.md`).includes(`<!-- media-transcribe:id ${ID(1)} -->`));
});

test('서로 다른 통화 연락처가 같은 정리 제목으로 충돌하면 쓰기 전에 멈춘다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상#A', { phoneContacts: ['가상#A'] });
  f.person('가상 A', { phoneContacts: ['가상 A'] });
  f.put(1, 'Calls', '통화 가상#A_300101_090000.m4a');
  f.put(2, 'Calls', '통화 가상 A_300101_100000.m4a');
  await assert.rejects(runMediaTranscribe(f.options), /통화 상대의 노트 제목 충돌/);
  assert.equal(existsSync(join(f.root, VAULT_REL.mediaTranscripts)), false);
});

test('색인 시각이 다른 해로 보정되어도 기존 ID를 다시 전사하지 않는다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const record = f.put(1, 'Recordings', '가상 녹음.m4a');
  await runMediaTranscribe(f.options);
  record.capturedAt = '2031-01-01T09:00:00+09:00';
  writeFileSync(f.indexPath, `${JSON.stringify(record)}\n`);
  const result = await runMediaTranscribe(f.options);
  assert.equal(result.transcribed, 0);
  assert.equal(readFileSync(f.calls, 'utf8').trim().split('\n').length, 1);
  assert.equal(existsSync(join(f.root, VAULT_REL.mediaTranscripts, '2031', `${ID(1)}.json`)), false);
});

test('구간별 시각을 저장하고 빈 구간은 빼며 text는 구간을 이어 붙인다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상별', { phoneContacts: ['가상연락처'] });
  f.put(1, 'Calls', '통화 가상연락처_300101_090000.m4a');
  writeFileSync(f.response, '가상 첫 문장\n   \n가상 둘째 문장');
  const summary = await runMediaTranscribe(f.options);
  assert.equal(summary.transcribed, 1);
  const transcript = f.transcript(1);
  assert.deepEqual(transcript.segments, [
    { start: 0, end: 900, text: '가상 첫 문장' },
    { start: 2000, end: 2900, text: '가상 둘째 문장' },
  ]);
  assert.equal(transcript.text, '가상 첫 문장 가상 둘째 문장');
});

test('Whisper JSON이 없으면 실패로 기록하고 전사 원본을 쓰지 않는다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상별', { phoneContacts: ['가상연락처'] });
  f.put(1, 'Calls', '통화 가상연락처_300101_090000.m4a');
  const noJson = join(f.base, 'bin', 'whisper-nojson');
  writeFileSync(noJson, '#!/bin/sh\nexit 0\n'); chmodSync(noJson, 0o755);
  const summary = await runMediaTranscribe({ ...f.options, whisperPath: noJson });
  assert.equal(summary.transcribed, 0);
  assert.equal(summary.failed, 1);
  assert.equal(JSON.parse(readFileSync(f.statePath, 'utf8')).failures[ID(1)].length, 1);
});

test('구간 시각이 없는 옛 전사 원본은 다시 전사하고 노트를 다시 만든다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상별', { phoneContacts: ['가상연락처'] });
  f.put(1, 'Calls', '통화 가상연락처_300101_090000.m4a');
  await runMediaTranscribe(f.options);
  const path = join(f.root, VAULT_REL.mediaTranscripts, '2030', `${ID(1)}.json`);
  const legacy = { ...f.transcript(1), text: '옛 가상 전사' };
  delete legacy.segments;
  writeFileSync(path, `${JSON.stringify(legacy)}\n`);
  const dry = await runMediaTranscribe({ ...f.options, dryRun: true });
  assert.equal(dry.remaining, 1);
  writeFileSync(f.response, '새 가상 전사');
  const again = await runMediaTranscribe(f.options);
  assert.equal(again.transcribed, 1);
  assert.equal(again.remaining, 0);
  assert.ok(Array.isArray(f.transcript(1).segments));
  assert.match(f.note('2030-01-01 가상별 통화.md'), /새 가상 전사/);
  const idle = await runMediaTranscribe(f.options);
  assert.equal(idle.transcribed, 0);
});

test('전사 모델 파일명이 바뀌면 다시 전사하고 같으면 대기하지 않는다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상별', { phoneContacts: ['가상연락처'] });
  f.put(1, 'Calls', '통화 가상연락처_300101_090000.m4a');
  const oldModel = join(f.base, 'ggml-old.bin');
  const newModel = join(f.base, 'ggml-new.bin');
  writeFileSync(oldModel, 'old model');
  writeFileSync(newModel, 'new model');
  await runMediaTranscribe({ ...f.options, model: oldModel });
  assert.equal(f.transcript(1).model, oldModel);
  const dry = await runMediaTranscribe({ ...f.options, model: newModel, dryRun: true });
  assert.equal(dry.remaining, 1);
  writeFileSync(f.response, '새 모델의 가상 전사');
  const again = await runMediaTranscribe({ ...f.options, model: newModel });
  assert.equal(again.transcribed, 1);
  assert.equal(again.updated, 1);
  assert.equal(again.remaining, 0);
  assert.equal(f.transcript(1).model, newModel);
  assert.match(f.note('2030-01-01 가상별 통화.md'), /새 모델의 가상 전사/);
  const idle = await runMediaTranscribe({ ...f.options, model: newModel, dryRun: true });
  assert.equal(idle.remaining, 0);
  const alternateDirectory = join(f.base, 'alternate');
  mkdirSync(alternateDirectory);
  const sameFilename = join(alternateDirectory, 'ggml-new.bin');
  writeFileSync(sameFilename, 'same model filename');
  const sameName = await runMediaTranscribe({ ...f.options, model: sameFilename, dryRun: true });
  assert.equal(sameName.remaining, 0);
  assert.equal(readFileSync(f.calls, 'utf8').trim().split('\n').length, 2);
});
