import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyPlans, applicablePlans, collectInbox, planShapeProblems, priorityOf, readWikiIndex, retryMemo, validateJudgment, run as ingestRun, telegramMessage,
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
  frontmatter: { category: ['[[01_Home/201 미네]]'], description: '가상 기록', sensitivity: '일반', occurred: '2026-10-11', origin: '테스트' },
  extracted: { people: [], places: [], topics: ['가상 주제'], objects: [], dates: [], todos: [], decisions: [] },
  wiki: [], dailyLink: '2026-10-11', unclassifiable: null });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'clio-ingest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel, content) => { const path = join(root, rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  return { root, put };
}
const memo = (origin, body) => `---\norigin: "${origin}"\n---\n${body}`;
const run = (options) => ingestRun({ mode: 'report', ...options });

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

test('dailyLink 누락은 원본 머리말 occurred, 그다음 created 날짜로 보정한다', async (t) => {
  const { root, put } = fixture(t);
  const missing = { ...judgment(), dailyLink: null };
  const source = '---\ncreated: "2026-10-10T09:00:00+09:00"\noccurred: "2026-10-09T18:00:00+09:00"\n---\n글 메모';
  assert.equal(validateJudgment(missing, { root, rules, date: '2026-10-11', sourceContent: source }).dailyLink, '2026-10-09');
  const omitted = { ...judgment() }; delete omitted.dailyLink;
  assert.equal(validateJudgment(omitted, { root, rules, date: '2026-10-11', sourceContent: source }).dailyLink, '2026-10-09');
  assert.equal(validateJudgment(missing, { root, rules, date: '2026-10-11',
    sourceContent: '---\ncreated: "2026-10-10"\n---\n글 메모' }).dailyLink, '2026-10-10');
  assert.equal(validateJudgment(missing, { root, rules, date: '2026-10-11',
    sourceContent: '---\ncreated: "2026-10-10T18:30:00Z"\n---\n글 메모' }).dailyLink, '2026-10-11');
  assert.equal(validateJudgment(missing, { root, rules, date: '2026-10-11', sourceContent: '날짜 없는 글' }).dailyLink, null);
  put('00_Inbox/memo.md', source);
  const result = await run({ root, rules, now: date, dryRun: true, judge: async () => missing,
    charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false });
  assert.equal(result.items[0].judgment.dailyLink, '2026-10-09');
});

test('판단 프롬프트는 실제 카테고리 링크 배열과 등록부 convKind 허용값, 글 메모 분류를 안내한다', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('텔레그램 📜', '미네가 직접 쓴 글'));
  put(`${VAULT_REL.homeDir}/200 가족.md`, '');
  put(`${VAULT_REL.homeDir}/201 미네.md`, '');
  const promptRules = [...rules, { type: 'conversation', path: '20_Records/23_Conversations/{YYYY}/',
    required: { bundle: [], extra: ['convKind'] }, allowedValues: { convKind: ['통화', '대면', '회의', '녹음'] } }];
  let prompt;
  await run({ root, rules: promptRules, now: date, dryRun: true,
    judge: async (value) => { prompt = value; return judgment(); },
    charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false });
  assert.match(prompt, /"category":\["\[\[01_Home\/200 가족\]\]"\]/);
  assert.match(prompt, /\[\[01_Home\/201 미네\]\]/);
  assert.match(prompt, /convKind 허용값: 통화, 대면, 회의, 녹음/);
  assert.match(prompt, /미네가 직접 쓴 글도 note/);
  assert.match(prompt, /dailyLink에 그 날짜/);
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
  await assert.rejects(run({ root, mode: 'apply' }), /지원하지 않는 mode/);
  const dry = await run({ ...deps, dryRun: true });
  assert.equal(dry.written, false);
  assert.equal(sends, 0);
  assert.equal(existsSync(join(root, dry.reportRel)), false);
  await run({ ...deps, noSend: true });
  assert.equal(sends, 0);
});

