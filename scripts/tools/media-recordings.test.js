import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, linkSync, utimesSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { runInNewContext, Script } from 'node:vm';
import { dateCandidate, dateSuspicious, recordingName, numberedNames, answerWithDate, renderSheet, proposeRecordings, applyRecordings } from './media-recordings.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { recordingNoteTitle } from '../lib/media-recording-title.mjs';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'recordings-test-'));
  const root = join(base, 'Vault'), mediaRoot = join(base, 'Media'), out = join(base, 'Rename');
  const content = 'sample recording bytes';
  const id = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const inbox = join(mediaRoot, 'Inbox/Recordings/0928 song.m4a');
  const archiveRel = 'Archive/2019/10/Recordings/0928 song.m4a';
  const archive = join(mediaRoot, archiveRel);
  const noteRel = `${VAULT_REL.mediaConversations}/2019/2019-10-01 예전 녹음.md`;
  const note = join(root, noteRel);
  const indexPath = join(root, VAULT_REL.mediaArchiveIndex);
  const transcript = join(root, VAULT_REL.mediaTranscripts, '2019', `${id}.json`);
  for (const path of [inbox, archive, note, indexPath, transcript, join(root, VAULT_REL.registryFile)]) mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(inbox, content); linkSync(inbox, archive);
  utimesSync(inbox, new Date('2019-10-01T03:00:00Z'), new Date('2019-10-01T03:00:00Z'));
  writeFileSync(indexPath, `${JSON.stringify({ id, kind: 'Recordings', inboxPath: 'Inbox/Recordings/0928 song.m4a', archivePath: archiveRel,
    capturedAt: '2019-10-01T12:00:00+09:00', capturedFrom: 'mtime', capturedConfidence: 'review' })}\n`);
  writeFileSync(note, `---\ntype: "conversation"\norigin: "media-transcribe"\noccurred: "2019-10-01T12:00:00+09:00"\ndescription: "0928 song 2분"\npeople: ["[[30_Wiki/31_People/미네]]"]\nconvKind: "녹음"\ndateCheck: "의심"\n---\n<!-- media-transcribe:start -->\n# 옛 제목\n<!-- media-transcribe:id ${id} -->\n원본: ${archiveRel}\n<!-- media-transcribe:end -->\n\n## 오너 메모\n\n소중한 내용\n`);
  const wiki = join(root, '30_Wiki/34_Topics/녹음 기록.md');
  mkdirSync(join(wiki, '..'), { recursive: true });
  writeFileSync(wiki, `---\ntype: "topic"\n---\n옛 링크 [[${noteRel.replace(/\.md$/, '')}#기억]]`);
  writeFileSync(transcript, JSON.stringify({ id, occurred: '2019-10-01T12:00:00+09:00', speech: true, text: '산토끼 토끼야 어디를 가느냐' }));
  writeFileSync(join(root, VAULT_REL.registryFile), '');
  return { root, mediaRoot, out, indexPath, id, inbox, archive, note, noteRel, transcript, content, wiki };
}
test('이름·날짜 후보·시트', () => {
  assert.equal(recordingNoteTitle('2019-09-28 미네 노래 산토끼 부르기'), '2019-09-28 미네 노래 산토끼 부르기 녹음');
  const longTitle = recordingNoteTitle(`2019-09-28 ${'가😀'.repeat(120)}`);
  assert.ok(Buffer.byteLength(`${longTitle}.md`) <= 255);
  assert.ok([...longTitle].length <= 73);
  assert.doesNotMatch(longTitle, /😀/);
  assert.equal(dateCandidate('0928 song.m4a', '2019'), '2019-09-28');
  assert.equal(dateCandidate('0230 song.m4a', '2019'), null);
  assert.equal(dateSuspicious({ capturedFrom: 'mtime' }), true);
  assert.equal(recordingName('2019-09-28', '미네', '노래', '산토끼 부르기'), '2019-09-28 미네 노래 산토끼 부르기');
  assert.deepEqual(numberedNames([{ newName: 'abc' }, { newName: 'abc' }]).map((x) => x.newName), ['abc', 'abc 2']);
  assert.deepEqual(numberedNames([{ newName: 'abc' }, { newName: 'abc 2' }, { newName: 'abc' }]).map((x) => x.newName), ['abc', 'abc 2', 'abc 3']);
  assert.deepEqual(answerWithDate({ id: 'a', date: '2019-10-01', newName: '2019-10-01 미네 노래 산토끼', skip: false }, '2019-09-28'),
    { id: 'a', date: '2019-09-28', newName: '2019-09-28 미네 노래 산토끼', skip: false });
  const html = renderSheet({ hash: 'x', rows: [{ id: 'a', originalName: 'old', newName: 'new', date: '2019-09-28', suspect: true }] });
  assert.match(html, /type='date'|type="date"|date\.type='date'/);
  assert.match(html, /suspect/);
  assert.match(html, /Object\.assign\(a,answerWithDate\(a,chosen\)\)/);
  assert.doesNotMatch(html, /https?:\/\//);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Script(script));
  const elements = [];
  const byId = new Map();
  const document = {
    createElement(tag) { const element = { tag, children: [], append(...children) { this.children.push(...children); } }; elements.push(element); return element; },
    createTextNode(text) { return { text }; },
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, { children: [], replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } });
      return byId.get(id);
    },
  };
  const saved = new Map();
  const localStorage = { getItem(key) { return saved.get(key) ?? null; }, setItem(key, value) { saved.set(key, value); }, removeItem(key) { saved.delete(key); } };
  const sheet = renderSheet({ hash: 'date-test', rows: [{ id: 'a', originalName: 'old', newName: '2019-10-01 미네 노래 산토끼',
    date: '2019-10-01', candidate: '2019-09-28', suspect: true, preview: '' }] });
  runInNewContext(sheet.match(/<script>([\s\S]*?)<\/script>/)[1], { document, localStorage });
  elements.find((element) => element.tag === 'button' && element.textContent === '파일명 2019-09-28').onclick();
  const nameInput = elements.find((element) => element.tag === 'input' && element.type === 'text');
  nameInput.value = '2019-09-28 미네 노래 토끼 이야기';
  nameInput.oninput();
  const skipInput = elements.find((element) => element.tag === 'input' && element.type === 'checkbox');
  skipInput.checked = true;
  skipInput.onchange();
  assert.deepEqual(JSON.parse(saved.get('recordings-date-test'))[0],
    { id: 'a', newName: '2019-09-28 미네 노래 토끼 이야기', date: '2019-09-28', skip: true });
});
test('MMDD 후보의 연도는 capturedAt이 아닌 파일 수정 시각을 따른다', async () => {
  const f = fixture();
  utimesSync(f.inbox, new Date('2020-10-01T03:00:00Z'), new Date('2020-10-01T03:00:00Z'));
  const result = await proposeRecordings({ ...f, now: new Date('2026-10-15T00:00:00Z'), judge: async () => JSON.stringify([{ id: f.id, kind: '노래', content: '산토끼 부르기' }]), cooldown: () => false });
  assert.equal(result.proposal.rows[0].date, '2019-10-01');
  assert.equal(result.proposal.rows[0].candidate, '2020-09-28');
  unlinkSync(f.inbox);
  const fallback = await proposeRecordings({ ...f, now: new Date('2026-10-15T01:00:00Z'), judge: async () => JSON.stringify([{ id: f.id, kind: '노래', content: '산토끼 부르기' }]), cooldown: () => false });
  assert.equal(fallback.proposal.rows[0].candidate, '2020-09-28');
});
test('제안·dry-run·적용·두 번째 적용은 임시 데이터만 변경', async () => {
  const f = fixture();
  const result = await proposeRecordings({ ...f, now: new Date('2026-10-15T00:00:00Z'), judge: async () => JSON.stringify([{ id: f.id, kind: '노래', content: '산토끼 부르기' }]), cooldown: () => false });
  const secondProposal = await proposeRecordings({ ...f, now: new Date('2026-10-15T00:00:00Z'), judge: async () => JSON.stringify([{ id: f.id, kind: '노래', content: '토끼 노래' }]), cooldown: () => false });
  assert.notEqual(secondProposal.path, result.path);
  assert.equal(JSON.parse(readFileSync(result.path, 'utf8')).hash, result.proposal.hash);
  assert.equal(result.proposal.rows[0].suspect, true);
  assert.equal(result.proposal.rows[0].candidate, '2019-09-28');
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: result.proposal.hash,
    rows: [{ id: f.id, date: '2019-09-28', newName: '2019-09-28 미네 노래 산토끼 부르기', skip: false }] }));
  const dry = await applyRecordings({ ...f, answersPath, proposalPath: result.path, dryRun: true, rules: [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, titleRegex: /^\d{4}-\d{2}-\d{2} /, required: { bundle: [], extra: [] } }, { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, titleRegex: null, required: { bundle: [], extra: [] } }] });
  assert.equal(dry.changed.length, 1);
  assert.equal(readFileSync(f.inbox, 'utf8'), f.content);
  const applied = await applyRecordings({ ...f, answersPath, proposalPath: result.path, rules: [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, titleRegex: /^\d{4}-\d{2}-\d{2} /, required: { bundle: [], extra: [] } }, { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, titleRegex: null, required: { bundle: [], extra: [] } }] });
  assert.deepEqual(applied.failed, []);
  assert.equal(applied.changed.length, 1);
  assert.equal(readFileSync(f.inbox, 'utf8'), f.content);
  const target = join(f.mediaRoot, 'Archive/2019/09/Recordings/2019-09-28 미네 노래 산토끼 부르기.m4a');
  assert.equal(readFileSync(target, 'utf8'), f.content);
  assert.equal(existsSync(f.archive), false);
  const newNote = join(f.root, VAULT_REL.mediaConversations, '2019', '2019-09-28 미네 노래 산토끼 부르기 녹음.md');
  assert.match(readFileSync(newNote, 'utf8'), /movedFrom:.*2019-10-01/);
  assert.match(readFileSync(newNote, 'utf8'), /description: "미네 노래 산토끼 부르기 2분"/);
  assert.match(readFileSync(newNote, 'utf8'), /소중한 내용/);
  assert.doesNotMatch(readFileSync(newNote, 'utf8'), /dateCheck:/);
  assert.match(readFileSync(f.wiki, 'utf8'), /2019-09-28 미네 노래 산토끼 부르기 녹음/);
  assert.match(readFileSync(f.wiki, 'utf8'), /#기억/);
  assert.equal(JSON.parse(readFileSync(f.indexPath, 'utf8')).capturedFrom, 'owner');
  assert.equal(JSON.parse(readFileSync(f.transcript, 'utf8')).occurred.slice(0, 10), '2019-09-28');
  const again = await applyRecordings({ ...f, answersPath, proposalPath: result.path, rules: [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, titleRegex: /^\d{4}-\d{2}-\d{2} /, required: { bundle: [], extra: [] } }, { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, titleRegex: null, required: { bundle: [], extra: [] } }] });
  assert.equal(again.changed.length, 0);
  const exiftoolPath = join(f.out, 'fake-exiftool');
  writeFileSync(exiftoolPath, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2).filter(a => !a.startsWith("-")).map(file => ({SourceFile:file}))));\n', { mode: 0o755 });
  const { runMediaArchive } = await import('../jobs/media-archive.mjs');
  const archiveRun = await runMediaArchive({ mediaRoot: f.mediaRoot, indexPath: f.indexPath, vaultRoot: f.root,
    exiftoolPath, now: new Date(Date.now() + 600_000), output: { log() {}, error() {} } });
  assert.equal(archiveRun.archived, 0);
  assert.equal(archiveRun.skipped, 1);
  assert.equal(archiveRun.failed, 0);
});
test('건별 실패 후 Archive·Inbox·색인·노트 되돌림', async () => {
  const f = fixture();
  const result = await proposeRecordings({ ...f, now: new Date('2026-10-15T00:00:00Z'), judge: async () => JSON.stringify([{ id: f.id, kind: '노래', content: '산토끼 부르기' }]), cooldown: () => false });
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: result.proposal.hash,
    rows: [{ id: f.id, date: '2019-09-28', newName: '2019-09-28 미네 노래 산토끼 부르기', skip: false }] }));
  const indexBefore = readFileSync(f.indexPath, 'utf8');
  const noteBefore = readFileSync(f.note, 'utf8');
  const { writeAtomic } = await import('../lib/state-writer.mjs');
  let injected = false;
  const resultApply = await applyRecordings({ ...f, answersPath, proposalPath: result.path,
    rules: [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, titleRegex: /^\d{4}-\d{2}-\d{2} /, required: { bundle: [], extra: [] } }, { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, titleRegex: null, required: { bundle: [], extra: [] } }],
    write: (path, content) => {
      if (!injected && path.endsWith('산토끼 부르기 녹음.md')) { injected = true; throw new Error('주입 실패'); }
      writeAtomic(path, content);
    } });
  assert.equal(resultApply.failed.length, 1);
  assert.equal(readFileSync(f.inbox, 'utf8'), f.content);
  assert.equal(readFileSync(f.archive, 'utf8'), f.content);
  assert.equal(readFileSync(f.indexPath, 'utf8'), indexBefore);
  assert.equal(readFileSync(f.note, 'utf8'), noteBefore);
  assert.match(readFileSync(join(f.root, VAULT_REL.mediaRenameLog), 'utf8'), /"stage":"rolled-back"/);
});
test('연도를 고치면 전사 원본도 새 연도에서 찾힌다', async () => {
  const f = fixture();
  const result = await proposeRecordings({ ...f, now: new Date('2026-10-15T00:00:00Z'), judge: async () => JSON.stringify([{ id: f.id, kind: '노래', content: '산토끼 부르기' }]), cooldown: () => false });
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: result.proposal.hash,
    rows: [{ id: f.id, date: '2020-01-02', newName: '2020-01-02 미네 노래 산토끼 부르기', skip: false }] }));
  const applied = await applyRecordings({ ...f, answersPath, proposalPath: result.path,
    rules: [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, titleRegex: /^\d{4}-\d{2}-\d{2} /, required: { bundle: [], extra: [] } }, { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, titleRegex: null, required: { bundle: [], extra: [] } }] });
  assert.deepEqual(applied.failed, []);
  assert.equal(existsSync(f.transcript), false);
  const moved = join(f.root, VAULT_REL.mediaTranscripts, '2020', `${f.id}.json`);
  assert.equal(JSON.parse(readFileSync(moved, 'utf8')).occurred.slice(0, 10), '2020-01-02');
});
test('한 건 실패해도 다음 녹음은 적용한다', async () => {
  const f = fixture();
  const secondContent = 'second recording bytes';
  const secondId = createHash('sha256').update(secondContent).digest('hex').slice(0, 16);
  const secondInbox = join(f.mediaRoot, 'Inbox/Recordings/두번째.m4a');
  const secondArchiveRel = 'Archive/2019/10/Recordings/두번째.m4a';
  mkdirSync(join(secondInbox, '..'), { recursive: true });
  writeFileSync(secondInbox, secondContent);
  linkSync(secondInbox, join(f.mediaRoot, secondArchiveRel));
  const first = JSON.parse(readFileSync(f.indexPath, 'utf8'));
  writeFileSync(f.indexPath, `${JSON.stringify(first)}\n${JSON.stringify({ ...first, id: secondId,
    inboxPath: 'Inbox/Recordings/두번째.m4a', archivePath: secondArchiveRel })}\n`);
  const result = await proposeRecordings({ ...f, now: new Date('2026-10-15T00:00:00Z'),
    judge: async () => JSON.stringify([{ id: f.id, kind: '노래', content: '산토끼 부르기' }]), cooldown: () => false });
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: result.proposal.hash,
    rows: [{ id: f.id, date: '2019-09-28', newName: '2019-09-28 미네 노래 산토끼 부르기', skip: false },
      { id: secondId, date: '2019-10-01', newName: '2019-10-01 대화 두번째 녹음', skip: false }] }));
  const targetFirst = join(f.mediaRoot, 'Archive/2019/09/Recordings/2019-09-28 미네 노래 산토끼 부르기.m4a');
  mkdirSync(join(targetFirst, '..'), { recursive: true });
  writeFileSync(targetFirst, 'collision');
  const applied = await applyRecordings({ ...f, answersPath, proposalPath: result.path,
    rules: [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, titleRegex: /^\d{4}-\d{2}-\d{2} /, required: { bundle: [], extra: [] } }, { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, titleRegex: null, required: { bundle: [], extra: [] } }] });
  assert.equal(applied.failed.length, 1);
  assert.equal(applied.changed.length, 1);
  assert.equal(readFileSync(f.inbox, 'utf8'), f.content);
  assert.equal(readFileSync(secondInbox, 'utf8'), secondContent);
});
test('변경 기록 쓰기가 계속 실패해도 Archive부터 복원하고 건을 실패로 보고한다', async () => {
  const f = fixture();
  const proposal = await proposeRecordings({ ...f, now: new Date('2026-10-15T00:00:00Z'),
    judge: async () => JSON.stringify([{ id: f.id, kind: '노래', content: '산토끼 부르기' }]), cooldown: () => false });
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: proposal.proposal.hash,
    rows: [{ id: f.id, date: '2019-09-28', newName: '2019-09-28 미네 노래 산토끼 부르기', skip: false }] }));
  const originalIndex = readFileSync(f.indexPath, 'utf8');
  const { writeAtomic } = await import('../lib/state-writer.mjs');
  const result = await applyRecordings({ ...f, answersPath, proposalPath: proposal.path,
    rules: [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, titleRegex: /^\d{4}-\d{2}-\d{2} /, required: { bundle: [], extra: [] } }, { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, titleRegex: null, required: { bundle: [], extra: [] } }],
    write: writeAtomic, append: () => { throw new Error('변경 기록 쓰기 실패'); } });
  assert.equal(result.failed.length, 1);
  assert.equal(existsSync(f.archive), true);
  assert.equal(readFileSync(f.indexPath, 'utf8'), originalIndex);
  assert.equal(existsSync(f.note), true);
  assert.equal(existsSync(join(f.root, VAULT_REL.mediaRenameLog)), false);
});
test('긴 이름·이모지 적용 후 전사 잡 재렌더도 같은 노트와 오너 메모를 쓴다', async () => {
  const f = fixture();
  const proposal = await proposeRecordings({ ...f, now: new Date('2026-10-15T00:00:00Z'),
    judge: async () => JSON.stringify([{ id: f.id, kind: '노래', content: '산토끼 부르기' }]), cooldown: () => false });
  const longName = `2019-09-28 미네 노래 ${'긴이야기'.repeat(10)} 😀`;
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: proposal.proposal.hash,
    rows: [{ id: f.id, date: '2019-09-28', newName: longName, skip: false }] }));
  const rules = [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/,
    titleRegex: /^\d{4}-\d{2}-\d{2} /, required: { bundle: [], extra: [] } },
  { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, titleRegex: null, required: { bundle: [], extra: [] } }];
  const applied = await applyRecordings({ ...f, answersPath, proposalPath: proposal.path, rules });
  assert.deepEqual(applied.failed, []);
  const { recordingNoteTitle } = await import('../lib/media-recording-title.mjs');
  const note = join(f.root, VAULT_REL.mediaConversations, '2019', `${recordingNoteTitle(longName)}.md`);
  assert.equal(existsSync(note), true);
  const { runMediaTranscribe } = await import('../jobs/media-transcribe.mjs');
  const rerender = await runMediaTranscribe({ root: f.root, mediaRoot: f.mediaRoot, rewriteNotes: true, limit: 0,
    maxMinutes: 0, registryRules: rules, output: { log() {}, error() {} } });
  assert.equal(rerender.failed, 0);
  assert.equal(existsSync(note), true);
  assert.match(readFileSync(note, 'utf8'), /소중한 내용/);
});

