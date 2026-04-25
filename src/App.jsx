import { useState, useEffect, useCallback, useRef } from "react";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from "recharts";

// ── 구글 시트 설정 ─ 아래 두 값을 실제 값으로 교체하세요 ───────────────────────
const GOOGLE_CLIENT_ID = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
const SHEET_ID = '1hWLSCd9n1zk4eM7Wf1O2a3VH_pwcDV9Qn_AixzDgUgE';
// ─────────────────────────────────────────────────────────────────────────────
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';
const CONFIGURED = !GOOGLE_CLIENT_ID.startsWith('YOUR_') && !SHEET_ID.startsWith('YOUR_');

// 시트 탭명 및 데이터 범위 설정 (실제 시트 구조에 맞게 조정)
// 컬럼 순서: A=종목명, B=수량, C=투자금, D=평가금, E=수익금, F=수익률(%), G=자산유형
// K=자산군, L=종목명, M=매수단가, N=수량, O=투자금, P=현재가, Q=수익금, R=평가금, S=수익률
const SHEET_RANGES = {
  ISA:      'Banana!K6:S12',
  위탁:     'Banana!K14:S41',
  연금저축: 'Banana!K43:S66',
  IRP:      'Banana!K68:S80',
};

// ── 색상 팔레트 ───────────────────────────────────────────────────────────────
const COLORS = {
  채권: "#4A90D9", 금: "#F5C842", 달러: "#7EC8A4", 배당주: "#F4845F",
  리츠: "#B07FE8", 국내주식: "#E85F7A", 해외주식: "#52C8D4", TDF: "#A8D672",
};

