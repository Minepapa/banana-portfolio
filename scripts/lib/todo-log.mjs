import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from './vault-paths.mjs';
import { withLock, writeAtomic } from './state-writer.mjs';

const dateOf = (instant) => new Date(new Date(instant).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const pathFor = (date, root) => join(root, date.slice(0, 4), `${date}.jsonl`);
const linesAt = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];

export function readTodos(date, { root = VAULT_PATHS.todoLog } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Todo 날짜 형식 오류');
  return linesAt(pathFor(date, root));
}

export async function appendTodo({ kind, id, title, when = null, link = null, createdAt = new Date().toISOString() }, { root = VAULT_PATHS.todoLog } = {}) {
  if (!['task', 'event'].includes(kind) || typeof id !== 'string' || !id || typeof title !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw new Error('Todo 기록 형식 오류');
  const date = dateOf(createdAt);
  const path = pathFor(date, root);
  mkdirSync(join(root, date.slice(0, 4)), { recursive: true });
  // 모든 날짜 파일에 같은 ID가 중복되지 않도록 공용 락 안에서 조회하고 쓴다.
  return withLock(join(root, '.todo-log'), () => {
    const current = linesAt(path);
    if (findRecord(id, { root })) return false;
    const entry = { kind, id, title, when, link, createdAt };
    writeAtomic(path, `${current.map((item) => JSON.stringify(item)).join('\n')}${current.length ? '\n' : ''}${JSON.stringify(entry)}\n`);
    return true;
  });
}

function findRecord(id, { root = VAULT_PATHS.todoLog, kind = null } = {}) {
  if (!existsSync(root)) return null;
  for (const year of readdirSync(root, { withFileTypes: true })) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
    for (const file of readdirSync(join(root, year.name))) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) continue;
      const found = linesAt(join(root, year.name, file)).find((entry) => (kind === null || entry.kind === kind) && entry.id === id);
      if (found) return found;
    }
  }
  return null;
}

export function findTaskRecord(id, options = {}) {
  return findRecord(id, { ...options, kind: 'task' });
}
