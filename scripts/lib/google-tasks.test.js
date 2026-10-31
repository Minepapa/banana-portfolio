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

test('Tasks 조회: 목록·열린 할 일을 쪽 끝까지 읽고, 실패는 토큰 없이 알린다', async () => {
  const { listTaskLists, listOpenTasks } = await import('./google-tasks.mjs');
  const urls = [];
  const pages = { first: { items: [{ id: 'a' }], nextPageToken: 'p2' }, second: { items: [{ id: 'b' }] } };
  const options = [];
  const fetchImpl = async (url, init) => { urls.push(url); options.push(init); return { ok: true, json: async () => (url.includes('pageToken=p2') ? pages.second : pages.first) }; };
  assert.deepEqual(await listOpenTasks({ token: 'secret', listId: 'L/1' }, { fetchImpl }), [{ id: 'a' }, { id: 'b' }]);
  assert.match(urls[0], /lists\/L%2F1\/tasks\?maxResults=100&showCompleted=false&showHidden=false$/);
  assert.match(urls[1], /pageToken=p2/);
  assert.ok(options.every((init) => init.headers.Authorization === 'Bearer secret' && init.signal instanceof AbortSignal));
  assert.deepEqual(await listTaskLists({ token: 'secret' }, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), []);
  await assert.rejects(() => listTaskLists({ token: 'secret' }, { fetchImpl: async () => ({ ok: false, status: 401 }) }),
    (error) => /HTTP 401/.test(error.message) && !error.message.includes('secret'));
  await assert.rejects(() => listTaskLists({ token: 'secret' }, { fetchImpl: async () => ({ ok: true, json: async () => ({ items: [], nextPageToken: 'again' }) }) }),
    /20쪽을 넘음/);
  await assert.rejects(() => listOpenTasks({ token: 'secret', listId: '' }), /목록 ID 필요/);
});