// ── 기본 데이터 (구글 시트 연결 전 빈 상태) ──────────────────────────────────
const DEFAULT_ACCOUNTS = {
  ISA: {
    label: "ISA", sub: "NH · 배당포트",
    total_invest: 0, total_eval: 0, profit: 0,
    color: "#F4845F",
    assets: [{ name: "배당주", ratio: 0, invest: 0, eval: 0, target: 100 }],
    holdings: [],
  },
  위탁: {
    label: "위탁+기타", sub: "NH · 수비형포트",
    total_invest: 0, total_eval: 0, profit: 0,
    color: "#52C8D4",
    assets: [
      { name: "채권", ratio: 0, invest: 0, eval: 0, target: 30 },
      { name: "해외주식", ratio: 0, invest: 0, eval: 0, target: 30 },
      { name: "국내주식", ratio: 0, invest: 0, eval: 0, target: 25 },
      { name: "배당주", ratio: 0, invest: 0, eval: 0, target: 5 },
      { name: "리츠", ratio: 0, invest: 0, eval: 0, target: 5 },
      { name: "금", ratio: 0, invest: 0, eval: 0, target: 5 },
      { name: "달러", ratio: 0, invest: 0, eval: 0, target: 0 },
    ],
    holdings: [],
  },
  연금저축: {
    label: "연금저축", sub: "삼성 · 공격형포트",
    total_invest: 0, total_eval: 0, profit: 0,
    color: "#B07FE8",
    assets: [
      { name: "채권", ratio: 0, invest: 0, eval: 0, target: 15 },
      { name: "금", ratio: 0, invest: 0, eval: 0, target: 10 },
      { name: "달러", ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "배당주", ratio: 0, invest: 0, eval: 0, target: 15 },
      { name: "리츠", ratio: 0, invest: 0, eval: 0, target: 5 },
      { name: "국내주식", ratio: 0, invest: 0, eval: 0, target: 25 },
      { name: "해외주식", ratio: 0, invest: 0, eval: 0, target: 30 },
    ],
    holdings: [],
  },
  IRP: {
    label: "IRP", sub: "한투 · TDF",
    total_invest: 0, total_eval: 0, profit: 0,
    color: "#A8D672",
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
  return (n < 0 ? '-' : '') + Math.round(Math.abs(n)).toLocaleString('ko-KR');
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

// ── 시트 데이터 파싱 ──────────────────────────────────────────────────────────
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

function parseSheetData(valueRanges) {
  const keys = Object.keys(SHEET_RANGES);
  const result = {};
  let anyData = false;

  keys.forEach((key, i) => {
    const rows = (valueRanges[i]?.values ?? []).filter(r => r[1]); // 종목명(L열) 기준 필터
    if (!rows.length) return;
    anyData = true;

    let lastType = '';
    const holdings = rows.map(r => {
      const type = String(r[0] ?? '').trim();
      if (type) lastType = type; // 자산군은 첫 행에만 있으므로 fill-down
      return {
        name: String(r[1] ?? ''),  // L: 종목명
        qty: parseNum(r[3]),       // N: 수량
        invest: parseNum(r[4]),    // O: 투자금
        eval: parseNum(r[7]),      // R: 평가금
        profit: parseNum(r[6]),    // Q: 수익금
        rate: parseNum(r[8]),      // S: 수익률
        type: lastType,            // K: 자산군 (fill-down)
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

  return anyData ? result : null;
}

// ── 앱 데이터 → 시트 직렬화 ──────────────────────────────────────────────────
function serializeForSheet(accountsData) {
  return Object.entries(SHEET_RANGES).map(([key, range]) => ({
    range,
    values: (accountsData[key]?.holdings ?? []).map(h => [
      h.type ?? '', // K: 자산군
      h.name,       // L: 종목명
      '',           // M: 매수단가 (앱에서 미관리)
      h.qty,        // N: 수량
      h.invest,     // O: 투자금
      '',           // P: 현재가 (앱에서 미관리)
      h.profit,     // Q: 수익금
      h.eval,       // R: 평가금
      h.rate,       // S: 수익률
    ]),
  }));
}

// ── useGoogleSheets 훅 ────────────────────────────────────────────────────────
function useGoogleSheets(onData) {
  const [auth, setAuth] = useState('idle');   // idle|loading|signed-out|signed-in|error
  const [sync, setSync] = useState('idle');   // idle|syncing|synced|error
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
      if (parsed) onDataRef.current(parsed);
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

  const save = useCallback(async (accountsData) => {
    setSync('syncing');
    try {
      await window.gapi.client.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        resource: { valueInputOption: 'RAW', data: serializeForSheet(accountsData) },
      });
      setLastSync(new Date());
      setSync('synced');
    } catch (e) {
      console.error('Sheets save error:', e);
      setSync('error');
    }
  }, []);

  return { auth, sync, lastSync, signIn, signOut, fetch: doFetch, save };
}

// ── 앱 ────────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("overview");
  const [acctKey, setAcctKey] = useState("위탁");
  const [accounts, setAccounts] = useState(DEFAULT_ACCOUNTS);
  const isMobile = useIsMobile();

  const onData = useCallback((data) => setAccounts(prev => ({ ...prev, ...data })), []);
  const sheets = useGoogleSheets(onData);

  const acct = accounts[acctKey];
  const totalEval = Object.values(accounts).reduce((s, a) => s + a.total_eval, 0);
  const totalInvest = Object.values(accounts).reduce((s, a) => s + a.total_invest, 0);
  const totalProfit = totalEval - totalInvest;

  const pieData = Object.entries(accounts).map(([, v]) => ({
    name: v.label, value: v.total_eval, color: v.color,
  }));

  const syncLabel =
    sheets.sync === 'syncing' ? '동기화 중...' :
    sheets.sync === 'error'   ? '동기화 실패' :
    sheets.lastSync           ? `↑ ${sheets.lastSync.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` :
    '';

  const sheetBtnStyle = {
    padding: "3px 8px", borderRadius: 4,
    border: "1px solid #2A2F3E", background: "transparent",
    color: "#9CA3AF", cursor: "pointer",
    fontSize: 10, fontFamily: "inherit",
  };

  return (
    <div style={{
      minHeight: "100vh", background: "#0D0F14", color: "#E8EAF0",
      fontFamily: "'DM Mono', 'Courier New', monospace", padding: 0,
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
            <div style={{ fontSize: isMobile ? 17 : 22, fontWeight: 700, letterSpacing: -1, color: "#F5F7FF" }}>
              ₩{totalEval.toLocaleString()}
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 9, color: "#5A6478", letterSpacing: 2 }}>총 수익</div>
            <div style={{ fontSize: isMobile ? 13 : 16, fontWeight: 700, color: "#4ADE80" }}>
              +{fmt(totalProfit)}
            </div>
            <div style={{ fontSize: 10, color: "#4ADE80" }}>
              +{((totalProfit / totalInvest) * 100).toFixed(1)}%
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
                구글 로그인
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
                <button onClick={() => sheets.save(accounts)} disabled={sheets.sync === 'syncing'}
                  style={sheetBtnStyle} title="현재 앱 데이터를 시트에 저장 (기존 데이터 덮어씀)">
                  ↑ 저장
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
        <div style={{ display: "flex", gap: 4, marginTop: isMobile ? 10 : 16 }}>
          {["overview", "rebalance", "holdings"].map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: isMobile ? "8px 14px" : "6px 14px",
              minHeight: isMobile ? 40 : undefined,
              borderRadius: 6, border: "none", cursor: "pointer",
              fontSize: 11, letterSpacing: 1, fontFamily: "inherit",
              background: tab === t ? "#3B82F6" : "#1E2233",
              color: tab === t ? "#fff" : "#6B7280",
              transition: "all 0.2s",
            }}>
              {t === "overview" ? "개요" : t === "rebalance" ? "리밸런싱" : "종목"}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "20px 16px" }}>

        {/* ── 개요 탭 ── */}
        {tab === "overview" && (
          <div>
            {/* 계좌 카드 */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
              gap: 10, marginBottom: 20,
            }}>
              {Object.entries(accounts).map(([k, v]) => {
                const profitRate = ((v.total_eval - v.total_invest) / v.total_invest * 100).toFixed(1);
                const isPos = v.total_eval >= v.total_invest;
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
                        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: "#F5F7FF" }}>
                          {v.label}
                        </div>
                        <div style={{ fontSize: 13, color: "#9CA3AF", marginBottom: 2 }}>
                          ₩{fmt(v.total_eval)}
                        </div>
                        <div style={{ fontSize: 11, color: isPos ? "#4ADE80" : "#F87171" }}>
                          {isPos ? "+" : ""}{profitRate}%
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 9, color: "#5A6478", marginBottom: 2 }}>수익</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: isPos ? "#4ADE80" : "#F87171" }}>
                          {isPos ? "+" : ""}{fmt(v.profit)}
                        </div>
                      </div>
                    </div>
                    <div style={{ marginTop: 8, height: 3, borderRadius: 2, background: "#2A2F3E", overflow: "hidden" }}>
                      <div style={{
                        height: "100%",
                        width: `${(v.total_eval / totalEval * 100).toFixed(1)}%`,
                        background: v.color, borderRadius: 2,
                      }} />
                    </div>
                    <div style={{ fontSize: 9, color: "#5A6478", marginTop: 4 }}>
                      비중 {(v.total_eval / totalEval * 100).toFixed(1)}%
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 계좌별 파이 차트 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, padding: "20px 16px", marginBottom: 16 }}>
              <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 16 }}>계좌별 비중</div>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={55} outerRadius={85}
                    dataKey="value" paddingAngle={3}>
                    {pieData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} stroke="#0D0F14" strokeWidth={2} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => `₩${v.toLocaleString()}`}
                    contentStyle={{ background: "#1E2233", border: "1px solid #2A2F3E", borderRadius: 8, fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", justifyContent: "center" }}>
                {pieData.map((d) => (
                  <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: d.color }} />
                    <span style={{ color: "#9CA3AF" }}>{d.name}</span>
                    <span style={{ color: "#E8EAF0" }}>{(d.value / totalEval * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 요약 통계 */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr",
              gap: 8,
            }}>
              {[
                { label: "총 투자금", value: `₩${fmt(totalInvest)}`, color: "#9CA3AF" },
                { label: "총 평가금", value: `₩${fmt(totalEval)}`, color: "#F5F7FF" },
                { label: "수익률", value: `+${((totalProfit / totalInvest) * 100).toFixed(1)}%`, color: "#4ADE80" },
              ].map((s, i) => (
                <div key={s.label} style={{
                  background: "#1A1D26", borderRadius: 10, padding: "12px 10px", textAlign: "center",
                  gridColumn: isMobile && i === 2 ? "1 / -1" : undefined,
                }}>
                  <div style={{ fontSize: 9, color: "#5A6478", marginBottom: 4, letterSpacing: 1 }}>{s.label}</div>
                  <div style={{
                    fontSize: isMobile ? 11 : 13, fontWeight: 700, color: s.color,
                    wordBreak: "break-all",
                  }}>
                    {s.value}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 리밸런싱 탭 ── */}
        {tab === "rebalance" && (
          <div>
            <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
              {Object.keys(accounts).filter(k => k !== "ISA" && k !== "IRP").map((k) => (
                <button key={k} onClick={() => setAcctKey(k)} style={{
                  padding: isMobile ? "8px 14px" : "6px 14px",
                  minHeight: isMobile ? 40 : undefined,
                  borderRadius: 20,
                  border: `1px solid ${acctKey === k ? accounts[k].color : "#2A2F3E"}`,
                  background: acctKey === k ? `${accounts[k].color}22` : "transparent",
                  color: acctKey === k ? accounts[k].color : "#6B7280",
                  cursor: "pointer", fontSize: 11, fontFamily: "inherit",
                }}>
                  {accounts[k].label}
                </button>
              ))}
            </div>

            <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
              <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 16 }}>현재 vs 목표 비중</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={rebalData(acct.assets)} layout="vertical" barSize={10}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3E" />
                  <XAxis type="number" domain={[0, 40]} tick={{ fill: "#5A6478", fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" tick={{ fill: "#9CA3AF", fontSize: 10 }} width={60} />
                  <Tooltip contentStyle={{ background: "#1E2233", border: "1px solid #2A2F3E", borderRadius: 8, fontSize: 11 }}
                    formatter={(v, n) => [`${v}%`, n === "현재" ? "현재비중" : "목표비중"]} />
                  <Bar dataKey="목표" fill="#2A3A5A" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="현재" radius={[0, 4, 4, 0]}>
                    {rebalData(acct.assets).map((entry, i) => (
                      <Cell key={i} fill={entry.gap > 3 ? "#52C8D4" : entry.gap < -3 ? "#F87171" : "#4ADE80"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* 갭 테이블 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", overflowX: "auto" }}>
              <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 12 }}>
                편차 & 리밸런싱 필요액
              </div>
              <div style={{ minWidth: 300 }}>
                {acct.assets.map((a) => {
                  const gap = a.ratio - a.target;
                  const needAmt = (a.target / 100 * acct.total_eval) - a.eval;
                  return (
                    <div key={a.name} style={{
                      display: "flex", alignItems: "center",
                      padding: "10px 0", borderBottom: "1px solid #1E2233",
                    }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[a.name] || "#aaa", marginRight: 10, flexShrink: 0 }} />
                      <div style={{ flex: 1, fontSize: 12 }}>{a.name}</div>
                      <div style={{ fontSize: 11, color: "#9CA3AF", marginRight: 10, flexShrink: 0 }}>
                        {a.ratio}% → {a.target}%
                      </div>
                      <div style={{
                        fontSize: 11, fontWeight: 700,
                        color: Math.abs(gap) >= 3 ? (gap > 0 ? "#52C8D4" : "#F87171") : "#4ADE80",
                        minWidth: 40, textAlign: "right", marginRight: 10, flexShrink: 0,
                      }}>
                        {gap > 0 ? "+" : ""}{gap}%p
                      </div>
                      <div style={{
                        fontSize: 10,
                        color: needAmt > 0 ? "#F87171" : "#4ADE80",
                        minWidth: 90, textAlign: "right", flexShrink: 0,
                      }}>
                        {needAmt > 0 ? `+${fmt(Math.round(needAmt))}` : fmt(Math.round(needAmt))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── 종목 탭 ── */}
        {tab === "holdings" && (
          <div>
            <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
              {Object.keys(accounts).map((k) => (
                <button key={k} onClick={() => setAcctKey(k)} style={{
                  padding: isMobile ? "8px 12px" : "6px 12px",
                  minHeight: isMobile ? 40 : undefined,
                  borderRadius: 20,
                  border: `1px solid ${acctKey === k ? accounts[k].color : "#2A2F3E"}`,
                  background: acctKey === k ? `${accounts[k].color}22` : "transparent",
                  color: acctKey === k ? accounts[k].color : "#6B7280",
                  cursor: "pointer", fontSize: 11, fontFamily: "inherit",
                }}>
                  {accounts[k].label}
                </button>
              ))}
            </div>

            {/* 계좌 요약 */}
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
                  <div style={{ fontSize: isMobile ? 13 : 16, fontWeight: 700, color: "#4ADE80" }}>
                    +{fmt(acct.profit)}
                  </div>
                  <div style={{ fontSize: 11, color: "#4ADE80" }}>
                    +{((acct.profit / acct.total_invest) * 100).toFixed(1)}%
                  </div>
                </div>
              </div>
            </div>

            {/* 자산군 파이 */}
            {acct.assets.length > 1 && (
              <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 12 }}>자산군 구성</div>
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
            )}

            {/* 보유 종목 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid #2A2F3E", fontSize: 10, letterSpacing: 3, color: "#5A6478" }}>
                보유 종목 ({acct.holdings.length})
              </div>
              {acct.holdings.map((h, i) => {
                const isPos = h.profit >= 0;
                const typeName = h.type || "배당주";
                return (
                  <div key={i} style={{
                    padding: isMobile ? "10px 16px" : "12px 16px",
                    borderBottom: i < acct.holdings.length - 1 ? "1px solid #1E2233" : "none",
                    display: "flex", alignItems: "center", gap: 10,
                  }}>
                    <div style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: COLORS[typeName] || "#aaa", flexShrink: 0,
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#E8EAF0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {h.name}
                      </div>
                      <div style={{ fontSize: 10, color: "#5A6478", marginTop: 2 }}>
                        {h.qty}주 · 매입 ₩{fmt(h.invest)}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: isMobile ? 11 : 12, color: "#E8EAF0" }}>₩{fmt(h.eval)}</div>
                      <div style={{ fontSize: isMobile ? 10 : 11, fontWeight: 700, color: isPos ? "#4ADE80" : "#F87171" }}>
                        {isPos ? "+" : ""}{h.rate.toFixed(1)}%
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div style={{ padding: "12px 16px 32px", textAlign: "center", fontSize: 9, color: "#2A2F3E", letterSpacing: 2 }}>
        2026-04-24 · 바나나 은퇴 준비 포트폴리오
      </div>
    </div>
  );
}
