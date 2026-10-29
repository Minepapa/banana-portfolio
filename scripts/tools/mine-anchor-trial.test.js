import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAnchorTable, planAnchors, compareAnswer, summarize, renderReport,
  criteriaQuotes, quoteOverlap, memoLeak, run,
} from './mine-anchor-trial.mjs';
import { fixtureCriteria } from '../lib/mine-emotion-criteria.fixture.js';
import { anchorBlock as anchorPromptBlock } from '../lib/mine-judgment-prompt.mjs';

const BODY = `## 9. 앞 절
내용

## 10. 기준 예시 (앵커) — 2026-10-19 오너 확정
- 설명 줄

| ID | 판정 | 기록 | 오너 근거 |
|---|---|---|---|
| joy-3 | 기쁨 3 | [[20_Records/23_Conversations/2020/2020-01-10 미네 웃음 녹음]] (#1) | 아주 강하게 웃는 웃음소리 |
| sad-3a | 슬픔 3 | 영상 d1bfa7257c1df6ed, 2019-08-30 (#6) | 오래 울고 달랜 순간 |
| unk-a | 모름 | 사진 c5e3b1f76d03d430, 2022-11-04 마스크 (#33) | 마스크로 표정이 가려짐 |
- 표 뒤 줄

## 11. 다음 절
`;

test('parseAnchorTable: §10 표만 읽고 시트 번호·볼트 링크 제목만 남긴다', () => {
  const rows = parseAnchorTable(BODY);
  assert.deepEqual(rows.map((row) => [row.id, row.no]), [['joy-3', 1], ['sad-3a', 6], ['unk-a', 33]]);
  assert.equal(rows[0].record, '2020-01-10 미네 웃음 녹음');
  assert.equal(rows[0].record.includes('20_Records'), false);
});

test('[막아야 함] parseAnchorTable: 시트 번호(#n)가 없는 행은 오류 — 하나 빼고 시험이 깨진다', () => {
  const broken = BODY.replace(' (#6)', '');
  assert.throws(() => parseAnchorTable(broken), /기준 예시 행 오류/);
});

test('anchorPromptBlock: 시험 대상 예시 한 줄만 뺀다(정답지 새는 것 방지)', () => {
  const rows = parseAnchorTable(BODY);
  const block = anchorPromptBlock(rows, { excludeNo: 6 });
  assert.match(block, /joy-3/);
  assert.match(block, /unk-a/);
  assert.equal(block.includes('sad-3a'), false);
  assert.equal(block.includes('오래 울고'), false);
  assert.match(anchorPromptBlock(rows), /sad-3a/);
});

test('[막아야 함] anchorPromptBlock: 같은 날짜의 형제 예시도 뺀다(날짜만 맞춰 답하는 누출 방지)', () => {
  const rows = parseAnchorTable(BODY.replace('| sad-3a | 슬픔 3 | 영상 d1bfa7257c1df6ed, 2019-08-30 (#6) |',
    '| sad-3a | 슬픔 3 | 영상 d1bfa7257c1df6ed, 2022-11-04 (#6) |'));
  const block = anchorPromptBlock(rows, { excludeNo: 33, excludeDate: '2022-11-04' });
  assert.equal(block.includes('unk-a'), false);
  assert.equal(block.includes('sad-3a'), false);
  assert.match(block, /joy-3/);
});

test('criteriaQuotes·quoteOverlap: 기준 본문의 6자 이상 인용이 노트에 그대로 있으면 겹침', () => {
  const criteria = { sections: { 3: "### 까칠\n- 엄마가 연락을 안 해서 '엄마 나한테 전화 안 왔어' → 까칠 1. '싫어'는 짧다." } };
  const quotes = criteriaQuotes(criteria);
  assert.deepEqual(quotes, ['엄마 나한테 전화 안 왔어']);
  assert.equal(quoteOverlap('미네: 엄마, 나한테 전화 안 왔어!', quotes).length, 1);
  assert.equal(quoteOverlap('미네: 오늘 학교 재밌었어', quotes).length, 0);
});

test('memoLeak: 오너 메모에 감정 줄이나 정답 감정 이름이 있으면 누출 가능', () => {
  assert.equal(memoLeak('', { emo: '슬픔' }), false);
  assert.equal(memoLeak('감정: 슬픔', { emo: '기쁨' }), true);
  assert.equal(memoLeak('많이 슬픔이 느껴짐', { emo: '슬픔' }), true);
  assert.equal(memoLeak('병원 다녀온 날', { emo: '슬픔' }), false);
});