test('전사 잠금과 미완료 기록은 적용 전에 중단한다', async () => {
  const f = fixture();
  const proposal = await proposeRecordings({ ...f, judge: async () => '[]', cooldown: () => false });
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: proposal.proposal.hash,
    rows: [{ id: f.id, date: '2019-10-01', newName: '2019-10-01 미네 대화 내용 확인', skip: false }] }));
  const lock = join(f.root, `${VAULT_REL.mediaTranscribeState}.lock`);
  writeFileSync(lock, `${process.pid}:test`);
  await assert.rejects(applyRecordings({ ...f, answersPath, proposalPath: proposal.path }), /전사 잡 실행 중/);
  unlinkSync(lock);
  writeFileSync(join(f.root, VAULT_REL.mediaRenameLog), `${JSON.stringify({ id: f.id, stage: 'start', step: 'Archive·색인' })}\n`);
  await assert.rejects(applyRecordings({ ...f, answersPath, proposalPath: proposal.path, dryRun: true }), /미완료 녹음 개명.*Archive·색인/);
});

test('링크 수정은 허용 폴더만 읽고 표 별칭·확장자·분해형 한글을 고친다', async () => {
  const f = fixture();
  const proposal = await proposeRecordings({ ...f, judge: async () => '[]', cooldown: () => false });
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: proposal.proposal.hash,
    rows: [{ id: f.id, date: '2019-09-28', newName: '2019-09-28 미네 노래 산토끼 부르기', skip: false }] }));
  const short = '2019-10-01 예전 녹음';
  writeFileSync(f.wiki, `---\ntype: "topic"\n---\n| [[${short.normalize('NFD')}\\|별칭]] | [[${short}.md]] |`);
  const excluded = ['99_Adyton', '80_Archive', '95_Etna', '60_Logs', '.hidden'];
  for (const folder of excluded) {
    const path = join(f.root, folder, 'old.md');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `[[${short}]]`);
  }
  const rules = [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, required: { bundle: [], extra: [] } },
    { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, required: { bundle: [], extra: [] } }];
  const result = await applyRecordings({ ...f, answersPath, proposalPath: proposal.path, rules });
  assert.deepEqual(result.failed, []);
  assert.match(readFileSync(f.wiki, 'utf8'), /산토끼 부르기 녹음\\\|별칭/);
  assert.match(readFileSync(f.wiki, 'utf8'), /산토끼 부르기 녹음\]\]/);
  for (const folder of excluded) assert.equal(readFileSync(join(f.root, folder, 'old.md'), 'utf8'), `[[${short}]]`);
});

