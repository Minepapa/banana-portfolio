import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMemo, main, memoTitle, saveMemo, savePhotoMemo, saveVoiceMemo, updateVoiceMemo } from './inbox-memo.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { toDayRecord } from '../lib/daily-note.mjs';

const now = new Date('2026-10-10T22:41:00Z'); // KST 10-11 07:41

test('memoTitle: KST 시각 + 첫 말, 금지 문자·이모지·줄바꿈 제거', () => {
  assert.equal(memoTitle('미네 어린이집 상담 #중요\n다음 주', now), '2026-10-11 0741 미네 어린이집 상담 중요 다음 주');
  assert.equal(memoTitle('📜', now), '2026-10-11 0741 메모');
  assert.equal(memoTitle('a/b:c', now), '2026-10-11 0741 a b c');
  assert.equal(memoTitle('$& $$ 제목', now), '2026-10-11 0741 & 제목');
});

test('buildMemo: 원문 그대로, inbox·개인·KST created, 데일리 기록으로 잡힘', () => {
  const text = '첫 줄\n둘째 줄 — 그대로';
  const content = buildMemo(text, { now });
  const fm = parseFrontmatter(content);
  assert.equal(fm.type, 'inbox');
  assert.equal(fm.sensitivity, '개인');
  assert.equal(fm.origin, '텔레그램 📜');
  assert.equal(fm.created, '2026-10-11');
  assert.equal(fm.capturedAt, '2026-10-11T07:41+09:00');
  assert.equal(fm.attachment, undefined);
  assert.equal(parseFrontmatter(buildMemo('가상 메모', { now, attachment: '사진' })).attachment, undefined);
  assert.ok(content.endsWith('첫 줄\n둘째 줄 — 그대로\n'), '본문 원문 보존');
  const record = toDayRecord('00_Inbox/x.md', content, '2026-10-11');
  assert.equal(record.sensitivity, '개인');
  assert.throws(() => buildMemo('   ', { now }), /빈 메모/);
});

test('사진판독: 캡션과 판독을 보존하고 사진 제목·머리말을 쓴다', () => {
  const input = { kind: '사진판독', decoded: '주차 위치 B2\n구역 A', caption: '주차 기록\n둘째 줄' };
  const content = buildMemo(null, { now, ...input });
  const fm = parseFrontmatter(content);
  assert.equal(fm.origin, '텔레그램 사진');
  assert.equal(fm.attachment, '사진(파일 저장 안 함)');
  assert.ok(content.endsWith('## 캡션\n주차 기록\n둘째 줄\n\n## 판독\n주차 위치 B2\n구역 A\n'));
  assert.equal(toDayRecord('00_Inbox/사진.md', content, '2026-10-11').type, 'inbox');
  assert.match(saveMemo(input, { now, dryRun: true }), /^🖼️ 판독 기록함: 00_Inbox\/2026-10-11 0741 사진 주차 기록 둘째 줄 \(dry-run\)$/);
  const noCaption = { kind: '사진판독', decoded: '주차 위치 B2\n구역 A' };
  assert.ok(buildMemo(null, { now, ...noCaption }).endsWith('## 판독\n주차 위치 B2\n구역 A\n'));
  assert.match(saveMemo(noCaption, { now, dryRun: true }), /0741 사진 주차 위치 B2 \(dry-run\)$/);
  assert.match(saveMemo({ kind: '사진판독', decoded: '📷' }, { now, dryRun: true }), /0741 사진 \(dry-run\)$/);
  assert.throws(() => buildMemo(null, { now, kind: '사진판독', decoded: '   ' }), /빈 사진 판독/);
});