test('candidate file is written once on change, restored from plans, and untouched by dry-run', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', '---\norigin: "옵시디언"\noccurred: "2026-09-01"\n---\n가상 원문');
  const candidateJudgment = () => ({ ...judgment(), wiki: [{ action: 'candidate',
    page: '30_Wiki/34_Topics/가상 주제', reason: '반복 후보' }] });
  const writes = [];
  const deps = { root, rules, now: date, judge: async () => candidateJudgment(),
    charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false, noSend: true,
    write: (path, content) => { writes.push(path); writeAtomic(path, content); } };
  const candidatePath = join(root, VAULT_REL.inboxIngestWikiCandidates);
  await run({ ...deps, dryRun: true });
  assert.equal(writes.length, 0);
  assert.equal(existsSync(candidatePath), false);
  await run(deps);
  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8')).candidates[0];
  assert.equal(candidate.sourceStatus, 'provisional');
  assert.equal(candidate.sources[0].occurredAt, '2026-09-01');
  assert.equal(candidate.sources[0].path, '00_Inbox/memo.md');
  assert.equal(candidate.sources[0].hash.length, 64);
  assert.equal(JSON.stringify(candidate).includes('가상 원문'), false);
  assert.equal(writes.filter((path) => path === candidatePath).length, 1);
  await run(deps);
  assert.equal(writes.filter((path) => path === candidatePath).length, 1);
  unlinkSync(candidatePath);
  await run(deps);
  assert.equal(writes.filter((path) => path === candidatePath).length, 2);
  const restored = readFileSync(candidatePath, 'utf8');
  put('00_Inbox/new.md', memo('외부', '새 기록'));
  await run({ ...deps, dryRun: true });
  assert.equal(readFileSync(candidatePath, 'utf8'), restored);
  assert.equal(writes.filter((path) => path === candidatePath).length, 2);
});

test('candidate write failure keeps pending message and rerun sends it once', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('오너 직접', '복구할 Wiki 후보'));
  const messages = [];
  const candidatePath = join(root, VAULT_REL.inboxIngestWikiCandidates);
  const deps = { root, rules, now: date, charter: { model: 'test', systemPrompt: 'test' },
    cooldown: () => false, judge: async () => ({ ...judgment(), wiki: [{ action: 'candidate',
      page: '30_Wiki/34_Topics/복구 주제', reason: '반복 후보' }] }),
    send: async (message) => { messages.push(message); } };
  await assert.rejects(run({ ...deps, write: (path, content) => {
    if (path === candidatePath) throw new Error('후보 쓰기 장애');
    writeAtomic(path, content);
  } }), /후보 쓰기 장애/);
  const planPath = join(root, VAULT_REL.inboxIngestPlans, '2026-10-11.json');
  assert.equal(JSON.parse(readFileSync(planPath, 'utf8')).pendingMessageItems.length, 1);
  assert.equal(existsSync(join(root, VAULT_REL.clioLog, '2026-10.md')), false);
  assert.equal(messages.length, 0);
  await run(deps);
  assert.equal(messages.length, 1);
  assert.match(messages[0].body, /복구 주제/);
  assert.equal(JSON.parse(readFileSync(planPath, 'utf8')).pendingMessageItems.length, 0);
  await run(deps);
  assert.equal(messages.length, 1);
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
  assert.equal(result.items[0].status, '판단 보류(실행 장애)');
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

const dailyRule = { type: 'daily', path: '10_Periodic/Daily/{YYYY}/', pathRegex: /^10_Periodic\/Daily\/\d{4}\/[^/]+\.md$/, titleRegex: /^\d{4}-\d{2}-\d{2}$/,
  required: { bundle: ['type'], extra: [] } };
