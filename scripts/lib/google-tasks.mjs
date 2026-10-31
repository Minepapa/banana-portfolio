const BASE = 'https://tasks.googleapis.com/tasks/v1';
const API = `${BASE}/lists/@default/tasks`;
// 목록·할 일을 끝까지 넘겨 읽되, 응답이 계속 다음 쪽을 주더라도 이 쪽 수에서 멈추고 실패한다(무한 반복 방지).
const MAX_PAGES = 20;

export async function insertTask({ token, title, notes, due }, { fetchImpl = fetch } = {}) {
  const body = { title };
  if (notes !== undefined) body.notes = notes;
  if (due !== undefined) body.due = `${due}T00:00:00.000Z`;
  const response = await fetchImpl(API, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Google Tasks 등록 실패 (HTTP ${response.status})`);
  return response.json();
}

export async function deleteTask({ token, id }, { fetchImpl = fetch } = {}) {
  if (typeof id !== 'string' || !id) throw new Error('할 일 ID 필요');
  const response = await fetchImpl(`${API}/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Google Tasks 삭제 실패 (HTTP ${response.status})`);
}

async function getPages(url, token, fetchImpl, what) {
  const items = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const pageUrl = new URL(url);
    if (pageToken) pageUrl.searchParams.set('pageToken', pageToken);
    const response = await fetchImpl(pageUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Google Tasks ${what} 조회 실패 (HTTP ${response.status})`);
    const data = await response.json();
    items.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) return items;
  }
  throw new Error(`Google Tasks ${what} 조회가 ${MAX_PAGES}쪽을 넘음`);
}

export async function listTaskLists({ token }, { fetchImpl = fetch } = {}) {
  return getPages(`${BASE}/users/@me/lists?maxResults=100`, token, fetchImpl, '목록');
}

// 열린 할 일만(완료·숨김 제외). 하위 할 일도 같이 온다(parent로 구분). Docs·Chat에서 배정받은 할 일(showAssigned)은
// 오너가 Tasks 앱에서 직접 관리하는 목록이 아니라 기본값대로 뺀다.
export async function listOpenTasks({ token, listId }, { fetchImpl = fetch } = {}) {
  if (typeof listId !== 'string' || !listId) throw new Error('목록 ID 필요');
  return getPages(`${BASE}/lists/${encodeURIComponent(listId)}/tasks?maxResults=100&showCompleted=false&showHidden=false`,
    token, fetchImpl, '할 일');
}