test('95건 제안 픽스처는 한 번의 탐색으로 처리한다', async () => {
  const f = fixture();
  const first = JSON.parse(readFileSync(f.indexPath, 'utf8'));
  writeFileSync(f.indexPath, `${Array.from({ length: 95 }, (_, number) => JSON.stringify({ ...first,
    id: number.toString(16).padStart(16, '0') })).join('\n')}\n`);
  const started = performance.now();
  const result = await proposeRecordings({ ...f, judge: async () => '[]', cooldown: () => false });
  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(result.proposal.rows.length, 95);
  assert.ok(elapsedMs < 5000, `95건 제안 ${elapsedMs}ms`);
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: result.proposal.hash,
    rows: result.proposal.rows.map((row) => ({ id: row.id, date: row.date, newName: row.newName, skip: false })) }));
  const applyStarted = performance.now();
  const preview = await applyRecordings({ ...f, answersPath, proposalPath: result.path, dryRun: true, rules: [] });
  const applyMs = Math.round(performance.now() - applyStarted);
  assert.equal(preview.changed.length, 0);
  assert.equal(preview.failed.length, 95);
  assert.ok(preview.failed.every((item) => /보관 파일 해시 불일치/.test(item.error)));
  assert.ok(applyMs < 5000, `95건 적용 미리보기 ${applyMs}ms`);
  console.log(`95건 픽스처: 제안 ${elapsedMs}ms, 적용 미리보기 ${applyMs}ms`);
});

