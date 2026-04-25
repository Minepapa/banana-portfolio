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
  ISA:           'Banana!K6:S12',    // 0
  위탁:          'Banana!K14:S41',   // 1
  연금저축:      'Banana!K43:S66',   // 2
  IRP:           'Banana!K68:S80',   // 3
  위탁목표:      'Banana!C11:C17',   // 4
  위탁현재:      'Banana!F11:F17',   // 5
  위탁리밸:      'Banana!G11:G17',   // 6
  연금저축목표:  'Banana!C23:C29',   // 7
  연금저축현재:  'Banana!F23:F29',   // 8
  연금저축리밸:  'Banana!G23:G29',   // 9
  ISA목표:       'Banana!C6:C6',     // 10
  ISA현재:       'Banana!F6:F6',     // 11
  ISA리밸:       'Banana!G6:G6',     // 12
  IRP목표:       'Banana!C35:C35',   // 13
  IRP현재:       'Banana!F35:F35',   // 14
  IRP리밸:       'Banana!G35:G35',   // 15
  월별잔고:      'Banana!B43:I89',   // 16
  배당2025:      'Banana!U5:W78',    // 17
  배당2026:      'Banana!Y5:AA78',   // 18
};

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
    assets: [{ name: "TDF", ratio: 0, invest: 0, eval: 0, target: 100 }],
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
    result.push({ label: `${yearShort}.${String(month).padStart(2, '0')}`, value: total });
  });
  return result;
}

function parseDividends(vr2025, vr2026) {
  const result = {};
  const process = (vr) => {
    (vr?.values ?? []).forEach(r => {
      const dateStr = String(r[0] ?? '').trim();
      const amt = parseNum(r[2]);
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
  };
  process(vr2025);
  process(vr2026);
  return Object.values(result).sort((a, b) => a.year - b.year || a.month - b.month);
}

function parseSheetData(valueRanges) {
  // indices: ISA(0) 위탁(1) 연금저축(2) IRP(3)
  //          위탁목표(4) 위탁현재(5) 위탁리밸(6)
  //          연금목표(7) 연금현재(8) 연금리밸(9)
  //          ISA목표(10) ISA현재(11) ISA리밸(12)
  //          IRP목표(13) IRP현재(14) IRP리밸(15)
  //          월별잔고(16) 배당2025(17) 배당2026(18)
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
        qty: parseNum(r[3]),
        invest: parseNum(r[4]),
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

  const parseCol = (vr) => (vr?.values ?? []).map(r => parseNum(r[0]));

  if (result['위탁']) {
    const targets = parseCol(valueRanges[4]);
    const currents = parseCol(valueRanges[5]);
    const rebals = parseCol(valueRanges[6]);
    result['위탁'].assets = result['위탁'].assets.map((a, i) => ({
      ...a,
      target: targets[i] ?? a.target,
      sheetCurrent: currents[i] ?? 0,
      rebalAmt: rebals[i] ?? 0,
    }));
  }

  if (result['연금저축']) {
    const targets = parseCol(valueRanges[7]);
    const currents = parseCol(valueRanges[8]);
    const rebals = parseCol(valueRanges[9]);
    result['연금저축'].assets = result['연금저축'].assets.map((a, i) => ({
      ...a,
      target: targets[i] ?? a.target,
      sheetCurrent: currents[i] ?? 0,
      rebalAmt: rebals[i] ?? 0,
    }));
  }

  if (result['ISA']) {
    const target = parseCol(valueRanges[10])[0] ?? 0;
    const current = parseCol(valueRanges[11])[0] ?? 0;
    const rebal = parseCol(valueRanges[12])[0] ?? 0;
    result['ISA'].assets = result['ISA'].assets.map((a, i) => ({
      ...a,
      target: i === 0 ? target : a.target,
      sheetCurrent: i === 0 ? current : 0,
      rebalAmt: i === 0 ? rebal : 0,
    }));
  }

  if (result['IRP']) {
    const target = parseCol(valueRanges[13])[0] ?? 0;
    const current = parseCol(valueRanges[14])[0] ?? 0;
    const rebal = parseCol(valueRanges[15])[0] ?? 0;
    result['IRP'].assets = result['IRP'].assets.map((a, i) => ({
      ...a,
      target: i === 0 ? target : a.target,
      sheetCurrent: i === 0 ? current : 0,
      rebalAmt: i === 0 ? rebal : 0,
    }));
  }

  const monthly = parseMonthly(valueRanges[16]);
  const dividends = parseDividends(valueRanges[17], valueRanges[18]);

  return anyData ? { accounts: result, monthly, dividends } : null;
}

// ── useGoogleSheets 훅 ────────────────────────────────────────────────────────
function useGoogleSheets(onData) {
  const [auth, setAuth] = useState('idle');
  const [sync, setSync] = useState('idle');
  const [lastSync, setLastSync] = useState(null);
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
          dividends: parsed.dividends,
        });
      }
      setLastSync(new Date());
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

  return { auth, sync, lastSync, signIn, signOut, fetch: doFetch, appendRow, clearRows };
}

