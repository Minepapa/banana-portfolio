import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { collectInbox, priorityOf, readWikiIndex, validateJudgment, run, telegramMessage,
  MAX_WIKI_TITLES_PER_FOLDER, MAX_WIKI_INDEX_CHARS, MAX_JOB_MS } from './clio-inbox-ingest.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';

const date = new Date('2026-10-10T20:00:00Z');
const rules = [
  { type: 'note', path: '20_Records/21_Notes/{YYYY}/', pathRegex: /^20_Records\/21_Notes\/\d{4}\/[^/]+\.md$/, titleRegex: /^\d{4}-\d{2}-\d{2} \S/,
    required: { bundle: ['type', 'category', 'description', 'sensitivity', 'created', 'modified'], extra: ['occurred', 'origin'] } },
  { type: 'agent-log', path: '60_Logs/Clio/', pathRegex: /^60_Logs\/Clio\/\d{4}-\d{2}\.md$/, titleRegex: /^\d{4}-\d{2}$/,
    required: { bundle: ['type', 'description', 'created', 'modified'], extra: ['agent'] } },
];
const judgment = () => ({ target: { folder: '20_Records/21_Notes/2026', type: 'note', title: '2026-10-11 가상 메모' },
  frontmatter: { category: '201', description: '가상 기록', sensitivity: '일반', occurred: '2026-10-11', origin: '테스트' },
  extracted: { people: [], places: [], topics: ['가상 주제'], objects: [], dates: [], todos: [], decisions: [] },
  wiki: [], dailyLink: '2026-10-11', unclassifiable: null });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'clio-ingest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel, content) => { const path = join(root, rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  return { root, put };
}
const memo = (origin, body) => `---\norigin: "${origin}"\n---\n${body}`;

test('priority and both item/character caps; unchanged hashes are skipped, changed content is planned', (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/a.md', memo('외부', '링크'));
  put('00_Inbox/b.md', memo('텔레그램 📜', '오너 가상 메모'));
  put('00_Inbox/c.md', memo('대화', '가상 대화'));
  assert.equal(priorityOf(memo('미네', '기록')), 0);
  assert.equal(priorityOf(memo('옵시디언', '직접 메모')), 1);
  assert.equal(priorityOf(memo('사진', '사진')), 3);
  assert.equal(collectInbox(root, { maxItems: 2 }).selected.map((x) => x.source).join(','), '00_Inbox/b.md,00_Inbox/c.md');
  const first = collectInbox(root, { maxChars: memo('텔레그램 📜', '오너 가상 메모').length });
  assert.equal(first.selected.length, 1);
  assert.equal(first.remaining, 2);
  put(VAULT_REL.inboxIngestProcessed, JSON.stringify({ '00_Inbox/b.md': first.selected[0].hash }));
  assert.equal(collectInbox(root).selected.length, 2);
  put('00_Inbox/b.md', memo('텔레그램 📜', '고친 가상 메모'));
  assert.equal(collectInbox(root).selected.length, 3);
  put('00_Inbox/d.md', memo('텔레그램 📜', '고친 가상 메모'));
  assert.equal(collectInbox(root).selected.length, 3);
  assert.equal(collectInbox(root, { maxChars: 1 }).selected.length, 0);
});

test('oversized memo is reported without sending its content to the judge or counting as remaining', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/large.md', memo('옵시디언', '가상 메모'.repeat(20)));
  let calls = 0;
  const result = await run({ root, rules, now: date, maxChars: 20, dryRun: true,
    judge: async () => { calls += 1; return judgment(); }, charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false });
  assert.equal(calls, 0);
  assert.equal(result.remaining, 0);
  assert.match(result.report, /입력 글자 수 상한/);
});

