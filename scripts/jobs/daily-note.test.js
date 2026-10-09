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
  const exists = () => true; // 이 테스트는 그날 노트가 이미 있는 경우(미리 만들기 없음)
  assert.deepEqual(planActions({ now: at('2026-10-10T14:30:00Z'), noteStatus: done, noteExists: exists }), [{ mode: 'draft', date: '2026-10-10' }]);
  assert.deepEqual(planActions({ now: at('2026-10-10T20:00:00Z'), noteStatus: none, noteExists: exists }), [{ mode: 'finalize', date: '2026-10-10' }]);
  assert.deepEqual(planActions({ now: at('2026-10-10T15:10:00Z'), noteStatus: none, noteExists: exists }), [{ mode: 'finalize', date: '2026-10-10' }]);
  assert.deepEqual(planActions({ now: at('2026-10-11T04:00:00Z'), noteStatus: done, noteExists: exists }), []);
  assert.deepEqual(planActions({ now: at('2026-10-10T08:59:00Z'), noteStatus: () => '초안', noteExists: exists }), [{ mode: 'finalize', date: '2026-10-09' }], '17:59 — 초안 시각 전');
  assert.deepEqual(planActions({ now: at('2026-10-10T09:00:00Z'), noteStatus: done, noteExists: exists }), [{ mode: 'draft', date: '2026-10-10' }], '18:00 정각');
  assert.deepEqual(planActions({ now: at('2026-10-09T14:30:00Z'), noteStatus: none, noteExists: exists }), [{ mode: 'draft', date: '2026-10-09' }], '시작일 이전은 자동 처리 안 함');
});

test('planActions: 18시 전 실행은 그날 노트가 없으면 미리 만든다(prepare), 있으면 안 만든다', () => {
  const none = () => null;
  const missing = () => false;
  assert.deepEqual(planActions({ now: at('2026-10-10T20:00:00Z'), noteStatus: none, noteExists: missing }),
    [{ mode: 'finalize', date: '2026-10-10' }, { mode: 'prepare', date: '2026-10-11' }], '05:00 — 어제 확정 + 오늘 미리 만들기');
  assert.deepEqual(planActions({ now: at('2026-10-10T20:00:00Z'), noteStatus: () => '확정', noteExists: (d) => d === '2026-10-11' }), []);
  assert.deepEqual(planActions({ now: at('2026-10-10T14:30:00Z'), noteStatus: () => '확정', noteExists: missing }),
    [{ mode: 'draft', date: '2026-10-10' }], '18시 이후는 초안이 바로 만든다');
  assert.deepEqual(planActions({ now: at('2026-10-07T20:00:00Z'), noteStatus: none, noteExists: missing }), [], '시작일(10-09) 이전은 미리 만들지 않음');
  assert.deepEqual(planActions({ mode: 'prepare', date: '2026-10-12' }), [{ mode: 'prepare', date: '2026-10-12' }]);
});

test('planActions: 명시 값 우선, 잘못된 값 거부', () => {
  assert.deepEqual(planActions({ mode: 'draft', date: '2026-10-01' }), [{ mode: 'draft', date: '2026-10-01' }]);
  assert.throws(() => planActions({ mode: 'x' }), /draft·finalize·prepare/);
  assert.throws(() => planActions({ mode: 'draft', date: '10/01' }), /형식 오류/);
  assert.throws(() => planActions({ mode: 'draft', date: '2026-02-30' }), /형식 오류/);
});

