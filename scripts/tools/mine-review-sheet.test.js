import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureCriteria } from '../lib/mine-emotion-criteria.fixture.js';
import { ambiguousSheet, anchorRefs, applyAnswers, emotionHint, firstMineStart, ownerFields, pendingAmbiguous, renderSheet, run, runView, sampleRecords, serveSheet, FAILURE_TYPES } from './mine-review-sheet.mjs';
import { PROMPT_VERSIONS, findTargets } from '../jobs/mine-athena-fields.mjs';
import { judgedNotes } from '../lib/mine-judgment.mjs';

const item = (rel, date, kind = '통화', body = '미네: 응') => ({ rel, date, fields: { convKind: kind }, content: `---\nconvKind: "${kind}"\n---\n${body}\n` });

test('표본: 2023년~·기준 예시 제외, 같은 씨앗이면 같은 결과, 절반은 감정 낱말, 녹음 비율 유지', () => {
  const targets = [
    ...Array.from({ length: 30 }, (_, i) => item(`r/${i}.md`, `2024-01-${String(i + 1).padStart(2, '0')}`)),
    ...Array.from({ length: 10 }, (_, i) => item(`h/${i}.md`, `2024-02-${String(i + 1).padStart(2, '0')}`, '통화', '미네: 너무 무서워')),
    item('rec.md', '2024-03-01', '녹음', '노래'), item('old.md', '2019-01-01', '통화', '미네: 좋아'), item('anchor.md', '2024-04-01'),
  ];
  const sample = sampleRecords(targets, new Set(['anchor.md']), { count: 10, seed: 's' });
  assert.equal(sample.length, 10);
  assert.ok(sample.every((entry) => entry.date >= '2023-01-01' && entry.rel !== 'anchor.md'));
  assert.ok(sample.some((entry) => entry.rel === 'rec.md'), '녹음 최소 1개');
  assert.ok(sample.filter((entry) => emotionHint(entry.content)).length >= 5, '절반은 감정 낱말');
  assert.deepEqual(sampleRecords(targets, new Set(['anchor.md']), { count: 10, seed: 's' }).map((e) => e.rel), sample.map((e) => e.rel));
  assert.deepEqual([...anchorRefs([{ ref: '20_Records/a.md' }, { ref: 'photo:0123456789abcdef' }, {}])], ['20_Records/a.md']);
  assert.equal(emotionHint('---\n---\n나: 무서워?\n미네: 아니'), false, '다른 화자의 감정 낱말은 세지 않음');
});

test('첫 미네 발화 위치: 전사 조각과 글자로 맞추고, 못 찾으면 첫 녹음 0초', () => {
  const content = '<!-- media-transcribe:id aaaaaaaaaaaaaaaa -->\n나: 뭐해\n<!-- media-transcribe:id bbbbbbbbbbbbbbbb -->\n미네: 그네 탔어 진짜 재밌었어\n';
  const transcripts = new Map([['aaaaaaaaaaaaaaaa', { segments: [{ start: 0, text: '뭐해' }] }],
    ['bbbbbbbbbbbbbbbb', { segments: [{ start: 1000, text: '응' }, { start: 15000, text: '그네 탔어 진짜 재밌었어' }] }]]);
  assert.deepEqual(firstMineStart(content, transcripts), { id: 'bbbbbbbbbbbbbbbb', seconds: 13 });
  assert.deepEqual(firstMineStart(content.replace(/미네: .*/, '나: 끝'), transcripts), { id: 'aaaaaaaaaaaaaaaa', seconds: 0 });
});

test('시트: 오너가 먼저 고르기 전에는 모델 답을 숨기고, 글자는 이스케이프, 두 번 다르면 표시', () => {
  const html = renderSheet([
    { no: 1, title: '<b>제목</b>', date: '2025-01-01', age: '만 8세', kind: '통화', text: '미네: <script>x</script>', audio: null,
      runs: [{ got: '기쁨 1', evidence: '웃음' }, { got: '감정 없음', evidence: '평온' }] },
  ], { title: '검수', storageKey: 'k', downloadName: 'a.json', promptVersion: 'v' });
  assert.match(html, /<div class="model" hidden>/);
  assert.match(html, /두 번 답이 다름/);
  assert.doesNotMatch(html, /<script>x<\/script>|<b>제목<\/b>/);
  assert.match(html, /&lt;script&gt;x/);
  for (const type of FAILURE_TYPES) assert.ok(html.includes(`data-v="${type}"`));
  assert.match(html, /c\.querySelector\('\.model'\)\.hidden=!ready\(a\)/, '오너 판단이 있어야 열림');
  assert.match(html, /a\.t&&a\.t!==c\.dataset\.title\)delete A/, '다른 기록 제목이 붙은 저장 답은 버린다');
});

