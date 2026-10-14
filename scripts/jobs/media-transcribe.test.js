import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectRepetition, parseCallFilename, orderPending, runMediaTranscribe } from './media-transcribe.mjs';
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
const LOOP = '문경읍이 뭐에요? '.repeat(20).trim();

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
  const retryResponse = join(base, 'response-mc0.txt');
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
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const prefix = process.argv[process.argv.indexOf('-of') + 1];
const retry = process.argv.includes('-mc');
const source = retry && fs.existsSync(${JSON.stringify(retryResponse)})
  ? ${JSON.stringify(retryResponse)} : ${JSON.stringify(response)};
const lines = fs.readFileSync(source, 'utf8').split('\\n');
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
  return { base, root, mediaRoot, temporaryRoot, calls, response, retryResponse, indexPath, statePath, options, put, person,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
    transcript: (number) => JSON.parse(readFileSync(join(root, VAULT_REL.mediaTranscripts, '2030', `${ID(number)}.json`), 'utf8')),
    note: (name) => readFileSync(join(root, VAULT_REL.mediaConversations, '2030', name), 'utf8') };
}

test('반복 감지는 긴 환각만 찾고 긴 입력도 빠르게 처리한다', () => {
  const found = detectRepetition(`먼저 대화 ${LOOP} 다음 대화`);
  assert.equal(found.looped, true);
  assert.equal(found.phrase, '문경읍이 뭐에요?');
  assert.equal(found.count, 20);
  assert.ok(found.span.length >= 80);
  assert.equal(detectRepetition('짧은 노래 후렴 '.repeat(7)).looped, false);
  assert.equal(detectRepetition('abcdefghi '.repeat(8)).looped, false);
  const start = performance.now();
  assert.equal(detectRepetition('가상의 일상 대화가 이어집니다. '.repeat(700)).looped, true);
  assert.ok(performance.now() - start < 5000);
  const varied = Array.from({ length: 2000 }, (_, index) => `가상${index}의 이야기`).join(' ');
  const scanStart = performance.now();
  assert.equal(detectRepetition(varied).looped, false);
  assert.ok(performance.now() - scanStart < 5000);
});

test('반복 1차 결과는 mc0으로 한 번 재시도하고 개선된 전사를 채택한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.put(1, 'Recordings', '가상 대화.m4a');
  writeFileSync(f.response, LOOP);
  writeFileSync(f.retryResponse, '문경읍의 이야기를 나눴습니다.');
  await runMediaTranscribe(f.options);
  const calls = readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].includes('-mc'), false);
  assert.deepEqual(calls[1].slice(calls[1].indexOf('-mc'), calls[1].indexOf('-mc') + 2), ['-mc', '0']);
  assert.equal(f.transcript(1).text, '문경읍의 이야기를 나눴습니다.');
  assert.equal(f.transcript(1).decodeRetry, 'mc0');
  assert.equal(f.transcript(1).repetition, undefined);
});

test('정상 전사는 재시도 없이 기존 출력 형식을 유지한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.put(1, 'Recordings', '가상 대화.m4a');
  await runMediaTranscribe(f.options);
  assert.equal(readFileSync(f.calls, 'utf8').trim().split('\n').length, 1);
  assert.equal(f.transcript(1).decodeRetry, undefined);
  assert.equal(f.transcript(1).repetition, undefined);
  assert.match(f.note('2030-01-01 가상 대화 녹음.md'), /가상의 대화입니다\./);
});

test('재시도도 반복이면 원문과 구간을 보존하고 노트만 줄인다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.put(1, 'Recordings', '가상 대화.m4a');
  writeFileSync(f.response, LOOP.repeat(2));
  writeFileSync(f.retryResponse, LOOP);
  await runMediaTranscribe(f.options);
  assert.equal(f.transcript(1).decodeRetry, 'mc0');
  assert.equal(f.transcript(1).text, LOOP);
  assert.equal(f.transcript(1).segments[0].text, LOOP);
  assert.equal(f.transcript(1).repetition.looped, true);
  const note = f.note('2030-01-01 가상 대화 녹음.md');
  assert.match(note, /같은 구절 17회 반복 — 전사 오류로 줄임/);
  assert.ok(!note.includes(LOOP));
});