test('partial plan write recovers report on rerun and preserves owner text', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('옵시디언', '복구할 기록'));
  const messages = [];
  const deps = { root, rules, now: date, charter: { model: 'test', systemPrompt: 'test' },
    cooldown: () => false, judge: async () => judgment(), send: async (message) => { messages.push(message); } };
  await assert.rejects(run({ ...deps, write: (path, content) => {
    if (path.endsWith('.md')) throw new Error('보고서 쓰기 장애');
    writeAtomic(path, content);
  } }), /보고서 쓰기 장애/);
  assert.equal(messages.length, 0);
  await run({ ...deps, dryRun: true });
  assert.equal(messages.length, 0);
  const first = await run(deps);
  assert.equal(first.sent, true);
  assert.equal(messages.length, 1);
  await run(deps);
  assert.equal(messages.length, 1);
  assert.match(first.report, /복구할 기록|00_Inbox\/memo.md/);
  put(first.reportRel, readFileSync(join(root, first.reportRel), 'utf8').replace(
    '<!-- clio-inbox-ingest:2026-10-11:end -->', '    오너 복구 문장\n<!-- clio-inbox-ingest:2026-10-11:end -->'));
  put('00_Inbox/next.md', memo('옵시디언', '다음 기록'));
  const next = await run(deps);
  assert.match(next.report, /오너 복구 문장/);
  assert.equal(next.report.match(/## 2026-10-11 Inbox ingest 계획/g)?.length, 1);
});

test('plan write failure leaves report untouched and rerun succeeds', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('옵시디언', '계획 쓰기 장애'));
  const deps = { root, rules, now: date, noSend: true, charter: { model: 'test', systemPrompt: 'test' },
    cooldown: () => false, judge: async () => judgment() };
  await assert.rejects(run({ ...deps, write: (path, content) => {
    if (path.endsWith('.json')) throw new Error('계획 쓰기 장애');
    writeAtomic(path, content);
  } }), /계획 쓰기 장애/);
  assert.equal(existsSync(join(root, '60_Logs/Clio/2026-10.md')), false);
  const recovered = await run(deps);
  assert.equal(recovered.items[0].status, '계획함');
  assert.equal(existsSync(join(root, recovered.reportRel)), true);
});

