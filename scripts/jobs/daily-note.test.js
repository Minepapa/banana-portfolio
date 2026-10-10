import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 볼트에서 돌린다 — 텔레그램은 가짜 발송 함수로만(실제 발송 금지).
const vault = mkdtempSync(join(tmpdir(), 'daily-note-'));
process.env.VAULT_PATH = vault;
const { planActions, processDay, recomputeDailyRoute, recomputeRecentRoutes, routeHashOf, dailyWorkFailed } = await import('./daily-note.mjs');
const { renderDailyNote, inspectExisting } = await import('../lib/daily-note.mjs');
const { VAULT_REL } = await import('../lib/vault-paths.mjs');
const rules = [{ type: 'daily', path: '10_Periodic/Daily/{YYYY}/YYYY-MM-DD.md',
  pathRegex: /^10_Periodic\/Daily\/\d{4}\/\d{4}-\d{2}-\d{2}\.md$/,
  titleRegex: /^\d{4}-\d{2}-\d{2}$/,
  required: { bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'], extra: [] } }];

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

test('processDay: 노트당 텔레그램 1회, --no-send, 오너가 AI 칸을 고친 파일은 쓰지 않음', async () => {
  try {
    mkdirSync(join(vault, '20_Records/21_Notes/2026'), { recursive: true });
    writeFileSync(join(vault, '20_Records/21_Notes/2026/2026-10-10 메모.md'), '---\ntype: "note"\ncategory: ["[[01_Home/700 자산]]"]\ndescription: "d"\nsensitivity: "일반"\ncreated: "2026-10-10"\nmodified: "2026-10-10"\noccurred: "x"\norigin: "y"\n---\n본문');
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

test('processDay prepare: 노트가 없을 때만 만들고, 요약 LLM·발송 없이 일정만 채우며 23:30 초안이 이어서 채운다', async (t) => {
  mkdirSync(vault, { recursive: true });
  t.after(() => rmSync(vault, { recursive: true, force: true }));
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
  assert.match(prepared, /## 오늘 생긴 할 일\n\(저녁 23:30에 채움\)/);
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
  assert.match(drafted, /## 오늘 생긴 할 일\n\(오늘 생긴 할 일 없음\)/);
  assert.match(drafted, /sensitivity: "개인"/, '오너 글이 있으면 개인 등급');
});

test('오늘 등록 기록은 데일리 AI 칸만 채우고 개인 등급을 만든다; 읽기 실패에도 계속한다', async (t) => {
  mkdirSync(vault, { recursive: true });
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  const date = '2026-10-16';
  const path = join(vault, '10_Periodic/Daily/2026', `${date}.md`);
  const records = [
    { kind: 'task', id: 'a', title: '제목 ## 보존', when: '2026-10-14' },
    { kind: 'event', id: 'b', title: '진료', when: '2026-10-14T15:00:00+09:00' },
  ];
  const deps = { summarize: async (_date, promptRecords) => { assert.deepEqual(promptRecords, []); return { summary: '- 요약', summaryStatus: 'ok', model: '없음' }; },
    fetchEvents: async () => [], readTodos: async () => records, send: async () => {} };
  const run = () => processDay({ mode: 'draft', date, dryRun: false, noSend: true, rules, today: date, deps });
  assert.equal((await run()).failed, false);
  const first = readFileSync(path, 'utf8');
  assert.match(first, /## 오늘 생긴 할 일\n- \[할 일\] 제목 \\#\\# 보존 \(기한 10\/14\)\n- \[일정\] 10\/14\(수\) 15:00 진료/);
  assert.match(first, /sensitivity: "개인"/);
  assert.equal(inspectExisting(first).ok, true);
  deps.readTodos = async () => { throw new Error('offline'); };
  assert.equal((await run()).failed, false);
  assert.match(readFileSync(path, 'utf8'), /## 오늘 생긴 할 일\n\(할 일 기록 읽기 실패/);
});

test('routeHash는 점 순서와 부가 속성에 영향받지 않고 좌표 변화는 감지한다', () => {
  const points = [{ tst: 2, lat: 0, lon: 1, acc: 20 }, { tst: 1, lat: 0, lon: 0 }];
  assert.equal(routeHashOf(points), routeHashOf([...points].reverse().map(({ tst, lat, lon }) => ({ tst, lat, lon }))));
  assert.notEqual(routeHashOf(points), routeHashOf([{ ...points[0], lon: 2 }, points[1]]));
});

test('위치 점 읽기가 실패해도 이전 지문을 지키며 노트 쓰기와 발송을 계속한다', async (t) => {
  mkdirSync(vault, { recursive: true });
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  const date = '2026-10-14';
  const path = join(vault, '10_Periodic/Daily/2026', `${date}.md`);
  mkdirSync(join(vault, '10_Periodic/Daily/2026'), { recursive: true });
  writeFileSync(path, renderDailyNote({ date, records: [], summary: '- 이전 요약', status: '초안', model: '없음',
    summaryStatus: 'ok', recordHash: 'old', routeHash: 'old-route', today: date, route: [] }));
  mkdirSync(join(vault, VAULT_REL.location, '2026', `${date}.jsonl`), { recursive: true });
  const sent = [];
  let computed = false;
  const result = await processDay({ mode: 'draft', date, dryRun: false, noSend: false, rules, today: date,
    deps: { summarize: async () => ({ summary: '- 새 요약', summaryStatus: 'ok', model: '없음' }),
      fetchEvents: async () => [], computeRoute: async () => { computed = true; return []; },
      send: async (message) => sent.push(message) } });
  assert.equal(result.failed, false);
  assert.equal(computed, false, '점 읽기 실패 후 계산하지 않음');
  assert.equal(sent.length, 1);
  const written = readFileSync(path, 'utf8');
  assert.match(written, /^routeHash: "old-route"$/m);
  assert.match(written, /## 동선\n\(동선 계산 실패/);
  assert.match(written, /## AI 하루 요약\n- 새 요약/);
  assert.match(written, /^telegramSentAt: /m);
});

test('지문이 다를 때 동선만 재계산하고 확정·발송·오너 글을 보존한다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'daily-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const date = '2026-10-10';
  const path = join(root, '10_Periodic/Daily/2026', `${date}.md`);
  mkdirSync(join(root, '10_Periodic/Daily/2026'), { recursive: true });
  mkdirSync(join(root, VAULT_REL.location), { recursive: true });
  const initial = renderDailyNote({ date, records: [], summary: '- 원래 요약', status: '확정', model: '없음',
    summaryStatus: 'ok', recordHash: 'record', routeHash: 'old', today: date,
    telegramSentAt: '2026-10-10T00:00:00Z', route: [] })
    .replace('## 오늘 한 줄\n<!-- 오너가 쓰는 칸. AI는 이 칸을 고치지 않는다. -->', '## 오늘 한 줄\n오너 원문')
    .replace('---\n\n# 2026', 'ownerKey: 값\n---\n\n# 2026');
  writeFileSync(path, initial);
  let computed = 0;
  let writes = 0;
  const deps = { computeRoute: async () => { computed += 1; return [{ start: '12:00', end: '12:30', label: '시험 장소' }]; },
    write: (file, note) => { writes += 1; writeFileSync(file, note); } };
  const changed = await recomputeDailyRoute({ date, root, deps });
  assert.equal(changed.updated, true);
  assert.equal(computed, 1);
  assert.equal(writes, 1);
  const next = readFileSync(path, 'utf8');
  assert.match(next, /## 동선\n- 12:00–12:30 시험 장소/);
  assert.match(next, /dailyStatus: "확정"/);
  assert.match(next, /telegramSentAt: "2026-10-10T00:00:00Z"/);
  assert.match(next, /ownerKey: 값/);
  assert.match(next, /## 오늘 한 줄\n오너 원문/);
  assert.match(next, /## AI 하루 요약\n- 원래 요약/);
  assert.equal(inspectExisting(next).ok, true);
  assert.equal((await recomputeDailyRoute({ date, root, deps })).updated, false);
  assert.equal(computed, 1, '같은 지문이면 체류도 다시 계산하지 않음');
  assert.equal(writes, 1);
  writeFileSync(path, next.replace('- 원래 요약', '- 오너가 수정한 요약'));
  const ownerEdited = readFileSync(path, 'utf8');
  assert.equal((await recomputeDailyRoute({ date, root, deps, force: true })).updated, false);
  assert.equal(readFileSync(path, 'utf8'), ownerEdited);
});

test('최근 7일에 이미 있는 노트만 재계산한다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'daily-route-week-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, VAULT_REL.location), { recursive: true });
  for (const date of ['2026-10-03', '2026-10-04']) {
    const directory = join(root, '10_Periodic/Daily/2026');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${date}.md`), renderDailyNote({ date, records: [], summary: '- 요약',
      status: '확정', model: '없음', summaryStatus: 'ok', recordHash: 'x', routeHash: 'old', today: date, route: [] }));
  }
  const computed = [];
  await recomputeRecentRoutes({ now: at('2026-10-10T03:00:00Z'), root,
    deps: { computeRoute: async (date) => { computed.push(date); return []; }, write: (path, note) => writeFileSync(path, note) } });
  assert.deepEqual(computed, ['2026-10-04']);
  assert.match(readFileSync(join(root, '10_Periodic/Daily/2026/2026-10-03.md'), 'utf8'), /routeHash: "old"/);
});

test('재계산은 위치 폴더 없음과 쓰기 전 삭제를 skip하고 dry-run은 날짜와 이유를 알린다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'daily-route-skip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const date = '2026-10-10';
  const path = join(root, '10_Periodic/Daily/2026', `${date}.md`);
  mkdirSync(join(root, '10_Periodic/Daily/2026'), { recursive: true });
  const original = renderDailyNote({ date, records: [], summary: '- 요약', status: '확정', model: '없음',
    summaryStatus: 'ok', recordHash: 'record', routeHash: 'old', today: date, route: [] });
  writeFileSync(path, original);
  assert.deepEqual(await recomputeDailyRoute({ date, root }), { updated: false, skipped: '위치 폴더 없음' });
  mkdirSync(join(root, VAULT_REL.location), { recursive: true });
  const deleted = await recomputeDailyRoute({ date, root, deps: { computeRoute: async () => { rmSync(path); return []; } } });
  assert.deepEqual(deleted, { updated: false, skipped: '노트 없음' });
  writeFileSync(path, original);
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(' '));
  try {
    const dry = await recomputeDailyRoute({ date, root, dryRun: true,
      deps: { computeRoute: async () => [{ start: '12:00', end: '12:30', label: '장소' }],
        write: () => assert.fail('dry-run은 쓰지 않음') } });
    assert.deepEqual(dry, { updated: false, dryRun: true });
  } finally { console.log = originalLog; }
  assert.match(logs.join('\n'), /2026-10-10.*위치 지문 변경/);
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('최근 7일 재계산 실패는 경고만 남기고 이후 날짜도 처리한다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'daily-route-warning-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, VAULT_REL.location), { recursive: true });
  for (const date of ['2026-10-10', '2026-10-09']) {
    const directory = join(root, '10_Periodic/Daily/2026');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${date}.md`), renderDailyNote({ date, records: [], summary: '- 요약',
      status: '확정', model: '없음', summaryStatus: 'ok', recordHash: 'x', routeHash: 'old', today: date, route: [] }));
  }
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => warnings.push(parts.join(' '));
  try {
    const results = await recomputeRecentRoutes({ now: at('2026-10-10T03:00:00Z'), root,
      deps: { computeRoute: async (date) => { if (date === '2026-10-10') throw new Error('address offline'); return []; },
        write: (path, note) => writeFileSync(path, note) } });
    assert.equal(results[0].failed, true);
    assert.equal(results[1].updated, true);
    assert.equal(dailyWorkFailed([{ failed: false }]), false, '7일 재계산 결과는 종료 코드 판정에서 제외');
    assert.equal(dailyWorkFailed([{ failed: true }]), true, '본 작업 실패는 종료 코드에 반영');
  } finally { console.warn = originalWarn; }
  assert.match(warnings.join('\n'), /동선 재계산 실패.*address offline/);
});
