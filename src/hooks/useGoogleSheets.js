// 구글 시트 인증·읽기·쓰기 훅. App.jsx에서 추출 (동작 불변).
// gapi/GSI 동적 로드, OAuth 토큰, batchGet 동기화, 행 추가/수정/삭제 API를 한데 캡슐화.
import { useState, useEffect, useCallback, useRef } from "react";
import { SHEET_RANGES } from '../lib/constants.js';
import { parseSheetData } from '../lib/parseSheetData.js';

// ── 구글 시트 설정 ─────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
const SHEET_ID = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';
export const CONFIGURED = !GOOGLE_CLIENT_ID.startsWith('YOUR_') && !SHEET_ID.startsWith('YOUR_');

// ── 토큰 영속화 (PWA 로그인 유지) ──────────────────────────────────────────────
// GSI implicit flow 는 access token(만료 ~1h)만 주고 refresh token 을 안 준다.
// 토큰을 메모리에만 두면 앱 최소화·뒤로가기로 페이지가 리로드될 때 휘발 → "로그아웃"처럼 보임.
// access token + 만료시각을 localStorage 에 저장해 리로드·복귀 시 복원하고,
// 만료 임박/만료 시 무팝업(prompt:'') 재발급으로 사실상 로그인 유지.
const TOKEN_KEY = 'banana_gtoken';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;   // 만료 5분 전이면 갱신 대상

function saveToken(resp) {
  try {
    const expiry = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ access_token: resp.access_token, expiry }));
  } catch { /* localStorage 불가(프라이빗 모드 등) — 메모리만 사용 */ }
}
function loadToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    return t && t.access_token && t.expiry ? t : null;
  } catch { return null; }
}
function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* noop */ }
}

// ── 구글 스크립트 동적 로더 ───────────────────────────────────────────────────
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