test('same-day partial report write uses old section as owner-edit baseline', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/first.md', memo('옵시디언', '첫 기록'));
  const messages = [];
  const deps = { root, rules, now: date, charter: { model: 'test', systemPrompt: 'test' },
    cooldown: () => false, send: async (message) => { messages.push(message); },
    judge: async (_prompt, item) => ({ ...judgment(), target: { ...judgment().target,
      title: item.source.includes('second') ? '2026-10-11 둘째' : '2026-10-11 첫째' } }) };
  const first = await run(deps);
  assert.equal(messages.length, 1);
  put(first.reportRel, readFileSync(join(root, first.reportRel), 'utf8').replace(
    '<!-- clio-inbox-ingest:2026-10-11:end -->', '    오너가 추가한 문장\n<!-- clio-inbox-ingest:2026-10-11:end -->'));
  put('00_Inbox/second.md', memo('옵시디언', '둘째 기록'));
  await assert.rejects(run({ ...deps, write: (path, content) => {
    if (path.endsWith('.md')) throw new Error('보고서 쓰기 장애');
    writeAtomic(path, content);
  } }), /보고서 쓰기 장애/);
  assert.equal(messages.length, 1);
  const recovered = await run(deps);
  assert.equal(recovered.items.length, 0);
  assert.equal(messages.length, 2);
  assert.match(messages[1].body, /둘째/);
  assert.equal(messages[1].body.includes('첫째'), false);
  assert.match(recovered.report, /오너가 추가한 문장/);
  assert.equal(recovered.report.match(/### 00_Inbox\/first.md/g)?.length, 1);
  assert.equal(recovered.report.match(/### 00_Inbox\/second.md/g)?.length, 1);
  assert.equal(recovered.report.match(/### 오너 추가 기록/g)?.length, 1);
  assert.equal(recovered.report.match(/## 2026-10-11 Inbox ingest 계획/g)?.length, 1);
  await run(deps);
  assert.equal(messages.length, 2);
});

test('next-day run recovers prior report and sends only its pending new item', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('옵시디언', '전날 기록'));
  const messages = [];
  const deps = { root, rules, charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false,
    judge: async () => judgment(), send: async (message) => { messages.push(message); } };
  await assert.rejects(run({ ...deps, now: date, write: (path, content) => {
    if (path.endsWith('.md')) throw new Error('전날 보고서 장애');
    writeAtomic(path, content);
  } }), /전날 보고서 장애/);
  const nextDay = new Date('2026-10-11T20:00:00Z');
  const recovered = await run({ ...deps, now: nextDay });
  assert.equal(recovered.sent, true);
  assert.equal(messages.length, 1);
  assert.match(readFileSync(join(root, '60_Logs/Clio/2026-10.md'), 'utf8'), /## 2026-10-11 Inbox ingest 계획/);
  await run({ ...deps, now: nextDay });
  assert.equal(messages.length, 1);
});

test('intentional no-send does not become delayed notification', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('옵시디언', '발송 생략 기록'));
  let sends = 0;
  const deps = { root, rules, charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false,
    judge: async () => judgment(), send: async () => { sends += 1; } };
  await run({ ...deps, now: date, noSend: true });
  await run({ ...deps, now: new Date('2026-10-11T20:00:00Z') });
  assert.equal(sends, 0);
});

test('send is aborted within remaining job time', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('옵시디언', '가상 기록'));
  let elapsed = 0;
  let aborted = false;
  const result = await run({ root, rules, now: date, clock: () => elapsed, noSend: false,
    charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false,
    judge: async () => { elapsed = MAX_JOB_MS - 15; return judgment(); },
    send: async (_message, { signal }) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }) });
  assert.equal(result.written, true);
  assert.equal(result.sent, false);
  assert.equal(aborted, true);
});

test('judgment failure is retried once with validation error and reported for only that memo', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('옵시디언', '가상 원문'));
  let calls = 0;
  const prompts = [];
  const result = await run({ root, rules, now: date, dryRun: true,
    judge: async (prompt) => { calls += 1; prompts.push(prompt); return '{broken'; },
    charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false });
  assert.equal(calls, 2);
  assert.match(prompts[1], /직전 검증 오류/);
  assert.equal(result.items[0].status, '판단 실패');
  assert.equal(result.sent, false);
});

test('object people is rejected with its index and type, then corrected on retry', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('옵시디언', '가상 원문'));
  const prompts = [];
  const invalid = { ...judgment(), extracted: { ...judgment().extracted,
    people: [{ name: '가상 인물 A', relation: '딸' }] } };
  const result = await run({ root, rules, now: date, dryRun: true,
    judge: async (prompt) => { prompts.push(prompt); return prompts.length === 1 ? invalid : judgment(); },
    charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /extracted의 모든 값은 문자열 배열이며 객체를 넣지 마라/);
  assert.match(prompts[0], /frontmatter 값은 문자열·숫자·불리언 또는 그 배열만/);
  assert.match(prompts[1], /직전 검증 오류: 추출 스키마 위반: people\[0\]이 문자열이 아님\(object\)/);
  assert.equal(result.items[0].status, '계획함');
});

test('last invalid response preview is kept only in the plan item', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('옵시디언', '가상 원문'));
  const first = { ...judgment(), extracted: { ...judgment().extracted, people: [{ name: '가상 인물 A' }] } };
  const last = { ...judgment(), extracted: { ...judgment().extracted,
    people: [{ name: '가상 인물 B', relation: '딸', detail: '가'.repeat(600) }] } };
  let calls = 0;
  const result = await run({ root, rules, now: date, noSend: true,
    judge: async () => { calls += 1; return calls === 1 ? first : last; },
    charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false });
  const plan = JSON.parse(readFileSync(join(root, result.planRel), 'utf8'));
  assert.equal(calls, 2);
  assert.equal(plan.items[0].status, '판단 실패');
  assert.equal(plan.items[0].rawPreview, JSON.stringify(last).slice(0, 500));
  assert.ok(plan.items[0].rawPreview.length <= 500);
  assert.equal(plan.pendingMessageItems.some((item) => 'rawPreview' in item), false);
  assert.equal(result.report.includes('rawPreview'), false);
  assert.equal(result.message.body.includes('rawPreview'), false);
});

