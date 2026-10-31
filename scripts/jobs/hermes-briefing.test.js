import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { birthdayLines, main, runBriefing, readUnregisteredVoices } from './hermes-briefing.mjs';
import { buildMemo } from '../tools/inbox-memo.mjs';
import { parseFrontmatter, updateFrontmatter } from '../lib/vault-frontmatter.mjs';
import { readWarningEvents } from '../lib/warning-event-journal.mjs';
import { deferWarning } from '../lib/deferred-warnings.mjs';
import { renderAgentMessage } from '../lib/pantheon-send.mjs';

const journalRoot = mkdtempSync(join(tmpdir(), 'hermes-warning-'));
const warningNow = () => new Date('2026-10-10T03:00:00.000Z');
after(() => rmSync(journalRoot, { recursive: true, force: true }));
const capture = (sent) => async (message) => {
  sent.push(message);
  return { ok: true, result: { message_id: sent.length } };
};
const noVoices = () => [];

const ev = { calendar: '개인', title: '<치과>', start: '2026-10-10T10:00:00+09:00', end: '2026-10-10T11:00:00+09:00', allDay: false, location: 'A&B' };

test('아침 일정과 생일, 저녁 내일 일정, 일정 없는 저녁 미발송', async () => {
  const sent = [];
  const deps = { fetchEvents: async () => [ev], readOwners: async () => { throw new Error('unavailable'); }, readPeople: async () => [{ name: '<민>', birthday: '1990-10-10' }, { name: '동생', birthday: '2000-10-14' }], readUnregisteredVoices: noVoices, readSpending: () => ({ hasSource: false }), send: capture(sent), now: () => new Date('2026-10-10T01:00:00Z') };
  const morning = await runBriefing({ deps });
  assert.equal(sent[0].agent, 'hermes');
  assert.equal(sent[0].topic, '아침 브리핑');
  assert.match(morning.body, /■ 오늘 일정/);
  assert.match(morning.body, /&lt;치과&gt; \(A&amp;B\)/);
  assert.match(morning.body, /오늘: &lt;민&gt;\(36살\)/);
  assert.match(morning.body, /4일 뒤: 동생/);
  await runBriefing({ mode: 'evening', date: '2026-10-11', deps });
  assert.equal(sent[1].topic, '내일 일정');
  assert.match(sent[1].body, /■ 내일 일정/);
  const skipped = await runBriefing({ mode: 'evening', date: '2026-10-11', deps: { ...deps, fetchEvents: async () => [] } });
  assert.equal(skipped.reason, 'no-events');
  assert.equal(sent.length, 2);
});

test('아침 브리핑은 오늘 확인된 지출과 송금 판정 대기를 구분한다', async () => {
  const result = await runBriefing({ mode: 'morning', date: '2026-10-10', preview: true, deps: {
    fetchEvents: async () => [], readPeople: async () => [],
    readSpending: () => ({ hasSource: true, total: 2500, expenseCount: 1, pendingCount: 1,
      invalidLines: 0, byCategory: { 일반: 2500, 교통비: 0, 온누리상품권: 0 } }),
  } });
  assert.match(result.body, /오늘 지출\n- 확인된 지출 2,500원 \(1건\)/);
  assert.match(result.body, /송금 판정 대기 1건 \(합계 제외\)/);
});

test('저녁 브리핑은 내일 일정이 없어도 오늘 지출을 요약한다', async () => {
  const result = await runBriefing({ mode: 'evening', date: '2026-10-11', preview: true, deps: {
    now: () => new Date('2026-10-10T12:00:00Z'), fetchEvents: async () => [],
    readCandidates: async () => [], readUnregisteredVoices: async () => [],
    readSpending: () => ({ hasSource: true, total: 2500, expenseCount: 1, pendingCount: 0,
      invalidLines: 0, byCategory: { 일반: 2500, 교통비: 0, 온누리상품권: 0 } }),
  } });
  assert.match(result.body, /■ 오늘 지출\n- 확인된 지출 2,500원/);
  assert.match(result.body, /■ 내일 일정/);
});