test('planAnchors: 통화 노트는 text, 사진은 photo, 영상·서사·오너 제외·정답 없음은 none', () => {
  const items = [
    { no: 1, group: '감정', kind: '녹음/통화', ref: '20_Records/23_Conversations/2020/a.md' },
    { no: 4, group: '감정', kind: '영상', ref: 'video:a8ff41de8aed1035' },
    { no: 5, group: '감정', kind: '녹음/통화', ref: '20_Records/23_Conversations/2026/b.md' },
    { no: 11, group: '감정', kind: '', ref: '' },
    { no: 34, group: '사진', kind: '사진', ref: 'photo:b553faed17c2e6b4' },
    { no: 40, group: '서사', kind: '녹음/통화', ref: '20_Records/23_Conversations/2026/c.md' },
  ];
  const answers = { 1: { emo: '기쁨', int: 3 }, 4: { emo: '기쁨', int: 2 }, 5: { skip: true }, 11: { emo: '모름' },
    34: { emo: '기쁨', int: 2 }, 40: { nw: 0.9 } };
  const plan = Object.fromEntries(planAnchors(items, answers).map((row) => [row.no, row]));
  assert.equal(plan[1].route, 'text');
  assert.equal(plan[34].route, 'photo');
  assert.equal(plan[34].photoId, 'b553faed17c2e6b4');
  assert.match(plan[4].reason, /영상/);
  assert.match(plan[5].reason, /쓰지 않음/);
  assert.match(plan[11].reason, /기록 없음/);
  assert.match(plan[40].reason, /서사적 무게/);
});

test('compareAnswer: 대표 감정·강도 같으면 일치, 강도만 다르면 감정만 일치, 목록에만 있으면 근접', () => {
  const fields = (primary, intensity, emotions = primary ? [primary] : []) => ({ emotions, primaryEmotion: primary, emotionIntensity: intensity });
  assert.equal(compareAnswer({ emo: '기쁨', int: 3 }, fields('기쁨', 3)).outcome, '일치');
  assert.equal(compareAnswer({ emo: '기쁨', int: 3 }, fields('기쁨', 1)).outcome, '감정만 일치');
  assert.equal(compareAnswer({ emo: '슬픔', int: 3 }, fields('소심', 2, ['소심', '슬픔'])).outcome, '근접');
  assert.equal(compareAnswer({ emo: '슬픔', int: 3 }, fields('기쁨', 2)).outcome, '불일치');
  assert.equal(compareAnswer({ emo: '기쁨', int: 2 }, null).outcome, '비교 불가');
});

test('compareAnswer: 감정 없음은 빈 감정이면 일치, 모름은 빈 감정이면 근접(지금 답 모양에 모름 칸 없음)', () => {
  const empty = { emotions: [], primaryEmotion: null, emotionIntensity: null };
  const joy = { emotions: ['기쁨'], primaryEmotion: '기쁨', emotionIntensity: 1 };
  assert.equal(compareAnswer({ emo: '감정 없음' }, empty).outcome, '일치');
  assert.equal(compareAnswer({ emo: '감정 없음' }, joy).outcome, '불일치');
  assert.equal(compareAnswer({ emo: '모름' }, empty).outcome, '근접');
  assert.equal(compareAnswer({ emo: '모름' }, joy).outcome, '불일치');
  // v0.1은 모름 칸이 있다.
  assert.equal(compareAnswer({ emo: '모름' }, { ...empty, emotionState: '모름' }).outcome, '일치');
  assert.equal(compareAnswer({ emo: '기쁨', int: 2 }, { ...empty, emotionState: '모름' }).outcome, '불일치');
  assert.equal(compareAnswer({ emo: '감정 없음' }, empty).got, '감정 없음');
});

test('summarize·renderReport: 판단한 것만 분모, 표에 정답·모델·결과가 들어간다', () => {
  const rows = [
    { no: 1, group: '감정', kind: '녹음/통화', route: 'text', answer: { emo: '기쁨', int: 3 }, outcome: '일치', got: '기쁨 3', seconds: 90 },
    { no: 2, group: '감정', kind: '녹음/통화', route: 'text', answer: { emo: '기쁨', int: 1 }, outcome: '감정만 일치', got: '기쁨 2' },
    { no: 4, group: '감정', kind: '영상', route: 'none', answer: { emo: '기쁨', int: 2 }, outcome: '비교 불가', reason: '영상' },
  ];
  const summary = summarize(rows);
  assert.deepEqual([summary.total, summary.judged, summary.emotionHits, summary.exactHits], [3, 2, 2, 1]);
  const report = renderReport(rows, { label: '시험', startedAt: '2026-10-29T08:00:00.000Z', models: ['a', 'b'] });
  assert.match(report, /\| 1 \| 감정 \| 녹음\/통화 \| 기쁨 3 \| 기쁨 3 \| 일치 \|/);
  assert.match(report, /감정 일치 2개\(강도까지 일치 1개\)/);
});

