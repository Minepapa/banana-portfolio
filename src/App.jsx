import { useState, useEffect, useCallback, useRef } from "react";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from "recharts";

// ── 구글 시트 설정 ─────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
const SHEET_ID = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';
const CONFIGURED = !GOOGLE_CLIENT_ID.startsWith('YOUR_') && !SHEET_ID.startsWith('YOUR_');

const SHEET_RANGES = {
  ISA:          'ISA!A2:I',            // 0
  위탁:         '위탁!A2:I',           // 1
  연금저축:     '연금저축!A2:I',       // 2
  IRP:          'IRP!A2:I',            // 3
  위탁리밸:     '자산분배!B3:D9',      // 4  목표+현재+리밸 한 범위로 (row 2 = 계좌 레이블)
  연금저축리밸: '자산분배!B12:D18',    // 5
  ISA리밸:      '자산분배!B21:D21',    // 6
  IRP리밸:      '자산분배!B24:D24',    // 7
  월별잔고:     '월별잔고!A2:H',       // 8
  배당금:       '배당금!A2:B',         // 9
  수익금:       '수익금!A2:F',         // 10
};

const REBAL_TARGET_START = { ISA: 21, 위탁: 3, 연금저축: 12, IRP: 24 };

// 한국 주식 색상 체계: 이익=빨강, 손실=파랑
const PROFIT_POS = '#EF4444';
const PROFIT_NEG = '#60A5FA';

// ── 색상 팔레트 ───────────────────────────────────────────────────────────────
const COLORS = {
  채권: "#4A90D9", 금: "#F5C842", 달러: "#7EC8A4", 배당주: "#F4845F",
  리츠: "#B07FE8", 국내주식: "#E85F7A", 해외주식: "#52C8D4", TDF: "#A8D672",
};

// ── 기본 데이터 ───────────────────────────────────────────────────────────────
const DEFAULT_ACCOUNTS = {
  ISA: {
    label: "ISA", sub: "NH · 배당포트",
    total_invest: 0, total_eval: 0, profit: 0, color: "#F4845F",
    assets: [{ name: "배당주", ratio: 0, invest: 0, eval: 0, target: 0 }],
    holdings: [],
  },
  위탁: {
    label: "위탁+기타", sub: "NH · 수비형포트",
    total_invest: 0, total_eval: 0, profit: 0, color: "#52C8D4",
    assets: [
      { name: "채권",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "금",      ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "달러",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "배당주",  ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "리츠",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "국내주식", ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "해외주식", ratio: 0, invest: 0, eval: 0, target: 0 },
    ],
    holdings: [],
  },
  연금저축: {
    label: "연금저축", sub: "삼성 · 공격형포트",
    total_invest: 0, total_eval: 0, profit: 0, color: "#B07FE8",
    assets: [
      { name: "채권",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "금",      ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "달러",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "배당주",  ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "리츠",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "국내주식", ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "해외주식", ratio: 0, invest: 0, eval: 0, target: 0 },
    ],
    holdings: [],
  },
  IRP: {
    label: "IRP", sub: "한투 · TDF",
    total_invest: 0, total_eval: 0, profit: 0, color: "#A8D672",
    assets: [{ name: "TDF", ratio: 0, invest: 0, eval: 0, target: 0 }],
    holdings: [],
  },
};

// ── 반응형 훅 ─────────────────────────────────────────────────────────────────
function useIsMobile(bp = 640) {
  const [m, setM] = useState(() => window.innerWidth < bp);
  useEffect(() => {
    const h = () => setM(window.innerWidth < bp);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, [bp]);
  return m;
}

// ── 유틸 함수 ─────────────────────────────────────────────────────────────────
const fmt = (n) => {
  if (n == null) return '-';
  return Math.round(Math.abs(n)).toLocaleString('ko-KR');
};

// ── 구글 스크립트 동적 로더 ───────────────────────────────────────────────────
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

// ── 파싱 함수들 ───────────────────────────────────────────────────────────────
function parseNum(v) {
  return parseFloat(String(v ?? 0).replace(/,/g, '')) || 0;
}

function computeAssets(holdings, totalEval, defaultAssets) {
  const byType = {};
  holdings.forEach(h => {
    if (!h.type) return;
    if (!byType[h.type]) byType[h.type] = { invest: 0, eval: 0 };
    byType[h.type].invest += h.invest;
    byType[h.type].eval += h.eval;
  });
  return defaultAssets.map(a => {
    const t = byType[a.name];
    return {
      ...a,
      invest: t?.invest ?? a.invest,
      eval: t?.eval ?? a.eval,
      ratio: totalEval > 0 ? Math.round((t?.eval ?? 0) / totalEval * 100) : a.ratio,
    };
  });
}

function parseMonthly(vr) {
  const rows = vr?.values ?? [];
  let lastYear = 0;
  const result = [];
  rows.forEach(r => {
    // B열(index 0): 연도 — 숫자만 추출하므로 "2024", "2024년", "2,024" 모두 처리
    const bNum = parseInt(String(r[0] ?? '').replace(/[^0-9]/g, ''));
    if (bNum >= 2000) lastYear = bNum;

    // C열(index 1): 월 — 숫자만 추출하므로 "1", "1월", "01" 모두 처리
    const month = parseInt(String(r[1] ?? '').replace(/[^0-9]/g, ''));

    // I열(index 7 in B:I 범위): 총잔고
    const total = parseNum(r[7]);

    if (!total || !month || !lastYear) return;
    const yearShort = String(lastYear).slice(-2);
    const savings = parseNum(r[2]);
    result.push({ label: `${yearShort}.${String(month).padStart(2, '0')}`, value: total, savings, year: lastYear });
  });
  return result;
}

function findMonthlyRow(vr) {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const rows = vr?.values ?? [];
  let lastYear = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const bNum = parseInt(String(r[0] ?? '').replace(/[^0-9]/g, ''));
    if (bNum >= 2000) lastYear = bNum;
    const mNum = parseInt(String(r[1] ?? '').replace(/[^0-9]/g, ''));
    if (lastYear === year && mNum === month) return 2 + i;
  }
  return null;
}

function parseDividends(vrAll) {
  const result = {};
  (vrAll?.values ?? []).forEach(r => {
    const dateStr = String(r[0] ?? '').trim();
    const amt = parseNum(r[1]);  // B열: 배당금
    if (!dateStr || !amt) return;
    const parts = dateStr.split('-');
    if (parts.length < 2) return;
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    if (!year || !month) return;
    const key = `${year}-${month}`;
    if (!result[key]) result[key] = { year, month, amount: 0 };
    result[key].amount += amt;
  });
  return Object.values(result).sort((a, b) => a.year - b.year || a.month - b.month);
}

function parseProfits(vr) {
  const result = {};
  (vr?.values ?? []).forEach(r => {
    const dateStr = String(r[0] ?? '').trim();
    const name    = String(r[1] ?? '').trim();
    const profit  = parseNum(r[5]); // F열: 수익금
    if (!dateStr) return;
    const parts = dateStr.split('-');
    if (parts.length < 2) return;
    const year  = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    if (!year || !month) return;
    const key = `${year}-${month}`;
    if (!result[key]) result[key] = { year, month, total: 0, items: [] };
    result[key].total += profit;
    if (name) result[key].items.push({ date: dateStr, name, profit });
  });
  return Object.values(result).sort((a, b) => a.year - b.year || a.month - b.month);
}

function parseSheetData(valueRanges) {
  // indices: ISA(0) 위탁(1) 연금저축(2) IRP(3)
  //          위탁리밸(4) 연금저축리밸(5) ISA리밸(6) IRP리밸(7)
  //          월별잔고(8) 배당금(9)
  const accountKeys = ['ISA', '위탁', '연금저축', 'IRP'];
  const result = {};
  let anyData = false;

  accountKeys.forEach((key, i) => {
    const allRows = valueRanges[i]?.values ?? [];
    let lastType = '';
    const holdings = [];
    allRows.forEach((r, rowOffset) => {
      if (!r[1]) return;
      const type = String(r[0] ?? '').trim();
      if (type) lastType = type;
      holdings.push({
        name: String(r[1] ?? ''),
        price: parseNum(r[2]),
        qty: parseNum(r[3]),
        invest: parseNum(r[4]),
        currentPrice: parseNum(r[5]),
        eval: parseNum(r[7]),
        profit: parseNum(r[6]),
        rate: parseNum(r[8]),
        type: lastType,
        rowOffset,
      });
    });
    if (!holdings.length) return;
    anyData = true;

    const total_invest = holdings.reduce((s, h) => s + h.invest, 0);
    const total_eval = holdings.reduce((s, h) => s + h.eval, 0);

    result[key] = {
      ...DEFAULT_ACCOUNTS[key],
      total_invest,
      total_eval,
      profit: total_eval - total_invest,
      holdings,
      assets: computeAssets(holdings, total_eval, DEFAULT_ACCOUNTS[key].assets),
    };
  });

  // 리밸런싱: 각 계좌별 단일 범위 [목표비율(B), 현재비율(C), 리밸런싱금액(D)]
  const parseRebalRows = (vr) => {
    const rows = vr?.values ?? [];
    return {
      targets:  rows.map(r => parseNum(r[0])),
      currents: rows.map(r => parseNum(r[1])),
      rebals:   rows.map(r => parseNum(r[2])),
    };
  };

  if (result['위탁']) {
    const { targets, currents, rebals } = parseRebalRows(valueRanges[4]);
    result['위탁'].assets = result['위탁'].assets.map((a, i) => ({
      ...a,
      target: targets[i] ?? a.target,
      sheetCurrent: currents[i] ?? 0,
      rebalAmt: rebals[i] ?? 0,
    }));
  }

  if (result['연금저축']) {
    const { targets, currents, rebals } = parseRebalRows(valueRanges[5]);
    result['연금저축'].assets = result['연금저축'].assets.map((a, i) => ({
      ...a,
      target: targets[i] ?? a.target,
      sheetCurrent: currents[i] ?? 0,
      rebalAmt: rebals[i] ?? 0,
    }));
  }

  if (result['ISA']) {
    const { targets, currents, rebals } = parseRebalRows(valueRanges[6]);
    result['ISA'].assets = result['ISA'].assets.map((a, i) => ({
      ...a,
      target: i === 0 ? (targets[0] ?? a.target) : a.target,
      sheetCurrent: i === 0 ? (currents[0] ?? 0) : 0,
      rebalAmt: i === 0 ? (rebals[0] ?? 0) : 0,
    }));
  }

  if (result['IRP']) {
    const { targets, currents, rebals } = parseRebalRows(valueRanges[7]);
    result['IRP'].assets = result['IRP'].assets.map((a, i) => ({
      ...a,
      target: i === 0 ? (targets[0] ?? a.target) : a.target,
      sheetCurrent: i === 0 ? (currents[0] ?? 0) : 0,
      rebalAmt: i === 0 ? (rebals[0] ?? 0) : 0,
    }));
  }

  const monthly = parseMonthly(valueRanges[8]);
  const monthlyRow = findMonthlyRow(valueRanges[8]);
  const dividends = parseDividends(valueRanges[9]);
  const profits = parseProfits(valueRanges[10]);

  return anyData ? { accounts: result, monthly, monthlyRow, dividends, profits } : null;
}

