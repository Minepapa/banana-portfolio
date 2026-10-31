import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTodoOpen, writeTodoOpen, todoOpenPath } from './todo-open.mjs';

const root = mkdtempSync(join(tmpdir(), 'todo-open-'));
after(() => rmSync(root, { recursive: true, force: true }));

const lists = [{ id: 'L1', title: '내 할 일' }, { id: 'L2', title: '집' }];
const tasksByList = {
  L1: [
    { id: 't1', title: '기한 없음', position: '002', notes: '비밀번호 1234', webViewLink: 'https://tasks/t1' },
    { id: 't2', title: '나중 기한', due: '2026-11-05T00:00:00.000Z', position: '001' },
    { id: 't3', title: '끝낸 일', status: 'completed', position: '000' },
    { id: 't4', title: '  ', position: '003' },
  ],
  L2: [
    { id: 't5', title: '이른 기한', due: '2026-11-01T00:00:00.000Z', position: '009', parent: 't1' },
    { id: 't7', title: '끝낸 부모의 하위', position: '010', parent: 't3' },
    { id: 't6', title: '숨김', hidden: true },
  ],
};

test('열린 할 일 스냅샷: 기한 이른 순·목록 순서, 완료·숨김·빈 제목 제외, 메모 본문은 남기지 않는다', () => {
  const snapshot = buildTodoOpen({ lists, tasksByList });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.count, 4);
  assert.deepEqual(snapshot.tasks.map((task) => task.id), ['t5', 't2', 't1', 't7']);
  assert.deepEqual(snapshot.tasks[0], { id: 't5', list: '집', title: '이른 기한', due: '2026-11-01', parent: 't1', hasNotes: false, link: null });
  assert.equal(snapshot.tasks[3].parent, null, '완료된 부모는 가리키지 않는다');
  assert.equal(snapshot.tasks[2].hasNotes, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /1234/, '메모 본문은 볼트에 쓰지 않는다');
  assert.deepEqual(snapshot.lists, [{ id: 'L1', title: '내 할 일' }, { id: 'L2', title: '집' }]);
  const shuffled = buildTodoOpen({ lists, tasksByList: { L1: [...tasksByList.L1].reverse(), L2: [...tasksByList.L2].reverse() } });
  assert.deepEqual(shuffled, snapshot, 'API 순서가 흔들려도 같은 내용이면 같은 결과');
});

test('스냅샷 쓰기: 정본 경로에 쓰고, 같은 내용이면 다시 쓰지 않는다', () => {
  const snapshot = buildTodoOpen({ lists, tasksByList });
  const path = writeTodoOpen(snapshot, { root });
  assert.equal(path, todoOpenPath(root));
  assert.match(path, /95_Etna\/Todo\/Open\.json$/);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), snapshot);
  assert.equal(writeTodoOpen(snapshot, { root }), null);
  assert.equal(writeTodoOpen(buildTodoOpen({ lists, tasksByList: {} }), { root }), path, '할 일이 다 끝나면 빈 목록으로 갱신');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).count, 0);
});