test('serveSheet: 토큰 경로에서만 시트를 주고, 답은 시트 옆 JSON으로 저장하며, 이상한 답은 거절', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'review-serve-'));
  const sheetPath = join(dir, 'review-sheet-v.html');
  writeFileSync(sheetPath, '<p>시트</p>');
  const { server, answersPath } = serveSheet({ sheetPath, host: '127.0.0.1', port: 0, token: 'tok', output: { log() {} } });
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.equal((await fetch(`${base}/wrong/`)).status, 404);
  assert.match(await (await fetch(`${base}/tok/`)).text(), /시트/);
  assert.equal((await fetch(`${base}/tok/answers`, { method: 'POST', body: '[1]' })).status, 400);
  assert.equal((await fetch(`${base}/tok/answers`, { method: 'POST', body: '{"1":{"emo":"기쁨","int":1}}' })).status, 204);
  assert.equal(answersPath, join(dir, 'review-answers-v.json'));
  assert.deepEqual(JSON.parse(readFileSync(answersPath, 'utf8')), { 1: { emo: '기쁨', int: 1 } });
  assert.equal((await fetch(`${base}/tok/answers`, { method: 'POST', body: '{"2":{"emo":"모름"}}' })).status, 204);
  assert.deepEqual(await (await fetch(`${base}/tok/answers`)).json(), { 1: { emo: '기쁨', int: 1 }, 2: { emo: '모름' } }, '다른 브라우저 답은 덮지 않고 합친다');
  assert.match(await (await fetch(`${base}/tok/`)).text(), /시트/, '시트는 그대로');
  await fetch(`${base}/tok/answers`, { method: 'POST', body: 'x'.repeat(1_100_000) }).then((r) => assert.equal(r.status, 413), () => {});
  assert.throws(() => serveSheet({ sheetPath: join(dir, 'sheet.html'), host: '127.0.0.1', port: 0 }), /review-sheet-/);
  assert.throws(() => serveSheet({ sheetPath, host: '0.0.0.0', port: 0 }), /테일스케일/);
  assert.throws(() => serveSheet({ sheetPath, host: '192.168.0.5', port: 0 }), /테일스케일/);
  assert.match(renderSheet([], { title: 't', storageKey: 'k', downloadName: 'a.json', promptVersion: 'v' }), /fetch\('answers'/, '시트는 띄워졌을 때 답을 맥으로 보냄');
});

test('runView:대표 감정·감정 없음·모름·오류를 한 줄로', () => {
  assert.equal(runView({ fields: { primaryEmotion: '기쁨', emotionIntensity: 2, emotions: ['기쁨'], emotionEvidence: '웃음' } }).got, '기쁨 2');
  assert.equal(runView({ fields: { primaryEmotion: null, emotions: [] }, emotionState: '모름' }).got, '모름');
  assert.equal(runView({ fields: { primaryEmotion: null, emotions: [] }, emotionState: '감정 없음' }).got, '감정 없음');
  assert.deepEqual(runView({ error: '형식' }), { error: '형식' });
});