test('사진메모: 원문과 원본 연결 표시를 남긴다', () => {
  const content = buildMemo('가상 메모\n둘째 줄', { now, kind: '사진메모', photoDescription: '가상 풍경' });
  const fm = parseFrontmatter(content);
  assert.equal(fm.origin, '텔레그램 📎');
  assert.equal(fm.photoLink, '대기');
  assert.ok(content.endsWith('가상 메모\n둘째 줄\n\n(사진: 가상 풍경)\n'));
  assert.equal(toDayRecord('00_Inbox/사진 메모.md', content, '2026-10-11').type, 'inbox');
  assert.ok(buildMemo('가상 메모', { now, kind: '사진메모' }).endsWith('가상 메모\n\n(사진 첨부)\n'));
  assert.match(saveMemo({ kind: '사진메모', text: '가상 메모' }, { now, dryRun: true }), /^📎 기록함:/);
  assert.throws(() => buildMemo(' ', { now, kind: '사진메모' }), /빈 메모/);
});

test('알 수 없는 kind와 본문 전체 2만 자 초과는 거부한다', () => {
  assert.throws(() => saveMemo({ kind: '기타', text: '가상 메모' }, { now, dryRun: true }), /알 수 없는 kind/);
  assert.throws(() => buildMemo(null, { now, kind: '사진판독', decoded: '가'.repeat(20_000) }), /2만 자 이하/);
  assert.throws(() => buildMemo('가'.repeat(20_000), { now, kind: '사진메모' }), /2만 자 이하/);
});

test('saveMemo: 같은 분에 두 번 와도 덮어쓰지 않고, dry-run은 쓰지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
  assert.match(saveMemo({ text: '같은 메모' }, { now, dir, dryRun: true }), /dry-run/);
  assert.equal(readdirSync(dir).length, 0);
  saveMemo({ text: '같은 메모' }, { now, dir });
  const second = saveMemo({ text: '같은 메모' }, { now, dir });
  assert.match(second, /\(2\)$/);
  assert.deepEqual(readdirSync(dir).sort(), ['2026-10-11 0741 같은 메모 (2).md', '2026-10-11 0741 같은 메모.md']);
  assert.match(readFileSync(join(dir, '2026-10-11 0741 같은 메모.md'), 'utf8'), /같은 메모\n$/);
  const photo = { kind: '사진판독', decoded: '가상 표지' };
  saveMemo(photo, { now, dir });
  assert.match(saveMemo(photo, { now, dir }), /사진 가상 표지 \(2\)$/);
});

test('음성 메모는 가짜 전사 원문과 길이를 기록하고 원본 파일을 보존한다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-memo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const audioPath = join(dir, 'voice.oga');
  writeFileSync(audioPath, 'original audio bytes');
  const result = await saveVoiceMemo({ kind: '음성', audioPath, caption: '참고' }, { now, dir,
    probe: async () => 12.5, transcribeAudio: async () => ({ text: '내일 오후 세시 병원 예약', speech: true }), model: '/fake/large-v3.bin' });
  assert.equal(result.note, '00_Inbox/2026-10-11 0741 음성 내일 오후 세시 병원 예약.md');
  assert.equal(result.text, '내일 오후 세시 병원 예약');
  assert.equal(result.durationSec, 12.5);
  const content = readFileSync(join(dir, result.note.slice('00_Inbox/'.length)), 'utf8');
  const fields = parseFrontmatter(content);
  assert.equal(fields.kind, '음성');
  assert.equal(fields.voiceDurationSec, 12.5);
  assert.equal(fields.transcriptModel, 'large-v3.bin');
  assert.equal(fields.voiceConfirm, undefined);
  assert.ok(content.endsWith('## 캡션\n참고\n\n## 전사\n내일 오후 세시 병원 예약\n'));
  assert.equal(readFileSync(audioPath, 'utf8'), 'original audio bytes');
});

