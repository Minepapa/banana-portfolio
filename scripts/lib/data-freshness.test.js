// 데이터 신선도 판정 테스트(2026-11-03). 읽기는 메모리 가짜 readers 또는 임시 폴더로만 한다 — 실제 볼트를 읽거나 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addDays, buildFreshnessDocument, createVaultReaders, currentDigestSlot, findStaleSources, formatSourceIssue,
  kstDateOf, parseTimeValue, planDigest, readFrontmatterField, trackDigestState, writeIfChanged,
  DIGEST_RECOVERY_HOLD_MS, DIGEST_REMIND_AFTER_MS,
} from './data-freshness.mjs';

const HOUR = 3600_000;
const at = (iso) => Date.parse(iso);

// 메모리 가짜 볼트: { 'pathKey/sub/file': 내용 }
function fakeReaders(files, { isTradingDay = () => null, mtimes = {}, calls } = {}) {
  const children = (prefix) => {
    const names = new Set();
    for (const path of Object.keys(files)) {
      if (path.startsWith(`${prefix}/`)) names.add(path.slice(prefix.length + 1).split('/')[0]);
    }
    return names.size ? [...names] : null;
  };
  return {
    listDir: (key, ...sub) => (files[[key, ...sub].join('/')] !== undefined ? null : children([key, ...sub].join('/'))),
    readText: (key, ...sub) => {
      const path = [key, ...sub].join('/');
      calls?.push(path);
      return files[path] ?? null;
    },
    mtime: (key) => mtimes[key] ?? null,
    isTradingDay,
  };
}

const eventLine = (type, receivedAt, kind) => JSON.stringify({ type, received_at: receivedAt, occurred_at: receivedAt,
  ...(kind ? { payload: { kind } } : { payload: {} }) });

const HEARTBEAT = {
  id: 'hb', label: '상태 신호', owner: 'hermes', producer: 'argos-ingest',
  probe: { type: 'events-type', pathKey: 'argosEvents', eventType: 'core.heartbeat' },
  kind: 'continuous', threshold: { maxAgeMs: 2 * HOUR }, urgent: true, liveness: null,
};
const LOCATION = {
  id: 'loc', label: '위치점', owner: 'hermes', producer: 'phone:argos',
  probe: { type: 'events-type', pathKey: 'argosEvents', eventType: 'location.point_recorded' },
  kind: 'continuous', threshold: { maxAgeMs: 3 * HOUR }, urgent: false, liveness: 'hb',
};
const CALLS = {
  id: 'calls', label: '통화', owner: 'athena', producer: 'phone:argos',
  probe: { type: 'events-type', pathKey: 'argosEvents', eventType: 'media.transferred', payloadKind: 'Calls' },
  kind: 'daily-rhythm', threshold: { zeroDays: 2 }, urgent: false, liveness: 'hb',
};

test('KST 날짜 보조 함수: 날짜 경계·시각 문자열', () => {
  assert.equal(kstDateOf(at('2026-11-03T14:59:59Z')), '2026-11-03');
  assert.equal(kstDateOf(at('2026-11-03T15:00:00Z')), '2026-11-04');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(parseTimeValue('2026-11-02 10:00:00'), at('2026-11-02T01:00:00Z'));
  assert.equal(parseTimeValue('2026-11-02T01:00:00.000Z'), at('2026-11-02T01:00:00Z'));
  assert.equal(parseTimeValue(1234), 1234);
  assert.equal(parseTimeValue('아님'), null);
  assert.equal(parseTimeValue(null), null);
});

test('readFrontmatterField: 따옴표 문자열·불리언·없음', () => {
  const text = '---\ntype: "x"\ncomputedAt: "2026-11-02T22:05:08.146Z"\nisCashLike: true\n---\n본문 computedAt: 아님';
  assert.equal(readFrontmatterField(text, 'computedAt'), '2026-11-02T22:05:08.146Z');
  assert.equal(readFrontmatterField(text, 'isCashLike'), true);
  assert.equal(readFrontmatterField(text, 'missing'), null);
  assert.equal(readFrontmatterField('머리말 없음', 'computedAt'), null);
});