test('제안과 dry-run·적용은 대소문자 무시 노트 제목 충돌을 보고하고 건너뛴다', async () => {
  const f = fixture();
  const occupied = join(f.root, VAULT_REL.mediaConversations, '2019', '2019-09-28 미네 노래 산토끼 부르기 녹음.MD');
  writeFileSync(occupied, '---\ntype: "conversation"\n---\n# 기존 노트\n');
  writeFileSync(join(f.root, VAULT_REL.mediaConversations, '2019', '2019-10-01 미네 노래 산토끼 부르기 녹음.MD'),
    '---\ntype: "conversation"\n---\n# 기존 노트\n');
  const proposal = await proposeRecordings({ ...f, judge: async () => JSON.stringify([{ id: f.id,
    kind: '노래', content: '산토끼 부르기' }]), cooldown: () => false });
  assert.match(proposal.proposal.rows[0].conflict, /노트 제목 충돌/);
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: proposal.proposal.hash,
    rows: [{ id: f.id, date: '2019-09-28', newName: '2019-09-28 미네 노래 산토끼 부르기', skip: false }] }));
  const options = { ...f, answersPath, proposalPath: proposal.path, rules: [] };
  assert.match((await applyRecordings({ ...options, dryRun: true })).failed[0].error, /충돌/);
  assert.match((await applyRecordings(options)).failed[0].error, /충돌/);
  assert.equal(existsSync(f.archive), true);
});

