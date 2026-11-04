import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIVESYNC_DATA_REL, isLiveSyncTarget, parseLiveSyncFilter, readLiveSyncFilter } from './livesync-filter.mjs';

// vault-paths를 읽는 모듈(livesync-watch)은 정적 import하지 않는다 — 임시 볼트를 VAULT_PATH로 정한 뒤 동적으로 부른다.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'livesync-filter-'));
process.env.VAULT_PATH = TMP_ROOT;
const { vaultChangedAfter } = await import('../jobs/livesync-watch.mjs');

// 2026-11-04 승인 규칙(맥 LiveSync에 넣을 예정)
const PLANNED = ['^95_Etna/Investing/', '^95_Etna/Jobs/', '^95_Etna/Events/', '^95_Etna/Location/(\\d{4}/|Today\\.json$|geocode-cache\\.json$)'].join('|[]|');
const settings = (extra) => JSON.stringify({ couchDB_PASSWORD: 'should-not-leak', syncIgnoreRegEx: PLANNED, ...extra });

test('parseLiveSyncFilter: |[]|로 나누고 빈 항목·공백·줄바꿈을 버리며, 필요한 키만 돌려준다', () => {
  const f = parseLiveSyncFilter(settings({ syncIgnoreRegEx: `|[]|${PLANNED}|[]||[]|\n^a /b/ ` }));
  assert.deepEqual(Object.keys(f).sort(), ['ignore', 'only']);
  assert.equal(f.ignore.length, 5);
  assert.equal(f.ignore[4].regexp.source, '^a\\/b\\/', '공백·줄바꿈은 플러그인처럼 지운다');
  assert.equal(JSON.stringify(f).includes('should-not-leak'), false);
  assert.deepEqual(parseLiveSyncFilter(settings({ syncIgnoreRegEx: '' })), { ignore: [], only: [] });
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
  const f = parseLiveSyncFilter(settings({ syncIgnoreRegEx: '^95_Etna/Jobs/|[]|^(broken|[]|[z-a]', syncOnlyRegEx: '(' }), (m) => logs.push(m));
  assert.equal(f.ignore.length, 1);
  assert.equal(f.only.length, 0, 'only가 모두 잘못됐으면 제한 없음');
  assert.equal(logs.length, 3);
  assert.equal(isLiveSyncTarget('95_Etna/Jobs/a.json', f), false);
  assert.equal(isLiveSyncTarget('30_Wiki/a.md', f), true);
});

test('parseLiveSyncFilter·readLiveSyncFilter: 설정이 없거나 깨졌으면 null(모든 경로), 원문은 로그에 남기지 않는다', () => {
  const logs = [];
  const log = (m) => logs.push(m);
  assert.equal(parseLiveSyncFilter('{"couchDB_PASSWORD":"should-not-leak", broken', log), null);
  assert.equal(parseLiveSyncFilter('null', log), null);
  assert.equal(parseLiveSyncFilter('"text"', log), null);
  assert.equal(parseLiveSyncFilter(settings({ syncIgnoreRegEx: 3 }), log), null);
  const root = mkdtempSync(join(tmpdir(), 'livesync-filter-read-'));
  try {
    assert.equal(readLiveSyncFilter(root, log), null, '파일 없음');
    assert.equal(logs.length, 5);
    assert.equal(logs.some((m) => m.includes('should-not-leak')), false);
    mkdirSync(join(root, LIVESYNC_DATA_REL, '..'), { recursive: true });
    writeFileSync(join(root, LIVESYNC_DATA_REL), settings());
    assert.equal(readLiveSyncFilter(root).ignore.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