test('continuous: 기준 안이면 ok, 넘으면 stale, 최근 기록이 없으면 stale', () => {
  const now = at('2026-11-04T05:00:00Z');
  const fresh = fakeReaders({ 'argosEvents/2026/2026-11-04.jsonl': eventLine('core.heartbeat', now - HOUR) });
  assert.equal(findStaleSources({ now, sources: [HEARTBEAT], readers: fresh }).results[0].status, 'ok');
  const old = fakeReaders({ 'argosEvents/2026/2026-11-04.jsonl': eventLine('core.heartbeat', now - 2 * HOUR - 1) });
  const result = findStaleSources({ now, sources: [HEARTBEAT], readers: old });
  assert.equal(result.results[0].status, 'stale');
  assert.equal(result.stale.length, 1);
  assert.match(result.results[0].detail, /기준 2시간/);
  assert.equal(findStaleSources({ now, sources: [HEARTBEAT], readers: fakeReaders({}) }).results[0].status, 'stale');
});

test('continuous: 자정 넘어 어제 파일의 마지막 수신도 본다, 깨진 줄은 건너뛴다', () => {
  const now = at('2026-11-03T15:30:00Z'); // 11-04 00:30 KST
  const readers = fakeReaders({
    'argosEvents/2026/2026-11-03.jsonl': `${eventLine('core.heartbeat', now - HOUR)}\n{깨진 줄\n`,
  });
  const [r] = findStaleSources({ now, sources: [HEARTBEAT], readers }).results;
  assert.equal(r.status, 'ok');
  assert.equal(r.lastAt, now - HOUR);
});

test('daily-rhythm zeroDays: 하루 비면 ok, 이틀 연속 비면 stale, 오늘 들어오면 ok', () => {
  const now = at('2026-11-04T05:00:00Z'); // 11-04 14:00 KST
  const hb = eventLine('core.heartbeat', now - 600_000);
  const base = { 'argosEvents/2026/2026-11-04.jsonl': hb };
  const oneEmpty = fakeReaders({ ...base, 'argosEvents/2026/2026-11-02.jsonl': eventLine('media.transferred', at('2026-11-02T03:00:00Z'), 'Calls') });
  assert.equal(findStaleSources({ now, sources: [HEARTBEAT, CALLS], readers: oneEmpty }).results[1].status, 'ok');
  const twoEmpty = fakeReaders({ ...base, 'argosEvents/2026/2026-11-01.jsonl': eventLine('media.transferred', at('2026-11-01T03:00:00Z'), 'Calls') });
  const r = findStaleSources({ now, sources: [HEARTBEAT, CALLS], readers: twoEmpty }).results[1];
  assert.equal(r.status, 'stale');
  assert.match(r.detail, /2일째 0건/);
  const today = fakeReaders({ 'argosEvents/2026/2026-11-04.jsonl': `${hb}\n${eventLine('media.transferred', now - HOUR, 'Calls')}` });
  assert.equal(findStaleSources({ now, sources: [HEARTBEAT, CALLS], readers: today }).results[1].status, 'ok');
  // 다른 종류(카메라)는 통화로 세지 않는다.
  const camera = fakeReaders({ ...base, 'argosEvents/2026/2026-11-03.jsonl': eventLine('media.transferred', at('2026-11-03T03:00:00Z'), 'Camera'),
    'argosEvents/2026/2026-11-01.jsonl': eventLine('media.transferred', at('2026-11-01T03:00:00Z'), 'Calls') });
  assert.equal(findStaleSources({ now, sources: [HEARTBEAT, CALLS], readers: camera }).results[1].status, 'stale');
});