test('서로 링크한 녹음 두 건은 옛 노트를 되살리지 않고 새 노트마다 한 번 쓴다', async () => {
  const f = fixture();
  const secondBytes = 'second linked recording';
  const secondId = createHash('sha256').update(secondBytes).digest('hex').slice(0, 16);
  const secondRel = 'Archive/2019/10/Recordings/second.m4a';
  const secondInbox = join(f.mediaRoot, 'Inbox/Recordings/second.m4a');
  writeFileSync(secondInbox, secondBytes);
  linkSync(secondInbox, join(f.mediaRoot, secondRel));
  const secondNoteRel = `${VAULT_REL.mediaConversations}/2019/2019-10-01 두번째 녹음.md`;
  const firstRecord = JSON.parse(readFileSync(f.indexPath, 'utf8'));
  writeFileSync(f.indexPath, `${JSON.stringify(firstRecord)}\n${JSON.stringify({ ...firstRecord,
    id: secondId, inboxPath: 'Inbox/Recordings/second.m4a', archivePath: secondRel })}\n`);
  writeFileSync(join(f.root, secondNoteRel), readFileSync(f.note, 'utf8')
    .replaceAll(f.id, secondId).replaceAll(firstRecord.archivePath, secondRel));
  writeFileSync(f.note, `${readFileSync(f.note, 'utf8')}\n[[${secondNoteRel.replace(/\.md$/, '')}]]\n[[${f.noteRel.replace(/\.md$/, '')}]]\n`);
  const secondNote = join(f.root, secondNoteRel);
  writeFileSync(secondNote, `${readFileSync(secondNote, 'utf8')}\n[[${f.noteRel.replace(/\.md$/, '')}]]\n`);
  const proposal = await proposeRecordings({ ...f, judge: async () => '[]', cooldown: () => false });
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: proposal.proposal.hash,
    rows: [{ id: f.id, date: '2019-09-28', newName: '2019-09-28 미네 노래 산토끼 부르기', skip: false },
      { id: secondId, date: '2019-10-01', newName: '2019-10-01 미네 대화 학교 이야기', skip: false }] }));
  const writes = [];
  const { writeAtomic } = await import('../lib/state-writer.mjs');
  const rules = [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, required: { bundle: [], extra: [] } },
    { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, required: { bundle: [], extra: [] } }];
  const result = await applyRecordings({ ...f, answersPath, proposalPath: proposal.path, rules,
    write: (path, content) => { writes.push(path); writeAtomic(path, content); } });
  assert.deepEqual(result.failed, []);
  const firstNew = join(f.root, VAULT_REL.mediaConversations, '2019', '2019-09-28 미네 노래 산토끼 부르기 녹음.md');
  const secondNew = join(f.root, VAULT_REL.mediaConversations, '2019', '2019-10-01 미네 대화 학교 이야기 녹음.md');
  assert.equal(existsSync(f.note), false);
  assert.equal(existsSync(secondNote), false);
  assert.match(readFileSync(firstNew, 'utf8'), /2019-10-01 미네 대화 학교 이야기 녹음/);
  assert.match(readFileSync(firstNew, 'utf8'), /\[\[20_Records\/23_Conversations\/2019\/2019-09-28 미네 노래 산토끼 부르기 녹음\]\]/);
  assert.match(readFileSync(secondNew, 'utf8'), /2019-09-28 미네 노래 산토끼 부르기 녹음/);
  assert.equal(writes.filter((path) => path === firstNew).length, 1);
  assert.equal(writes.filter((path) => path === secondNew).length, 1);
  assert.equal(writes.filter((path) => path === f.indexPath).length, 1);
  assert.equal(writes.filter((path) => path.endsWith('rename-log.jsonl')).length, 0);
});

