import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyCause, parseTailscaleState, planTailscale, dueAgain, evaluate, findReverted, parseNameStatus, planAction, vaultChangedAfter, ESCALATE_REPEAT_MS, MAX_RESTARTS_PER_DAY, STALL_MS } from './livesync-watch.mjs';
import { MOUSEION_TOP_FOLDERS } from '../lib/vault-layout.mjs';

const T0 = new Date('2026-10-31T05:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);

test('evaluate: 첫 회차·번호 증가는 기록만 하고 멈춤 아님', () => {
  const first = evaluate(null, { seq: 10, now: T0, vaultChangedAfter: () => true });
  assert.equal(first.stalled, false);
  assert.deepEqual(first.state, { seq: 10, seqChangedAt: T0.toISOString() });
  const next = evaluate({ ...first.state, restarts: ['x'] }, { seq: 12, now: at(15), vaultChangedAfter: () => true });
  assert.equal(next.stalled, false);
  assert.deepEqual(next.state, { seq: 12, seqChangedAt: at(15).toISOString(), restarts: ['x'] }, '재시작 기록은 유지');
});

test('evaluate: 번호가 30분 넘게 그대로이고 그 뒤 볼트가 바뀌었을 때만 멈춤', () => {
  const prev = { seq: 10, seqChangedAt: T0.toISOString() };
  assert.equal(evaluate(prev, { seq: 10, now: at(29), vaultChangedAfter: () => true }).stalled, false, '30분 안');
  assert.equal(evaluate(prev, { seq: 10, now: at(45), vaultChangedAfter: () => false }).stalled, false, '볼트도 조용함');
  let asked;
  const r = evaluate(prev, { seq: 10, now: at(45), vaultChangedAfter: (ms) => { asked = ms; return true; } });
  assert.equal(r.stalled, true);
  assert.match(r.reason, /45분째/);
  assert.equal(asked, T0.getTime() + 2 * 60_000, '번호가 멈춘 직후 2분은 세지 않는다');
  assert.equal(STALL_MS, 30 * 60_000);
});

test('planAction: 24시간에 정해진 횟수까지만 재시작, 넘으면 6시간에 한 번 알림', () => {
  assert.equal(planAction({}, T0).action, 'restart');
  const restarts = Array.from({ length: MAX_RESTARTS_PER_DAY }, (_, i) => at(-60 * (i + 1)).toISOString());
  assert.equal(planAction({ restarts }, T0).action, 'escalate');
  assert.equal(planAction({ restarts, lastEscalatedAt: at(-60).toISOString() }, T0).action, 'quiet');
  assert.equal(planAction({ restarts, lastEscalatedAt: at(-7 * 60).toISOString() }, T0).action, 'escalate');
  const old = [at(-25 * 60).toISOString(), at(-26 * 60).toISOString()];
  assert.deepEqual(planAction({ restarts: old }, T0), { action: 'restart', recent: [] }, '24시간 지난 재시작은 세지 않음');
});

test('vaultChangedAfter: 금고·점으로 시작하는 항목·임시 파일은 보지 않고, 늦게 바뀐 파일이 있으면 true', () => {
  const root = mkdtempSync(join(tmpdir(), 'livesync-watch-'));
  try {
    const safe = MOUSEION_TOP_FOLDERS.find((f) => f.startsWith('99_'));
    const old = new Date('2026-10-01T00:00:00Z');
    for (const rel of [`${safe}/비밀.md`, '.git/index', '.obsidian/workspace.json', '.omc/x.json', '10_Periodic/b.md.tmp-1', '10_Periodic/a.md']) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), 'x');
    }
    utimesSync(join(root, '10_Periodic/a.md'), old, old);
    const after = new Date('2026-10-15T00:00:00Z').getTime();
    assert.equal(vaultChangedAfter(root, after), false, '금고·점 파일·임시 파일의 새 변경은 세지 않는다');
    utimesSync(join(root, '10_Periodic/a.md'), T0, T0);
    assert.equal(vaultChangedAfter(root, after), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findReverted: 지금 내용이 기준점 이전 옛 버전과 같은 파일은 되돌림 의심, 지워진 파일은 따로 모은다', () => {
  const hashes = { 'a.md': 'h-old', 'b.md': 'h-new', 'c.md': null };
  const history = { 'a.md': ['h-older', 'h-old'], 'b.md': ['h-old'], 'c.md': ['h-old'] };
  const entries = [{ status: 'M', file: 'a.md' }, { status: 'M', file: 'b.md' }, { status: 'M', file: 'c.md' }, { status: 'D', file: 'd.md' }];
  assert.deepEqual(findReverted(entries, { hashOf: (f) => hashes[f], historyOf: (f) => history[f] }), { reverted: ['a.md'], deleted: ['d.md'] });
});

