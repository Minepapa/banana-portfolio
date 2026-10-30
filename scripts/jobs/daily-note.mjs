#!/usr/bin/env node
/**
 * 데일리 노트 잡(D85, 5단계 1번) — launchd가 매일 23:30·05:00에 부른다.
 *
 * 한 번 실행할 때 할 일(늦은 실행에도 꼬이지 않게, 리뷰 M-1):
 *   1) 어제 노트가 확정이 아니면(없으면 새로 만들어) 확정한다.
 *   2) KST 18시 이후 실행이면 오늘 초안을 쓴다.
 *   텔레그램(클리오)은 노트당 한 번만 보낸다(telegramSentAt). 23:30 실행을 놓쳐 확정이 먼저 오면 확정 때 보낸다.
 * 오너 글 보존(D19): AI 칸만 다시 쓰고 나머지는 원문 그대로. 오너가 AI 칸을 고쳤거나 형식이 다른 파일이면 쓰지 않고 실패로 알린다.
 * 쓰기 직전에 파일을 다시 읽어, 그 사이(LLM 호출 중) 바뀌었으면 최신 내용으로 다시 만든다. 내용이 같으면 쓰지 않는다.
 * LLM 요약은 쿨다운 가드 통과 후, 도구를 모두 끈 채로 부른다(개인 등급도 제목·설명을 넘김, D96).
 *
 * 사용법: node scripts/jobs/daily-note.mjs [--mode=draft|finalize --date=YYYY-MM-DD] [--dry-run] [--no-send]
 *   --no-send: 노트는 쓰되 텔레그램을 보내지 않는다(수동 재실행·시험용). 텔레그램 발송 함수에는 시험 모드가 없으니 시험은 이걸로 한다.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { readTodos } from '../lib/todo-log.mjs';
import { cooldownActive } from '../lib/quota-cooldown.mjs';
import { runHeadlessClaude, headlessResult } from '../lib/headless-claude.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { sendDirectWarning, warningSubjectKey } from '../lib/direct-warning-delivery.mjs';
import { cancelDeferredWarnings, DEFERRED_WARNINGS_FILE } from '../lib/deferred-warnings.mjs';
import { isConfigured, getAccessToken, CALENDAR_READ_SCOPES } from '../lib/google-oauth.mjs';
import { listEventsForKstDay } from '../lib/google-calendar.mjs';
import { renderRouteMapFile } from '../lib/route-map.mjs';
import { createTileFetcher } from '../lib/osm-tiles.mjs';
import { groupEventsByOwner, parseCalendarOwners } from '../lib/calendar-owners.mjs';
import { readDayPoints, detectStays, loadPlaces, describeStays, buildMoveSegments, movePaymentCoordinate, haversineM, STAY_RADIUS_M } from '../lib/location-stays.mjs';
import { createCachedGeocoder } from '../lib/kakao-geocode.mjs';
import { readDailySpending, formatDailyNoteSpending } from '../lib/spending-daily.mjs';
import { attachRouteActivities, moveStopovers } from '../lib/route-activities.mjs';
import { writeSpendingPlaces, spendingPlacesPath } from '../lib/spending-places.mjs';
import { updateCandidates } from '../lib/place-candidates.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import {
  DAILY_SKIP_TOP, buildDailyTelegramBody, buildSummaryPrompt, hasNormalSchedule, inspectExisting, recordHashOf, renderDailyNote, sameIgnoringModified,
  PENDING_TEXT, replaceDailyRoute, sanitizeSummary, toDayRecord,
} from '../lib/daily-note.mjs';

const SENDER_AGENT = 'clio'; // 데일리 요약(D85) — 기록 담당
const ROOT_RULE_FILES = new Set(['CLAUDE.md', 'AGENTS.md']);
// 데일리 시작일 — 자동 실행은 이 날짜 이전을 다루지 않는다(이관 작업일 2026-10-08의 대량 기록이 첫 실행에 나가지 않게).
export const DAILY_START = '2026-10-09';

export const kstDate = (d) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const kstHour = (d) => Number(new Date(d.getTime() + 9 * 3600_000).toISOString().slice(11, 13));

// 실행할 일 목록(순수). 명시 --mode/--date가 있으면 그것 하나만.
// prepare(2026-10-10): 오너가 밤에 잠들기 전에도 "오늘 한 줄"을 쓸 수 있게, 18시 전 실행(05:00)에서 그날 노트가 없으면 미리 만든다.
export function planActions({ mode, date, now = new Date(), noteStatus = () => null, noteExists = () => false }) {
  if (mode || date) {
    const m = mode ?? 'draft';
    if (!['draft', 'finalize', 'prepare'].includes(m)) throw new Error(`--mode는 draft·finalize·prepare 중 하나: ${m}`);
    const d = date ?? (m === 'draft' ? kstDate(now) : kstDate(new Date(now.getTime() - 24 * 3600_000)));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) throw new Error(`--date 형식 오류: ${d}`);
    return [{ mode: m, date: d }];
  }
  const today = kstDate(now);
  const yesterday = kstDate(new Date(now.getTime() - 24 * 3600_000));
  const actions = [];
  if (yesterday >= DAILY_START && noteStatus(yesterday) !== '확정') actions.push({ mode: 'finalize', date: yesterday });
  if (kstHour(now) >= 18) actions.push({ mode: 'draft', date: today });
  else if (today >= DAILY_START && !noteExists(today)) actions.push({ mode: 'prepare', date: today });
  return actions;
}

function walk(dir, root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (entry.isDirectory()) { if (!DAILY_SKIP_TOP.has(rel)) walk(full, root, out); } else if (entry.name.endsWith('.md') && !ROOT_RULE_FILES.has(rel)) out.push(rel);
  }
  return out;
}

export function collectRecords(root, date) {
  const records = [];
  for (const rel of walk(root, root)) {
    const full = join(root, rel);
    const content = readFileSync(full, 'utf8');
    // 머리말 없는 노트의 파일 생성일 판정은 사람 입력 폴더(00_Inbox)에만 쓴다(리뷰 M-2).
    const fallbackDate = rel.startsWith(`${VAULT_REL.inboxRoot}/`) && !/^﻿?---/.test(content) ? kstDate(statSync(full).birthtime) : null;
    const record = toDayRecord(rel, content, date, { fallbackDate });
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.link.localeCompare(b.link));
}

export const notePath = (date) => join(vaultAbs(VAULT_REL.dailyNotes), date.slice(0, 4), `${date}.md`);
const notePathAt = (root, date) => join(root, VAULT_REL.dailyNotes, date.slice(0, 4), `${date}.md`);
const readOrNull = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const routeTime = (value, date) => Date.parse(value) === Date.parse(`${date}T00:00:00+09:00`) + 86_400_000
  ? '24:00' : new Date(Date.parse(value) + 9 * 3_600_000).toISOString().slice(11, 16);
export function readRoutePoints(date, root = VAULT_PATHS.root) {
  // 자정 양쪽의 점을 함께 읽어 당일 첫/마지막 체류를 올바르게 자른다.
  const dateMs = Date.parse(`${date}T00:00:00Z`);
  const adjacentDates = [-1, 0, 1].map((offset) => new Date(dateMs + offset * 86_400_000).toISOString().slice(0, 10));
  const dayReads = adjacentDates.map((day) => readDayPoints(day, { root }));
  const points = dayReads.flatMap((result) => result.points);
  const brokenLines = dayReads.reduce((sum, result) => sum + result.brokenLines, 0);
  if (brokenLines) console.warn(`[daily-note] 위치 기록 손상 ${brokenLines}줄`);
  return points;
}

// 동선 지문: 위치 점 + 결제(가맹점·시각·금액). 결제 알림이 늦게 들어와도 활동(식사 등)이 다시 계산되게 한다.
export function routeHashOf(points, payments = []) {
  const triples = points.map(({ tst, lat, lon }) => [tst, lat, lon])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const paid = payments.map(({ at, amount, merchant }) => [at, amount, merchant ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || a[1] - b[1]);
  return createHash('sha256').update(JSON.stringify(paid.length ? [triples, paid] : triples)).digest('hex').slice(0, 16);
}

export function readRoutePayments(date, root = VAULT_PATHS.root) {
  return readDailySpending(date, { spendingDir: join(root, VAULT_REL.spending) }).entries
    .filter((entry) => entry.status === 'expense');
}

// 동선 지도(D90). renderMap은 main()만 넘긴다 — 기본값이 없으니 테스트·도구 호출은 타일을 받지 않는다.
// - 오늘은 그리지 않는다. 점이 계속 늘어 실행마다 큰 SVG를 다시 쓰게 되므로, 다음 날 확정 때 한 번 그린다.
// - 지도가 실패해도 동선 글은 그대로 쓴다. 실패했거나 빈 타일이 섞였으면 route.mapIncomplete를 붙여
//   호출부가 동선 지문을 옛 값으로 두게 한다(degraded와 같은 방식) — 그래야 다음 실행에서 다시 그린다.
export async function attachRouteMap(renderMap, { date, route, points, root, today = kstDate(new Date()) }) {
  if (!renderMap || !Array.isArray(route) || !route.length || date >= today) return;
  try {
    const result = await renderMap({ date, route, points, root });
    if (result?.rel) Object.defineProperty(route, 'mapPath', { value: result.rel });
    if (result?.missingTiles) {
      // 빈 칸이 계속되면(타일 서버 차단·네트워크) 실행마다 재시도만 하고 쓰지는 않으니, 로그로 드러낸다.
      Object.defineProperty(route, 'mapIncomplete', { value: true });
      console.warn(`  ⚠️ ${date} 동선 지도 타일 ${result.missingTiles}칸 비어 있음 — 다음 실행에서 다시 그림`);
    }
  } catch (error) {
    Object.defineProperty(route, 'mapIncomplete', { value: true });
    console.warn(`  ⚠️ ${date} 동선 지도 실패:`, String(error?.message ?? error).replace(/[-+]?\d+(?:\.\d+)?/g, '[수치]'));
  }
}

// 장소별 소비 파생(결제↔동선, `95_Etna/Spending/Places`). writePlaces도 main()만 넘긴다 — 테스트·도구 호출은 볼트에 쓰지 않는다.
// - 오늘은 쓰지 않는다(지도와 같은 이유: 동선이 아직 자란다). 다음 날 확정 때 쓴다.
// - 카카오 조회가 실패한 결과(degraded)는 장소 이름이 덜 붙어 있어 쓰지 않는다. 지문을 옛 값으로 두므로 다음 재계산이 다시 쓴다.
// - 실패해도 동선 글은 그대로 쓴다.
export function attachSpendingPlaces(writePlaces, { date, route, payments, root, today = kstDate(new Date()) }) {
  if (!writePlaces || !Array.isArray(route) || !route.length || date >= today || route.degraded) return;
  try { writePlaces({ date, route, payments, ...(root ? { root } : {}) }); }
  catch (error) { console.warn(`  ⚠️ ${date} 장소별 소비 기록 실패:`, String(error?.message ?? error).replace(/[-+]?\d+(?:\.\d+)?/g, '[수치]')); }
}

export function createRouteMapRenderer({ root: defaultRoot = VAULT_PATHS.root, fetcher = createTileFetcher(), write = writeAtomic } = {}) {
  return ({ date, route, points, root = defaultRoot }) => renderRouteMapFile({ date, route, points, root, fetcher, write });
}

// 외출 시각을 동선 줄 표기(HH:MM)로 바꾸고, 결제·사진 연결용 원래 시각은 startAt/endAt으로 남긴다.
const toRouteOuting = (outing, date) => ({ ...outing, start: routeTime(outing.start, date), end: routeTime(outing.end, date),
  startAt: outing.start, endAt: outing.end });

export async function computeRoute(date, { root = VAULT_PATHS.root, geocode = createCachedGeocoder({ root }), dryRun = false,
  points = readRoutePoints(date, root), payments = readRoutePayments(date, root), events = [], now = new Date() } = {}) {
  let stays;
  let moves;
  // 자동납부는 그 시각 머문 곳·이동과 무관하므로 동선 글의 가게 연결에서 뺀다(장소별 소비는 위치 없음으로 남는다).
  const placedPayments = payments.filter((payment) => !payment.autopay);
  try {
    stays = await describeStays(detectStays(points, { date }), { places: loadPlaces(root),
      geocode: dryRun ? async () => ({ reason: 'dry-run' }) : geocode,
      region: dryRun ? async () => null : geocode.region?.bind(geocode) });
    moves = buildMoveSegments(stays, points, { date });
    const attachedPayments = new Set();
    stays = await attachRouteActivities(stays, { payments: placedPayments, events, moves, attachedPayments,
      keyword: dryRun ? async () => null : geocode.keyword?.bind(geocode) });
    for (const move of moves) {
      move.label += await moveStopovers(Date.parse(move.start), Date.parse(move.end), placedPayments,
        dryRun ? async () => null : async (merchant, payment) => {
          const coordinate = movePaymentCoordinate(move, stays, points, Date.parse(payment.at));
          return geocode.keyword?.call(geocode, merchant, coordinate.lat, coordinate.lon);
        }, attachedPayments);
    }
  }
  finally { if (!dryRun) await geocode.flush?.(); }
  const degraded = !dryRun && geocode.failureCount?.() > 0;
  if (degraded) {
    const reasons = Object.entries(geocode.failureReasons?.() ?? {}).map(([reason, n]) => `${reason} ${n}`).join(', ');
    console.warn(`[daily-note] 지오코딩 실패 ${geocode.failureCount()}건${reasons ? ` (${reasons})` : ''}`);
  }
  const nextDate = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const nextStart = Date.parse(`${nextDate}T00:00:00+09:00`) / 1000;
  const firstNextDayPoint = points.filter((point) => point.tst >= nextStart && point.tst < nextStart + 86_400)
    .sort((first, second) => first.tst - second.tst)[0];
  const isToday = date === new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  const lastStay = stays.at(-1);
  const ordered = [...stays, ...moves].sort((first, second) => Date.parse(first.start) - Date.parse(second.start)
    || (first.kind === 'move' ? 1 : -1));
  const route = ordered.map((entry) => {
    const isLast = entry === ordered.at(-1);
    const nextDayConfirmsPlace = entry === lastStay && firstNextDayPoint && haversineM(entry, firstNextDayPoint) <= STAY_RADIUS_M;
    const end = isLast && isToday ? '' : isLast && entry === lastStay && (!firstNextDayPoint || nextDayConfirmsPlace)
      ? '24:00' : routeTime(entry.end, date);
    return { ...entry, current: isLast && isToday, start: routeTime(entry.start, date), end,
      startAt: entry.start, endAt: entry.end,
      ...(entry.outings ? { outings: entry.outings.map((outing) => toRouteOuting(outing, date)) } : {}) };
  });
  // 카카오 조회가 실패한 결과는 지문을 갱신하지 않게 표시한다(다음 실행에서 다시 계산).
  if (degraded) Object.defineProperty(route, 'degraded', { value: true });
  return route;
}

async function summarize(date, records, prevFields, recordHash, dryRun) {
  if (prevFields?.summaryStatus === 'ok' && prevFields?.recordHash === recordHash) return { reuse: true };
  if (!records.length) return { summary: '- 오늘 볼트에 들어온 기록이 없습니다.', summaryStatus: 'empty', model: '없음' };
  if (dryRun) return { summary: '(dry-run: 요약 생략)', summaryStatus: 'skipped', model: '없음' };
  if (cooldownActive()) return { summary: '(사용량 한도 쿨다운으로 요약 보류 — 다음 실행에서 다시 시도)', summaryStatus: 'cooldown', model: '없음' };
  try {
    const clio = loadAgent('clio', { fallbackModel: 'sonnet' });
    const out = sanitizeSummary(headlessResult(await runHeadlessClaude(buildSummaryPrompt(date, records), clio.model, '', {
      lean: true, appendSystemPrompt: clio.systemPrompt, tools: '', maxTurns: 1, timeoutMs: 5 * 60 * 1000,
    })));
    if (!out) throw new Error('요약 형식("- " 줄) 출력 없음');
    return { summary: out, summaryStatus: 'ok', model: clio.model };
  } catch (e) {
    console.error('  ❌ AI 요약 실패:', e.message);
    return { summary: '(AI 요약 실패 — 다음 실행에서 다시 시도)', summaryStatus: 'failed', model: '없음', failed: true };
  }
}

// 날짜별 경고 키 — 경고 상세의 날짜는 가림 처리되므로 키로 날짜를 구분한다(그날 경고만 취소).
function summaryWarningSubject(date) {
  return warningSubjectKey('summary', date);
}

export async function processDay({ mode, date, dryRun, noSend, rules, today, deps: injected = {} }) {
  const deps = { send: sendAgentMessage, summarize, write: writeAtomic, computeRoute, updateCandidates, fetchEvents: async (day) => {
    if (!isConfigured()) return null;
    return listEventsForKstDay(day, { token: await getAccessToken({ requiredScopes: CALENDAR_READ_SCOPES }) });
  }, readOwners: () => parseCalendarOwners(readFileSync(vaultAbs(VAULT_REL.calendarOwnersFile), 'utf8')),
  readTodos, ...injected };
  const path = notePath(date);
  const first = readOrNull(path);
  if (mode === 'prepare' && first != null) { console.log(`  ℹ️ ${date}: 노트가 이미 있음 — 미리 만들기 건너뜀`); return { failed: false }; }
  const inspected = inspectExisting(first);
  if (!inspected.ok) { console.error(`  ⛔ ${date}: ${inspected.reason} — 쓰지 않음`); return { failed: true }; }
  // 원문이 있는 날의 잘못된 판정 설정은 합계를 조용히 비우지 않고 잡 실패로 드러낸다.
  const spendingSummary = (injected.readSpending ?? readDailySpending)(date);
  const spending = formatDailyNoteSpending(spendingSummary);
  const records = collectRecords(VAULT_PATHS.root, date);
  const recordHash = recordHashOf(records);
  console.log(`[daily-note] ${mode} ${date} — 기록 ${records.length}개${dryRun ? ' (dry-run)' : ''}`);
  const prevFields = inspected.prev?.fields;
  // 미리 만들기는 LLM 요약을 부르지 않는다(23:30 초안이 채운다).
  const s = mode === 'prepare' ? { summary: PENDING_TEXT, summaryStatus: 'pending', model: '없음' }
    : await deps.summarize(date, records, prevFields, recordHash, dryRun);
  const summary = s.reuse ? (inspected.prev.sections.find((x) => x.title === 'AI 하루 요약')?.content ?? '') : s.summary;
  const summaryStatus = s.reuse ? prevFields.summaryStatus : s.summaryStatus;
  const model = s.reuse ? prevFields.model : s.model;
  let events;
  try { events = await deps.fetchEvents(date); }
  catch (error) { events = 'failed'; console.error('  ❌ 캘린더 조회 실패:', error.message); }
  let eventGroups = null;
  if (Array.isArray(events) && events.length) {
    try { eventGroups = groupEventsByOwner(events, await deps.readOwners()); }
    catch (error) { console.warn('  ⚠️ 캘린더 소유자 대응표 읽기 실패:', error.message); }
  }
  let todos = 'pending';
  if (mode !== 'prepare') {
    try { todos = await deps.readTodos(date); }
    catch (error) { todos = 'failed'; console.error('  ❌ 할 일 기록 읽기 실패:', error.message); }
  }
  let route = null;
  let routeHash = prevFields?.routeHash ?? null;
  if (mode === 'prepare') route = 'pending';
  else if (existsSync(VAULT_PATHS.location.root)) {
    try {
      const routePoints = readRoutePoints(date);
      const routePayments = readRoutePayments(date);
      routeHash = routeHashOf(routePoints, routePayments);
      route = await deps.computeRoute(date, { dryRun, points: routePoints, payments: routePayments,
        events: Array.isArray(events) ? events : [] });
      if (!dryRun) await attachRouteMap(deps.renderMap, { date, route, points: routePoints, today });
      if (!dryRun) attachSpendingPlaces(deps.writePlaces, { date, route, payments: routePayments, today });
      // 일정·카카오 조회가 실패한 결과로는 지문을 갱신하지 않는다. 그래야 7일 재계산이 다시 돌아 활동을 채운다.
      if (events === 'failed' || route?.degraded || route?.mapIncomplete) routeHash = prevFields?.routeHash ?? null;
    }
    catch (error) { route = 'failed'; routeHash = prevFields?.routeHash ?? null; console.error('  ❌ 동선 계산 실패:', String(error.message).replace(/[-+]?\d+(?:\.\d+)?/g, '[수치]')); }
  }
  const statusOf = (prev) => mode === 'finalize' && (events !== 'failed' || hasNormalSchedule(prev)) ? '확정' : '초안';
  const render = (prev) => renderDailyNote({ date, records, summary, status: statusOf(prev), model, summaryStatus, recordHash, routeHash, today, telegramSentAt: prev?.fields?.telegramSentAt ?? null, prev, events, eventGroups, route, todos, spending, spendingExpenseCount: spendingSummary.expenseCount });

  let note = render(inspected.prev);
  const rel = relative(VAULT_PATHS.root, path);
  const problems = checkNote(rel, note, rules);
  if (problems.length) { console.error(`  ⛔ 등록부 위반으로 쓰지 않음: ${problems.join(' / ')}`); return { failed: true }; }
  if (dryRun) { console.log(note); return { failed: !!s.failed || events === 'failed' }; }

  // 쓰기 직전 다시 읽기 — LLM 호출 중 오너가 고쳤으면 최신 내용 기준으로 다시 만든다(리뷰 HIGH-3).
  const latest = readOrNull(path);
  if (latest !== first) {
    const again = inspectExisting(latest);
    if (!again.ok) { console.error(`  ⛔ ${date}: 쓰기 직전 변경 감지 — ${again.reason}`); return { failed: true }; }
    note = render(again.prev);
    const again2 = checkNote(rel, note, rules);
    if (again2.length) { console.error(`  ⛔ 등록부 위반으로 쓰지 않음: ${again2.join(' / ')}`); return { failed: true }; }
  }
  let candidatesFailed = false;
  if (mode === 'finalize' && statusOf(inspectExisting(note).prev) === '확정' && Array.isArray(route)) {
    try { deps.updateCandidates({ date, stays: route.filter((stay) => stay.kind !== 'roam' && stay.kind !== 'move').map((stay) => ({ ...stay, start: stay.startAt, end: stay.endAt })),
      events: Array.isArray(events) ? events : [], root: VAULT_PATHS.root }); }
    catch (error) { candidatesFailed = true; console.error('  ❌ 장소 후보 갱신 실패:', String(error.message).replace(/[-+]?\d+(?:\.\d+)?/g, '[수치]')); }
  }
  if (latest != null && sameIgnoringModified(latest, note)) console.log('  변경 없음 — 쓰지 않음');
  else { mkdirSync(dirname(path), { recursive: true }); deps.write(path, note); console.log(`  💾 ${rel} (${statusOf(inspectExisting(note).prev)})`); }

  // 23:30 초안의 요약 실패 경고는 밤이라 07:00까지 보류된다. 05:30 확정에서 요약이 되면 그 경고는 이미 낡았으므로
  // 아침에 나가기 전에 취소한다(2026-10-25: 한도로 23:30 실패 → 05:30 복구됐는데 07:00에 실패 경고가 나감).
  if (summaryStatus === 'ok' && !dryRun && (deps.queueFile || !process.env.NODE_TEST_CONTEXT)) {
    const issueKey = `daily-note|DAILY_SUMMARY_FAILED|${summaryWarningSubject(date)}`;
    try {
      await cancelDeferredWarnings((entry) => entry.issueKey === issueKey, deps.queueFile ?? DEFERRED_WARNINGS_FILE);
    } catch (error) { console.error(`  ⚠️ 보류된 요약 실패 경고 취소 실패: ${error.message}`); }
  }

  const sentAt = inspectExisting(readOrNull(path)).prev?.fields?.telegramSentAt;
  if (sentAt || noSend || mode === 'prepare') return { failed: !!s.failed || events === 'failed', candidatesFailed };
  try {
    const message = { agent: SENDER_AGENT, kind: '정보', topic: '데일리', body: buildDailyTelegramBody(date, records, summary, statusOf(inspectExisting(note).prev)) };
    if (summaryStatus === 'failed') {
      const result = await sendDirectWarning({
        message, send: deps.send, jobName: 'daily-note', warningCode: 'DAILY_SUMMARY_FAILED',
        subjectKey: summaryWarningSubject(date), kind: 'operational', severity: 'medium', journalRoot: deps.journalRoot,
        queueFile: deps.queueFile, clock: deps.clock ?? Date.now,
        detail: `AI 요약 실패 — 다음 실행에서 다시 시도 (${date})`,
      });
      if (result?.deferred) return { failed: !!s.failed || events === 'failed', candidatesFailed };
    } else await deps.send(message);
    console.log('  📨 데일리 요약 발송');
  } catch (e) {
    console.error('  ❌ 텔레그램 발송 실패:', e.message);
    return { failed: true, candidatesFailed };
  }
  // 발송 기록 — AI 칸 지문은 머리말과 무관해 그대로 유효하다. 다시 읽어 그 사이 변경을 보존한다.
  const current = readOrNull(path);
  const fmEnd = current?.indexOf('\n---', 4) ?? -1;
  if (!current || fmEnd < 0) { console.error('  ⚠️ 발송 기록을 남길 노트를 찾지 못함(다음 실행에서 다시 보낼 수 있음)'); return { failed: true, candidatesFailed }; }
  const head = current.slice(0, fmEnd).replace(/^(dailyStatus: .*)$/m, `$1\ntelegramSentAt: "${new Date().toISOString()}"`);
  deps.write(path, head + current.slice(fmEnd));
  return { failed: !!s.failed || events === 'failed', candidatesFailed };
}

export async function recomputeDailyRoute({ date, root = VAULT_PATHS.root, rules, dryRun = false, force = false,
  today = kstDate(new Date()), deps: injected = {} }) {
  const deps = { computeRoute, write: writeAtomic, fetchEvents: async (day) => {
    if (!isConfigured()) return [];
    return listEventsForKstDay(day, { token: await getAccessToken({ requiredScopes: CALENDAR_READ_SCOPES }) });
  }, ...injected };
  const path = notePathAt(root, date);
  const first = readOrNull(path);
  if (first == null) return { updated: false, skipped: '노트 없음' };
  const inspected = inspectExisting(first);
  if (!inspected.ok) return { updated: false, skipped: inspected.reason };
  if (inspected.prev.fields.summaryStatus === 'pending') return { updated: false, skipped: '미리 만든 노트' };
  if (!existsSync(join(root, VAULT_REL.location))) return { updated: false, skipped: '위치 폴더 없음' };
  const points = readRoutePoints(date, root);
  const payments = readRoutePayments(date, root);
  const routeHash = routeHashOf(points, payments);
  if (!force && inspected.prev.fields.routeHash === routeHash) {
    // 지문이 같아도 장소별 소비 파일이 없는 지난날이면 그 파일만 쓴다. 확정이 카카오 조회 실패(degraded)로 끝났는데
    // 그 뒤 새 점·결제가 없으면 지문이 그대로라 영영 안 생기기 때문이다(2026-10-29 리뷰). 데일리 노트는 건드리지 않는다.
    // 도입 전 최근 7일도 이 경로로 채워진다. 일정은 장소 이름에 쓰지 않으니 넘기지 않는다.
    if (!dryRun && deps.writePlaces && date < today && !existsSync(spendingPlacesPath(date, root))) {
      const route = await deps.computeRoute(date, { root, dryRun, points, payments, events: [] });
      attachSpendingPlaces(deps.writePlaces, { date, route, payments, root, today });
    }
    return { updated: false, skipped: '지문 동일' };
  }
  // 재계산에도 일정을 넘긴다. 못 읽으면 일정 활동(공연 등)이 사라지므로 이번엔 건너뛰고 다음 실행에서 다시 한다.
  let events;
  try { events = await deps.fetchEvents(date); }
  catch { return { updated: false, skipped: '캘린더 조회 실패' }; }
  const route = await deps.computeRoute(date, { root, dryRun, points, payments, events: Array.isArray(events) ? events : [] });
  if (!dryRun) await attachRouteMap(deps.renderMap, { date, route, points, root, today });
  if (!dryRun) attachSpendingPlaces(deps.writePlaces, { date, route, payments, root, today });
  // 지오코딩 중 오너가 파일을 수정했으면 다시 검사해 그 변경을 보존한다.
  const latest = readOrNull(path);
  if (latest == null) return { updated: false, skipped: '노트 없음' };
  const again = inspectExisting(latest);
  if (!again.ok) return { updated: false, skipped: again.reason };
  if (!force && again.prev.fields.routeHash === routeHash) return { updated: false, skipped: '지문 동일' };
  const note = replaceDailyRoute(latest, route, route?.degraded || route?.mapIncomplete
    ? (again.prev.fields.routeHash ?? null) : routeHash);
  const problems = rules ? checkNote(relative(root, path), note, rules) : [];
  if (problems.length) throw new Error(`등록부 위반: ${problems.join(' / ')}`);
  if (sameIgnoringModified(latest, note)) return { updated: false, skipped: '변경 없음' };
  if (dryRun) console.log(`  ℹ️ ${date} 동선 갱신 예정: ${force ? '강제 재계산' : '위치 지문 변경'}`);
  else deps.write(path, note);
  return { updated: !dryRun, dryRun };
}

export async function recomputeRecentRoutes({ now = new Date(), root = VAULT_PATHS.root, rules, dryRun = false,
  deps = {} } = {}) {
  const today = kstDate(now);
  const results = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(Date.parse(`${today}T00:00:00Z`) - offset * 86_400_000).toISOString().slice(0, 10);
    try { results.push({ date, ...await recomputeDailyRoute({ date, root, rules, dryRun, today, deps }) }); }
    catch (error) { console.warn(`  ⚠️ ${date} 동선 재계산 실패:`, String(error.message).replace(/[-+]?\d+(?:\.\d+)?/g, '[수치]')); results.push({ date, failed: true }); }
  }
  return results;
}

export const dailyWorkFailed = (results) => results.some((result) => result.failed);

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
  const dryRun = args['dry-run'] === true;
  const now = new Date();
  const noteStatus = (date) => inspectExisting(readOrNull(notePath(date))).prev?.fields?.dailyStatus ?? null;
  const actions = planActions({ mode: args.mode, date: args.date, now, noteStatus, noteExists: (date) => existsSync(notePath(date)) });
  if (!actions.length) console.log('ℹ️ 새 노트 작업 없음');
  const rules = parseRegistry(readFileSync(vaultAbs(VAULT_REL.registryFile), 'utf8'));
  const dayResults = [];
  const renderMap = createRouteMapRenderer();
  for (const action of actions) {
    const r = await processDay({ ...action, dryRun, noSend: args['no-send'] === true, rules, today: kstDate(now),
      deps: { renderMap, writePlaces: writeSpendingPlaces } });
    dayResults.push(r);
  }
  await recomputeRecentRoutes({ now, rules, dryRun, deps: { renderMap, writePlaces: writeSpendingPlaces } });
  if (dailyWorkFailed(dayResults)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error('❌ 데일리 노트 실패:', e); process.exit(1); });
}
