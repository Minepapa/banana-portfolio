const API = 'https://www.googleapis.com/calendar/v3';

async function getPages(path, { token, fetchImpl = fetch, params = {} }) {
  const items = [];
  let pageToken;
  const seenTokens = new Set();
  let pageCount = 0;
  do {
    if (++pageCount > 50) throw new Error('Google Calendar 페이지 50개 초과');
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Google Calendar 조회 실패 (HTTP ${response.status})`);
    const data = await response.json();
    if (!Array.isArray(data.items)) throw new Error('Google Calendar 응답 items가 배열이 아님');
    items.push(...data.items);
    pageToken = data.nextPageToken;
    if (pageToken && seenTokens.has(pageToken)) throw new Error('Google Calendar pageToken 반복');
    if (pageToken) seenTokens.add(pageToken);
  } while (pageToken);
  return items;
}

export async function listSelectedCalendars({ token, fetchImpl = fetch }) {
  const items = await getPages('/users/me/calendarList', { token, fetchImpl });
  return items.filter((item) => item.selected === true).map(({ id, summary, primary }) => ({ id, summary, primary: primary === true }));
}

export function normalizeEvent(raw, calendarSummary) {
  const allDay = !!raw.start?.date;
  return {
    calendar: calendarSummary,
    title: raw.summary || '(제목 없음)',
    start: raw.start?.dateTime ?? raw.start?.date ?? null,
    end: raw.end?.dateTime ?? raw.end?.date ?? null,
    allDay,
    location: raw.location || null,
  };
}

const kstTime = (value) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const oneLine = (value) => String(value).replace(/[\r\n\u2028\u2029]+/g, ' ');

export function formatEventLine(ev) {
  const startDay = new Date(Date.parse(ev.start) + 9 * 3_600_000).toISOString().slice(0, 10);
  const endDay = ev.end ? new Date(Date.parse(ev.end) + 9 * 3_600_000).toISOString().slice(0, 10) : startDay;
  const endLabel = endDay > startDay ? `(다음날) ${kstTime(ev.end)}` : kstTime(ev.end);
  const when = ev.allDay ? '종일' : `${kstTime(ev.start)}–${endLabel}`;
  return `- ${when} ${oneLine(ev.title || '(제목 없음)')}${ev.location ? ` (${oneLine(ev.location)})` : ''} · ${oneLine(ev.calendar)}`;
}

export async function listEventsForKstDay(date, { token, fetchImpl = fetch, calendars } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error(`날짜 형식 오류: ${date}`);
  // UTC ISO로 하루 뒤 KST 날짜를 만들면 15:00 UTC 경계에서 전날이 되므로 KST로 환산한다.
  const nextKst = new Date(Date.parse(`${date}T00:00:00+09:00`) + 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10);
  const selected = calendars ?? await listSelectedCalendars({ token, fetchImpl });
  const events = [];
  for (const calendar of selected) {
    const items = await getPages(`/calendars/${encodeURIComponent(calendar.id)}/events`, {
      token, fetchImpl,
      params: { timeMin: `${date}T00:00:00+09:00`, timeMax: `${nextKst}T00:00:00+09:00`, singleEvents: 'true', orderBy: 'startTime' },
    });
    events.push(...items.filter((item) => item.status !== 'cancelled').map((item) => normalizeEvent(item, calendar.summary)));
  }
  return events.sort((a, b) => Number(b.allDay) - Number(a.allDay) || Date.parse(a.start) - Date.parse(b.start) || String(a.start).localeCompare(String(b.start)));
}