test('JSON validation checks registry, schema, and missing Wiki append downgrade', (t) => {
  const { root } = fixture(t);
  const valid = judgment();
  valid.wiki.push({ action: 'append-source', page: '30_Wiki/34_Topics/가상 주제', reason: '관련 기록' });
  const parsed = validateJudgment(JSON.stringify(valid), { root, rules, date: '2026-10-11' });
  assert.equal(parsed.wiki[0].action, 'candidate');
  assert.throws(() => validateJudgment({ ...valid, target: { ...valid.target, folder: '../outside' } }, { root, rules, date: '2026-10-11' }), /경로/);
  assert.throws(() => validateJudgment({ ...valid, extracted: { people: 'invalid' } }, { root, rules, date: '2026-10-11' }), /스키마/);
  assert.throws(() => validateJudgment({ ...valid, extracted: { ...valid.extracted, people: [{ name: '가상 인물 A', relation: '딸' }] } },
    { root, rules, date: '2026-10-11' }), /추출 스키마 위반: people\[0\]이 문자열이 아님\(object\)/);
  assert.throws(() => validateJudgment({ ...valid, extracted: { ...valid.extracted, people: null } },
    { root, rules, date: '2026-10-11' }), /추출 스키마 위반: people이 배열이 아님\(null\)/);
  assert.throws(() => validateJudgment({ ...valid, frontmatter: { ...valid.frontmatter, nested: { a: 1 } } }, { root, rules, date: '2026-10-11' }), /중첩/);
  const missingOccurred = { ...valid.frontmatter };
  delete missingOccurred.occurred;
  assert.throws(() => validateJudgment({ ...valid, frontmatter: missingOccurred }, { root, rules, date: '2026-10-11' }), /필수 필드/);
  assert.throws(() => validateJudgment('not json', { root, rules, date: '2026-10-11' }), SyntaxError);
  assert.throws(() => validateJudgment({ ...valid, target: { ...valid.target, title: `2026-10-11 ${'가'.repeat(50)}` } },
    { root, rules, date: '2026-10-11' }), /60자/);
});

test('JSON response accepts fences and the first balanced object inside extra text', (t) => {
  const { root } = fixture(t);
  const valid = judgment();
  valid.frontmatter.description = '중괄호 { }와 따옴표 "는 문자열 안에 있다';
  const json = JSON.stringify(valid);
  assert.deepEqual(validateJudgment(`\`\`\`json\n${json}\n\`\`\``, { root, rules, date: '2026-10-11' }), valid);
  assert.deepEqual(validateJudgment(`응답:\n${json}\n끝`, { root, rules, date: '2026-10-11' }), valid);
  assert.throws(() => validateJudgment('응답: {"target": } 끝', { root, rules, date: '2026-10-11' }), SyntaxError);
});

