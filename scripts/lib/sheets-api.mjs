import { fetchRetry } from './fetch-retry.mjs';

export const SHEET_ID = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
export const ACCOUNTS = ['위탁', '연금저축', 'ISA', 'IRP'];
const API = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

export async function getRange(token, range) {
  const res = await fetchRetry(`${API}/values/${encodeURIComponent(range)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`범위 조회 실패 (${range}): ${await res.text()}`);
  return (await res.json()).values || [];
}

// 표시형식과 무관하게 원본값을 읽는다(UNFORMATTED_VALUE). 날짜=직렬수, 숫자=수.
export async function getRangeRaw(token, range) {
  const res = await fetchRetry(`${API}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`원본 범위 조회 실패 (${range}): ${await res.text()}`);
  return (await res.json()).values || [];
}

export async function appendValues(token, range, values) {
  const res = await fetchRetry(
    `${API}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) throw new Error(`append 실패 (${range}): ${await res.text()}`);
  return res.json();
}

export async function updateCell(token, range, value) {
  const res = await fetchRetry(
    `${API}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[value]] }),
    }
  );
  if (!res.ok) throw new Error(`셀 업데이트 실패 (${range}): ${await res.text()}`);
}

export async function setValues(token, range, values) {
  const res = await fetchRetry(
    `${API}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) throw new Error(`범위 쓰기 실패 (${range}): ${await res.text()}`);
}

export async function clearValues(token, range) {
  const res = await fetchRetry(`${API}/values/${encodeURIComponent(range)}:clear`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`범위 비우기 실패 (${range}): ${await res.text()}`);
}

async function listSheetTitles(token) {
  const res = await fetchRetry(`${API}?fields=sheets.properties.title`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`시트 목록 조회 실패: ${await res.text()}`);
  return ((await res.json()).sheets || []).map(s => s.properties.title);
}

export async function getSheetIdByTitle(token, title) {
  const res = await fetchRetry(`${API}?fields=sheets.properties(sheetId,title)`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`시트 ID 조회 실패: ${await res.text()}`);
  const s = ((await res.json()).sheets || []).find(x => x.properties.title === title);
  return s ? s.properties.sheetId : null;
}

// 지정 행 범위(1-based, 양끝 포함)의 A열 배경을 흰색으로 리셋.
// append(INSERT_ROWS)가 위 행 서식을 상속하므로 '처리완료(초록)' 상속 방지용.
export async function clearColumnABackground(token, title, startRow1, endRow1) {
  const sheetId = await getSheetIdByTitle(token, title);
  if (sheetId == null) throw new Error(`시트 없음: ${title}`);
  const res = await fetchRetry(`${API}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{
      repeatCell: {
        range: { sheetId, startRowIndex: startRow1 - 1, endRowIndex: endRow1, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    }] }),
  });
  if (!res.ok) throw new Error(`배경 리셋 실패 (${title} A${startRow1}:A${endRow1}): ${await res.text()}`);
}

export async function ensureSheet(token, title, header) {
  const titles = await listSheetTitles(token);
  if (titles.includes(title)) return false;
  const res = await fetchRetry(`${API}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
  if (!res.ok) throw new Error(`탭 생성 실패 (${title}): ${await res.text()}`);
  if (header) await appendValues(token, `${title}!A1`, [header]);
  console.log(`   🆕 탭 생성: ${title}`);
  return true;
}

// 보유종목 읽기 (4계좌) → 티커 기준 dedupe
// 계좌 시트 A2:I: [자산군(병합), 종목명, 평균단가, 수량, 투자금, ...]
export async function readHoldings(token) {
  const map = new Map();
  for (const acct of ACCOUNTS) {
    const rows = await getRange(token, `${acct}!A2:I`);
    let lastType = '';
    for (const r of rows) {
      const t = String(r[0] ?? '').trim();
      if (t) lastType = t;
      const name = String(r[1] ?? '').trim();
      if (!name) continue;
      const qty = parseFloat(String(r[3] ?? '').replace(/[,%]/g, '')) || 0;
      const invest = parseFloat(String(r[4] ?? '').replace(/[,%]/g, '')) || 0;
      if (qty <= 0 && invest <= 0) continue;
      const key = name;
      if (!map.has(key)) {
        map.set(key, { name, ticker: '', market: lastType.includes('해외') || lastType.includes('미국') ? 'US' : 'KR', accounts: [], type: lastType });
      }
      map.get(key).accounts.push({ acct, type: lastType, qty, invest });
    }
  }
  // 가드: 실계좌엔 보유 종목이 항상 존재하므로 4계좌 합산 0건 = 시트 읽기 이상(부분/빈 응답).
  // 조용한 빈 배열은 하류(risk-monitor 프루닝·journal-sync 청산 마킹·weekly-report)를
  // "전량 매도"로 오판시킨다 — throw로 잡 실패를 표면화(하트비트 FAIL → 기존 알림 경로).
  if (map.size === 0) throw new Error('보유종목 0건 — 전 계좌 빈 응답(읽기 이상 의심), 안전을 위해 중단');
  return [...map.values()];
}

export function nowKST() {
  return new Date(Date.now() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
}
export function todayKST() {
  return nowKST().slice(0, 10);
}
