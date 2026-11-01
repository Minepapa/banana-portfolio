#!/usr/bin/env node
/**
 * 오늘 동선 임시 파일 잡(2026-11-01, 헤르메스 — 오너 승인, 제우스 요청): 15분마다 오늘(KST) 지금까지의 동선을
 * `95_Etna/Location/Today.json`에 남긴다. 올림푸스 헤르메스 방이 오늘 날짜에서 읽는다(확정본은 밤 데일리의 Location/Days).
 *
 * - 계산은 데일리 동선과 같은 computeRoute다(머문 곳·이동·결제·일정 활동). 위치 점은 Location/{YYYY}/{날짜}.jsonl을 읽는다.
 *   11-07 아르고스 전환 뒤에도 아르고스 전달(argos-forward)이 같은 파일에 점을 넣으므로 이 잡은 바뀌지 않는다.
 * - 일정 조회가 실패하면 일정 활동 없이 계산한다(임시본이라 다음 회차에 다시 채워진다). 텔레그램 발송 없음.
 * - 카카오 장소 조회가 실패한 결과(degraded)는 쓰지 않고 종료 코드 1(지난 회차 파일이 그대로 남는다).
 * - 내용이 같으면 쓰지 않는다. 새 위치 점이 없으면 asOf도 같아 파일이 그대로다.
 * - 장소 캐시(geocode-cache.json)는 읽기만 한다. 머무는 동안 체류 중심이 조금씩 움직여 매 회차 새 좌표 키가 생기는데,
 *   그때마다 수백 KB 캐시를 다시 쓰면 LiveSync 부담이 되고 다시 안 쓸 키가 쌓인다(2026-11-01 리뷰). 캐시 갱신은
 *   지금처럼 밤 데일리 확정이 한다. 새 곳은 회차마다 카카오에 다시 묻는다(15분에 몇 건).
 *
 * 사용법: node scripts/jobs/route-today.mjs [--dry-run]
 */
import { fileURLToPath } from 'node:url';
import { computeRoute, readRoutePoints, readRoutePayments } from './daily-note.mjs';
import { isConfigured, getAccessToken, CALENDAR_READ_SCOPES } from '../lib/google-oauth.mjs';
import { listEventsForKstDay } from '../lib/google-calendar.mjs';
import { buildRouteToday, writeRouteToday } from '../lib/route-today.mjs';
import { createCachedGeocoder } from '../lib/kakao-geocode.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

const kstDate = (now) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

export function parseArgs(args) {
  const options = { dryRun: false };
  for (const arg of args) {
    if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`모르는 인자: ${arg}`);
  }
  return options;
}

async function fetchTodayEvents(date) {
  if (!isConfigured()) return [];
  return listEventsForKstDay(date, { token: await getAccessToken({ requiredScopes: CALENDAR_READ_SCOPES }) });
}

// 캐시를 읽고 조회는 하되 파일로 쓰지 않는 지오코더(computeRoute가 끝에 부르는 flush만 막는다).
export function readOnlyGeocoder(make = createCachedGeocoder, root = VAULT_PATHS.root) {
  const geocode = make({ root });
  geocode.flush = async () => {};
  return geocode;
}

export async function runRouteToday({ now = new Date(), dryRun = false, deps: injected = {} } = {}) {
  const deps = { computeRoute, readPoints: readRoutePoints, readPayments: readRoutePayments, fetchEvents: fetchTodayEvents,
    write: writeRouteToday, warn: console.warn, makeGeocoder: readOnlyGeocoder, ...injected };
  const date = kstDate(now);
  const points = deps.readPoints(date);
  let events = [];
  try { events = await deps.fetchEvents(date); if (!Array.isArray(events)) events = []; }
  catch (error) { deps.warn(`[route-today] 일정 조회 실패 — 일정 활동 없이 계산: ${error.message}`); events = []; }
  const route = await deps.computeRoute(date, { points, payments: deps.readPayments(date), events, now, dryRun,
    geocode: deps.makeGeocoder() });
  if (route?.degraded) return { date, degraded: true, today: null, written: null };
  const today = buildRouteToday({ date, route: Array.isArray(route) ? route : [], points });
  return { date, today, written: dryRun ? null : deps.write(today) };
}

export async function main(args = process.argv.slice(2), { run = runRouteToday, log = console.log, error = console.error } = {}) {
  const { dryRun } = parseArgs(args);
  try {
    const { date, degraded, today, written } = await run({ dryRun });
    if (degraded) { error(`[route-today] ${date} 장소 조회 실패 — 이번 회차는 쓰지 않음`); return 1; }
    const { summary } = today;
    log(`[route-today] ${dryRun ? '미리보기 ' : ''}${date} 기준 ${today.asOf ?? '점 없음'} · 머문 곳 ${summary.stays} · `
      + `${summary.distanceKm}km — ${written ? '새로 씀' : '그대로'}`);
    if (dryRun) log(JSON.stringify(today));
    return 0;
  } catch (caught) { error(`[route-today] 실패: ${caught.message}`); return 1; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; },
    (caught) => { console.error(`[route-today] 실패: ${caught.message}`); process.exitCode = 1; });
}