import { aiHashOf, inspectExisting, parseSections, splitNote } from '../lib/daily-note.mjs';
import { createHash } from 'node:crypto';
function dailyNote() {
  const body = '## 오늘 한 줄\n\n## 오너 메모\n오너 글\n\n## 오늘 들어온 기록\n- 기존 줄\n\n## AI 하루 요약\n요약\n';
  const hash = aiHashOf(parseSections(body).sections);
  return `---\ntype: "daily"\nmodified: "2026-10-11"\naiHash: "${hash}"\n---\n${body}`;
}
function applyFixture(t, { daily = dailyNote(), plans = null } = {}) {
  const { root, put } = fixture(t);
  const source = '00_Inbox/2026-10-11 1200 가상 메모, 쉼표.md';
  const content = `---\norigin: "텔레그램 📜"\ncreated: "2026-10-11T12:00:00+09:00"\n---\n오너 가상 메모 본문`;
  put(source, content);
  if (daily) put('10_Periodic/Daily/2026/2026-10-11.md', daily);
  const hash = createHash('sha256').update(content).digest('hex');
  const entries = plans ?? [{ date: '2026-10-11', judgment: judgment() }];
  for (const { date, judgment: value } of entries)
    put(`95_Etna/Ingest/plans/${date}.json`, JSON.stringify({ items: [{ source, hash, status: '계획함', judgment: value },
      { source: '00_Inbox/other.md', hash: 'x', status: '계획함', judgment: judgment() }] }));
  return { root, put, source, rules: [...rules, dailyRule] };
}
const NOW = new Date('2026-10-17T03:00:00Z');

test('planShapeProblems: convKind 허용값·category 링크 배열·201 미네 대화 조건부·머리말 키·줄바꿈', () => {
  assert.deepEqual(planShapeProblems(judgment()), []);
  const bad = { target: { type: 'conversation' }, frontmatter: { category: '가족', convKind: '텔레그램 메시지' } };
  assert.equal(planShapeProblems(bad).length, 2);
  const mine = { target: { type: 'conversation' }, frontmatter: { category: ['[[01_Home/201 미네]]'], convKind: '대면' } };
  assert.match(planShapeProblems(mine).join(), /21_Notes/);
  const injected = judgment(); injected.frontmatter.description = '앞\n---\n뒤'; injected.frontmatter['a b'] = 'x';
  const problems = planShapeProblems(injected).join(' ');
  assert.match(problems, /줄바꿈 금지/);
  assert.match(problems, /키 형식 위반/);
});

