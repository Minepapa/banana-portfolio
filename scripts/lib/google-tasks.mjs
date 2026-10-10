const API = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';

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
