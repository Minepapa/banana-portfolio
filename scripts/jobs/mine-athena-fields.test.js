import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fixture as criteriaFixture, fixtureCriteria as criteria } from '../lib/mine-emotion-criteria.fixture.js';

// Ollama 0.1 시험용 기준 예시(결정 §10 표 모양). 진짜 결정 문서를 읽지 않게 주입한다.
const anchors = [
  { id: 'joy-1', verdict: '기쁨 1', record: '2026-07-15 미네 통화 등굣길', no: 2, why: '매주 있을 수 있는 기쁨' },
  { id: 'none-a', verdict: '감정 없음', record: '2025-04-13 미네 통화 놀이 마무리', no: 14, why: '일상적인 협상' },
];
// v0.2 답(모든 감정 세기 단어). over로 일부만 바꾼다.
const scored = (over = {}) => ({ emotionState: '있음', nearestAnchor: 'joy-1', emotionEvidence: '미네가 웃음', secondFilmSignal: null, primary: null,
  ...over, levels: { 기쁨: '없음', 슬픔: '없음', 버럭: '없음', 까칠: '없음', 소심: '없음', ...(over.levels ?? {}) } });
// Claude 1.0 답 한 건(JSON 문자열). extra로 importance 등을 붙인다.
const reply = (over = {}, extra = {}) => JSON.stringify({ ...scored(over), ...extra });
const joy2 = (extra = {}) => reply({ levels: { 기쁨: '보통' } }, extra);
const claude = { charter: { model: 'sonnet', systemPrompt: '' }, anchors };
import { parseEmotionCriteria } from '../lib/mine-emotion-criteria.mjs';
import { applyFields, defaultJudgmentsPath, failed, findTargets, judgeItems, mineAge, noteText, ollamaDecision, ollamaProposalSchema, buildOllamaPrompt, validateOllamaProposals, proposalSchema, recentSignalTrend, reclassify,
  restrictedDecision, reclassifyFailed, run, CLAUDE_RUNS, DAILY_CLAUDE_CALLS, PROMPT_VERSIONS, STATE_REL } from './mine-athena-fields.mjs';
import { OLLAMA_MODELS } from '../lib/ollama-client.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