test('일반 mc0 재시도는 뒤쪽 반복이 더 길어지면 채택하지 않는다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.put(1, 'Recordings', '가상 반복.m4a');
  writeFileSync(f.response, LOOP);
  const worse = `${'작은 반복 문장 '.repeat(10)} 중간 ${'아주 길게 반복되는 가상 문장 '.repeat(25)}`;
  writeFileSync(f.retryResponse, worse);
  await runMediaTranscribe(f.options);
  assert.equal(f.transcript(1).text, LOOP);
  assert.equal(f.transcript(1).decodeRetry, undefined);
});

test('mc0 재시도 실패는 원문을 유지하고 한 줄 오류를 기록한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.put(1, 'Recordings', '가상 반복.m4a');
  writeFileSync(f.response, LOOP);
  const script = readFileSync(f.options.whisperPath, 'utf8');
  writeFileSync(f.options.whisperPath, script.replace('const source = retry',
    "if (retry) { process.stderr.write('가상 실패\\n상세'); process.exit(7); }\nconst source = retry"));
  const errors = [];
  await runMediaTranscribe({ ...f.options,
    output: { log() {}, error: (line) => errors.push(line) } });
  assert.equal(f.transcript(1).text, LOOP);
  assert.equal(f.transcript(1).decodeRetry, undefined);
  assert.equal(typeof f.transcript(1).decodeRetryError, 'string');
  assert.equal(f.transcript(1).decodeRetryError.includes('\n'), false);
  assert.match(errors.join('\n'), /-mc 0 재시도 실패/);
});

test('서로 떨어진 반복 구간과 무음 문구 반복도 노트에서 줄인다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.put(1, 'Recordings', '가상 반복.m4a');
  const repeated = `감사합니다 `.repeat(20).trim();
  writeFileSync(f.response, `${repeated} 중간 대화 ${repeated}`);
  await runMediaTranscribe(f.options);
  assert.equal(f.transcript(1).text, `${repeated} 중간 대화 ${repeated}`);
  const note = f.note('2030-01-01 가상 반복 녹음.md');
  assert.equal((note.match(/전사 오류로 줄임/g) || []).length, 2);
  f.put(2, 'Recordings', '가상 무음 반복.m4a');
  writeFileSync(f.response, repeated);
  await runMediaTranscribe(f.options);
  assert.equal(f.transcript(2).speech, false);
  assert.match(f.note('2030-01-01 가상 무음 반복 녹음.md'), /\(음성 없음 — 반복 환각 20회\)/);
});

