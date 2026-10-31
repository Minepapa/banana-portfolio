import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dueAgain, evaluate, findReverted, parseNameStatus, planAction, vaultChangedAfter, ESCALATE_REPEAT_MS, MAX_RESTARTS_PER_DAY, STALL_MS } from './livesync-watch.mjs';
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