test('전사 실패·빈 음성은 노트를 만들고, 10분 초과는 기록하지 않는다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = { kind: '음성', audioPath: '/fake/voice.ogg' };
  const failed = await saveVoiceMemo(input, { now, dir, probe: async () => 5,
    transcribeAudio: async () => { throw new Error('Whisper unavailable'); } });
  assert.equal(failed.error, 'Whisper unavailable');
  assert.match(readFileSync(join(dir, failed.note.slice('00_Inbox/'.length)), 'utf8'), /## 전사\n\(전사 실패: Whisper unavailable\)/);
  const silent = await saveVoiceMemo(input, { now, dir, probe: async () => 4,
    transcribeAudio: async () => ({ text: '', speech: false }) });
  assert.equal(silent.text, '(음성 없음)');
  assert.equal(silent.error, '음성 없음');
  const hallucinated = await saveVoiceMemo(input, { now, dir, probe: async () => 4,
    transcribeAudio: async () => ({ text: '시청해주셔서 감사합니다', speech: false }) });
  assert.equal(hallucinated.text, '(음성 없음)');
  assert.equal(hallucinated.error, '음성 없음');
  assert.match(readFileSync(join(dir, hallucinated.note.slice('00_Inbox/'.length)), 'utf8'), /## 전사\n\(음성 없음\)/);
  const rangeFailure = await saveVoiceMemo(input, { now, dir, probe: async () => 4,
    transcribeAudio: async () => { throw new RangeError('Whisper buffer'); } });
  assert.equal(rangeFailure.error, 'Whisper buffer');
  const tooLong = await saveVoiceMemo(input, { now, dir, probe: async () => 600.1,
    transcribeAudio: async () => { throw new Error('should not transcribe'); } });
  assert.equal(tooLong.error, '음성 길이 10분 초과');
  assert.match(readFileSync(join(dir, tooLong.note.slice('00_Inbox/'.length)), 'utf8'), /전사 실패/);
  const longError = await saveVoiceMemo(input, { now, dir, probe: async () => 2,
    transcribeAudio: async () => { throw new Error(`${'x'.repeat(250)}\n/private/secret stderr`); } });
  assert.equal(longError.error.length, 200);
  assert.doesNotMatch(readFileSync(join(dir, longError.note.slice('00_Inbox/'.length)), 'utf8'), /private\/secret/);
  assert.equal(parseFrontmatter(readFileSync(join(dir, longError.note.slice('00_Inbox/'.length)), 'utf8')).transcriptModel, undefined);
  const commandError = await saveVoiceMemo(input, { now, dir, probe: async () => 2,
    transcribeAudio: async () => {
      const failure = new Error('Command failed: /opt/homebrew/bin/whisper-cli -m /Users/private/model.bin\nsecret stderr');
      failure.cmd = '/opt/homebrew/bin/whisper-cli -m /Users/private/model.bin';
      failure.stderr = 'secret stderr';
      throw failure;
    } });
  assert.equal(commandError.error, '전사 명령 실행 실패');
  const commandNote = readFileSync(join(dir, commandError.note.slice('00_Inbox/'.length)), 'utf8');
  assert.match(commandNote, /전사 실패: 전사 명령 실행 실패/);
  assert.doesNotMatch(commandNote, /whisper-cli|model\.bin|secret stderr/);
});

test('음성 CLI는 한 줄 안내 뒤 JSON을 내고 --json-out은 JSON만 낸다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-json-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines = [];
  const options = { input: () => JSON.stringify({ kind: '음성', audioPath: '/fake/voice.m4a' }), output: (line) => lines.push(line),
    voiceOptions: { now, dir, probe: async () => 2, transcribeAudio: async () => ({ text: '회의', speech: true }), model: 'fake' } };
  await main(['--json=-'], options);
  assert.match(lines[0], /기록함/);
  assert.deepEqual(JSON.parse(lines[1]), { note: '00_Inbox/2026-10-11 0741 음성 회의.md', text: '회의', durationSec: 2 });
  lines.length = 0;
  await main(['--json=-', '--json-out'], options);
  assert.equal(lines.length, 1);
  assert.match(JSON.parse(lines[0]).note, /음성 회의 \(2\)\.md$/);
});

