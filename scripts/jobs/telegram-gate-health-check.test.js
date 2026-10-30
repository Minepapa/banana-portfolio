import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessGate, decideAction, runHealthCheck, HEARTBEAT_STALE_MS, MAX_CONSECUTIVE_RESTARTS } from './telegram-gate-health-check.mjs';

const NOW = Date.parse('2026-10-30T05:00:00Z');

test('assessGate: 하트비트 없음·낡음, 남은 메시지 두 번 연속이면 비정상', () => {
  assert.deepEqual(assessGate({ heartbeat: { at: new Date(NOW - 60_000).toISOString() }, nowMs: NOW, pendingCount: 0 }), { healthy: true, refused: false, reasons: [], pendingStreak: 0 });
  assert.equal(assessGate({ heartbeat: null, nowMs: NOW, pendingCount: 0 }).healthy, false);
  assert.match(assessGate({ heartbeat: { at: new Date(NOW - HEARTBEAT_STALE_MS - 60_000).toISOString() }, nowMs: NOW }).reasons[0], /16분 전/);
  const once = assessGate({ heartbeat: { at: new Date(NOW).toISOString() }, nowMs: NOW, pendingCount: 2 });
  assert.equal(once.healthy, true, '한 번은 타이밍 경합일 수 있어 정상');
  const twice = assessGate({ heartbeat: { at: new Date(NOW).toISOString() }, nowMs: NOW, pendingCount: 2, priorPendingStreak: once.pendingStreak });
  assert.equal(twice.healthy, false);
});

test('decideAction: 정상이면 카운터 0, 비정상이면 3회까지 재시작 뒤 사람 확인', () => {
  assert.deepEqual(decideAction({ healthy: true, consecutiveRestarts: 2 }), { action: 'none', consecutiveRestarts: 0 });
  assert.deepEqual(decideAction({ healthy: false, consecutiveRestarts: 0 }), { action: 'restart', consecutiveRestarts: 1 });
  assert.deepEqual(decideAction({ healthy: false, consecutiveRestarts: MAX_CONSECUTIVE_RESTARTS }), { action: 'escalate', consecutiveRestarts: 3 });
});

function withState(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-hc-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('runHealthCheck: 낡은 하트비트면 재시작 1회 + 경고, 상태 파일에 횟수를 남긴다', () => withState(async (dir) => {
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ at: new Date(NOW - 30 * 60_000).toISOString() }));
  const restarts = [];
  const warnings = [];
  const result = await runHealthCheck({ stateDir: dir, nowMs: NOW, webhookInfo: async () => ({ pending_update_count: 0 }),
    restart: () => restarts.push(1), warn: async (m) => warnings.push(m), log: () => {} });
  assert.equal(result.decision.action, 'restart');
  assert.equal(restarts.length, 1);
  assert.equal(warnings[0].agent, 'zeus');
  assert.match(warnings[0].body, /다시 띄웠습니다/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'health-check.json'), 'utf8')).consecutiveRestarts, 1);
}));

test('runHealthCheck: 차단기에 걸리면 재시작하지 않고 경고는 한 번만', () => withState(async (dir) => {
  writeFileSync(join(dir, 'health-check.json'), JSON.stringify({ consecutiveRestarts: 3 }));
  const restarts = [];
  const warnings = [];
  const opts = { stateDir: dir, nowMs: NOW, webhookInfo: async () => ({ pending_update_count: 0 }), restart: () => restarts.push(1), warn: async (m) => warnings.push(m), log: () => {} };
  await runHealthCheck(opts);
  await runHealthCheck(opts);
  assert.equal(restarts.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].body, /자동 재시작을 멈췄습니다/);
}));

test('runHealthCheck: --dry-run은 판정만 하고 재시작·발송·상태 기록을 하지 않는다', () => withState(async (dir) => {
  const result = await runHealthCheck({ stateDir: dir, nowMs: NOW, dryRun: true, webhookInfo: async () => { throw new Error('오프라인'); },
    restart: () => { throw new Error('재시작하면 안 됨'); }, warn: async () => { throw new Error('발송하면 안 됨'); }, log: () => {} });
  assert.equal(result.decision.action, 'restart');
  assert.throws(() => readFileSync(join(dir, 'health-check.json')), /ENOENT/);
}));

test('runHealthCheck: 실전 가드 거부(refusal.json이 하트비트보다 새것)는 재시작하지 않고 거부마다 경고 한 번', () => withState(async (dir) => {
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ at: new Date(NOW - 60 * 60_000).toISOString() }));
  writeFileSync(join(dir, 'refusal.json'), JSON.stringify({ at: new Date(NOW - 20 * 60_000).toISOString(), codes: ['RIVAL'] }));
  const restarts = [];
  const warnings = [];
  const opts = { stateDir: dir, nowMs: NOW, webhookInfo: async () => ({ pending_update_count: 3 }), restart: () => restarts.push(1), warn: async (m) => warnings.push(m), log: () => {} };
  const first = await runHealthCheck(opts);
  await runHealthCheck({ ...opts, nowMs: NOW + 10 * 60_000 });
  await runHealthCheck({ ...opts, nowMs: NOW + 20 * 60_000 });
  assert.equal(first.decision.action, 'refused');
  assert.equal(restarts.length, 0, '다시 띄워도 또 거부하니 재시작하지 않는다(끝없는 재시작·경고 반복 방지)');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].body, /실전 시작을 스스로 거부/);
  assert.match(warnings[0].body, /RIVAL/);
  // 새 거부가 생기면 다시 한 번 알린다
  writeFileSync(join(dir, 'refusal.json'), JSON.stringify({ at: new Date(NOW + 25 * 60_000).toISOString(), codes: ['NOT_LAUNCHD'] }));
  await runHealthCheck({ ...opts, nowMs: NOW + 30 * 60_000 });
  assert.equal(warnings.length, 2);
  // 관문이 정상으로 뜨면(하트비트가 거부보다 새것) 거부 판정은 끝난다
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ at: new Date(NOW + 35 * 60_000).toISOString() }));
  const after = await runHealthCheck({ ...opts, nowMs: NOW + 36 * 60_000, webhookInfo: async () => ({ pending_update_count: 0 }) });
  assert.equal(after.decision.action, 'none');
}));

test('assessGate: 거부 코드는 정해진 형식만 메시지에 넣는다', () => {
  const r = assessGate({ heartbeat: null, nowMs: NOW, refusal: { at: new Date(NOW).toISOString(), codes: ['RIVAL', '<b>x</b>'] } });
  assert.equal(r.refused, true);
  assert.match(r.reasons[0], /\(RIVAL\)/);
});