test('daily-rhythm zeroDays(dated-jsonl): 소비 3일 연속 0건이면 stale, 빈 파일은 0건', () => {
  const spending = {
    id: 'spend', label: '소비', owner: 'hermes', producer: 'phone:kakao-notification',
    probe: { type: 'dated-jsonl', pathKey: 'spending', layout: 'year', timeField: 'postedAt' },
    kind: 'daily-rhythm', threshold: { zeroDays: 3 }, urgent: false, liveness: null,
  };
  const now = at('2026-11-05T05:00:00Z'); // 11-05 KST
  const row = (postedAt) => JSON.stringify({ id: 'x', ts: '가상', postedAt });
  const twoEmpty = fakeReaders({ 'spending/2026/2026-11-02.jsonl': row(at('2026-11-02T01:00:00Z')), 'spending/2026/2026-11-04.jsonl': '' });
  const ok = findStaleSources({ now, sources: [spending], readers: twoEmpty }).results[0];
  assert.equal(ok.status, 'ok');
  assert.equal(ok.lastAt, at('2026-11-02T01:00:00Z'));
  const threeEmpty = fakeReaders({ 'spending/2026/2026-11-01.jsonl': row(at('2026-11-01T01:00:00Z')) });
  assert.equal(findStaleSources({ now, sources: [spending], readers: threeEmpty }).results[0].status, 'stale');
});

test('daily-rhythm 마감 시각: 데일리 노트는 다음날 02:00 KST 전엔 없어도 ok, 지나면 stale', () => {
  const daily = {
    id: 'daily', label: '데일리', owner: 'clio', producer: 'daily-note',
    probe: { type: 'dated-files', pathKey: 'dailyNotes', layout: 'year', ext: '.md' },
    kind: 'daily-rhythm', threshold: { dueHourNextDayKst: 2, lookbackDays: 3 }, urgent: true, liveness: null,
  };
  const files = { 'dailyNotes/2026/2026-11-01.md': 'x', 'dailyNotes/2026/2026-11-02.md': 'x', 'dailyNotes/2026/메모.md': 'x' };
  const before = at('2026-11-03T16:59:00Z'); // 11-04 01:59 KST — 11-03 노트 마감 전
  assert.equal(findStaleSources({ now: before, sources: [daily], readers: fakeReaders(files) }).results[0].status, 'ok');
  const after = at('2026-11-03T17:01:00Z'); // 11-04 02:01 KST
  const r = findStaleSources({ now: after, sources: [daily], readers: fakeReaders(files) }).results[0];
  assert.equal(r.status, 'stale');
  assert.match(r.detail, /2026-11-03/);
  assert.equal(findStaleSources({ now: after, sources: [daily],
    readers: fakeReaders({ ...files, 'dailyNotes/2026/2026-11-03.md': 'x' }) }).results[0].status, 'ok');
});

test('daily-rhythm 마감 시각: 기록 시작 전 날짜는 빈칸으로 치지 않고, 중간 빈 날짜는 잡는다(연도 없는 폴더)', () => {
  const snap = {
    id: 'snap', label: '스냅샷', owner: 'plutus', producer: 'update-monthly-balance-snapshot',
    probe: { type: 'dated-files', pathKey: 'factsLedgerDailySnapshots', layout: 'flat', ext: '.md' },
    kind: 'daily-rhythm', threshold: { dueHourNextDayKst: 1, lookbackDays: 14 }, urgent: false, liveness: null,
  };
  const now = at('2026-11-04T05:00:00Z');
  const started = fakeReaders({ 'factsLedgerDailySnapshots/2026-11-02.md': 'x', 'factsLedgerDailySnapshots/2026-11-03.md': 'x' });
  assert.equal(findStaleSources({ now, sources: [snap], readers: started }).results[0].status, 'ok');
  const gap = fakeReaders({ 'factsLedgerDailySnapshots/2026-10-30.md': 'x', 'factsLedgerDailySnapshots/2026-11-01.md': 'x',
    'factsLedgerDailySnapshots/2026-11-03.md': 'x' });
  const r = findStaleSources({ now, sources: [snap], readers: gap }).results[0];
  assert.equal(r.status, 'stale');
  assert.equal(r.detail, '빈 날짜 2026-10-31, 2026-11-02');
});

const MACRO = {
  id: 'macro', label: '거시', owner: 'plutus', producer: 'update-macro-indicators-cache',
  probe: { type: 'frontmatter-field', pathKey: 'macroIndicatorsFile', field: 'computedAt' },
  kind: 'market-day', threshold: { graceHoursKst: 10 }, urgent: false, liveness: null,
};
const macroFile = (iso) => ({ macroIndicatorsFile: `---\ntype: "macro"\ncomputedAt: "${iso}"\n---\n` });