test('fix-loops는 저장된 반복만 N개 처리하고 dry-run에서는 아무것도 쓰지 않는다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  for (let number = 1; number <= 3; number += 1) {
    f.put(number, 'Recordings', `가상 대화 ${number}.m4a`);
    writeFileSync(f.response, number === 3 ? '정상적인 가상 대화' : LOOP);
    await runMediaTranscribe(f.options);
  }
  const names = [1, 2].map((number) => `2030-01-01 가상 대화 ${number} 녹음.md`);
  const notePath = join(f.root, VAULT_REL.mediaConversations, '2030', names[0]);
  const transcriptPath = join(f.root, VAULT_REL.mediaTranscripts, '2030', `${ID(1)}.json`);
  const originalNote = f.note(names[0]);
  const originalTranscript = readFileSync(transcriptPath, 'utf8');
  const callsBefore = readFileSync(f.calls, 'utf8');
  const logs = [];
  const dry = await runMediaTranscribe({ ...f.options, fixLoops: 1, dryRun: true,
    output: { log: (line) => logs.push(line), error() {} } });
  assert.equal(dry.upcoming.length, 1);
  assert.match(logs[0], /"count":2/);
  assert.equal(readFileSync(f.calls, 'utf8'), callsBefore);
  assert.equal(readFileSync(notePath, 'utf8'), originalNote);
  assert.equal(readFileSync(transcriptPath, 'utf8'), originalTranscript);
  assert.equal(existsSync(`${f.statePath}.lock`), false);

  writeFileSync(notePath, originalNote.replace('convKind: "녹음"', 'convKind: "통화"')
    .replace('people: []', 'people: ["[[30_Wiki/31_People/가상인물]]"]')
    .replace('category: "[[01_Home/100 나]]"', 'category: "[[01_Home/500 기술]]"\nemotions: ["기쁨"]\nprimaryEmotion: "기쁨"\nimportance: 4\nmineAge: "가상 나이"')
    + '\n오너가 남긴 메모\n');
  writeFileSync(f.response, LOOP);
  writeFileSync(f.retryResponse, '정상적인 새 전사입니다.');
  const result = await runMediaTranscribe({ ...f.options, fixLoops: 1 });
  assert.equal(result.transcribed, 1);
  assert.equal(f.transcript(1).decodeRetry, 'mc0');
  assert.equal(f.transcript(2).text, LOOP);
  const updated = f.note(names[0]);
  const fields = parseFrontmatter(updated);
  // 자동값(대면·녹음) 밖의 수동 convKind와 수동 people은 보존한다. category는 합친 people
  // 기준으로 다시 계산한다(people 밖 수동 category는 바뀌는 의도된 한계).
  assert.equal(fields.convKind, '통화');
  assert.notEqual(fields.category, '[[01_Home/500 기술]]');
  assert.deepEqual(fields.people, ['[[30_Wiki/31_People/가상인물]]']);
  assert.deepEqual(fields.emotions, ['기쁨']);
  assert.equal(fields.primaryEmotion, '기쁨');
  assert.equal(fields.importance, 4);
  assert.equal(fields.mineAge, '가상 나이');
  assert.match(updated, /오너가 남긴 메모/);
  assert.match(updated, /정상적인 새 전사입니다/);
  const legacyTranscript = f.transcript(1);
  delete legacyTranscript.segments;
  writeFileSync(transcriptPath, `${JSON.stringify(legacyTranscript)}\n`);
  await runMediaTranscribe(f.options);
  // 다음 일반 실행 뒤에도 수동 convKind·people·아테나 필드·오너 메모가 남는다.
  const after = f.note(names[0]);
  const afterFields = parseFrontmatter(after);
  assert.equal(afterFields.category, '[[01_Home/100 나]]');
  assert.equal(afterFields.convKind, '통화');
  assert.deepEqual(afterFields.people, ['[[30_Wiki/31_People/가상인물]]']);
  assert.deepEqual(afterFields.emotions, ['기쁨']);
  assert.equal(afterFields.importance, 4);
  assert.match(after, /오너가 남긴 메모/);
});

test('fix-loops는 악화된 전사를 보존하고 같은 모델의 재시도를 제외한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.put(1, 'Recordings', '가상 반복.m4a');
  writeFileSync(f.response, LOOP);
  await runMediaTranscribe(f.options);
  const note = f.note('2030-01-01 가상 반복 녹음.md');
  const before = f.transcript(1);
  const callsBefore = readFileSync(f.calls, 'utf8').trim().split('\n').length;
  const logs = [];
  const result = await runMediaTranscribe({ ...f.options, fixLoops: 1,
    output: { log: (line) => logs.push(line), error: (line) => logs.push(line) } });
  assert.equal(result.loopFixSkipped, 1);
  assert.equal(result.transcribed, 0);
  assert.equal(f.transcript(1).text, before.text);
  assert.equal(f.transcript(1).loopFixAttemptedModel, f.options.model);
  assert.equal(f.transcript(1).loopFixAttemptedAt, f.options.now.toISOString());
  assert.equal(f.note('2030-01-01 가상 반복 녹음.md'), note);
  assert.match(logs.join('\n'), /반복 수정 건너뜀/);
  const newCalls = readFileSync(f.calls, 'utf8').trim().split('\n').slice(callsBefore).map(JSON.parse);
  assert.equal(newCalls.length, 1);
  assert.ok(newCalls[0].includes('-mc'));
  const dry = await runMediaTranscribe({ ...f.options, fixLoops: 1, dryRun: true });
  assert.equal(dry.excludedLoops, 1);
  assert.equal(dry.upcoming.length, 0);
  const olderModel = { ...f.transcript(1), model: '/older/legacy.bin' };
  writeFileSync(join(f.root, VAULT_REL.mediaTranscripts, '2030', `${ID(1)}.json`),
    `${JSON.stringify(olderModel)}\n`);
  const changedModelDry = await runMediaTranscribe({ ...f.options, fixLoops: 1, dryRun: true });
  assert.equal(changedModelDry.excludedLoops, 1);
});

