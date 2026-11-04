import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIVESYNC_DATA_REL, VERIFIED_PLUGIN_VERSION, isLiveSyncTarget, parseLiveSyncFilter as parseFull, readLiveSyncFilter } from './livesync-filter.mjs';

// vault-paths를 읽는 모듈(livesync-watch)은 정적 import하지 않는다 — 임시 볼트를 VAULT_PATH로 정한 뒤 동적으로 부른다.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'livesync-filter-'));
process.env.VAULT_PATH = TMP_ROOT;
const { vaultChangedAfter, guardUncertainFilter, ESCALATE_REPEAT_MS } = await import('../jobs/livesync-watch.mjs');
const parseLiveSyncFilter = (text, log) => parseFull(text, log).filter;

// 2026-11-04 승인 규칙(맥 LiveSync에 넣을 예정)
const PLANNED = ['^95_Etna/Investing/', '^95_Etna/Jobs/', '^95_Etna/Events/', '^95_Etna/Location/(\\d{4}/|Today\\.json$|geocode-cache\\.json$)'].join('|[]|');
const settings = (extra) => JSON.stringify({ couchDB_PASSWORD: 'should-not-leak', syncIgnoreRegEx: PLANNED, ...extra });

test('parseLiveSyncFilter: |[]|로 나누고 빈 항목·공백·줄바꿈을 버리며, 필요한 키만 돌려준다', () => {
  const f = parseLiveSyncFilter(settings({ syncIgnoreRegEx: `|[]|${PLANNED}|[]||[]|\n^a /b/ ` }));
  assert.deepEqual(Object.keys(f).sort(), ['ignore', 'only']);
  assert.equal(f.ignore.length, 5);
  assert.equal(f.ignore[4].regexp.source, '^a\\/b\\/', '공백·줄바꿈은 플러그인처럼 지운다');
  assert.equal(JSON.stringify(f).includes('should-not-leak'), false);
  assert.deepEqual(parseFull(settings({ syncIgnoreRegEx: '' })), { filter: { ignore: [], only: [] }, status: 'ok', invalidRules: 0 });
});

test('isLiveSyncTarget: 예정 규칙 — 제외 경로와 남는 경로', () => {
  const f = parseLiveSyncFilter(settings());
  for (const p of ['95_Etna/Investing/Ledger/a.md', '95_Etna/Jobs/JobHealth/x.json', '95_Etna/Events/2026/e.json',
    '95_Etna/Location/2026/11/04.json', '95_Etna/Location/Today.json', '95_Etna/Location/geocode-cache.json']) {
    assert.equal(isLiveSyncTarget(p, f), false, p);
  }
  for (const p of ['10_Periodic/Daily/2026-11-04.md', '95_Etna/Questions/q.md', '95_Etna/Location/Places.md',
    '95_Etna/Location/Today.json.bak', 'x/95_Etna/Jobs/a.json']) {
    assert.equal(isLiveSyncTarget(p, f), true, p);
  }
  assert.equal(isLiveSyncTarget('95_Etna/Jobs/a.json', null), true, '필터 없음이면 모든 경로');
});

test('isLiveSyncTarget: handleFilenameCaseSensitive가 참일 때만 대소문자를 가린다(없으면 i)', () => {
  const p = '95_etna/jobs/a.json';
  assert.equal(isLiveSyncTarget(p, parseLiveSyncFilter(settings())), false, '키 없음 → i');
  assert.equal(isLiveSyncTarget(p, parseLiveSyncFilter(settings({ handleFilenameCaseSensitive: false }))), false);
  assert.equal(isLiveSyncTarget(p, parseLiveSyncFilter(settings({ handleFilenameCaseSensitive: true }))), true);
});

test('isLiveSyncTarget: !! 뒤집은 규칙과 syncOnlyRegEx', () => {
  const inv = parseLiveSyncFilter(settings({ syncIgnoreRegEx: '!!^10_' }));
  assert.equal(isLiveSyncTarget('10_Periodic/a.md', inv), true);
  assert.equal(isLiveSyncTarget('20_Records/a.md', inv), false);
  const only = parseLiveSyncFilter(settings({ syncOnlyRegEx: '^10_|[]|^20_' }));
  assert.equal(isLiveSyncTarget('20_Records/a.md', only), true);
  assert.equal(isLiveSyncTarget('30_Wiki/a.md', only), false);
  assert.equal(isLiveSyncTarget('95_Etna/Jobs/a.json', parseLiveSyncFilter(settings({ syncOnlyRegEx: '^95_' }))), false, 'only 통과 뒤 ignore');
});