// ── useGoogleSheets 훅 ────────────────────────────────────────────────────────
function useGoogleSheets(onData) {
  const [auth, setAuth] = useState('idle');
  const [sync, setSync] = useState('idle');
  const [lastSync, setLastSync] = useState(null);
  const lastSyncRef = useRef(null);
  const [tc, setTc] = useState(null);
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
        });
      }
      const now = new Date();
      lastSyncRef.current = now;
      setLastSync(now);
      setSync('synced');
    } catch (e) {
      console.error('Sheets fetch error:', e);
      setSync('error');
    }
  }, []);

  useEffect(() => {
    if (!CONFIGURED) return;
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
              if (resp.error) { setAuth('error'); return; }
              setAuth('signed-in');
              await doFetch();
            },
          });
          setTc(tokenClient);
          setAuth('signed-out');
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
    setAuth('signed-out');
    setSync('idle');
    setLastSync(null);
  }, []);

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

  return { auth, sync, lastSync, lastSyncRef, signIn, signOut, fetch: doFetch, appendRow, clearRows, clearRowsRaw, readRange, writeRange, writeRangeMulti, insertRowAfter, getSheetId, readTradeProcessedFlags, markTradeProcessed };
}

// ── 종목추가 폼 컴포넌트 ──────────────────────────────────────────────────────
const START_ROWS = { ISA: 2, 위탁: 2, 연금저축: 2, IRP: 2 };

// 계좌별 A:B 읽기 범위 (A=자산군, B=종목명 여부 확인용)
const KL_CFG = {
  ISA:      { range: 'ISA!A2:B60',      start: 2, end: 60 },
  위탁:     { range: '위탁!A2:B60',     start: 2, end: 60 },
  연금저축: { range: '연금저축!A2:B60', start: 2, end: 60 },
  IRP:      { range: 'IRP!A2:B30',      start: 2, end: 30 },
};

function buildRowMap(rows, start, end) {
  let lastType = '';
  const result = [];
  for (let i = 0; i < end - start + 1; i++) {
    const r = rows[i] ?? [];
    const k = String(r[0] ?? '').trim();
    if (k) lastType = k;
    result.push({ row: start + i, type: lastType, empty: !String(r[1] ?? '').trim(), hasA: !!k });
  }
  return result;
}

