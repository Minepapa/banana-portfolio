#!/usr/bin/env node
/**
 * 일정 파일 정본 잡(2026-10-30, 헤르메스 — 오너 승인, 제우스 요청): 15분마다 오늘부터 7일 치 구글 캘린더
 * 일정을 `95_Etna/Calendar/{YYYY}/{날짜}.json`에 남긴다. 올림푸스 홈 '오늘'·헤르메스 방 '오늘 일정'이 읽는다.
 *
 * - 지난날은 건드리지 않는다. 어제 파일은 어제 마지막 조회 그대로 남는다.
 * - 내용이 같으면 쓰지 않는다(LiveSync 부담). 조회 시각은 파일에 넣지 않고 잡 상태로 본다.
 * - 조회가 하나라도 실패하면 아무 날도 쓰지 않고 종료 코드 1(두 번 연속이면 잡 실패 경보).
 *   조회 실패로 반쯤 갱신된 주가 남지 않게 모두 받은 뒤에 쓴다. 쓰기 도중 실패(디스크 등)는 앞날만 갱신된 채
 *   끝날 수 있는데, 날마다 원자적 쓰기라 깨지지 않고 다음 15분 회차에 맞춰진다.
 * - 선택된 캘린더가 0개면 실패한다. 연결 계정이 바뀐 것을 '일정 없음'으로 덮어쓰지 않게 한다.
 * - 텔레그램 발송 없음.
 *
 * 사용법: node scripts/jobs/calendar-days.mjs [--dry-run] [--days N]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';
import { isConfigured, getAccessToken, CALENDAR_READ_SCOPES } from '../lib/google-oauth.mjs';
import { listEventsForKstDay, listSelectedCalendars } from '../lib/google-calendar.mjs';
import { parseCalendarOwners } from '../lib/calendar-owners.mjs';
import { buildCalendarDay, writeCalendarDay, kstDate, nextDates } from '../lib/calendar-days.mjs';

export const DEFAULT_DAYS = 7;

export async function makeCalendarFetcher({ configured = isConfigured,
  getToken = () => getAccessToken({ requiredScopes: CALENDAR_READ_SCOPES }),
  listCalendars = listSelectedCalendars, listDay = listEventsForKstDay } = {}) {
  if (!configured()) throw new Error('캘린더 미연결 — google-oauth-setup 필요');
  const token = await getToken();
  const calendars = await listCalendars({ token });
  if (!calendars.length) throw new Error('선택된 캘린더 0개 — 연결 계정·캘린더 선택 확인');
  return (date) => listDay(date, { token, calendars });
}

export function parseArgs(args) {
  const options = { days: DEFAULT_DAYS, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--days') options.days = Number(args[++index]);
    else if (arg.startsWith('--days=')) options.days = Number(arg.slice('--days='.length));
    else throw new Error(`모르는 인자: ${arg}`);
  }
  return options;
}

export async function runCalendarDays({ now = new Date(), days = DEFAULT_DAYS, dryRun = false,
  makeFetcher = makeCalendarFetcher,
  readOwners = () => parseCalendarOwners(readFileSync(vaultAbs(VAULT_REL.calendarOwnersFile), 'utf8')),
  write = writeCalendarDay } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error(`--days는 1~31: ${days}`);
  const owners = readOwners();
  const fetchDay = await makeFetcher();
  const built = [];
  for (const date of nextDates(kstDate(now), days)) built.push(buildCalendarDay({ date, events: await fetchDay(date), owners }));
  const written = dryRun ? [] : built.map((day) => write(day)).filter(Boolean);
  return { days: built, written };
}

async function main() {
  const { days, dryRun } = parseArgs(process.argv.slice(2));
  const { days: built, written } = await runCalendarDays({ days, dryRun });
  const counts = built.map((day) => `${day.date.slice(5)} ${day.events.length}`).join(' · ');
  console.log(`[calendar-days] ${dryRun ? '미리보기 ' : ''}${counts} — 새로 쓴 파일 ${written.length}개`);
  if (dryRun) for (const day of built) console.log(JSON.stringify(day));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(`[calendar-days] 실패: ${error.message}`); process.exit(1); });
}
