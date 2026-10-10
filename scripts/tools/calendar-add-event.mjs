#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { getAccessToken, CALENDAR_WRITE_SCOPES } from '../lib/google-oauth.mjs';
import { insertEvent, pantheonEventBody } from '../lib/google-calendar.mjs';
import { appendTodo } from '../lib/todo-log.mjs';

function argumentsMap(argv) {
  const result = {};
  for (const arg of argv) {
    if (arg === '--dry-run') { result.dryRun = true; continue; }
    const match = /^--([a-z-]+)=(.*)$/s.exec(arg);
    if (!match || !['title', 'start', 'end', 'date', 'end-date', 'location', 'description', 'json'].includes(match[1])) throw new Error(`알 수 없는 인자: ${arg}`);
    if (Object.hasOwn(result, match[1])) throw new Error(`중복 인자: ${match[1]}`);
    result[match[1]] = match[2];
  }
  return result;
}

function validDate(value) {
  const millis = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) throw new Error(`날짜 오류: ${value}`);
  return value;
}
function validTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error(`시간 형식 오류: ${value}`);
  validDate(value.slice(0, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  if (hour > 23 || minute > 59) throw new Error(`시간 오류: ${value}`);
  return Date.parse(`${value}:00+09:00`);
}
const kstIso = (millis) => new Date(millis + 9 * 3600_000).toISOString().slice(0, 19) + '+09:00';

export function buildEvent(argv, jsonInput) {
  const args = argumentsMap(argv);
  if (args.json !== undefined) {
    if (args.json !== '-' || jsonInput === undefined || Object.keys(args).some((key) => !['json', 'dryRun'].includes(key))) throw new Error('--json=-는 다른 일정 인자와 함께 쓸 수 없음');
    let parsed;
    try { parsed = JSON.parse(jsonInput); } catch { throw new Error('표준입력 JSON 형식 오류'); }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('표준입력 JSON 객체 필요');
    const keys = new Set(['title', 'start', 'end', 'date', 'endDate', 'location', 'description']);
    for (const [key, value] of Object.entries(parsed)) {
      if (!keys.has(key) || typeof value !== 'string') throw new Error(`JSON 필드 오류: ${key}`);
      args[key === 'endDate' ? 'end-date' : key] = value;
    }
  }
  if (!args.title?.trim() || args.title.length > 200 || /[\r\n\u2028\u2029]/.test(args.title)) throw new Error('제목은 줄바꿈 없는 1~200자 필수');
  if (args.location?.length > 500) throw new Error('위치는 500자 이하여야 함');
  if (args.description?.length > 2000) throw new Error('설명은 2000자 이하여야 함');
  if (Boolean(args.start) === Boolean(args.date) || (args.date && args.end) || (args.start && args['end-date'])) throw new Error('--start 또는 --date 중 하나 필요');
  let start;
  let end;
  if (args.start) {
    const startMs = validTime(args.start);
    const endMs = args.end ? validTime(args.end) : startMs + 3600_000;
    if (endMs <= startMs) throw new Error('종료 시각은 시작 시각보다 뒤여야 함');
    start = { dateTime: kstIso(startMs), timeZone: 'Asia/Seoul' };
    end = { dateTime: kstIso(endMs), timeZone: 'Asia/Seoul' };
  } else {
    const startDate = validDate(args.date);
    const inclusiveEnd = args['end-date'] ? validDate(args['end-date']) : startDate;
    if (inclusiveEnd < startDate) throw new Error('종료 날짜는 시작 날짜와 같거나 뒤여야 함');
    // Calendar API의 종일 종료일은 배타적이므로 CLI의 마지막 날짜 다음 날을 보낸다.
    const endDate = new Date(Date.parse(`${inclusiveEnd}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
    start = { date: startDate };
    end = { date: endDate };
  }
  const event = { summary: args.title, start, end };
  if (args.location) event.location = args.location;
  if (args.description) event.description = args.description;
  return { event, dryRun: args.dryRun };
}

// 표준입력은 동기 readFileSync(0)로 읽는다 — fs/promises.readFile은 fd 번호를 받지 않는다(2026-10-09 실측).
export async function main(argv = process.argv.slice(2), { readStdin = async () => readFileSync(0, 'utf8'), getToken = getAccessToken, createEvent = insertEvent,
  recordTodo = appendTodo, log = console.log, warn = console.warn } = {}) {
  const jsonInput = argv.includes('--json=-') ? await readStdin() : undefined;
  const { event, dryRun } = buildEvent(argv, jsonInput);
  if (dryRun) { log(JSON.stringify(pantheonEventBody(event), null, 2)); return; }
  const created = await createEvent(event, { token: await getToken({ requiredScopes: CALENDAR_WRITE_SCOPES }) });
  if (!created.id) throw new Error('Google Calendar 응답에 일정 ID 없음');
  try { await recordTodo({ kind: 'event', id: created.id, title: event.summary, when: event.start.dateTime ?? event.start.date, link: created.htmlLink ?? null }); }
  catch (error) { warn(`⚠️ Todo 등록 기록 실패: ${error.message}`); }
  const startMs = Date.parse(event.start.date ? `${event.start.date}T00:00:00+09:00` : event.start.dateTime);
  const day = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(new Date(startMs));
  const dayLabel = `${event.start.date ?? event.start.dateTime.slice(0, 10)}`.slice(5).replace('-', '/');
  const time = event.start.date ? '종일' : `${event.start.dateTime.slice(11, 16)}–${event.end.dateTime.slice(11, 16)}`;
  log(`등록함: ${dayLabel}(${day}) ${time} ${event.summary}${event.location ? ` @${event.location}` : ''} · 취소: node scripts/tools/calendar-delete-event.mjs --id=${created.id}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