test('fix-loops는 이미 mc0을 채택한 같은 모델을 제외하고 원본 없음·JSON 오류를 집계한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  for (let number = 1; number <= 3; number += 1) {
    f.put(number, 'Recordings', `가상 반복 ${number}.m4a`);
    writeFileSync(f.response, number === 1 ? LOOP.repeat(2) : LOOP);
    writeFileSync(f.retryResponse, number === 1 ? LOOP : LOOP);
    await runMediaTranscribe(f.options);
  }
  const missing = join(f.mediaRoot, f.put(4, 'Recordings', '가상 임시.m4a').archivePath);
  rmSync(missing);
  rmSync(join(f.mediaRoot, 'Archive/2030/01/Recordings/가상 반복 2.m4a'));
  writeFileSync(join(f.root, VAULT_REL.mediaTranscripts, '2030', `${ID(3)}.json`), '{broken');
  const errors = [];
  const dry = await runMediaTranscribe({ ...f.options, fixLoops: 10, dryRun: true,
    output: { log() {}, error: (line) => errors.push(line) } });
  assert.equal(dry.excludedLoops, 1);
  assert.equal(dry.missingAudio, 1);
  assert.equal(dry.invalidTranscript, 1);
  assert.equal(dry.upcoming.length, 0);
  assert.match(errors.join('\n'), /전사 JSON 건너뜀/);
});

test('fix-loops는 누적 오디오 길이 상한에서 다음 항목을 멈춘다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  for (let number = 1; number <= 2; number += 1) {
    f.put(number, 'Recordings', `가상 반복 ${number}.m4a`);
    writeFileSync(f.response, LOOP);
    await runMediaTranscribe(f.options);
  }
  writeFileSync(f.retryResponse, '개선된 가상 대화입니다.');
  const result = await runMediaTranscribe({ ...f.options, fixLoops: 2, maxMinutes: 1.1 });
  assert.equal(result.transcribed, 1);
  assert.equal(result.remaining, 1);
  const strict = await runMediaTranscribe({ ...f.options, fixLoops: 2, maxMinutes: 1 });
  assert.equal(strict.transcribed, 0);
  assert.equal(strict.remaining, 1);
});

test('fix-loops는 뒤쪽 반복이 더 길어지면 앞쪽 반복이 짧아도 버린다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.put(1, 'Recordings', '가상 반복.m4a');
  writeFileSync(f.response, LOOP);
  await runMediaTranscribe(f.options);
  const worse = `${'작은 반복 문장 '.repeat(10)} 중간 ${'아주 길게 반복되는 가상 문장 '.repeat(25)}`;
  assert.ok(detectRepetition(worse).span.length < detectRepetition(LOOP).span.length);
  writeFileSync(f.retryResponse, worse);
  const result = await runMediaTranscribe({ ...f.options, fixLoops: 1 });
  assert.equal(result.loopFixSkipped, 1);
  assert.equal(f.transcript(1).text, LOOP);
});