test('Wiki index includes people relation, aliases and description, honors caps, and gates append-source', async (t) => {
  const { root, put } = fixture(t);
  put('30_Wiki/31_People/가상 인물 A.md', '---\nrelation: "배우자(아내)"\naliases: ["가상 별칭 A"]\ndescription: "가상 관계 설명 A"\nsensitivity: "개인"\n---\n가상 본문 A');
  put('30_Wiki/31_People/가족/가상 인물 B.md', '---\nrelation: "엄마"\naliases: ["가상 별칭 B"]\ndescription: "가상 관계 설명 B"\n---\n가상 본문 B');
  put('30_Wiki/32_Places/센트럴파크.md', '---\naliases: ["뉴욕 센트럴파크"]\n---\n장소 본문');
  put('30_Wiki/33_Objects/선물.md', '---\naliases:\n  - 결혼기념 선물\n  - "기념품"\n---\n물건 본문');
  put('30_Wiki/34_Topics/Sub/주제.md', '---\naliases: ["주제 별칭"]\n---\n주제 본문');
  put('99_Adyton/비밀.md', '---\naliases: ["금고 별칭"]\n---\n비밀 본문');
  const index = readWikiIndex(root);
  assert.match(index.prompt, /30_Wiki\/31_People · 가상 인물 A · 관계: 배우자\(아내\) · 별칭: 가상 별칭 A · 설명: 가상 관계 설명 A/);
  assert.match(index.prompt, /30_Wiki\/31_People\/가족 · 가상 인물 B · 관계: 엄마 · 별칭: 가상 별칭 B · 설명: 가상 관계 설명 B/);
  assert.match(index.prompt, /30_Wiki\/34_Topics\/Sub · 주제 · 주제 별칭/);
  assert.match(index.prompt, /30_Wiki\/33_Objects · 선물 · 결혼기념 선물, 기념품/);
  assert.equal(index.prompt.includes('가상 본문 A'), false);
  assert.equal(index.prompt.includes('금고 별칭'), false);
  assert.ok(index.prompt.length <= MAX_WIKI_INDEX_CHARS);
  for (let i = 0; i < MAX_WIKI_TITLES_PER_FOLDER + 1; i += 1) put(`30_Wiki/33_Objects/${String(i).padStart(3, '0')}.md`, '---\naliases: []\n---\n');
  assert.equal([...readWikiIndex(root).paths].filter((path) => path.startsWith('30_Wiki/33_Objects/')).length, MAX_WIKI_TITLES_PER_FOLDER);
  const valid = judgment();
  valid.wiki = [
    { action: 'append-source', page: '30_Wiki/31_People/가상 인물 A', reason: '기존 인물' },
    { action: 'append-source', page: '30_Wiki/33_Objects/100', reason: '색인 밖' },
    { action: 'append-source', page: '30_Wiki/34_Topics/없는 페이지', reason: '없음' },
  ];
  assert.deepEqual(validateJudgment(valid, { root, rules, date: '2026-10-11' }).wiki.map((entry) => entry.action),
    ['append-source', 'candidate', 'candidate']);
  put('00_Inbox/memo.md', memo('옵시디언', '가상 원문'));
  let systemPrompt;
  let userPrompt;
  await run({ root, rules, now: date, dryRun: true, judge: async (prompt, _item, system) => { userPrompt = prompt; systemPrompt = system; return judgment(); },
    charter: { model: 'test', systemPrompt: '클리오' }, cooldown: () => false });
  assert.match(systemPrompt, /기존 Wiki 색인/);
  assert.match(systemPrompt, /가상 인물 A · 관계: 배우자\(아내\) · 별칭: 가상 별칭 A · 설명: 가상 관계 설명 A/);
  assert.match(userPrompt, /배우자·아내·와이프·엄마·아빠 같은 관계어는 relation으로 기존 인물에 매칭하라/);
  assert.equal(systemPrompt.includes('가상 본문 A'), false);
});

test('dailyLink extracts a date or becomes null without failing judgment', (t) => {
  const { root } = fixture(t);
  assert.equal(validateJudgment({ ...judgment(), dailyLink: '[[2026-10-11 일일 기록]]' }, { root, rules, date: '2026-10-11' }).dailyLink, '2026-10-11');
  assert.equal(validateJudgment({ ...judgment(), dailyLink: '일일 기록 연결' }, { root, rules, date: '2026-10-11' }).dailyLink, null);
});