test('저녁 브리핑은 다른 내용으로 발송할 때 원문 없는 지출도 명시하고 빈 브리핑은 건너뛴다', async () => {
  const deps = { now: () => new Date('2026-10-10T12:00:00Z'), readCandidates: async () => [],
    readUnregisteredVoices: async () => [], readSpending: () => ({ hasSource: false }) };
  const withEvent = await runBriefing({ mode: 'evening', date: '2026-10-11', preview: true,
    deps: { ...deps, fetchEvents: async () => [ev] } });
  assert.match(withEvent.body, /■ 오늘 지출\n- 오늘 지출 알림 기록 없음/);
  const empty = await runBriefing({ mode: 'evening', date: '2026-10-11', preview: true,
    deps: { ...deps, fetchEvents: async () => [] } });
  assert.deepEqual(empty, { skipped: true, reason: 'no-events' });
});

test('저녁 지출 조회 오류는 다른 일정이 없어도 오류를 발송하고 실패로 알린다', async () => {
  const sent = [];
  const result = await runBriefing({ mode: 'evening', date: '2026-10-11', deps: {
    now: () => new Date('2026-10-10T12:00:00Z'), fetchEvents: async () => [],
    readCandidates: async () => [], readUnregisteredVoices: async () => [],
    readSpending: () => { throw new Error('설정 형식 오류'); }, send: capture(sent),
  } });
  assert.equal(result.alert, true);
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /■ 오늘 지출\n- 지출 기록 조회 실패/);
});

test('지출 항목이 많은 브리핑은 모든 항목을 전송 길이 이내의 여러 메시지로 보낸다', async () => {
  const sent = [];
  const entries = Array.from({ length: 40 }, (_, index) => ({
    status: 'expense', merchant: `가상상점${index} ${'가'.repeat(110)}`, amount: index + 1,
    category: '일반',
  }));
  await runBriefing({ mode: 'morning', date: '2026-10-10', deps: {
    fetchEvents: async () => [], readPeople: async () => [], send: capture(sent),
    readSpending: () => ({ hasSource: true, total: 820, expenseCount: 40, pendingCount: 0,
      invalidLines: 0, byCategory: { 일반: 820, 교통비: 0, 온누리상품권: 0, 계좌이체: 0 }, entries }),
  } });
  assert.ok(sent.length > 1);
  assert.ok(sent.every((message) => renderAgentMessage(message).length <= 4096));
  const delivered = sent.map((message) => message.body).join('\n');
  for (const entry of entries) assert.ok(delivered.includes(`- ${entry.merchant} ${entry.amount}원`));
});

test('긴 단일 지출 항목도 분할하고 모든 조각의 전달을 확인한다', async () => {
  const sent = [];
  const entry = { status: 'expense', merchant: `가상상점 ${'가'.repeat(5000)} &<`, amount: 1000,
    category: '일반' };
  const deps = { fetchEvents: async () => [], readPeople: async () => [],
    readSpending: () => ({ hasSource: true, total: 1000, expenseCount: 1, pendingCount: 0,
      invalidLines: 0, byCategory: { 일반: 1000 }, entries: [entry] }) };
  await runBriefing({ mode: 'morning', date: '2026-10-10', deps: { ...deps, send: capture(sent) } });
  assert.ok(sent.length > 1);
  assert.ok(sent.every((message) => renderAgentMessage(message).length <= 4096));
  assert.ok(sent.map((message) => message.body).join('').includes('&amp;&lt;'));
  let calls = 0;
  await assert.rejects(runBriefing({ mode: 'morning', date: '2026-10-10', deps: {
    ...deps, send: async () => (++calls === 1 ? { ok: true } : { ok: true, result: { message_id: calls } }),
  } }), /전달 결과 확인 불가/);
  assert.equal(calls, 1);
});

test('OAuth 미설정이어도 생일과 일정 연결 경고를 발송한다', async () => {
  const sent = [];
  const result = await runBriefing({ mode: 'morning', date: '2026-10-10', deps: { isConfigured: () => false, readPeople: async () => [{ name: '민', birthday: '1990-10-10' }], send: capture(sent), journalRoot, now: warningNow } });
  assert.equal(result.alert, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /- 캘린더 연결 확인 필요\(google-oauth-setup\)/);
  assert.match(sent[0].body, /오늘: 민\(36살\)/);
  assert.match(readWarningEvents({ rootDir: journalRoot }).events.at(-1).detail, /캘린더 연결 확인 필요/);
  assert.deepEqual(birthdayLines('2026-10-10', [{ name: '빈값', birthday: '' }]), []);
});