test('processDay: 노트당 텔레그램 1회, --no-send, 오너가 AI 칸을 고친 파일은 쓰지 않음', { skip: !existsSync(REG) }, async () => {
  try {
    mkdirSync(join(vault, '90_Delphi/Schema'), { recursive: true });
    copyFileSync(REG, join(vault, '90_Delphi/Schema/경로 등록부.md'));
    mkdirSync(join(vault, '20_Records/21_Notes/2026'), { recursive: true });
    writeFileSync(join(vault, '20_Records/21_Notes/2026/2026-10-10 메모.md'), '---\ntype: "note"\ncategory: ["[[01_Home/700 자산]]"]\ndescription: "d"\nsensitivity: "일반"\ncreated: "2026-10-10"\nmodified: "2026-10-10"\noccurred: "x"\norigin: "y"\n---\n본문');
    const rules = parseRegistry(readFileSync(REG, 'utf8'));
    const sent = [];
    const deps = { send: async (m) => { sent.push(m); }, fetchEvents: async () => null, summarize: async () => ({ summary: '- 요약', summaryStatus: 'ok', model: 'sonnet' }) };
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

    deps.fetchEvents = async () => [{ calendarId: 'a@example.com', calendar: '개인', title: '치과', start: '2026-10-10T10:00:00+09:00', end: '2026-10-10T11:00:00+09:00', allDay: false }];
    deps.readOwners = async () => [{ calendarId: 'a@example.com', owner: '나' }];
    await run({ mode: 'draft', noSend: true });
    assert.match(readFileSync(path, 'utf8'), /## 일정\n\*\*나\*\*\n- 10:00–11:00 치과/);
    deps.readOwners = async () => { throw new Error('owners offline'); };
    await run({ mode: 'draft', noSend: true });
    deps.fetchEvents = async () => { throw new Error('calendar offline'); };
    assert.equal((await run({ mode: 'finalize', noSend: true })).failed, true);
    assert.match(readFileSync(path, 'utf8'), /## 일정\n- 10:00–11:00 치과 · 개인/);
    assert.match(readFileSync(path, 'utf8'), /dailyStatus: "확정"/);
    assert.equal((await run({ mode: 'finalize', noSend: true, date: '2026-10-11' })).failed, true);
    const retryPath = join(vault, '10_Periodic/Daily/2026/2026-10-11.md');
    assert.match(readFileSync(retryPath, 'utf8'), /dailyStatus: "초안"/);
    assert.match(readFileSync(retryPath, 'utf8'), /캘린더 조회 실패/);
    assert.equal((await run({ mode: 'finalize', noSend: true, date: '2026-10-11', dryRun: true })).failed, true);

    writeFileSync(path, readFileSync(path, 'utf8').replace('- 요약', '- 오너가 고친 요약'));
    const before = readFileSync(path, 'utf8');
    assert.equal((await run({ mode: 'finalize' })).failed, true);
    assert.equal(readFileSync(path, 'utf8'), before, '오너가 고친 파일은 그대로');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('processDay prepare: 노트가 없을 때만 만들고, 요약 LLM·발송 없이 일정만 채우며 23:30 초안이 이어서 채운다', { skip: !existsSync(REG) }, async () => {
  mkdirSync(join(vault, '90_Delphi/Schema'), { recursive: true });
  copyFileSync(REG, join(vault, '90_Delphi/Schema/경로 등록부.md'));
  const rules = parseRegistry(readFileSync(REG, 'utf8'));
  const sent = [];
  let summarized = 0;
  const deps = { send: async (m) => { sent.push(m); }, fetchEvents: async () => [], summarize: async () => { summarized += 1; return { summary: '- 저녁 요약', summaryStatus: 'ok', model: 'sonnet' }; } };
  const path = join(vault, '10_Periodic/Daily/2026/2026-10-12.md');
  const run = (mode) => processDay({ mode, date: '2026-10-12', dryRun: false, noSend: false, rules, today: '2026-10-12', deps });
  assert.equal((await run('prepare')).failed, false);
  const prepared = readFileSync(path, 'utf8');
  assert.equal(summarized, 0, '미리 만들기는 LLM 요약을 부르지 않음');
  assert.equal(sent.length, 0, '미리 만들기는 발송하지 않음');
  assert.match(prepared, /dailyStatus: "초안"/);
  assert.match(prepared, /## 동선\n\(저녁 23:30에 채움\)/);
  assert.match(prepared, /## AI 하루 요약\n\(저녁 23:30에 채움\)/);
  assert.match(prepared, /## 일정\n\(일정 없음\)/);
  // 오너가 아침에 한 줄을 쓴 뒤 다시 prepare가 돌아도 건드리지 않는다.
  writeFileSync(path, prepared.replace(/## 오늘 한 줄\n[^\n]*/, '## 오늘 한 줄\n아침에 쓴 한 줄'));
  await run('prepare');
  assert.match(readFileSync(path, 'utf8'), /아침에 쓴 한 줄/);
  // 23:30 초안은 오너 글을 보존한 채 AI 칸을 채우고 발송한다.
  await run('draft');
  const drafted = readFileSync(path, 'utf8');
  assert.equal(summarized, 1);
  assert.equal(sent.length, 1);
  assert.match(drafted, /## 오늘 한 줄\n아침에 쓴 한 줄/);
  assert.match(drafted, /## AI 하루 요약\n- 저녁 요약/);
  assert.match(drafted, /sensitivity: "개인"/, '오너 글이 있으면 개인 등급');
});