test('market-day: 월요일 아침엔 금요일 값이면 충분하고, 10시 지나면 월요일 값이 있어야 한다', () => {
  const saturdayRun = '2026-10-30T22:05:00Z'; // 10-31(토) 07:05 KST
  const fridayRun = '2026-10-29T22:05:00Z'; // 10-30(금) 07:05 KST
  const mondayMorning = at('2026-11-01T23:30:00Z'); // 11-02(월) 08:30 KST
  assert.equal(findStaleSources({ now: mondayMorning, sources: [MACRO], readers: fakeReaders(macroFile(fridayRun)) }).results[0].status, 'ok');
  const mondayNoon = at('2026-11-02T03:00:00Z'); // 11-02(월) 12:00 KST
  const r = findStaleSources({ now: mondayNoon, sources: [MACRO], readers: fakeReaders(macroFile(fridayRun)) }).results[0];
  assert.equal(r.status, 'stale');
  assert.match(r.detail, /2026-11-02/);
  assert.equal(findStaleSources({ now: mondayNoon, sources: [MACRO], readers: fakeReaders(macroFile('2026-11-01T22:05:00Z')) }).results[0].status, 'ok');
  // 주말(일요일 낮)엔 금요일 값이면 ok, 토요일 값(금요일 이후)이면 당연히 ok.
  const sunday = at('2026-11-01T05:00:00Z');
  assert.equal(findStaleSources({ now: sunday, sources: [MACRO], readers: fakeReaders(macroFile(fridayRun)) }).results[0].status, 'ok');
  assert.equal(findStaleSources({ now: sunday, sources: [MACRO], readers: fakeReaders(macroFile(saturdayRun)) }).results[0].status, 'ok');
});

test('market-day: 휴장일 캐시(false)면 그날을 건너뛰고, 캐시가 없으면(null) 평일을 거래일로 본다', () => {
  const thursdayRun = '2026-10-28T22:05:00Z'; // 10-29(목) 07:05 KST
  const fridayNoon = at('2026-10-30T03:00:00Z'); // 10-30(금) 12:00 KST
  const holiday = fakeReaders(macroFile(thursdayRun), { isTradingDay: (label) => (label === '2026-10-30' ? false : null) });
  assert.equal(findStaleSources({ now: fridayNoon, sources: [MACRO], readers: holiday }).results[0].status, 'ok');
  const noCache = fakeReaders(macroFile(thursdayRun));
  assert.equal(findStaleSources({ now: fridayNoon, sources: [MACRO], readers: noCache }).results[0].status, 'stale');
});

test('market-day 폴더: 현금성 파일은 빼고 가장 최근 갱신을 본다', () => {
  const prices = {
    id: 'prices', label: '시세', owner: 'plutus', producer: 'update-holdings-prices',
    probe: { type: 'frontmatter-field', pathKey: 'stateHoldings', field: 'updatedAt', skipIfTrue: 'isCashLike' },
    kind: 'market-day', threshold: { graceHoursKst: 18 }, urgent: false, liveness: null,
  };
  const now = at('2026-11-04T10:00:00Z'); // 11-04(수) 19:00 KST
  const readers = fakeReaders({
    'stateHoldings/가상A.md': '---\nisCashLike: false\nupdatedAt: "2026-11-03T06:30:00Z"\n---\n',
    'stateHoldings/가상B.md': '---\nisCashLike: false\nupdatedAt: "2026-11-02T06:30:00Z"\n---\n',
    'stateHoldings/가상-예수금.md': '---\nisCashLike: true\nupdatedAt: "2026-11-04T09:00:00Z"\n---\n',
  });
  const r = findStaleSources({ now, sources: [prices], readers }).results[0];
  assert.equal(r.status, 'stale');
  assert.equal(r.lastAt, at('2026-11-03T06:30:00Z'));
});