test('parseLiveSyncFilter: 잘못된 정규식 항목은 그 항목만 버리고 로그, 남은 규칙은 쓴다', () => {
  const logs = [];
  const full = parseFull(settings({ syncIgnoreRegEx: '^95_Etna/Jobs/|[]|^(broken|[]|[z-a]', syncOnlyRegEx: '(' }), (m) => logs.push(m));
  const f = full.filter;
  assert.equal(full.status, 'ok');
  assert.equal(full.invalidRules, 3);
  assert.ok(logs.every((m) => m.includes('재시작으로 고쳐지지 않는 설정 오류')));
  assert.equal(f.ignore.length, 1);
  assert.equal(f.only.length, 0, 'only가 모두 잘못됐으면 제한 없음');
  assert.equal(logs.length, 3);
  assert.equal(isLiveSyncTarget('95_Etna/Jobs/a.json', f), false);
  assert.equal(isLiveSyncTarget('30_Wiki/a.md', f), true);
});

test('parseLiveSyncFilter·readLiveSyncFilter: 상태 코드, 깨졌으면 filter null(모든 경로), 원문은 로그에 남기지 않는다', () => {
  const logs = [];
  const log = (m) => logs.push(m);
  assert.deepEqual(parseFull('{"couchDB_PASSWORD":"should-not-leak", broken', log), { filter: null, status: 'parse-fail', invalidRules: 0 });
  assert.equal(parseFull('null', log).status, 'bad-type');
  assert.equal(parseFull('"text"', log).status, 'bad-type');
  assert.deepEqual(parseFull(settings({ syncIgnoreRegEx: 3 }), log), { filter: null, status: 'bad-type', invalidRules: 0 });
  assert.equal(parseFull(settings({ syncOnlyRegEx: ['^a'] }), log).status, 'bad-type');
  assert.equal(logs.some((m) => m.includes('should-not-leak')), false);
  const root = mkdtempSync(join(tmpdir(), 'livesync-filter-read-'));
  const dir = join(root, LIVESYNC_DATA_REL, '..');
  try {
    assert.deepEqual(readLiveSyncFilter(root, log), { filter: null, status: 'missing', invalidRules: 0, pluginVersion: null, versionOk: false }, '파일 없음 = 규칙 없음');
    mkdirSync(join(root, LIVESYNC_DATA_REL), { recursive: true }); // 같은 이름 폴더 → 읽기 실패(EISDIR)
    assert.equal(readLiveSyncFilter(root, log).status, 'read-fail');
    rmSync(join(root, LIVESYNC_DATA_REL), { recursive: true });
    writeFileSync(join(root, LIVESYNC_DATA_REL), settings());
    const vlogs = [];
    let r = readLiveSyncFilter(root, (m) => vlogs.push(m));
    assert.equal(r.status, 'ok');
    assert.equal(r.filter.ignore.length, 4);
    assert.equal(r.versionOk, false, 'manifest 없음 → 판 모름');
    assert.equal(vlogs.length, 1, '판이 다르거나 모르면 로그로 표시만');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: '1.0.43' }));
    r = readLiveSyncFilter(root, () => {});
    assert.deepEqual([r.status, r.pluginVersion, r.versionOk, r.filter.ignore.length], ['ok', '1.0.43', false, 4], '판이 달라도 판정은 그대로');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: VERIFIED_PLUGIN_VERSION }));
    vlogs.length = 0;
    r = readLiveSyncFilter(root, (m) => vlogs.push(m));
    assert.equal(r.versionOk, true);
    assert.equal(vlogs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseLiveSyncFilter: 규칙 키가 null이면 빈 규칙으로 본다(리뷰 LOW-3)', () => {
  const r = parseFull(JSON.stringify({ syncIgnoreRegEx: null, syncOnlyRegEx: null, handleFilenameCaseSensitive: null }));
  assert.deepEqual(r, { filter: { ignore: [], only: [] }, status: 'ok', invalidRules: 0 });
  assert.equal(parseFull('{}').status, 'ok', '키 없음도 빈 규칙');
});