test('parseNameStatus: git diff --name-status -z 출력, 이름 바뀜은 새 이름만', () => {
  const z = ['M', 'a 공백.md', 'D', 'b.md', 'R100', '옛.md', '새.md', 'A', 'c.md', ''].join('\0');
  assert.deepEqual(parseNameStatus(z), [
    { status: 'M', file: 'a 공백.md' }, { status: 'D', file: 'b.md' }, { status: 'R100', file: '새.md' }, { status: 'A', file: 'c.md' },
  ]);
});

test('dueAgain: 같은 알림은 6시간에 한 번', () => {
  assert.equal(dueAgain(undefined, T0), true);
  assert.equal(dueAgain(at(-60).toISOString(), T0), false);
  assert.equal(dueAgain(new Date(T0.getTime() - ESCALATE_REPEAT_MS).toISOString(), T0), true);
});

test('classifyCause·parseTailscaleState: Tailscale이 Running이 아닐 때만 재시작하지 않는다(2026-11-01)', () => {
  assert.deepEqual(classifyCause({ tailscale: 'Running' }), { cause: 'unknown', restart: true });
  assert.deepEqual(classifyCause({ tailscale: null }), { cause: 'unknown', restart: true }, '조회 실패는 기존 경로');
  for (const s of ['NeedsLogin', 'Stopped', 'NoState']) assert.deepEqual(classifyCause({ tailscale: s }), { cause: 'tailscale', restart: false }, s);
  assert.equal(parseTailscaleState('{"BackendState":"NeedsLogin","Self":{}}'), 'NeedsLogin');
  assert.equal(parseTailscaleState('{"BackendState":"Run ning"}'), null);
  assert.equal(parseTailscaleState('{}'), null);
  assert.equal(parseTailscaleState('Logged out.'), null);
});

test('planTailscale: 즉시·2회 연속 알림, 6시간 상한, 복구 1회와 그 회차 재시작 생략(리뷰 M1·M2·M3)', () => {
  const apply = (state, plan) => {
    const next = { ...state };
    for (const [k, v] of Object.entries(plan.fields)) { if (v === undefined) delete next[k]; else next[k] = v; }
    return next;
  };
  // 정상·조회 실패는 아무것도 안 하고 기존 재시작 경로
  assert.deepEqual(planTailscale({}, 'Running', T0), { alert: null, skipRestart: false, fields: {} });
  assert.deepEqual(planTailscale({}, null, T0), { alert: null, skipRestart: false, fields: {} });

  // 사람이 손대야 하는 상태는 첫 회차에 바로 알림, 재시작 안 함
  let p = planTailscale({}, 'NeedsLogin', T0);
  assert.equal(p.alert, 'down');
  assert.equal(p.skipRestart, true);
  let s = apply({}, p);
  assert.equal(s.tailscaleDownSince, T0.toISOString());
  // 6시간 안 다시 끊김 → 조용히, 6시간 뒤 → 다시 알림
  p = planTailscale(s, 'NeedsLogin', at(15)); assert.equal(p.alert, null); s = apply(s, p);
  assert.equal(s.tailscaleDownSince, T0.toISOString(), '끊긴 시각은 처음 것 유지');
  p = planTailscale(s, 'NeedsLogin', at(6 * 60)); assert.equal(p.alert, 'down'); s = apply(s, p);
  // 끊긴 중 조회 실패는 기록 유지
  assert.deepEqual(planTailscale(s, null, at(6 * 60 + 15)).fields, {});
  // 복구: 한 번 알리고 그 회차는 재시작 안 함, 다음 회차는 정상 경로
  p = planTailscale(s, 'Running', at(6 * 60 + 30));
  assert.equal(p.alert, 'recovered');
  assert.equal(p.skipRestart, true);
  s = apply(s, p);
  assert.equal(s.tailscaleDownSince, undefined);
  assert.ok(s.lastTailscaleAlertAt, '알린 시각은 남겨 6시간 상한 유지');
  assert.deepEqual(planTailscale(s, 'Running', at(6 * 60 + 45)), { alert: null, skipRestart: false, fields: {} });
  // 오락가락: 복구 직후 다시 끊겨도 6시간 안이면 알리지 않는다
  assert.equal(planTailscale(s, 'NeedsLogin', at(6 * 60 + 50)).alert, null);

  // 잠깐 거치는 상태는 두 회차 연속일 때만
  p = planTailscale({}, 'Starting', T0);
  assert.equal(p.alert, null);
  assert.equal(p.skipRestart, true);
  s = apply({}, p);
  assert.equal(planTailscale(s, 'Starting', at(15)).alert, 'down');
  // 알리지 않은 끊김이 풀리면 복구 알림도 없다(재시작만 한 회차 미룸)
  p = planTailscale(s, 'Running', at(15));
  assert.equal(p.alert, null);
  assert.equal(p.skipRestart, true);
});
