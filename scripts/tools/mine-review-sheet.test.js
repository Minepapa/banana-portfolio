import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureCriteria } from '../lib/mine-emotion-criteria.fixture.js';
import { anchorRefs, emotionHint, firstMineStart, renderSheet, run, runView, sampleRecords, serveSheet, FAILURE_TYPES } from './mine-review-sheet.mjs';

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