test('applyPlans: 1건 명시, dry-run 무쓰기, 노트(movedFrom·원본 origin·created 보존·modified=적용일)·데일리 한 줄+aiHash 재계산·원본 비움·멱등', (t) => {
  const { root, source, rules: r } = applyFixture(t);
  assert.throws(() => applyPlans({ root, ids: undefined, rules: r }), /1건을 명시/);
  assert.throws(() => applyPlans({ root, ids: [source, '00_Inbox/other.md'], rules: r }), /1건을 명시/);
  const preview = applyPlans({ root, ids: source, dryRun: true, noWiki: true, rules: r, now: NOW });
  assert.equal(preview.written, false);
  assert.ok(existsSync(join(root, source)));
  const done = applyPlans({ root, ids: source, noWiki: true, rules: r, now: NOW });
  assert.equal(done.written, true);
  const note = readFileSync(join(root, '20_Records/21_Notes/2026/2026-10-11 가상 메모.md'), 'utf8');
  assert.match(note, /movedFrom: \["00_Inbox\/2026-10-11 1200 가상 메모, 쉼표"\]/);
  assert.match(note, /origin: "텔레그램 📜"/);
  assert.match(note, /created: "2026-10-11"/);
  assert.match(note, /modified: "2026-10-17"/);
  assert.match(note, /오너 가상 메모 본문/);
  assert.ok(!existsSync(join(root, source)));
  const daily = readFileSync(join(root, '10_Periodic/Daily/2026/2026-10-11.md'), 'utf8');
  assert.match(daily, /## 오너 메모\n오너 글\n/);
  assert.match(daily, /- 기존 줄\n- \[\[20_Records\/21_Notes\/2026\/2026-10-11 가상 메모\|/);
  assert.equal(inspectExisting(daily).ok, true, '데일리 잡이 계속 갱신할 수 있어야 함(aiHash 일치)');
  assert.match(readFileSync(join(root, '60_Logs/Clio/2026-10.md'), 'utf8'), /- 2026-10-17 Inbox apply/);
  assert.equal(applyPlans({ root, ids: source, noWiki: true, rules: r, now: NOW }).items[0].alreadyApplied, true);
});

test('applyPlans: 데일리 없음·오너가 AI 칸을 고친 데일리는 손대지 않고 보류', (t) => {
  const none = applyFixture(t, { daily: null });
  assert.match(applyPlans({ root: none.root, ids: none.source, dryRun: true, noWiki: true, rules: none.rules, now: NOW }).items[0].dailyPending, /2026-10-11\.md/);
  const edited = applyFixture(t, { daily: dailyNote().replace('- 기존 줄', '- 오너가 고친 줄') });
  const result = applyPlans({ root: edited.root, ids: edited.source, noWiki: true, rules: edited.rules, now: NOW });
  assert.match(result.items[0].dailyPending, /오너 수정/);
  assert.match(readFileSync(join(edited.root, '10_Periodic/Daily/2026/2026-10-11.md'), 'utf8'), /- 오너가 고친 줄\n\n## AI/);
});

test('applyPlans: 재판단으로 옛 잘못된 계획과 새 계획이 함께 있으면 기준을 통과하는 최신 1건을 쓰고, 맞는 계획이 없으면 적용하지 않음', (t) => {
  const bad = judgment(); bad.frontmatter.category = '가족';
  const both = applyFixture(t, { plans: [{ date: '2026-10-12', judgment: bad }, { date: '2026-10-17', judgment: judgment() }] });
  assert.equal(applyPlans({ root: both.root, ids: both.source, dryRun: true, noWiki: true, rules: both.rules, now: NOW }).items.length, 1);
  const onlyBad = applyFixture(t, { plans: [{ date: '2026-10-12', judgment: bad }] });
  assert.throws(() => applyPlans({ root: onlyBad.root, ids: onlyBad.source, noWiki: true, rules: onlyBad.rules, now: NOW }), /0건 일치/);
  assert.ok(existsSync(join(onlyBad.root, onlyBad.source)));
});

test('applyPlans: 노트를 쓴 뒤 멈춘 적용은 다음 실행에서 남은 단계만 이어서 끝낸다', (t) => {
  const { root, source, rules: r } = applyFixture(t);
  let calls = 0;
  const crashing = (path, content) => { calls += 1; writeAtomic(path, content); if (calls === 2) throw new Error('중간 멈춤'); };
  assert.throws(() => applyPlans({ root, ids: source, noWiki: true, rules: r, now: NOW, write: crashing }), /중간 멈춤/);
  assert.ok(existsSync(join(root, '20_Records/21_Notes/2026/2026-10-11 가상 메모.md')));
  assert.ok(existsSync(join(root, source)));
  const resumed = applyPlans({ root, ids: source, noWiki: true, rules: r, now: NOW });
  assert.equal(resumed.items[0].resumed, true);
  assert.ok(!existsSync(join(root, source)));
  assert.equal(applyPlans({ root, ids: source, noWiki: true, rules: r, now: NOW }).items[0].alreadyApplied, true);
});

test('collectInbox: 지금 기준에 어긋나는 옛 계획함 항목은 다시 판단 대상, 맞는 계획은 건너뜀', (t) => {
  const bad = judgment(); bad.frontmatter.category = '가족';
  const invalid = applyFixture(t, { plans: [{ date: '2026-10-12', judgment: bad }] });
  assert.ok(collectInbox(invalid.root).selected.some((x) => x.source === invalid.source));
  const valid = applyFixture(t);
  assert.ok(!collectInbox(valid.root).selected.some((x) => x.source === valid.source));
});

test('execution failure keeps attempts and retries next day; validation failure still counts', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('옵시디언', '재시도 기록'));
  const deps = { root, rules, noSend: true, charter: { model: 'test', systemPrompt: 'test' }, cooldown: () => false };
  const failed = await ingestRun({ ...deps, now: date, judge: async () => { throw new Error("claude 종료코드 1: error: unknown option '--restricted'"); } });
  assert.equal(failed.items[0].status, '판단 보류(실행 장애)');
  assert.equal(failed.items[0].attempts, 0);
  assert.match(failed.report, /실행 장애 1건/);
  assert.match(failed.message.body, /실행 장애 1건/);
  assert.equal(collectInbox(root).selected[0].attempts, 0);
  const next = await ingestRun({ ...deps, mode: 'report', now: new Date('2026-10-11T20:00:00Z'), judge: async () => '{bad' });
  assert.equal(next.items[0].status, '판단 실패');
  assert.equal(next.items[0].attempts, 2);
  assert.equal(collectInbox(root).selected[0].attempts, 2);
});

test('old cumulative execution attempts are excluded while earlier validation attempts remain', (t) => {
  const { root, put } = fixture(t);
  const content = memo('옵시디언', '옛 장애 기록');
  put('00_Inbox/memo.md', content);
  const hash = createHash('sha256').update(content).digest('hex');
  put('95_Etna/Ingest/plans/2026-10-14.json', JSON.stringify({ items: [
    { source: '00_Inbox/memo.md', hash, status: '판단 실패', attempts: 1, reason: 'JSON 스키마 위반' }] }));
  put('95_Etna/Ingest/plans/2026-10-15.json', JSON.stringify({ items: [
    { source: '00_Inbox/memo.md', hash, status: '판단 실패', attempts: 2, reason: "claude 종료코드 1: unknown option '--restricted'" }] }));
  put('95_Etna/Ingest/plans/2026-10-16.json', JSON.stringify({ items: [
    { source: '00_Inbox/memo.md', hash, status: '판단 실패', attempts: 3, reason: 'Not logged in' }] }));
  assert.equal(collectInbox(root).selected[0].attempts, 1);
  assert.equal(readFileSync(join(root, '95_Etna/Ingest/plans/2026-10-16.json'), 'utf8').includes('attempts":3'), true);
});

test('retry resets exhausted memo attempts without changing plans; changed content ignores marker', (t) => {
  const { root, put } = fixture(t);
  const source = '00_Inbox/retry.md';
  const content = memo('옵시디언', '재시도할 기록');
  const hash = createHash('sha256').update(content).digest('hex');
  put(source, content);
  const planPath = '95_Etna/Ingest/plans/2026-10-14.json';
  const plan = JSON.stringify({ items: [{ source, hash, status: '판단 실패', attempts: 3, reason: '검증 실패' }] });
  put(planPath, plan);
  assert.equal(collectInbox(root).exhausted.length, 1);
  const resetAt = new Date('2026-10-14T12:00:00Z');
  assert.equal(retryMemo({ root, source, now: resetAt }).written, true);
  assert.equal(readFileSync(join(root, planPath), 'utf8'), plan);
  assert.equal(collectInbox(root).selected[0].attempts, 0);
  const processed = JSON.parse(readFileSync(join(root, VAULT_REL.inboxIngestProcessed), 'utf8'));
  assert.equal(processed[source].retryResetAt, resetAt.toISOString());
  assert.equal(processed[source].retryHash, hash);
  put('95_Etna/Ingest/plans/2026-10-15.json', JSON.stringify({ items: [
    { source, hash, attemptedAt: '2026-10-14T13:00:00.000Z', status: '판단 실패', attempts: 2, reason: '검증 실패' }] }));
  assert.equal(collectInbox(root).selected[0].attempts, 2);
  put(source, memo('옵시디언', '수정한 기록'));
  assert.equal(collectInbox(root).selected[0].attempts, 0);
});

test('retry uses the KST plan day for legacy attempts just after midnight', (t) => {
  const { root, put } = fixture(t);
  const source = '00_Inbox/midnight.md';
  const content = memo('옵시디언', '자정 재시도');
  const hash = createHash('sha256').update(content).digest('hex');
  put(source, content);
  put('95_Etna/Ingest/plans/2026-10-15.json', JSON.stringify({ items: [
    { source, hash, status: '판단 실패', attempts: 3, reason: '검증 실패' }] }));
  assert.equal(collectInbox(root).exhausted.length, 1);
  retryMemo({ root, source, now: new Date('2026-10-14T15:10:00Z') });
  assert.equal(collectInbox(root).selected[0].attempts, 0);
});

test('retry rejects an already processed hash and preserves its state', (t) => {
  const { root, put } = fixture(t);
  const source = '00_Inbox/processed.md';
  const content = memo('옵시디언', '처리 중인 기록');
  const hash = createHash('sha256').update(content).digest('hex');
  put(source, content);
  const statePath = VAULT_REL.inboxIngestProcessed;
  const state = JSON.stringify({ [source]: { hash, target: '20_Records/21_Notes/2026/처리 중.md' } });
  put(statePath, state);
  assert.throws(() => retryMemo({ root, source }), /이미 처리 중이거나 적용된/);
  assert.throws(() => retryMemo({ root, source, dryRun: true }), /이미 처리 중이거나 적용된/);
  assert.equal(readFileSync(join(root, statePath), 'utf8'), state);
});

test('retry validates a single Inbox file and rejects symlinks before reading', (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/valid.md', memo('옵시디언', '정상'));
  put('outside.md', '외부 파일');
  symlinkSync(join(root, 'outside.md'), join(root, '00_Inbox/link.md'));
  for (const source of ['../outside.md', '00_Inbox/../outside.md', '00_Inbox/missing.md',
    '00_Inbox/link.md', '00_Inbox/sub/file.md', '00_Inbox/valid.md,00_Inbox/other.md']) {
    assert.throws(() => retryMemo({ root, source }), /Inbox 메모/);
  }
  assert.equal(existsSync(join(root, VAULT_REL.inboxIngestProcessed)), false);
});

test('retry dry-run leaves no writes and CLI keeps comma filename as one path', (t) => {
  const { root, put } = fixture(t);
  const source = '00_Inbox/one,two.md';
  put(source, memo('옵시디언', '쉼표 제목'));
  assert.equal(retryMemo({ root, source, dryRun: true }).written, false);
  assert.equal(existsSync(join(root, VAULT_REL.inboxIngestProcessed)), false);
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'clio-inbox-ingest.mjs'),
    `--retry=${source}`, '--dry-run'], { env: { ...process.env, VAULT_PATH: root }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /00_Inbox\/one,two\.md/);
  assert.equal(existsSync(join(root, VAULT_REL.inboxIngestProcessed)), false);
  const written = spawnSync(process.execPath, [join(import.meta.dirname, 'clio-inbox-ingest.mjs'),
    `--retry=${source}`], { env: { ...process.env, VAULT_PATH: root }, encoding: 'utf8' });
  assert.equal(written.status, 0, written.stderr);
  const processed = JSON.parse(readFileSync(join(root, VAULT_REL.inboxIngestProcessed), 'utf8'));
  assert.deepEqual(Object.keys(processed), [source]);
});