function AddHoldingForm({ acctKey, accounts, onSave, onCancel, readRange }) {
  const assetNames = accounts[acctKey].assets.map(a => a.name);

  const [자산군, set자산군] = useState(assetNames[0] || '');
  const [종목명, set종목명] = useState('');
  const [티커유형, set티커유형] = useState('국내(GOOGLEFINANCE)');
  const [티커, set티커] = useState('');
  const [현재가수기, set현재가수기] = useState('');
  const [매수단가, set매수단가] = useState('');
  const [수량, set수량] = useState('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [rowMap, setRowMap] = useState(null);

  const loadRowMap = useCallback(() => {
    const cfg = KL_CFG[acctKey];
    if (!cfg) return;
    readRange(cfg.range)
      .then(rows => setRowMap(buildRowMap(rows, cfg.start, cfg.end)))
      .catch(() => setRowMap([]));
  }, [acctKey, readRange]);

  useEffect(() => { setRowMap(null); loadRowMap(); }, [loadRowMap]);

  const hasAInSheet = rowMap ? rowMap.some(r => r.hasA && r.type === 자산군) : null;
  const emptySlots = rowMap ? rowMap.filter(r => r.type === 자산군 && r.empty && r.hasA).length : null;
  const sheetWarning = rowMap !== null && (!hasAInSheet || emptySlots === 0);
  const notReady = rowMap === null || saving || sheetWarning;

  const inputStyle = {
    background: '#0D1520', border: '1px solid #2A2F3E', borderRadius: 6,
    color: '#E8EAF0', padding: '6px 10px', fontSize: 12,
    fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
    width: '100%', boxSizing: 'border-box',
  };
  const labelStyle = { fontSize: 10, color: '#5A6478', marginBottom: 4, display: 'block' };

  const handleSubmit = async () => {
    if (!종목명.trim() || !매수단가 || !수량 || !rowMap || sheetWarning) return;
    // 자산군의 첫 번째 빈 행 찾기
    let targetRow = null;
    for (const r of rowMap) {
      if (r.type === 자산군 && r.empty && r.hasA) { targetRow = r.row; break; }
    }
    if (targetRow === null) return;
    setSaving(true);
    try {
      let 현재가formula = '';
      if (티커유형 === '국내(GOOGLEFINANCE)') 현재가formula = `=GOOGLEFINANCE("${티커}")`;
      else if (티커유형 === '해외(GOOGLEFINANCE)') 현재가formula = `=GOOGLEFINANCE("${티커}")*설정!B2`;
      else if (티커유형 === '네이버') 현재가formula = `=IMPORTXML("https://finance.naver.com/item/main.naver?code=${티커}","//p[@class='no_today']/em/span[1]")`;
      else if (티커유형 === '수기입력') 현재가formula = parseFloat(현재가수기) || 0;
      const n = targetRow;
      const 투자금 = parseFloat(매수단가) * parseFloat(수량);
      await onSave(`${acctKey}!B${n}:I${n}`, [
        종목명, parseFloat(매수단가), parseFloat(수량),
        `=C${n}*D${n}`,
        현재가formula,
        `=H${n}-E${n}`, `=D${n}*F${n}`, `=H${n}/E${n}-1`,
      ], 투자금);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
      set종목명(''); set티커(''); set현재가수기(''); set매수단가(''); set수량('');
      loadRowMap();
    } catch (e) {
      console.error('종목추가 오류:', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      background: '#1A1D26', border: '1px solid #2A2F3E', borderRadius: 12,
      padding: 16, marginBottom: 16,
    }}>
      <div style={{ fontSize: 11, letterSpacing: 2, color: '#5A6478', marginBottom: 12 }}>종목 추가</div>
      {rowMap !== null && sheetWarning && (
        <div style={{
          background: '#2D1A1A', border: '1px solid #7F1D1D', borderRadius: 6,
          padding: '7px 11px', marginBottom: 10, fontSize: 11, color: '#FCA5A5',
        }}>
          ⚠ {!hasAInSheet ? `시트 A열에 '${자산군}' 자산군 없음` : '빈 행 없음 — 시트에 공백 행 추가 필요'}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div>
          <label style={labelStyle}>
            자산군{rowMap !== null && hasAInSheet && (
              <span style={{ marginLeft: 5, color: emptySlots > 0 ? '#6EE7B7' : '#FCA5A5' }}>
                ({emptySlots}개 가능)
              </span>
            )}
          </label>
          <select value={자산군} onChange={e => set자산군(e.target.value)} style={inputStyle}>
            {assetNames.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>종목명</label>
          <input type="text" value={종목명} onChange={e => set종목명(e.target.value)}
            placeholder="예: TIGER 미국나스닥100" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>티커유형</label>
          <select value={티커유형} onChange={e => set티커유형(e.target.value)} style={inputStyle}>
            {['국내(GOOGLEFINANCE)', '해외(GOOGLEFINANCE)', '네이버', '수기입력'].map(o =>
              <option key={o} value={o}>{o}</option>
            )}
          </select>
        </div>
        {티커유형 !== '수기입력' ? (
          <div>
            <label style={labelStyle}>티커</label>
            <input type="text" value={티커} onChange={e => set티커(e.target.value)}
              placeholder="예: KRX:360750" style={inputStyle} />
          </div>
        ) : (
          <div>
            <label style={labelStyle}>현재가</label>
            <input type="number" value={현재가수기} onChange={e => set현재가수기(e.target.value)}
              placeholder="0" style={inputStyle} />
          </div>
        )}
        <div>
          <label style={labelStyle}>매수단가</label>
          <input type="number" value={매수단가} onChange={e => set매수단가(e.target.value)}
            placeholder="0" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>수량</label>
          <input type="number" value={수량} onChange={e => set수량(e.target.value)}
            placeholder="0" style={inputStyle} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{
          padding: '6px 14px', borderRadius: 6, border: '1px solid #2A2F3E',
          background: 'transparent', color: '#6B7280', cursor: 'pointer', fontSize: 11,
          fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
        }}>취소</button>
        <button onClick={handleSubmit} disabled={notReady} style={{
          padding: '6px 14px', borderRadius: 6, border: 'none',
          background: notReady ? '#2A2F3E' : '#3B82F6',
          color: '#fff', cursor: notReady ? 'not-allowed' : 'pointer',
          fontSize: 11, fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
        }}>
          {saving ? '저장 중...' : success ? '저장됨 ✓' : rowMap === null ? '로딩...' : '저장'}
        </button>
      </div>
    </div>
  );
}

// ── 앱 ────────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [acctKey, setAcctKey] = useState("위탁");
  const [accounts, setAccounts] = useState(DEFAULT_ACCOUNTS);
  const [monthlyData, setMonthlyData] = useState([]);
  const [dividendData, setDividendData] = useState([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showDeleteMode, setShowDeleteMode] = useState(false);
  const [selectedToDelete, setSelectedToDelete] = useState(new Set());
  const [editingHolding, setEditingHolding] = useState(null);
  const [editPrice, setEditPrice] = useState('');
  const [editQty, setEditQty] = useState('');
  const [editCurrentPrice, setEditCurrentPrice] = useState('');
  const [editIncludeSavings, setEditIncludeSavings] = useState(false);
  const [editingAllTargets, setEditingAllTargets] = useState(false);
  const [allTargetInputs, setAllTargetInputs] = useState([]);
  const lpRef = useRef(null);
  const [monthlyRow, setMonthlyRow] = useState(null);
  const monthlyRowRef = useRef(null);
  const lastBalanceSyncRef = useRef(null);
  const isBalanceWritingRef = useRef(false);
  const [balanceSyncMsg, setBalanceSyncMsg] = useState('');
  const [prevDayEval, setPrevDayEval] = useState(() => {
    const today = new Date().toISOString().slice(0, 10);
    const history = JSON.parse(localStorage.getItem('banana_eval_history') || '{}');
    const prevDate = Object.keys(history).filter(d => d < today).sort().pop();
    return prevDate ? history[prevDate] : null;
  });
  const [showSavings, setShowSavings] = useState(false);
  const [showSavingsEdit, setShowSavingsEdit] = useState(false);
  const [savingsEditValue, setSavingsEditValue] = useState('');
  const savingsLpRef = useRef(null);
  const savingsLpFiredRef = useRef(false);
  const [divYear, setDivYear] = useState('전체');
  const [monthYear, setMonthYear] = useState('전체');
  const [tradeRows, setTradeRows] = useState([]);
  const [tradeSyncing, setTradeSyncing] = useState(false);
  const [tradeSyncMsg, setTradeSyncMsg] = useState('');
  const [profitData, setProfitData] = useState([]);
  const [profitYear, setProfitYear] = useState('전체');
  const [selectedProfitKey, setSelectedProfitKey] = useState(null);
  const isMobile = useIsMobile();

  const onData = useCallback(({ accounts: a, monthly: m, dividends: d, monthlyRow: mr, profits: p }) => {
    setAccounts(prev => ({ ...prev, ...a }));
    setMonthlyData(m || []);
    setDividendData(d || []);
    setProfitData(p || []);
    monthlyRowRef.current = mr ?? null;
    setMonthlyRow(mr ?? null);
  }, []);

  const sheets = useGoogleSheets(onData);

  const totalEval = Object.values(accounts).reduce((s, a) => s + a.total_eval, 0);

  // 어제 대비 평가금 추적
  useEffect(() => {
    if (sheets.sync !== 'synced' || totalEval === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const history = JSON.parse(localStorage.getItem('banana_eval_history') || '{}');
    const prevDate = Object.keys(history).filter(d => d < today).sort().pop();
    setPrevDayEval(prevDate ? history[prevDate] : null);
    history[today] = totalEval;
    const dates = Object.keys(history).sort();
    while (dates.length > 7) delete history[dates.shift()];
    localStorage.setItem('banana_eval_history', JSON.stringify(history));
  }, [sheets.sync, totalEval]); // eslint-disable-line react-hooks/exhaustive-deps

  // 잔고 자동 동기화 — write 후 re-fetch 하여 월별 그래프도 즉시 갱신
  useEffect(() => {
    if (isBalanceWritingRef.current) return;
    if (sheets.sync !== 'synced' || !sheets.lastSync) return;
    if (lastBalanceSyncRef.current === sheets.lastSync) return;
    lastBalanceSyncRef.current = sheets.lastSync;
    const mr = monthlyRowRef.current;
    if (!mr) {
      setBalanceSyncMsg('이번 달 행 없음');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    isBalanceWritingRef.current = true;
    const _isa = accounts['ISA']?.total_eval ?? 0;
    const _위탁 = accounts['위탁']?.total_eval ?? 0;
    const _연금 = accounts['연금저축']?.total_eval ?? 0;
    const _irp = accounts['IRP']?.total_eval ?? 0;
    sheets.writeRange(`월별잔고!D${mr}:H${mr}`, [
      _isa, _위탁, _연금, _irp, _isa + _위탁 + _연금 + _irp,
    ]).then(async () => {
      await sheets.fetch();
      // fetch 완료 후 lastSyncRef.current = t2 → 다음 effect 실행 시 중복 write 방지
      lastBalanceSyncRef.current = sheets.lastSyncRef.current;
      setBalanceSyncMsg('잔고 동기화됨');
      setTimeout(() => setBalanceSyncMsg(''), 3000);
    }).catch(() => {
      setBalanceSyncMsg('잔고 동기화 실패');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
    }).finally(() => {
      isBalanceWritingRef.current = false;
    });
  }, [sheets.sync, sheets.lastSync, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDeleteSelected = async () => {
    const ranges = [...selectedToDelete].map(idx => {
      const sheetRow = START_ROWS[acctKey] + acct.holdings[idx].rowOffset;
      return `${acctKey}!B${sheetRow}:I${sheetRow}`;
    });
    await sheets.clearRows(ranges);
    setShowDeleteMode(false);
    setSelectedToDelete(new Set());
  };

  const startLP = (origIdx, h) => {
    lpRef.current = setTimeout(async () => {
      const sheetRow = START_ROWS[acctKey] + h.rowOffset;
      let isManual = false;
      try {
        const vals = await sheets.readRange(`${acctKey}!F${sheetRow}`, 'FORMULA');
        const cell = String(vals[0]?.[0] ?? '');
        isManual = cell !== '' && !cell.startsWith('=');
      } catch {}
      setEditingHolding({ origIdx, sheetRow, oldPrice: h.price, oldQty: h.qty, isManual });
      setEditPrice(String(h.price || ''));
      setEditQty(String(h.qty || ''));
      setEditCurrentPrice(String(isManual ? (h.currentPrice || '') : ''));
      setEditIncludeSavings(false);
    }, 1000);
  };

  const endLP = () => {
    if (lpRef.current) { clearTimeout(lpRef.current); lpRef.current = null; }
  };

  const saveEdit = async () => {
    if (!editingHolding) return;
    const { sheetRow, oldPrice, oldQty, isManual } = editingHolding;
    const p = parseFloat(editPrice) || 0;
    const q = parseFloat(editQty) || 0;
    await sheets.appendRow(`${acctKey}!C${sheetRow}:D${sheetRow}`, [p, q]);
    if (isManual && editCurrentPrice !== '') {
      await sheets.writeRange(`${acctKey}!F${sheetRow}`, [parseFloat(editCurrentPrice) || 0]);
    }
    if (editIncludeSavings) {
      const mr = monthlyRowRef.current;
      if (!mr) {
        setBalanceSyncMsg('이번 달 행 없음 — 저축금 미반영');
        setTimeout(() => setBalanceSyncMsg(''), 4000);
      } else {
        try {
          const delta = (p * q) - ((oldPrice || 0) * (oldQty || 0));
          if (delta !== 0) {
            const rows = await sheets.readRange(`월별잔고!C${mr}:C${mr}`);
            const current = parseNum(rows[0]?.[0]);
            await sheets.writeRange(`월별잔고!C${mr}:C${mr}`, [current + delta]);
            setBalanceSyncMsg('저축금 반영됨');
            setTimeout(() => setBalanceSyncMsg(''), 3000);
          }
        } catch {
          setBalanceSyncMsg('저축금 업데이트 실패');
          setTimeout(() => setBalanceSyncMsg(''), 4000);
        }
      }
    }
    setEditingHolding(null);
    setEditIncludeSavings(false);
  };

  const repairFormulas = useCallback(async () => {
    setTradeSyncMsg('수식 복구 중...');
    try {
      for (const key of ['ISA', '위탁', '연금저축', 'IRP']) {
        const rows = await sheets.readRange(`${key}!B2:B60`);
        for (let r = 0; r < rows.length; r++) {
          if (!String(rows[r]?.[0] ?? '').trim()) continue;
          const n = 2 + r;
          await sheets.writeRange(`${key}!E${n}:E${n}`, [`=C${n}*D${n}`]);
          await sheets.writeRange(`${key}!G${n}:G${n}`, [`=H${n}-E${n}`]);
          await sheets.writeRange(`${key}!H${n}:H${n}`, [`=D${n}*F${n}`]);
          await sheets.writeRange(`${key}!I${n}:I${n}`, [`=H${n}/E${n}-1`]);
        }
      }
      setTradeSyncMsg('수식 복구 완료');
      setTimeout(() => setTradeSyncMsg(''), 3000);
      await sheets.fetch();
    } catch (e) {
      console.error('수식 복구 오류:', e);
      setTradeSyncMsg('수식 복구 오류');
      setTimeout(() => setTradeSyncMsg(''), 4000);
    }
  }, [sheets]);

  const addHoldingFromTrade = useCallback(async (acctKey, assetType, stockName, price, qty, currentPrice) => {
    const cfg = KL_CFG[acctKey];
    if (!cfg) throw new Error(`알 수 없는 계좌: ${acctKey}`);
    const rows = await sheets.readRange(cfg.range);
    const rowMap = buildRowMap(rows, cfg.start, cfg.end);
    let targetRow = null;
    for (const r of rowMap) {
      if (r.type === assetType && r.empty && r.hasA) { targetRow = r.row; break; }
    }
    if (targetRow === null) throw new Error(`${acctKey} > ${assetType}: 빈 행 없음`);
    const n = targetRow;
    await sheets.writeRange(`${acctKey}!B${n}:I${n}`, [
      stockName, price, qty,
      `=C${n}*D${n}`,
      currentPrice,
      `=H${n}-E${n}`,
      `=D${n}*F${n}`,
      `=H${n}/E${n}-1`,
    ]);
  }, [sheets]);

  const syncTradeExecutions = useCallback(async () => {
    if (tradeSyncing) return;
    setTradeSyncing(true);
    setTradeSyncMsg('동기화 중...');
    try {
      const tradeValues = await sheets.readRange('체결내역!A2:M');
      const tradeJFormulas = await sheets.readRange('체결내역!J2:J', 'FORMULA');
      const flags = await sheets.readTradeProcessedFlags();

      const rowsWithStatus = tradeValues.map((row, i) => ({ row, processed: flags[i] ?? false }));
      setTradeRows(rowsWithStatus);

      const toProcess = rowsWithStatus
        .map(({ row, processed }, i) => ({ row, i, processed }))
        .filter(({ row, processed }) => {
          if (processed) return false;
          if (row.length < 13) return false;
          return row.slice(0, 13).every(cell => String(cell ?? '').trim() !== '');
        });

      if (toProcess.length === 0) {
        setTradeSyncMsg(tradeValues.length > 0 ? '처리할 신규 내역 없음' : '체결내역 없음');
        setTimeout(() => setTradeSyncMsg(''), 3000);
        return;
      }

      const cheolSheetId = await sheets.getSheetId('체결내역');
      let processed = 0;
      const errors = [];

      for (const { row, i } of toProcess) {
        try {
          const buySell   = String(row[1] ?? '').trim(); // B
          const account   = String(row[2] ?? '').trim(); // C
          const assetType = String(row[4] ?? '').trim(); // E
          const stockName = String(row[5] ?? '').trim(); // F
          const price     = parseNum(row[6]);             // G
          const qty       = parseNum(row[7]);             // H
          const jFormula  = String(tradeJFormulas[i]?.[0] ?? '').trim();
          const currentPrice = jFormula.startsWith('=') ? jFormula : parseNum(row[9]); // J (formula or number)

          if (!account || !stockName) continue;

          const acctKey = ['ISA', '위탁', '연금저축', 'IRP'].find(k => account.includes(k));
          if (!acctKey) continue;

          const holdingRows = await sheets.readRange(`${acctKey}!A2:D60`);
          let matchRow = null;
          let lastType = '';
          for (let r = 0; r < holdingRows.length; r++) {
            const hr = holdingRows[r];
            const typeVal = String(hr[0] ?? '').trim();
            if (typeVal) lastType = typeVal;
            if (String(hr[1] ?? '').trim() === stockName) {
              matchRow = { row: 2 + r, type: lastType, price: parseNum(hr[2]), qty: parseNum(hr[3]) };
              break;
            }
          }

          const isBuy  = buySell.includes('매수');
          const isSell = buySell.includes('매도');

          if (isBuy) {
            if (matchRow) {
              const newQty = matchRow.qty + qty;
              const newAvgPrice = newQty > 0
                ? Math.round((matchRow.price * matchRow.qty + price * qty) / newQty)
                : price;
              await sheets.writeRange(`${acctKey}!C${matchRow.row}:D${matchRow.row}`, [newAvgPrice, newQty]);
            } else {
              await addHoldingFromTrade(acctKey, assetType, stockName, price, qty, currentPrice);
            }
          } else if (isSell && matchRow) {
            const newQty = matchRow.qty - qty;
            if (newQty <= 0) {
              await sheets.clearRowsRaw([`${acctKey}!B${matchRow.row}:I${matchRow.row}`]);
            } else {
              await sheets.writeRange(`${acctKey}!D${matchRow.row}`, [newQty]);
            }
          }

          if (cheolSheetId !== null) {
            await sheets.markTradeProcessed(cheolSheetId, i + 1); // row2 → 0-based index 1
          }
          processed++;
        } catch (e) {
          errors.push(String(e?.message ?? e));
        }
      }

      await sheets.fetch();

      const newValues = await sheets.readRange('체결내역!A2:M');
      const newFlags  = await sheets.readTradeProcessedFlags();
      setTradeRows(newValues.map((row, i) => ({ row, processed: newFlags[i] ?? false })));

      setTradeSyncMsg(errors.length > 0
        ? `${processed}건 완료 · ${errors.length}건 오류`
        : `${processed}건 동기화 완료`);
      setTimeout(() => setTradeSyncMsg(''), 5000);
    } catch (e) {
      console.error('체결내역 동기화 오류:', e);
      setTradeSyncMsg('동기화 오류');
      setTimeout(() => setTradeSyncMsg(''), 4000);
    } finally {
      setTradeSyncing(false);
    }
  }, [sheets, tradeSyncing, addHoldingFromTrade]);

  const saveAllTargets = async () => {
    const sum = allTargetInputs.reduce((s, v) => s + (parseFloat(v) || 0), 0);
    if (Math.abs(sum - 100) > 0.1) {
      alert(`합계가 ${sum.toFixed(1)}%입니다. 100%가 되어야 합니다.`);
      return;
    }
    setEditingAllTargets(false);
    const startRow = REBAL_TARGET_START[acctKey];
    await sheets.writeRangeMulti(
      `자산분배!B${startRow}:B${startRow + allTargetInputs.length - 1}`,
      allTargetInputs.map(v => [(parseFloat(v) || 0) / 100])
    );
    await sheets.fetch();
  };

  const startSavingsLP = () => {
    savingsLpFiredRef.current = false;
    savingsLpRef.current = setTimeout(async () => {
      savingsLpFiredRef.current = true;
      const mr = monthlyRowRef.current;
      if (!mr) {
        setBalanceSyncMsg('이번 달 행 없음');
        setTimeout(() => setBalanceSyncMsg(''), 3000);
        return;
      }
      try {
        const rows = await sheets.readRange(`월별잔고!C${mr}:C${mr}`);
        setSavingsEditValue(String(parseNum(rows[0]?.[0]) || ''));
      } catch {
        setSavingsEditValue('');
      }
      setShowSavingsEdit(true);
    }, 1000);
  };

  const endSavingsLP = () => {
    if (savingsLpRef.current) { clearTimeout(savingsLpRef.current); savingsLpRef.current = null; }
  };

  const saveSavingsEdit = async () => {
    const mr = monthlyRowRef.current;
    if (!mr) {
      setBalanceSyncMsg('이번 달 행 없음');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      setShowSavingsEdit(false);
      return;
    }
    try {
      await sheets.writeRange(`월별잔고!C${mr}:C${mr}`, [parseFloat(savingsEditValue) || 0]);
      setBalanceSyncMsg('저축금 저장됨');
      setTimeout(() => setBalanceSyncMsg(''), 3000);
    } catch {
      setBalanceSyncMsg('저축금 저장 실패');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
    }
    setShowSavingsEdit(false);
  };

  useEffect(() => {
    if (tab === '체결내역' && sheets.auth === 'signed-in') {
      syncTradeExecutions();
    }
  }, [tab, sheets.auth]); // eslint-disable-line

  const acct = accounts[acctKey];
  const totalInvest = Object.values(accounts).reduce((s, a) => s + a.total_invest, 0);
  const totalProfit = totalEval - totalInvest;
  const dailyDelta = sheets.auth === 'signed-in' && prevDayEval != null ? totalEval - prevDayEval : null;

  const syncLabel =
    sheets.sync === 'syncing' ? '동기화 중...' :
    sheets.sync === 'error'   ? '동기화 실패' :
    sheets.lastSync           ? `↑ ${sheets.lastSync.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` :
    '';

  const sheetBtnStyle = {
    padding: "3px 8px", borderRadius: 4,
    border: "1px solid #2A2F3E", background: "transparent",
    color: "#9CA3AF", cursor: "pointer",
    fontSize: 10, fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
  };

  const baseFont = "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif";

  // 배당금 탭 필터링
  const filteredDividends = divYear === '전체'
    ? dividendData
    : dividendData.filter(d => String(d.year) === divYear);

  const div2025Total = dividendData.filter(d => d.year === 2025).reduce((s, d) => s + d.amount, 0);
  const div2026Total = dividendData.filter(d => d.year === 2026).reduce((s, d) => s + d.amount, 0);

  return (
    <div style={{
      minHeight: "100vh", background: "#0D0F14", color: "#E8EAF0",
      fontFamily: baseFont, padding: 0,
    }}>
      {/* ── 헤더 ── */}
      <div style={{
        background: "linear-gradient(135deg, #1A1D26 0%, #0D1520 100%)",
        borderBottom: "1px solid #2A2F3E",
        padding: isMobile ? "14px 16px 12px" : "20px 24px 16px",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0, marginRight: 8 }}>
            <div style={{ fontSize: 9, letterSpacing: 3, color: "#5A6478", marginBottom: 4 }}>
              BANANA · 은퇴 준비 포트폴리오
            </div>
            <div style={{ fontSize: isMobile ? 20 : 24, fontWeight: 700, letterSpacing: -1, color: "#F5F7FF" }}>
              ₩{totalEval.toLocaleString()}
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 9, color: "#5A6478", letterSpacing: 2 }}>총 수익</div>
            <div style={{ fontSize: isMobile ? 13 : 15, fontWeight: 700, color: totalProfit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
              {totalProfit >= 0 ? '+' : '-'}₩{fmt(Math.abs(totalProfit))}
            </div>
            {dailyDelta != null && (
              <div style={{ fontSize: 10, color: dailyDelta >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                {dailyDelta >= 0 ? '+' : '-'}₩{fmt(Math.abs(dailyDelta))}
              </div>
            )}
          </div>
        </div>

        {/* 구글 시트 동기화 UI */}
        {CONFIGURED && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {sheets.auth === 'loading' && (
              <span style={{ fontSize: 10, color: "#5A6478" }}>Google 초기화 중...</span>
            )}
            {sheets.auth === 'signed-out' && (
              <button onClick={sheets.signIn}
                style={{ ...sheetBtnStyle, background: "#1E3A5F", color: "#60A5FA", borderColor: "#3B82F6" }}>
                로그인
              </button>
            )}
            {sheets.auth === 'signed-in' && (
              <>
                <span style={{ fontSize: 10, color: sheets.sync === 'error' ? "#F87171" : "#5A6478" }}>
                  {syncLabel}
                </span>
                {balanceSyncMsg && (
                  <span style={{ fontSize: 10, color: balanceSyncMsg.includes('실패') || balanceSyncMsg.includes('없음') ? '#F87171' : '#4ADE80' }}>
                    · {balanceSyncMsg}
                  </span>
                )}
                <button onClick={sheets.fetch} disabled={sheets.sync === 'syncing'}
                  style={sheetBtnStyle} title="시트에서 최신 데이터 가져오기">
                  ↻ 새로고침
                </button>
                <button onClick={sheets.signOut} style={{ ...sheetBtnStyle, color: "#F87171" }}>
                  로그아웃
                </button>
              </>
            )}
            {sheets.auth === 'error' && (
              <span style={{ fontSize: 10, color: "#F87171" }}>Google 연결 오류</span>
            )}
          </div>
        )}

        {/* 탭 */}
        <div style={{ display: "flex", gap: 4, marginTop: isMobile ? 10 : 16, flexWrap: "nowrap", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          {[
            { key: "dashboard", label: "홈" },
            { key: "rebalance", label: "자산분배" },
            { key: "holdings", label: "종목" },
            { key: "dividend", label: "배당금" },
            { key: "profit", label: "수익금" },
            { key: "체결내역", label: "체결" },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: "10px 10px",
              flexShrink: 0,
              borderRadius: 6, border: "none", cursor: "pointer",
              fontSize: 11, letterSpacing: 1, fontFamily: baseFont,
              background: tab === key ? "#3B82F6" : "#1E2233",
              color: tab === key ? "#fff" : "#6B7280",
              transition: "all 0.2s",
            }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "20px 16px" }}>

        {/* ── 대시보드 탭 ── */}
        {tab === "dashboard" && (
          <div>
            {/* 요약 카드 3개 */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 8, marginBottom: 20,
            }}>
              {[
                { label: "총 투자금", value: `₩${fmt(totalInvest)}`, color: "#9CA3AF" },
                { label: "총 평가금", value: `₩${fmt(totalEval)}`, color: "#F5F7FF" },
                { label: "수익률", value: `${totalProfit >= 0 ? '+' : ''}${totalInvest > 0 ? ((totalProfit / totalInvest) * 100).toFixed(1) : '0.0'}%`, color: totalProfit >= 0 ? PROFIT_POS : PROFIT_NEG },
              ].map((s) => (
                <div key={s.label} style={{
                  background: "#1A1D26", borderRadius: 10, padding: "12px 10px", textAlign: "center",
                }}>
                  <div style={{ fontSize: 9, color: "#5A6478", marginBottom: 4, letterSpacing: 1 }}>{s.label}</div>
                  <div style={{
                    fontSize: isMobile ? 10 : 13, fontWeight: 700, color: s.color,
                    wordBreak: "break-all",
                  }}>
                    {s.value}
                  </div>
                </div>
              ))}
            </div>

            {/* 계좌 카드 그리드 (2열) */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
              gap: 10, marginBottom: 20,
            }}>
              {Object.entries(accounts).map(([k, v]) => {
                const isPos = v.profit >= 0;
                const pRate = v.total_invest > 0
                  ? ((v.profit / v.total_invest) * 100).toFixed(1)
                  : '0.0';
                return (
                  <div key={k} onClick={() => { setAcctKey(k); setTab("holdings"); }}
                    style={{
                      background: "#1A1D26", border: `1px solid ${v.color}33`,
                      borderRadius: 12, padding: "14px 16px",
                      cursor: "pointer", transition: "all 0.2s",
                      boxShadow: `0 0 20px ${v.color}11`,
                    }}>
                    <div style={{ fontSize: 9, letterSpacing: 2, color: v.color, marginBottom: 4 }}>
                      {v.sub.toUpperCase()}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, color: "#F5F7FF" }}>
                          {v.label}
                        </div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: "#F5F7FF", marginBottom: 2 }}>
                          ₩{fmt(v.total_eval)}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 9, color: "#5A6478", marginBottom: 2 }}>수익</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: isPos ? PROFIT_POS : PROFIT_NEG }}>
                          ₩{fmt(v.profit)}
                        </div>
                        <div style={{ fontSize: 11, color: isPos ? PROFIT_POS : PROFIT_NEG }}>
                          {isPos ? '+' : ''}{pRate}%
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 전체 평가금 추이 바차트 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478" }}>전체 평가금 추이</div>
                  <button
                    onClick={() => { if (!savingsLpFiredRef.current) setShowSavings(p => !p); }}
                    onMouseDown={startSavingsLP}
                    onMouseUp={endSavingsLP}
                    onMouseLeave={endSavingsLP}
                    onTouchStart={e => { e.preventDefault(); startSavingsLP(); }}
                    onTouchEnd={endSavingsLP}
                    onTouchCancel={endSavingsLP}
                    onContextMenu={e => e.preventDefault()}
                    style={{
                      padding: '3px 10px', borderRadius: 4,
                      border: `1px solid ${showSavings ? '#10B981' : '#2A2F3E'}`,
                      background: showSavings ? '#0D2B1A' : 'transparent',
                      color: showSavings ? '#10B981' : '#6B7280',
                      cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
                      userSelect: 'none', WebkitUserSelect: 'none',
                    }}
                  >저축금</button>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {['전체', '2025', '2026'].map(y => (
                    <button key={y} onClick={() => setMonthYear(y)} style={{
                      padding: '3px 10px', borderRadius: 4,
                      border: `1px solid ${monthYear === y ? '#3B82F6' : '#2A2F3E'}`,
                      background: monthYear === y ? '#1E3A5F' : 'transparent',
                      color: monthYear === y ? '#60A5FA' : '#6B7280',
                      cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
                    }}>{y}</button>
                  ))}
                </div>
              </div>
              {(() => {
                const data = monthYear === '전체' ? monthlyData : monthlyData.filter(d => String(d.year) === monthYear);
                const chartData = showSavings
                  ? data.map(d => ({ ...d, base: Math.max(0, d.value - (d.savings || 0)), savingsAmt: d.savings || 0 }))
                  : data;
                return data.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={chartData} barSize={isMobile ? 8 : 14}>
                      <XAxis dataKey="label" tick={{ fill: "#5A6478", fontSize: 9 }} axisLine={false} tickLine={false} />
                      <YAxis tickFormatter={v => `${(v / 100000000).toFixed(1)}억`} tick={{ fill: "#5A6478", fontSize: 9 }} width={40} axisLine={false} tickLine={false} />
                      <Tooltip
                        formatter={(v, name) => {
                          if (name === 'base') return [`₩${v.toLocaleString()}`, '잔고'];
                          if (name === 'savingsAmt') return [`₩${v.toLocaleString()}`, '저축금'];
                          return [`₩${v.toLocaleString()}`, '평가금'];
                        }}
                        contentStyle={{ background: "#1E2233", border: "1px solid #2A2F3E", borderRadius: 8, fontSize: 11 }}
                        labelStyle={{ color: '#E8EAF0' }}
                        itemStyle={{ color: '#E8EAF0' }}
                      />
                      {showSavings ? (
                        <>
                          <Bar dataKey="base" stackId="a" fill="#3B82F6" />
                          <Bar dataKey="savingsAmt" stackId="a" fill="#10B981" radius={[3, 3, 0, 0]} />
                        </>
                      ) : (
                        <Bar dataKey="value" fill="#3B82F6" radius={[3, 3, 0, 0]} />
                      )}
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5A6478', fontSize: 12 }}>
                    데이터가 없습니다
                  </div>
                );
              })()}
              {showSavingsEdit && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #2A2F3E' }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: '#5A6478', marginBottom: 8 }}>이번 달 저축금 수정</div>
                  <input
                    type="number"
                    value={savingsEditValue}
                    onChange={e => setSavingsEditValue(e.target.value)}
                    style={{
                      width: '100%', boxSizing: 'border-box', marginBottom: 8,
                      background: '#0D1520', border: '1px solid #2A2F3E', borderRadius: 6,
                      color: '#E8EAF0', padding: '6px 10px', fontSize: 12, fontFamily: baseFont,
                    }}
                    placeholder="0"
                  />
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => setShowSavingsEdit(false)} style={{
                      padding: '6px 12px', borderRadius: 6, border: '1px solid #2A2F3E',
                      background: 'transparent', color: '#6B7280', cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
                    }}>취소</button>
                    <button onClick={saveSavingsEdit} style={{
                      padding: '6px 12px', borderRadius: 6, border: 'none',
                      background: '#10B981', color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
                    }}>저장</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── 리밸런싱 탭 ── */}
        {tab === "rebalance" && (
          <div>
            {/* 계좌 선택 (4개) */}
            <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
              {Object.keys(accounts).map((k) => (
                <button key={k} onClick={() => setAcctKey(k)} style={{
                  flex: 1, padding: isMobile ? "8px 4px" : "6px 4px",
                  textAlign: 'center',
                  borderRadius: 20,
                  border: `1px solid ${acctKey === k ? accounts[k].color : "#2A2F3E"}`,
                  background: acctKey === k ? `${accounts[k].color}22` : "transparent",
                  color: acctKey === k ? accounts[k].color : "#6B7280",
                  cursor: "pointer", fontSize: 11, fontFamily: baseFont,
                }}>
                  {accounts[k].label}
                </button>
              ))}
            </div>

            {/* 자산군 구성 파이 (최상단) */}
            {acct.assets.some(a => a.eval > 0) && (
              <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 12 }}>자산군 구성</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <ResponsiveContainer width="100%" height={160}>
                      <PieChart>
                        <Pie
                          data={acct.assets.filter(a => a.eval > 0).map(a => ({ name: a.name, value: a.eval }))}
                          cx="50%" cy="50%" innerRadius={40} outerRadius={65} dataKey="value" paddingAngle={3}>
                          {acct.assets.filter(a => a.eval > 0).map((a, i) => (
                            <Cell key={i} fill={COLORS[a.name] || "#aaa"} stroke="#0D0F14" strokeWidth={2} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(v) => `₩${v.toLocaleString()}`}
                          contentStyle={{ background: "#1E2233", border: "1px solid #2A2F3E", borderRadius: 8, fontSize: 11 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ width: 120, flexShrink: 0 }}>
                    {acct.assets.filter(a => a.eval > 0).map(a => (
                      <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                        <span style={{ fontSize: 11, color: '#9CA3AF', flex: 1 }}>{a.name}</span>
                        <span style={{ fontSize: 11, color: '#E8EAF0' }}>
                          {acct.total_eval > 0 ? (a.eval / acct.total_eval * 100).toFixed(1) : '0.0'}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* 현재 vs 목표 비중 테이블 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478" }}>목표 vs 현재 비중</div>
                {sheets.auth === 'signed-in' && (
                  <button
                    onClick={() => { setAllTargetInputs(acct.assets.map(a => String(a.target))); setEditingAllTargets(true); }}
                    style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #2A2F3E', background: 'transparent', color: '#5A6478', cursor: 'pointer', fontSize: 13, fontFamily: baseFont, lineHeight: 1 }}
                  >⋯</button>
                )}
              </div>
              {editingAllTargets && (
                <div style={{ marginBottom: 12, background: '#141927', borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 8 }}>목표 비중 수정 — 합계 100%</div>
                  {acct.assets.map((a, i) => (
                    <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                      <span style={{ fontSize: 12, flex: 1, color: '#E8EAF0' }}>{a.name}</span>
                      <input
                        type="number"
                        value={allTargetInputs[i] ?? ''}
                        onChange={e => setAllTargetInputs(prev => { const n = [...prev]; n[i] = e.target.value; return n; })}
                        style={{ width: 60, padding: '3px 6px', borderRadius: 4, border: '1px solid #3B82F6', background: '#0D1520', color: '#E8EAF0', fontSize: 12, textAlign: 'right', fontFamily: baseFont, outline: 'none' }}
                      />
                      <span style={{ fontSize: 11, color: '#5A6478' }}>%</span>
                    </div>
                  ))}
                  <div style={{ fontSize: 11, marginBottom: 8, color: (() => { const s = allTargetInputs.reduce((acc, v) => acc + (parseFloat(v)||0), 0); return Math.abs(s-100) < 0.1 ? '#4ADE80' : '#F87171'; })() }}>
                    합계: {allTargetInputs.reduce((acc, v) => acc + (parseFloat(v)||0), 0).toFixed(1)}%
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => setEditingAllTargets(false)} style={{ padding: '5px 12px', borderRadius: 5, border: '1px solid #2A2F3E', background: 'transparent', color: '#6B7280', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>취소</button>
                    <button onClick={saveAllTargets} style={{ padding: '5px 12px', borderRadius: 5, border: 'none', background: '#3B82F6', color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>저장</button>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', marginBottom: 4 }}>
                <div style={{ flex: 1, fontSize: 10, color: '#5A6478', textAlign: 'center' }}>자산군</div>
                <div style={{ width: 60, textAlign: 'center', fontSize: 10, color: '#5A6478' }}>목표%</div>
                <div style={{ width: 50, textAlign: 'center', fontSize: 10, color: '#5A6478' }}>현재%</div>
                <div style={{ width: 60, textAlign: 'center', fontSize: 10, color: '#5A6478' }}>차이</div>
              </div>
              {acct.assets.map((a) => {
                const curr = a.sheetCurrent ?? a.ratio;
                const diff = parseFloat((curr - a.target).toFixed(1));
                const highlight = Math.abs(diff) >= 5;
                return (
                  <div key={a.name} style={{
                    display: 'flex', alignItems: 'center', padding: '7px 8px',
                    borderRadius: 6, marginBottom: 2,
                    background: highlight ? '#1A2035' : 'transparent',
                    borderLeft: highlight ? `3px solid ${diff > 0 ? PROFIT_POS : PROFIT_NEG}` : '3px solid transparent',
                  }}>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                      <span style={{ fontSize: 12 }}>{a.name}</span>
                    </div>
                    <div style={{ width: 60, textAlign: 'center', fontSize: 12, color: '#9CA3AF' }}>
                      {a.target}%
                    </div>
                    <div style={{ width: 50, textAlign: 'center', fontSize: 12, color: '#E8EAF0' }}>{curr}%</div>
                    <div style={{ width: 60, textAlign: 'right', fontSize: 12, fontWeight: 700,
                      color: diff > 0 ? PROFIT_POS : diff < 0 ? PROFIT_NEG : '#9CA3AF' }}>
                      {diff > 0 ? '+' : ''}{diff}%p
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 리밸런싱 필요 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px" }}>
              <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 12 }}>리밸런싱 필요</div>
              {acct.assets.map((a) => {
                const amt = a.rebalAmt ?? 0;
                const curr = a.sheetCurrent ?? a.ratio;
                const diff = parseFloat((curr - a.target).toFixed(1));
                const highlight = Math.abs(diff) >= 5;
                return (
                  <div key={a.name} style={{
                    display: 'flex', alignItems: 'center', padding: '10px 12px',
                    borderRadius: 6, marginBottom: 4,
                    background: highlight ? '#1A2035' : 'transparent',
                    borderLeft: highlight ? `3px solid ${amt > 0 ? PROFIT_POS : PROFIT_NEG}` : '3px solid transparent',
                  }}>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                      <span style={{ fontSize: 12 }}>{a.name}</span>
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: amt > 0 ? PROFIT_POS : amt < 0 ? PROFIT_NEG : '#9CA3AF' }}>
                      ₩{fmt(amt)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── 종목 탭 ── */}
        {tab === "holdings" && (
          <div>
            {/* 계좌 선택 (4개 모두) */}
            <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
              {Object.keys(accounts).map((k) => (
                <button key={k} onClick={() => { setAcctKey(k); setShowAddForm(false); setEditingHolding(null); }} style={{
                  flex: 1, padding: isMobile ? "8px 4px" : "6px 4px",
                  textAlign: 'center',
                  borderRadius: 20,
                  border: `1px solid ${acctKey === k ? accounts[k].color : "#2A2F3E"}`,
                  background: acctKey === k ? `${accounts[k].color}22` : "transparent",
                  color: acctKey === k ? accounts[k].color : "#6B7280",
                  cursor: "pointer", fontSize: 11, fontFamily: baseFont,
                }}>
                  {accounts[k].label}
                </button>
              ))}
            </div>

            {/* 계좌 요약 카드 */}
            <div style={{
              background: `linear-gradient(135deg, ${acct.color}22, #1A1D26)`,
              border: `1px solid ${acct.color}44`,
              borderRadius: 12, padding: "16px", marginBottom: 16,
            }}>
              <div style={{ fontSize: 10, letterSpacing: 2, color: acct.color, marginBottom: 4 }}>
                {acct.sub.toUpperCase()}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
                <div>
                  <div style={{ fontSize: isMobile ? 16 : 20, fontWeight: 700, color: "#F5F7FF" }}>
                    ₩{fmt(acct.total_eval)}
                  </div>
                  <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>
                    투자금 ₩{fmt(acct.total_invest)}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{
                    fontSize: isMobile ? 13 : 16, fontWeight: 700,
                    color: acct.profit >= 0 ? PROFIT_POS : PROFIT_NEG,
                  }}>
                    ₩{fmt(acct.profit)}
                  </div>
                  <div style={{ fontSize: 11, color: acct.profit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                    {acct.profit >= 0 ? '+' : ''}
                    {acct.total_invest > 0 ? ((acct.profit / acct.total_invest) * 100).toFixed(1) : '0.0'}%
                  </div>
                </div>
              </div>
            </div>

            {/* 종목추가/삭제 버튼 + 폼 */}
            {sheets.auth === 'signed-in' && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 }}>
                  <button onClick={() => { setShowDeleteMode(p => !p); setSelectedToDelete(new Set()); setShowAddForm(false); }} style={{
                    width: 30, height: 30, padding: 0, borderRadius: 6, flexShrink: 0,
                    border: showDeleteMode ? `1px solid ${PROFIT_POS}` : '1px solid #2A2F3E',
                    background: showDeleteMode ? '#2A1A1A' : 'transparent',
                    color: showDeleteMode ? PROFIT_POS : '#6B7280',
                    cursor: 'pointer', fontSize: 16, fontFamily: baseFont,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {showDeleteMode ? '✕' : '−'}
                  </button>
                  <button onClick={() => { setShowAddForm(p => !p); setShowDeleteMode(false); }} style={{
                    width: 30, height: 30, padding: 0, borderRadius: 6, flexShrink: 0,
                    border: showAddForm ? `1px solid ${PROFIT_POS}` : '1px solid #2A2F3E',
                    background: showAddForm ? '#2A1A1A' : 'transparent',
                    color: showAddForm ? PROFIT_POS : '#6B7280',
                    cursor: 'pointer', fontSize: 16, fontFamily: baseFont,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {showAddForm ? '✕' : '+'}
                  </button>
                </div>
                {showAddForm && (
                  <AddHoldingForm
                    acctKey={acctKey}
                    accounts={accounts}
                    readRange={sheets.readRange}
                    insertRowAfter={sheets.insertRowAfter}
                    onSave={async (range, row, investAmount) => {
                      await sheets.appendRow(range, row);
                      const mr = monthlyRowRef.current;
                      if (!mr) {
                        setBalanceSyncMsg('이번 달 행 없음 — 저축금 미반영');
                        setTimeout(() => setBalanceSyncMsg(''), 4000);
                      } else {
                        try {
                          const rows = await sheets.readRange(`월별잔고!C${mr}:C${mr}`);
                          const current = parseNum(rows[0]?.[0]);
                          await sheets.writeRange(`월별잔고!C${mr}:C${mr}`, [current + investAmount]);
                          setBalanceSyncMsg('저축금 반영됨');
                          setTimeout(() => setBalanceSyncMsg(''), 3000);
                        } catch {
                          setBalanceSyncMsg('저축금 업데이트 실패');
                          setTimeout(() => setBalanceSyncMsg(''), 4000);
                        }
                      }
                      setShowAddForm(false);
                    }}
                    onCancel={() => setShowAddForm(false)}
                  />
                )}
              </div>
            )}

            {/* 보유 종목 목록 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, overflow: "hidden" }}>
              {(() => {
                const vis = acct.holdings
                  .map((h, origIdx) => ({ h, origIdx }))
                  .filter(({ h }) => h.invest > 0 && h.eval > 0);
                return (<>
                  <div style={{ padding: "12px 16px", borderBottom: "1px solid #2A2F3E", fontSize: 10, letterSpacing: 3, color: "#5A6478" }}>
                    보유 종목 ({vis.length})
                  </div>
                  {vis.length === 0 && (
                    <div style={{ padding: 24, textAlign: 'center', color: '#5A6478', fontSize: 12 }}>
                      종목이 없습니다
                    </div>
                  )}
                  {vis.map(({ h, origIdx }, vi) => {
                    const color = h.rate >= 0 ? PROFIT_POS : PROFIT_NEG;
                    const typeName = h.type || '';
                    const isEditing = editingHolding?.origIdx === origIdx;
                    const lpHandlers = sheets.auth === 'signed-in' && !showDeleteMode ? {
                      onMouseDown: () => startLP(origIdx, h),
                      onMouseUp: endLP,
                      onMouseLeave: endLP,
                      onTouchStart: (e) => { e.preventDefault(); startLP(origIdx, h); },
                      onTouchEnd: endLP,
                      onTouchCancel: endLP,
                      onContextMenu: (e) => e.preventDefault(),
                    } : {};
                    return (
                    <div key={origIdx} style={{ borderBottom: vi < vis.length - 1 ? "1px solid #1E2233" : "none" }}>
                      <div style={{
                        padding: isMobile ? "10px 16px" : "12px 16px",
                        display: "flex", alignItems: "center", gap: 10,
                        background: isEditing ? '#1A2035' : selectedToDelete.has(origIdx) ? '#1A1520' : 'transparent',
                        userSelect: 'none', WebkitUserSelect: 'none',
                      }} {...lpHandlers}>
                      {showDeleteMode && (
                        <input type="checkbox" checked={selectedToDelete.has(origIdx)}
                          onChange={() => setSelectedToDelete(prev => {
                            const next = new Set(prev);
                            if (next.has(origIdx)) next.delete(origIdx); else next.add(origIdx);
                            return next;
                          })}
                          style={{ marginRight: 2, accentColor: PROFIT_POS, flexShrink: 0 }}
                        />
                      )}
                      {typeName && (
                        <div style={{
                          fontSize: 10,
                          background: (COLORS[typeName] || '#aaa') + '33',
                          color: COLORS[typeName] || '#aaa',
                          padding: '2px 6px', borderRadius: 4, flexShrink: 0, whiteSpace: 'nowrap',
                        }}>
                          {typeName}
                        </div>
                      )}
                      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#E8EAF0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {h.name}
                        </div>
                        <div style={{ fontSize: 10, color: "#5A6478", marginTop: 2 }}>
                          {h.qty}주 · ₩{fmt(h.invest)}
                        </div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: isMobile ? 11 : 12, color: "#E8EAF0" }}>₩{fmt(h.eval)}</div>
                        <div style={{ fontSize: isMobile ? 10 : 11, fontWeight: 700, color }}>
                          ₩{fmt(Math.abs(h.profit))}
                        </div>
                        <div style={{ fontSize: 10, color }}>
                          {h.rate >= 0 ? '+' : ''}{h.rate.toFixed(1)}%
                        </div>
                      </div>
                    </div>
                    {isEditing && (
                      <div style={{
                        padding: '12px 16px', background: '#141927',
                        borderTop: '1px solid #2A2F3E',
                      }}>
                        <div style={{ fontSize: 10, letterSpacing: 2, color: '#5A6478', marginBottom: 10 }}>종목 수정</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                          <div>
                            <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4 }}>매수단가</div>
                            <input
                              type="number"
                              value={editPrice}
                              onChange={e => setEditPrice(e.target.value)}
                              style={{
                                background: '#0D1520', border: '1px solid #2A2F3E', borderRadius: 6,
                                color: '#E8EAF0', padding: '6px 10px', fontSize: 12,
                                fontFamily: baseFont, width: '100%', boxSizing: 'border-box',
                              }}
                            />
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4 }}>수량</div>
                            <input
                              type="number"
                              value={editQty}
                              onChange={e => setEditQty(e.target.value)}
                              style={{
                                background: '#0D1520', border: '1px solid #2A2F3E', borderRadius: 6,
                                color: '#E8EAF0', padding: '6px 10px', fontSize: 12,
                                fontFamily: baseFont, width: '100%', boxSizing: 'border-box',
                              }}
                            />
                          </div>
                        </div>
                        {editingHolding?.isManual && (
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4 }}>현재가 (수기)</div>
                            <input
                              type="number"
                              value={editCurrentPrice}
                              onChange={e => setEditCurrentPrice(e.target.value)}
                              style={{
                                background: '#0D1520', border: '1px solid #3B82F6', borderRadius: 6,
                                color: '#E8EAF0', padding: '6px 10px', fontSize: 12,
                                fontFamily: baseFont, width: '100%', boxSizing: 'border-box',
                              }}
                            />
                          </div>
                        )}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9CA3AF', marginBottom: 10, cursor: 'pointer', userSelect: 'none' }}>
                          <input
                            type="checkbox"
                            checked={editIncludeSavings}
                            onChange={e => setEditIncludeSavings(e.target.checked)}
                            style={{ accentColor: '#3B82F6' }}
                          />
                          신규 매수 반영 (저축금 업데이트)
                        </label>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                          <button onClick={() => { setEditingHolding(null); setEditIncludeSavings(false); }} style={{
                            padding: '6px 14px', borderRadius: 6, border: '1px solid #2A2F3E',
                            background: 'transparent', color: '#6B7280', cursor: 'pointer',
                            fontSize: 11, fontFamily: baseFont,
                          }}>취소</button>
                          <button onClick={saveEdit} style={{
                            padding: '6px 14px', borderRadius: 6, border: 'none',
                            background: '#3B82F6', color: '#fff', cursor: 'pointer',
                            fontSize: 11, fontFamily: baseFont,
                          }}>저장</button>
                        </div>
                      </div>
                    )}
                    </div>
                );
              })}
              {showDeleteMode && selectedToDelete.size > 0 && (
                <div style={{ padding: '12px 16px', borderTop: '1px solid #2A2F3E' }}>
                  <button onClick={handleDeleteSelected} style={{
                    width: '100%', padding: 10, borderRadius: 6, border: 'none',
                    background: PROFIT_POS, color: '#fff', cursor: 'pointer',
                    fontSize: 12, fontFamily: baseFont,
                  }}>
                    선택 삭제 ({selectedToDelete.size}개)
                  </button>
                </div>
              )}
                </>);
              })()}
            </div>
          </div>
        )}

        {/* ── 배당금 탭 ── */}
        {tab === "dividend" && (
          <div>
            {/* 연도 선택 */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
              {['전체', '2025', '2026'].map(y => (
                <button key={y} onClick={() => setDivYear(y)} style={{
                  padding: isMobile ? "8px 14px" : "6px 14px",
                  minHeight: isMobile ? 40 : undefined,
                  borderRadius: 20,
                  border: `1px solid ${divYear === y ? '#3B82F6' : '#2A2F3E'}`,
                  background: divYear === y ? '#1E3A5F' : 'transparent',
                  color: divYear === y ? '#60A5FA' : '#6B7280',
                  cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
                }}>{y}</button>
              ))}
            </div>

            {/* 배당금 바차트 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
              <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 16 }}>
                월별 배당금
              </div>
              {filteredDividends.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={filteredDividends.map(d => ({
                      ...d,
                      label: `${String(d.year).slice(-2)}.${String(d.month).padStart(2, '0')}`,
                    }))}
                    barSize={isMobile ? 10 : 16}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3E" />
                    <XAxis dataKey="label" tick={{ fill: "#5A6478", fontSize: 9 }} />
                    <YAxis tickFormatter={v => v.toLocaleString()} tick={{ fill: "#5A6478", fontSize: 9 }} width={55} />
                    <Tooltip
                      formatter={v => [`₩${v.toLocaleString()}`, '배당금']}
                      contentStyle={{ background: "#1E2233", border: "1px solid #2A2F3E", borderRadius: 8, fontSize: 11 }}
                      labelStyle={{ color: '#E8EAF0' }}
                      itemStyle={{ color: '#E8EAF0' }}
                    />
                    <Bar dataKey="amount" radius={[3, 3, 0, 0]}>
                      {filteredDividends.map((d, i) => (
                        <Cell key={i} fill={d.year === 2025 ? "#3B82F6" : "#10B981"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5A6478', fontSize: 12 }}>
                  배당 데이터가 없습니다
                </div>
              )}
            </div>

            {/* 연도별 합계 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px" }}>
              <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 12 }}>연도별 합계</div>
              {[
                { label: '2025년 합계', value: div2025Total, color: '#3B82F6' },
                { label: '2026년 합계', value: div2026Total, color: '#10B981' },
              ].map(row => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #1E2233' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: row.color }} />
                    <span style={{ fontSize: 12, color: '#9CA3AF' }}>{row.label}</span>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#E8EAF0' }}>₩{row.value.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* ── 수익금 탭 ── */}
        {tab === "profit" && (() => {
          const profitYears = ['전체', ...[...new Set(profitData.map(d => String(d.year)))].sort()];
          const filtered = profitYear === '전체' ? profitData : profitData.filter(d => String(d.year) === profitYear);
          const selectedItem = selectedProfitKey ? profitData.find(d => `${d.year}-${d.month}` === selectedProfitKey) : null;
          const yearTotals = profitYears.filter(y => y !== '전체').map(y => ({
            year: y,
            total: profitData.filter(d => String(d.year) === y).reduce((s, d) => s + d.total, 0),
          }));
          return (
            <div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
                {profitYears.map(y => (
                  <button key={y} onClick={() => { setProfitYear(y); setSelectedProfitKey(null); }} style={{
                    padding: isMobile ? "8px 14px" : "6px 14px",
                    borderRadius: 20,
                    border: `1px solid ${profitYear === y ? '#3B82F6' : '#2A2F3E'}`,
                    background: profitYear === y ? '#1E3A5F' : 'transparent',
                    color: profitYear === y ? '#60A5FA' : '#6B7280',
                    cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
                  }}>{y}</button>
                ))}
              </div>

              <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 16 }}>월별 수익금</div>
                {filtered.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart
                      data={filtered.map(d => ({ ...d, label: `${String(d.year).slice(-2)}.${String(d.month).padStart(2, '0')}` }))}
                      barSize={isMobile ? 10 : 16}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3E" />
                      <XAxis dataKey="label" tick={{ fill: "#5A6478", fontSize: 9 }} />
                      <YAxis tickFormatter={v => v.toLocaleString()} tick={{ fill: "#5A6478", fontSize: 9 }} width={55} />
                      <Tooltip
                        formatter={v => [`₩${v.toLocaleString()}`, '수익금']}
                        contentStyle={{ background: "#1E2233", border: "1px solid #2A2F3E", borderRadius: 8, fontSize: 11 }}
                        labelStyle={{ color: '#E8EAF0' }}
                        itemStyle={{ color: '#E8EAF0' }}
                      />
                      <Bar dataKey="total" radius={[3, 3, 0, 0]} cursor="pointer"
                        onClick={(data) => {
                          const key = `${data.year}-${data.month}`;
                          setSelectedProfitKey(prev => prev === key ? null : key);
                        }}>
                        {filtered.map((d, i) => (
                          <Cell key={i} fill={`${d.year}-${d.month}` === selectedProfitKey ? '#F5A623' : (d.total >= 0 ? '#3B82F6' : '#EF4444')} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5A6478', fontSize: 12 }}>
                    수익금 데이터가 없습니다
                  </div>
                )}

                {selectedItem && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #2A2F3E' }}>
                    <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 8, letterSpacing: 1 }}>
                      {selectedItem.year}년 {selectedItem.month}월 상세
                    </div>
                    {selectedItem.items.map((item, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #1E2233' }}>
                        <span style={{ fontSize: 12, color: '#E8EAF0' }}>{item.name}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: item.profit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                          {item.profit >= 0 ? '+' : '-'}₩{fmt(Math.abs(item.profit))}
                        </span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8 }}>
                      <span style={{ fontSize: 11, color: '#9CA3AF' }}>합계</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: selectedItem.total >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                        {selectedItem.total >= 0 ? '+' : '-'}₩{fmt(Math.abs(selectedItem.total))}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px" }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 12 }}>연도별 합계</div>
                {yearTotals.map(row => (
                  <div key={row.year} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #1E2233' }}>
                    <span style={{ fontSize: 12, color: '#9CA3AF' }}>{row.year}년 합계</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: row.total >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                      {row.total >= 0 ? '+' : '-'}₩{fmt(Math.abs(row.total))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* ── 체결내역 탭 ── */}
        {tab === "체결내역" && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 10, letterSpacing: 3, color: '#5A6478' }}>체결내역 자동 동기화</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {tradeSyncMsg && (
                  <span style={{ fontSize: 10, color: tradeSyncMsg.includes('오류') ? '#F87171' : '#4ADE80' }}>
                    {tradeSyncMsg}
                  </span>
                )}
                <button onClick={repairFormulas} disabled={tradeSyncing || sheets.auth !== 'signed-in'} style={{
                  padding: '5px 12px', borderRadius: 6, border: '1px solid #2A2F3E',
                  background: 'transparent', color: '#F5A623',
                  cursor: (tradeSyncing || sheets.auth !== 'signed-in') ? 'not-allowed' : 'pointer',
                  fontSize: 10, fontFamily: baseFont,
                }}>
                  수식 복구
                </button>
                <button onClick={syncTradeExecutions} disabled={tradeSyncing || sheets.auth !== 'signed-in'} style={{
                  padding: '5px 12px', borderRadius: 6, border: '1px solid #2A2F3E',
                  background: 'transparent', color: '#9CA3AF',
                  cursor: (tradeSyncing || sheets.auth !== 'signed-in') ? 'not-allowed' : 'pointer',
                  fontSize: 10, fontFamily: baseFont,
                }}>
                  ↻
                </button>
              </div>
            </div>

            {sheets.auth !== 'signed-in' ? (
              <div style={{ padding: 32, textAlign: 'center', color: '#5A6478', fontSize: 12 }}>
                로그인 후 이용할 수 있습니다
              </div>
            ) : tradeRows.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: '#5A6478', fontSize: 12 }}>
                {tradeSyncing ? '불러오는 중...' : '체결내역이 없습니다'}
              </div>
            ) : (
              <div style={{ background: '#1A1D26', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ padding: '10px 16px', borderBottom: '1px solid #2A2F3E', fontSize: 10, letterSpacing: 3, color: '#5A6478' }}>
                  전체 {tradeRows.length}건 · 처리완료 {tradeRows.filter(r => r.processed).length}건
                </div>
                {tradeRows.map(({ row, processed }, idx) => {
                  const date     = String(row[0] ?? '').trim();
                  const buySell  = String(row[1] ?? '').trim();
                  const account  = String(row[2] ?? '').trim();
                  const stockName = String(row[5] ?? '').trim();
                  const price    = parseNum(row[6]);
                  const qty      = parseNum(row[7]);
                  const isComplete = row.length >= 13 && row.slice(0, 13).every(cell => String(cell ?? '').trim() !== '');
                  const isBuy = buySell.includes('매수');
                  return (
                    <div key={idx} style={{
                      padding: '12px 16px',
                      borderBottom: idx < tradeRows.length - 1 ? '1px solid #1E2233' : 'none',
                      display: 'flex', alignItems: 'center', gap: 12,
                      opacity: processed ? 0.55 : 1,
                    }}>
                      <div style={{
                        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                        background: processed ? '#34A853' : isComplete ? '#F5A623' : '#3B4152',
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                          <span style={{
                            fontSize: 10, padding: '1px 5px', borderRadius: 3,
                            background: isBuy ? '#1E3A5F' : '#4A1E1E',
                            color: isBuy ? '#60A5FA' : '#F87171',
                          }}>{buySell || '—'}</span>
                          <span style={{ fontSize: 10, color: '#5A6478' }}>{account}</span>
                          <span style={{ fontSize: 10, color: '#3A3F4E' }}>·</span>
                          <span style={{ fontSize: 10, color: '#5A6478' }}>{date}</span>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#E8EAF0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {stockName || '—'}
                        </div>
                        <div style={{ fontSize: 10, color: '#5A6478', marginTop: 2 }}>
                          {qty > 0 ? `${qty}주` : ''}{qty > 0 && price > 0 ? ' · ' : ''}{price > 0 ? `₩${price.toLocaleString()}` : ''}
                          {!isComplete && <span style={{ marginLeft: 6, color: '#F59E0B' }}>셀 미완성</span>}
                        </div>
                      </div>
                      {processed && (
                        <span style={{ fontSize: 10, color: '#34A853', flexShrink: 0 }}>완료</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

          </div>
        )}

      </div>

      <div style={{ padding: "12px 16px 32px", textAlign: "center", fontSize: 9, color: "#2A2F3E", letterSpacing: 2 }}>
        2026-04-25 · 바나나 은퇴 준비 포트폴리오
      </div>
    </div>
  );
}