test('링크 파일이 적용 중 바뀌면 외부 편집을 보존하고 개명을 복구한다', async () => {
  const f = fixture();
  const proposal = await proposeRecordings({ ...f, judge: async () => '[]', cooldown: () => false });
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: proposal.proposal.hash,
    rows: [{ id: f.id, date: '2019-09-28', newName: '2019-09-28 미네 노래 산토끼 부르기', skip: false }] }));
  const { writeAtomic } = await import('../lib/state-writer.mjs');
  const originalWiki = readFileSync(f.wiki, 'utf8');
  const result = await applyRecordings({ ...f, answersPath, proposalPath: proposal.path,
    rules: [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, required: { bundle: [], extra: [] } },
      { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, required: { bundle: [], extra: [] } }],
    write: (path, content) => {
      writeAtomic(path, content);
      if (path.endsWith('산토끼 부르기 녹음.md')) writeFileSync(f.wiki, `${originalWiki}\n외부 편집`);
    } });
  assert.match(result.failed[0].error, /링크 파일이 적용 중 변경됨/);
  assert.match(readFileSync(f.wiki, 'utf8'), /외부 편집/);
  assert.equal(existsSync(f.archive), true);
});

test('복구 도중 링크에 외부 편집이 있으면 덮지 않고 미완료 기록을 남긴다', async () => {
  const f = fixture();
  const extra = join(f.root, '30_Wiki/34_Topics/후속 기록.md');
  writeFileSync(extra, readFileSync(f.wiki, 'utf8'));
  const proposal = await proposeRecordings({ ...f, judge: async () => '[]', cooldown: () => false });
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: proposal.proposal.hash,
    rows: [{ id: f.id, date: '2019-09-28', newName: '2019-09-28 미네 노래 산토끼 부르기', skip: false }] }));
  const { writeAtomic } = await import('../lib/state-writer.mjs');
  const result = await applyRecordings({ ...f, answersPath, proposalPath: proposal.path,
    rules: [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, required: { bundle: [], extra: [] } },
      { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, required: { bundle: [], extra: [] } }],
    write: (path, content) => {
      if (path === extra) throw new Error('두 번째 링크 쓰기 실패');
      writeAtomic(path, content);
      if (path === f.wiki) writeFileSync(path, `${content}\n외부 편집`);
    } });
  assert.match(result.failed[0].rollbackErrors.join(' '), /외부에서 변경됨/);
  assert.match(readFileSync(f.wiki, 'utf8'), /외부 편집/);
  assert.doesNotMatch(readFileSync(join(f.root, VAULT_REL.mediaRenameLog), 'utf8'), /"stage":"rolled-back"/);
});

