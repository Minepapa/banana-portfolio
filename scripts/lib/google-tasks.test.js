import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertTask, deleteTask } from './google-tasks.mjs';

test('Tasks 등록·삭제는 기본 목록, 기한 변환, 15초 제한을 사용한다', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ id: 'task-1' }) }; };
  assert.deepEqual(await insertTask({ token: 'secret', title: '점검', notes: '메모', due: '2026-10-14' }, { fetchImpl }), { id: 'task-1' });
  await deleteTask({ token: 'secret', id: 'task/1' }, { fetchImpl });
  assert.match(calls[0].url, /lists\/@default\/tasks$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { title: '점검', notes: '메모', due: '2026-10-14T00:00:00.000Z' });
  assert.match(calls[1].url, /task%2F1$/);
  assert.equal(calls[1].options.method, 'DELETE');
  assert.ok(calls.every(({ options }) => options.signal instanceof AbortSignal));
  await assert.rejects(() => insertTask({ token: 'secret', title: 'x' }, { fetchImpl: async () => ({ ok: false, status: 403 }) }), (error) => !error.message.includes('secret'));
});
