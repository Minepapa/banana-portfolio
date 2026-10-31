import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeLiveSyncWarning, parseLiveSyncStatusText, readLiveSyncSummary, summarizeLiveSyncState, CHECK_STALE_MS } from './livesync-status.mjs';

const NOW = new Date('2026-11-01T03:00:00Z');
const ago = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();

test('parseLiveSyncStatusText: 정상·멈춤 경고(실제 문구)·URL 제거·상태줄 아님', () => {
  assert.deepEqual(parseLiveSyncStatusText('🌐1 Sync: 💤 (⏩ 128) ↑ 2842 (LIVE) ↓ 1 (LIVE) 📥0 📄0 💾0 ⏳0 🛫0'), { warning: null });
  assert.deepEqual(parseLiveSyncStatusText('🌐1 Sync: ⏹ ↑ 0 ↓ 0⚠️ ​Network Error: Failed to fetch: Error:net::ERR_NAME_NOT_RESOLVED'),
    { warning: 'Network Error: Failed to fetch: Error:net::ERR_NAME_NOT_RESOLVED' });
  assert.equal(parseLiveSyncStatusText('Sync: ⏹ ⚠️ 📥 boom 🛫').warning, 'boom', '이모지 제거');
  const withUrl = parseLiveSyncStatusText('Sync: ⏹ ⚠️ failed https://user:pw@host.example:5984/db retry');
  assert.equal(withUrl.warning, 'failed (주소) retry', '자격증명이 들 수 있는 URL은 지운다');
  assert.equal(parseLiveSyncStatusText(`Sync: ⚠️ ${'x'.repeat(300)}`).warning.length, 120);
  assert.equal(parseLiveSyncStatusText('No elements found.'), null);
  assert.equal(describeLiveSyncWarning('Network Error: Failed to fetch: Error:net::ERR_NAME_NOT_RESOLVED'), '서버 이름을 찾지 못함(Tailscale·DNS)');
  assert.equal(describeLiveSyncWarning('Failed to fetch: net::ERR_CONNECTION_REFUSED'), '서버 연결 실패');
  assert.equal(describeLiveSyncWarning('401 Unauthorized'), '서버 인증 실패');
  assert.equal(describeLiveSyncWarning('mac.tail1234.ts.net said something'), '기타 경고(맥 로그 참고)', '원문(호스트 이름)은 내보내지 않는다');
  assert.equal(describeLiveSyncWarning(null), null);
  assert.equal(parseLiveSyncStatusText(undefined), null);
});

test('summarizeLiveSyncState: 상태 코드·24시간 재시작·감시 끊김(45분)', () => {
  const state = { seq: 1, seqChangedAt: ago(5), lastCheckAt: ago(3), status: 'ok', tailscale: 'Running', liveSyncWarning: null,
    tailscaleDownSince: ago(60), lastTailscaleAlertAt: ago(60),
    restarts: [ago(25 * 60), ago(120), ago(30)], pendingRevertCheck: { base: 'abc', reported: ['10_Periodic/x.md'] } };
  const s = summarizeLiveSyncState(state, NOW);
  assert.deepEqual(s, { status: 'ok', checkedAt: ago(3), serverChangedAt: ago(5), restarts24h: 2, lastRestartAt: ago(30),
    tailscale: 'Running', warning: null }, '파일 이름(되돌림 목록)·기준점은 내보내지 않는다');
  assert.equal(summarizeLiveSyncState({ ...state, status: 'tailscale', tailscale: 'NeedsLogin' }, NOW).status, 'tailscale');
  assert.equal(summarizeLiveSyncState({ ...state, liveSyncWarning: 'x.ts.net ERR_NAME_NOT_RESOLVED' }, NOW).warning,
    '서버 이름을 찾지 못함(Tailscale·DNS)', '카드에는 분류 문구만');
  assert.equal(summarizeLiveSyncState({ ...state, status: 'weird' }, NOW).status, 'unknown');
  const stale = summarizeLiveSyncState({ ...state, lastCheckAt: new Date(NOW.getTime() - CHECK_STALE_MS - 1).toISOString() }, NOW);
  assert.equal(stale.status, 'unknown');
  assert.match(stale.reason, /45분/);
  assert.equal(summarizeLiveSyncState({ seq: 1, seqChangedAt: ago(1) }, NOW).status, 'unknown', '옛 형식(lastCheckAt 없음)');
  assert.deepEqual(summarizeLiveSyncState(null, NOW), { status: 'unknown', reason: '감시 기록 없음' });
});

test('readLiveSyncSummary: 파일 없음·깨짐은 unknown', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'livesync-status-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readLiveSyncSummary({ file: join(dir, 'none.json'), now: NOW }).status, 'unknown');
  writeFileSync(join(dir, 'bad.json'), '{');
  assert.equal(readLiveSyncSummary({ file: join(dir, 'bad.json'), now: NOW }).status, 'unknown');
  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ lastCheckAt: ago(1), status: 'stalled' }));
  assert.equal(readLiveSyncSummary({ file: join(dir, 'ok.json'), now: NOW }).status, 'stalled');
});