test('run: 기록마다 두 번 묻고, 다시 돌리면 이미 판단한 기록은 건너뛰며, 볼트에 쓰지 않는다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'review-sheet-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault'), anchorRoot = join(base, 'anchors'), out = join(base, 'out');
  const dir = join(root, '20_Records/23_Conversations/2025');
  mkdirSync(dir, { recursive: true });
  for (const day of ['10', '11', '12']) {
    writeFileSync(join(dir, `2025-01-${day} 미네 통화.md`), `---\ntype: "conversation"\ncategory: ["[[01_Home/201 미네]]"]\noccurred: "2025-01-${day}T19:00:00+09:00"\nconvKind: "통화"\nemotions: []\nprimaryEmotion: null\n---\n미네: 오늘 재밌었어\n\n## 오너 메모\n`);
  }
  mkdirSync(anchorRoot, { recursive: true });
  writeFileSync(join(anchorRoot, 'items-2026-10-19.json'), JSON.stringify([{ no: 1, ref: '20_Records/23_Conversations/2025/2025-01-12 미네 통화.md' }]));
  const before = readdirSync(root, { recursive: true }).sort();
  const answer = { emotionState: '있음', nearestAnchor: '없음', emotionEvidence: '재밌었다고 말함', secondFilmSignal: null,
    primary: '기쁨', levels: { 기쁨: '옅음', 슬픔: '없음', 버럭: '없음', 까칠: '없음', 소심: '없음' } };
  let calls = 0;
  const options = { root, anchorRoot, out, criteria: { ...fixtureCriteria, ref: 't' }, anchors: [], charter: { model: 'sonnet', systemPrompt: '' },
    cooldown: () => false, cues: async (items) => { for (const entry of items) entry.audioCues = { text: '' }; }, clip: () => null,
    output: { log() {}, error() {} }, claude: async () => { calls += 1; return JSON.stringify(answer); } };
  const first = await run(options);
  assert.equal(first.cards.length, 2, '기준 예시 노트는 빠진다');
  assert.equal(calls, 4, '기록마다 두 번');
  assert.ok(first.cards.every((card) => card.runs.length === 2 && card.runs[0].got === '기쁨 1'));
  assert.ok(existsSync(first.sheetPath));
  assert.match(readFileSync(first.sheetPath, 'utf8'), /미네 감정 첫 검수/);
  await run(options);
  assert.equal(calls, 4, '다시 돌리면 묻지 않는다');
  const cardsPath = join(out, PROMPT_VERSIONS.ollama.split('/').pop(), `cards-${PROMPT_VERSIONS.ollama.split('/').pop()}.json`);
  writeFileSync(cardsPath, JSON.stringify([{ no: 1, rel: 'other.md' }]));
  await assert.rejects(run(options), /표본이 바뀌어 번호표가 달라짐/, '번호표가 다르면 덮지 않고 멈춘다');
  assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before, '볼트는 그대로');
  const cooled = await run({ ...options, out: join(base, 'out2'), cooldown: () => true });
  assert.equal(cooled.stopped, 'Claude 쿨다운');
  let flaky = 0;
  const failing = { ...options, out: join(base, 'out3'), claude: async () => { flaky += 1; if (flaky === 1) throw new Error('시간 초과'); return JSON.stringify(answer); } };
  const firstTry = await run(failing);
  assert.ok(firstTry.cards.some((card) => card.runs.some((entry) => entry.error)), '오류도 시트에는 보인다');
  await run(failing);
  assert.equal(flaky, 6, '오류가 섞인 기록만 다시 묻는다');
  assert.ok((await run(failing)).cards.every((card) => card.runs.every((entry) => !entry.error)));
});

const rules = [{ type: 'conversation', path: '20_Records/23_Conversations/{YYYY}/', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/[^/]+\.md$/,
  titleRegex: /^\d{4}-\d{2}-\d{2} \S/, required: { bundle: ['type', 'category', 'description'], extra: [] } }];
const convNote = (day, extra = '') => `---\ntype: "conversation"\ncategory: ["[[01_Home/201 미네]]"]\ndescription: "미네 통화"\nmodified: "2025-01-${day}"\noccurred: "2025-01-${day}T19:00:00+09:00"\nconvKind: "통화"${extra}\n---\n미네: 오늘 재밌었어\n\n## 오너 메모\n`;
const claudeRow = (rel, status, extra = {}) => ({ rel, status, engine: 'claude', model: 'sonnet', criteriaRef: null, promptVersion: PROMPT_VERSIONS.claude, ...extra });
const answer = (state, primary, intensity) => ({ emotionState: state, fields: { emotions: primary ? [primary] : [], primaryEmotion: primary, emotionIntensity: intensity, emotionEvidence: '근거' } });

test('pendingAmbiguous: 지금 판의 마지막 기록이 애매함이고 오너 줄이 뒤에 없는 노트만', () => {
  const rows = [claudeRow('a.md', 'ambiguous', { answers: [] }), claudeRow('b.md', 'ambiguous', { answers: [] }), { rel: 'b.md', engine: 'owner', status: 'applied' },
    claudeRow('c.md', 'ambiguous', { answers: [], promptVersion: 'athena-fields/0.9' }), claudeRow('d.md', 'ambiguous', { answers: [] }), claudeRow('d.md', 'applied')];
  assert.deepEqual(pendingAmbiguous(rows).map((row) => row.rel), ['a.md']);
});

test('ownerFields: 감정·강도 → 필드, 감정 없음·모름은 비움, 덜 고르면 null', () => {
  assert.deepEqual(ownerFields({ emo: '슬픔', int: 1, memo: '혼자 밥 먹음' }),
    { emotions: ['슬픔'], primaryEmotion: '슬픔', emotionIntensity: 1, secondFilmSignal: null, emotionEvidence: '오너 판단(검수 시트): 혼자 밥 먹음' });
  assert.equal(ownerFields({ emo: '감정 없음' }).primaryEmotion, null);
  assert.match(ownerFields({ emo: '모름' }).emotionEvidence, /^모름: 오너 판단/);
  assert.equal(ownerFields({ emo: '기쁨' }), null, '강도 없이 감정만 고르면 쓰지 않는다');
  assert.equal(ownerFields(undefined), null);
});

