// 열린 할 일 스냅샷(2026-10-31, 헤르메스 — 오너 승인, 제우스 요청): 구글 Tasks의 열린 할 일을
// `95_Etna/Todo/Open.json` 한 파일에 남긴다. 올림푸스 헤르메스 방이 읽는다. `95_Etna/Todo/{YYYY}`의 등록 기록과는
// 따로다(그건 Claude가 등록한 것만, 이건 오너가 폰에서 직접 넣은 것까지 전부).
// - 일정 파일(calendar-days)과 같이 내용만 담고 조회 시각은 넣지 않는다. 같은 내용이면 쓰지 않는다(LiveSync 부담).
// - 메모(notes) 본문은 쓰지 않고 있음 표시만 둔다. 오너가 메모에 비밀번호 같은 것을 적어도 볼트에 남지 않게 한다.
// - 순서: 기한 있는 것 먼저(이른 날부터), 그다음 목록 순서·목록 안 위치. 같은 내용이면 같은 바이트가 되게 끝까지 정한다.
//   한 줄 목록이라 하위 할 일이 부모와 떨어질 수 있다. 묶어 보이려면 읽는 쪽이 parent로 다시 묶는다.
//   부모가 스냅샷에 없으면(완료·숨김) parent는 null로 둔다 — 없는 id를 가리키지 않게.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VAULT_PATHS, VAULT_REL } from './vault-paths.mjs';
import { writeAtomic } from './state-writer.mjs';

export const TODO_OPEN_SCHEMA = 1;

export function todoOpenPath(root = VAULT_PATHS.root) {
  return join(root, ...VAULT_REL.todoOpen.split('/'));
}

// lists: [{ id, title }] (구글 목록 순서), tasksByList: { [listId]: [Tasks API 항목] }
export function buildTodoOpen({ lists, tasksByList }) {
  const text = (value) => String(value ?? '');
  const entries = lists.flatMap((list, listRank) => (tasksByList[list.id] ?? [])
    .filter((task) => task.status !== 'completed' && !task.deleted && !task.hidden && text(task.title).trim())
    .map((task) => ({
      _rank: listRank,
      _position: text(task.position),
      id: task.id,
      list: list.title ?? null,
      title: text(task.title).trim(),
      due: typeof task.due === 'string' && /^\d{4}-\d{2}-\d{2}/.test(task.due) ? task.due.slice(0, 10) : null,
      parent: task.parent ?? null,
      hasNotes: Boolean(text(task.notes).trim()),
      link: task.webViewLink ?? null,
    })));
  const ids = new Set(entries.map((entry) => entry.id));
  for (const entry of entries) if (entry.parent && !ids.has(entry.parent)) entry.parent = null;
  entries.sort((a, b) => Number(a.due === null) - Number(b.due === null) || text(a.due).localeCompare(text(b.due))
    || a._rank - b._rank || a._position.localeCompare(b._position) || a.title.localeCompare(b.title)
    || text(a.id).localeCompare(text(b.id)));
  return {
    schemaVersion: TODO_OPEN_SCHEMA,
    lists: lists.map((list) => ({ id: list.id, title: list.title ?? null })),
    count: entries.length,
    tasks: entries.map(({ _rank, _position, ...entry }) => entry),
  };
}

// 같은 내용이면 쓰지 않는다. 반환: 쓴 경로 또는 null.
export function writeTodoOpen(snapshot, { root = VAULT_PATHS.root, write = writeAtomic } = {}) {
  const path = todoOpenPath(root);
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === body) return null;
  mkdirSync(dirname(path), { recursive: true });
  write(path, body);
  return path;
}
