#!/usr/bin/env node
/** D86: 오너 일정 읽기 전용. 07:30 오늘, 21:00 내일. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { escapeHtml } from '../lib/telegram.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { isConfigured, getAccessToken } from '../lib/google-oauth.mjs';
import { formatEventLine, listEventsForKstDay } from '../lib/google-calendar.mjs';

const SENDER_AGENT = 'hermes';
const kstParts = (now) => new Date(now.getTime() + 9 * 3_600_000).toISOString();
const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const validDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
  && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

export function readPeople() {
  const root = vaultAbs(VAULT_REL.people);
  return readdirSync(root).filter((name) => name.endsWith('.md')).map((name) => {
    const fields = parseFrontmatter(readFileSync(join(root, name), 'utf8'));
    return { name: fields.name || fields.title || basename(name, '.md'), birthday: fields.birthday };
  });
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

export async function runBriefing({ mode, date, deps = {} } = {}) {
  const now = deps.now?.() ?? new Date();
  const current = kstParts(now);
  const hour = Number(current.slice(11, 13));
  const selectedMode = mode ?? (hour >= 5 && hour <= 11 ? 'morning' : hour >= 18 && hour <= 23 ? 'evening' : null);
  if (selectedMode === null) { console.log('브리핑 시각 아님 — --mode 없이 종료'); return { skipped: true, reason: 'outside-hours' }; }
  if (!['morning', 'evening'].includes(selectedMode)) throw new Error(`--mode는 morning 또는 evening: ${selectedMode}`);
  const targetDate = date ?? (selectedMode === 'morning' ? current.slice(0, 10) : nextDay(current.slice(0, 10)));
  if (!validDate(targetDate)) throw new Error(`--date 형식 오류: ${targetDate}`);
  if (!(deps.isConfigured ?? isConfigured)() && !deps.fetchEvents) {
    console.log('캘린더 미연결 — google-oauth-setup 필요');
    return { skipped: true, reason: 'unconfigured' };
  }
  const fetchEvents = deps.fetchEvents ?? (async (day) => listEventsForKstDay(day, { token: await getAccessToken() }));
  const events = await fetchEvents(targetDate);
  if (selectedMode === 'evening' && !events.length) return { skipped: true, reason: 'no-events' };
  const lines = events.length ? events.map((event) => escapeHtml(formatEventLine(event))) : ['- 일정 없음'];
  const sections = [`■ ${selectedMode === 'morning' ? '오늘 일정' : '내일 일정'}\n${lines.join('\n')}`];
  if (selectedMode === 'morning') {
    let birthday;
    try { birthday = birthdayLines(targetDate, await (deps.readPeople ?? readPeople)()); }
    catch (error) { console.error('생일 정보 조회 실패:', error.message); birthday = ['- 생일 정보 조회 실패']; }
    if (birthday.length) sections.push(`■ 생일\n${birthday.join('\n')}`);
  }
  const body = [`${selectedMode === 'morning' ? '아침 브리핑' : '내일 일정'} (${targetDate})`, ...sections].join('\n\n');
  await (deps.send ?? sendAgentMessage)({ agent: SENDER_AGENT, kind: '정보', topic: selectedMode === 'morning' ? '아침 브리핑' : '내일 일정', body });
  return { body, sent: true };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((value) => value.replace(/^--/, '').split('=')).map(([key, value]) => [key, value ?? true]));
  const noSend = args['dry-run'] === true || args['no-send'] === true;
  const result = await runBriefing({ mode: args.mode, date: args.date, deps: noSend ? { send: async () => {} } : {} });
  if (args['dry-run'] && result.body) console.log(result.body);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error('헤르메스 브리핑 실패:', error.message); process.exitCode = 1; });