test('fix-loops는 긴 첫 후보를 건너뛰고 예산에 맞는 뒤 후보를 처리한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  for (let number = 1; number <= 2; number += 1) {
    f.put(number, 'Recordings', `가상 반복 ${number}.m4a`);
    writeFileSync(f.response, LOOP);
    await runMediaTranscribe(f.options);
  }
  writeFileSync(f.options.ffprobePath, `#!/usr/bin/env node\nprocess.stdout.write(process.argv.at(-1).includes('반복 1') ? '120\\n' : '30\\n');\n`);
  writeFileSync(f.retryResponse, '개선된 대화입니다.');
  const result = await runMediaTranscribe({ ...f.options, fixLoops: 2, maxMinutes: 1 });
  assert.equal(result.transcribed, 1);
  assert.equal(result.remaining, 1);
  assert.equal(f.transcript(1).text, LOOP);
  assert.equal(f.transcript(2).text, '개선된 대화입니다.');
});

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

test('201 표지 인물만 등장한 녹음은 가족과 201 category를 배열로 쓴다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  // 실제 인물 노트의 category도 201로 시작한다고 가정하며, 인물 이름은 가상값만 쓴다.
  f.person('가상별', { category: '[[01_Home/201 미네]]' });
  f.put(1, 'Recordings', '가상별 노래.m4a');
  await runMediaTranscribe(f.options);
  const note = f.note('2030-01-01 가상별 노래 녹음.md');
  assert.deepEqual(parseFrontmatter(note).category,
    ['[[01_Home/200 가족]]', '[[01_Home/201 미네]]']);
  assert.match(note, /^category: \["\[\[01_Home\/200 가족\]\]", "\[\[01_Home\/201 미네\]\]"\]$/m);
});

test('가족 아닌 인물의 녹음은 100 나 category를 쓴다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상동료', { category: '[[01_Home/100 나]]' });
  f.put(1, 'Recordings', '가상동료 대화.m4a');
  await runMediaTranscribe(f.options);
  assert.equal(parseFrontmatter(f.note('2030-01-01 가상동료 대화 녹음.md')).category,
    '[[01_Home/100 나]]');
});

test('통화 휘영과 녹음 미네·휘영의 하위 category를 번호순으로 쓴다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상휘영', { phoneContacts: ['가상휘영'],
    category: ['[[01_Home/200 가족]]', '[[01_Home/202 휘영]]'] });
  f.person('가상미네', { category: '[[01_Home/201 미네]]' });
  f.put(1, 'Calls', '통화 가상휘영_300101_090000.m4a');
  f.put(2, 'Recordings', '가상미네 가상휘영 대화.m4a');
  await runMediaTranscribe(f.options);
  assert.deepEqual(parseFrontmatter(f.note('2030-01-01 가상휘영 통화.md')).category,
    ['[[01_Home/200 가족]]', '[[01_Home/202 휘영]]']);
  assert.deepEqual(parseFrontmatter(f.note('2030-01-01 가상미네 가상휘영 대화 녹음.md')).category,
    ['[[01_Home/200 가족]]', '[[01_Home/201 미네]]', '[[01_Home/202 휘영]]']);
});

test('일반 재실행은 수동 category를 자동 갱신하지 않는다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상휘영', { phoneContacts: ['가상휘영'], category: '[[01_Home/200 가족]]' });
  f.put(1, 'Calls', '통화 가상휘영_300101_090000.m4a');
  await runMediaTranscribe(f.options);
  const name = '2030-01-01 가상휘영 통화.md';
  const path = join(f.root, VAULT_REL.mediaConversations, '2030', name);
  writeFileSync(path, `${f.note(name)}\n오너가 쓴 내용\n`);
  f.person('가상휘영', { phoneContacts: ['가상휘영'],
    category: ['[[01_Home/200 가족]]', '[[01_Home/202 휘영]]'] });
  const result = await runMediaTranscribe(f.options);
  assert.equal(result.transcribed, 0);
  assert.equal(result.updated, 1);
  assert.deepEqual(parseFrontmatter(f.note(name)).category,
    ['[[01_Home/200 가족]]', '[[01_Home/202 휘영]]']);
  assert.match(f.note(name), /오너가 쓴 내용/);
});

