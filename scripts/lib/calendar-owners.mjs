// 캘린더 소유자 대응표는 표 순서가 표시 순서다.
export function parseCalendarOwners(markdown) {
  const lines = String(markdown).split(/\r?\n/).map((line) => line.trim());
  const header = lines.findIndex((line) => /^\|\s*캘린더 ID\s*\|\s*소유자\s*\|\s*위키\s*\|$/.test(line));
  if (header < 0 || !/^\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|$/.test(lines[header + 1] ?? '')) {
    throw new Error('캘린더 소유자 표 형식 오류');
  }
  const owners = [];
  for (const [offset, line] of lines.slice(header + 2).entries()) {
    if (!line.startsWith('|')) {
      if (!line && lines.slice(header + 3 + offset).find((next) => next)?.startsWith('|')) {
        throw new Error('캘린더 소유자 표 중간에 빈 행이 있음');
      }
      if (line.includes('|')) throw new Error('캘린더 소유자 표 행 형식 오류');
      break;
    }
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 3 || !cells[0] || !cells[1] || !cells[2]) throw new Error('캘린더 소유자 표 빈 행 또는 형식 오류');
    owners.push({ calendarId: cells[0], owner: cells[1] });
  }
  if (!owners.length) throw new Error('캘린더 소유자 표에 데이터가 없음');
  if (new Set(owners.map(({ calendarId }) => calendarId)).size !== owners.length) throw new Error('캘린더 ID 중복');
  return owners;
}

export function groupEventsByOwner(events, owners) {
  const ownerOrder = [...new Set(owners.map(({ owner }) => owner))];
  const calendarOwners = new Map(owners.map(({ calendarId, owner }) => [calendarId, owner]));
  const orderedEvents = events.map((event, index) => ({ event, index })).sort((a, b) => {
    const rank = ({ event }) => owners.findIndex(({ calendarId }) => calendarId === event.calendarId);
    const aRank = rank(a);
    const bRank = rank(b);
    return (aRank < 0 ? owners.length : aRank) - (bRank < 0 ? owners.length : bRank);
  });
  const groups = new Map([...ownerOrder, '기타'].map((owner) => [owner, []]));
  const seen = new Map();
  const included = new Map();
  for (const { event, index } of orderedEvents) {
    const owner = calendarOwners.get(event.calendarId) ?? '기타';
    // 반복 일정은 회차마다 iCalUID가 같다(singleEvents) — 시작 시각까지 묶어야 같은 날 여러 회차가 사라지지 않는다.
    const uid = event.iCalUID ? `${event.iCalUID}|${event.start ?? ''}` : null;
    if (uid && seen.has(uid)) {
      const first = seen.get(uid);
      if (owner !== first.owner && !first.event.sharedWith?.includes(owner)) {
        first.event.sharedWith = [...(first.event.sharedWith ?? []), owner];
      }
      continue;
    }
    const copy = { ...event, owner };
    included.set(index, copy);
    if (uid) seen.set(uid, { owner, event: copy });
  }
  // 대표 UID는 표 순서로 고르되, 각 소유자 안에서는 원래 일정 시간순을 지킨다.
  for (const [index, event] of events.entries()) {
    const copy = included.get(index);
    if (copy) groups.get(calendarOwners.get(event.calendarId) ?? '기타').push(copy);
  }
  return [...groups].filter(([, ownerEvents]) => ownerEvents.length).map(([owner, ownerEvents]) => ({ owner, events: ownerEvents }));
}
