#!/usr/bin/env node
/** D86: 오너 일정 읽기 전용. 07:30 오늘, 21:00 내일. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_REL, VAULT_PATHS, vaultAbs } from '../lib/vault-paths.mjs';
import { readCandidates, saveCandidates, readyCandidate, candidateVisitCount } from '../lib/place-candidates.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { escapeHtml } from '../lib/telegram.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { sendDirectWarning } from '../lib/direct-warning-delivery.mjs';
import { isConfigured, getAccessToken, CALENDAR_READ_SCOPES } from '../lib/google-oauth.mjs';
import { formatEventLine, listEventsForKstDay } from '../lib/google-calendar.mjs';
import { groupEventsByOwner, parseCalendarOwners } from '../lib/calendar-owners.mjs';

const SENDER_AGENT = 'hermes';
const kstParts = (now) => new Date(now.getTime() + 9 * 3_600_000).toISOString();
const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const validDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
  && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
const oneLineHtml = (value) => escapeHtml(String(value ?? '').replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim());

export function readPeople() {
  const root = vaultAbs(VAULT_REL.people);
  return readdirSync(root).filter((name) => name.endsWith('.md')).map((name) => {
    const fields = parseFrontmatter(readFileSync(join(root, name), 'utf8'));
    return { name: fields.name || fields.title || basename(name, '.md'), birthday: fields.birthday };
  });
}

export function readOwners() {
  return parseCalendarOwners(readFileSync(vaultAbs(VAULT_REL.calendarOwnersFile), 'utf8'));
}

export function birthdayLines(date, people) {
  const today = Date.parse(`${date}T00:00:00Z`);
  return people.flatMap((person) => {
    if (!validDate(person.birthday || '')) return [];
    const [, month, day] = person.birthday.split('-').map(Number);
    // 2월 29일생은 평년에 JS UTC 날짜 정규화에 따라 3월 1일로 축하한다.
    let occurrence = Date.UTC(Number(date.slice(0, 4)), month - 1, day);
    if (occurrence < today) occurrence = Date.UTC(Number(date.slice(0, 4)) + 1, month - 1, day);
    const days = Math.round((occurrence - today) / 86_400_000);
    if (days > 7) return [];
    const name = escapeHtml(person.name);
    return [days === 0 ? `- 오늘: ${name}(${Number(date.slice(0, 4)) - Number(person.birthday.slice(0, 4))}살)` : `- ${days}일 뒤: ${name}`];
  });
}

export async function runBriefing({ mode, date, preview = false, deps = {} } = {}) {
  const now = deps.now?.() ?? new Date();
  const current = kstParts(now);
  const hour = Number(current.slice(11, 13));
  const selectedMode = mode ?? (hour >= 5 && hour <= 11 ? 'morning' : hour >= 18 && hour <= 23 ? 'evening' : null);
  if (selectedMode === null) { console.log('브리핑 시각 아님 — --mode 없이 종료'); return { skipped: true, reason: 'outside-hours' }; }
  if (!['morning', 'evening'].includes(selectedMode)) throw new Error(`--mode는 morning 또는 evening: ${selectedMode}`);
  const targetDate = date ?? (selectedMode === 'morning' ? current.slice(0, 10) : nextDay(current.slice(0, 10)));
  if (!validDate(targetDate)) throw new Error(`--date 형식 오류: ${targetDate}`);
  const fetchEvents = deps.fetchEvents ?? (async (day) => {
    if (!(deps.isConfigured ?? isConfigured)()) throw new Error('캘린더 미연결 — google-oauth-setup 필요');
    return listEventsForKstDay(day, { token: await getAccessToken({ requiredScopes: CALENDAR_READ_SCOPES }) });
  });
  let events;
  let calendarError = false;
  try { events = await fetchEvents(targetDate); }
  catch (error) {
    console.error('캘린더 조회 실패:', error.message);
    events = [];
    calendarError = true;
  }
  const today = current.slice(0, 10);
  let candidates = [];
  if (selectedMode === 'evening') {
    try { candidates = await (deps.readCandidates ?? readCandidates)(VAULT_PATHS.root); }
    catch (error) { console.warn('장소 후보 읽기 실패:', error.message); }
  }
  const requests = candidates.filter((candidate) => candidate.status === '관찰' && readyCandidate(candidate, today)).slice(0, 3);
  if (selectedMode === 'evening' && !events.length && !calendarError && !requests.length) return { skipped: true, reason: 'no-events' };
  const period = selectedMode === 'morning' ? '오늘 일정' : '내일 일정';
  let groups = null;
  if (events.length) {
    try { groups = groupEventsByOwner(events, await (deps.readOwners ?? readOwners)()); }
    catch (error) { console.warn('캘린더 소유자 대응표 읽기 실패:', error.message); }
  }
  const sections = groups
    ? groups.map(({ owner, events: ownerEvents }) => `■ ${escapeHtml(owner)} — ${period}\n${ownerEvents.map((event) => escapeHtml(formatEventLine(event, { owner, showCalendar: owner === '기타' }))).join('\n')}`)
    : [`■ ${period}\n${calendarError ? '- 캘린더 연결 확인 필요(google-oauth-setup)' : (events.length ? events.map((event) => escapeHtml(formatEventLine(event))) : ['- 일정 없음']).join('\n')}`];
  let birthdayError = false;
  if (selectedMode === 'morning') {
    let birthday;
    try { birthday = birthdayLines(targetDate, await (deps.readPeople ?? readPeople)()); }
    catch (error) { console.error('생일 정보 조회 실패:', error.message); birthday = ['- 생일 정보 조회 실패']; birthdayError = true; }
    if (birthday.length) sections.push(`■ 생일\n${birthday.join('\n')}`);
  }
  if (requests.length) {
    const lines = requests.map((candidate) => `- ${oneLineHtml(candidate.id)} · ${oneLineHtml(candidate.address || '미등록 장소')} 근처 · 최근 30일 ${candidateVisitCount(candidate, today)}회 방문${candidate.eventTitles.length ? ` · 일정: ${oneLineHtml(candidate.eventTitles.join(', '))}` : ''}`);
    const exampleId = oneLineHtml(requests[0].id);
    sections.push(`■ 장소 등록 요청\n${lines.join('\n')}\n<code>장소 ${exampleId} 이름</code>으로 답하면 등록, <code>장소 ${exampleId} 제외</code>`);
  }
  const body = [`${selectedMode === 'morning' ? '아침 브리핑' : '내일 일정'} (${targetDate})`, ...sections].join('\n\n');
  if (!preview) {
    const message = { agent: SENDER_AGENT, kind: '정보', topic: selectedMode === 'morning' ? '아침 브리핑' : '내일 일정', body };
    const send = deps.send ?? sendAgentMessage;
    if (calendarError || birthdayError) {
      await sendDirectWarning({
        message, send, jobName: 'hermes-briefing', warningCode: 'PERSONAL_BRIEFING_SOURCE_FAILED',
        subjectKey: 'source', kind: 'operational', severity: 'medium', journalRoot: deps.journalRoot,
        detail: [calendarError && '캘린더 연결 확인 필요', birthdayError && '생일 정보 조회 실패'].filter(Boolean).join(' | '),
      });
    } else await send(message);
  }
  if (!preview && requests.length) {
    for (const candidate of requests) { candidate.status = '물음'; candidate.askedAt = now.toISOString(); }
    await (deps.saveCandidates ?? saveCandidates)(VAULT_PATHS.root, candidates);
  }
  return { body, sent: !preview, alert: calendarError };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = Object.fromEntries(argv.map((value) => value.replace(/^--/, '').split('=')).map(([key, value]) => [key, value ?? true]));
  const noSend = args['dry-run'] === true || args['no-send'] === true;
  const result = await runBriefing({ mode: args.mode, date: args.date, preview: noSend, deps });
  if (args['dry-run'] && result.body) console.log(result.body);
  if (result.alert) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error('헤르메스 브리핑 실패:', error.message); process.exitCode = 1; });
