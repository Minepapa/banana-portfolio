#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../lib/google-oauth.mjs';
import { deleteTask } from '../lib/google-tasks.mjs';
import { findTaskRecord } from '../lib/todo-log.mjs';

const TASKS_SCOPES = ['https://www.googleapis.com/auth/tasks'];

export async function main(argv = process.argv.slice(2), { findRecord = findTaskRecord, getToken = getAccessToken,
  removeTask = deleteTask, log = console.log } = {}) {
  if (argv.length !== 1 || !argv[0].startsWith('--id=') || !argv[0].slice(5)) throw new Error('사용법: tasks-delete.mjs --id=<id>');
  const id = argv[0].slice(5);
  if (!findRecord(id)) throw new Error('이 도구의 Todo 등록 기록에 없는 할 일은 삭제할 수 없음');
  await removeTask({ token: await getToken({ requiredScopes: TASKS_SCOPES }), id });
  log(`할 일 삭제함: ${id}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