test('isLiveSyncTarget·vaultChangedAfter: macOS NFD 파일 이름도 NFC 규칙에 맞는다(리뷰 LOW-2)', () => {
  const f = parseLiveSyncFilter(settings({ syncIgnoreRegEx: '^95_Etna/위치/' }));
  assert.equal(isLiveSyncTarget('95_Etna/위치/a.json'.normalize('NFD'), f), true, '정규화하지 않으면 안 맞는다(부르는 쪽이 NFC로)');
  const root = mkdtempSync(join(tmpdir(), 'livesync-filter-nfc-'));
  try {
    const rel = '95_Etna/위치/a.json'.normalize('NFD');
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), 'x');
    assert.equal(vaultChangedAfter(root, 0, f), false, 'NFD 이름도 제외 규칙에 맞음');
    assert.equal(vaultChangedAfter(root, 0, null), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('guardUncertainFilter: 설정 불확실이면 재시작 경로로 가지 않고 알림은 6시간에 한 번, ok·missing은 기존 경로', async () => {
  const T = new Date('2026-11-04T05:00:00Z');
  const make = () => {
    const sent = [];
    const saved = [];
    let restarted = 0;
    const deps = { notify: async (lines) => { sent.push(lines); }, writeState: (s) => { saved.push({ ...s }); } };
    // main과 같은 순서: 가드가 true면 재시작하지 않는다.
    const runStalledTail = async (state, status, now) => {
      if (await guardUncertainFilter(state, status, '번호 10가 45분째 그대로인데 볼트는 바뀜', now, deps)) return;
      restarted += 1;
    };
    return { sent, saved, runStalledTail, restarts: () => restarted };
  };
  for (const status of ['ok', 'missing']) {
    const h = make();
    await h.runStalledTail({}, status, T);
    assert.equal(h.restarts(), 1, `${status}는 기존 재시작 경로`);
    assert.equal(h.sent.length + h.saved.length, 0);
  }
  for (const status of ['read-fail', 'parse-fail', 'bad-type']) {
    const h = make();
    const state = {};
    await h.runStalledTail(state, status, T);
    assert.equal(h.restarts(), 0, `${status}는 재시작 안 함`);
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0][0], /LiveSync 설정을 읽지 못해 멈춤 판정을 확신할 수 없/);
    assert.equal(h.saved[0].lastFilterAlertAt, T.toISOString(), '발송 전에 알린 시각을 저장');
    await h.runStalledTail(state, status, new Date(T.getTime() + 15 * 60_000));
    assert.equal(h.sent.length, 1, '6시간 안 같은 상태는 조용히');
    assert.equal(h.saved.length, 2, '조용한 회차도 상태는 저장');
    await h.runStalledTail(state, status, new Date(T.getTime() + ESCALATE_REPEAT_MS));
    assert.equal(h.sent.length, 2, '6시간 뒤 다시 알림');
    assert.equal(h.restarts(), 0);
  }
});

test('vaultChangedAfter: 제외 경로만 바뀌면 멈춤 아님, 일반 경로가 함께 바뀌면 멈춤, 설정 없거나 깨지면 예전처럼', () => {
  const root = join(TMP_ROOT, 'vault');
  const old = new Date('2026-10-01T00:00:00Z');
  const fresh = new Date('2026-11-04T05:00:00Z');
  const after = new Date('2026-11-04T00:00:00Z').getTime();
  const touch = (rel, t) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), 'x'); utimesSync(join(root, rel), t, t); };
  const writeSettings = (text) => { mkdirSync(join(root, LIVESYNC_DATA_REL, '..'), { recursive: true }); writeFileSync(join(root, LIVESYNC_DATA_REL), text); };
  try {
    touch('10_Periodic/a.md', old);
    touch('95_Etna/Jobs/JobHealth/x.json', fresh);
    touch('95_Etna/Location/Today.json', fresh);
    writeSettings(settings());
    assert.equal(vaultChangedAfter(root, after), false, '제외 경로만 바뀜');

    writeSettings('{ broken');
    assert.equal(vaultChangedAfter(root, after), true, '설정이 깨졌으면 모든 경로를 센다');
    rmSync(join(root, '.obsidian'), { recursive: true, force: true });
    assert.equal(vaultChangedAfter(root, after), true, '설정이 없으면 모든 경로를 센다');

    writeSettings(settings());
    touch('95_Etna/Location/Places.md', fresh);
    assert.equal(vaultChangedAfter(root, after), true, '95_Etna 안이라도 규칙에 없는 경로는 센다');
    rmSync(join(root, '95_Etna/Location/Places.md'));
    touch('10_Periodic/a.md', fresh);
    assert.equal(vaultChangedAfter(root, after), true, '제외 경로와 일반 경로가 함께 바뀜');
    assert.equal(vaultChangedAfter(root, after, null), true);
  } finally {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});
