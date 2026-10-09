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
  assert.equal(fm.created, '2026-10-11');
  assert.ok(content.endsWith('첫 줄\n둘째 줄 — 그대로\n'), '본문 원문 보존');
  const record = toDayRecord('00_Inbox/x.md', content, '2026-10-11');
  assert.equal(record.sensitivity, '개인');
  assert.throws(() => buildMemo('   ', { now }), /빈 메모/);
  assert.match(buildMemo('', { now, attachment: '사진' }), /첨부: 사진/);
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
});