test('재작성은 수동 people·category와 아테나 필드를 보존한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상동료', { category: '[[01_Home/100 나]]' });
  f.person('가상가족', { category: '[[01_Home/200 가족]]' });
  f.put(1, 'Recordings', '가상동료 대화.m4a');
  await runMediaTranscribe(f.options);
  const name = '2030-01-01 가상동료 대화 녹음.md';
  const path = join(f.root, VAULT_REL.mediaConversations, '2030', name);
  const familyLink = `[[${VAULT_REL.people}/가상가족]]`;
  const manualFields = [
    `people: ["${familyLink}", "${familyLink}"]`,
    'emotions: ["기쁨", "안도"]',
    'primaryEmotion: "기쁨"',
    'importance: 4',
    'mineAge: "가상 나이"',
    'coreMemory: true',
    'islands: ["가상 섬"]',
  ].join('\n');
  writeFileSync(path, f.note(name).replace(`people: ["[[${VAULT_REL.people}/가상동료]]"]`, manualFields));
  await runMediaTranscribe({ ...f.options, rewriteNotes: true });
  let fields = parseFrontmatter(f.note(name));
  assert.deepEqual(fields.people, [`[[${VAULT_REL.people}/가상동료]]`, familyLink]);
  assert.equal(fields.category, '[[01_Home/200 가족]]');
  assert.deepEqual(fields.emotions, ['기쁨', '안도']);
  assert.equal(fields.primaryEmotion, '기쁨');
  assert.equal(fields.importance, 4);
  assert.equal(fields.mineAge, '가상 나이');
  assert.equal(fields.coreMemory, true);
  assert.deepEqual(fields.islands, ['가상 섬']);

  writeFileSync(path, f.note(name).replace(/^people: .*$/m, `people: "${familyLink}"`));
  await runMediaTranscribe({ ...f.options, rewriteNotes: true });
  fields = parseFrontmatter(f.note(name));
  assert.deepEqual(fields.people, [`[[${VAULT_REL.people}/가상동료]]`, familyLink]);
  assert.equal(fields.category, '[[01_Home/200 가족]]');
});

test('미연결 녹음의 수동 people과 기존 category를 재작성에서 유지한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.person('가상아이', { category: '[[01_Home/201 미네]]' });
  f.put(1, 'Recordings', '무명 녹음.m4a');
  await runMediaTranscribe(f.options);
  const name = '2030-01-01 무명 녹음 녹음.md';
  const path = join(f.root, VAULT_REL.mediaConversations, '2030', name);
  const childLink = `[[${VAULT_REL.people}/가상아이]]`;
  writeFileSync(path, f.note(name).replace('people: []', `people: "${childLink}"`));
  await runMediaTranscribe({ ...f.options, rewriteNotes: true });
  const fields = parseFrontmatter(f.note(name));
  assert.deepEqual(fields.people, [childLink]);
  assert.deepEqual(fields.category, ['[[01_Home/200 가족]]', '[[01_Home/201 미네]]']);
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
  f.person('가상별', { phoneContacts: ['가상,⭐#1'], aliases: ['별이'], category: '[[01_Home/201 미네]]' });
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
  assert.deepEqual(parseFrontmatter(call).category, ['[[01_Home/200 가족]]', '[[01_Home/201 미네]]']);
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

test('날짜로 시작하는 녹음 이름은 파일명 전체와 녹음 접미를 쓴다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.put(1, 'Recordings', '2025-09-20 아이 노래 바다.m4a');
  const summary = await runMediaTranscribe({ ...f.options, dryRun: true });
  assert.equal(summary.upcoming[0].notePath,
    `${VAULT_REL.mediaConversations}/2025/2025-09-20 아이 노래 바다 녹음.md`);
});