// run() 끝까지 — 임시 볼트·기준 예시·가짜 Ollama로. 볼트에 쓰지 않고 out 아래에만 쓰는지 본다.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'anchor-trial-'));
  const root = join(base, 'vault'), anchorRoot = join(base, 'anchors'), out = join(base, 'out');
  const rel = '20_Records/23_Conversations/2026/2026-07-15 미네 통화.md';
  mkdirSync(join(root, '20_Records/23_Conversations/2026'), { recursive: true });
  writeFileSync(join(root, rel), '---\noccurred: "2026-07-15 08:00"\nconvKind: "통화"\n---\n미네: 나 숙제 다 했어\n');
  mkdirSync(anchorRoot, { recursive: true });
  writeFileSync(join(anchorRoot, 'items-2026-10-19.json'), JSON.stringify([
    { no: 2, group: '감정', kind: '녹음/통화', ref: rel, date: '2026-07-15' },
    { no: 4, group: '감정', kind: '영상', ref: 'video:a8ff41de8aed1035', date: '2023-06-03' },
  ]));
  writeFileSync(join(anchorRoot, 'anchor-answers-2026-10-19.json'), JSON.stringify({ 2: { emo: '기쁨', int: 1 }, 4: { emo: '기쁨', int: 2 } }));
  const anchorBody = BODY.replace('| joy-3 | 기쁨 3 | [[20_Records/23_Conversations/2020/2020-01-10 미네 웃음 녹음]] (#1) |',
    '| joy-1 | 기쁨 1 | [[20_Records/23_Conversations/2026/2026-07-15 미네 통화]] (#2) |');
  const criteria = { ...fixtureCriteria, ref: 'test' };
  const vaultFiles = () => readdirSync(root, { recursive: true }).sort();
  return { base, root, anchorRoot, out, anchorBody, criteria, vaultFiles };
}
const quiet = { log() {}, error() {} };
const judgeOptions = (f, extra = {}) => ({ root: f.root, anchorRoot: f.anchorRoot, out: f.out, anchorBody: f.anchorBody,
  criteria: f.criteria, output: quiet, cues: async (items) => { for (const item of items) item.audioCues = { text: '' }; },
  ...extra });

