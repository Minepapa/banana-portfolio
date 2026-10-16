import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fixture as criteriaFixture, fixtureCriteria as criteria } from '../lib/mine-emotion-criteria.fixture.js';
import { parseEmotionCriteria } from '../lib/mine-emotion-criteria.mjs';
import { applyFields, buildPrompt, failed, findTargets, mineAge, noteText, recentSignalTrend, reclassify, run, validateProposals,
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
  const prompt = buildPrompt([{ rel: `${C}/2026/2026-10-15 미네 통화.md`, content: note(), occurred: '2026-10-15', date: '2026-10-15' }], { criteria });
  assert.match(prompt, /기쁨·슬픔·버럭/);
  assert.match(prompt, /### 1\. 2026-10-15 미네 통화/);
  assert.match(prompt, /만 9세/);
});

test('혼합 날짜 묶음은 경보 전후 기준을 각각 한 번만 넣고 노트 번호를 연결한다', () => {
  const raised = parseEmotionCriteria(criteriaFixture.replace('사춘기 경보: 미발령', '사춘기 경보: 2026-10-16'));
  const items = ['2026-10-14', '2026-10-15', '2026-10-16'].map((date, index) => ({
    rel: `${C}/2026/${date} 미네 ${index}.md`, content: note({ occurred: date }), occurred: date, date,
  }));
  const prompt = buildPrompt(items, { criteria: raised });
  assert.match(prompt, /경보 전 기록 \(노트 번호 1·2\)/);
  assert.match(prompt, /경보 뒤 기록 \(노트 번호 3\)/);
  assert.equal((prompt.match(/## 3\. 감정별 정의와 관찰 근거/g) ?? []).length, 2);
});

test('제안 검증: 어휘 밖·주감정 불일치·중요도 범위 밖은 오류, skip은 이유를 남긴다', () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    date: `2026-10-${String(11 + index).padStart(2, '0')}`, content: note(),
  }));
  const result = validateProposals([
    { id: 1, emotions: ['기쁨', '슬픔'], primaryEmotion: '기쁨', emotionIntensity: 2, emotionEvidence: '미네가 웃음', importance: 3 },
    { id: 2, emotions: ['행복'], primaryEmotion: '행복', emotionIntensity: 2, emotionEvidence: '근거', importance: 2 },
    { id: 3, emotions: ['슬픔'], primaryEmotion: '기쁨', emotionIntensity: 2, emotionEvidence: '근거', importance: 2 },
    { id: 4, emotions: ['슬픔'], primaryEmotion: '슬픔', emotionIntensity: 2, emotionEvidence: '근거', importance: 6 },
    { id: 5, skip: '3초 통화' },
    { id: 9, emotions: ['기쁨'], primaryEmotion: '기쁨', importance: 1 },
  ], items, { criteria });
  assert.deepEqual(result.get(1), { fields: { emotions: ['기쁨', '슬픔'], primaryEmotion: '기쁨', emotionIntensity: 2, emotionEvidence: '미네가 웃음', secondFilmSignal: null, importance: 3 } });
  assert.match(result.get(2).error, /어휘 밖/);
  assert.match(result.get(3).error, /primaryEmotion/);
  assert.match(result.get(4).error, /importance/);
  assert.deepEqual(result.get(5), { skip: '3초 통화' });
  assert.equal(result.has(9), false);
  assert.throws(() => validateProposals({}, items, { criteria }), /JSON 배열/);
  assert.throws(() => validateProposals([], 5, { criteria }), /날짜가 있는 노트 배열/);
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

test('run: 제안대로 쓰고, skip은 상태 파일에 남겨 다음 실행에서 다시 묻지 않는다, 형식 오류는 재시도', async (t) => {
  const { root, put } = fixture(t);
  put(`${C}/2026/2026-10-15 미네 통화.md`, note({ occurred: '2026-10-12T09:00:00+09:00' }));
  put(`${C}/2026/2026-10-16 미네 통화.md`, note({ occurred: '2026-10-13T09:00:00+09:00' }));
  put(`${C}/2026/2026-10-17 미네 통화.md`, note({ occurred: '2026-10-14T09:00:00+09:00' }));
  put(`${C}/2026/2026-10-18 미네 녹음.md`, note({ occurred: '2026-10-15', extra: '\nemotions: ["소심"]\nprimaryEmotion: "소심"\nsecondFilmSignal: "불안"\nemotionEvidence: "미네가 내일 일을 걱정함"' }));
  const prompts = [];
  const judge = async (prompt) => {
    prompts.push(prompt);
    return '```json\n[{"id":1,"emotions":["기쁨"],"primaryEmotion":"기쁨","emotionIntensity":2,"emotionEvidence":"미네가 웃음","importance":4},{"id":2,"skip":"3초 통화"},{"id":3,"emotions":["행복"],"primaryEmotion":"행복","emotionIntensity":2,"emotionEvidence":"근거","importance":2}]\n```';
  };
  const quiet = { log() {}, error() {} };
  const summary = await run({ root, now, judge, cooldown: () => false, criteria, charter: { model: 'sonnet', systemPrompt: '' }, rules, output: quiet });
  assert.match(prompts[0], /최근 사춘기 신호 관찰 .*: 1건/);
  assert.match(prompts[0], /감정별: 불안 1건/);
  assert.match(prompts[0], /근거 예시: 불안 — 미네가 내일 일을 걱정함/);
  assert.deepEqual(summary.written.map((x) => x.rel), [`${C}/2026/2026-10-15 미네 통화.md`]);
  assert.match(readFileSync(join(root, `${C}/2026/2026-10-15 미네 통화.md`), 'utf8'), /importance: 4\nmineAge: 9\n---/);
  assert.equal(summary.skipped.length, 1);
  assert.equal(summary.invalid.length, 1);
  const state = JSON.parse(readFileSync(join(root, STATE_REL), 'utf8'));
  assert.deepEqual(Object.keys(state.skipped), [`${C}/2026/2026-10-16 미네 통화.md`]);
  assert.equal(readFileSync(join(root, `${C}/2026/2026-10-17 미네 통화.md`), 'utf8'), note({ occurred: '2026-10-14T09:00:00+09:00' }));

  const again = await run({ root, now, criteria, judge: async () => '[{"id":1,"emotions":["슬픔"],"primaryEmotion":"슬픔","emotionIntensity":2,"emotionEvidence":"미네가 울음","importance":2}]',
    cooldown: () => false, charter: { model: 'sonnet', systemPrompt: '' }, rules, output: quiet });
  assert.deepEqual(again.written.map((x) => x.rel), [`${C}/2026/2026-10-17 미네 통화.md`]);
  assert.equal(existsSync(join(root, `${C}/2026/2026-10-17 미네 통화.md.lock`)), false);
});

test('run: 판단 중 노트가 바뀌면 쓰지 않고 재시도, 아테나 오류는 reject하고 파일은 그대로', async (t) => {
  const { root, put } = fixture(t);
  const rel = `${C}/2026/2026-10-15 미네 통화.md`;
  put(rel, note());
  const quiet = { log() {}, error() {} };
  const opts = { root, now, criteria, cooldown: () => false, charter: { model: 'sonnet', systemPrompt: '' }, rules, output: quiet };
  const summary = await run({ ...opts, judge: async () => {
    put(rel, note({ body: '전사 본문\n추가된 통화' }));
    return '[{"id":1,"emotions":["기쁨"],"primaryEmotion":"기쁨","emotionIntensity":2,"emotionEvidence":"미네가 웃음","importance":2}]';
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
  const options = { root, out, now, rules, criteria, output: quiet, cooldown: () => false, maxNotes: 10,
    judge: async () => '[{"id":1,"emotions":["기쁨"],"primaryEmotion":"기쁨","emotionIntensity":2,"emotionEvidence":"미네가 즐거워라고 말함"}]' };
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
  const second = await reclassify({ ...options, dryRun: true });
  assert.equal(second.targets, 1);
  assert.equal(second.changed, 0);
  assert.equal(readFileSync(join(root, rel), 'utf8'), after);
  const repeated = await reclassify(options);
  assert.equal(repeated.changed, 0);
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
  const options = { root, out, now, rules, criteria, output: { log() {} }, cooldown: () => false,
    judge: async () => '[{"id":1,"emotions":["기쁨"],"primaryEmotion":"기쁨","emotionIntensity":2,"emotionEvidence":"미네가 웃음"}]' };
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

test('재분류 실행 두 개는 같은 잡 락을 공유한다', async (t) => {
  const { root, put } = fixture(t);
  const out = mkdtempSync(join(tmpdir(), 'mine-reclassify-lock-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  put(`${C}/2026/2026-10-15 미네 녹음.md`, note({ extra: '\nemotions: ["슬픔"]\nprimaryEmotion: "슬픔"' })
    .replace('convKind: "통화"', 'convKind: "녹음"'));
  let release;
  const response = '[{"id":1,"emotions":["기쁨"],"primaryEmotion":"기쁨","emotionIntensity":2,"emotionEvidence":"미네가 웃음"}]';
  const options = { root, out, now, rules, criteria, output: { log() {} }, cooldown: () => false, maxNotes: 1 };
  const first = reclassify({ ...options, judge: () => new Promise((resolve) => { release = resolve; }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  await assert.rejects(reclassify({ ...options, judge: async () => response }), /락 획득 실패/);
  release(response);
  assert.equal((await first).changed, 1);
});

test('buildPrompt: 노트에 붙은 소리 근거를 넣고, 소리 근거 사용 규칙을 안내한다', () => {
  const item = { rel: `${C}/2020/2020-07-27 미네 노래 요들송 웃음 녹음.md`, content: note(), occurred: '2020-07-27', date: '2020-07-27',
    audioCues: { text: '소리 근거(전체(화자 분리 없음), 맥 안 기계 감지 — 틀릴 수 있음):\n- 웃음 3회(0:06·0:24·0:42, 최대 0.39)', ok: true } };
  const prompt = buildPrompt([item], { criteria });
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
    await reclassify({ root, dryRun: true, criteria, now: new Date('2026-10-16T12:00:00Z'), output: { log() {}, error() {} },
      cues: async (batch) => { for (const item of batch) item.audioCues = { text: '소리 근거: 테스트 웃음', ok: true }; },
      judge: async (prompt) => { seen = prompt; return '[{"id":1,"emotions":["기쁨"],"primaryEmotion":"기쁨","emotionIntensity":2,"emotionEvidence":"웃음","secondFilmSignal":null}]'; } });
    assert.match(seen, /소리 근거: 테스트 웃음/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
