import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VAULT_PATH = mkdtempSync(join(tmpdir(), 'owner-input-'));
const { addOwnerInput, targetDate } = await import('./daily-owner-input.mjs');
const { renderDailyNote, inspectExisting, setOwnerSection } = await import('../lib/daily-note.mjs');
const { parseRegistry } = await import('../lib/vault-registry.mjs');
const REG = '/Users/huinique/Pantheon/Mouseion/90_Delphi/Schema/경로 등록부.md';

const base = renderDailyNote({ date: '2026-10-10', records: [], summary: '- 요약', status: '초안', model: '없음', summaryStatus: 'empty', recordHash: 'h', today: '2026-10-10' });
const at = (iso) => new Date(iso);

test('setOwnerSection: 한 줄은 바꾸고 메모는 시각과 함께 쌓으며 AI 칸 지문은 그대로', () => {
  const one = setOwnerSection(base, { section: '오늘 한 줄', text: '첫 한 줄' });
  assert.match(one.content, /## 오늘 한 줄\n첫 한 줄\n\n## 일정/);
  assert.equal(one.previous, null);
  assert.equal(inspectExisting(one.content).prev.fields.aiHash, inspectExisting(base).prev.fields.aiHash);
  assert.match(one.content, /sensitivity: "개인"/);
  const two = setOwnerSection(one.content, { section: '오늘 한 줄', text: '바꾼 한 줄' });
  assert.equal(two.previous, '첫 한 줄');
  assert.doesNotMatch(two.content, /첫 한 줄/);
  const m1 = setOwnerSection(two.content, { section: '오너 메모', text: '메모 하나', time: '07:40' });
  const m2 = setOwnerSection(m1.content, { section: '오너 메모', text: '메모 둘', time: '08:10' });
  assert.match(m2.content, /## 오너 메모\n- 07:40 메모 하나\n- 08:10 메모 둘\n$/);
  assert.doesNotMatch(m2.content.split('## 오너 메모')[1], /오너가 쓰는 칸/);
  assert.ok(inspectExisting(m2.content).ok);
});

test('setOwnerSection: 줄바꿈·제목·코드 울타리로 칸 경계를 깨지 못한다', () => {
  const r = setOwnerSection(base, { section: '오늘 한 줄', text: '## 동선\n가짜' });
  assert.match(r.content, /## 오늘 한 줄\n\\## 동선 가짜\n/);
  assert.ok(inspectExisting(r.content).ok, 'AI 칸 지문 유지');
  const f = setOwnerSection(base, { section: '오늘 한 줄', text: '```js' });
  assert.match(f.content, /## 오늘 한 줄\n\\```js\n/);
  assert.throws(() => setOwnerSection(base, { section: '동선', text: 'x' }), /오너 칸이 아님/);
  assert.throws(() => setOwnerSection(base, { section: '오늘 한 줄', text: '   ' }), /빈 내용/);
  assert.throws(() => setOwnerSection('---\ntype: "note"\n---\n## 오늘 한 줄\n', { section: '오늘 한 줄', text: 'x' }), /데일리 노트가 아님/);
});

test('targetDate: KST 05시 전은 전날, 명시 날짜 검증', () => {
  assert.equal(targetDate(at('2026-10-10T19:59:00Z')), '2026-10-10', 'KST 10-11 04:59 → 전날');
  assert.equal(targetDate(at('2026-10-10T20:00:00Z')), '2026-10-11', 'KST 05:00 → 그날');
  assert.equal(targetDate(at('2026-10-10T14:30:00Z')), '2026-10-10', 'KST 23:30');
  assert.equal(targetDate(at('2026-10-10T00:00:00Z'), '2026-10-09'), '2026-10-09');
  assert.throws(() => targetDate(at('2026-10-10T00:00:00Z'), '2026-02-30'), /날짜 형식/);
});

test('addOwnerInput: 노트가 없으면 미리 만들고 쓰며, dry-run은 아무것도 쓰지 않는다', { skip: !existsSync(REG) }, async () => {
  const files = new Map();
  const io = { read: (p) => files.get(p) ?? null, write: (p, c) => files.set(p, c), rules: parseRegistry(readFileSync(REG, 'utf8')), pathOf: (d) => join(process.env.VAULT_PATH, '10_Periodic/Daily/2026', `${d}.md`) };
  let prepared = 0;
  const prepare = async (date) => { prepared += 1; files.set(io.pathOf(date), base.replaceAll('2026-10-10', date)); return { failed: false }; };
  const now = at('2026-10-10T22:40:00Z'); // KST 10-11 07:40
  assert.match(await addOwnerInput({ kind: '한줄', text: 'x' }, { ...io, prepare, now, dryRun: true }), /dry-run/);
  assert.equal(files.size, 0);
  assert.equal(prepared, 0);
  assert.equal(await addOwnerInput({ kind: '한줄', text: '좋은 날' }, { ...io, prepare, now }), '오늘 한 줄 저장(2026-10-11)');
  assert.equal(prepared, 1);
  assert.match(files.get(io.pathOf('2026-10-11')), /## 오늘 한 줄\n좋은 날\n/);
  await assert.rejects(addOwnerInput({ kind: '메모', text: 'x' }, { ...io, prepare, now }), /📜/, '메모는 📜 → Inbox 경로');
  assert.match(await addOwnerInput({ kind: '한줄', text: '더 좋은 날' }, { ...io, prepare, now }), /이전 한 줄을 바꿈/);
  await assert.rejects(addOwnerInput({ kind: '기타', text: 'x' }, { ...io, prepare, now }), /kind/);
});