test('dry-run도 해시·쓰기 관문을 검사하고 URL 인코딩 링크를 경고한다', async () => {
  const f = fixture();
  const proposal = await proposeRecordings({ ...f, judge: async () => '[]', cooldown: () => false });
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: proposal.proposal.hash,
    rows: [{ id: f.id, date: '2019-09-28', newName: '2019-09-28 미네 노래 산토끼 부르기', skip: false }] }));
  const encoded = encodeURIComponent(f.noteRel);
  writeFileSync(f.wiki, `---\ntype: "topic"\n---\n[녹음](${encoded})`);
  const rules = [{ type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, required: { bundle: [], extra: [] } },
    { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, required: { bundle: [], extra: [] } }];
  const preview = await applyRecordings({ ...f, answersPath, proposalPath: proposal.path, dryRun: true, rules });
  assert.equal(preview.changed[0].newNotePath.endsWith('2019-09-28 미네 노래 산토끼 부르기 녹음.md'), true);
  assert.equal(preview.changed[0].linkCount, 0);
  assert.deepEqual(preview.changed[0].suspiciousLinks, [f.wiki.slice(f.root.length + 1)]);
  writeFileSync(f.archive, 'corrupted');
  const failed = await applyRecordings({ ...f, answersPath, proposalPath: proposal.path, dryRun: true, rules });
  assert.match(failed.failed[0].error, /해시 불일치/);
  assert.equal(failed.changed.length, 0);
});

test('날짜가 그대로면 전사 원본을 다시 쓰지 않는다', async () => {
  const f = fixture();
  const proposal = await proposeRecordings({ ...f, judge: async () => '[]', cooldown: () => false });
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: proposal.proposal.hash,
    rows: [{ id: f.id, date: '2019-10-01', newName: '2019-10-01 미네 대화 내용 확인', skip: false }] }));
  const writes = [];
  const { writeAtomic } = await import('../lib/state-writer.mjs');
  const result = await applyRecordings({ ...f, answersPath, proposalPath: proposal.path, rules: [
    { type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, required: { bundle: [], extra: [] } },
    { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, required: { bundle: [], extra: [] } },
  ], write: (path, content) => { writes.push(path); writeAtomic(path, content); } });
  assert.deepEqual(result.failed, []);
  assert.equal(writes.includes(f.transcript), false);
});

test('노트 오너 영역의 원래 원본 경로는 개명 후에도 그대로 남는다', async () => {
  const f = fixture();
  const ownerLine = `\n오너 메모 원본: Archive/2019/10/Recordings/0928 song.m4a\n`;
  writeFileSync(f.note, `${readFileSync(f.note, 'utf8')}${ownerLine}`);
  const proposal = await proposeRecordings({ ...f, judge: async () => '[]', cooldown: () => false });
  const answersPath = join(f.out, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ proposalHash: proposal.proposal.hash,
    rows: [{ id: f.id, date: '2019-09-28', newName: '2019-09-28 미네 노래 산토끼 부르기', skip: false }] }));
  const result = await applyRecordings({ ...f, answersPath, proposalPath: proposal.path, rules: [
    { type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, required: { bundle: [], extra: [] } },
    { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, required: { bundle: [], extra: [] } },
  ] });
  assert.deepEqual(result.failed, []);
  const next = readFileSync(join(f.root, result.changed[0].newNotePath), 'utf8');
  assert.match(next, /원본: Archive\/2019\/09\/Recordings\/2019-09-28 미네 노래 산토끼 부르기\.m4a/);
  assert.equal(next.slice(next.indexOf('<!-- media-transcribe:end -->') + '<!-- media-transcribe:end -->'.length).endsWith(ownerLine), true);
});