test('예전 제목의 녹음 노트 네 건은 같은 ID를 찾아 기존 경로에서 재렌더한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const names = [
    ['2025-09-20 미네 노래 Ocean', '2025-09-20 미네 노래 Ocean'],
    ['2026-06-10 미네 통화 숙제 힘들어 4', '2026-06-10 미네 통화 숙제 힘들어 4'],
    ['2025-11-03 미네 동화 숲 이야기', '2025-11-03 미네 동화 숲 이야기'],
    ['2026-01-12 미네 대화 학교 소식', '2026-01-12 미네 대화 학교 소식'],
  ];
  const { recordingNoteTitle } = await import('../lib/media-recording-title.mjs');
  for (const [stem] of names) f.put(names.findIndex(([name]) => name === stem) + 1, 'Recordings', `${stem}.m4a`);
  await runMediaTranscribe(f.options);
  for (const [stem, oldTitle] of names) {
    const year = stem.slice(0, 4);
    const directory = join(f.root, VAULT_REL.mediaConversations, year);
    renameSync(join(directory, `${recordingNoteTitle(stem)}.md`), join(directory, `${oldTitle}.md`));
  }
  const result = await runMediaTranscribe({ ...f.options, rewriteNotes: true, limit: 0, maxMinutes: 0 });
  assert.equal(result.failed, 0);
  for (const [stem, oldTitle] of names) {
    const directory = join(f.root, VAULT_REL.mediaConversations, stem.slice(0, 4));
    assert.equal(existsSync(join(directory, `${oldTitle}.md`)), true);
    assert.equal(existsSync(join(directory, `${recordingNoteTitle(stem)}.md`)), false);
  }
});

test('녹음 convKind는 기본 녹음이고 파일명에 통화·전화가 있으면 통화다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.put(1, 'Recordings', '가상 노래.m4a');
  f.put(2, 'Recordings', '가상 통화 기록.m4a');
  f.put(3, 'Recordings', '가상 전화 기록.m4a');
  await runMediaTranscribe(f.options);
  assert.equal(parseFrontmatter(f.note('2030-01-01 가상 노래 녹음.md')).convKind, '녹음');
  assert.equal(parseFrontmatter(f.note('2030-01-01 가상 통화 기록 녹음.md')).convKind, '통화');
  assert.equal(parseFrontmatter(f.note('2030-01-01 가상 전화 기록 녹음.md')).convKind, '통화');
});

test('날짜 접두 녹음은 본문 제목에 날짜를 반복하지 않고 description에서 날짜를 뺀다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.put(1, 'Recordings', '2025-09-20 가상 노래 바다.m4a');
  await runMediaTranscribe(f.options);
  const note = readFileSync(join(f.root, VAULT_REL.mediaConversations, '2025',
    '2025-09-20 가상 노래 바다 녹음.md'), 'utf8');
  assert.match(note, /<!-- media-transcribe:start -->\n# 2025-09-20 가상 노래 바다 녹음\n/);
  assert.equal(parseFrontmatter(note).description, '가상 노래 바다 2분');
});

