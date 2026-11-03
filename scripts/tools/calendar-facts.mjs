#!/usr/bin/env node
export const FACTS_META = {"serves":[{"agent":"hermes","workType":"일정 조회"}],"attach":"always","args":[],"summary":"볼트 일정 정본(calendar-days 잡) 오늘·내일 일정"};
// calendar-facts.mjs — 헤르메스 호출 때 붙는 일정 기본 사실(2026-11-03, 텔레그램 창구 4단계 전 확인).
// 창구 대화(헤드리스, --strict-mcp-config)에서는 구글 캘린더 MCP를 쓸 수 없다(설계 위험 R7). 그래서 일정 질문은
// calendar-days 잡이 15분마다 남기는 볼트 일정 정본(VAULT_REL.calendarDays/{YYYY}/{날짜}.json)을 읽어 답한다.
// 2026-10-31 시험 봇 실측에서 "오늘 밤 내 일정"에 헤르메스가 "조회를 못 한 상태"로 답한 원인: 헤르메스에 붙는 사실 도구가 없었다.
// 읽기만 한다(쓰기·외부 호출 없음). 파일이 없으면 "아직 조회 전"으로 적는다(빈 목록 파일 = 일정 없음, calendar-days 규칙).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { calendarDayPath, kstDate } from '../lib/calendar-days.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';

const kstClock = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? new Date(t + 9 * 3_600_000).toISOString().slice(11, 16) : '?';
};

// 순수 함수: 하루 일정 파일 내용 → 줄 목록.
export function describeCalendarDay(date, day) {
  if (!day) return [`${date}: 일정 파일 없음(아직 조회 전 — calendar-days 잡 상태 확인)`];
  const events = Array.isArray(day.events) ? day.events : [];
  if (!events.length) return [`${date}: 일정 없음`];
  return [`${date}: ${events.length}건`, ...events.map((e) => {
    const when = e.allDay ? '종일' : `${kstClock(e.start)}~${kstClock(e.end)}`;
    const who = e.person ? `[${e.person}] ` : '';
    return `- ${when} ${who}${e.title ?? '(제목 없음)'}${e.location ? ` @${e.location}` : ''}`;
  })];
}

export function calendarFacts({ now = new Date(), read = (date) => {
  const path = calendarDayPath(date);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
} } = {}) {
  const today = kstDate(now);
  const tomorrow = kstDate(new Date(now.getTime() + 24 * 3_600_000));
  return [`일정 정본(${VAULT_REL.calendarDays}, KST) — 오늘·내일`, ...describeCalendarDay(today, read(today)), ...describeCalendarDay(tomorrow, read(tomorrow))].join('\n');
}

const invokedPath = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return null; } })();
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) { console.error('사용법: calendar-facts.mjs (인자 없음)'); process.exit(2); }
  try { console.log(calendarFacts()); } catch (error) { console.error(`일정 사실 조회 실패: ${error.message}`); process.exit(1); }
}