test('07:30 아침 브리핑은 일정 조회 실패와 별개로 보류 경고를 먼저 정리한다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-drain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const queueFile = join(dir, 'queue.json');
  await deferWarning({ queueFile, agent: 'zeus', detail: '전날 경고',
    at: Date.parse('2026-10-11T15:00:00Z') });
  const sent = [];
  await runBriefing({ mode: 'morning', date: '2026-10-12', deps: {
    queueFile, journalRoot: join(dir, 'journal'), now: () => new Date('2026-10-11T22:30:00Z'),
    fetchEvents: async () => { throw new Error('calendar failed'); }, readPeople: async () => [],
    send: capture(sent),
  } });
  assert.equal(sent[0].topic, '경고');
  assert.equal(sent[1].topic, '아침 브리핑');
});

test('일정 조회 권한 실패여도 저녁 연결 경고를 발송한다', async () => {
  const sent = [];
  const result = await runBriefing({ mode: 'evening', date: '2026-10-11', deps: { fetchEvents: async () => { throw new Error('권한 범위 부족'); }, readUnregisteredVoices: noVoices, send: capture(sent), journalRoot, now: warningNow } });
  assert.equal(result.alert, true);
  assert.match(sent[0].body, /- 캘린더 연결 확인 필요\(google-oauth-setup\)/);
});

test('브리핑 CLI는 일정 권한 실패 경보를 종료 코드 1로 표시한다', async () => {
  const original = process.exitCode;
  try {
    process.exitCode = 0;
    await main(['--mode=morning', '--date=2026-10-10'], { fetchEvents: async () => { throw new Error('권한 범위 부족'); }, readPeople: async () => [], send: async () => ({ ok: true, result: { message_id: 10 } }), journalRoot, now: warningNow });
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = original; }
});

test('생일 파일 읽기 실패를 표시해 일정 브리핑은 발송한다', async () => {
  const sent = [];
  const result = await runBriefing({ mode: 'morning', date: '2026-10-10', deps: {
    fetchEvents: async () => [ev], readOwners: async () => { throw new Error('unavailable'); }, readPeople: async () => { throw new Error('vault unavailable'); }, send: capture(sent), journalRoot, now: warningNow,
  } });
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /■ 오늘 일정[\s\S]*■ 생일\n- 생일 정보 조회 실패/);
});

test('실제 날짜만 허용하고 잘못된 생일은 무시, 2월 29일생은 평년 3월 1일', async () => {
  assert.deepEqual(birthdayLines('2027-03-01', [{ name: '윤일', birthday: '2000-02-29' }, { name: '잘못', birthday: '2000-02-30' }, { name: '월 오류', birthday: '2000-13-01' }]), ['- 오늘: 윤일(27살)']);
  await assert.rejects(() => runBriefing({ mode: 'morning', date: '2026-02-30', deps: { fetchEvents: async () => [] } }), /형식 오류/);
});

test('자동 모드는 05~11시·18~23시만 실행한다', async () => {
  const sent = [];
  const deps = { fetchEvents: async () => [ev], readPeople: async () => [], readUnregisteredVoices: noVoices, send: capture(sent) };
  for (const hour of [0, 4, 12, 17]) {
    const result = await runBriefing({ deps: { ...deps, now: () => new Date(`2026-10-10T${String((hour + 15) % 24).padStart(2, '0')}:00:00Z`) } });
    assert.equal(result.reason, 'outside-hours');
  }
  assert.equal(sent.length, 0);
  await runBriefing({ deps: { ...deps, now: () => new Date('2026-10-09T20:00:00Z') } }); // 05 KST
  await runBriefing({ deps: { ...deps, now: () => new Date('2026-10-10T09:00:00Z') } }); // 18 KST
  assert.equal(sent.length, 2);
});