test('애매함 시트 → 오너 답 반영: 감정 필드만 바꾸고 백업·오너 줄을 남기며, 반영한 노트는 다시 묻지 않는다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'review-ambiguous-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault'), out = join(base, 'out');
  const dir = join(root, '20_Records/23_Conversations/2025');
  mkdirSync(dir, { recursive: true });
  const [one, two, three] = ['10', '11', '12'].map((day) => `20_Records/23_Conversations/2025/2025-01-${day} 미네 통화.md`);
  writeFileSync(join(root, one), convNote('10'));
  writeFileSync(join(root, two), convNote('11', '\nemotions: ["기쁨"]\nprimaryEmotion: "기쁨"\nemotionIntensity: 1\nemotionEvidence: "옛 판"\nsecondFilmSignal: null\nimportance: 3\nmineAge: 8'));
  writeFileSync(join(root, three), convNote('12'));
  const judgmentsPath = join(base, 'judgments.jsonl');
  writeFileSync(judgmentsPath, [one, two, three].map((rel) => JSON.stringify(claudeRow(rel, 'ambiguous', { answers: [answer('있음', '기쁨', 2), answer('감정 없음', null, null)] }))).join('\n') + '\n');
  const quiet = { log() {}, error() {} };
  const sheet = await ambiguousSheet({ root, out, judgmentsPath, now: new Date('2026-10-31T03:00:00Z'), clip: () => null, output: quiet });
  assert.equal(sheet.cards.length, 3);
  assert.match(readFileSync(sheet.sheetPath, 'utf8'), /미네 감정 애매함 검수[\s\S]*두 번 답이 다름[\s\S]*기쁨 2[\s\S]*감정 없음/);
  const title = (rel) => rel.split('/').pop().replace(/\.md$/, '');
  assert.deepEqual(JSON.parse(readFileSync(sheet.cardsPath, 'utf8')), [one, two, three].map((rel, index) => ({ no: index + 1, rel, title: title(rel) })));
  assert.match(sheet.cardsPath, /ambiguous-2026-10-31-12-00\/cards-ambiguous-2026-10-31-12-00\.json$/);
  await assert.rejects(ambiguousSheet({ root, out, judgmentsPath, now: new Date('2026-10-31T03:00:00Z'), clip: () => null, output: quiet }), /이미 있는 시트/);
  const answersPath = join(base, 'review-answers-ambiguous-2026-10-31-12-00 (1).json');
  writeFileSync(answersPath, JSON.stringify({ 1: { t: title(one), emo: '슬픔', int: 1, type: '감정이 다름' }, 2: { t: title(two), emo: '감정 없음', type: '맞음' }, 3: { t: title(three), emo: '기쁨' } }));
  await assert.rejects(applyAnswers({ answersPath: join(base, 'review-answers-other.json'), cardsPath: sheet.cardsPath, root, out, judgmentsPath, rules, output: quiet }), /같은 시트가 아님/);
  const before = readFileSync(join(root, one), 'utf8');
  const preview = await applyAnswers({ answersPath, cardsPath: sheet.cardsPath, root, out, judgmentsPath, rules, dryRun: true, output: quiet });
  assert.deepEqual([preview.applied.length, readFileSync(join(root, one), 'utf8')], [2, before], '미리보기는 쓰지 않는다');
  const summary = await applyAnswers({ answersPath, cardsPath: sheet.cardsPath, root, out, judgmentsPath, rules, now: new Date('2026-10-31T03:00:00Z'), output: quiet });
  assert.deepEqual([summary.applied, summary.partial, summary.unanswered, summary.errors], [[one, two], [three], [], []]);
  assert.match(readFileSync(join(root, one), 'utf8'), /modified: "2026-10-31"[\s\S]*emotions: \["슬픔"\]\nprimaryEmotion: "슬픔"\nemotionIntensity: 1\nemotionEvidence: "오너 판단\(검수 시트\)"\nsecondFilmSignal: null\nmineAge: 8\n---/, '첫 분류면 나이를 채운다');
  const kept = readFileSync(join(root, two), 'utf8');
  assert.match(kept, /emotions: \[\]\nprimaryEmotion: null/);
  assert.match(kept, /importance: 3\nmineAge: 8/, '중요도·나이는 그대로');
  const backup = readFileSync(join(out, 'owner-apply-backup-2026-10-31.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(backup.map((row) => [row.rel, row.fields.primaryEmotion]), [[one, null], [two, '기쁨']]);
  assert.match(backup[1].frontmatter, /emotionEvidence: "옛 판"/, '원래 머리말 전체를 백업');
  const rows = readFileSync(judgmentsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.slice(3).map((row) => [row.rel, row.engine, row.status]), [[one, 'owner', 'applied'], [two, 'owner', 'applied']]);
  assert.deepEqual(pendingAmbiguous(rows).map((row) => row.rel), [three], '남은 애매함만 다음 시트에');
  assert.ok(judgedNotes(rows, { engine: 'claude', model: 'sonnet', criteriaRef: null, promptVersion: 'athena-fields/9.9' }).has(one), '다음 판도 다시 묻지 않는다');
  assert.equal(findTargets(root, { reclassify: true, kind: 'all', includeUnclassified: true, ids: [one, three] }).map((item) => item.rel).join(), three,
    '노트 표식만으로도(옮겨도) 모델이 덮지 않는다');
});

test('--apply 대조: 답에 남은 제목·번호표 제목·노트 이름이 어긋나거나 블록 목록 머리말이면 그 카드는 쓰지 않는다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'review-apply-guard-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  mkdirSync(join(root, '20_Records/23_Conversations/2025'), { recursive: true });
  const rels = ['10', '11', '12'].map((day) => `20_Records/23_Conversations/2025/2025-01-${day} 미네 통화.md`);
  writeFileSync(join(root, rels[0]), convNote('10'));
  writeFileSync(join(root, rels[1]), convNote('11'));
  writeFileSync(join(root, rels[2]), convNote('12', '\ntags:\n  - 미네'));
  const cardsPath = join(base, 'cards-x.json');
  writeFileSync(cardsPath, JSON.stringify([{ no: 1, rel: rels[0], title: '2025-01-10 미네 통화' }, { no: 2, rel: rels[1], title: '2025-01-99 다른 통화' },
    { no: 3, rel: rels[2], title: '2025-01-12 미네 통화' }]));
  const answersPath = join(base, 'review-answers-x.json');
  writeFileSync(answersPath, JSON.stringify({ 1: { t: '2025-01-11 미네 통화', emo: '감정 없음' }, 2: { emo: '감정 없음' }, 3: { emo: '감정 없음' } }));
  const summary = await applyAnswers({ answersPath, cardsPath, root, out: join(base, 'out'), judgmentsPath: join(base, 'j.jsonl'), rules, output: { log() {}, error() {} } });
  const reasons = summary.errors.map((error) => error.reason);
  assert.equal(reasons.length, 3);
  [/^답을 고른 기록/, /^번호표 제목과 노트 이름이 다름/, /^머리말에 블록 목록/].forEach((pattern, index) => assert.match(reasons[index], pattern));
  assert.equal(readFileSync(join(root, rels[0]), 'utf8'), convNote('10'));
  assert.equal(existsSync(join(base, 'j.jsonl')), false);
});