test('regular run applies old and new valid plans in memo date order, continues after failure, skips applied, and keeps Wiki pending', async (t) => {
  const { root, put } = fixture(t);
  const events = [];
  const planItems = [];
  for (const [name, day, title] of [['old', '2026-10-09', '2026-10-09 오래된 메모'],
    ['bad', '2026-10-10', '2026-10-10 충돌 메모'], ['done', '2026-10-11', '2026-10-11 이미 적용'],
    ['new', '2026-10-12', '2026-10-12 새 메모']]) {
    const source = `00_Inbox/${name}.md`;
    const content = `---\norigin: "옵시디언"\ncreated: "${day}"\n---\n${name} 본문`;
    put(source, content);
    const value = judgment();
    value.target.title = title;
    value.dailyLink = null;
    value.wiki = [{ action: 'candidate', page: '30_Wiki/34_Topics/가상', reason: '가상 후보' }];
    planItems.push({ source, hash: createHash('sha256').update(content).digest('hex'), status: '계획함',
      judgment: value, sourceMeta: { occurredAt: day } });
  }
  put('95_Etna/Ingest/plans/2026-10-10.json', JSON.stringify({ items: planItems.slice(0, 3) }));
  put('95_Etna/Ingest/processed.json', JSON.stringify({ '00_Inbox/done.md': {
    hash: planItems[2].hash, target: 'already', appliedAt: '2026-10-11' } }));
  put('20_Records/21_Notes/2026/2026-10-10 충돌 메모.md', '이미 존재');
  assert.deepEqual(applicablePlans(root).map(({ item }) => item.source), ['00_Inbox/old.md', '00_Inbox/bad.md']);
  const result = await ingestRun({ root, rules, now: date, noSend: true, cooldown: () => false,
    charter: { model: 'test', systemPrompt: 'test' }, judge: async () => planItems[3].judgment,
    write: (path, content) => { if (path.endsWith('processed.json')) events.push(JSON.parse(content)); writeAtomic(path, content); } });
  assert.equal(result.applyResults.length, 3);
  assert.deepEqual(result.applyResults.map((item) => item.source), ['00_Inbox/old.md', '00_Inbox/bad.md', '00_Inbox/new.md']);
  assert.match(result.applyResults[1].failed, /대상 이미 있음/);
  assert.equal(result.applyResults[0].written, true);
  assert.equal(result.applyResults[2].written, true);
  assert.equal(result.applyResults[0].wikiPending.length, 1);
  assert.match(result.report, /Inbox ingest 적용 결과/);
  assert.match(result.report, /00_Inbox\/old.md → 20_Records/);
  assert.match(result.report, /적용 실패 1건 · Wiki 보류 2건/);
  assert.match(result.message.body, /적용 결과: 이동 2건/);
  const log = readFileSync(join(root, '60_Logs/Clio/2026-10.md'), 'utf8');
  assert.match(log, /Inbox apply: \[\[20_Records\/21_Notes\/2026\/2026-10-09 오래된 메모\]\] ← 00_Inbox\/old.md/);
  assert.match(log, /Inbox apply: \[\[20_Records\/21_Notes\/2026\/2026-10-12 새 메모\]\] ← 00_Inbox\/new.md/);
  assert.equal(events.length, 4);
});

