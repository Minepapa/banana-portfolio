import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 볼트에서 돌린다 — 텔레그램은 가짜 발송 함수로만(실제 발송 금지).
const vault = mkdtempSync(join(tmpdir(), 'daily-note-'));
process.env.VAULT_PATH = vault;
const REG = '/Users/huinique/Pantheon/Mouseion/90_Delphi/Schema/경로 등록부.md';
const { planActions, processDay } = await import('./daily-note.mjs');
const { parseRegistry } = await import('../lib/vault-registry.mjs');
const { existsSync } = await import('node:fs');

const at = (iso) => new Date(iso);

test('planActions: 23:30은 (어제 확정 안 됐으면 확정) + 오늘 초안, 05:00은 어제 확정, 늦은 실행도 꼬이지 않음', () => {
  const none = () => null;
  const done = () => '확정';
  assert.deepEqual(planActions({ now: at('2026-10-10T14:30:00Z'), noteStatus: done }), [{ mode: 'draft', date: '2026-10-10' }]);
  assert.deepEqual(planActions({ now: at('2026-10-10T20:00:00Z'), noteStatus: none }), [{ mode: 'finalize', date: '2026-10-10' }]);
  assert.deepEqual(planActions({ now: at('2026-10-10T15:10:00Z'), noteStatus: none }), [{ mode: 'finalize', date: '2026-10-10' }]);
  assert.deepEqual(planActions({ now: at('2026-10-11T04:00:00Z'), noteStatus: done }), []);
  assert.deepEqual(planActions({ now: at('2026-10-10T08:59:00Z'), noteStatus: () => '초안' }), [{ mode: 'finalize', date: '2026-10-09' }], '17:59 — 초안 시각 전');
  assert.deepEqual(planActions({ now: at('2026-10-10T09:00:00Z'), noteStatus: done }), [{ mode: 'draft', date: '2026-10-10' }], '18:00 정각');
  assert.deepEqual(planActions({ now: at('2026-10-09T14:30:00Z'), noteStatus: none }), [{ mode: 'draft', date: '2026-10-09' }], '시작일 이전은 자동 처리 안 함');
});

test('planActions: 명시 값 우선, 잘못된 값 거부', () => {
  assert.deepEqual(planActions({ mode: 'draft', date: '2026-10-01' }), [{ mode: 'draft', date: '2026-10-01' }]);
  assert.throws(() => planActions({ mode: 'x' }), /draft 또는 finalize/);
  assert.throws(() => planActions({ mode: 'draft', date: '10/01' }), /형식 오류/);
});

test('processDay: 노트당 텔레그램 1회, --no-send, 오너가 AI 칸을 고친 파일은 쓰지 않음', { skip: !existsSync(REG) }, async () => {
  try {
    mkdirSync(join(vault, '90_Delphi/Schema'), { recursive: true });
    copyFileSync(REG, join(vault, '90_Delphi/Schema/경로 등록부.md'));
    mkdirSync(join(vault, '20_Records/21_Notes/2026'), { recursive: true });
    writeFileSync(join(vault, '20_Records/21_Notes/2026/2026-10-10 메모.md'), '---\ntype: "note"\ncategory: ["[[01_Home/700 자산]]"]\ndescription: "d"\nsensitivity: "일반"\ncreated: "2026-10-10"\nmodified: "2026-10-10"\noccurred: "x"\norigin: "y"\n---\n본문');
    const rules = parseRegistry(readFileSync(REG, 'utf8'));
    const sent = [];
    const deps = { send: async (m) => { sent.push(m); }, summarize: async () => ({ summary: '- 요약', summaryStatus: 'ok', model: 'sonnet' }) };
    const run = (extra = {}) => processDay({ mode: 'draft', date: '2026-10-10', dryRun: false, noSend: false, rules, today: '2026-10-10', deps, ...extra });
    const path = join(vault, '10_Periodic/Daily/2026/2026-10-10.md');

    assert.equal((await run({ noSend: true })).failed, false);
    assert.equal(sent.length, 0, '--no-send는 보내지 않음');
    assert.doesNotMatch(readFileSync(path, 'utf8'), /telegramSentAt/);
    await run();
    assert.equal(sent.length, 1);
    assert.match(readFileSync(path, 'utf8'), /telegramSentAt: "/);
    await run({ mode: 'finalize' });
    assert.equal(sent.length, 1, '이미 보낸 노트는 확정 때 다시 보내지 않음');
    assert.match(readFileSync(path, 'utf8'), /dailyStatus: "확정"/);

    writeFileSync(path, readFileSync(path, 'utf8').replace('- 요약', '- 오너가 고친 요약'));
    const before = readFileSync(path, 'utf8');
    assert.equal((await run({ mode: 'finalize' })).failed, true);
    assert.equal(readFileSync(path, 'utf8'), before, '오너가 고친 파일은 그대로');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