test('상위 채널 묶기: 상태 신호가 끊기면 위치·통화는 suppressed, 살아 있으면 위치 끊김만 stale', () => {
  const now = at('2026-11-04T05:00:00Z');
  const dead = fakeReaders({ 'argosEvents/2026/2026-11-04.jsonl': [
    eventLine('core.heartbeat', now - 5 * HOUR), eventLine('location.point_recorded', now - 5 * HOUR)].join('\n') });
  const result = findStaleSources({ now, sources: [HEARTBEAT, LOCATION, CALLS], readers: dead });
  assert.deepEqual(result.results.map((r) => r.status), ['stale', 'suppressed', 'suppressed']);
  assert.deepEqual(result.stale.map((r) => r.id), ['hb']);
  assert.match(result.results[1].detail, /상위 채널 hb/);
  const alive = fakeReaders({ 'argosEvents/2026/2026-11-04.jsonl': [
    eventLine('core.heartbeat', now - 600_000), eventLine('location.point_recorded', now - 5 * HOUR),
    eventLine('media.transferred', now - HOUR, 'Calls')].join('\n') });
  assert.deepEqual(findStaleSources({ now, sources: [HEARTBEAT, LOCATION, CALLS], readers: alive }).stale.map((r) => r.id), ['loc']);
});

test('producer 잡이 이미 조용함 경보 중이면 그 출처와 하위 출처는 묶는다', () => {
  const now = at('2026-11-04T05:00:00Z');
  const readers = fakeReaders({ 'argosEvents/2026/2026-11-04.jsonl': eventLine('core.heartbeat', now - 5 * HOUR) });
  const result = findStaleSources({ now, sources: [HEARTBEAT, LOCATION], readers, silentJobs: new Set(['argos-ingest']) });
  assert.deepEqual(result.results.map((r) => r.status), ['suppressed', 'suppressed']);
  assert.deepEqual(result.stale, []);
});

test('bursty·표시 전용·미수집은 경보하지 않고 마지막 시각만 보인다', () => {
  const now = at('2026-11-04T05:00:00Z');
  const sources = [
    { id: 'cam', label: '카메라', owner: 'athena', producer: 'phone:argos',
      probe: { type: 'events-type', pathKey: 'argosEvents', eventType: 'media.transferred', payloadKind: 'Camera', lookbackDays: 14 },
      kind: 'bursty', threshold: null, urgent: false, liveness: null },
    { id: 'rec', label: '녹음', owner: 'athena', producer: 'phone:argos', probe: { type: 'not-collected' },
      kind: 'display-only', threshold: null, urgent: false, liveness: null },
    { id: 'todo', label: '할 일', owner: 'hermes', producer: 'calendar-days', probe: { type: 'file-mtime', pathKey: 'todoOpen' },
      kind: 'display-only', threshold: null, urgent: false, liveness: null },
  ];
  const readers = fakeReaders({ 'argosEvents/2026/2026-10-24.jsonl': eventLine('media.transferred', at('2026-10-24T03:00:00Z'), 'Camera') },
    { mtimes: { todoOpen: at('2026-10-31T11:00:00Z') } });
  const result = findStaleSources({ now, sources, readers });
  assert.deepEqual(result.results.map((r) => r.status), ['display', 'not-collected', 'display']);
  assert.equal(result.results[0].lastAt, at('2026-10-24T03:00:00Z'));
  assert.equal(result.results[2].lastAt, at('2026-10-31T11:00:00Z'));
  assert.deepEqual(result.stale, []);
});

test('한 출처 읽기 실패는 error로 남기고 나머지 판정은 계속한다', () => {
  const now = at('2026-11-04T05:00:00Z');
  const readers = fakeReaders({ 'argosEvents/2026/2026-11-04.jsonl': eventLine('core.heartbeat', now - 5 * HOUR) });
  const broken = { ...readers, mtime: () => { throw new Error('권한 없음'); } };
  const sources = [{ id: 'todo', label: '할 일', owner: 'hermes', producer: 'calendar-days',
    probe: { type: 'file-mtime', pathKey: 'todoOpen' }, kind: 'display-only', threshold: null, urgent: false, liveness: null }, HEARTBEAT];
  const result = findStaleSources({ now, sources, readers: broken });
  assert.equal(result.results[0].status, 'error');
  assert.match(result.results[0].detail, /권한 없음/);
  assert.equal(result.results[1].status, 'stale');
});