test('복구 중 Archive 또는 전사 원본이 외부에서 바뀌면 덮지 않고 미완료로 남긴다', async () => {
  const { writeAtomic } = await import('../lib/state-writer.mjs');
  for (const changedFile of ['archive', 'transcript']) {
    const f = fixture();
    const proposal = await proposeRecordings({ ...f, judge: async () => '[]', cooldown: () => false });
    const answersPath = join(f.out, 'answers.json');
    writeFileSync(answersPath, JSON.stringify({ proposalHash: proposal.proposal.hash,
      rows: [{ id: f.id, date: '2020-01-02', newName: '2020-01-02 미네 노래 산토끼 부르기', skip: false }] }));
    const targetArchive = join(f.mediaRoot, 'Archive/2020/01/Recordings/2020-01-02 미네 노래 산토끼 부르기.m4a');
    const targetTranscript = join(f.root, VAULT_REL.mediaTranscripts, '2020', `${f.id}.json`);
    const result = await applyRecordings({ ...f, answersPath, proposalPath: proposal.path, rules: [
      { type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, required: { bundle: [], extra: [] } },
      { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, required: { bundle: [], extra: [] } },
    ], write: (path, content) => {
      if (path === f.wiki) {
        writeFileSync(changedFile === 'archive' ? targetArchive : targetTranscript, 'external edit');
        throw new Error('링크 쓰기 주입 실패');
      }
      writeAtomic(path, content);
    } });
    assert.match(result.failed[0].rollbackErrors.join(' '), /외부에서 변경됨/, changedFile);
    assert.equal(readFileSync(changedFile === 'archive' ? targetArchive : targetTranscript, 'utf8'), 'external edit');
    assert.doesNotMatch(readFileSync(join(f.root, VAULT_REL.mediaRenameLog), 'utf8'), /"stage":"rolled-back"/);
  }
});

test('건별 검증 중 Archive 또는 전사가 바뀌면 복구하지 않고 다음 행도 멈춘다', async () => {
  for (const changedFile of ['archive', 'transcript']) {
    const f = fixture();
    const secondContent = 'second pending recording';
    const secondId = createHash('sha256').update(secondContent).digest('hex').slice(0, 16);
    const secondInbox = join(f.mediaRoot, 'Inbox/Recordings/second.m4a');
    const secondArchiveRel = 'Archive/2019/10/Recordings/second.m4a';
    writeFileSync(secondInbox, secondContent);
    linkSync(secondInbox, join(f.mediaRoot, secondArchiveRel));
    const firstRecord = JSON.parse(readFileSync(f.indexPath, 'utf8'));
    writeFileSync(f.indexPath, `${JSON.stringify(firstRecord)}\n${JSON.stringify({ ...firstRecord, id: secondId,
      inboxPath: 'Inbox/Recordings/second.m4a', archivePath: secondArchiveRel })}\n`);
    const proposal = await proposeRecordings({ ...f, judge: async () => '[]', cooldown: () => false });
    const answersPath = join(f.out, 'answers.json');
    writeFileSync(answersPath, JSON.stringify({ proposalHash: proposal.proposal.hash,
      rows: [{ id: f.id, date: '2020-01-02', newName: '2020-01-02 미네 노래 산토끼 부르기', skip: false },
        { id: secondId, date: '2019-10-01', newName: '2019-10-01 대화 두번째 녹음', skip: false }] }));
    const targetArchive = join(f.mediaRoot, 'Archive/2020/01/Recordings/2020-01-02 미네 노래 산토끼 부르기.m4a');
    const targetTranscript = join(f.root, VAULT_REL.mediaTranscripts, '2020', `${f.id}.json`);
    const result = await applyRecordings({ ...f, answersPath, proposalPath: proposal.path, rules: [
      { type: 'conversation', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/.*\.md$/, required: { bundle: [], extra: [] } },
      { type: 'topic', pathRegex: /^30_Wiki\/34_Topics\/.*\.md$/, required: { bundle: [], extra: [] } },
    ], append: (path, line) => {
      const event = JSON.parse(line);
      appendFileSync(path, line);
      const step = changedFile === 'archive' ? 'Archive 이동·색인 대기' : '전사 원본·노트 준비';
      if (event.step === step) {
        writeFileSync(changedFile === 'archive' ? targetArchive : targetTranscript, 'external edit');
        throw new Error('건별 단계 주입 실패');
      }
    } });
    assert.equal(result.changed.length, 0);
    assert.equal(existsSync(join(f.mediaRoot, secondArchiveRel)), true);
    assert.match(result.failed[0].rollbackErrors.join(' '), /외부에서 변경됨/, changedFile);
    assert.equal(readFileSync(changedFile === 'archive' ? targetArchive : targetTranscript, 'utf8'), 'external edit');
    assert.doesNotMatch(readFileSync(join(f.root, VAULT_REL.mediaRenameLog), 'utf8'), /"stage":"rolled-back"/);
  }
});
