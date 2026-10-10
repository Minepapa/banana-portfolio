import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTask, main as add } from './tasks-add.mjs';
import { main as remove } from './tasks-delete.mjs';

test('할 일 입력은 제목·실재 날짜를 검증하고 dry-run은 등록하지 않는다', async () => {
  for (const task of [{ title: 'a\nb' }, { title: 'x', due: '2026-02-30' }, { title: 'x'.repeat(201) }]) {
    assert.throws(() => buildTask(['--json=-'], JSON.stringify(task)));
  }
  assert.deepEqual(buildTask(['--json=-'], '{"title":"점검"}'), { title: '점검' });
  const output = [];
  await add(['--json=-', '--dry-run'], { readStdin: async () => '{"title":"점검"}', getToken: async () => assert.fail('dry-run 토큰 요청'), log: (text) => output.push(text) });
  assert.match(output[0], /점검/);
});

test('등록 후 자기 기록만 삭제하고 기록 실패는 부분 성공으로 알린다', async () => {
  const entries = [];
  const output = [];
  await add(['--json=-'], { readStdin: async () => '{"title":"점검","due":"2026-10-14"}', getToken: async () => 'fake',
    createTask: async () => ({ id: 'task-1' }), recordTodo: async (item) => entries.push(item), log: (text) => output.push(text) });
  assert.deepEqual(entries[0], { kind: 'task', id: 'task-1', title: '점검', when: '2026-10-14', link: null });
  assert.match(output[0], /할 일 등록함: 점검 · 기한 10\/14\(수\).*tasks-delete/);
  let deleted = false;
  await assert.rejects(() => remove(['--id=owner-task'], { findRecord: () => null, getToken: async () => assert.fail('토큰 요청'), removeTask: async () => { deleted = true; } }), /기록에 없는/);
  assert.equal(deleted, false);
  await remove(['--id=task-1'], { findRecord: (id) => entries.find((entry) => entry.id === id), getToken: async () => 'fake',
    removeTask: async ({ id }) => { assert.equal(id, 'task-1'); deleted = true; }, log: () => {} });
  assert.equal(deleted, true);
  await assert.rejects(() => add(['--json=-'], { readStdin: async () => '{"title":"점검"}', getToken: async () => 'fake',
    createTask: async () => ({ id: 'orphan-1' }), recordTodo: async () => { throw new Error('disk offline'); },
    log: () => assert.fail('기록 실패 시 취소 명령을 출력하면 안 됨') }),
  /등록은 성공했으나 Todo 기록 실패 \(ID: orphan-1\).*Google Tasks에서 직접 확인·삭제 필요/);
});
