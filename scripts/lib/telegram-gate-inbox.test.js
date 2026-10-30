import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateInbox, foldInbox, parseInboxLines } from './telegram-gate-inbox.mjs';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-inbox-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const upd = (id, text = `m${id}`) => ({ update_id: id, message: { message_id: id, text } });

test('저장 → offset 확정 순서: 재시작해도 받은 업데이트와 offset이 남는다', () => withDir((dir) => {
  const inbox = createGateInbox({ dir });
  assert.equal(inbox.readOffset(), null);
  assert.equal(inbox.appendUpdates([upd(10), upd(11)]).length, 2);
  inbox.commitOffset(12);
  const reopened = createGateInbox({ dir });
  assert.equal(reopened.readOffset(), 12);
  assert.deepEqual(reopened.pending().map((i) => i.updateId), [10, 11]);
}));

test('저장 뒤 offset 기록 전에 죽으면 같은 업데이트가 다시 와도 한 번만 남는다', () => withDir((dir) => {
  const first = createGateInbox({ dir });
  first.appendUpdates([upd(20), upd(21)]);
  // 여기서 프로세스가 죽었다고 보고 offset을 기록하지 않는다.
  const restarted = createGateInbox({ dir });
  assert.equal(restarted.readOffset(), null);
  const fresh = restarted.appendUpdates([upd(20), upd(21), upd(22)]);
  assert.deepEqual(fresh.map((u) => u.update_id), [22]);
  assert.deepEqual(restarted.pending().map((i) => i.updateId), [20, 21, 22]);
  const lines = parseInboxLines(readFileSync(join(dir, 'inbox.jsonl'), 'utf8')).filter((r) => r.type === 'update');
  assert.equal(lines.length, 3);
}));

test('한 묶음 안의 중복 update_id·정수 아닌 id는 버린다', () => withDir((dir) => {
  const inbox = createGateInbox({ dir });
  assert.deepEqual(inbox.appendUpdates([upd(1), upd(1), { update_id: 'x' }, null]).map((u) => u.update_id), [1]);
}));

test('처리중으로 끊긴 건은 재시작 때 다시 실행하지 않고 확인필요로 돌린다', () => withDir((dir) => {
  const inbox = createGateInbox({ dir });
  inbox.appendUpdates([upd(1), upd(2), upd(3)]);
  inbox.markStatus(1, '완료');
  inbox.markStatus(2, '처리중', 'memo');
  const restarted = createGateInbox({ dir });
  const interrupted = restarted.recoverInterrupted();
  assert.deepEqual(interrupted.map((i) => i.updateId), [2]);
  assert.equal(restarted.get(2).status, '확인필요');
  assert.deepEqual(restarted.pending().map((i) => i.updateId), [3]);
  assert.deepEqual(createGateInbox({ dir }).counts(), { 완료: 1, 확인필요: 1, 받음: 1 });
}));

test('쓰다 만 마지막 줄(전원 차단)은 건너뛰고 나머지를 읽는다', () => withDir((dir) => {
  const inbox = createGateInbox({ dir });
  inbox.appendUpdates([upd(5)]);
  appendFileSync(join(dir, 'inbox.jsonl'), '{"type":"update","updateId":6,"upd');
  const reopened = createGateInbox({ dir });
  assert.deepEqual(reopened.pending().map((i) => i.updateId), [5]);
}));

test('offset은 뒤로 가지 않는다', () => withDir((dir) => {
  const inbox = createGateInbox({ dir });
  inbox.commitOffset(50);
  assert.equal(inbox.commitOffset(40), 50);
  assert.equal(inbox.readOffset(), 50);
  assert.throws(() => inbox.commitOffset(1.5), /정수/);
}));

test('compact: 끝난 지 7일 넘은 건만 지우고, 끝나지 않은 건은 나이와 상관없이 남긴다', () => withDir((dir) => {
  let clock = new Date('2026-10-01T00:00:00Z');
  const inbox = createGateInbox({ dir, now: () => clock });
  inbox.appendUpdates([upd(1), upd(2), upd(3)]);
  inbox.markStatus(1, '완료');
  inbox.markStatus(3, '확인필요');
  clock = new Date('2026-10-10T00:00:00Z');
  inbox.markStatus(3, '확인필요');
  assert.equal(inbox.compact(), 1);
  const reopened = createGateInbox({ dir });
  assert.equal(reopened.get(1), null);
  assert.equal(reopened.get(2).status, '받음');
  assert.equal(reopened.get(3).status, '확인필요');
}));

test('foldInbox: 상태 줄이 업데이트보다 먼저 오면 무시한다', () => {
  const items = foldInbox([{ type: 'status', updateId: 1, status: '완료' }, { type: 'update', updateId: 1, update: upd(1), receivedAt: 't' }]);
  assert.equal(items.get(1).status, '받음');
});

test('markStatus: 없는 update_id는 거부한다', () => withDir((dir) => {
  assert.throws(() => createGateInbox({ dir }).markStatus(9, '완료'), /없는 update_id/);
}));