test('소유자별 아침·저녁 일정, 빈 아침과 대응표 실패 폴백', async () => {
  const sent = [];
  const deps = {
    fetchEvents: async () => [
      { ...ev, calendarId: 'b@example.com', iCalUID: 'shared' },
      { ...ev, calendarId: 'a@example.com', iCalUID: 'shared' },
      { ...ev, calendarId: 'c@example.com', iCalUID: 'mine', title: '미네 일정' },
    ],
    readOwners: async () => [
      { calendarId: 'a@example.com', owner: '나' },
      { calendarId: 'b@example.com', owner: '휘영' },
      { calendarId: 'c@example.com', owner: '미네' },
    ],
    readPeople: async () => [],
    readUnregisteredVoices: noVoices,
    send: capture(sent),
  };
  const morning = await runBriefing({ mode: 'morning', date: '2026-10-10', deps });
  assert.match(morning.body, /■ 나 — 오늘 일정\n- 10:00–11:00 &lt;치과&gt; \(A&amp;B\) \(나·휘영 함께\)/);
  assert.doesNotMatch(morning.body, /■ 휘영 — 오늘 일정/);
  assert.match(morning.body, /■ 미네 — 오늘 일정/);
  const evening = await runBriefing({ mode: 'evening', date: '2026-10-11', deps });
  assert.match(evening.body, /■ 나 — 내일 일정/);
  const empty = await runBriefing({ mode: 'morning', date: '2026-10-10', deps: { ...deps, fetchEvents: async () => [] } });
  assert.match(empty.body, /■ 오늘 일정\n- 일정 없음/);
  const fallback = await runBriefing({ mode: 'morning', date: '2026-10-10', deps: { ...deps, readOwners: async () => { throw new Error('unavailable'); } } });
  assert.match(fallback.body, /■ 오늘 일정\n- 10:00–11:00/);
  assert.equal(sent.length, 4);
});

test('저녁에는 오늘의 미등록 음성 최대 5개를 읽고 그 섹션만으로 발송한다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-voice-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const today = '2026-10-11';
  for (let index = 0; index < 7; index += 1) {
    const content = buildMemo(`가상 음성 ${index} <병원>`, { now: new Date('2026-10-10T22:00:00Z'),
      kind: '음성', voiceDurationSec: 3, transcriptModel: 'fake' });
    writeFileSync(join(dir, `${today} 070${index} 음성 ${index}.md`), `${updateFrontmatter(content, { voiceConfirm: '확인 대기 → 미등록' })}${content.slice(content.indexOf('\n---\n') + 5)}`);
  }
  writeFileSync(join(dir, '2026-10-10 0700 어제.md'), buildMemo('어제', { now: new Date('2026-10-09T22:00:00Z'), kind: '음성' }));
  const voices = readUnregisteredVoices(today, dir);
  assert.equal(voices.length, 5);
  const sent = [];
  const result = await runBriefing({ mode: 'evening', date: '2026-10-12', deps: {
    now: () => new Date('2026-10-11T12:00:00Z'), fetchEvents: async () => [], readCandidates: async () => [],
    readUnregisteredVoices: (date) => readUnregisteredVoices(date, dir), send: capture(sent),
  } });
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.match(result.body, /■ 음성으로 받은 일정·할 일 \(미등록\)/);
  assert.match(result.body, /가상 음성 0 &lt;병원&gt;/);
  assert.doesNotMatch(result.body, /가상 음성 5/);
  assert.doesNotMatch(result.body, /어제/);
});

test('전날 21시 이후 음성은 다음 저녁에 Inbox와 Records에서 한 번만 알린다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-window-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inbox = join(root, 'inbox');
  const records = join(root, 'records', '2030');
  mkdirSync(inbox);
  mkdirSync(records, { recursive: true });
  const add = (folder, title, at) => {
    const content = buildMemo(title, { now: new Date(at), kind: '음성' });
    writeFileSync(join(folder, `${title}.md`), `${updateFrontmatter(content,
      { voiceConfirm: '확인 대기 → 미등록' })}${content.slice(content.indexOf('\n---\n') + 5)}`);
  };
  add(inbox, '전날 저녁 후', '2026-10-10T12:01:00Z');
  add(records, '당일 이관', '2026-10-11T00:00:00Z');
  add(inbox, '전날 저녁 전', '2026-10-10T11:59:00Z');
  add(inbox, '다음 창', '2026-10-11T12:01:00Z');
  assert.deepEqual(readUnregisteredVoices('2026-10-11', inbox, join(root, 'records')).map((voice) => voice.text).sort(),
    ['당일 이관', '전날 저녁 후']);
  assert.deepEqual(readUnregisteredVoices('2026-10-12', inbox, join(root, 'records')).map((voice) => voice.text),
    ['다음 창']);
});