export function useGoogleSheets(onData) {
  const [auth, setAuth] = useState('idle');
  const [sync, setSync] = useState('idle');
  const [lastSync, setLastSync] = useState(null);
  const lastSyncRef = useRef(null);
  const [tc, setTc] = useState(null);
  const tcRef = useRef(null);              // 콜백 의존 없는 토큰 클라이언트 참조(401 갱신용)
  const onDataRef = useRef(onData);
  useEffect(() => { onDataRef.current = onData; });

  const doFetch = useCallback(async () => {
    setSync('syncing');
    try {
      const resp = await window.gapi.client.sheets.spreadsheets.values.batchGet({
        spreadsheetId: SHEET_ID,
        ranges: Object.values(SHEET_RANGES),
      });
      const parsed = parseSheetData(resp.result.valueRanges);
      if (parsed) {
        onDataRef.current({
          accounts: parsed.accounts,
          monthly: parsed.monthly,
          monthlyRow: parsed.monthlyRow,
          dividends: parsed.dividends,
          profits: parsed.profits,
          evaluations: parsed.evaluations,
          evalQueue: parsed.evalQueue,
          weeklyReports: parsed.weeklyReports,
          riskMonitor: parsed.riskMonitor,
          baselines: parsed.baselines,
          positionJournal: parsed.positionJournal,
          usdRate: parsed.usdRate,
          preferences: parsed.preferences,
        });
      }
      const now = new Date();
      lastSyncRef.current = now;
      setLastSync(now);
      setSync('synced');
    } catch (e) {
      // 토큰 만료(401) → 무팝업 갱신 시도. 성공 시 콜백이 doFetch 를 다시 부른다.
      const code = e?.status ?? e?.result?.error?.code;
      if (code === 401 && tcRef.current) {
        tcRef.current.requestAccessToken({ prompt: '' });
        return;
      }
      console.error('Sheets fetch error:', e);
      setSync('error');
    }
  }, []);

  useEffect(() => {
    if (!CONFIGURED) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAuth('loading');
    Promise.all([
      loadScript('https://apis.google.com/js/api.js'),
      loadScript('https://accounts.google.com/gsi/client'),
    ]).then(() => {
      window.gapi.load('client', async () => {
        try {
          await window.gapi.client.init({
            discoveryDocs: ['https://sheets.googleapis.com/$discovery/rest?version=v4'],
          });
          const tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope: SCOPES,
            callback: async (resp) => {
              if (resp.error) {
                // 무팝업 갱신(prompt:'') 실패 시 토큰이 이미 있으면 유지, 없으면 로그인 필요 상태로.
                if (!window.gapi.client.getToken()) setAuth('signed-out');
                return;
              }
              saveToken(resp);
              setAuth('signed-in');
              await doFetch();
            },
          });
          setTc(tokenClient);
          tcRef.current = tokenClient;

          // 저장된 토큰 복원 — 리로드·PWA 복귀 시 재로그인 없이 이어가기.
          const saved = loadToken();
          if (saved && saved.expiry - Date.now() > REFRESH_MARGIN_MS) {
            window.gapi.client.setToken({ access_token: saved.access_token });
            setAuth('signed-in');
            await doFetch();
          } else if (saved) {
            // 토큰이 있었으나 만료/임박 → 무팝업 재발급 시도(기존 구글 세션 이용).
            setAuth('signed-in');               // 깜빡임 방지: 일단 유지, 실패 시 콜백이 내림
            tokenClient.requestAccessToken({ prompt: '' });
          } else {
            setAuth('signed-out');
          }
        } catch (e) {
          console.error('Google init error:', e);
          setAuth('error');
        }
      });
    }).catch(() => setAuth('error'));
  }, [doFetch]);

  const signIn = useCallback(() => {
    if (tc) tc.requestAccessToken({ prompt: '' });
  }, [tc]);

  const signOut = useCallback(() => {
    const token = window.gapi?.client?.getToken?.();
    if (token) {
      window.google.accounts.oauth2.revoke(token.access_token);
      window.gapi.client.setToken(null);
    }
    clearToken();                 // 명시적 로그아웃에서만 저장 토큰 제거
    setAuth('signed-out');
    setSync('idle');
    setLastSync(null);
  }, []);

  // PWA 포그라운드 복귀 시 토큰 만료 임박이면 무팝업 갱신 — "최소화 후 복귀 = 로그아웃" 방지.
  useEffect(() => {
    if (!tc) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const saved = loadToken();
      if (!saved) return;                                    // 로그인한 적 없음
      if (saved.expiry - Date.now() <= REFRESH_MARGIN_MS) {  // 만료 임박/만료 → 조용히 갱신
        tc.requestAccessToken({ prompt: '' });
      } else if (!window.gapi?.client?.getToken()) {         // 토큰은 유효한데 메모리만 비었으면 복원
        window.gapi.client.setToken({ access_token: saved.access_token });
        setAuth('signed-in');
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [tc]);

  const appendRow = useCallback(async (range, rowData) => {
    await window.gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [rowData] },
    });
    await doFetch();
  }, [doFetch]);

  const clearRows = useCallback(async (ranges) => {
    await window.gapi.client.sheets.spreadsheets.values.batchClear({
      spreadsheetId: SHEET_ID,
      resource: { ranges },
    });
    await doFetch();
  }, [doFetch]);

  const readRange = useCallback(async (range, renderOption) => {
    const resp = await window.gapi.client.sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
      ...(renderOption ? { valueRenderOption: renderOption } : {}),
    });
    return resp.result.values ?? [];
  }, []);

  const writeRange = useCallback(async (range, rowData) => {
    await window.gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [rowData] },
    });
  }, []);

  const writeRangeMulti = useCallback(async (range, rows) => {
    await window.gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: rows },
    });
  }, []);

  // 진짜 append (시트 끝에 새 행 추가) — values.append API
  const appendValues = useCallback(async (range, rows) => {
    await window.gapi.client.sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: rows },
    });
    await doFetch();
  }, [doFetch]);

  const insertRowAfter = useCallback(async (sheetName, startIndex) => {
    const meta = await window.gapi.client.sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: 'sheets.properties',
    });
    const sheet = meta.result.sheets.find(s => s.properties.title === sheetName);
    if (!sheet) throw new Error(`Sheet ${sheetName} not found`);
    await window.gapi.client.sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [{
          insertDimension: {
            range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex, endIndex: startIndex + 1 },
            inheritFromBefore: true,
          }
        }]
      }
    });
  }, []);

  const clearRowsRaw = useCallback(async (ranges) => {
    await window.gapi.client.sheets.spreadsheets.values.batchClear({
      spreadsheetId: SHEET_ID,
      resource: { ranges },
    });
  }, []);

  const getSheetId = useCallback(async (sheetName) => {
    const meta = await window.gapi.client.sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: 'sheets.properties',
    });
    const sheet = meta.result.sheets.find(s => s.properties.title === sheetName);
    return sheet?.properties?.sheetId ?? null;
  }, []);

  const readTradeProcessedFlags = useCallback(async () => {
    const resp = await window.gapi.client.sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      ranges: ['체결내역!A2:A200'],
      includeGridData: true,
      fields: 'sheets.data.rowData.values.userEnteredFormat.backgroundColor',
    });
    const rows = resp.result.sheets?.[0]?.data?.[0]?.rowData ?? [];
    return rows.map(r => {
      const bg = r?.values?.[0]?.userEnteredFormat?.backgroundColor;
      if (!bg) return false;
      return (bg.green ?? 0) > 0.5 && (bg.red ?? 1) < 0.5;
    });
  }, []);

  const markTradeProcessed = useCallback(async (sheetId, rowIndex) => {
    await window.gapi.client.sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [{
          repeatCell: {
            range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: 1 },
            cell: { userEnteredFormat: { backgroundColor: { red: 0.204, green: 0.659, blue: 0.325 } } },
            fields: 'userEnteredFormat.backgroundColor',
          },
        }],
      },
    });
  }, []);

  return { auth, sync, lastSync, lastSyncRef, signIn, signOut, fetch: doFetch, appendRow, appendValues, clearRows, clearRowsRaw, readRange, writeRange, writeRangeMulti, insertRowAfter, getSheetId, readTradeProcessedFlags, markTradeProcessed };
}
