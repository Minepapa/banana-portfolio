import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendTodo, findTaskRecord, readTodos } from './todo-log.mjs';

test('Todo 기록은 KST 등록일에 한 번만 원자적으로 추가하고 지난 기록도 찾는다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'todo-log-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const record = { kind: 'task', id: 'task-1', title: '점검', when: '2026-10-14', createdAt: '2026-10-09T15:05:00.000Z' };
  assert.equal(await appendTodo(record, { root }), true);
  assert.equal(await appendTodo(record, { root }), false);
  assert.equal(await appendTodo({ ...record, createdAt: '2026-10-10T15:05:00.000Z' }, { root }), false);
  assert.deepEqual(readTodos('2026-10-10', { root }), [{ ...record, link: null }]);
  assert.equal(readFileSync(join(root, '2026', '2026-10-10.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal(findTaskRecord('task-1', { root })?.title, '점검');
  assert.equal(await appendTodo({ kind: 'event', id: 'event-1', title: '회의', when: '2026-10-14', createdAt: '2026-10-09T15:06:00.000Z' }, { root }), true);
  assert.equal(await appendTodo({ kind: 'event', id: 'event-1', title: '회의', when: '2026-10-14', createdAt: '2026-10-10T15:06:00.000Z' }, { root }), false);
  assert.equal(findTaskRecord('event-1', { root }), null, '일정 기록은 할 일 삭제 허가가 아니다');
});