const now = new Date('2026-10-18T12:00:00Z'); // KST 10-18 21:00
const rules = [
  { type: 'conversation', path: '20_Records/23_Conversations/{YYYY}/', pathRegex: /^20_Records\/23_Conversations\/\d{4}\/[^/]+\.md$/,
    titleRegex: /^\d{4}-\d{2}-\d{2} \S/, required: { bundle: ['type', 'category', 'description'], extra: [] } },
];
const note = ({ category = '["[[01_Home/200 가족]]", "[[01_Home/201 미네]]"]', occurred = '2026-10-15T19:00:00.000+09:00', extra = '', body = '전사 본문' } = {}) =>
  `---\ntype: "conversation"\ncategory: ${category}\ndescription: "미네 통화"\nmodified: "2026-10-15"\noccurred: "${occurred}"\nconvKind: "통화"${extra}\n---\n<!-- media-transcribe:start -->\n${body}\n<!-- media-transcribe:end -->\n\n## 오너 메모\n`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mine-athena-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel, content) => { const path = join(root, rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  return { root, put };
}
const C = '20_Records/23_Conversations';

test('제한 판단은 옵션을 전달하고 JSON result·토큰 사용량을 기록한 뒤 cwd를 지운다', async () => {
  let invocation;
  let log = '';
  const result = await restrictedDecision('prompt', { model: 'sonnet', systemPrompt: 'charter' }, {
    invoke: async (...args) => {
      invocation = args;
      assert.match(args[3].cwd, /^\/tmp\/mine-athena-claude-/);
      assert.equal(args[3].cwd.startsWith(`${process.cwd()}/`), false);
      assert.equal(existsSync(args[3].cwd), true);
      assert.deepEqual(readdirSync(args[3].cwd), []);
      return JSON.stringify({ result: '[{"id":1}]', usage: {
        input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 4 } });
    },
    output: { log(message) { log = message; } },
  });
  assert.equal(result, '[{"id":1}]');
  assert.deepEqual(invocation.slice(0, 3), ['prompt', 'sonnet', '']);
  assert.deepEqual(invocation[3], {
    appendSystemPrompt: 'charter', lean: true, tools: '', maxTurns: 1,
    cwd: invocation[3].cwd, timeoutMs: 5 * 60_000,
  });
  assert.equal(existsSync(invocation[3].cwd), false);
  assert.match(log, /"inputTokens":60,"outputTokens":4/);
});

test('제한 판단은 오류에서도 임시 cwd를 지운다', async () => {
  let cwd;
  await assert.rejects(restrictedDecision('prompt', { model: 'sonnet', systemPrompt: '' }, {
    invoke: async (_prompt, _model, _tools, options) => {
      cwd = options.cwd;
      throw new Error('실패');
    },
    output: { log() {} },
  }), /실패/);
  assert.equal(existsSync(cwd), false);
});

test('mineAge는 생일(11-04) 전후로 만 나이를 계산한다', () => {
  assert.equal(mineAge('2026-11-03T10:00:00+09:00'), 9);
  assert.equal(mineAge('2026-11-04'), 10);
  assert.equal(mineAge('2016-11-04'), 0);
  assert.equal(mineAge('2016-01-01'), null);
  assert.equal(mineAge(''), null);
  assert.equal(mineAge('2026-11-03T16:00:00Z'), 10); // KST 11-04 01:00
});

test('대상은 201 미네·아테나 키 없음·건너뜀 기록 없음·cutoff 이전 노트만', (t) => {
  const { root, put } = fixture(t);
  put(`${C}/2026/2026-10-15 미네 통화.md`, note());
  put(`${C}/2026/2026-10-14 미네 통화.md`, note({ occurred: '2026-10-14T19:00:00+09:00', extra: '\nprimaryEmotion: "기쁨"' }));
  put(`${C}/2026/2026-10-13 휘영 통화.md`, note({ category: '["[[01_Home/202 휘영]]"]' }));
  put(`${C}/2026/2026-10-16 미네 통화.md`, note({ occurred: '2026-10-16T09:00:00+09:00' }));
  put(`${C}/2026/2026-10-12 미네 통화.md`, note({ occurred: '2026-10-12T09:00:00+09:00' }));
  put(`${C}/2026/2026-10-11 미네 통화.md`, note({ occurred: '2026-10-11T09:00:00+09:00', extra: '\nimportance: 4' }));
  const targets = findTargets(root, { skipped: { [`${C}/2026/2026-10-12 미네 통화.md`]: { reason: 'x' } }, cutoff: '2026-10-16' });
  assert.deepEqual(targets.map((x) => x.rel), [`${C}/2026/2026-10-15 미네 통화.md`]);
});

test('noteText는 머리말·주석을 빼고 길이를 자른다, 프롬프트에 제목과 나이가 들어간다', () => {
  const text = noteText(note({ body: '가'.repeat(50) }), 10);
  assert.equal(text, `${'가'.repeat(10)}…(이하 생략)`);
  const prompt = buildOllamaPrompt([{ rel: `${C}/2026/2026-10-15 미네 통화.md`, content: note(), occurred: '2026-10-15', date: '2026-10-15' }], { criteria, anchors });
  assert.match(prompt, /### 2026-10-15 미네 통화\n/);
  assert.match(prompt, /만 9세/);
});

test('applyFields는 닫는 --- 앞에 붙이고 modified만 바꾼다, 이미 있으면 null', () => {
  const next = applyFields(note(), { emotions: ['기쁨'], primaryEmotion: '기쁨', emotionIntensity: 2, emotionEvidence: '미네가 웃음', importance: 2 }, 9, '2026-10-18');
  assert.match(next, /modified: "2026-10-18"\n/);
  assert.match(next, /convKind: "통화"\nemotions: \["기쁨"\]\nprimaryEmotion: "기쁨"\nemotionIntensity: 2\nemotionEvidence: "미네가 웃음"\nsecondFilmSignal: null\nimportance: 2\nmineAge: 9\n---\n<!-- media-transcribe:start -->/);
  assert.equal(next.endsWith('## 오너 메모\n'), true);
  assert.equal(applyFields(next, { emotions: ['슬픔'], primaryEmotion: '슬픔', emotionIntensity: 2, emotionEvidence: '미네가 울음', importance: 1 }, 9, '2026-10-18'), null);
  assert.equal(applyFields(note({ extra: '\nimportance: 4' }), { emotions: ['슬픔'], primaryEmotion: '슬픔', emotionIntensity: 2, emotionEvidence: '미네가 울음', importance: 1 }, 9, '2026-10-18'), null);
});

test('run: dry-run은 아테나를 부르지 않고, 쿨다운이면 건너뛴다', async (t) => {
  const { root, put } = fixture(t);
  put(`${C}/2026/2026-10-15 미네 통화.md`, note());
  const judge = () => { throw new Error('호출되면 안 됨'); };
  const quiet = { log() {}, error() {} };
  const dry = await run({ root, now, dryRun: true, judge, rules, criteria, output: quiet });
  assert.equal(dry.targets, 1);
  const cooled = await run({ root, now, judge, cooldown: () => true, rules, criteria, output: quiet });
  assert.equal(cooled.cooldown, true);
  assert.equal(readFileSync(join(root, `${C}/2026/2026-10-15 미네 통화.md`), 'utf8'), note());
});

test('run: 두 답이 같으면 쓰고, 다르면 애매함으로 남겨 다시 묻지 않으며, 형식 오류는 재시도', async (t) => {
  const { root, put } = fixture(t);
  const [same, split, broken] = ['2026-10-15', '2026-10-16', '2026-10-17'].map((day) => `${C}/2026/${day} 미네 통화.md`);
  put(same, note({ occurred: '2026-10-12T09:00:00+09:00' }));
  put(split, note({ occurred: '2026-10-13T09:00:00+09:00' }));
  put(broken, note({ occurred: '2026-10-14T09:00:00+09:00' }));
  put(`${C}/2026/2026-10-18 미네 녹음.md`, note({ occurred: '2026-10-15', extra: '\nemotions: ["소심"]\nprimaryEmotion: "소심"\nsecondFilmSignal: "불안"\nemotionEvidence: "미네가 내일 일을 걱정함"' }));
  const prompts = [];
  const asked = {};
  const judge = async (prompt, { items: [item] }) => {
    prompts.push(prompt);
    asked[item.rel] = (asked[item.rel] ?? 0) + 1;
    if (item.rel === split) return asked[item.rel] === 1 ? joy2({ importance: 2 }) : reply({ emotionState: '감정 없음' }, { importance: 2 });
    if (item.rel === broken) return reply({ levels: { 행복: '보통' } }, { importance: 2 });
    return reply({ levels: { 기쁨: '보통' } }, { importance: 4 });
  };
  const quiet = { log() {}, error() {} };
  const summary = await run({ root, now, judge, cooldown: () => false, criteria, ...claude, rules, output: quiet });
  assert.match(prompts[0], /# 최근 사춘기 신호 관찰 .*: 1건 — 불안 1건/);
  assert.deepEqual(asked, { [same]: CLAUDE_RUNS, [split]: 2, [broken]: 1 }, '형식 오류가 나면 두 번째는 묻지 않는다');
  assert.deepEqual(summary.written.map((x) => x.rel), [same]);
  assert.match(readFileSync(join(root, same), 'utf8'), /primaryEmotion: "기쁨"\nemotionIntensity: 2\n[\s\S]*importance: 4\nmineAge: 9\n---/);
  assert.deepEqual(summary.ambiguous, [{ rel: split, answers: ['있음|기쁨|2', '감정 없음||'] }]);
  assert.equal(readFileSync(join(root, split), 'utf8'), note({ occurred: '2026-10-13T09:00:00+09:00' }), '애매함은 노트에 쓰지 않는다');
  assert.equal(summary.invalid.length, 1);
  assert.equal(failed(summary), false);
  const rows = readFileSync(join(root, '.mine-judgments', 'athena-judgments.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const ambiguous = rows.find((row) => row.status === 'ambiguous');
  assert.equal(ambiguous.calls, 2);
  assert.deepEqual(ambiguous.answers.map((answer) => [answer.emotionState, answer.fields.primaryEmotion]), [['있음', '기쁨'], ['감정 없음', null]]);
  assert.equal(rows.find((row) => row.status === 'applied').promptVersion, 'athena-fields/1.0');

  const again = await run({ root, now, criteria, judge: async (_prompt, { items: [item] }) => { asked[item.rel] += 1; return joy2({ importance: 2 }); },
    cooldown: () => false, ...claude, rules, output: quiet });
  assert.deepEqual(again.written.map((x) => x.rel), [broken], '애매함은 같은 판으로 다시 묻지 않는다');
  assert.equal(asked[split], 2);
  assert.equal(existsSync(join(root, `${broken}.lock`)), false);
});

test('run: 판단 중 노트가 바뀌면 쓰지 않고 재시도, 아테나 오류도 그 기록만 재시도하고 파일은 그대로', async (t) => {
  const { root, put } = fixture(t);
  const rel = `${C}/2026/2026-10-15 미네 통화.md`;
  put(rel, note());
  const quiet = { log() {}, error() {} };
  const opts = { root, now, criteria, cooldown: () => false, ...claude, rules, output: quiet };
  const summary = await run({ ...opts, judge: async () => {
    put(rel, note({ body: '전사 본문\n추가된 통화' }));
    return joy2({ importance: 2 });
  } });
  assert.equal(summary.written.length, 0);
  assert.equal(summary.invalid[0].reason, '판단 중 노트가 바뀜');
  assert.equal(failed(summary), true);
  assert.equal(readFileSync(join(root, rel), 'utf8'), note({ body: '전사 본문\n추가된 통화' }));
  const crashed = await run({ ...opts, judgmentsPath: join(root, 'crash.jsonl'), judge: async () => { throw new Error('claude 종료코드 1'); } });
  assert.match(crashed.invalid[0].reason, /claude 종료코드/, '호출 오류는 그 기록만 재시도');
  assert.equal(failed(crashed), true);
  const prose = await run({ ...opts, judgmentsPath: join(root, 'prose.jsonl'), judge: async () => '설명만 있고 JSON 없음' });
  assert.match(prose.invalid[0].reason, /JSON/);
  assert.equal(existsSync(join(root, `${STATE_REL}.lock`)), false);
});

test('failed: 오류가 있거나 하나도 처리하지 못했을 때만 실패, 쿨다운·대상 없음은 정상', () => {
  const base = { targets: 2, written: [], skipped: [], invalid: [], errors: 0 };
  assert.equal(failed({ ...base, invalid: [{}] }), true);
  assert.equal(failed({ ...base, invalid: [{}], written: [{}] }), false);
  assert.equal(failed({ ...base, written: [{}], errors: 1 }), true);
  assert.equal(failed({ ...base, cooldown: true, invalid: [{}] }), false);
  assert.equal(failed({ ...base, targets: 0 }), false);
  assert.equal(failed({ ...base, cooldown: true, errors: 1 }), true, '쿨다운이 같은 회차의 쓰기 관문 오류를 가리지 않는다');
  assert.equal(failed({ ...base, invalid: [{}], ambiguous: [{}] }), false, '애매함은 처리한 것');
});

test('주간 로그용 신호 추이는 최근 발생 기록의 건수·종류·근거를 집계한다', (t) => {
  const { root, put } = fixture(t);
  put(`${C}/2026/2026-10-15 미네 녹음.md`, note({ extra: '\nsecondFilmSignal: "불안"\nemotionEvidence: "미네가 앞날을 걱정함"' }));
  put(`${C}/2026/2026-10-14 미네 녹음.md`, note({ occurred: '2026-10-14', extra: '\nsecondFilmSignal: "부럽"\nemotionEvidence: "친구 물건을 갖고 싶어함"' }));
  put(`${C}/2026/2026-10-01 미네 녹음.md`, note({ occurred: '2026-10-01', extra: '\nsecondFilmSignal: "따분"' }));
  const trend = recentSignalTrend(root, '2026-10-18', criteria);
  assert.deepEqual(trend.counts, { 부럽: 1, 불안: 1 });
  assert.equal(trend.total, 2);
  assert.equal(trend.examples.length, 2);
});

test('녹음 재분류는 백업 0600 후 감정 네 필드만 바꾸며 오너 메모를 보존한다', async (t) => {
  const { root, put } = fixture(t);
  const out = mkdtempSync(join(tmpdir(), 'mine-reclassify-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const rel = `${C}/2026/2026-10-15 미네 녹음.md`;
  const original = note({ body: '미네: 즐거워\n엄마: 그래', extra: '\nemotions: ["슬픔"]\nprimaryEmotion: "슬픔"\nimportance: 4\ncoreMemory: true\nmineAge: 9' })
    .replace('convKind: "통화"', 'convKind: "녹음"').replace('## 오너 메모\n', '## 오너 메모\n감정: 슬픔\n');
  put(rel, original);
  put(`${C}/2026/2026-10-14 미네 통화.md`, note({ extra: '\nemotions: ["기쁨"]\nprimaryEmotion: "기쁨"' }));
  const quiet = { log() {}, error() {} };
  const options = { root, out, now, rules, criteria, output: quiet, cooldown: () => false, maxNotes: 10, anchors,
    judge: async () => reply({ levels: { 기쁨: '보통' }, emotionEvidence: '미네가 즐거워라고 말함' }) };
  const dry = await reclassify({ ...options, dryRun: true, judge: undefined });
  assert.equal(dry.targets, 1);
  assert.equal(existsSync(join(out, 'reclassify-backup-2026-10-18.jsonl')), false);
  const first = await reclassify(options);
  assert.equal(first.changed, 1);
  const backup = join(out, 'reclassify-backup-2026-10-18.jsonl');
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  const backedUp = JSON.parse(readFileSync(backup, 'utf8').trim()).fields;
  assert.equal(backedUp.primaryEmotion, '슬픔');
  assert.equal(backedUp.modified, '2026-10-15');
  assert.equal(backedUp.secondFilmSignal, null);
  const after = readFileSync(join(root, rel), 'utf8');
  assert.match(after, /emotions: \["슬픔"\]/);
  assert.match(after, /emotionIntensity: 2/);
  assert.match(after, /emotionEvidence: "미네가 즐거워라고 말함"/);
  assert.match(after, /importance: 4/);
  assert.match(after, /coreMemory: true/);
  assert.match(after, /## 오너 메모\n감정: 슬픔/);
  // 같은 판(엔진·모델·기준·프롬프트)으로 판단을 마친 노트는 다시 고르지 않는다.
  const second = await reclassify({ ...options, dryRun: true });
  assert.equal(second.targets, 0);
  assert.equal(readFileSync(join(root, rel), 'utf8'), after);
  const judgments = readFileSync(join(out, 'athena-judgments.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(judgments.map(({ rel: note, status, mode, engine, model, promptVersion }) => ({ note, status, mode, engine, model, promptVersion })),
    [{ note: rel, status: 'applied', mode: 'reclassify', engine: 'claude', model: judgments[0].model, promptVersion: PROMPT_VERSIONS.claude }]);
  assert.equal(judgments[0].calls, CLAUDE_RUNS);
  assert.equal(statSync(join(out, 'athena-judgments.jsonl')).mode & 0o777, 0o600);
  // 기준 판이 바뀌면 다시 대상이 되고, 같은 답이면 노트는 그대로 둔다.
  const repeated = await reclassify({ ...options, criteria: { ...criteria, ref: '미네-감정-분류@다음판' } });
  assert.equal(repeated.selected, 1);
  assert.equal(repeated.changed, 0);
  assert.equal(readFileSync(join(root, rel), 'utf8'), after);
  const report = join(out, 'reclassify-report-2026-10-18.md');
  assert.equal((readFileSync(report, 'utf8').match(/# 미네 녹음 감정 재분류/g) ?? []).length, 2);
  assert.equal(statSync(report).mode & 0o777, 0o600);
  assert.match(readFileSync(report, 'utf8'), /secondFilmSignal 분포 \(이번 처리 묶음\)/);
});

test('같은 날 외부 수정 뒤 재분류는 새 사전 상태를 쓰기 전에 다시 백업한다', async (t) => {
  const { root, put } = fixture(t);
  const out = mkdtempSync(join(tmpdir(), 'mine-reclassify-backup-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const rel = `${C}/2026/2026-10-15 미네 녹음.md`;
  put(rel, note({ extra: '\nemotions: ["슬픔"]\nprimaryEmotion: "슬픔"' }).replace('convKind: "통화"', 'convKind: "녹음"'));
  const backup = join(out, 'reclassify-backup-2026-10-18.jsonl');
  const options = { root, out, now, rules, criteria, output: { log() {} }, cooldown: () => false, anchors, judge: async () => joy2() };
  await reclassify(options);
  const externallyChanged = readFileSync(join(root, rel), 'utf8').replace('emotions: ["기쁨"]', 'emotions: ["버럭"]')
    .replace('primaryEmotion: "기쁨"', 'primaryEmotion: "버럭"')
    .replace('modified: "2026-10-18"', 'modified: "2026-10-17"');
  writeFileSync(join(root, rel), externallyChanged);
  await reclassify({ ...options, write: (path, content) => {
    const entries = readFileSync(backup, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.length, 2);
    assert.equal(entries[1].fields.primaryEmotion, '버럭');
    assert.equal(entries[1].fields.modified, '2026-10-17');
    writeFileSync(path, content);
  } });
  assert.equal(statSync(backup).mode & 0o777, 0o600);
});

test('빈 감정과 null 대표 감정도 녹음 재분류 대상이며 정확한 id만 선택한다', (t) => {
  const { root, put } = fixture(t);
  const rel = `${C}/2026/2026-10-15 미네 녹음.md`;
  const content = note({ extra: '\nemotions: []\nprimaryEmotion: null\nimportance: 2' })
    .replace('convKind: "통화"', 'convKind: "녹음"')
    .replace('<!-- media-transcribe:start -->', '<!-- media-transcribe:start -->\n<!-- media-transcribe:id aabbccddeeff0011 -->');
  put(rel, content);
  assert.equal(findTargets(root, { reclassify: true, cutoff: '2026-10-18' }).length, 1);
  assert.equal(findTargets(root, { reclassify: true, ids: ['aabbccddeeff0011'], cutoff: '2026-10-18' }).length, 1);
  assert.equal(findTargets(root, { reclassify: true, ids: ['aabb'], cutoff: '2026-10-18' }).length, 0);
});

test('재분류 kind는 통화·녹음·all을 선택하고 기본은 녹음이다', (t) => {
  const { root, put } = fixture(t);
  put(`${C}/2026/2026-10-15 미네 통화.md`, note({ extra: '\nemotions: []\nprimaryEmotion: null' }));
  put(`${C}/2026/2026-10-14 미네 녹음.md`, note({ occurred: '2026-10-14',
    extra: '\nemotions: []\nprimaryEmotion: null' }).replace('convKind: "통화"', 'convKind: "녹음"'));
  const find = (kind) => findTargets(root, { reclassify: true, cutoff: '2026-10-18', ...(kind ? { kind } : {}) });
  assert.equal(find().length, 1);
  assert.equal(find('통화').length, 1);
  assert.equal(find('all').length, 2);
  assert.equal(find('녹음')[0].fields.convKind, '녹음');
  assert.equal(find('통화')[0].fields.convKind, '통화');
  assert.equal(findTargets(root, { reclassify: true, cutoff: '2026-10-18', kind: 'all', since: '2026-10-15' }).length, 1, 'since 이전 기록은 뺀다');
});

test('통화 재분류 프롬프트는 미네 발화와 목소리 거절 이유를 명시하고 중요도는 묻지 않는다', () => {
  const content = note({ body: '나: 오늘 기분이 좋아 보이네\n미네: 응 기뻐',
    extra: '\nemotions: []\nprimaryEmotion: null' });
  const item = { rel: `${C}/2026/2026-10-15 미네 통화.md`, content,
    occurred: '2026-10-15', date: '2026-10-15', fields: { convKind: '통화' },
    audioCues: { text: '소리 근거: 없음(상대 목소리가 미네 기준과 다름)', ok: false } };
  const prompt = buildOllamaPrompt([item], { reclassify: true, criteria, anchors });
  assert.match(prompt, /대화 형식의 미네: 줄과 확인된 미네 구간 소리만 감정 근거/);
  assert.match(prompt, /다른 화자의 말은 맥락 해석에만/);
  assert.match(prompt, /상대 목소리가 미네 기준과 다름/);
  assert.doesNotMatch(prompt, /importance/);
});

test('재분류 실행 두 개는 같은 잡 락을 공유한다', async (t) => {
  const { root, put } = fixture(t);
  const out = mkdtempSync(join(tmpdir(), 'mine-reclassify-lock-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  put(`${C}/2026/2026-10-15 미네 녹음.md`, note({ extra: '\nemotions: ["슬픔"]\nprimaryEmotion: "슬픔"' })
    .replace('convKind: "통화"', 'convKind: "녹음"'));
  let release;
  const response = joy2();
  const options = { root, out, now, rules, criteria, output: { log() {} }, cooldown: () => false, maxNotes: 1, anchors };
  const first = reclassify({ ...options, judge: () => release ? response : new Promise((resolve) => { release = resolve; }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  await assert.rejects(reclassify({ ...options, judge: async () => response }), /락 획득 실패/);
  release(response);
  assert.equal((await first).changed, 1);
});

test('판단 프롬프트: 노트에 붙은 소리 근거를 넣고, 소리 근거 사용 규칙을 안내한다', () => {
  const item = { rel: `${C}/2020/2020-07-27 미네 노래 요들송 웃음 녹음.md`, content: note(), occurred: '2020-07-27', date: '2020-07-27',
    audioCues: { text: '소리 근거(전체(화자 분리 없음), 맥 안 기계 감지 — 틀릴 수 있음):\n- 웃음 3회(0:06·0:24·0:42, 최대 0.39)', ok: true } };
  const prompt = buildOllamaPrompt([item], { criteria, anchors });
  assert.match(prompt, /웃음 3회\(0:06·0:24·0:42/);
  assert.match(prompt, /소리 근거: 노트에 맥 안 기계 감지 결과/);
});

test('reclassify: 판단 호출 전에 소리 근거를 붙인다(주입)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'athena-cues-'));
  try {
    const rel = `${C}/2020/2020-07-27 미네 노래 녹음.md`;
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), note({ occurred: '2020-07-27T10:00:00+09:00', extra: '\nemotions: []\nprimaryEmotion: null' }).replace('convKind: "통화"', 'convKind: "녹음"'));
    let seen = '';
    await reclassify({ root, dryRun: true, criteria, now: new Date('2026-10-16T12:00:00Z'), output: { log() {}, error() {} }, anchors,
      cues: async (batch) => { for (const item of batch) item.audioCues = { text: '소리 근거: 테스트 웃음', ok: true }; },
      judge: async (prompt) => { seen = prompt; return joy2(); } });
    assert.match(seen, /소리 근거: 테스트 웃음/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('재분류 --include-unclassified: 처음 분류는 주간 잡과 같이 importance와 mineAge를 쓴다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'athena-unclassified-'));
  const out = mkdtempSync(join(tmpdir(), 'athena-unclassified-report-'));
  try {
    const rel = `${C}/2025/2025-03-01 미네 통화.md`;
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), note({ occurred: '2025-03-01T10:00:00+09:00' }));
    const opts = { root, out, rules, criteria, kind: '통화', now: new Date('2026-10-17T03:00:00Z'),
      output: { log() {}, error() {} }, cooldown: () => false, cues: async () => {}, anchors,
      judge: async (prompt) => {
        assert.match(prompt, /importance: 1~5 정수/);
        return joy2({ importance: 3 });
      } };
    const skipped = await reclassify({ ...opts, dryRun: true });
    assert.equal(skipped.targets, 0);
    const included = await reclassify({ ...opts, dryRun: true, includeUnclassified: true });
    assert.equal(included.targets, 1);
    assert.equal(included.changed, 1);
    const written = await reclassify({ ...opts, includeUnclassified: true });
    assert.equal(written.changed, 1);
    assert.match(readFileSync(join(root, rel), 'utf8'), /importance: 3\nmineAge: 8\n---/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test('재분류는 주간 잡의 skipped 노트를 처음 분류 대상으로 다시 열지 않는다', async (t) => {
  const { root, put } = fixture(t);
  const rel = `${C}/2025/2025-03-01 미네 통화.md`;
  put(rel, note({ occurred: '2025-03-01T10:00:00+09:00' }));
  put(STATE_REL, JSON.stringify({ skipped: { [rel]: { reason: '판단 불가' } } }));
  assert.equal((await reclassify({ root, dryRun: true, kind: '통화', includeUnclassified: true,
    now, criteria, output: { log() {} } })).targets, 0);
});

test('처음 분류와 기존 재분류가 섞이면 importance 판단을 처음 분류에만 요구한다', async (t) => {
  const { root, put } = fixture(t);
  put(`${C}/2025/2025-03-01 미네 통화.md`, note({ occurred: '2025-03-01T10:00:00+09:00' }));
  put(`${C}/2025/2025-03-02 미네 통화.md`, note({ occurred: '2025-03-02T10:00:00+09:00',
    extra: '\nemotions: []\nprimaryEmotion: null\nimportance: 4\nmineAge: 8' }));
  const prompts = [];
  const result = await reclassify({ root, dryRun: true, includeUnclassified: true, kind: '통화',
    now, criteria, output: { log() {} }, cues: async () => {}, anchors, judge: async (prompt) => {
      prompts.push(prompt);
      return joy2(prompt.includes('importance: 1~5 정수') ? { importance: 2 } : {});
    } });
  assert.equal(result.changed, 2);
  assert.equal(prompts.length, 2 * CLAUDE_RUNS);
  assert.match(prompts[0], /importance: 1~5 정수/);
  assert.match(prompts[0], /최근 사춘기 신호 관찰/);
  assert.doesNotMatch(prompts.at(-1), /importance/);
  assert.doesNotMatch(prompts.at(-1), /최근 사춘기 신호 관찰/);
});

test('부분 머리말 첫 분류는 빠진 importance·mineAge를 채우고 기존 값은 보존한다', async (t) => {
  const { root, put } = fixture(t);
  const out = mkdtempSync(join(tmpdir(), 'athena-partial-report-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const one = `${C}/2025/2025-03-01 미네 통화.md`;
  const two = `${C}/2025/2025-03-02 미네 통화.md`;
  const three = `${C}/2025/2025-03-03 미네 통화.md`;
  put(one, note({ occurred: '2025-03-01T10:00:00+09:00', extra: '\nemotions: []' }));
  put(two, note({ occurred: '2025-03-02T10:00:00+09:00', extra: '\nimportance: 4\nmineAge: 8' }));
  put(three, note({ occurred: '2025-03-03T10:00:00+09:00', extra: '\nimportance: null\nmineAge: null' }));
  const result = await reclassify({ root, out, rules, includeUnclassified: true, kind: '통화',
    now, criteria, cooldown: () => false, output: { log() {} }, cues: async () => {}, anchors,
    judge: async (prompt) => {
      assert.match(prompt, /importance: 1~5 정수/);
      return joy2({ importance: 2 });
    } });
  assert.equal(result.changed, 3);
  assert.match(readFileSync(join(root, one), 'utf8'), /importance: 2\nmineAge: 8\n---/);
  const existing = readFileSync(join(root, two), 'utf8');
  assert.match(existing, /importance: 4\nmineAge: 8/);
  assert.match(existing, /primaryEmotion: "기쁨"/);
  assert.equal((existing.match(/importance:/g) ?? []).length, 1);
  const empty = readFileSync(join(root, three), 'utf8');
  assert.match(empty, /importance: 2\nmineAge: 8\n---/);
  assert.equal((empty.match(/mineAge:/g) ?? []).length, 1);
});

test('쿨다운이 켜지면 같은 기록의 두 번째 호출부터 멈춘다', async (t) => {
  const { root, put } = fixture(t);
  put(`${C}/2025/2025-03-01 미네 통화.md`, note({ occurred: '2025-03-01T10:00:00+09:00' }));
  put(`${C}/2025/2025-03-02 미네 통화.md`, note({ occurred: '2025-03-02T10:00:00+09:00',
    extra: '\nemotions: []\nprimaryEmotion: null\nimportance: 4' }));
  let calls = 0;
  const result = await reclassify({ root, dryRun: true, includeUnclassified: true, kind: '통화',
    now, criteria, output: { log() {} }, cues: async () => {}, cooldown: () => calls > 0, anchors,
    judge: async () => { calls += 1; return joy2({ importance: 2 }); } });
  assert.equal(calls, 1);
  assert.equal(result.cooldown, true);
});

test('replaceEmotionFields: 기존 감정 필드만 교체한다', async () => {
  const { replaceEmotionFields } = await import('./mine-athena-fields.mjs');
  const next = replaceEmotionFields(note({ occurred: '2025-03-01T10:00:00+09:00',
    extra: '\nemotions: []\nprimaryEmotion: null' }),
    { emotions: ['기쁨'], primaryEmotion: '기쁨', emotionIntensity: 1, emotionEvidence: '웃음', secondFilmSignal: null }, '2026-10-17');
  assert.match(next, /primaryEmotion: "기쁨"/);
  assert.doesNotMatch(next, /importance:/);
  assert.doesNotMatch(next, /mineAge:/);
});

test('Ollama 답 모양: 기록 날짜의 어휘로 묶고, importance는 처음 분류에만, 날짜가 섞이면 막는다', () => {
  const item = { date: '2026-10-15', content: note() };
  const schema = proposalSchema([item], { criteria });
  assert.equal(schema.type, 'array');
  assert.equal(schema.maxItems, 1);
  const names = criteria.emotions.filter((emotion) => emotion.part === 1).map((emotion) => emotion.name);
  assert.deepEqual(schema.items.properties.emotions.items.enum, names);
  assert.deepEqual(schema.items.properties.primaryEmotion.enum, [...names, null]);
  assert.ok(schema.items.required.includes('importance'));
  assert.equal(schema.items.properties.skip, undefined, 'Ollama는 skip을 못 낸다 — 예시 문구를 따라 쓰면 노트가 영구 제외됨');
  assert.equal(schema.items.additionalProperties, false);
  const again = proposalSchema([item], { criteria, reclassify: true });
  assert.equal(again.items.required.includes('importance'), false);
  assert.equal(again.items.properties.importance, undefined);
  assert.throws(() => proposalSchema([item, { ...item, date: '2026-10-16' }], { criteria }), /한 날짜/);
});

test('ollamaDecision: 텍스트 모델·답 모양을 넘기고 JSON 문자열로 돌려준다', async () => {
  const calls = [];
  const decide = ollamaDecision({ criteria, output: { log() {} },
    invoke: async (request) => { calls.push(request); return { json: { emotionState: '모름' } }; } });
  const item = { date: '2026-10-15', content: note() };
  assert.equal(await decide('프롬프트', { items: [item], reclassify: true }), '{"emotionState":"모름"}');
  assert.equal(calls[0].model, OLLAMA_MODELS.text);
  assert.equal(calls[0].prompt, '프롬프트');
  assert.deepEqual(calls[0].schema, ollamaProposalSchema([item], { criteria, reclassify: true }));
  assert.deepEqual(calls[0].schema.properties.levels.required, ['기쁨', '슬픔', '버럭', '까칠', '소심']);
});

test('judgeItems: 기록 하나씩, 형식 실패는 그 기록만, 멈추면 남은 기록을 연기한다', async () => {
  const items = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'].map((date) => ({ date, content: note() }));
  const validate = (raw, subset) => validateOllamaProposals(raw, subset, { criteria });
  const answer = reply({ emotionState: '감정 없음', emotionEvidence: '짧은 안부' }, { importance: 1 });
  const prompts = [];
  const replies = [async () => answer, async () => { throw Object.assign(new Error('로컬 모델 답이 JSON이 아님'), { formatFailure: true }); },
    async () => { throw Object.assign(new Error('Ollama 연결 실패: fetch failed'), { unavailable: true }); }, async () => { throw new Error('부르면 안 됨'); }];
  const result = await judgeItems(items, { validate, prompt: (subset) => subset.map((item) => item.date).join(','),
    decide: async (prompt) => { prompts.push(prompt); return replies[prompts.length - 1](); } });
  assert.deepEqual(prompts, ['2026-10-12', '2026-10-13', '2026-10-14']);
  assert.equal(result.get(1).fields.emotionEvidence, '짧은 안부');
  assert.equal(result.get(1).calls, 1);
  assert.deepEqual(result.get(2), { error: '로컬 모델 답이 JSON이 아님', calls: 1, formatFailure: true });
  assert.equal(result.get(3).unavailable, true);
  assert.equal(result.get(4).deferred, true);
  // 잡 시간 상한이 지나면 더 부르지 않는다.
  const late = await judgeItems(items.slice(0, 1), { validate, prompt: () => 'p', deadline: 0,
    decide: async () => { throw new Error('부르면 안 됨'); } });
  assert.deepEqual(late.get(1), { error: '잡 시간 상한', deferred: true });
});

test('judgeItems 두 번 묻기: 같으면 첫 답, 대표 감정·강도·상태가 다르면 애매함, 쿨다운이면 남은 기록 연기', async () => {
  const items = ['2026-10-12', '2026-10-13', '2026-10-14'].map((date) => ({ date, content: note() }));
  const validate = (raw, subset) => validateOllamaProposals(raw, subset, { criteria, reclassify: true });
  let calls = 0;
  const twice = await judgeItems(items.slice(0, 1), { validate, runs: 2, prompt: () => 'p',
    decide: async () => { calls += 1; return calls === 1 ? joy2() : reply({ levels: { 기쁨: '보통', 소심: '옅음' }, emotionEvidence: '다른 말' }); } });
  assert.equal(calls, 2);
  assert.equal(twice.get(1).ambiguous, undefined, '곁 감정·근거만 다르면 같은 답');
  assert.deepEqual([twice.get(1).fields.emotionEvidence, twice.get(1).calls], ['미네가 웃음', 2]);
  const answers = [joy2(), reply({ levels: { 기쁨: '옅음' } }), joy2(), joy2()];
  const split = await judgeItems(items.slice(0, 2), { validate, runs: 2, prompt: () => 'p', decide: async () => answers.shift() });
  assert.equal(split.get(1).ambiguous, true);
  assert.deepEqual(split.get(1).answers.map((answer) => answer.fields.emotionIntensity), [2, 1]);
  assert.equal(split.get(2).ambiguous, undefined);
  let asked = 0;
  const cooled = await judgeItems(items, { validate, runs: 2, prompt: () => 'p', quota: () => asked >= 3,
    decide: async () => { asked += 1; return joy2(); } });
  assert.equal(asked, 3);
  assert.equal(cooled.get(1).calls, 2);
  assert.deepEqual(cooled.get(2), { error: '쿨다운', deferred: true, cooldown: true, calls: 1 });
  assert.deepEqual(cooled.get(3), { error: '쿨다운', deferred: true, cooldown: true });
  const crashed = await judgeItems(items.slice(0, 1), { validate, runs: 2, prompt: () => 'p', decide: async () => { throw new Error('claude 종료코드 1'); } });
  assert.deepEqual(crashed.get(1), { error: 'claude 종료코드 1', calls: 1 });
});

test('하루 상한: 오늘 Claude를 부른 횟수만큼 덜 고르고, 다 쓰면 묻지 않으며 실패가 아니다', async (t) => {
  const { root, put } = fixture(t);
  for (const day of ['10', '11', '12']) put(`${C}/2026/2026-10-${day} 미네 통화.md`, note({ occurred: `2026-10-${day}T09:00:00+09:00` }));
  const judgmentsPath = join(root, 'judgments.jsonl');
  const today = '2026-10-18';
  writeFileSync(judgmentsPath, `${JSON.stringify({ rel: 'x.md', engine: 'claude', at: today, calls: DAILY_CLAUDE_CALLS - 2 })}\n`);
  let calls = 0;
  const opts = { root, now, rules, criteria, ...claude, judgmentsPath, cooldown: () => false, output: { log() {}, error() {} },
    cues: async () => {}, judge: async () => { calls += 1; return joy2({ importance: 2 }); } };
  const first = await run(opts);
  assert.equal(first.written.length, 1);
  assert.equal(first.capped, true);
  assert.equal(calls, 2);
  const full = await run(opts);
  assert.deepEqual([full.written.length, full.capped, failed(full), calls], [0, true, false, 2]);
  const dry = await reclassify({ ...opts, dryRun: true, kind: '통화', includeUnclassified: true });
  assert.deepEqual([dry.selected, dry.capped], [0, true]);
  const local = await run({ ...opts, engine: 'ollama', judge: async () => reply({}, { importance: 2 }) });
  assert.equal(local.written.length, 2, 'Ollama는 상한 없음');
});

test('run --engine=ollama: 쿨다운과 무관하게 판단하고, 판 이름을 기록하며, Ollama가 멈추면 실패로 본다', async (t) => {
  const { root, put } = fixture(t);
  put(`${C}/2026/2026-10-15 미네 통화.md`, note({ occurred: '2026-10-12T09:00:00+09:00' }));
  put(`${C}/2026/2026-10-16 미네 통화.md`, note({ occurred: '2026-10-13T09:00:00+09:00' }));
  const quiet = { log() {}, error() {} };
  let unloaded = 0;
  const opts = { root, now, rules, output: quiet, cues: async () => {}, engine: 'ollama', cooldown: () => true,
    criteria: { ...criteria, ref: '미네-감정-분류@시험' }, unload: async () => { unloaded += 1; }, anchors };
  let calls = 0;
  const summary = await run({ ...opts, judge: async (prompt, { items }) => {
    calls += 1;
    assert.equal(items.length, 1);
    if (calls === 2) throw Object.assign(new Error('Ollama 연결 실패: fetch failed'), { unavailable: true });
    assert.match(prompt, /# 기준 예시[\s\S]*joy-1[\s\S]*# 기록/);
    return JSON.stringify({ ...scored({ levels: { 기쁨: '짙음', 슬픔: '옅음' } }), importance: 2 });
  } });
  assert.equal(summary.cooldown, undefined);
  assert.equal(summary.written.length, 1);
  assert.equal(summary.unavailable, true);
  assert.equal(failed(summary), true);
  assert.equal(unloaded, 0, '시험 주입이면 모델을 내리지 않는다');
  const rows = readFileSync(join(root, '.mine-judgments', 'athena-judgments.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => [row.rel.split('/').pop(), row.status]), [['2026-10-15 미네 통화.md', 'applied'], ['2026-10-16 미네 통화.md', 'retry']]);
  assert.deepEqual({ engine: rows[0].engine, model: rows[0].model, criteriaRef: rows[0].criteriaRef, promptVersion: rows[0].promptVersion, mode: rows[0].mode },
    { engine: 'ollama', model: OLLAMA_MODELS.text, criteriaRef: '미네-감정-분류@시험', promptVersion: PROMPT_VERSIONS.ollama, mode: 'initial' });
  assert.deepEqual(rows[0].scores, { 기쁨: 0.85, 슬픔: 0.35, 버럭: 0, 까칠: 0, 소심: 0 });
  assert.equal(rows[0].levels.기쁨, '짙음');
  assert.equal(rows[0].fields.primaryEmotion, '기쁨');
  assert.equal(rows[0].fields.emotionIntensity, 3, '짙음은 강도 3');
  assert.deepEqual([rows[0].emotionState, rows[0].nearestAnchor], ['있음', 'joy-1']);
  await assert.rejects(run({ ...opts, engine: 'gpt' }), /판단 엔진/);
});

test('판단 기록 기본 경로: 진짜 볼트(다른 표기 포함)만 Media, 시험 볼트는 그 안', () => {
  assert.match(defaultJudgmentsPath(VAULT_PATHS.root), /Media\/MemoryOrb\/athena-judgments\.jsonl$/);
  assert.match(defaultJudgmentsPath(`${VAULT_PATHS.root}/`), /Media\/MemoryOrb\/athena-judgments\.jsonl$/);
  assert.equal(defaultJudgmentsPath('/tmp/x'), '/tmp/x/.mine-judgments/athena-judgments.jsonl');
  assert.equal(defaultJudgmentsPath('/tmp/x', '/tmp/out'), '/tmp/out/athena-judgments.jsonl');
});

test('재분류 같은 판 거르기: retry는 다시 고르고, --ids는 같은 판이어도 고르며, 옮긴 노트는 movedFrom으로 찾는다', async (t) => {
  const { root, put } = fixture(t);
  const out = mkdtempSync(join(tmpdir(), 'mine-judged-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const done = `${C}/2026/2026-10-11 미네 녹음.md`;
  const retry = `${C}/2026/2026-10-12 미네 녹음.md`;
  const moved = `${C}/2026/2026-10-13 미네 녹음 새이름.md`;
  const classified = (extra = '') => note({ extra: `\nemotions: ["기쁨"]\nprimaryEmotion: "기쁨"${extra}` }).replace('convKind: "통화"', 'convKind: "녹음"');
  put(done, classified()); put(retry, classified()); put(moved, classified(`\nmovedFrom: "[[${C}/2026/2026-10-13 미네 녹음]]"`));
  const version = { engine: 'claude', model: 'sonnet', criteriaRef: null, promptVersion: PROMPT_VERSIONS.claude };
  writeFileSync(join(out, 'athena-judgments.jsonl'), [
    { rel: done, status: 'same', ...version }, { rel: retry, status: 'retry', ...version },
    { rel: `${C}/2026/2026-10-13 미네 녹음.md`, status: 'applied', ...version }].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const opts = { root, out, now, rules, criteria, output: { log() {}, error() {} }, dryRun: true, charter: { model: 'sonnet', systemPrompt: '' } };
  const summary = await reclassify(opts);
  assert.equal(summary.targets, 1, 'retry 노트만 남는다');
  const forced = await reclassify({ ...opts, ids: [done] });
  assert.equal(forced.targets, 1, '--ids는 같은 판이어도 고른다');
});

test('Ollama 실제 경로: 판단 뒤 텍스트 모델을 한 번 내리고, 내리기 실패·기록 실패는 노트 쓰기를 끊지 않는다', async (t) => {
  const { root, put } = fixture(t);
  put(`${C}/2026/2026-10-15 미네 통화.md`, note({ occurred: '2026-10-12T09:00:00+09:00' }));
  put(`${C}/2026/2026-10-16 미네 통화.md`, note({ occurred: '2026-10-13T09:00:00+09:00' }));
  const errors = [];
  const unloaded = [];
  const blocked = join(root, 'blocked');
  writeFileSync(blocked, '파일이라 폴더를 만들 수 없음');
  const summary = await run({ root, now, rules, criteria, cues: async () => {}, engine: 'ollama', anchors,
    output: { log() {}, error: (line) => errors.push(line) }, judgmentsPath: join(blocked, 'judgments.jsonl'),
    unload: async (model) => { unloaded.push(model); throw new Error('내리기 실패'); },
    invoke: async () => ({ json: { ...scored({ emotionState: '감정 없음', emotionEvidence: '짧은 안부' }), importance: 1 } }) });
  assert.deepEqual(unloaded, [OLLAMA_MODELS.text]);
  assert.equal(summary.written.length, 2, '기록 실패가 있어도 두 노트 모두 쓴다');
  assert.equal(summary.recordErrors, 2);
  assert.equal(failed(summary), true);
  assert.ok(errors.some((line) => /모델 내리기 실패/.test(line)));
});

test('판단 프롬프트 입력은 미네 발화로 추리고 오너 메모는 따로 붙인다', () => {
  const item = { rel: `${C}/2026/2026-10-15 미네 통화.md`, date: '2026-10-15', occurred: '2026-10-15T19:00:00+09:00',
    fields: { convKind: '통화' }, content: note({ body: '나: 숙제 했어?\n나: 오늘 뭐 했어?\n미네: 그네 탔어\n원본: Archive/a.m4a' }).replace('## 오너 메모\n', '## 오너 메모\n소풍 다녀온 날\n') };
  const local = buildOllamaPrompt([item], { criteria, anchors });
  assert.match(local, /전사\(미네 발화와 그 바로 앞 다른 화자 한 줄만 추림\):\n나: 오늘 뭐 했어\?\n미네: 그네 탔어/);
  assert.doesNotMatch(local, /숙제 했어|원본: Archive/);
  assert.match(local, /오너 메모: 소풍 다녀온 날/);
});

test('Ollama 0.2 프롬프트: 고정 앞부분(기준·예시·판단 순서·자리표시 답 양식) 뒤에 기록, 채운 예시 값 없음', () => {
  const item = { rel: `${C}/2026/2026-10-15 미네 통화.md`, date: '2026-10-15', occurred: '2026-10-15T19:00:00+09:00',
    fields: { convKind: '통화' }, content: note({ body: '미네: 그네 탔어' }) };
  const prompt = buildOllamaPrompt([item], { criteria, anchors, reclassify: true });
  const order = ['# 역할', '# 감정 기준', '# 기준 예시', '# 판단 순서', '# 답 양식', '# 소리 근거 읽는 법', '# 기록'].map((head) => prompt.indexOf(head));
  assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), `순서 ${order}`);
  assert.match(prompt, /미네: 그네 탔어/);
  assert.doesNotMatch(prompt, /"emotionIntensity": ?2|미네가 웃으며 말함/, '채운 예시 값을 보여 주지 않는다');
  assert.doesNotMatch(prompt, /importance/, '재분류는 중요도를 묻지 않는다');
  const other = buildOllamaPrompt([{ ...item, content: note({ body: '미네: 다른 이야기' }) }], { criteria, anchors, reclassify: true });
  assert.equal(prompt.slice(0, prompt.indexOf('# 기록')), other.slice(0, other.indexOf('# 기록')), '기록이 달라도 앞부분이 같아 캐시를 쓴다');
  assert.equal(buildOllamaPrompt([item], { criteria, anchors, exclude: { excludeNo: 2 } }).includes('joy-1'), false);
  assert.throws(() => buildOllamaPrompt([item, item], { criteria, anchors }), /하나씩/);
});

test('0.3 화자 줄: 화자 표시 없는 한 사람 녹음은 대개 미네 것, 통화는 예전 문구 그대로', () => {
  const recording = { rel: `${C}/2018/2018-10-22 미네 노래 녹음.md`, date: '2018-10-22', occurred: '2018-10-22T19:00:00+09:00',
    fields: { convKind: '녹음' }, content: note({ body: '산토끼 토끼야 하나 둘 셋' }).replace('convKind: "통화"', 'convKind: "녹음"') };
  const local = buildOllamaPrompt([recording], { criteria, anchors, reclassify: true });
  assert.match(local, /화자 분리: 화자 표시 없는 한 사람 녹음 — 노래·혼잣말·말소리는 대개 미네 것이다/);
  assert.doesNotMatch(local, /확실한 미네 발화가 표시되지 않으면 감정 없음/);
  assert.match(local, /화자 표시가 없는 한 사람 녹음은 기록의 화자 줄을 따른다/);
  assert.match(local, /협상 중이라도 음식·맛·물건이 싫다고 말로 드러내면\("그거 싫어해"\) 그 싫음은 까칠 옅음/, '0.4 협상 경계 줄(통화·녹음)');
  assert.match(local, /미네가 화를 직접 말하면\("화났어", "기분 나빴어"\) 끝에 "속상해"가 붙어도 대표 감정은 버럭이다/, '0.5 화남·속상 경계 줄');
  const call = { ...recording, fields: { convKind: '통화' }, content: note({ body: '여보세요 응 알았어' }) };
  assert.match(buildOllamaPrompt([call], { criteria, anchors, reclassify: true }), /화자 분리: 확실한 미네 발화가 표시되지 않으면 감정 없음/);
});

test('validateOllamaProposals: 세기 단어 → 필드, 형식 오류·중요도 누락은 형식 실패', () => {
  const item = { date: '2026-10-15', content: note() };
  const ok = validateOllamaProposals({ ...scored({ levels: { 소심: '보통', 슬픔: '옅음' } }), importance: 2 }, [item], { criteria }).get(1);
  assert.deepEqual([ok.fields.emotions, ok.fields.primaryEmotion, ok.fields.emotionIntensity, ok.fields.importance], [['소심', '슬픔'], '소심', 2, 2]);
  assert.equal(validateOllamaProposals(scored(), [item], { criteria }).get(1).formatFailure, true, '처음 분류는 중요도 필수');
  assert.equal(validateOllamaProposals(scored(), [item], { criteria, reclassify: true }).get(1).fields.emotions.length, 0);
  const bad = validateOllamaProposals({ ...scored(), levels: { 기쁨: 2 } }, [item], { criteria, reclassify: true }).get(1);
  assert.match(bad.error, /levels/);
});

test('재분류 실제 실행: 애매함은 노트를 그대로 두고 기록·보고서에 남기며, 같은 답도 두 답을 기록한다', async (t) => {
  const { root, put } = fixture(t);
  const out = mkdtempSync(join(tmpdir(), 'mine-ambiguous-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const recording = (day) => note({ occurred: `2026-10-${day}`, extra: '\nemotions: ["슬픔"]\nprimaryEmotion: "슬픔"' }).replace('convKind: "통화"', 'convKind: "녹음"');
  const [split, same] = ['11', '12'].map((day) => `${C}/2026/2026-10-${day} 미네 녹음.md`);
  put(split, recording('11')); put(same, recording('12'));
  const asked = {};
  const summary = await reclassify({ root, out, now, rules, criteria, output: { log() {} }, cooldown: () => false, anchors, cues: async () => {},
    judge: async (_prompt, { items: [item] }) => {
      asked[item.rel] = (asked[item.rel] ?? 0) + 1;
      if (item.rel === split) return asked[split] === 1 ? joy2() : reply({ levels: { 슬픔: '보통' } });
      return asked[same] === 1 ? joy2() : reply({ levels: { 기쁨: '보통', 소심: '옅음' }, secondFilmSignal: '불안' });
    } });
  assert.deepEqual([summary.changed, summary.ambiguous.length, summary.invalid.length], [1, 1, 0]);
  assert.equal(readFileSync(join(root, split), 'utf8'), recording('11'));
  const rows = readFileSync(join(out, 'athena-judgments.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => [row.rel, row.status, row.calls, row.answers?.length]), [[split, 'ambiguous', 2, 2], [same, 'applied', 2, 2]]);
  assert.equal(rows[1].answers[1].fields.secondFilmSignal, '불안', '같은 답이어도 흔들린 값이 기록에 남는다');
  assert.match(readFileSync(join(out, 'reclassify-report-2026-10-18.md'), 'utf8'), /## 애매함[^\n]*\n- [^\n]*2026-10-11 미네 녹음\.md: 있음\|기쁨\|2 \/ 있음\|슬픔\|2/);
});

test('run: 회차 중간 쿨다운은 남은 기록을 미루고 실패로 보지 않으며, 부른 횟수를 기록한다', async (t) => {
  const { root, put } = fixture(t);
  for (const day of ['10', '11']) put(`${C}/2026/2026-10-${day} 미네 통화.md`, note({ occurred: `2026-10-${day}T09:00:00+09:00` }));
  let calls = 0;
  const summary = await run({ root, now, rules, criteria, ...claude, output: { log() {}, error() {} }, cues: async () => {},
    cooldown: () => calls >= 3, judge: async () => { calls += 1; return joy2({ importance: 2 }); } });
  assert.deepEqual([summary.written.length, summary.invalid.length, summary.cooldown, failed(summary)], [1, 0, true, false]);
  const rows = readFileSync(join(root, '.mine-judgments', 'athena-judgments.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => [row.status, row.calls]), [['applied', 2], ['retry', 1]]);
});

test('reclassifyFailed: 부분 실패는 정상, 하나도 못 했거나 쓰기 오류·기록 실패면 실패', () => {
  const base = { changed: 0, unchanged: 0, ambiguous: [], invalid: [] };
  assert.equal(reclassifyFailed({ ...base, changed: 5, invalid: [{}] }), false);
  assert.equal(reclassifyFailed({ ...base, ambiguous: [{}], invalid: [{}] }), false);
  assert.equal(reclassifyFailed({ ...base, invalid: [{}] }), true);
  assert.equal(reclassifyFailed({ ...base, changed: 5, errors: 1 }), true);
  assert.equal(reclassifyFailed({ ...base, changed: 5, recordErrors: 1 }), true);
  assert.equal(reclassifyFailed({ ...base, timedOut: true, cooldown: true }), false);
});