test('run: 텍스트 한 건을 끝까지 — 결과·보고서·프롬프트는 out에만, 볼트는 그대로, 시험 대상 예시는 프롬프트에 없음', async (t) => {
  const f = fixture();
  const before = f.vaultFiles();
  const unloaded = [];
  const invoke = async () => ({ json: { emotionState: '있음', nearestAnchor: '없음', emotionEvidence: '숙제를 끝냈다고 말함', secondFilmSignal: null,
    primary: '기쁨', levels: { 기쁨: '옅음', 슬픔: '없음', 버럭: '없음', 까칠: '없음', 소심: '없음' } }, usage: {} });
  const { rows, runDir } = await run(judgeOptions(f, { invoke, unload: async (model) => { unloaded.push(model); }}));
  assert.deepEqual(f.vaultFiles(), before);
  assert.ok(runDir.startsWith(f.out));
  const row = rows.find((entry) => entry.no === 2);
  assert.equal(row.outcome, '일치');
  assert.equal(rows.find((entry) => entry.no === 4).outcome, '비교 불가');
  const prompt = readFileSync(join(runDir, 'prompts', '2.txt'), 'utf8');
  assert.match(prompt, /# 기준 예시/);
  assert.equal(prompt.includes('joy-1'), false);
  assert.ok(existsSync(join(runDir, 'report.md')));
  assert.equal(unloaded.length, 1);
});

test('run --dry-run: 소리 분석·모델·파일 쓰기 없음', async () => {
  const f = fixture();
  let cuesCalled = false, invoked = false;
  await run(judgeOptions(f, { dryRun: true, cues: async () => { cuesCalled = true; }, invoke: async () => { invoked = true; } }));
  assert.equal(cuesCalled, false);
  assert.equal(invoked, false);
  assert.equal(existsSync(f.out), false);
});

test('[막아야 함] run: Ollama가 멈추면 남은 행을 오류로 적고 부분 보고서를 쓴 뒤 멈추며, 모델은 내린다', async () => {
  const f = fixture();
  const unloaded = [];
  const invoke = async () => { const error = new Error('연결 실패'); error.unavailable = true; throw error; };
  await assert.rejects(() => run(judgeOptions(f, { invoke, unload: async (model) => { unloaded.push(model); } })), /Ollama 멈춤으로 중단/);
  const dir = join(f.out, readdirSync(f.out)[0]);
  assert.ok(existsSync(join(dir, 'report.md')));
  assert.match(readFileSync(join(dir, 'report.md'), 'utf8'), /Ollama 멈춤/);
  assert.equal(unloaded.length, 1);
});

test('run: 검증 실패는 형식 실패로 센다', async () => {
  const f = fixture();
  const invoke = async () => ({ json: { emotionState: '있음', nearestAnchor: '없음', emotionEvidence: '근거', secondFilmSignal: null,
    primary: null, levels: { 기쁨: '아주 큼' } }, usage: {} });
  const { rows } = await run(judgeOptions(f, { invoke, unload: async () => {} }));
  assert.equal(rows.find((entry) => entry.no === 2).outcome, '형식 실패');
});

test('run --engine=claude: 같은 텍스트 프롬프트를 Claude로, 모델 내리기 없음, 쿨다운이면 부르지 않고 멈춘다', async () => {
  const f = fixture();
  const prompts = [];
  const unloaded = [];
  const answer = { emotionState: '있음', nearestAnchor: '없음', emotionEvidence: '숙제를 끝냈다고 말함', secondFilmSignal: null,
    primary: '기쁨', levels: { 기쁨: '옅음', 슬픔: '없음', 버럭: '없음', 까칠: '없음', 소심: '없음' } };
  const options = { engine: 'claude', charter: { model: 'sonnet', systemPrompt: '' }, unload: async (model) => { unloaded.push(model); },
    invoke: async () => { throw new Error('Ollama를 부르면 안 됨'); } };
  const { rows, runDir } = await run(judgeOptions(f, { ...options, cooldown: () => false,
    claude: async (prompt) => { prompts.push(prompt); return `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``; } }));
  assert.equal(rows.find((entry) => entry.no === 2).outcome, '일치');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0], readFileSync(join(runDir, 'prompts', '2.txt'), 'utf8'));
  assert.equal(prompts[0].includes('joy-1'), false, '하나 빼고 시험은 Claude도 같다');
  assert.match(runDir, /-claude$/);
  assert.match(readFileSync(join(runDir, 'report.md'), 'utf8'), /claude sonnet/);
  assert.deepEqual(unloaded, []);
  const cooled = await run(judgeOptions(fixture(), { ...options, cooldown: () => true,
    claude: async () => { throw new Error('쿨다운이면 부르면 안 됨'); } }));
  assert.equal(cooled.rows.find((entry) => entry.no === 2).reason, 'Claude 쿨다운');
  await assert.rejects(() => run(judgeOptions(fixture(), { engine: 'gpt' })), /판단 엔진/);
});

test('[막아야 함] run --engine=claude: 미네 사진은 어떤 판단에도 보내지 않고 비교 불가로, 사용 한도면 남은 행을 멈춘다', async () => {
  const f = fixture();
  const items = JSON.parse(readFileSync(join(f.anchorRoot, 'items-2026-10-19.json'), 'utf8'));
  const rel2 = '20_Records/23_Conversations/2026/2026-07-16 미네 통화.md';
  writeFileSync(join(f.root, rel2), '---\noccurred: "2026-07-16 08:00"\nconvKind: "통화"\n---\n미네: 오늘 재밌었어\n');
  writeFileSync(join(f.anchorRoot, 'items-2026-10-19.json'), JSON.stringify([...items,
    { no: 5, group: '감정', kind: '사진', ref: 'photo:0123456789abcdef', date: '2024-01-01' },
    { no: 6, group: '감정', kind: '녹음/통화', ref: rel2, date: '2026-07-16' }]));
  const answers = JSON.parse(readFileSync(join(f.anchorRoot, 'anchor-answers-2026-10-19.json'), 'utf8'));
  writeFileSync(join(f.anchorRoot, 'anchor-answers-2026-10-19.json'), JSON.stringify({ ...answers, 5: { emo: '기쁨', int: 2 }, 6: { emo: '기쁨', int: 1 } }));
  let claudeCalls = 0;
  const { rows } = await run(judgeOptions(f, { engine: 'claude', charter: { model: 'sonnet', systemPrompt: '' }, cooldown: () => false,
    invoke: async () => { throw new Error('Ollama(사진 포함)를 부르면 안 됨'); },
    copyPhoto: () => { throw new Error('사진 사본을 만들면 안 됨'); }, mineFaces: new Map(),
    claude: async () => { claudeCalls += 1; throw Object.assign(new Error('사용 한도'), { isLimit: true }); } }));
  const photo = rows.find((entry) => entry.no === 5);
  assert.equal(photo.outcome, '비교 불가');
  assert.equal(photo.reason, '사진은 Claude로 보내지 않음');
  assert.equal(claudeCalls, 1, '한도에 걸리면 다음 행은 부르지 않는다');
  assert.deepEqual(rows.filter((entry) => entry.route === 'text').map((entry) => entry.reason), ['Claude 사용 한도', 'Claude 사용 한도']);
});