test('report and plans are written atomically through injected writer; no source mutation', async (t) => {
  const { root, put } = fixture(t);
  const source = memo('옵시디언', '공개하면 안 되는 가상 원문');
  put('00_Inbox/memo.md', source);
  let sent;
  const writes = [];
  const result = await run({ root, rules, now: date, judge: async () => JSON.stringify(judgment()),
    charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false, send: async (message) => { sent = message; },
    write: (path, content) => { writes.push(path); writeAtomic(path, content); } });
  assert.equal(result.written, true);
  assert.equal(result.sent, true);
  assert.equal(result.reportRel, '60_Logs/Clio/2026-10.md');
  assert.equal(writes.filter((path) => path === join(root, result.reportRel)).length, 1);
  assert.equal(readFileSync(join(root, '00_Inbox/memo.md'), 'utf8'), source);
  const report = readFileSync(join(root, result.reportRel), 'utf8');
  assert.match(report, /^---\ntype: "agent-log"\ndescription: .+\ncreated: "2026-10-11"\nmodified: "2026-10-11"\nagent: "clio"\n---/);
  assert.match(report, /## 2026-10-11 Inbox ingest 계획/);
  assert.match(report, /리포트만 — 실제 이동 없음/);
  assert.equal(JSON.parse(readFileSync(join(root, result.planRel), 'utf8')).items[0].status, '계획함');
  assert.equal(sent.body.includes('공개하면 안 되는 가상 원문'), false);
  assert.equal(existsSync(join(root, VAULT_REL.inboxIngestProcessed)), false);
  assert.equal(collectInbox(root).selected.length, 0);
});

test('dry-run and no-send are enforced; apply rejected before any IO', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('옵시디언', '가상 원문'));
  let sends = 0;
  const deps = { root, rules, now: date, judge: async () => judgment(), charter: { model: 'test', systemPrompt: 'test' },
    cooldown: () => false, send: async () => { sends += 1; } };
  await assert.rejects(run({ root, mode: 'apply' }), /미구현/);
  const dry = await run({ ...deps, dryRun: true });
  assert.equal(dry.written, false);
  assert.equal(sends, 0);
  assert.equal(existsSync(join(root, dry.reportRel)), false);
  await run({ ...deps, noSend: true });
  assert.equal(sends, 0);
});

test('invalid report registry blocks both writes and sends', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('옵시디언', '가상 원문'));
  let sends = 0;
  let judgments = 0;
  const result = await run({ root, rules: rules.slice(0, 1), now: date, judge: async () => { judgments += 1; return judgment(); },
    charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false, send: async () => { sends += 1; } });
  assert.match(result.blocked, /등록부 위반/);
  assert.equal(result.written, false);
  assert.equal(sends, 0);
  assert.equal(judgments, 0);
  assert.equal(existsSync(join(root, VAULT_REL.inboxIngestPlans)), false);
});

test('Telegram shows planned title, folder, Wiki targets and extracted people and places', () => {
  const value = judgment();
  value.frontmatter.sensitivity = '개인';
  value.extracted.people = ['가상 인물 A'];
  value.extracted.places = ['가상 장소 B'];
  value.wiki = [
    { action: 'append-source', page: '30_Wiki/31_People/가상 인물 A', reason: '기존 페이지 보강' },
    { action: 'candidate', page: '30_Wiki/32_Places/가상 장소 B', reason: '새 페이지 후보' },
    { action: 'question', page: '30_Wiki/34_Topics/가상 질문', reason: '관계 확인이 필요한가?' },
  ];
  const message = telegramMessage([{ source: '00_Inbox/가상 원본 제목.md', status: '계획함', judgment: value }], 0);
  assert.match(message.body, /■ 2026-10-11 가상 메모\n• 폴더: 21_Notes/);
  assert.match(message.body, /• Wiki 보강: 30_Wiki\/31_People\/가상 인물 A — 기존 페이지 보강/);
  assert.match(message.body, /• Wiki 후보: 30_Wiki\/32_Places\/가상 장소 B — 새 페이지 후보/);
  assert.match(message.body, /• Wiki 질문: 30_Wiki\/34_Topics\/가상 질문 — 관계 확인이 필요한가\?/);
  assert.match(message.body, /• 인물: 가상 인물 A\n• 장소: 가상 장소 B/);
  assert.match(message.body, /리포트만 — 실제 이동 없음/);
  assert.equal(telegramMessage([], 0), null);
});