test('저녁 재실행은 이미 발송한 음성 노트를 다시 알리지 않는다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-reminded-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inboxDir = join(dir, 'inbox');
  const recordsDir = join(dir, 'records');
  mkdirSync(inboxDir);
  mkdirSync(recordsDir);
  const path = join(inboxDir, 'voice.md');
  const content = buildMemo('저녁 뒤 음성', { now: new Date('2026-10-10T13:00:00Z'), kind: '음성' });
  writeFileSync(path, `${updateFrontmatter(content, { voiceConfirm: '확인 대기 → 미등록' })}${content.slice(content.indexOf('\n---\n') + 5)}`);
  const recordsPath = join(recordsDir, 'voice-record.md');
  const recordContent = buildMemo('옮겨진 음성', { now: new Date('2026-10-11T00:00:00Z'), kind: '음성' });
  writeFileSync(recordsPath, `${updateFrontmatter(recordContent,
    { voiceConfirm: '확인 대기 → 미등록' })}${recordContent.slice(recordContent.indexOf('\n---\n') + 5)}`);
  const sent = [];
  const deps = { now: () => new Date('2026-10-11T12:00:00Z'), fetchEvents: async () => [],
    readCandidates: async () => [], readSpending: () => ({ hasSource: false }),
    readUnregisteredVoices: (date) => readUnregisteredVoices(date, inboxDir, recordsDir),
    send: capture(sent) };
  const first = await runBriefing({ mode: 'evening', date: '2026-10-12', deps });
  assert.equal(first.sent, true);
  assert.equal(parseFrontmatter(readFileSync(path, 'utf8')).voiceRemindedAt, '2026-10-11T12:00:00.000Z');
  assert.equal(parseFrontmatter(readFileSync(recordsPath, 'utf8')).voiceRemindedAt, '2026-10-11T12:00:00.000Z');
  const second = await runBriefing({ mode: 'evening', date: '2026-10-12', deps });
  assert.equal(second.reason, 'no-events');
  assert.equal(sent.length, 1);
  const unsentPath = join(inboxDir, 'unsent.md');
  writeFileSync(unsentPath, `${updateFrontmatter(content, { voiceConfirm: '확인 대기 → 미등록' })}${content.slice(content.indexOf('\n---\n') + 5)}`);
  await assert.rejects(() => runBriefing({ mode: 'evening', date: '2026-10-12',
    deps: { ...deps, send: async () => { throw new Error('발송 실패'); } } }), /발송 실패/);
  assert.equal(parseFrontmatter(readFileSync(unsentPath, 'utf8')).voiceRemindedAt, undefined);
});

test('음성 노트 조회 실패는 저녁 브리핑을 중단하지 않는다', async () => {
  const sent = [];
  const result = await runBriefing({ mode: 'evening', date: '2026-10-12', deps: {
    now: () => new Date('2026-10-11T12:00:00Z'), fetchEvents: async () => [ev], readOwners: async () => [],
    readCandidates: async () => [], readUnregisteredVoices: () => { throw new Error('unavailable'); }, send: capture(sent),
  } });
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.match(result.body, /■ 기타 — 내일 일정/);
});

