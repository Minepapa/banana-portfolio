#!/usr/bin/env node
/** D86: 오너 일정 읽기 전용. 07:30 오늘, 21:00 내일. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_REL, VAULT_PATHS, vaultAbs } from '../lib/vault-paths.mjs';
import { readCandidates, saveCandidates, readyCandidate, candidateVisitCount } from '../lib/place-candidates.mjs';
import { parseFrontmatter, updateFrontmatter } from '../lib/vault-frontmatter.mjs';
import { withLock, writeAtomic } from '../lib/state-writer.mjs';
import { escapeHtml } from '../lib/telegram.mjs';
import { renderAgentMessage, sendAgentMessage } from '../lib/pantheon-send.mjs';
import { sendDirectWarning } from '../lib/direct-warning-delivery.mjs';
import { drainDeferredWarnings } from '../lib/deferred-warnings.mjs';
import { isConfigured, getAccessToken, CALENDAR_READ_SCOPES } from '../lib/google-oauth.mjs';
import { formatEventLine, listEventsForKstDay } from '../lib/google-calendar.mjs';
import { groupEventsByOwner, parseCalendarOwners } from '../lib/calendar-owners.mjs';
import { readDailySpending, formatTodaySpending } from '../lib/spending-daily.mjs';
import { dayCollection, formatCollectionLine } from '../lib/spending-collection.mjs';
import { planMonthCheck, runMonthReport, commitMonthReport, removeMonthReport, readMonthReport, renderMonthCheck,
  monthPlaces, gapQuestions, previousMonth } from '../lib/spending-month-check.mjs';
import { createWikiQuestion } from '../lib/wiki-question-queue.mjs';

const SENDER_AGENT = 'hermes';
const TELEGRAM_TEXT_LIMIT = 4096;
const kstParts = (now) => new Date(now.getTime() + 9 * 3_600_000).toISOString();
const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const previousDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const validDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
  && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
const oneLineHtml = (value) => escapeHtml(String(value ?? '').replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim());

function splitBriefingMessage(message) {
  if (message.agent !== SENDER_AGENT || message.kind !== '정보' || typeof message.body !== 'string') {
    return [message];
  }
  if (renderAgentMessage(message).length <= TELEGRAM_TEXT_LIMIT) return [message];
  const continuation = `${message.topic} (계속)\n`;
  const lineLimit = TELEGRAM_TEXT_LIMIT - renderAgentMessage({ ...message, body: continuation }).length;
  const splitLongLine = (line) => {
    if (line.length <= lineLimit) return [line];
    // 긴 입력 한 줄은 HTML 태그만 내려놓고, 엔티티를 자르지 않은 채 나눈다.
    const plain = line.replace(/<[^>]*>/g, '');
    const parts = [];
    let part = '';
    for (const token of plain.match(/&(?:#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);|[\s\S]/giu) ?? []) {
      if (part.length + token.length > lineLimit) { parts.push(part); part = ''; }
      part += token;
    }
    if (part) parts.push(part);
    return parts;
  };
  const chunks = [];
  let body = '';
  for (const line of message.body.split('\n').flatMap(splitLongLine)) {
    const candidate = body ? `${body}\n${line}` : line;
    if (renderAgentMessage({ ...message, body: candidate }).length <= TELEGRAM_TEXT_LIMIT) {
      body = candidate;
      continue;
    }
    if (body) chunks.push({ ...message, body });
    body = `${continuation}${line}`;
    if (renderAgentMessage({ ...message, body }).length > TELEGRAM_TEXT_LIMIT) {
      throw new Error('브리핑 한 줄이 텔레그램 길이 제한을 초과함');
    }
  }
  if (body) chunks.push({ ...message, body });
  return chunks;
}

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

export function readUnregisteredVoices(today, dir = vaultAbs(VAULT_REL.inboxRoot),
  recordsDir = dir === vaultAbs(VAULT_REL.inboxRoot) ? vaultAbs(VAULT_REL.recordsNotes) : null) {
  const start = Date.parse(`${nextDay(today)}T00:00:00Z`) - 2 * 86_400_000 + 12 * 3_600_000;
  const end = start + 86_400_000;
  const files = [];
  function collect(folder) {
    let entries;
    // 메모가 모두 옮겨져 빈 Inbox 폴더가 사라진 경우는 '비어 있음'이다(2026-10-23).
    try { entries = readdirSync(folder, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
    }
  }
  collect(dir);
  if (recordsDir) collect(recordsDir);
  return files.sort().flatMap((path) => {
      try {
        const content = readFileSync(path, 'utf8');
        const fields = parseFrontmatter(content);
        const createdAt = Date.parse(fields.capturedAt);
        if (fields.kind !== '음성' || fields.voiceConfirm !== '확인 대기 → 미등록' || fields.voiceRemindedAt
          || !Number.isFinite(createdAt) || createdAt <= start || createdAt > end) return [];
        const transcript = content.split(/^## 전사\s*$/m)[1]?.split(/^정정: /m)[0]?.trim() ?? '';
        return [{ path, text: transcript.replace(/\s+/g, ' ').slice(0, 60) || '(전사 없음)' }];
      } catch (error) { console.warn(`음성 노트 읽기 실패 ${path}:`, error.message); return []; }
    }).slice(0, 5);
}

export async function markVoiceReminded(voices, at) {
  for (const voice of voices) {
    if (!voice.path) continue;
    try {
      await withLock(voice.path, () => {
        const content = readFileSync(voice.path, 'utf8');
        const fields = parseFrontmatter(content);
        if (fields.kind !== '음성' || fields.voiceRemindedAt) return;
        const updated = `${updateFrontmatter(content, { voiceRemindedAt: at })}${content.slice(content.indexOf('\n---\n') + 5)}`;
        if (readFileSync(voice.path, 'utf8') !== content) throw new Error('음성 노트가 갱신됨');
        writeAtomic(voice.path, updated);
      });
    } catch (error) { console.warn(`음성 알림 기록 실패 ${voice.path}:`, error.message); }
  }
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

// 월간 지출 점검(결정 `월별-지출-정본`, 2026-10-29 오너 승인): 아침마다 지난달 결과 파일이 있는지 본다.
// - 내보내기가 아직 없으면 브리핑에 대기 한 줄(오너가 넣을 때까지 날마다 — 매달 하는 요청을 대신한다).
// - 있으면 점검을 돌려 본문을 만든다. 발송·결과 파일 저장은 브리핑 발송 뒤 deliverMonthCheck가 한다.
// - 실패는 숨기지 않는다: 브리핑에 실패 한 줄 + 잡 실패 코드. 결과 파일이 없으니 다음 아침 다시 돈다.
// - 지난달 결과·장소별 소비는 곁가지다. 읽기가 깨져도(LiveSync 손상 등) 합계·커버리지는 보내고 그 칸만 실패로 적는다
//   (곁가지 파일 하나가 본 점검을 날마다 막지 않게, 2026-10-29 리뷰 MEDIUM).
// 테스트에서는 기본 구현을 하나도 쓰지 않는다(주입이 빠지면 실제 볼트·python 대신 실패로 끝난다).
const MONTH_CHECK_DEFAULTS = process.env.NODE_TEST_CONTEXT ? {} : {
  planMonthCheck, runMonthReport, readMonthReport, monthPlaces, commitMonthReport,
  removeMonthReport, createQuestion: createWikiQuestion };
const monthCheckDep = (deps, name) => deps[name] ?? MONTH_CHECK_DEFAULTS[name]
  ?? (() => { throw new Error(`월간 점검 의존성 없음: ${name}`); });

export function prepareMonthCheck(date, deps = {}) {
  if (!deps.planMonthCheck && !MONTH_CHECK_DEFAULTS.planMonthCheck) return null;
  let month = previousMonth(date);
  try {
    const planned = monthCheckDep(deps, 'planMonthCheck')({ date });
    month = planned.month;
    if (planned.status === 'none') return null;
    if (planned.status === 'waiting') {
      return { status: 'waiting', month, section: `■ 지난달 지출 마감\n- ${month} 뱅크샐러드 내보내기 대기(${VAULT_REL.spending}/Banksalad에 넣으면 다음 아침 점검)` };
    }
    const { report, text } = monthCheckDep(deps, 'runMonthReport')(month);
    const sideFailures = [];
    let previous = null;
    try { previous = monthCheckDep(deps, 'readMonthReport')(previousMonth(`${month}-01`)); }
    catch (error) { sideFailures.push('지난달 결과'); console.error('월간 점검: 지난달 결과 읽기 실패:', error.message); }
    let places;
    try { places = monthCheckDep(deps, 'monthPlaces')(month); }
    catch (error) { places = { failed: true }; sideFailures.push('장소별 소비'); console.error('월간 점검: 장소별 소비 읽기 실패:', error.message); }
    const body = renderMonthCheck(report, { previous, places });
    return { status: 'ready', month, report, text, body, sideFailures,
      section: `■ 지난달 지출 마감\n- ${month} 점검 결과는 이어서 따로 보냄(실패하면 잡 경고)` };
  } catch (error) {
    console.error('월간 지출 점검 실패:', error.message);
    return { status: 'failed', month, section: `■ 지난달 지출 마감\n- ${month} 월간 점검 실패(잡 로그 확인, 다음 아침 다시)` };
  }
}

// 순서: 결과 파일 저장 → 발송 → (발송 실패면 파일을 지워 다음 아침 다시) → 빠진 결제수단 질문.
// 저장을 먼저 하는 이유: 발송 뒤 저장이 실패하면 다음 아침 같은 메시지가 또 나가고, 저장 실패가 이어지는 동안
// 날마다 반복된다(2026-10-29 리뷰 MEDIUM). 저장이 안 되면 아예 보내지 않고, 보내기가 안 되면 파일을 되돌린다.
// 되돌리기마저 실패하면 그 달 메시지는 빠지지만 잡 경고로 드러난다(중복 반복보다 한 번 누락 + 경고를 고른다).
// 반환: 질문 등록 실패 건수(호출부가 잡 경고로 올린다).
export async function deliverMonthCheck(check, { sendAll, deps = {} }) {
  monthCheckDep(deps, 'commitMonthReport')(check.month, check.text);
  try { await sendAll({ agent: SENDER_AGENT, kind: '정보', topic: '월간 지출 점검', body: check.body }); }
  catch (error) {
    try { monthCheckDep(deps, 'removeMonthReport')(check.month); }
    catch (removeError) { console.error('월간 점검 결과 파일 되돌리기 실패 — 이 달 메시지는 다시 보내지 않음:', removeError.message); }
    throw error;
  }
  let questionFailures = 0;
  for (const question of gapQuestions(check.report)) {
    try { await monthCheckDep(deps, 'createQuestion')({ ...question, asker: SENDER_AGENT }); }
    catch (error) { questionFailures += 1; console.error('빠진 결제수단 질문 등록 실패:', error.message); }
  }
  return { questionFailures };
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
  if (selectedMode === 'morning' && !preview && (deps.queueFile || !process.env.NODE_TEST_CONTEXT)) {
    try { await drainDeferredWarnings({ send: deps.send ?? sendAgentMessage,
      queueFile: deps.queueFile, now: now.getTime(), journalRoot: deps.journalRoot }); }
    catch (error) { console.error('아침 보류 경고 정리 실패:', error.message); }
  }
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
  const spendingDate = selectedMode === 'morning' ? targetDate
    : targetDate === nextDay(today) ? today : null;
  let spendingSection = null;
  let spendingHasSource = false;
  let spendingError = false;
  if (spendingDate) {
    try {
      const spending = (deps.readSpending ?? readDailySpending)(spendingDate);
      spendingHasSource = spending.hasSource;
      spendingSection = formatTodaySpending(spending);
    } catch {
      spendingError = true;
      spendingSection = '■ 오늘 지출\n- 지출 기록 조회 실패';
    }
  }
  const monthCheck = selectedMode === 'morning' ? prepareMonthCheck(targetDate, deps) : null;
  // 어제 '지출 0원'이 결제가 없던 날인지 수집이 빠진 날인지(소비 보고 2단계). 확인이 필요할 때만 한 줄을 낸다.
  // 테스트에서는 주입이 없으면 돌지 않는다(실제 볼트를 읽지 않게).
  let collectionLine = null;
  const collection = deps.dayCollection ?? (process.env.NODE_TEST_CONTEXT ? null : dayCollection);
  if (selectedMode === 'morning' && collection) {
    try { collectionLine = formatCollectionLine(collection(previousDay(targetDate))); }
    catch (error) { console.error('지출 수집 점검 실패:', error.message); }
  }
  let candidates = [];
  if (selectedMode === 'evening') {
    try { candidates = await (deps.readCandidates ?? readCandidates)(VAULT_PATHS.root); }
    catch (error) { console.warn('장소 후보 읽기 실패:', error.message); }
  }
  const requests = candidates.filter((candidate) => candidate.status === '관찰' && readyCandidate(candidate, today)).slice(0, 3);
  let unregisteredVoices = [];
  if (selectedMode === 'evening') {
    try { unregisteredVoices = await (deps.readUnregisteredVoices ?? readUnregisteredVoices)(today); }
    catch (error) { console.warn('음성 노트 읽기 실패:', error.message); }
  }
  if (selectedMode === 'evening' && !events.length && !calendarError && !requests.length
    && !unregisteredVoices.length && !spendingHasSource && !spendingError) return { skipped: true, reason: 'no-events' };
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
  if (spendingSection) sections.push(spendingSection);
  if (collectionLine) sections.push(`■ 어제 지출 수집\n${collectionLine}`);
  if (monthCheck?.section) sections.push(monthCheck.section);
  if (requests.length) {
    const lines = requests.map((candidate) => `- ${oneLineHtml(candidate.id)} · ${oneLineHtml(candidate.address || '미등록 장소')} 근처 · 최근 30일 ${candidateVisitCount(candidate, today)}회 방문${candidate.eventTitles.length ? ` · 일정: ${oneLineHtml(candidate.eventTitles.join(', '))}` : ''}`);
    const exampleId = oneLineHtml(requests[0].id);
    sections.push(`■ 장소 등록 요청\n${lines.join('\n')}\n<code>장소 ${exampleId} 이름</code>으로 답하면 등록, <code>장소 ${exampleId} 제외</code>`);
  }
  if (unregisteredVoices.length) sections.push(`■ 음성으로 받은 일정·할 일 (미등록)\n${unregisteredVoices.map((voice) => `- ${oneLineHtml(voice.text ?? voice)}`).join('\n')}`);
  const body = [`${selectedMode === 'morning' ? '아침 브리핑' : '내일 일정'} (${targetDate})`, ...sections].join('\n\n');
  if (!preview) {
    const message = { agent: SENDER_AGENT, kind: '정보', topic: selectedMode === 'morning' ? '아침 브리핑' : '내일 일정', body };
    const send = deps.send ?? sendAgentMessage;
    const sendAll = async (outgoing) => {
      let result;
      for (const chunk of splitBriefingMessage(outgoing)) {
        result = await send(chunk);
        if (result?.ok !== true || !Number.isSafeInteger(result.result?.message_id)
          || result.result.message_id <= 0) {
          throw new Error('브리핑 메시지 전달 결과 확인 불가');
        }
      }
      return result;
    };
    let delivery;
    if (calendarError || birthdayError) {
      delivery = await sendDirectWarning({
        message, send: sendAll, jobName: 'hermes-briefing', warningCode: 'PERSONAL_BRIEFING_SOURCE_FAILED',
        subjectKey: 'source', kind: 'operational', severity: 'medium', journalRoot: deps.journalRoot,
        queueFile: deps.queueFile, clock: () => now.getTime(),
        detail: [calendarError && '캘린더 연결 확인 필요', birthdayError && '생일 정보 조회 실패'].filter(Boolean).join(' | '),
      });
    } else delivery = await sendAll(message);
    if (delivery?.ok === false) throw new Error('브리핑 발송 실패');
    if (unregisteredVoices.length && !delivery?.deferred) {
      await (deps.markVoiceReminded ?? markVoiceReminded)(unregisteredVoices, now.toISOString());
    }
    if (monthCheck?.status === 'ready') {
      try {
        const { questionFailures } = await deliverMonthCheck(monthCheck, { sendAll, deps });
        if (questionFailures || monthCheck.sideFailures.length) monthCheck.status = 'partial';
      } catch (error) { console.error('월간 지출 점검 발송 실패:', error.message); monthCheck.status = 'failed'; }
    }
  }
  if (!preview && requests.length) {
    for (const candidate of requests) { candidate.status = '물음'; candidate.askedAt = now.toISOString(); }
    await (deps.saveCandidates ?? saveCandidates)(VAULT_PATHS.root, candidates);
  }
  return { body, monthBody: monthCheck?.body ?? null, sent: !preview,
    alert: calendarError || spendingError || ['failed', 'partial'].includes(monthCheck?.status) };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = Object.fromEntries(argv.map((value) => value.replace(/^--/, '').split('=')).map(([key, value]) => [key, value ?? true]));
  const noSend = args['dry-run'] === true || args['no-send'] === true;
  const result = await runBriefing({ mode: args.mode, date: args.date, preview: noSend, deps });
  if (args['dry-run'] && result.body) console.log(result.body);
  if (args['dry-run'] && result.monthBody) console.log(`\n── 월간 지출 점검(따로 보낼 메시지) ──\n${result.monthBody}`);
  if (result.alert) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error('개인 일정 브리핑 실패:', error.message); process.exitCode = 1; });