test('재작성은 Whisper와 예산 없이 노트를 갱신하고 수동 convKind·오너 메모를 보존한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.put(1, 'Recordings', '가상 노래.m4a');
  f.put(2, 'Recordings', '가상 이야기.m4a');
  f.put(3, 'Recordings', '가상 통화 기록.m4a');
  await runMediaTranscribe(f.options);
  const names = ['2030-01-01 가상 노래 녹음.md', '2030-01-01 가상 이야기 녹음.md',
    '2030-01-01 가상 통화 기록 녹음.md'];
  const paths = names.map((name) => join(f.root, VAULT_REL.mediaConversations, '2030', name));
  writeFileSync(paths[0], f.note(names[0]).replace('convKind: "녹음"', 'convKind: "통화"')
    + '\n가상 오너 메모\n');
  writeFileSync(paths[1], f.note(names[1]).replace('convKind: "녹음"', 'convKind: "대면"'));
  writeFileSync(paths[2], f.note(names[2]).replace('convKind: "통화"', 'convKind: "녹음"'));
  const before = paths.map((path) => readFileSync(path, 'utf8'));
  const whisperCalls = readFileSync(f.calls, 'utf8');
  rmSync(f.options.model);
  const logs = [];
  const options = { ...f.options, rewriteNotes: true, limit: 0, maxMinutes: 0,
    whisperPath: join(f.base, 'missing-whisper'),
    output: { log: (line) => logs.push(line), error() {} } };
  const dry = await runMediaTranscribe({ ...options, dryRun: true });
  assert.equal(dry.rewritten, 0);
  assert.match(logs[0], /"count":3/);
  assert.ok(logs[0].includes(names[0]));
  assert.deepEqual(paths.map((path) => readFileSync(path, 'utf8')), before);
  const result = await runMediaTranscribe(options);
  assert.equal(result.transcribed, 0);
  assert.equal(result.rewritten, 3);
  assert.equal(result.updated, 3);
  assert.equal(parseFrontmatter(f.note(names[0])).convKind, '통화');
  assert.equal(parseFrontmatter(f.note(names[1])).convKind, '녹음');
  assert.equal(parseFrontmatter(f.note(names[2])).convKind, '통화');
  assert.ok(f.note(names[0]).includes('가상 오너 메모'));
  assert.equal(readFileSync(f.calls, 'utf8'), whisperCalls);
  assert.ok(logs.at(-1).includes('재작성 3'));
});

test('기존 녹음 이름은 발생 날짜와 녹음 접미를 유지한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.put(1, 'Recordings', '아이 노래 바다.m4a');
  const summary = await runMediaTranscribe({ ...f.options, dryRun: true });
  assert.equal(summary.upcoming[0].notePath,
    `${VAULT_REL.mediaConversations}/2030/2030-01-01 아이 노래 바다 녹음.md`);
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
test('색인 날짜 의심 변경은 기존 완성 노트를 재렌더하고 오너 확정 때 표시를 뺀다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const record = f.put(1, 'Recordings', '가상 대화.m4a');
  await runMediaTranscribe(f.options);
  const name = '2030-01-01 가상 대화 녹음.md';
  assert.equal(parseFrontmatter(f.note(name)).dateCheck, undefined);
  record.capturedFrom = 'mtime';
  record.capturedConfidence = 'review';
  writeFileSync(f.indexPath, `${JSON.stringify(record)}\n`);
  await runMediaTranscribe({ ...f.options, limit: 0 });
  assert.equal(parseFrontmatter(f.note(name)).dateCheck, '의심');
  record.capturedFrom = 'owner';
  record.capturedConfidence = 'confirmed';
  writeFileSync(f.indexPath, `${JSON.stringify(record)}\n`);
  await runMediaTranscribe({ ...f.options, limit: 0 });
  assert.equal(parseFrontmatter(f.note(name)).dateCheck, undefined);
});
test('긴 이름과 이모지의 녹음 제목은 공용 정리 규칙을 따르고 재렌더해도 오너 메모를 보존한다', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const stem = `2030-01-01 가상 노래 ${'긴이야기'.repeat(12)} 😀`;
  f.put(1, 'Recordings', `${stem}.m4a`);
  await runMediaTranscribe(f.options);
  const { recordingNoteTitle } = await import('../lib/media-recording-title.mjs');
  const title = recordingNoteTitle(stem);
  const path = join(f.root, VAULT_REL.mediaConversations, '2030', `${title}.md`);
  const before = readFileSync(path, 'utf8');
  writeFileSync(path, `${before}\n오너 메모 보존\n`);
  await runMediaTranscribe({ ...f.options, rewriteNotes: true, limit: 0, maxMinutes: 0 });
  assert.match(readFileSync(path, 'utf8'), /오너 메모 보존/);
});