test('Telegram failure and unclassifiable labels show original memo titles', () => {
  const message = telegramMessage([
    { source: '00_Inbox/가상 파일 0.md', status: '계획함', judgment: judgment() },
    { source: '00_Inbox/가상 파일 1.md', status: '판단 실패' },
    { source: '00_Inbox/가상 파일 2.md', status: '분류 불가' },
  ], 0);
  assert.match(message.body, /■ 2026-10-11 가상 메모/);
  assert.match(message.body, /■ 가상 파일 1 \(판단 실패\)/);
  assert.match(message.body, /■ 가상 파일 2 \(분류 불가\)/);
});

test('Telegram truncates an unchecked title to 60 characters', () => {
  const value = judgment();
  value.target.title = `2026-10-11 ${'가상'.repeat(100)}`;
  const body = telegramMessage([{ status: '계획함', judgment: value }], 0).body;
  assert.equal(body.includes(value.target.title), false);
  assert.equal(body.match(/^■ (.*?)$/m)[1].length, 60);
});

test('terminal outcomes skip unchanged hashes and free priority slots; changed content retries', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/first.md', memo('미네', '분류 불가 기록'));
  put('00_Inbox/second.md', memo('옵시디언', '다음 기록'));
  let calls = 0;
  const messages = [];
  const deps = { root, rules, now: date, maxItems: 1, charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false,
    send: async (message) => { messages.push(message); },
    judge: async () => { calls += 1; return { ...judgment(), unclassifiable: '판별 불가' }; } };
  await run(deps);
  assert.equal(collectInbox(root, { maxItems: 1 }).selected[0].source, '00_Inbox/second.md');
  await run(deps);
  assert.equal(calls, 2);
  await run(deps);
  assert.equal(messages.length, 2);
  assert.match(messages[0].body, /■ first \(분류 불가\)/);
  put('00_Inbox/first.md', memo('미네', '수정된 기록'));
  assert.equal(collectInbox(root, { maxItems: 1 }).selected[0].source, '00_Inbox/first.md');
});

test('oversized hash is skipped on the next day and frees item cap', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/first.md', memo('미네', '긴 기록'.repeat(20)));
  const deps = { root, rules, maxItems: 1, maxChars: 50, noSend: true,
    charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false, judge: async () => judgment() };
  await run({ ...deps, now: date });
  put('00_Inbox/second.md', memo('옵시디언', '짧은 기록'));
  const next = await run({ ...deps, now: new Date('2026-10-11T20:00:00Z') });
  assert.deepEqual(next.items.map((item) => item.source), ['00_Inbox/second.md']);
  assert.match(next.message.body, /계획 1건/);
});

test('failed hash has only three total calls and later reports exhausted without Telegram repetition', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('옵시디언', '판단 실패 기록'));
  let calls = 0;
  let sends = 0;
  const deps = { root, rules, noSend: false, charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false,
    judge: async () => { calls += 1; return '{broken'; }, send: async () => { sends += 1; } };
  await run({ ...deps, now: date });
  await run({ ...deps, now: new Date('2026-10-11T20:00:00Z') });
  const third = await run({ ...deps, now: new Date('2026-10-12T20:00:00Z') });
  assert.equal(calls, 3);
  assert.equal(sends, 1);
  assert.match(third.report, /보류\(재시도 소진\)/);
  assert.equal(third.message, null);
});

