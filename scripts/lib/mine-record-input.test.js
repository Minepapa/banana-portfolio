import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faceBoxText, loadMineFaces, mineConversation } from './mine-record-input.mjs';

const note = (body, memo = '') => `---\ntype: "conversation"\n---\n<!-- media-transcribe:id 0123456789abcdef -->\n# 2026-10-15 통화\n\n### 0분 30초\n\n${body}\n\n원본: Archive/2026/a.m4a\n<!-- media-transcribe:end -->\n\n## 오너 메모\n${memo}\n`;

test('화자 표시 대화: 미네 말은 모두, 다른 화자는 미네 말 바로 앞 한 줄만, 경로·제목·오너 메모는 뺀다', () => {
  const result = mineConversation(note('나: 밥 먹었어?\n나: 오늘 학교 어땠어?\n미네: 재밌었어!\n휘영: 숙제는?\n나: 그래 잘했네\n미네: 응 끊어', '감정: 기쁨'));
  assert.equal(result.mode, 'mine');
  assert.equal(result.text, '### 0분 30초\n나: 오늘 학교 어땠어?\n미네: 재밌었어!\n나: 그래 잘했네\n미네: 응 끊어');
  assert.deepEqual([result.mineLines, result.contextLines, result.truncated], [2, 2, false]);
  assert.doesNotMatch(result.text, /원본|감정: 기쁨|# 2026/);
});

test('넘치면 맥락 줄부터 빼고, 그래도 넘치면 미네 말을 뒤에서 자른다', () => {
  const long = Array.from({ length: 80 }, (_, index) => `나: ${'질문'.repeat(20)}${index}\n미네: ${'대답'.repeat(20)}${index}`).join('\n');
  const result = mineConversation(note(long), { maxChars: 2000 });
  assert.equal(result.contextLines, 0);
  assert.equal(result.truncated, true);
  assert.match(result.text, /^### 0분 30초\n미네: /);
  assert.ok(result.text.endsWith('…(이하 생략)'));
  assert.ok(result.text.length <= 2000 + '…(이하 생략)'.length);
  const contextDropped = mineConversation(note('나: 긴 질문입니다\n미네: 응'), { maxChars: 20 });
  assert.equal(contextDropped.text, '### 0분 30초\n미네: 응');
});

test('화자 표시가 없으면 본문 전체(한 사람 녹음·화자 분리 전)', () => {
  const result = mineConversation(note('반짝반짝 작은 별\n아름답게 비치네'));
  assert.equal(result.mode, 'whole');
  assert.equal(result.text, '### 0분 30초\n반짝반짝 작은 별\n아름답게 비치네');
});

test('미네 얼굴 상자: 사진마다 점수가 가장 높은 미네 얼굴, 색인에 없거나 미네가 아니면 뺀다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mine-faces-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const matchesPath = join(dir, 'matches.jsonl');
  const indexPath = join(dir, 'faces-index.jsonl');
  writeFileSync(matchesPath, [
    { id: 'a', i: 0, score: 0.6, label: 'mine' }, { id: 'a', i: 1, score: 0.9, person: '미네' },
    { id: 'b', i: 0, score: 0.8, person: '휘영', label: 'mine' }, { id: 'c', i: 0, score: 0.7, person: '미네' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n{"id":"torn"');
  writeFileSync(indexPath, [
    { id: 'a', faces: [{ i: 0, bbox: [0, 0, 1, 1] }, { i: 1, bbox: [10, 20, 30, 40] }] },
    { id: 'b', faces: [{ i: 0, bbox: [0, 0, 5, 5] }] },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const faces = loadMineFaces({ matchesPath, indexPath });
  assert.deepEqual([...faces.keys()], ['a']);
  assert.deepEqual(faces.get('a'), { i: 1, score: 0.9, bbox: [10, 20, 30, 40] });
  assert.equal(loadMineFaces({ matchesPath, indexPath, ids: ['b'] }).size, 0);
});

test('얼굴 위치 글: 세운 원본 크기로 0~1 비율과 위치 말, 크기를 모르면 null', () => {
  assert.equal(faceBoxText([100, 100, 300, 400], { width: 3024, height: 4032 }), '미네 얼굴: 왼쪽 위 (가로 0.03~0.10, 세로 0.02~0.10, 사진 전체 0~1 기준)');
  assert.match(faceBoxText([1400, 1800, 1600, 2200], { width: 3024, height: 4032 }), /^미네 얼굴: 한가운데 /);
  assert.match(faceBoxText([1400, 100, 1600, 300], { width: 3024, height: 4032 }), /^미네 얼굴: 가운데 위 /);
  assert.match(faceBoxText([100, 1800, 300, 2200], { width: 3024, height: 4032 }), /^미네 얼굴: 왼쪽 중간 /);
  assert.match(faceBoxText([-50, 0, 5000, 100], { width: 3024, height: 4032 }), /가로 0\.00~1\.00/);
  assert.equal(faceBoxText([0, 0, 1, 1], undefined), null);
  assert.equal(faceBoxText([5, 5, 5, 9], { width: 10, height: 10 }), null);
});

test('구간마다 따로: 화자 분리된 구간은 미네 발화만, 안 된 구간은 전체, 화자 확인 표시는 남긴다', () => {
  const content = `---\ntype: "conversation"\n---\n# 2026-10-15 녹음 둘\n\n### 0분 30초\n\n${'[화자 확인 필요]'}\n나: 뭐 해?\n미네: 그림 그려\n나: 다른 말\n\n원본: Archive/a.m4a\n\n### 2분 10초\n\n반짝반짝 작은 별\n\n원본: Archive/b.m4a\n`;
  const result = mineConversation(content);
  assert.equal(result.mode, 'mixed');
  assert.equal(result.text, '### 0분 30초\n[화자 확인 필요]\n나: 뭐 해?\n미네: 그림 그려\n### 2분 10초\n반짝반짝 작은 별');
  assert.equal(result.mineLines, 1);
});
