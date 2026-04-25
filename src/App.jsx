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
  ISA:          'Banana!K6:S12',
  위탁:         'Banana!K14:S41',
  연금저축:     'Banana!K43:S66',
  IRP:          'Banana!K68:S80',
  위탁목표:     'Banana!C11:C17',
  연금저축목표: 'Banana!C23:C29',
  월별잔고:     'Banana!B43:I89',
  배당2025:     'Banana!U5:W78',
  배당2026:     'Banana!Y5:AA78',
};

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
      { name: "해외주식", ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "국내주식", ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "배당주",  ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "리츠",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "금",      ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "달러",    ratio: 0, invest: 0, eval: 0, target: 0 },
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

const rebalData = (assets) =>
  assets.map((a) => ({ name: a.name, 현재: a.ratio, 목표: a.target, gap: a.ratio - a.target }));

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

const TARGET_ASSET_ORDER = ['채권', '금', '달러', '배당주', '리츠', '국내주식', '해외주식'];

function parseTargets(valueRange) {
  return (valueRange?.values ?? []).map((r, i) => ({
    name: TARGET_ASSET_ORDER[i],
    target: parseNum(r[0]),
  }));
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
  let lastYear = '';
  const result = [];
  rows.forEach(r => {
    const yr = String(r[0] ?? '').trim();
    if (yr) lastYear = yr;
    const monthRaw = String(r[1] ?? '').trim();
    const totalRaw = r[7];
    if (!totalRaw || String(totalRaw).trim() === '') return;
    const total = parseNum(totalRaw);
    if (!total) return;
    let month = 0;
    if (/^\d+$/.test(monthRaw)) month = parseInt(monthRaw);
    else if (monthRaw.includes('-')) month = parseInt(monthRaw.split('-')[1]);
    if (!month || !lastYear) return;
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
  // valueRanges order: [ISA, 위탁, 연금저축, IRP, 위탁목표, 연금저축목표, 월별잔고, 배당2025, 배당2026]
  const accountKeys = ['ISA', '위탁', '연금저축', 'IRP'];
  const result = {};
  let anyData = false;

  accountKeys.forEach((key, i) => {
    const rows = (valueRanges[i]?.values ?? []).filter(r => r[1]);
    if (!rows.length) return;
    anyData = true;

    let lastType = '';
    const holdings = rows.map(r => {
      const type = String(r[0] ?? '').trim();
      if (type) lastType = type;
      return {
        name: String(r[1] ?? ''),
        qty: parseNum(r[3]),
        invest: parseNum(r[4]),
        eval: parseNum(r[7]),
        profit: parseNum(r[6]),
        rate: parseNum(r[8]),
        type: lastType,
      };
    });

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

  // Apply target overrides
  const 위탁타겟 = parseTargets(valueRanges[4]);
  const 연금타겟 = parseTargets(valueRanges[5]);

  if (result['위탁']) {
    위탁타겟.forEach(({ name, target }) => {
      const a = result['위탁'].assets.find(x => x.name === name);
      if (a) a.target = target;
    });
  }
  if (result['연금저축']) {
    연금타겟.forEach(({ name, target }) => {
      const a = result['연금저축'].assets.find(x => x.name === name);
      if (a) a.target = target;
    });
  }

  const monthly = parseMonthly(valueRanges[6]);
  const dividends = parseDividends(valueRanges[7], valueRanges[8]);

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

  return { auth, sync, lastSync, signIn, signOut, fetch: doFetch, appendRow };
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
      const newRow = [자산군, 종목명, parseFloat(매수단가), parseFloat(수량), 투자금, 현재가formula, '', '', ''];

      const nextRow = START_ROWS[acctKey] + accounts[acctKey].holdings.length;
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
  const [showTarget, setShowTarget] = useState(true);
  const [showCurrent, setShowCurrent] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [divYear, setDivYear] = useState('전체');
  const isMobile = useIsMobile();

  const onData = useCallback(({ accounts: a, monthly: m, dividends: d }) => {
    setAccounts(prev => ({ ...prev, ...a }));
    setMonthlyData(m || []);
    setDividendData(d || []);
  }, []);

  const sheets = useGoogleSheets(onData);

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
            <div style={{ fontSize: isMobile ? 13 : 15, fontWeight: 700, color: totalProfit >= 0 ? "#4ADE80" : "#F87171" }}>
              {totalProfit >= 0 ? '+' : '-'}₩{fmt(totalProfit)}
            </div>
            <div style={{ fontSize: 10, color: totalProfit >= 0 ? "#4ADE80" : "#F87171" }}>
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
                { label: "수익률", value: `${totalProfit >= 0 ? '+' : ''}${profitRate}%`, color: totalProfit >= 0 ? "#4ADE80" : "#F87171" },
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
                        <div style={{ fontSize: 13, fontWeight: 700, color: isPos ? "#4ADE80" : "#F87171" }}>
                          {isPos ? '+' : '-'}₩{fmt(v.profit)}
                        </div>
                        <div style={{ fontSize: 11, color: isPos ? "#4ADE80" : "#F87171" }}>
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
            {/* 계좌 선택 (위탁, 연금저축만) */}
            <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
              {['위탁', '연금저축'].map((k) => (
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

            {/* 현재 vs 목표 비중 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478" }}>현재 vs 목표 비중</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => setShowTarget(p => !p)} style={{
                    padding: '3px 10px', borderRadius: 4, border: `1px solid ${showTarget ? '#2A3A5A' : '#2A2F3E'}`,
                    background: showTarget ? '#2A3A5A' : 'transparent',
                    color: showTarget ? '#60A5FA' : '#6B7280', cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
                  }}>목표</button>
                  <button onClick={() => setShowCurrent(p => !p)} style={{
                    padding: '3px 10px', borderRadius: 4, border: `1px solid ${showCurrent ? '#1A3A2A' : '#2A2F3E'}`,
                    background: showCurrent ? '#1A3A2A' : 'transparent',
                    color: showCurrent ? '#4ADE80' : '#6B7280', cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
                  }}>현재</button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={rebalData(acct.assets)} layout="vertical" barSize={10}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3E" />
                      <XAxis type="number" tick={{ fill: "#5A6478", fontSize: 9 }} />
                      <YAxis type="category" dataKey="name" tick={{ fill: "#9CA3AF", fontSize: 10 }} width={55} />
                      <Tooltip
                        contentStyle={{ background: "#1E2233", border: "1px solid #2A2F3E", borderRadius: 8, fontSize: 11 }}
                        formatter={(v, n) => [`${v}%`, n === "목표" ? "목표비중" : "현재비중"]}
                      />
                      {showTarget && <Bar dataKey="목표" fill="#2A3A5A" radius={[0, 4, 4, 0]} />}
                      {showCurrent && (
                        <Bar dataKey="현재" radius={[0, 4, 4, 0]}>
                          {rebalData(acct.assets).map((entry, i) => (
                            <Cell key={i} fill={entry.gap > 3 ? "#52C8D4" : entry.gap < -3 ? "#F87171" : "#4ADE80"} />
                          ))}
                        </Bar>
                      )}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {/* 우측 레이블 패널 */}
                <div style={{ width: 130, flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-around', fontSize: 11 }}>
                  {acct.assets.map(a => (
                    <div key={a.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1px 0' }}>
                      <span style={{ color: COLORS[a.name] || '#aaa', fontWeight: 600, fontSize: 10, minWidth: 40 }}>{a.name}</span>
                      <span style={{ color: '#4ADE80', fontSize: 10 }}>{a.ratio}%</span>
                      <span style={{ color: '#60A5FA', fontSize: 10 }}>{a.target}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* 리밸런싱 필요 테이블 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
              <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 12 }}>
                리밸런싱 필요
              </div>
              {acct.assets.map((a) => {
                const gap = a.ratio - a.target;
                const needAmt = (a.target / 100 * acct.total_eval) - a.eval;
                const highlight = Math.abs(gap) >= 5;
                return (
                  <div key={a.name} style={{
                    display: "flex", alignItems: "center",
                    padding: "10px 12px",
                    marginBottom: 4,
                    borderRadius: 6,
                    background: highlight ? "#1A2035" : "transparent",
                    borderLeft: highlight ? `3px solid ${gap > 0 ? "#52C8D4" : "#F87171"}` : "3px solid transparent",
                  }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[a.name] || "#aaa", marginRight: 10, flexShrink: 0 }} />
                    <div style={{ flex: 1, fontSize: 12 }}>{a.name}</div>
                    <div style={{ fontSize: 11, color: "#9CA3AF", marginRight: 10, flexShrink: 0 }}>
                      {a.ratio}% → {a.target}%
                    </div>
                    <div style={{
                      fontSize: 11, fontWeight: 700,
                      color: Math.abs(gap) >= 5 ? (gap > 0 ? "#52C8D4" : "#F87171") : "#4ADE80",
                      minWidth: 40, textAlign: "right", marginRight: 10, flexShrink: 0,
                    }}>
                      {gap > 0 ? "+" : ""}{gap}%p
                    </div>
                    <div style={{
                      fontSize: 10,
                      color: needAmt > 0 ? "#52C8D4" : "#F87171",
                      minWidth: 90, textAlign: "right", flexShrink: 0,
                    }}>
                      {needAmt > 0 ? `+₩${fmt(Math.round(needAmt))}` : `-₩${fmt(Math.round(Math.abs(needAmt)))}`}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 자산군 구성 파이 */}
            {acct.assets.length > 1 && (
              <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px" }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 12 }}>자산군 구성</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <ResponsiveContainer width="100%" height={160}>
                      <PieChart>
                        <Pie
                          data={acct.assets.filter(a => a.eval > 0).map(a => ({ name: a.name, value: a.eval, color: COLORS[a.name] || "#aaa" }))}
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
                    color: acct.profit >= 0 ? "#4ADE80" : "#F87171",
                  }}>
                    {acct.profit >= 0 ? '+' : '-'}₩{fmt(acct.profit)}
                  </div>
                  <div style={{ fontSize: 11, color: acct.profit >= 0 ? "#4ADE80" : "#F87171" }}>
                    {acct.profit >= 0 ? '+' : ''}
                    {acct.total_invest > 0 ? ((acct.profit / acct.total_invest) * 100).toFixed(1) : '0.0'}%
                  </div>
                </div>
              </div>
            </div>

            {/* 종목추가 버튼 + 폼 */}
            {sheets.auth === 'signed-in' && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                  <button onClick={() => setShowAddForm(p => !p)} style={{
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

            {/* 자산군 파이 */}
            {acct.assets.length > 1 && (
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

            {/* 보유 종목 목록 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid #2A2F3E", fontSize: 10, letterSpacing: 3, color: "#5A6478" }}>
                보유 종목 ({acct.holdings.length})
              </div>
              {acct.holdings.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center', color: '#5A6478', fontSize: 12 }}>
                  종목이 없습니다
                </div>
              )}
              {acct.holdings.map((h, i) => {
                const sign = h.profit >= 0 ? '+' : '';
                const color = h.profit >= 0 ? '#4ADE80' : '#F87171';
                const typeName = h.type || '';
                return (
                  <div key={i} style={{
                    padding: isMobile ? "10px 16px" : "12px 16px",
                    borderBottom: i < acct.holdings.length - 1 ? "1px solid #1E2233" : "none",
                    display: "flex", alignItems: "center", gap: 10,
                  }}>
                    {/* 자산군 배지 */}
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
                        {sign}₩{fmt(Math.abs(h.profit))}
                      </div>
                      <div style={{ fontSize: 10, color }}>
                        {h.rate >= 0 ? '+' : ''}{h.rate.toFixed(1)}%
                      </div>
                    </div>
                  </div>
                );
              })}
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