test('--apply: 애매함 시트 답은 기록 제목(t)이 있어야 한다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'review-apply-t-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  mkdirSync(join(root, '20_Records/23_Conversations/2025'), { recursive: true });
  const rel = '20_Records/23_Conversations/2025/2025-01-10 미네 통화.md';
  writeFileSync(join(root, rel), convNote('10', '\n\nnote: "빈 줄 뒤"'));
  const cardsPath = join(base, 'cards-ambiguous-x.json');
  writeFileSync(cardsPath, JSON.stringify([{ no: 1, rel, title: '2025-01-10 미네 통화' }]));
  const answersPath = join(base, 'review-answers-ambiguous-x.json');
  writeFileSync(answersPath, JSON.stringify({ 1: { emo: '감정 없음' } }));
  const opts = { cardsPath, root, out: join(base, 'out'), judgmentsPath: join(base, 'j.jsonl'), rules, output: { log() {}, error() {} } };
  assert.match((await applyAnswers({ ...opts, answersPath })).errors[0].reason, /제목\(t\)이 없음/);
  writeFileSync(answersPath, JSON.stringify({ 1: { t: '2025-01-10 미네 통화', emo: '감정 없음' } }));
  assert.equal((await applyAnswers({ ...opts, answersPath })).applied.length, 1, '빈 줄은 블록 목록이 아니다');
});