test('음성 노트 확인 3종과 정정 누적; 경로 탈출과 다른 kind 거부', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-update-'));
  try {
    const label = saveMemo({ kind: '음성', text: '원래 전사', voiceDurationSec: 3, transcriptModel: 'fake' }, { now, dir });
    const note = `${label.split('00_Inbox/')[1]}.md`;
    const path = join(dir, note);
    for (const [value, expected] of Object.entries({ 등록: '등록', 미등록: '미등록', 확인대기미등록: '확인 대기 → 미등록' })) {
      await updateVoiceMemo({ note: `00_Inbox/${note}`, confirm: value }, { now, dir });
      const fields = parseFrontmatter(readFileSync(path, 'utf8'));
      assert.equal(fields.voiceConfirm, expected);
      assert.equal(fields.voiceConfirmAt, '2026-10-11T07:41:00+09:00');
    }
    await updateVoiceMemo({ note: `00_Inbox/${note}`, correction: '네시로 수정' }, { dir });
    await updateVoiceMemo({ note: `00_Inbox/${note}`, correction: '다음 주로 수정' }, { dir });
    assert.match(readFileSync(path, 'utf8'), /## 전사\n원래 전사\n정정: 네시로 수정\n정정: 다음 주로 수정\n$/);
    await assert.rejects(() => updateVoiceMemo({ note: '00_Inbox/../outside.md', confirm: '등록' }, { dir }), /경로 오류/);
    await assert.rejects(() => updateVoiceMemo({ note: '20_Records/voice.md', confirm: '등록' }, { dir }), /경로 오류/);
    const other = saveMemo({ text: '일반 메모' }, { now, dir }).split('00_Inbox/')[1];
    await assert.rejects(() => updateVoiceMemo({ note: `00_Inbox/${other}.md`, confirm: '등록' }, { dir }), /음성 노트가 아님/);
    await assert.rejects(() => updateVoiceMemo({ note: '00_Inbox/moved.md', confirm: '등록' }, { dir }), /이미 정리됨\(클리오가 옮김\)/);
    const lines = [];
    await assert.rejects(() => main(['--note=00_Inbox/moved.md', '--confirm=등록'],
      { output: (line) => lines.push(line), updateOptions: { dir } }), /이미 정리됨\(클리오가 옮김\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('사진메모는 photoPath가 있을 때만 지문과 30일 만료를 남기고 사진을 복사하지 않는다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'photo-memo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'notes');
  const printsPath = join(root, 'prints');
  const photoPath = join(root, 'telegram.jpg');
  writeFileSync(photoPath, 'telegram bytes');
  const input = { kind: '사진메모', text: '그때 웃었어', photoPath };
  const runner = async ([request]) => {
    assert.equal(request.path, photoPath);
    assert.equal(request.kind, 'image');
    writeFileSync(request.printPath, Buffer.alloc(8));
    return { lines: [JSON.stringify({ id: request.id, printDims: 2, labels: [{ name: 'smile' }] })] };
  };
  await savePhotoMemo(input, { now, dir, printsPath, runner });
  const first = parseFrontmatter(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
  assert.match(first.photoPrint, /^memo-/);
  assert.equal(first.photoMatchUntil, '2026-11-10');
  assert.equal(first.photoLink, '대기');
  assert.equal(readFileSync(photoPath, 'utf8'), 'telegram bytes');
  assert.equal(readdirSync(printsPath).length, 1);
  const missingLogs = [];
  await savePhotoMemo({ kind: '사진메모', text: '경로 없음' }, { now, dir, printsPath,
    output: { log: (line) => missingLogs.push(line) }, runner: async () => { throw Error('호출 금지'); } });
  const noPhoto = readFileSync(join(dir, readdirSync(dir).find((name) => name.includes('경로 없음'))), 'utf8');
  assert.equal(parseFrontmatter(noPhoto).photoPrint, undefined);
  assert.equal(parseFrontmatter(noPhoto).photoLink, '대기');
  assert.equal(parseFrontmatter(noPhoto).photoMatchUntil, '2026-11-10');
  assert.deepEqual(missingLogs, ['[inbox-memo] 사진 경로 없음: 원본 연결 대기']);
  const logs = [];
  await savePhotoMemo({ ...input, text: '분석 실패' }, { now, dir, printsPath, output: { log: (line) => logs.push(line) },
    runner: async () => ({ lines: [{ id: 'wrong', error: 'bad image' }] }) });
  const failed = readFileSync(join(dir, readdirSync(dir).find((name) => name.includes('분석 실패'))), 'utf8');
  assert.equal(parseFrontmatter(failed).photoPrint, undefined);
  assert.equal(logs.length, 1);
  assert.equal(readdirSync(printsPath).length, 1);
});