test('Inbox 폴더가 없으면 미등록 음성은 빈 목록이고 예외가 나지 않는다(2026-10-23)', () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-noinbox-'));
  try {
    assert.deepEqual(readUnregisteredVoices('2026-10-23', join(root, 'missing-inbox'), join(root, 'missing-records')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 월간 지출 점검(2026-10-29): 아침 브리핑이 지난달 내보내기를 보고 대기 한 줄 또는 별도 점검 메시지를 보낸다.
const monthBase = { fetchEvents: async () => [], readPeople: async () => [], readSpending: () => ({ hasSource: false }),
  readUnregisteredVoices: noVoices, now: () => new Date('2026-11-02T00:00:00Z') };
const closedMonthReport = {
  period: { closed_month: '2026-10' }, source: { export: '2025-11-02_2026-11-02' },
  monthly: { total_expense: '1000', everyday_expense: '1000', total_income: '0', total_expense_offset: '0', net_expense: '1000' },
  coverage: { transactions: 3, parsed: 0, raw_unparsed: 0, no_alert: 3, no_source: 0 },
  missed: Array.from({ length: 3 }, () => ({ payment_instrument: 'K-패스 체크', signed_amount: '-1500', alert_coverage: 'no_alert' })),
  alert_only: [],
};
const readyMonthDeps = (calls) => ({
  planMonthCheck: ({ date }) => { calls.push(['plan', date]); return { status: 'ready', month: '2026-10' }; },
  runMonthReport: (month) => { calls.push(['run', month]); return { report: closedMonthReport, text: '{"ok":1}' }; },
  readMonthReport: (month) => { calls.push(['previous', month]); return null; },
  monthPlaces: () => ({ recordedDays: 0 }),
  commitMonthReport: (month, text) => calls.push(['commit', month, text]),
  removeMonthReport: (month) => calls.push(['remove', month]),
  createQuestion: async (question) => { calls.push(['question', question.asker, question.dedupeKey, question.urgent]); return {}; },
});

test('지난달 내보내기가 없으면 아침 브리핑에 대기 한 줄만 넣는다', async () => {
  const sent = [];
  const result = await runBriefing({ mode: 'morning', date: '2026-11-02', deps: { ...monthBase, send: capture(sent),
    planMonthCheck: () => ({ status: 'waiting', month: '2026-10' }) } });
  assert.equal(sent.length, 1);
  assert.match(result.body, /■ 지난달 지출 마감\n- 2026-10 뱅크샐러드 내보내기 대기/);
  assert.equal(result.alert, false);
});

test('내보내기가 있으면 브리핑 뒤 점검 메시지를 따로 보내고, 결과 파일을 남긴 뒤 질문을 등록한다', async () => {
  const sent = [];
  const calls = [];
  const send = async (message) => { calls.push(['send', message.topic]); return capture(sent)(message); };
  const result = await runBriefing({ mode: 'morning', date: '2026-11-02', deps: { ...monthBase, send, ...readyMonthDeps(calls) } });
  assert.deepEqual(sent.map((message) => [message.agent, message.topic]), [['hermes', '아침 브리핑'], ['hermes', '월간 지출 점검']]);
  assert.match(result.body, /2026-10 점검 결과는 이어서 따로 보냄/);
  assert.match(sent[1].body, /^2026-10 지출 마감/);
  renderAgentMessage(sent[1]);
  // 저장 → 발송 순서: 발송 뒤 저장이 실패해 같은 메시지가 날마다 다시 나가는 일을 막는다.
  assert.deepEqual(calls, [['plan', '2026-11-02'], ['run', '2026-10'], ['previous', '2026-09'], ['send', '아침 브리핑'],
    ['commit', '2026-10', '{"ok":1}'], ['send', '월간 지출 점검'], ['question', 'hermes', 'spending-alert-gap:K-패스 체크', false]]);
  assert.equal(result.alert, false);
});

test('점검 메시지 발송이 실패하면 저장한 결과 파일을 되돌리고 잡 실패로 드러낸다(다음 아침 다시)', async () => {
  const calls = [];
  let count = 0;
  const send = async () => { count += 1; return count === 1 ? { ok: true, result: { message_id: 1 } } : { ok: false }; };
  const result = await runBriefing({ mode: 'morning', date: '2026-11-02', deps: { ...monthBase, send, ...readyMonthDeps(calls) } });
  assert.deepEqual(calls.filter(([kind]) => ['commit', 'remove', 'question'].includes(kind)).map(([kind]) => kind), ['commit', 'remove']);
  assert.equal(result.alert, true);
});

test('결과 파일 저장이 실패하면 점검 메시지를 보내지 않는다(재발송 반복 방지)', async () => {
  const sent = [];
  const calls = [];
  const result = await runBriefing({ mode: 'morning', date: '2026-11-02', deps: { ...monthBase, send: capture(sent),
    ...readyMonthDeps(calls), commitMonthReport: () => { throw new Error('disk full'); } } });
  assert.deepEqual(sent.map((message) => message.topic), ['아침 브리핑']);
  assert.equal(result.alert, true);
});

test('질문 등록 실패·곁가지 읽기 실패는 메시지는 보내되 잡 경고로 올린다', async () => {
  const sent = [];
  const calls = [];
  const questionFailed = await runBriefing({ mode: 'morning', date: '2026-11-02', deps: { ...monthBase, send: capture(sent),
    ...readyMonthDeps(calls), createQuestion: async () => { throw new Error('lock'); } } });
  assert.equal(sent.at(-1).topic, '월간 지출 점검');
  assert.equal(questionFailed.alert, true);
  const placesFailed = await runBriefing({ mode: 'morning', date: '2026-11-02', deps: { ...monthBase, send: capture(sent),
    ...readyMonthDeps([]), monthPlaces: () => { throw new SyntaxError('Unexpected end of JSON input'); },
    readMonthReport: () => { throw new SyntaxError('bad'); } } });
  assert.match(sent.at(-1).body, /■ 합계/);
  assert.match(sent.at(-1).body, /■ 장소별 소비\n- 읽기 실패/);
  assert.equal(placesFailed.alert, true);
});

test('테스트에서 주입이 빠진 의존성은 실제 볼트·python 대신 실패로 끝난다', async () => {
  const result = await runBriefing({ mode: 'morning', date: '2026-11-02', preview: true, deps: { ...monthBase,
    planMonthCheck: () => ({ status: 'ready', month: '2026-10' }) } });
  assert.match(result.body, /월간 점검 실패/);
});

test('점검 계산이 실패하면 브리핑에 실패 한 줄, 미리보기는 보내지도 쓰지도 않는다', async () => {
  const sent = [];
  const failed = await runBriefing({ mode: 'morning', date: '2026-11-02', deps: { ...monthBase, send: capture(sent),
    planMonthCheck: () => ({ status: 'ready', month: '2026-10' }), runMonthReport: () => { throw new Error('python 없음'); } } });
  assert.match(failed.body, /2026-10 월간 점검 실패/);
  assert.equal(failed.alert, true);
  assert.equal(sent.length, 1);
  const calls = [];
  const preview = await runBriefing({ mode: 'morning', date: '2026-11-02', preview: true, deps: { ...monthBase, ...readyMonthDeps(calls) } });
  assert.match(preview.monthBody, /^2026-10 지출 마감/);
  assert.ok(!calls.some(([kind]) => kind === 'commit' || kind === 'question'));
});

test('저녁 브리핑은 월간 점검을 보지 않는다', async () => {
  const calls = [];
  await runBriefing({ mode: 'evening', date: '2026-11-03', preview: true, deps: { ...monthBase, fetchEvents: async () => [ev], ...readyMonthDeps(calls) } });
  assert.deepEqual(calls, []);
});

test('아침 브리핑은 어제 지출 수집이 의심될 때만 한 줄을 붙인다', async () => {
  const base = { fetchEvents: async () => [], readPeople: async () => [],
    readSpending: () => ({ hasSource: true, total: 0, expenseCount: 0, pendingCount: 0, invalidLines: 0,
      byCategory: { 일반: 0, 교통비: 0, 온누리상품권: 0 } }) };
  const asked = [];
  const check = await runBriefing({ mode: 'morning', date: '2026-11-02', preview: true, deps: { ...base,
    dayCollection: (date) => { asked.push(date); return { date, status: 'check', reason: 'argos-more', argosCount: 2, alertCount: 1 }; } } });
  assert.deepEqual(asked, ['2026-11-01']);
  assert.match(check.body, /■ 어제 지출 수집\n- 11-01 지출 수집 확인 필요: 아르고스 결제 2건, 지출 기록 1건/);
  const quiet = await runBriefing({ mode: 'morning', date: '2026-11-02', preview: true, deps: { ...base,
    dayCollection: (date) => ({ date, status: 'quiet', reason: null }) } });
  assert.doesNotMatch(quiet.body, /어제 지출 수집/);
  const broken = await runBriefing({ mode: 'morning', date: '2026-11-02', preview: true, deps: { ...base,
    dayCollection: () => { throw new Error('읽기 실패'); } } });
  assert.doesNotMatch(broken.body, /어제 지출 수집/);
});