// ── 종목추가 폼 컴포넌트 ──────────────────────────────────────────────────────
const START_ROWS = { ISA: 6, 위탁: 14, 연금저축: 43, IRP: 68 };

function AddHoldingForm({ acctKey, accounts, onSave, onCancel }) {
  const acct = accounts[acctKey];
  const assetNames = acct.assets.map(a => a.name);

  const [자산군, set자산군] = useState(assetNames[0] || '');
  const [종목명, set종목명] = useState('');
  const [티커유형, set티커유형] = useState('국내(GOOGLEFINANCE)');
  const [티커, set티커] = useState('');
  const [매수단가, set매수단가] = useState('');
  const [수량, set수량] = useState('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const inputStyle = {
    background: '#0D1520', border: '1px solid #2A2F3E', borderRadius: 6,
    color: '#E8EAF0', padding: '6px 10px', fontSize: 12,
    fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
    width: '100%', boxSizing: 'border-box',
  };
  const labelStyle = { fontSize: 10, color: '#5A6478', marginBottom: 4, display: 'block' };

  const handleSubmit = async () => {
    if (!종목명.trim() || !매수단가 || !수량) return;
    setSaving(true);
    try {
      let 현재가formula = '';
      if (티커유형 === '국내(GOOGLEFINANCE)') 현재가formula = `=GOOGLEFINANCE("${티커}")`;
      else if (티커유형 === '해외(GOOGLEFINANCE)') 현재가formula = `=GOOGLEFINANCE("${티커}")*I37`;
      else if (티커유형 === '네이버') 현재가formula = `=IMPORTXML("https://finance.naver.com/item/main.naver?code=${티커}","//p[@class='no_today']/em/span[1]")`;

      const 투자금 = parseFloat(매수단가) * parseFloat(수량);
      const nextRow = START_ROWS[acctKey] + accounts[acctKey].holdings.length;
      const newRow = [
        자산군, 종목명, parseFloat(매수단가), parseFloat(수량), 투자금,
        현재가formula,
        `=R${nextRow}-O${nextRow}`,
        `=N${nextRow}*P${nextRow}`,
        `=R${nextRow}/O${nextRow}-1`,
      ];
      const writeRange = `Banana!K${nextRow}:S${nextRow}`;

      await onSave(writeRange, newRow);
      setSuccess(true);
      setTimeout(() => { setSuccess(false); }, 2000);
      set종목명(''); set티커(''); set매수단가(''); set수량('');
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
      <div style={{ fontSize: 11, letterSpacing: 2, color: '#5A6478', marginBottom: 12 }}>
        종목 추가
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div>
          <label style={labelStyle}>자산군</label>
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
        {티커유형 !== '수기입력' && (
          <div>
            <label style={labelStyle}>티커</label>
            <input type="text" value={티커} onChange={e => set티커(e.target.value)}
              placeholder="예: KRX:360750" style={inputStyle} />
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
        <button onClick={handleSubmit} disabled={saving} style={{
          padding: '6px 14px', borderRadius: 6, border: 'none',
          background: saving ? '#2A2F3E' : '#3B82F6', color: '#fff', cursor: saving ? 'not-allowed' : 'pointer',
          fontSize: 11, fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
        }}>
          {saving ? '저장 중...' : success ? '저장됨 ✓' : '저장'}
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
  const [divYear, setDivYear] = useState('전체');
  const isMobile = useIsMobile();

  const onData = useCallback(({ accounts: a, monthly: m, dividends: d }) => {
    setAccounts(prev => ({ ...prev, ...a }));
    setMonthlyData(m || []);
    setDividendData(d || []);
  }, []);

  const sheets = useGoogleSheets(onData);

  const handleDeleteSelected = async () => {
    const ranges = [...selectedToDelete].map(idx => {
      const sheetRow = START_ROWS[acctKey] + acct.holdings[idx].rowOffset;
      return `Banana!K${sheetRow}:S${sheetRow}`;
    });
    await sheets.clearRows(ranges);
    setShowDeleteMode(false);
    setSelectedToDelete(new Set());
  };

  const acct = accounts[acctKey];
  const totalEval = Object.values(accounts).reduce((s, a) => s + a.total_eval, 0);
  const totalInvest = Object.values(accounts).reduce((s, a) => s + a.total_invest, 0);
  const totalProfit = totalEval - totalInvest;
  const profitRate = totalInvest > 0 ? ((totalProfit / totalInvest) * 100).toFixed(1) : '0.0';

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
              ₩{fmt(totalProfit)}
            </div>
            <div style={{ fontSize: 10, color: totalProfit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
              {totalProfit >= 0 ? '+' : ''}{profitRate}%
            </div>
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
        <div style={{ display: "flex", gap: 4, marginTop: isMobile ? 10 : 16, flexWrap: "wrap" }}>
          {[
            { key: "dashboard", label: "대시보드" },
            { key: "rebalance", label: "리밸런싱" },
            { key: "holdings", label: "종목" },
            { key: "dividend", label: "배당금" },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: isMobile ? "8px 14px" : "6px 14px",
              minHeight: isMobile ? 40 : undefined,
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
                { label: "수익률", value: `${totalProfit >= 0 ? '+' : ''}${profitRate}%`, color: totalProfit >= 0 ? PROFIT_POS : PROFIT_NEG },
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
              <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 16 }}>
                전체 평가금 추이
              </div>
              {monthlyData.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={monthlyData} barSize={isMobile ? 8 : 14}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3E" />
                    <XAxis dataKey="label" tick={{ fill: "#5A6478", fontSize: 9 }} />
                    <YAxis tickFormatter={v => `${(v / 10000).toFixed(0)}만`} tick={{ fill: "#5A6478", fontSize: 9 }} width={45} />
                    <Tooltip
                      formatter={v => [`₩${v.toLocaleString()}`, '평가금']}
                      contentStyle={{ background: "#1E2233", border: "1px solid #2A2F3E", borderRadius: 8, fontSize: 11 }}
                    />
                    <Bar dataKey="value" fill="#3B82F6" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5A6478', fontSize: 12 }}>
                  데이터가 없습니다. Google Sheets에서 불러와 주세요.
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── 리밸런싱 탭 ── */}
        {tab === "rebalance" && (
          <div>
            {/* 계좌 선택 (4개) */}
            <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
              {Object.keys(accounts).map((k) => (
                <button key={k} onClick={() => setAcctKey(k)} style={{
                  padding: isMobile ? "8px 14px" : "6px 14px",
                  minHeight: isMobile ? 40 : undefined,
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
              <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 12 }}>목표 vs 현재 비중</div>
              <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', marginBottom: 4 }}>
                <div style={{ flex: 1, fontSize: 10, color: '#5A6478' }}>자산군</div>
                <div style={{ width: 50, textAlign: 'right', fontSize: 10, color: '#5A6478' }}>목표%</div>
                <div style={{ width: 50, textAlign: 'right', fontSize: 10, color: '#5A6478' }}>현재%</div>
                <div style={{ width: 60, textAlign: 'right', fontSize: 10, color: '#5A6478' }}>차이</div>
              </div>
              {acct.assets.map((a) => {
                const curr = a.sheetCurrent ?? a.ratio;
                const diff = curr - a.target;
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
                    <div style={{ width: 50, textAlign: 'right', fontSize: 12, color: '#9CA3AF' }}>{a.target}%</div>
                    <div style={{ width: 50, textAlign: 'right', fontSize: 12, color: '#E8EAF0' }}>{curr}%</div>
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
                const diff = (a.sheetCurrent ?? a.ratio) - a.target;
                const highlight = Math.abs(diff) >= 5;
                return (
                  <div key={a.name} style={{
                    display: 'flex', alignItems: 'center', padding: '10px 12px',
                    borderRadius: 6, marginBottom: 4,
                    background: highlight ? '#1A2035' : 'transparent',
                    borderLeft: highlight ? `3px solid ${amt > 0 ? PROFIT_POS : PROFIT_NEG}` : '3px solid transparent',
                  }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[a.name] || '#aaa', marginRight: 10, flexShrink: 0 }} />
                    <div style={{ flex: 1, fontSize: 12 }}>{a.name}</div>
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
            <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
              {Object.keys(accounts).map((k) => (
                <button key={k} onClick={() => { setAcctKey(k); setShowAddForm(false); }} style={{
                  padding: isMobile ? "8px 12px" : "6px 12px",
                  minHeight: isMobile ? 40 : undefined,
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
                    padding: '6px 14px', borderRadius: 6,
                    border: `1px solid ${showDeleteMode ? PROFIT_POS : '#2A2F3E'}`,
                    background: showDeleteMode ? '#2A1A1A' : 'transparent',
                    color: showDeleteMode ? PROFIT_POS : '#6B7280',
                    cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
                  }}>
                    {showDeleteMode ? '✕ 취소' : '− 종목삭제'}
                  </button>
                  <button onClick={() => { setShowAddForm(p => !p); setShowDeleteMode(false); }} style={{
                    padding: '6px 14px', borderRadius: 6,
                    border: '1px solid #3B82F6', background: showAddForm ? '#1E3A5F' : 'transparent',
                    color: '#60A5FA', cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
                  }}>
                    {showAddForm ? '✕ 닫기' : '+ 종목추가'}
                  </button>
                </div>
                {showAddForm && (
                  <AddHoldingForm
                    acctKey={acctKey}
                    accounts={accounts}
                    onSave={async (range, row) => {
                      await sheets.appendRow(range, row);
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
                    const color = h.profit >= 0 ? PROFIT_POS : PROFIT_NEG;
                    const typeName = h.type || '';
                    return (
                    <div key={origIdx} style={{
                      padding: isMobile ? "10px 16px" : "12px 16px",
                      borderBottom: vi < vis.length - 1 ? "1px solid #1E2233" : "none",
                      display: "flex", alignItems: "center", gap: 10,
                      background: selectedToDelete.has(origIdx) ? '#1A1520' : 'transparent',
                    }}>
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
      </div>

      <div style={{ padding: "12px 16px 32px", textAlign: "center", fontSize: 9, color: "#2A2F3E", letterSpacing: 2 }}>
        2026-04-25 · 바나나 은퇴 준비 포트폴리오
      </div>
    </div>
  );
}