test('아르고스 날짜 파일은 한 실행에서 한 번만 읽는다(출처 여럿이 나눠 씀)', () => {
  const now = at('2026-11-04T05:00:00Z');
  const calls = [];
  const readers = fakeReaders({ 'argosEvents/2026/2026-11-04.jsonl': eventLine('core.heartbeat', now - 600_000) }, { calls });
  findStaleSources({ now, sources: [HEARTBEAT, LOCATION, CALLS], readers });
  const eventReads = calls.filter((path) => path.startsWith('argosEvents/'));
  assert.equal(eventReads.length, new Set(eventReads).size);
  assert.equal(eventReads.length, 8); // 기본 최근 7일 + 오늘
});

test('createVaultReaders: 임시 볼트에서 경로 키로 읽고, 점 파일·없는 경로는 무시한다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'freshness-vault-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rel = { argosEvents: 'E/Events', todoOpen: 'E/Todo/Open.json' };
  mkdirSync(join(root, 'E', 'Events', '2026'), { recursive: true });
  const now = at('2026-11-04T05:00:00Z');
  writeFileSync(join(root, 'E', 'Events', '2026', '2026-11-04.jsonl'), `${eventLine('core.heartbeat', now - 600_000)}\n`);
  writeFileSync(join(root, 'E', 'Events', '2026', '.lock'), '');
  const readers = createVaultReaders({ root, rel });
  assert.deepEqual(readers.listDir('argosEvents', '2026'), ['2026-11-04.jsonl']);
  assert.equal(readers.readText('argosEvents', '2026', 'none.jsonl'), null);
  assert.equal(readers.mtime('todoOpen'), null);
  assert.throws(() => readers.listDir('nope'), /VAULT_REL에 없는 경로 키/);
  assert.equal(findStaleSources({ now, sources: [HEARTBEAT], readers }).results[0].status, 'ok');
});

test('writeIfChanged: generatedAt만 바뀌면 쓰지 않고, 내용이 바뀌면 쓴다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'Jobs', 'DataFreshness.json');
  const results = [{ id: 'hb', label: '상태 신호', owner: 'hermes', kind: 'continuous', urgent: true, status: 'ok', lastAt: 1000, detail: '' }];
  assert.equal(writeIfChanged(file, buildFreshnessDocument(results, 5000)), true);
  const firstMtime = statSync(file).mtimeMs;
  assert.equal(writeIfChanged(file, buildFreshnessDocument(results, 9000)), false);
  assert.equal(statSync(file).mtimeMs, firstMtime);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).generatedAt, new Date(5000).toISOString());
  assert.equal(writeIfChanged(file, buildFreshnessDocument([{ ...results[0], status: 'stale' }], 9000)), true);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(doc.sources[0].status, 'stale');
  assert.equal(doc.sources[0].lastReceivedAt, new Date(1000).toISOString());
  assert.deepEqual(readdirSync(join(dir, 'Jobs')), ['DataFreshness.json'], '임시 파일이 남지 않는다');
  writeFileSync(file, '{깨짐');
  assert.equal(writeIfChanged(file, buildFreshnessDocument(results, 9000)), true);
});

test('formatSourceIssue: 이름·마지막 수신(KST)·사유를 한 줄로', () => {
  const line = formatSourceIssue({ id: 'hb', label: '상태 신호', lastAt: at('2026-11-04T01:00:00Z'), detail: '3.0시간째 없음' });
  assert.equal(line, '데이터 <code>상태 신호</code>(hb) 끊김 — 마지막 수신 2026-11-04 10:00, 3.0시간째 없음');
  assert.match(formatSourceIssue({ id: 'x', label: 'x', lastAt: null, detail: '' }), /기록 없음/);
});

