// 일정 파일 정본(2026-10-30, 헤르메스): 구글 캘린더에서 받은 하루 일정을 `95_Etna/Calendar/{YYYY}/{날짜}.json`에
// 남긴다. 올림푸스 '오늘' 칸이 읽는다. 내용만 담고 조회 시각은 넣지 않는다 — 같은 내용이면 다시 쓰지 않아야
// LiveSync가 15분마다 흔들리지 않는다. 조회가 살아 있는지는 잡 상태(JobHealth `calendar-days`)로 본다.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VAULT_PATHS, VAULT_REL } from './vault-paths.mjs';
import { groupEventsByOwner } from './calendar-owners.mjs';
import { writeAtomic } from './state-writer.mjs';

export const CALENDAR_DAY_SCHEMA = 1;

export function calendarDayPath(date, root = VAULT_PATHS.root) {
  return join(root, ...VAULT_REL.calendarDays.split('/'), date.slice(0, 4), `${date}.json`);
}

// 함께 쓰는 일정(같은 iCalUID·시작)은 소유자 표 순서의 첫 소유자 하나로 묶고 나머지는 sharedWith에 둔다.
// 순서는 종일 먼저, 그다음 시작 시각(listEventsForKstDay와 같은 기준). 시작이 같으면 소유자 표 순서·끝·제목·캘린더로
// 끝까지 정한다 — API 동률 순서가 흔들려도 같은 내용이면 같은 바이트여야 다시 쓰지 않는다.
export function buildCalendarDay({ date, events, owners }) {
  const ownerRank = (owner) => { const rank = owners.findIndex((item) => item.owner === owner); return rank < 0 ? owners.length : rank; };
  const at = (value) => { const time = Date.parse(value); return Number.isFinite(time) ? time : 0; };
  const text = (value) => String(value ?? '');
  const merged = groupEventsByOwner(events, owners).flatMap(({ events: ownerEvents }) => ownerEvents);
  const entries = merged.map((event) => ({
    owner: event.owner,
    sharedWith: event.sharedWith ?? [],
    title: event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    location: event.location ?? null,
    calendar: event.calendar ?? null,
  })).sort((a, b) => Number(b.allDay) - Number(a.allDay) || at(a.start) - at(b.start)
    || text(a.start).localeCompare(text(b.start)) || ownerRank(a.owner) - ownerRank(b.owner)
    || at(a.end) - at(b.end) || text(a.title).localeCompare(text(b.title)) || text(a.calendar).localeCompare(text(b.calendar)));
  return { schemaVersion: CALENDAR_DAY_SCHEMA, date, events: entries };
}

// 같은 내용이면 쓰지 않는다. 반환: 쓴 경로 또는 null. 일정이 없는 날도 빈 목록으로 남긴다(파일 없음 = 아직 조회 전).
export function writeCalendarDay(day, { root = VAULT_PATHS.root, write = writeAtomic } = {}) {
  const path = calendarDayPath(day.date, root);
  const text = `${JSON.stringify(day, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return null;
  mkdirSync(dirname(path), { recursive: true });
  write(path, text);
  return path;
}

export function kstDate(now = new Date()) {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function nextDates(start, count) {
  const base = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => new Date(base + index * 86_400_000).toISOString().slice(0, 10));
}
