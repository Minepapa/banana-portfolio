import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { llmRunFailed } from '../lib/llm-run-outcome.mjs';
import { buildPrompt, collectCandidates, headlinePath, runZeusHeadline, validatePick } from './zeus-headline.mjs';

const NOW = new Date('2026-10-31T22:40:00Z'); // KST 2026-11-01 07:40
const TODAY = '2026-11-01';
const quiet = { log() {}, error() {} };

function vault(t) {
  const root = mkdtempSync(join(tmpdir(), 'zeus-headline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (relPath, content) => {
    const path = join(root, relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  };
  const fm = (fields) => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n`;
  const fromAbs = (absolutePath) => relative(VAULT_PATHS.root, absolutePath);
  // 늘 있어야 하는 폴더(잡 상태·질문 큐) — 없으면 잡이 볼트 경로 오류로 본다.
  for (const key of ['jobHealth', 'stateWikiQuestions']) mkdirSync(join(root, VAULT_REL[key]), { recursive: true });
  return { root, put, fm, fromAbs };
}

function seed({ put, fm, fromAbs }) {
  put(`${VAULT_REL.stateWikiQuestions}/WQ-20261030-0000000a.md`, `${fm({ questionId: 'WQ-20261030-0000000a', status: '답변대기', asker: 'clio', urgent: true, createdAt: '2026-10-30T22:40:00.000Z' })}# q\n\n[[40_Projects/a/Requests/정리 요청|정리 요청]] 완료할까요?\n`);
  put(`${VAULT_REL.stateWikiQuestions}/WQ-20261030-0000000b.md`, `${fm({ questionId: 'WQ-20261030-0000000b', status: '처리완료' })}# q\n\n끝난 질문\n`);
  put(`${VAULT_REL.jobHealth}/daily-note.md`, fm({ status: 'FAIL', failStreak: 2, lastRun: '2026-10-31T22:00:00.000Z' }));
  put(`${VAULT_REL.jobHealth}/calendar-days.md`, fm({ status: 'OK', lastRun: '2026-10-31T22:30:00.000Z' }));
  put(`${VAULT_REL.calendarDays}/2026/${TODAY}.json`, { schemaVersion: 1, date: TODAY, events: [
    { owner: '미네', sharedWith: [], title: '태권도 심사', start: '2026-11-01T06:40:00.000Z', end: '2026-11-01T08:00:00.000Z', allDay: false, location: '가상체육관', calendar: 'm@example.com' },
    { owner: '나', sharedWith: [], title: '이미 지난 일정', start: '2026-10-31T21:00:00.000Z', end: '2026-10-31T22:00:00.000Z', allDay: false, location: null, calendar: 'a@example.com' },
  ] });
  put(fromAbs(VAULT_PATHS.state.killSwitch), fm({ active: true, changedAt: '2026-10-31T00:00:00.000Z' }));
}

test('후보 수집: 진행 중 질문·실패 잡·앞으로 남은 일정·킬스위치를 정본 상태 그대로, 경로·장소·계정은 빼고', (t) => {
  const v = vault(t);
  seed(v);
  const candidates = collectCandidates({ root: v.root, now: NOW });
  assert.deepEqual(candidates.map((item) => [item.source, item.refId, item.agent]), [
    ['question', 'WQ-20261030-0000000a', 'clio'],
    ['job', 'job-daily-note', 'clio'],
    ['calendar', `cal-${TODAY}-0`, 'hermes'],
    ['plutus', 'killswitch', 'plutus'],
  ]);
  assert.equal(candidates[0].title, '정리 요청 완료할까요?');
  assert.deepEqual(candidates[0].facts, { urgent: true, waitingHours: 24, status: '답변대기' });
  assert.equal(candidates[1].facts.failStreak, 2);
  assert.equal(candidates[2].facts.startsInMinutes, 480);
  assert.doesNotMatch(JSON.stringify(candidates), /40_Projects|가상체육관|example\.com/);
});

test('후보가 없으면 claude를 부르지 않고 empty, 쿨다운이면 부르지 않고 cooldown(단발 잡이라 실패로 기록)', async (t) => {
  const v = vault(t);
  let called = 0;
  const judge = async () => { called += 1; return ''; };
  const empty = await runZeusHeadline({ root: v.root, now: NOW, judge, cooldown: () => false, log: quiet });
  assert.equal(empty.result.status, 'empty');
  assert.equal(llmRunFailed(empty.counts), false);
  seed(v);
  const cooled = await runZeusHeadline({ root: v.root, now: NOW, judge, cooldown: () => true, log: quiet });
  assert.equal(cooled.result.status, 'cooldown');
  assert.equal(called, 0);
  assert.equal(llmRunFailed(cooled.counts), true); // retryable: false — 그 회차가 지나가면 끝이라 알린다
  assert.equal(JSON.parse(readFileSync(headlinePath(v.root), 'utf8')).status, 'cooldown');
});

test('판단 성공: 후보에서 고른 건을 계약 모양으로, 담당은 후보에서, 점 임시 파일이 남지 않는다', async (t) => {
  const v = vault(t);
  seed(v);
  const prompts = [];
  const judge = async (prompt) => { prompts.push(prompt); return JSON.stringify({ result: '{"refId":"job-daily-note","text":"데일리 노트 잡이 2회 연속 실패했습니다","sub":"기록 정리가 멈춰 오늘 확인이 필요합니다"}' }); };
  const { result, counts } = await runZeusHeadline({ root: v.root, now: NOW, judge, cooldown: () => false, log: quiet });
  assert.equal(llmRunFailed(counts), false);
  assert.deepEqual([result.status, result.pick, result.agent, result.text, result.date, result.candidates], [
    'ok', { source: 'job', refId: 'job-daily-note' }, 'clio', '데일리 노트 잡이 2회 연속 실패했습니다', TODAY, 4]);
  assert.match(prompts[0], /WQ-20261030-0000000a/);
  assert.doesNotMatch(prompts[0], /가상체육관|example\.com|40_Projects/);
  const saved = JSON.parse(readFileSync(headlinePath(v.root), 'utf8'));
  assert.equal(saved.text, result.text);
  assert.deepEqual(readdirSync(dirname(headlinePath(v.root))).filter((name) => name !== 'headline.json'), []);
});

test('출력 검증: 후보에 없는 refId·숫자·경로·긴 숫자·금고·길이 초과는 버리고 failed(잡 실패)', async (t) => {
  const v = vault(t);
  seed(v);
  const candidates = collectCandidates({ root: v.root, now: NOW });
  const secret = ['9', '9', '_Fake'].join('');
  const bad = [
    [{ refId: 'nope', text: 'x', sub: '' }, /refId/],
    [{ refId: 'job-daily-note', text: '데일리 노트 잡이 7회 실패', sub: '' }, /숫자/],
    [{ refId: 'job-daily-note', text: '40_Projects/a 확인', sub: '' }, /경로|숫자/],
    [{ refId: 'killswitch', text: '킬스위치 켜짐', sub: `${secret}/노트 확인` }, /금고/],
    [{ refId: 'killswitch', text: 'x'.repeat(51), sub: '' }, /길이/],
    [null, /객체/],
  ];
  for (const [raw, message] of bad) assert.throws(() => validatePick(raw, candidates, TODAY), message);
  assert.doesNotThrow(() => validatePick({ refId: 'job-daily-note', text: '데일리 노트 2회 실패', sub: '2/2 회차' }, candidates, TODAY));
  const { result, counts } = await runZeusHeadline({ root: v.root, now: NOW, cooldown: () => false, log: quiet,
    judge: async () => JSON.stringify({ result: '{"refId":"nope","text":"x","sub":""}' }) });
  assert.equal(result.status, 'failed');
  assert.equal(result.text, '');
  assert.equal(llmRunFailed(counts), true);
});

test('사용량 한도(isLimit)는 cooldown으로, 단발 잡이라 실패로 기록', async (t) => {
  const v = vault(t);
  seed(v);
  const judge = async () => { throw Object.assign(new Error('limit'), { isLimit: true }); };
  const { result, counts } = await runZeusHeadline({ root: v.root, now: NOW, judge, cooldown: () => false, log: quiet });
  assert.equal(result.status, 'cooldown');
  assert.equal(llmRunFailed(counts), true);
});

test('dry-run은 볼트에 쓰지 않는다', async (t) => {
  const v = vault(t);
  seed(v);
  await runZeusHeadline({ root: v.root, now: NOW, dryRun: true, cooldown: () => true, log: quiet });
  assert.equal(existsSync(headlinePath(v.root)), false);
});

test('프롬프트는 후보와 출력 계약만 담는다', () => {
  const prompt = buildPrompt([{ source: 'job', refId: 'job-x', agent: 'zeus', title: '잡 x 실패', facts: { failStreak: 1 } }], TODAY);
  assert.match(prompt, /"refId":"job-x"/);
  assert.match(prompt, /50자 이내/);
});

test('검증 강화: 숫자 세탁·링크·이메일·자격증명·한글 금액은 거부, 시각·날짜·ID·한 번 슬래시는 허용', (t) => {
  const v = vault(t);
  seed(v);
  const candidates = collectCandidates({ root: v.root, now: NOW });
  const bad = [
    [{ refId: 'killswitch', text: '킬스위치 켜짐 10억 손실 위험', sub: '' }, /금액|숫자/],
    [{ refId: 'killswitch', text: '킬스위치 켜짐', sub: '31일 000 계좌' }, /숫자/],
    [{ refId: 'killswitch', text: '일천이백만원 손실', sub: '' }, /금액/],
    [{ refId: 'killswitch', text: '확인: frank@gmail.com', sub: '' }, /링크·이메일/],
    [{ refId: 'killswitch', text: '자세히 https://evil.example', sub: '' }, /링크·이메일/],
    [{ refId: 'killswitch', text: '키 api_key=sk-ant-abcdef', sub: '' }, /민감값/],
    [{ refId: 'killswitch', text: '40_Projects/a 확인', sub: '' }, /경로/],
  ];
  for (const [raw, message] of bad) assert.throws(() => validatePick(raw, candidates, TODAY), message, raw.text);
  // 지어낸 날짜·ID, 한글로 쓴 수는 거부
  assert.throws(() => validatePick({ refId: 'killswitch', text: '2026-12-25까지 마감', sub: '' }, candidates, TODAY), /날짜·ID/);
  assert.throws(() => validatePick({ refId: 'killswitch', text: 'WQ-20991231-deadbeef 참조', sub: '' }, candidates, TODAY), /날짜·ID/);
  assert.throws(() => validatePick({ refId: 'killswitch', text: '킬스위치 일곱 건 확인', sub: '' }, candidates, TODAY), /한글로 쓴 수/);
  assert.doesNotThrow(() => validatePick({ refId: 'killswitch', text: '킬스위치 구조 점검 필요', sub: '' }, candidates, TODAY)); // '구조'는 금액 아님
  const calendar = candidates.find((item) => item.source === 'calendar');
  assert.equal(calendar.facts.startsAtKst, '15:40');
  for (const raw of [
    { refId: calendar.refId, text: '오후 3시 40분 미네 태권도 심사', sub: '8시간 뒤 · 15:40 출발 전 준비' },
    { refId: 'killswitch', text: '킬스위치 켜짐 — 매수/매도 멈춤', sub: '2026-11-01 기준' },
    { refId: 'WQ-20261030-0000000a', text: '정리 요청 답변 필요', sub: 'WQ-20261030-0000000a 하루 대기' },
  ]) assert.doesNotThrow(() => validatePick(raw, candidates, TODAY), raw.text);
});

test('출처 격리: 깨진 출처는 이름을 로그로 남기고, 후보가 0이면 empty가 아니라 failed(잡 실패)', async (t) => {
  const v = vault(t);
  mkdirSync(join(v.root, VAULT_REL.themisVerdicts), { recursive: true }); // 원장 자리에 폴더 → 읽기 실패
  const errors = [];
  const log = { log() {}, error: (line) => errors.push(line) };
  const { result, counts } = await runZeusHeadline({ root: v.root, now: NOW, judge: async () => '', cooldown: () => false, log });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.sourceErrors, ['themis']);
  assert.ok(errors.some((line) => /출처 themis/.test(line)));
  assert.equal(llmRunFailed(counts), true);
});

test('후보 규칙: 답한 질문 제외·테미스 최근 48시간 보류·거부·구슬은 사실만·전체 10건 상한', (t) => {
  const v = vault(t);
  v.put(`${VAULT_REL.stateWikiQuestions}/WQ-20261030-0000000c.md`, `${v.fm({ questionId: 'WQ-20261030-0000000c', status: '반영대기', asker: 'clio', createdAt: '2026-10-30T00:00:00.000Z' })}# q\n\n이미 답함\n`);
  const verdict = (id, verdictValue, at) => JSON.stringify({ schemaVersion: 1, id, at, kind: '기타', subject: `대상 ${id.slice(-1)}`, requestedBy: 'zeus', verdict: verdictValue, reasons: 'r', refs: [], recordedBy: 'zeus' });
  v.put(VAULT_REL.themisVerdicts, [verdict('TV-20261031-aaaaaaa1', '보류', '2026-10-31T12:00:00.000Z'), verdict('TV-20261028-aaaaaaa2', '거부', '2026-10-28T12:00:00.000Z'),
    verdict('TV-20261031-aaaaaaa3', '통과', '2026-10-31T13:00:00.000Z')].join('\n'));
  v.put(VAULT_REL.mediaOrbDailyFeed, { schemaVersion: 1, totals: { coreCandidates: 2, ambiguousPending: 0 }, days: [] });
  for (let i = 0; i < 7; i += 1) v.put(`${VAULT_REL.jobHealth}/job-${i}.md`, v.fm({ status: 'FAIL', failStreak: i, lastRun: NOW.toISOString() }));
  for (let i = 0; i < 6; i += 1) v.put(`${VAULT_REL.decisionsProposals}/2026-10-31-자산분배-매수-종목${i}-000000Z.md`, v.fm({ status: '대기' }));
  const candidates = collectCandidates({ root: v.root, now: NOW });
  assert.equal(candidates.length, 10);
  assert.ok(!candidates.some((item) => item.refId === 'WQ-20261030-0000000c'));
  // 출처별로 번갈아 채운다 — 잡 실패가 많아도 테미스·아테나·플루토스 후보가 잘리지 않는다
  for (const source of ['job', 'plutus', 'themis', 'athena']) assert.ok(candidates.some((item) => item.source === source), source);
  assert.ok(candidates.filter((item) => item.source === 'job').length <= 5);
  const small = vault(t);
  small.put(VAULT_REL.themisVerdicts, [verdict('TV-20261031-aaaaaaa1', '보류', '2026-10-31T12:00:00.000Z'), verdict('TV-20261028-aaaaaaa2', '거부', '2026-10-28T12:00:00.000Z')].join('\n'));
  small.put(VAULT_REL.mediaOrbDailyFeed, { schemaVersion: 1, totals: { coreCandidates: 2 }, days: [] });
  const few = collectCandidates({ root: small.root, now: NOW });
  assert.deepEqual(few.map((item) => item.refId), ['TV-20261031-aaaaaaa1', 'orb-core']);
  assert.equal(few[1].title, '핵심기억 후보 2개');
});

test('dry-run은 claude를 부르지 않고, 같은 날 좋은 헤드라인은 실패 결과로 덮어쓰지 않는다', async (t) => {
  const v = vault(t);
  seed(v);
  let called = 0;
  const judge = async () => { called += 1; return JSON.stringify({ result: '{"refId":"killswitch","text":"킬스위치 켜짐","sub":""}' }); };
  const dry = await runZeusHeadline({ root: v.root, now: NOW, dryRun: true, judge, cooldown: () => false, log: quiet });
  assert.deepEqual([dry.result.status, called], ['dry-run', 0]);
  await runZeusHeadline({ root: v.root, now: NOW, judge, cooldown: () => false, log: quiet });
  assert.equal(JSON.parse(readFileSync(headlinePath(v.root), 'utf8')).status, 'ok');
  await runZeusHeadline({ root: v.root, now: NOW, judge, cooldown: () => true, log: quiet });
  assert.equal(JSON.parse(readFileSync(headlinePath(v.root), 'utf8')).status, 'ok'); // 보존
});

test('대기 시간: 48시간을 넘으면 일 단위만 사실로 주고(정렬은 그대로 오래된 순), 문장에도 일 단위만 허용', (t) => {
  const v = vault(t);
  seed(v);
  // NOW 기준 382시간(약 16일) 전
  const longAgo = new Date(NOW.getTime() - 382 * 3_600_000).toISOString();
  v.put(`${VAULT_REL.stateWikiQuestions}/WQ-20261015-0000000d.md`, `${v.fm({ questionId: 'WQ-20261015-0000000d', status: '답변대기', asker: 'plutus', urgent: true, createdAt: longAgo })}# q\n\n매수 체결 기록 확인\n`);
  const candidates = collectCandidates({ root: v.root, now: NOW });
  const questions = candidates.filter((item) => item.source === 'question');
  assert.equal(questions[0].refId, 'WQ-20261015-0000000d'); // 오래된 것이 먼저
  assert.deepEqual(questions[0].facts, { urgent: true, waitingDays: 16, status: '답변대기' });
  assert.equal(questions[1].facts.waitingHours, 24); // 48시간 이하는 시간 그대로
  assert.doesNotThrow(() => validatePick({ refId: 'WQ-20261015-0000000d', text: '매수 체결 기록 확인이 16일째 대기 중', sub: '' }, candidates, TODAY));
  assert.throws(() => validatePick({ refId: 'WQ-20261015-0000000d', text: '매수 체결 기록 확인이 382시간째 대기 중', sub: '' }, candidates, TODAY), /후보에 없는 숫자/);
});
