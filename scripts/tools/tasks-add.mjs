#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../lib/google-oauth.mjs';
import { insertTask } from '../lib/google-tasks.mjs';
import { appendTodo } from '../lib/todo-log.mjs';

const TASKS_SCOPES = ['https://www.googleapis.com/auth/tasks'];

export function buildTask(argv, jsonInput) {
  if (!argv.includes('--json=-') || argv.some((arg) => !['--json=-', '--dry-run'].includes(arg)) || argv.filter((arg) => arg === '--json=-').length !== 1) throw new Error('사용법: tasks-add.mjs --json=- [--dry-run]');
  let task;
  try { task = JSON.parse(jsonInput); } catch { throw new Error('표준입력 JSON 형식 오류'); }
  if (!task || typeof task !== 'object' || Array.isArray(task) || Object.keys(task).some((key) => !['title', 'notes', 'due'].includes(key))) throw new Error('JSON 필드 오류');
  if (typeof task.title !== 'string' || !task.title.trim() || task.title.length > 200 || /[\r\n\u2028\u2029]/.test(task.title)) throw new Error('제목은 줄바꿈 없는 1~200자 필수');
  if (task.notes !== undefined && typeof task.notes !== 'string') throw new Error('notes는 문자열 필요');
  if (task.due !== undefined) {
    const millis = Date.parse(`${task.due}T00:00:00Z`);
    if (typeof task.due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(task.due) || !Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== task.due) throw new Error('기한 날짜 오류');
  }
  return task;
}

export async function main(argv = process.argv.slice(2), { readStdin = async () => readFileSync(0, 'utf8'), getToken = getAccessToken,
  createTask = insertTask, recordTodo = appendTodo, log = console.log } = {}) {
  const task = buildTask(argv, await readStdin());
  if (argv.includes('--dry-run')) { log(JSON.stringify(task, null, 2)); return; }
  const created = await createTask({ ...task, token: await getToken({ requiredScopes: TASKS_SCOPES }) });
  if (!created.id) throw new Error('Google Tasks 응답에 할 일 ID 없음');
  try { await recordTodo({ kind: 'task', id: created.id, title: task.title, when: task.due ?? null, link: created.webViewLink ?? null }); }
  catch {
    // 기록이 없으면 tasks-delete는 소유 여부를 증명할 수 없다. 원격 등록 사실과 ID를 남겨 수동 복구를 돕는다.
    throw new Error(`Google Tasks 등록은 성공했으나 Todo 기록 실패 (ID: ${created.id}). Google Tasks에서 직접 확인·삭제 필요`);
  }
  const due = task.due ? ` · 기한 ${task.due.slice(5).replace('-', '/')}(${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(new Date(`${task.due}T00:00:00+09:00`))})` : '';
  log(`할 일 등록함: ${task.title}${due} · 취소: node scripts/tools/tasks-delete.mjs --id=${created.id}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