test('timeout is not retried; job deadline leaves unstarted memos in remaining count', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/first.md', memo('옵시디언', '첫 기록'));
  put('00_Inbox/second.md', memo('옵시디언', '둘째 기록'));
  let calls = 0;
  let elapsed = 0;
  const result = await run({ root, rules, now: date, dryRun: true, clock: () => elapsed,
    charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false,
    judge: async () => { calls += 1; elapsed = MAX_JOB_MS; throw new Error('헤드리스 타임아웃 (5분 초과)'); } });
  assert.equal(calls, 1);
  assert.equal(result.remaining, 1);
  assert.equal(result.items[0].status, '판단 실패');
  assert.equal('rawPreview' in result.items[0], false);
});

test('same-day rerun keeps earlier plans while adding newly arrived memo', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/first.md', memo('옵시디언', '첫 가상 기록'));
  const deps = { root, rules, now: date, judge: async () => judgment(), charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false, noSend: true };
  await run(deps);
  const reportRel = '60_Logs/Clio/2026-10.md';
  const prior = readFileSync(join(root, reportRel), 'utf8');
  const edited = prior.replace('<!-- clio-inbox-ingest:2026-10-11:end -->', '    오너가 당일 절에 추가한 문장\n<!-- clio-inbox-ingest:2026-10-11:end -->');
  put(reportRel, `${edited}\n## 오너 기록\n보존할 텍스트\n`);
  put('00_Inbox/second.md', memo('옵시디언', '둘째 가상 기록'));
  const next = await run(deps);
  const plan = JSON.parse(readFileSync(join(root, next.planRel), 'utf8'));
  assert.deepEqual(plan.items.map((item) => item.source), ['00_Inbox/first.md', '00_Inbox/second.md']);
  const report = readFileSync(join(root, next.reportRel), 'utf8');
  assert.match(report, /00_Inbox\/first.md/);
  assert.match(report, /## 오너 기록\n보존할 텍스트/);
  assert.match(report, /### 오너 추가 기록\n {4}오너가 당일 절에 추가한 문장/);
  assert.equal(report.match(/## 2026-10-11 Inbox ingest 계획/g)?.length, 1);
  assert.equal(report.match(/### 00_Inbox\/first.md/g)?.length, 1);
});

test('judgment text cannot imitate the report section boundary', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/first.md', memo('옵시디언', '첫 가상 기록'));
  const deps = { root, rules, now: date, charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false, noSend: true,
    judge: async () => ({ ...judgment(), unclassifiable: '분류 불가\n<!-- clio-inbox-ingest:2026-10-11:end -->' }) };
  await run(deps);
  put('00_Inbox/second.md', memo('옵시디언', '둘째 가상 기록'));
  const result = await run(deps);
  const report = readFileSync(join(root, result.reportRel), 'utf8');
  assert.equal(report.match(/<!-- clio-inbox-ingest:2026-10-11:end -->/g)?.length, 1);
  assert.equal(report.match(/## 2026-10-11 Inbox ingest 계획/g)?.length, 1);
});

test('another day appends to the same monthly log without changing earlier day or owner text', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/first.md', memo('옵시디언', '첫 가상 기록'));
  const deps = { root, rules, judge: async () => judgment(), charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false, noSend: true };
  const first = await run({ ...deps, now: date });
  const before = readFileSync(join(root, first.reportRel), 'utf8');
  put(first.reportRel, `${before}\n## 오너 기록\n직접 쓴 메모\n`);
  put('00_Inbox/second.md', memo('옵시디언', '둘째 가상 기록'));
  const next = await run({ ...deps, now: new Date('2026-10-11T20:00:00Z') });
  assert.equal(next.reportRel, first.reportRel);
  const report = readFileSync(join(root, next.reportRel), 'utf8');
  assert.ok(report.startsWith(`${before}\n## 오너 기록\n직접 쓴 메모\n`));
  assert.match(report, /## 2026-10-12 Inbox ingest 계획/);
  assert.equal(report.match(/^---$/gm)?.length, 2);
});