test('regular preview makes no judgment, send, or write and counts retry and apply candidates', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/retry.md', memo('옵시디언', '재판단'));
  const source = '00_Inbox/planned.md';
  const content = memo('옵시디언', '기존 계획');
  put(source, content);
  put('95_Etna/Ingest/plans/2026-10-10.json', JSON.stringify({ items: [{ source,
    hash: createHash('sha256').update(content).digest('hex'), status: '계획함', judgment: judgment() }] }));
  const result = await ingestRun({ root, rules, now: date, dryRun: true, preview: true,
    judge: async () => { throw new Error('judge called'); }, send: async () => { throw new Error('send called'); },
    write: () => { throw new Error('write called'); } });
  assert.equal(result.retryCandidates, 1);
  assert.equal(result.applyCandidates, 1);
  assert.equal(result.written, false);
  assert.equal(result.sent, false);
});

test('regular run leaves unstarted applications for the next day at 05:30', async (t) => {
  const { root, put } = fixture(t);
  put('00_Inbox/memo.md', memo('옵시디언', '마감 직전 기록'));
  let elapsed = 0;
  const result = await ingestRun({ root, rules, now: new Date('2026-10-10T20:29:59Z'), noSend: true,
    clock: () => elapsed, cooldown: () => false, charter: { model: 'test', systemPrompt: 'test' },
    judge: async () => { elapsed = 1_000; return judgment(); } });
  assert.equal(result.items[0].status, '계획함');
  assert.equal(result.applyResults.length, 0);
  assert.equal(result.applyRemaining, 1);
  assert.ok(existsSync(join(root, '00_Inbox/memo.md')));
  assert.match(result.report, /적용 대기 1건/);
});