test('currentDigestSlot: 09·19시 KST 뒤 3시간 안에서만 슬롯', () => {
  assert.equal(currentDigestSlot(at('2026-11-04T00:00:00Z')), '2026-11-04@09'); // 09:00 KST
  assert.equal(currentDigestSlot(at('2026-11-04T02:59:00Z')), '2026-11-04@09');
  assert.equal(currentDigestSlot(at('2026-11-04T03:00:00Z')), null); // 12:00
  assert.equal(currentDigestSlot(at('2026-11-03T23:59:00Z')), null); // 08:59
  assert.equal(currentDigestSlot(at('2026-11-04T10:30:00Z')), '2026-11-04@19');
  assert.equal(currentDigestSlot(at('2026-11-04T13:00:00Z')), null); // 22:00
});

const nonUrgent = (status) => [{ id: 'loc', label: '위치점', owner: 'hermes', urgent: false, status, lastAt: null, detail: '' }];

test('묶음 계획: 30분 깜빡임은 가짜 복구를 만들지 않고, 보낸 적 없는 깜빡임은 조용히 지운다', () => {
  const nine = at('2026-11-04T00:00:00Z');
  let state = trackDigestState({}, nonUrgent('stale'), nine);
  let plan = planDigest(state, nonUrgent('stale'), nine);
  assert.deepEqual(plan.due.map((r) => [r.id, r.reminder]), [['loc', false]]);
  state.sources.loc.lastSentAt = nine;
  // 09:30부터 18:30까지 30분마다 ok/stale 깜빡임
  for (let t = nine + 0.5 * HOUR, i = 0; t <= nine + 9.5 * HOUR; t += 0.5 * HOUR, i += 1) {
    state = trackDigestState(state, nonUrgent(i % 2 ? 'stale' : 'ok'), t);
  }
  const seven = nine + 10 * HOUR;
  plan = planDigest(state, nonUrgent('ok'), seven);
  assert.deepEqual(plan, { due: [], recovered: [], dropped: [] }, '19시: 복구도 재알림도 없음');
  // 6시간 연속 ok이면 그때 복구.
  const later = state.sources.loc.lastBadAt + DIGEST_RECOVERY_HOLD_MS;
  assert.deepEqual(planDigest(state, nonUrgent('ok'), later).recovered.map((r) => r.id), ['loc']);
  // 보낸 적 없는 깜빡임은 복구 알림 없이 지운다.
  const blip = trackDigestState({}, nonUrgent('stale'), nine + HOUR);
  const blipPlan = planDigest(blip, nonUrgent('ok'), seven);
  assert.deepEqual([blipPlan.recovered, blipPlan.dropped], [[], ['loc']]);
});

test('묶음 계획: 계속 끊겨 있으면 하루 한 번만 다시 알린다, suppressed·error는 판단 보류', () => {
  const nine = at('2026-11-04T00:00:00Z');
  let state = trackDigestState({}, nonUrgent('stale'), nine);
  state.sources.loc.lastSentAt = nine;
  state = trackDigestState(state, nonUrgent('stale'), nine + 10 * HOUR);
  assert.deepEqual(planDigest(state, nonUrgent('stale'), nine + 10 * HOUR).due, [], '같은 날 19시엔 재알림 없음');
  const next = nine + DIGEST_REMIND_AFTER_MS + 4 * HOUR; // 다음날 09시
  state = trackDigestState(state, nonUrgent('stale'), next);
  assert.deepEqual(planDigest(state, nonUrgent('stale'), next).due.map((r) => r.reminder), [true]);
  // 상위 채널 때문에 묶이면 lastBadAt만 이어 붙여 복구로 치지 않는다.
  state = trackDigestState(state, nonUrgent('suppressed'), next + 7 * HOUR);
  assert.equal(state.sources.loc.lastBadAt, next + 7 * HOUR);
  assert.deepEqual(planDigest(state, nonUrgent('suppressed'), next + 10 * HOUR).recovered, []);
  // 긴급 출처는 묶음 상태에 넣지 않는다.
  assert.deepEqual(trackDigestState({}, [{ ...nonUrgent('stale')[0], urgent: true }], nine).sources, {});
});
