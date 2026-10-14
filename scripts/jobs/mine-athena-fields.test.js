import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { applyFields, buildPrompt, failed, findTargets, mineAge, noteText, run, validateProposals,
  STATE_REL } from './mine-athena-fields.mjs';

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

test('noteText는 머리말·주석을 빼고 길이를 자른다, 프롬프트에 어휘와 나이가 들어간다', () => {
  const text = noteText(note({ body: '가'.repeat(50) }), 10);
  assert.equal(text, `${'가'.repeat(10)}…(이하 생략)`);
  const prompt = buildPrompt([{ rel: `${C}/2026/2026-10-15 미네 통화.md`, content: note(), occurred: '2026-10-15', date: '2026-10-15' }]);
  assert.match(prompt, /기쁨·슬픔·버럭/);
  assert.match(prompt, /### 1\. 2026-10-15 미네 통화/);
  assert.match(prompt, /만 9세/);
});

test('제안 검증: 어휘 밖·주감정 불일치·중요도 범위 밖은 오류, skip은 이유를 남긴다', () => {
  const result = validateProposals([
    { id: 1, emotions: ['기쁨', '기쁨', '불안'], primaryEmotion: '기쁨', importance: 3 },
    { id: 2, emotions: ['행복'], primaryEmotion: '행복', importance: 2 },
    { id: 3, emotions: ['슬픔'], primaryEmotion: '기쁨', importance: 2 },
    { id: 4, emotions: ['슬픔'], primaryEmotion: '슬픔', importance: 6 },
    { id: 5, skip: '3초 통화' },
    { id: 9, emotions: ['기쁨'], primaryEmotion: '기쁨', importance: 1 },
  ], 5);
  assert.deepEqual(result.get(1), { fields: { emotions: ['기쁨', '불안'], primaryEmotion: '기쁨', importance: 3 } });
  assert.match(result.get(2).error, /어휘 밖/);
  assert.match(result.get(3).error, /primaryEmotion/);
  assert.match(result.get(4).error, /importance/);
  assert.deepEqual(result.get(5), { skip: '3초 통화' });
  assert.equal(result.has(9), false);
  assert.throws(() => validateProposals({}, 1), /JSON 배열/);
});

test('applyFields는 닫는 --- 앞에 붙이고 modified만 바꾼다, 이미 있으면 null', () => {
  const next = applyFields(note(), { emotions: ['기쁨'], primaryEmotion: '기쁨', importance: 2 }, 9, '2026-10-18');
  assert.match(next, /modified: "2026-10-18"\n/);
  assert.match(next, /convKind: "통화"\nemotions: \["기쁨"\]\nprimaryEmotion: "기쁨"\nimportance: 2\nmineAge: 9\n---\n<!-- media-transcribe:start -->/);
  assert.equal(next.endsWith('## 오너 메모\n'), true);
  assert.equal(applyFields(next, { emotions: ['슬픔'], primaryEmotion: '슬픔', importance: 1 }, 9, '2026-10-18'), null);
  assert.equal(applyFields(note({ extra: '\nimportance: 4' }), { emotions: ['슬픔'], primaryEmotion: '슬픔', importance: 1 }, 9, '2026-10-18'), null);
});

test('run: dry-run은 아테나를 부르지 않고, 쿨다운이면 건너뛴다', async (t) => {
  const { root, put } = fixture(t);
  put(`${C}/2026/2026-10-15 미네 통화.md`, note());
  const judge = () => { throw new Error('호출되면 안 됨'); };
  const quiet = { log() {}, error() {} };
  const dry = await run({ root, now, dryRun: true, judge, rules, output: quiet });
  assert.equal(dry.targets, 1);
  const cooled = await run({ root, now, judge, cooldown: () => true, rules, output: quiet });
  assert.equal(cooled.cooldown, true);
  assert.equal(readFileSync(join(root, `${C}/2026/2026-10-15 미네 통화.md`), 'utf8'), note());
});

test('run: 제안대로 쓰고, skip은 상태 파일에 남겨 다음 실행에서 다시 묻지 않는다, 형식 오류는 재시도', async (t) => {
  const { root, put } = fixture(t);
  put(`${C}/2026/2026-10-15 미네 통화.md`, note({ occurred: '2026-10-12T09:00:00+09:00' }));
  put(`${C}/2026/2026-10-16 미네 통화.md`, note({ occurred: '2026-10-13T09:00:00+09:00' }));
  put(`${C}/2026/2026-10-17 미네 통화.md`, note({ occurred: '2026-10-14T09:00:00+09:00' }));
  const prompts = [];
  const judge = async (prompt) => {
    prompts.push(prompt);
    return '```json\n[{"id":1,"emotions":["기쁨"],"primaryEmotion":"기쁨","importance":4},{"id":2,"skip":"3초 통화"},{"id":3,"emotions":["행복"],"primaryEmotion":"행복","importance":2}]\n```';
  };
  const quiet = { log() {}, error() {} };
  const summary = await run({ root, now, judge, cooldown: () => false, charter: { model: 'sonnet', systemPrompt: '' }, rules, output: quiet });
  assert.deepEqual(summary.written.map((x) => x.rel), [`${C}/2026/2026-10-15 미네 통화.md`]);
  assert.match(readFileSync(join(root, `${C}/2026/2026-10-15 미네 통화.md`), 'utf8'), /importance: 4\nmineAge: 9\n---/);
  assert.equal(summary.skipped.length, 1);
  assert.equal(summary.invalid.length, 1);
  const state = JSON.parse(readFileSync(join(root, STATE_REL), 'utf8'));
  assert.deepEqual(Object.keys(state.skipped), [`${C}/2026/2026-10-16 미네 통화.md`]);
  assert.equal(readFileSync(join(root, `${C}/2026/2026-10-17 미네 통화.md`), 'utf8'), note({ occurred: '2026-10-14T09:00:00+09:00' }));

  const again = await run({ root, now, judge: async () => '[{"id":1,"emotions":["슬픔"],"primaryEmotion":"슬픔","importance":2}]',
    cooldown: () => false, charter: { model: 'sonnet', systemPrompt: '' }, rules, output: quiet });
  assert.deepEqual(again.written.map((x) => x.rel), [`${C}/2026/2026-10-17 미네 통화.md`]);
  assert.equal(existsSync(join(root, `${C}/2026/2026-10-17 미네 통화.md.lock`)), false);
});

test('run: 판단 중 노트가 바뀌면 쓰지 않고 재시도, 아테나 오류는 reject하고 파일은 그대로', async (t) => {
  const { root, put } = fixture(t);
  const rel = `${C}/2026/2026-10-15 미네 통화.md`;
  put(rel, note());
  const quiet = { log() {}, error() {} };
  const opts = { root, now, cooldown: () => false, charter: { model: 'sonnet', systemPrompt: '' }, rules, output: quiet };
  const summary = await run({ ...opts, judge: async () => {
    put(rel, note({ body: '전사 본문\n추가된 통화' }));
    return '[{"id":1,"emotions":["기쁨"],"primaryEmotion":"기쁨","importance":2}]';
  } });
  assert.equal(summary.written.length, 0);
  assert.equal(summary.invalid[0].reason, '판단 중 노트가 바뀜');
  assert.equal(failed(summary), true);
  assert.equal(readFileSync(join(root, rel), 'utf8'), note({ body: '전사 본문\n추가된 통화' }));
  await assert.rejects(run({ ...opts, judge: async () => { throw new Error('claude 종료코드 1'); } }), /claude 종료코드/);
  await assert.rejects(run({ ...opts, judge: async () => '설명만 있고 JSON 없음' }), /JSON/);
  assert.equal(existsSync(join(root, `${STATE_REL}.lock`)), false);
});

test('failed: 오류가 있거나 하나도 처리하지 못했을 때만 실패, 쿨다운·대상 없음은 정상', () => {
  const base = { targets: 2, written: [], skipped: [], invalid: [], errors: 0 };
  assert.equal(failed({ ...base, invalid: [{}] }), true);
  assert.equal(failed({ ...base, invalid: [{}], written: [{}] }), false);
  assert.equal(failed({ ...base, written: [{}], errors: 1 }), true);
  assert.equal(failed({ ...base, cooldown: true, invalid: [{}] }), false);
  assert.equal(failed({ ...base, targets: 0 }), false);
});
