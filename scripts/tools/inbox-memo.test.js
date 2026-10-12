import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMemo, memoTitle, saveMemo } from './inbox-memo.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { toDayRecord } from '../lib/daily-note.mjs';

const now = new Date('2026-10-10T22:41:00Z'); // KST 10-11 07:41

test('memoTitle: KST 시각 + 첫 말, 금지 문자·이모지·줄바꿈 제거', () => {
  assert.equal(memoTitle('미네 어린이집 상담 #중요\n다음 주', now), '2026-10-11 0741 미네 어린이집 상담 중요 다음 주');
  assert.equal(memoTitle('📜', now), '2026-10-11 0741 메모');
  assert.equal(memoTitle('a/b:c', now), '2026-10-11 0741 a b c');
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
  assert.ok(content.endsWith('가상 메모\n둘째 줄\n\n(사진: 가상 풍경 — 원본 연결 대기)\n'));
  assert.equal(toDayRecord('00_Inbox/사진 메모.md', content, '2026-10-11').type, 'inbox');
  assert.ok(buildMemo('가상 메모', { now, kind: '사진메모' }).endsWith('가상 메모\n\n(사진 원본 연결 대기)\n'));
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
