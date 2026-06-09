import { useState, useEffect, useCallback, useRef } from "react";
import { parseJobStatus, computeJobHealth } from './lib/jobHealth.js';
import {
  SHEET_RANGES, REBAL_TARGET_START, JOB_CADENCE, CHEOL_COLS,
  profitColor, relTime, LEARNING_MODULES, DEFAULT_ACCOUNTS,
} from './lib/constants.js';
import { parseNum } from './lib/textFormat.js';
import { computeAssets } from './lib/metrics.js';
import HelpTab from './tabs/HelpTab.jsx';
import DividendTab from './tabs/DividendTab.jsx';
import ProfitTab from './tabs/ProfitTab.jsx';
import ReportTab from './tabs/ReportTab.jsx';
import KpiTab from './tabs/KpiTab.jsx';
import RiskTab from './tabs/RiskTab.jsx';
import DashboardTab from './tabs/DashboardTab.jsx';
import RebalanceTab from './tabs/RebalanceTab.jsx';
import HoldingsTab from './tabs/HoldingsTab.jsx';
import ExecutionsTab from './tabs/ExecutionsTab.jsx';
import TradeDecisionTab from './tabs/TradeDecisionTab.jsx';
import PositionJournalTab from './tabs/PositionJournalTab.jsx';
import BuyEvaluationTab from './tabs/BuyEvaluationTab.jsx';
import SellEvaluationTab from './tabs/SellEvaluationTab.jsx';

// ── 구글 시트 설정 ─────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
const SHEET_ID = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';
const CONFIGURED = !GOOGLE_CLIENT_ID.startsWith('YOUR_') && !SHEET_ID.startsWith('YOUR_');

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
    const kospi  = parseNum(r[8]);   // I열: KOSPI 월말 지수 (0이면 미입력)
    const sp500  = parseNum(r[9]);   // J열: S&P500 월말 지수 (0이면 미입력)
    result.push({ label: `${yearShort}.${String(month).padStart(2, '0')}`, value: total, savings, year: lastYear, kospi, sp500 });
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
  (vrAll?.values ?? []).forEach((r, i) => {
    const dateStr = String(r[0] ?? '').trim();
    const amt  = parseNum(r[1] ?? 0);  // B열: 금액
    const name = String(r[2] ?? '').trim(); // C열: 종목명
    if (!dateStr || !amt) return;
    const parts = dateStr.split('-');
    if (parts.length < 2) return;
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    if (!year || !month) return;
    const key = `${year}-${month}`;
    if (!result[key]) result[key] = { year, month, amount: 0, items: [] };
    result[key].amount += amt;
    // row: 배당금!A2:C 기준 시트 행번호 (종목명 편집 시 C열 타겟)
    result[key].items.push({ date: dateStr, name, amount: amt, row: i + 2 });
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

// 결론(E) 표준 어휘 — 단일 통합 4단계 (매수·매도 공통). 이모지가 표준 단어를 결정.
const CONCLUSION_STD = { '🟢': '🟢 유효', '🟡': '🟡 관망', '🔴': '🔴 부적합', '⚪': '⚪ 판단보류' };
function normalizeConclusion(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  // 이모지 우선 (includes — 정규식 charclass의 surrogate 깨짐 회피)
  if (s.includes('🟢')) return CONCLUSION_STD['🟢'];
  if (s.includes('🟡')) return CONCLUSION_STD['🟡'];
  if (s.includes('🔴')) return CONCLUSION_STD['🔴'];
  if (s.includes('⚪')) return CONCLUSION_STD['⚪'];
  // 이모지 없으면 단어로 추정 (구체→일반 순서)
  if (/판단\s*보류/.test(s)) return CONCLUSION_STD['⚪'];
  if (/부적합|훼손|불가|매도|\bX\b/i.test(s)) return CONCLUSION_STD['🔴'];
  if (/관망|약화|보류|축소|△/.test(s)) return CONCLUSION_STD['🟡'];
  if (/유효|적합|매수|\bO\b/i.test(s)) return CONCLUSION_STD['🟢'];
  return s;
}

// 종목투자노트 탭 (playbook §6 컬럼 A~T) → 평가 카드 객체 배열
function parseEvaluations(vr) {
  const rows = vr?.values ?? [];
  const splitNumbered = (s) => {
    const t = String(s ?? '').trim();
    if (!t) return [];
    // "1) ... 2) ..." or "1. ... 2. ..." or 줄바꿈 분리
    if (/\d[).]\s/.test(t)) {
      return t.split(/(?=\d[).]\s)/).map(x => x.replace(/^\d[).]\s*/, '').trim()).filter(Boolean);
    }
    return t.split(/[\n;]+/).map(x => x.trim()).filter(Boolean);
  };
  const splitBullets = (s) => splitNumbered(s).length
    ? splitNumbered(s)
    : String(s ?? '').split(/\.\s+(?=[A-Z가-힣])/).map(x => x.trim()).filter(Boolean);

  return rows.map(r => {
    const date = String(r[0] ?? '').trim();
    const name = String(r[1] ?? '').trim();
    if (!date || !name) return null;
    return {
      stock: {
        name,
        ticker: String(r[2] ?? '').trim(),
        market: String(r[3] ?? '').trim(),
      },
      date,
      conclusion: { raw: normalizeConclusion(r[4]) },
      axisGrades: {
        수익성:     String(r[5] ?? '').trim(),
        안정성:     String(r[6] ?? '').trim(),
        밸류에이션: String(r[7] ?? '').trim(),
        현금흐름:   String(r[8] ?? '').trim(),
        모멘텀:     String(r[9] ?? '').trim(),
      },
      reasons:   splitNumbered(r[10]),
      risks:     splitNumbered(r[11]),
      actions:   splitBullets(r[12]),
      frankMemo: String(r[13] ?? '').trim(),
      status:    String(r[14] ?? '').trim(),  // 매수 / 보류 / 매도
      buyDate:   String(r[15] ?? '').trim(),
      buyPrice:  String(r[16] ?? '').trim(),
      targetTerm:(() => { const v = String(r[17] ?? '').trim(); return v.startsWith('#') ? '' : v; })(),
      targetRet: (() => { const v = String(r[18] ?? '').trim(); return v.startsWith('#') ? '' : v; })(),
      aiNote:    String(r[19] ?? '').trim(),
      axisItems: (() => { try { const v = String(r[20] ?? '').trim(); return v ? JSON.parse(v) : null; } catch { return null; } })(),
    };
  }).filter(Boolean).reverse();  // 최신순
}

// 평가요청 큐 (컬럼 A~F) → { entries, counts }
function parseEvalQueue(vr) {
  const rows = vr?.values ?? [];
  const entries = rows.map((r, idx) => {
    const requestedAt = String(r[0] ?? '').trim();
    const name = String(r[1] ?? '').trim();
    if (!requestedAt || !name) return null;
    return {
      rowIndex: idx,
      requestedAt,
      name,
      market: String(r[2] ?? '').trim(),
      status: String(r[3] ?? '').trim() || '대기',
      processedAt: String(r[4] ?? '').trim(),
      memo: String(r[5] ?? '').trim(),
    };
  }).filter(Boolean);

  const counts = entries.reduce((acc, e) => {
    const k = e.status === '완료' ? 'done'
            : e.status === '처리중' ? 'processing'
            : e.status === '오류' ? 'error'
            : 'pending';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, { pending: 0, processing: 0, done: 0, error: 0 });

  // 최신 요청 순으로 정렬해서 반환
  return { entries: entries.slice().reverse(), counts };
}

// 주간리포트 파서 (날짜, 요약, 본문) → 최신순 배열
function parseWeeklyReports(vr) {
  const rows = vr?.values ?? [];
  return rows.map(r => {
    const date = String(r[0] ?? '').trim();
    if (!date) return null;
    return { date, summary: String(r[1] ?? '').trim(), body: String(r[2] ?? '').trim() };
  }).filter(Boolean).reverse();
}

// 포지션저널 파서 (A~P) → 거래 생애주기 전제 배열. 보유 우선, 그 안에서 시트 순서 유지
function parsePositionJournal(vr) {
  const rows = vr?.values ?? [];
  const list = rows.map((r, idx) => {
    const name = String(r[0] ?? '').trim();
    if (!name) return null;
    return {
      rowIndex: idx,            // 시트 행 = idx + 2 (A2 기준)
      name,
      ticker:  String(r[1] ?? '').trim(),
      market:  String(r[2] ?? '').trim(),
      account: String(r[3] ?? '').trim(),
      kind:    String(r[4] ?? '').trim(),   // 배분 / 확신
      thesis:  String(r[5] ?? '').trim(),
      target:  String(r[6] ?? '').trim(),
      exit:    String(r[7] ?? '').trim(),
      hold:    String(r[8] ?? '').trim(),
      entry:   String(r[9] ?? '').trim(),
      status:  String(r[10] ?? '').trim() || '보유',  // 보유 / 청산
      exitDate:String(r[11] ?? '').trim(),
      result:  String(r[12] ?? '').trim(),
      lesson:  String(r[13] ?? '').trim(),
      confirm: String(r[14] ?? '').trim() || '미작성',  // 대기 / 확인 / 미작성
      updated: String(r[15] ?? '').trim(),
    };
  }).filter(Boolean);
  // 보유 먼저, 청산 뒤로
  return list.sort((a, b) => (a.status === '청산' ? 1 : 0) - (b.status === '청산' ? 1 : 0));
}

// 보유 포지션 × 리스크 신호(🟡/🔴) 조인 → 전제 점검 대상 [{ position, signal }]
// riskMonitor 는 최신순 → find 가 최신 신호를 반환. target 은 종목명 또는 코드.
// 리스크모니터 파서 (날짜,유형,대상,신호,요약,상세,근거,기준선참조) → 최신순
function parseRiskMonitor(vr) {
  const rows = vr?.values ?? [];
  return rows.map(r => {
    const date = String(r[0] ?? '').trim();
    if (!date) return null;
    return {
      date,
      type: String(r[1] ?? '').trim(),       // B(논리) | D(거시)
      target: String(r[2] ?? '').trim(),
      signal: String(r[3] ?? '').trim(),     // 🟢 | 🟡 | 🔴
      summary: String(r[4] ?? '').trim(),
      detail: String(r[5] ?? '').trim(),
      evidence: String(r[6] ?? '').trim(),   // JSON 문자열
      baselineRef: String(r[7] ?? '').trim(),
    };
  }).filter(Boolean).reverse();
}

// 리스크기준선 파서 (종목,티커,시장,기준일,매총이,영익,ROE,부채,EPS,비고)
function parseBaselines(vr) {
  const rows = vr?.values ?? [];
  return rows.map(r => {
    const name = String(r[0] ?? '').trim();
    if (!name) return null;
    return {
      name,
      ticker: String(r[1] ?? '').trim(),
      market: String(r[2] ?? '').trim(),
      date: String(r[3] ?? '').trim(),
      grossMargin: String(r[4] ?? '').trim(),
      operatingMargin: String(r[5] ?? '').trim(),
      roe: String(r[6] ?? '').trim(),
      debtRatio: String(r[7] ?? '').trim(),
      eps: String(r[8] ?? '').trim(),
      note: String(r[9] ?? '').trim(),
    };
  }).filter(Boolean);
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
    const isCash = (h) => h.name === '예수금' || (key === '연금저축' && String(h.name).includes('MMF'));
    const nonCashHoldings = holdings.filter(h => !isCash(h));
    const asset_eval = nonCashHoldings.reduce((s, h) => s + h.eval, 0);

    result[key] = {
      ...DEFAULT_ACCOUNTS[key],
      total_invest,
      total_eval,
      profit: total_eval - total_invest,
      holdings,
      assets: computeAssets(nonCashHoldings, asset_eval || total_eval, DEFAULT_ACCOUNTS[key].assets),
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
  const evaluations = parseEvaluations(valueRanges[11]);
  const evalQueue = parseEvalQueue(valueRanges[12]);
  const weeklyReports = parseWeeklyReports(valueRanges[13]);
  const riskMonitor = parseRiskMonitor(valueRanges[14]);
  const baselines = parseBaselines(valueRanges[15]);
  const positionJournal = parsePositionJournal(valueRanges[16]);
  const usdRate = parseNum(valueRanges[17]?.values?.[0]?.[0]);

  return anyData ? { accounts: result, monthly, monthlyRow, dividends, profits, evaluations, evalQueue, weeklyReports, riskMonitor, baselines, positionJournal, usdRate } : null;
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
          evaluations: parsed.evaluations,
          weeklyReports: parsed.weeklyReports,
          riskMonitor: parsed.riskMonitor,
          baselines: parsed.baselines,
          positionJournal: parsed.positionJournal,
          usdRate: parsed.usdRate,
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

  // eslint-disable-next-line react-hooks/set-state-in-effect
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
  const labelStyle = { fontSize: 10, color: '#8A9AB5', marginBottom: 4, display: 'block' };

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
      <div style={{ fontSize: 11, letterSpacing: 2, color: '#8A9AB5', marginBottom: 12 }}>종목 추가</div>
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
  const [holdSort, setHoldSort] = useState('sheet'); // sheet | rate_desc | rate_asc | eval_desc | profit_desc
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
  const [editingCash, setEditingCash] = useState(null); // 예수금(현금성) 수동 편집 중인 행
  const [editCashValue, setEditCashValue] = useState('');
  const [editingDollar, setEditingDollar] = useState(null); // 달러RP(외화 RP) 수동 편집 중인 행
  const [editDollarValue, setEditDollarValue] = useState(''); // USD 잔액
  const [editingAllTargets, setEditingAllTargets] = useState(false);
  const [allTargetInputs, setAllTargetInputs] = useState([]);
  const [evalMode, setEvalMode] = useState('매수'); // 평가 탭 토글: '매수' | '매도'
  const lpRef = useRef(null);
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
  const [tradeRows, setTradeRows] = useState([]);
  const [tradeSyncing, setTradeSyncing] = useState(false);
  const [kpiTrades, setKpiTrades] = useState(null); // null=미로딩, []이상=로딩완료
  const [jobStatus, setJobStatus] = useState(null); // null=미로딩
  const [tradeSyncMsg, setTradeSyncMsg] = useState('');
  // 저축금 반영 완료 거래 — 새로고침 후 이중 반영 방지 위해 거래 내용 키로 localStorage 영속화
  const [savingsAppliedRows, setSavingsAppliedRows] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('banana_savings_applied') || '[]')); }
    catch { return new Set(); }
  });
  const [savingsMode, setSavingsMode] = useState(false);
  const [tradeEditOpen, setTradeEditOpen] = useState(false);
  const [tradeEditRowIdx, setTradeEditRowIdx] = useState(null);
  const [tradeEditValues, setTradeEditValues] = useState(Array(13).fill(''));
  const [tradeEditBusy, setTradeEditBusy] = useState(false);
  const tradeLpRef = useRef(null);
  const [profitData, setProfitData] = useState([]);
  const isMobile = useIsMobile();
  const [evalSelectedMetric, setEvalSelectedMetric] = useState(null);
  const [evaluations, setEvaluations] = useState([]);
  const [evalSelectedIdx, setEvalSelectedIdx] = useState(0);
  const [evalIngestOpen, setEvalIngestOpen] = useState(false);
  const [evalIngestRaw, setEvalIngestRaw] = useState('');
  const [evalIngestParsed, setEvalIngestParsed] = useState(null);
  const [evalIngestMsg, setEvalIngestMsg] = useState('');
  const [evalIngestBusy, setEvalIngestBusy] = useState(false);
  const [evalQueue, setEvalQueue] = useState({ entries: [], counts: { pending: 0, processing: 0, done: 0, error: 0 } });
  const [evalQueueOpen, setEvalQueueOpen] = useState(false);
  const [evalQueueName, setEvalQueueName] = useState('');
  const [evalQueueMarket, setEvalQueueMarket] = useState('KR');
  const [evalQueueMemo, setEvalQueueMemo] = useState('');
  const [evalQueueBusy, setEvalQueueBusy] = useState(false);
  const [evalQueueMsg, setEvalQueueMsg] = useState('');
  const [requeueBusyIdx, setRequeueBusyIdx] = useState(null); // 재시도 진행 중인 큐 행 rowIndex

  const [weeklyReports, setWeeklyReports] = useState([]);
  const [riskMonitor, setRiskMonitor] = useState([]);
  const [baselines, setBaselines] = useState([]);
  const [positionJournal, setPositionJournal] = useState([]);
  const [usdRate, setUsdRate] = useState(0); // USD/KRW 환율

  const onData = useCallback(({ accounts: a, monthly: m, dividends: d, monthlyRow: mr, profits: p, evaluations: ev, evalQueue: q, weeklyReports: wr, riskMonitor: rm, baselines: bl, positionJournal: pj, usdRate: ur }) => {
    setAccounts(prev => ({ ...prev, ...a }));
    setMonthlyData(m || []);
    setDividendData(d || []);
    setProfitData(p || []);
    monthlyRowRef.current = mr ?? null;
    setEvaluations(ev || []);
    setEvalSelectedIdx(0);
    if (q) setEvalQueue(q);
    if (wr) setWeeklyReports(wr);
    if (rm) setRiskMonitor(rm);
    if (bl) setBaselines(bl);
    if (pj) setPositionJournal(pj);
    if (ur > 0) setUsdRate(ur);
  }, []);

  const sheets = useGoogleSheets(onData);

  // ── 평가 카드 JSON 파싱·적재 ────────────────────────────────────────────
  const tryParseEvalJson = useCallback((raw) => {
    if (!raw || !raw.trim()) return { ok: false, error: '입력이 비어있습니다.' };
    // ```json ... ``` 펜스 우선 추출
    const fence = raw.match(/```json\s*([\s\S]*?)\s*```/i) || raw.match(/```\s*([\s\S]*?)\s*```/);
    let candidate = fence ? fence[1] : raw;
    // 가장 바깥 { ... } 추출
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first < 0 || last < 0 || last < first) return { ok: false, error: 'JSON 블록을 찾지 못했습니다.' };
    candidate = candidate.slice(first, last + 1);
    try {
      const obj = JSON.parse(candidate);
      const required = ['date', 'name', 'conclusion'];
      const missing = required.filter(k => !obj[k]);
      if (missing.length) return { ok: false, error: `필수 필드 누락: ${missing.join(', ')}` };
      const grades = obj.grades || {};
      return { ok: true, data: {
        date:       String(obj.date ?? ''),
        name:       String(obj.name ?? ''),
        ticker:     String(obj.ticker ?? ''),
        market:     String(obj.market ?? ''),
        conclusion: String(obj.conclusion ?? ''),
        grades: {
          수익성:     String(grades.수익성 ?? ''),
          안정성:     String(grades.안정성 ?? ''),
          밸류에이션: String(grades.밸류에이션 ?? ''),
          현금흐름:   String(grades.현금흐름 ?? ''),
          모멘텀:     String(grades.모멘텀 ?? ''),
        },
        reasons:    Array.isArray(obj.reasons) ? obj.reasons.map(String) : [],
        risks:      Array.isArray(obj.risks)   ? obj.risks.map(String)   : [],
        actions:    Array.isArray(obj.actions) ? obj.actions.map(String) : [],
        frankMemo:  String(obj.frankMemo ?? ''),
        status:     String(obj.status ?? '보류'),
        buyDate:    String(obj.buyDate ?? ''),
        buyPrice:   String(obj.buyPrice ?? ''),
        targetTerm: String(obj.targetTerm ?? ''),
        targetRet:  String(obj.targetRet ?? ''),
        aiNote:     String(obj.aiNote ?? ''),
        axisItems:  obj.axisItems && typeof obj.axisItems === 'object' ? obj.axisItems : null,
      }};
    } catch (e) {
      return { ok: false, error: `JSON 파싱 실패: ${e.message}` };
    }
  }, []);

  const buildEvalRow = useCallback((d) => {
    const joinNumbered = (arr) => (arr || []).map((s, i) => `${i + 1}) ${s}`).join(' ');
    return [
      d.date, d.name, d.ticker, d.market,
      d.conclusion,
      d.grades.수익성, d.grades.안정성, d.grades.밸류에이션, d.grades.현금흐름, d.grades.모멘텀,
      joinNumbered(d.reasons),
      joinNumbered(d.risks),
      joinNumbered(d.actions),
      d.frankMemo,
      d.status,
      d.buyDate, d.buyPrice,
      d.targetTerm, d.targetRet,
      d.aiNote,
      d.axisItems ? JSON.stringify(d.axisItems) : '',
    ];
  }, []);

  const submitEvalQueue = useCallback(async () => {
    const name = evalQueueName.trim();
    if (!name) { setEvalQueueMsg('⚠️ 종목명을 입력해주세요.'); return; }
    setEvalQueueBusy(true);
    setEvalQueueMsg('큐에 추가 중...');
    try {
      const _now = new Date();
      const requestedAt = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')} ${String(_now.getHours()).padStart(2,'0')}:${String(_now.getMinutes()).padStart(2,'0')}`;
      const row = [requestedAt, name, evalQueueMarket, '대기', '', evalQueueMemo.trim()];
      await sheets.appendValues('평가요청!A2:F', [row]);
      setEvalQueueMsg('✓ 큐에 추가됨');
      setTimeout(() => {
        setEvalQueueOpen(false);
        setEvalQueueName('');
        setEvalQueueMemo('');
        setEvalQueueMsg('');
      }, 1500);
    } catch (e) {
      setEvalQueueMsg(`큐 추가 실패: ${e.message || e}`);
    } finally {
      setEvalQueueBusy(false);
    }
  }, [evalQueueName, evalQueueMarket, evalQueueMemo, sheets]);

  // 오류 난 평가요청을 다시 '대기'로 돌려 다음 drain 때 재처리.
  // F열(메모)은 보존 — '매도 평가' 같은 의미 트리거가 들어 있을 수 있어 지우면 안 됨.
  const requeueEval = async (entry) => {
    setRequeueBusyIdx(entry.rowIndex);
    setEvalQueueMsg('');
    try {
      const sheetRow = entry.rowIndex + 2; // A2:F → rowIndex 0 = 시트 2행
      await sheets.writeRange(`평가요청!D${sheetRow}:E${sheetRow}`, ['대기', '']);
      await sheets.fetch();
    } catch {
      setEvalQueueMsg('재시도 등록 실패 — 잠시 후 다시 시도해주세요');
      setTimeout(() => setEvalQueueMsg(''), 4000);
    } finally {
      setRequeueBusyIdx(null);
    }
  };

  const ingestEvaluation = useCallback(async () => {
    if (!evalIngestParsed) return;
    setEvalIngestBusy(true);
    setEvalIngestMsg('적재 중...');
    try {
      const row = buildEvalRow(evalIngestParsed);
      await sheets.appendValues('종목투자노트!A2:U', [row]);
      setEvalIngestMsg('✓ 적재 완료 — 카드 갱신됨');
      setTimeout(() => {
        setEvalIngestOpen(false);
        setEvalIngestRaw('');
        setEvalIngestParsed(null);
        setEvalIngestMsg('');
      }, 1200);
    } catch (e) {
      setEvalIngestMsg(`적재 실패: ${e.message || e}`);
    } finally {
      setEvalIngestBusy(false);
    }
  }, [evalIngestParsed, buildEvalRow, sheets]);

  const totalEval = Object.values(accounts).reduce((s, a) => s + a.total_eval, 0);

  // 어제 대비 평가금 추적
  useEffect(() => {
    if (sheets.sync !== 'synced' || totalEval === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const history = JSON.parse(localStorage.getItem('banana_eval_history') || '{}');
    const prevDate = Object.keys(history).filter(d => d < today).sort().pop();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrevDayEval(prevDate ? history[prevDate] : null);
    history[today] = totalEval;
    const dates = Object.keys(history).sort();
    while (dates.length > 7) delete history[dates.shift()];
    localStorage.setItem('banana_eval_history', JSON.stringify(history));
  }, [sheets.sync, totalEval]);

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
    try {
      await sheets.clearRows(ranges);
    } catch {
      setBalanceSyncMsg('삭제 실패 — 다시 시도해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    setShowDeleteMode(false);
    setSelectedToDelete(new Set());
  };

  // 파서 findCashRow 로직과 동일하게 현금(예수금) 행을 판별
  const isCashRow = (h) => h.name === '예수금' || (acctKey === '연금저축' && String(h.name).includes('MMF'));
  const isDollarRow = (h) => acctKey === '위탁' && h.name === '외화 RP';

  const startLP = (origIdx, h) => {
    lpRef.current = setTimeout(async () => {
      const sheetRow = START_ROWS[acctKey] + h.rowOffset;
      if (isCashRow(h)) {
        // NH(ISA·위탁)는 입금/출금 알림으로 자동 갱신 — 수동 편집 막고 안내만
        if (acctKey !== '연금저축' && acctKey !== 'IRP') {
          setBalanceSyncMsg('NH 입금/출금 알림으로 자동 갱신됩니다');
          setTimeout(() => setBalanceSyncMsg(''), 3500);
          return;
        }
        setEditingCash({ origIdx, sheetRow });
        setEditCashValue(String(Math.round(h.eval) || ''));
        return;
      }
      if (isDollarRow(h)) {
        // 달러RP: USD 잔액을 기준으로 리셋(달러기준 표). 표시행 D열만 갱신, 원화는 수식.
        setEditingDollar({ origIdx, sheetRow });
        setEditDollarValue(String(h.qty || ''));
        return;
      }
      let isManual = false;
      try {
        const vals = await sheets.readRange(`${acctKey}!F${sheetRow}`, 'FORMULA');
        const cell = String(vals[0]?.[0] ?? '');
        isManual = cell !== '' && !cell.startsWith('=');
      } catch { /* 수식 조회 실패 시 수동 여부 미상으로 진행 */ }
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
    try {
      await sheets.appendRow(`${acctKey}!C${sheetRow}:D${sheetRow}`, [p, q]);
      if (isManual && editCurrentPrice !== '') {
        const cp = parseFloat(editCurrentPrice);
        // 잘못된 입력으로 현재가를 0으로 덮어써 평가금이 0이 되는 사고 방지
        if (Number.isFinite(cp) && cp > 0) {
          await sheets.writeRange(`${acctKey}!F${sheetRow}`, [cp]);
        }
      }
    } catch {
      setBalanceSyncMsg('수정 저장 실패 — 다시 시도해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
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

  // 예수금(연금저축·IRP) 수동 편집 저장: 표시 행이 아닌 예수금기준 표를 리셋해 파서 클로버 회피.
  const saveCash = async () => {
    if (!editingCash) return;
    const { sheetRow } = editingCash;
    const amt = parseFloat(editCashValue);
    if (!Number.isFinite(amt) || amt < 0) {
      setBalanceSyncMsg('예수금 금액을 올바르게 입력해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    // 파서 todayKST와 맞춰 KST 기준일로 리셋(UTC 자정 근처 하루 오차 방지)
    const todayKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    try {
      const baseA = await sheets.readRange('예수금기준!A2:A5');
      const idx = baseA.findIndex(r => String(r?.[0] ?? '').trim() === acctKey);
      if (idx < 0) {
        setBalanceSyncMsg('예수금기준 표에 계좌 행이 없습니다');
        setTimeout(() => setBalanceSyncMsg(''), 4000);
        return;
      }
      const baseRow = 2 + idx;
      await sheets.writeRange(`예수금기준!B${baseRow}:C${baseRow}`, [amt, todayKST]);
      await sheets.writeRange(`${acctKey}!E${sheetRow}`, [amt]);
      await sheets.writeRange(`${acctKey}!H${sheetRow}`, [amt]);
      await sheets.fetch();
      setBalanceSyncMsg('예수금 갱신됨');
      setTimeout(() => setBalanceSyncMsg(''), 3000);
    } catch {
      setBalanceSyncMsg('예수금 저장 실패 — 다시 시도해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    setEditingCash(null);
  };

  // 달러RP(외화 RP) 수동 편집 저장: 달러기준 표(USD)를 리셋해 파서 클로버 회피.
  // 표시행은 D열(USD 잔액)만 갱신 — C·E·F·H 수식(원화 표시)은 보존.
  const saveDollar = async () => {
    if (!editingDollar) return;
    const { sheetRow } = editingDollar;
    const usd = parseFloat(editDollarValue);
    if (!Number.isFinite(usd) || usd < 0) {
      setBalanceSyncMsg('USD 잔액을 올바르게 입력해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    const todayKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    try {
      const baseA = await sheets.readRange('달러기준!A2:A10');
      const idx = baseA.findIndex(r => String(r?.[0] ?? '').trim() === '위탁');
      if (idx < 0) {
        await sheets.appendValues('달러기준!A2', [['위탁', usd, todayKST, todayKST]]);
      } else {
        await sheets.writeRange(`달러기준!B${2 + idx}:C${2 + idx}`, [usd, todayKST]);
      }
      await sheets.writeRange(`위탁!D${sheetRow}`, [usd]);
      await sheets.fetch();
      setBalanceSyncMsg('달러RP 갱신됨');
      setTimeout(() => setBalanceSyncMsg(''), 3000);
    } catch {
      setBalanceSyncMsg('달러RP 저장 실패 — 다시 시도해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    setEditingDollar(null);
  };

  const handleAddHoldingSave = async (range, row, investAmount) => {
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
  };

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

          const isOverseas = assetType.includes('해외');
          // 해외주식: G열 체결가는 parse-notifications이 ={usd}*설정!B2 수식으로 기록 → evaluated 값은 KRW
          // holdings C열은 USD 저장이므로 KRW→USD 변환 후 연산
          // 환율 미로드(usdRate=0) 시 변환 불가 → KRW를 USD로 잘못 저장하는 사고 방지 위해 스킵
          if (isOverseas && !(usdRate > 0)) {
            errors.push(`${stockName}: 환율 미로드 — 해외주식 처리 보류 (다음 동기화 재시도)`);
            continue;
          }
          const priceForCalc = isOverseas ? price / usdRate : price;

          if (isBuy) {
            if (matchRow) {
              const newQty = matchRow.qty + qty;
              const rawAvg = newQty > 0
                ? (matchRow.price * matchRow.qty + priceForCalc * qty) / newQty
                : priceForCalc;
              const newAvgPrice = isOverseas
                ? Math.round(rawAvg * 100) / 100   // USD: 소수점 2자리
                : Math.round(rawAvg);               // KRW: 정수
              await sheets.writeRange(`${acctKey}!C${matchRow.row}:D${matchRow.row}`, [newAvgPrice, newQty]);
            } else {
              await addHoldingFromTrade(acctKey, assetType, stockName, priceForCalc, qty, currentPrice);
            }
          } else if (isSell && matchRow) {
            const avgBuyPrice = matchRow.price; // 매도 전 평균매수단가 보존 (USD for 해외주식)
            const newQty = matchRow.qty - qty;
            if (newQty <= 0) {
              await sheets.clearRowsRaw([`${acctKey}!B${matchRow.row}:I${matchRow.row}`]);
            } else {
              await sheets.writeRange(`${acctKey}!D${matchRow.row}`, [newQty]);
            }
            // 수익금 시트에 매도 내역 기록 — 해외주식은 USD 기준으로 통일
            const profitRows = await sheets.readRange('수익금!A2:A');
            const nextRow = (profitRows?.length ?? 0) + 2;
            const dateStr = String(row[0] ?? '').trim();
            const sellPriceForProfit = isOverseas
              ? Math.round(priceForCalc * 100) / 100  // USD 소수점 2자리
              : price;
            // 해외주식: D·E는 USD, F는 KRW (×환율). 국내주식: D·E·F 모두 KRW
            const profitFormula = isOverseas
              ? `=(E${nextRow}-D${nextRow})*C${nextRow}*설정!$B$2`
              : `=(E${nextRow}-D${nextRow})*C${nextRow}`;
            await sheets.writeRange(`수익금!A${nextRow}:F${nextRow}`, [
              dateStr, stockName, qty, avgBuyPrice, sellPriceForProfit,
              profitFormula,
            ]);
          } else if (isSell && !matchRow) {
            errors.push(`${stockName}: 계좌(${acctKey})에서 종목을 찾을 수 없음 — 처리 건너뜀`);
            continue; // 완료 마킹 스킵
          }

          // 예수금 반영 — ISA·위탁 국내주식만 (해외주식은 외화RP 별도 처리)
          if ((isBuy || isSell) && !assetType.includes('해외') && (acctKey === 'ISA' || acctKey === '위탁')) {
            const cashRowIdx = holdingRows.findIndex(hr => String(hr[1] ?? '').trim() === '예수금');
            if (cashRowIdx >= 0) {
              const cashRowNum = 2 + cashRowIdx;
              const currentCash = parseNum(holdingRows[cashRowIdx][2]);
              const tradeAmt = Math.round(price * qty);
              const newCash = isBuy ? Math.max(0, currentCash - tradeAmt) : currentCash + tradeAmt;
              await sheets.writeRange(`${acctKey}!C${cashRowNum}`, [newCash]);
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
  }, [sheets, tradeSyncing, addHoldingFromTrade, usdRate]);

  const saveTradeEdit = useCallback(async () => {
    if (tradeEditRowIdx === null) return;
    setTradeEditBusy(true);
    try {
      const n = tradeEditRowIdx + 2; // 시트 행 번호 (A2 기준)
      await sheets.writeRange(`체결내역!A${n}:M${n}`, tradeEditValues);
      const newValues = await sheets.readRange('체결내역!A2:M');
      const newFlags  = await sheets.readTradeProcessedFlags();
      setTradeRows(newValues.map((row, i) => ({ row, processed: newFlags[i] ?? false })));
      setTradeEditOpen(false);
      setTradeEditRowIdx(null);
      setTradeSyncMsg('셀 업데이트 완료');
      setTimeout(() => setTradeSyncMsg(''), 3000);
    } catch (e) {
      setTradeSyncMsg(`저장 실패: ${e.message}`);
      setTimeout(() => setTradeSyncMsg(''), 4000);
    } finally {
      setTradeEditBusy(false);
    }
  }, [sheets, tradeEditRowIdx, tradeEditValues]);

  const applySavingsFromTrade = useCallback(async (tradeDate, amount, isBuy, tradeKey) => {
    setTradeSyncMsg('저축금 반영 중...');
    try {
      const parts = tradeDate.split('-');
      if (parts.length < 2) throw new Error('날짜 형식 오류');
      const year = parseInt(parts[0]);
      const month = parseInt(parts[1]);

      const values = await sheets.readRange('월별잔고!A2:H');
      let lastYear = 0;
      let targetRow = null;
      for (let i = 0; i < values.length; i++) {
        const r = values[i];
        const bNum = parseInt(String(r[0] ?? '').replace(/[^0-9]/g, ''));
        if (bNum >= 2000) lastYear = bNum;
        const mNum = parseInt(String(r[1] ?? '').replace(/[^0-9]/g, ''));
        if (lastYear === year && mNum === month) { targetRow = 2 + i; break; }
      }
      if (!targetRow) throw new Error(`${year}년 ${month}월 행 없음`);

      const rows = await sheets.readRange(`월별잔고!C${targetRow}:C${targetRow}`);
      const current = parseNum(rows[0]?.[0]);
      const delta = isBuy ? amount : -amount;
      await sheets.writeRange(`월별잔고!C${targetRow}:C${targetRow}`, [current + delta]);

      setSavingsAppliedRows(prev => {
        const next = new Set([...prev, tradeKey]);
        try { localStorage.setItem('banana_savings_applied', JSON.stringify([...next])); } catch { /* 저장소 불가 시 메모리만 유지 */ }
        return next;
      });
      setTradeSyncMsg(`${year}.${String(month).padStart(2,'0')} 저축금 ${isBuy ? '+' : '−'}₩${amount.toLocaleString()} 반영됨`);
      setTimeout(() => setTradeSyncMsg(''), 4000);
    } catch (e) {
      setTradeSyncMsg(`저축금 반영 실패: ${e.message}`);
      setTimeout(() => setTradeSyncMsg(''), 4000);
    }
  }, [sheets]);

  const saveAllTargets = async () => {
    const sum = allTargetInputs.reduce((s, v) => s + (parseFloat(v) || 0), 0);
    if (Math.abs(sum - 100) > 0.1) {
      alert(`합계가 ${sum.toFixed(1)}%입니다. 100%가 되어야 합니다.`);
      return;
    }
    setEditingAllTargets(false);
    const startRow = REBAL_TARGET_START[acctKey];
    try {
      await sheets.writeRangeMulti(
        `자산분배!B${startRow}:B${startRow + allTargetInputs.length - 1}`,
        allTargetInputs.map(v => [(parseFloat(v) || 0) / 100])
      );
      await sheets.fetch();
    } catch {
      setBalanceSyncMsg('목표비중 저장 실패 — 다시 시도해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
    }
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
      syncTradeExecutions(); // eslint-disable-line react-hooks/set-state-in-effect
    }
  }, [tab, sheets.auth]); // eslint-disable-line

  useEffect(() => {
    if (tab === 'kpi' && sheets.auth === 'signed-in' && kpiTrades === null) {
      sheets.readRange('체결내역!A2:M')
        .then(vals => setKpiTrades((vals || []).map(row => ({ row }))))
        .catch(() => setKpiTrades([]));
    }
  }, [tab, sheets.auth]); // eslint-disable-line

  useEffect(() => {
    if (sheets.auth === 'signed-in' && jobStatus === null) {
      sheets.readRange('잡상태!A2:E')
        .then(rows => setJobStatus(parseJobStatus(rows)))
        .catch(() => setJobStatus([]));   // 시트 없거나 실패 → 배너 숨김
    }
  }, [sheets.auth, jobStatus]); // eslint-disable-line

  const acct = accounts[acctKey];
  const totalInvest = Object.values(accounts).reduce((s, a) => s + a.total_invest, 0);
  const totalProfit = totalEval - totalInvest;
  const dailyDelta = sheets.auth === 'signed-in' && prevDayEval != null ? totalEval - prevDayEval : null;

  const syncLabel =
    sheets.sync === 'syncing' ? '동기화 중...' :
    sheets.sync === 'error'   ? '동기화 실패' :
    sheets.lastSync           ? `${relTime(sheets.lastSync)} 갱신` :
    '';

  const sheetBtnStyle = {
    padding: "8px 12px", minHeight: 36, borderRadius: 4,
    border: "1px solid #2A2F3E", background: "transparent",
    color: "#9CA3AF", cursor: "pointer",
    fontSize: 11, fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
  };

  const baseFont = "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif";

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
            <div style={{ fontSize: 9, letterSpacing: 3, color: "#8A9AB5", marginBottom: 4 }}>
              BANANA · 은퇴 준비 포트폴리오
            </div>
            <div style={{ fontSize: isMobile ? 20 : 24, fontWeight: 700, letterSpacing: -1, color: "#F5F7FF" }}>
              ₩{totalEval.toLocaleString()}
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 9, color: "#8A9AB5", letterSpacing: 2 }}>평가손익</div>
            <div style={{ fontSize: isMobile ? 13 : 15, fontWeight: 700, color: profitColor(totalProfit) }}>
              ₩{fmt(Math.abs(totalProfit))}
            </div>
            {dailyDelta != null && (
              <div style={{ fontSize: 10, color: profitColor(dailyDelta) }}>
                ₩{fmt(Math.abs(dailyDelta))}
              </div>
            )}
          </div>
        </div>

        {/* 구글 시트 동기화 UI */}
        {CONFIGURED && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {sheets.auth === 'loading' && (
              <span style={{ fontSize: 10, color: "#8A9AB5" }}>Google 초기화 중...</span>
            )}
            {sheets.auth === 'signed-out' && (
              <button onClick={sheets.signIn} aria-label="Google 계정으로 로그인"
                style={{ ...sheetBtnStyle, background: "#1E3A5F", color: "#60A5FA", borderColor: "#3B82F6" }}>
                로그인
              </button>
            )}
            {sheets.auth === 'signed-in' && (
              <>
                <span style={{ fontSize: 10, color: sheets.sync === 'error' ? "#F87171" : "#8A9AB5" }}>
                  {syncLabel}
                </span>
                <button onClick={sheets.fetch} disabled={sheets.sync === 'syncing'}
                  style={sheetBtnStyle} aria-label="시트에서 최신 데이터 새로고침" title="시트에서 최신 데이터 가져오기">
                  ↻ 새로고침
                </button>
                <button onClick={sheets.signOut} aria-label="로그아웃" style={{ ...sheetBtnStyle, color: "#F87171" }}>
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
        <div className="tab-bar" role="tablist" aria-label="화면 전환" style={{ display: "flex", gap: 4, marginTop: isMobile ? 10 : 16, flexWrap: "nowrap", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          {[
            { key: "dashboard", label: "홈" },
            { key: "report",    label: "리포트" },
            { key: "리스크",    label: "리스크" },
            { key: "평가",      label: "평가" },
            { key: "거래",      label: "거래결정" },
            { key: "저널",      label: "포지션" },
            { key: "holdings",  label: "보유종목" },
            { key: "rebalance", label: "자산분배" },
            { key: "체결내역",  label: "체결" },
            { key: "dividend",  label: "배당금" },
            { key: "profit",    label: "수익금" },
            { key: "kpi",       label: "KPI" },
            { key: "help",      label: "도움말" },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setTab(key)}
              role="tab" aria-selected={tab === key} aria-label={label} style={{
              padding: "10px 12px",
              minHeight: 44,
              flexShrink: 0,
              borderRadius: 6, border: "none", cursor: "pointer",
              fontSize: 12, letterSpacing: 1, fontFamily: baseFont,
              background: tab === key ? "#3B82F6" : "#1E2233",
              color: tab === key ? "#fff" : "#9CA3AF",
              transition: "all 0.2s",
            }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "20px 16px" }}>

        {CONFIGURED && (sheets.auth === 'signed-out' || sheets.auth === 'error') && (
          <div style={{
            background: "linear-gradient(135deg, #1E3A5F33, #1A1D26)",
            border: "1px solid #3B82F655", borderRadius: 12,
            padding: "20px 16px", marginBottom: 16, textAlign: "center",
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#F5F7FF", marginBottom: 6 }}>
              {sheets.auth === 'error' ? 'Google 연결 오류' : '로그인이 필요합니다'}
            </div>
            <div style={{ fontSize: 11, color: "#9CA3AF", lineHeight: 1.5, marginBottom: 14 }}>
              {sheets.auth === 'error'
                ? '시트 연결에 문제가 있어 데이터를 불러오지 못했습니다. 아래 0원 표시는 실제 잔액이 아닙니다.'
                : '로그인하면 실제 포트폴리오가 표시됩니다. 아래 0원은 로그인 전 빈 화면입니다.'}
            </div>
            <button onClick={sheets.signIn} style={{
              padding: "10px 24px", borderRadius: 8, border: "1px solid #3B82F6",
              background: "#1E3A5F", color: "#60A5FA", cursor: "pointer",
              fontSize: 13, fontWeight: 600, fontFamily: baseFont, minHeight: 44,
            }}>
              {sheets.auth === 'error' ? '다시 로그인' : 'Google 로그인'}
            </button>
          </div>
        )}

        {jobStatus && (() => {
          const problems = computeJobHealth(jobStatus, JOB_CADENCE);
          if (problems.length === 0) return null;
          const anyFail = problems.some(p => p.problem === 'fail');
          return (
            <div style={{
              margin: '8px 12px', padding: '8px 12px', borderRadius: 8,
              background: anyFail ? '#2A1416' : '#241F12',
              border: `1px solid ${anyFail ? '#7F1D1D' : '#78510F'}`,
              fontSize: 11, color: anyFail ? '#FCA5A5' : '#FCD34D', textAlign: 'left',
            }}>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>
                ⚠️ 무인 잡 점검 필요 {problems.length}건
              </div>
              {problems.map((p, i) => (
                <div key={i} style={{ fontSize: 10, opacity: 0.9 }}>
                  {p.job} — {p.problem === 'fail' ? '실패' : '갱신 정체'}{p.detail ? ` (${p.detail.slice(0, 60)})` : ''}
                </div>
              ))}
            </div>
          );
        })()}

        {/* ── 대시보드 탭 ── */}
        {tab === "dashboard" && (
          <DashboardTab
            totalInvest={totalInvest} totalEval={totalEval} totalProfit={totalProfit}
            accounts={accounts} monthlyData={monthlyData} fmt={fmt} isMobile={isMobile} baseFont={baseFont}
            setAcctKey={setAcctKey} setTab={setTab}
            showSavings={showSavings} setShowSavings={setShowSavings} showSavingsEdit={showSavingsEdit}
            savingsEditValue={savingsEditValue} setSavingsEditValue={setSavingsEditValue}
            savingsLpFiredRef={savingsLpFiredRef} startSavingsLP={startSavingsLP} endSavingsLP={endSavingsLP}
            saveSavingsEdit={saveSavingsEdit} setShowSavingsEdit={setShowSavingsEdit}
          />
        )}

        {/* ── KPI 탭 ── */}
        {tab === "kpi" && (
          <KpiTab monthlyData={monthlyData} kpiTrades={kpiTrades} evaluations={evaluations} isMobile={isMobile} evalSelectedMetric={evalSelectedMetric} setEvalSelectedMetric={setEvalSelectedMetric} />
        )}

        {/* ── 리포트 탭 ── */}
        {tab === "report" && (
          <ReportTab weeklyReports={weeklyReports} setWeeklyReports={setWeeklyReports} />
        )}

        {/* ── 리스크 탭 ── */}
        {tab === "리스크" && (
          <RiskTab riskMonitor={riskMonitor} baselines={baselines} />
        )}

        {/* ── 리밸런싱 탭 ── */}
        {tab === "rebalance" && (
          <RebalanceTab
            accounts={accounts} acctKey={acctKey} acct={acct} setAcctKey={setAcctKey}
            isMobile={isMobile} baseFont={baseFont} fmt={fmt} sheets={sheets}
            editingAllTargets={editingAllTargets} setEditingAllTargets={setEditingAllTargets}
            allTargetInputs={allTargetInputs} setAllTargetInputs={setAllTargetInputs}
            saveAllTargets={saveAllTargets}
          />
        )}

        {/* ── 종목 탭 ── */}
        {tab === "holdings" && (
          <HoldingsTab
            accounts={accounts} acct={acct} acctKey={acctKey} setAcctKey={setAcctKey}
            isMobile={isMobile} baseFont={baseFont} fmt={fmt} sheets={sheets}
            holdSort={holdSort} setHoldSort={setHoldSort}
            showAddForm={showAddForm} setShowAddForm={setShowAddForm}
            showDeleteMode={showDeleteMode} setShowDeleteMode={setShowDeleteMode}
            selectedToDelete={selectedToDelete} setSelectedToDelete={setSelectedToDelete}
            editingHolding={editingHolding} setEditingHolding={setEditingHolding}
            editingCash={editingCash} setEditingCash={setEditingCash}
            editingDollar={editingDollar} setEditingDollar={setEditingDollar}
            editPrice={editPrice} setEditPrice={setEditPrice}
            editQty={editQty} setEditQty={setEditQty}
            editCurrentPrice={editCurrentPrice} setEditCurrentPrice={setEditCurrentPrice}
            editIncludeSavings={editIncludeSavings} setEditIncludeSavings={setEditIncludeSavings}
            editCashValue={editCashValue} setEditCashValue={setEditCashValue}
            editDollarValue={editDollarValue} setEditDollarValue={setEditDollarValue}
            startLP={startLP} endLP={endLP} saveEdit={saveEdit} saveCash={saveCash}
            saveDollar={saveDollar} handleDeleteSelected={handleDeleteSelected}
            AddHoldingForm={AddHoldingForm} onAddHoldingSave={handleAddHoldingSave}
          />
        )}

        {/* ── 배당금 탭 ── */}
        {tab === "dividend" && (
          <DividendTab dividendData={dividendData} isMobile={isMobile} baseFont={baseFont} fmt={fmt} sheets={sheets} />
        )}
        {/* ── 수익금 탭 ── */}
        {tab === "profit" && (
          <ProfitTab profitData={profitData} isMobile={isMobile} baseFont={baseFont} fmt={fmt} />
        )}

        {/* ── 거래결정 탭 (① 거래직전 워크플로우: 시장→팔것→옮길곳→교훈) ── */}
        {tab === "거래" && (
          <TradeDecisionTab
            riskMonitor={riskMonitor} positionJournal={positionJournal} accounts={accounts}
            weeklyReports={weeklyReports} setTab={setTab} baseFont={baseFont}
          />
        )}

        {/* ── 포지션저널 탭 (거래 생애주기 전제) ── */}
        {tab === "저널" && (
          <PositionJournalTab
            positionJournal={positionJournal} riskMonitor={riskMonitor} sheets={sheets} baseFont={baseFont}
          />
        )}

        {/* ── 체결내역 탭 ── */}
        {tab === "체결내역" && (
          <ExecutionsTab
            tradeRows={tradeRows} tradeSyncMsg={tradeSyncMsg} tradeSyncing={tradeSyncing}
            syncTradeExecutions={syncTradeExecutions}
            savingsMode={savingsMode} setSavingsMode={setSavingsMode}
            savingsAppliedRows={savingsAppliedRows} applySavingsFromTrade={applySavingsFromTrade}
            setTradeEditValues={setTradeEditValues} setTradeEditRowIdx={setTradeEditRowIdx}
            setTradeEditOpen={setTradeEditOpen} tradeLpRef={tradeLpRef}
            sheets={sheets} baseFont={baseFont}
          />
        )}

        {/* ── 평가 탭 ── */}
        {tab === "평가" && (
          <BuyEvaluationTab
            evaluations={evaluations} accounts={accounts} evalMode={evalMode} setEvalMode={setEvalMode}
            setEvalSelectedMetric={setEvalSelectedMetric} setEvalQueueOpen={setEvalQueueOpen}
            setEvalIngestOpen={setEvalIngestOpen} evalQueue={evalQueue} requeueEval={requeueEval}
            requeueBusyIdx={requeueBusyIdx} evalSelectedIdx={evalSelectedIdx} setEvalSelectedIdx={setEvalSelectedIdx}
            sheets={sheets} baseFont={baseFont}
          />
        )}

        {/* ── 매도 모드 (evalMode === '매도') ── */}
        {tab === "평가" && evalMode === '매도' && (
          <SellEvaluationTab
            accounts={accounts} evaluations={evaluations} positionJournal={positionJournal}
            riskMonitor={riskMonitor} setEvalMode={setEvalMode} sheets={sheets} baseFont={baseFont} fmt={fmt}
          />
        )}

        {/* ── 체결내역 셀 편집 모달 ── */}
        {tradeEditOpen && tradeEditRowIdx !== null && (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, zIndex: 200,
          }} onClick={(e) => { if (e.target === e.currentTarget) setTradeEditOpen(false); }}>
            <div style={{
              background: '#1A1D26', borderRadius: 12, width: '100%', maxWidth: 440,
              maxHeight: '90vh', overflowY: 'auto', padding: '20px 18px',
              border: '1px solid #2A2F3E',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#F5A623' }}>셀 값 입력</div>
                <button onClick={() => setTradeEditOpen(false)} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: '#8A9AB5', fontSize: 18, padding: 0, lineHeight: 1,
                }}>✕</button>
              </div>

              {CHEOL_COLS.map((col, ci) => {
                const isEmpty = !tradeEditValues[ci];
                return (
                  <div key={col.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{
                      width: 64, fontSize: 10, color: isEmpty ? '#F59E0B' : '#8A9AB5',
                      textAlign: 'right', flexShrink: 0,
                    }}>
                      {col.key} · {col.label}
                    </div>
                    <input
                      value={tradeEditValues[ci]}
                      onChange={(e) => {
                        const next = [...tradeEditValues];
                        next[ci] = e.target.value;
                        setTradeEditValues(next);
                      }}
                      placeholder={col.placeholder}
                      style={{
                        flex: 1, background: isEmpty ? '#1E1A0F' : '#0F1218',
                        border: `1px solid ${isEmpty ? '#F59E0B' : '#2A2F3E'}`,
                        borderRadius: 4, padding: '6px 8px', color: '#E8EAF0',
                        fontSize: 12, fontFamily: baseFont, outline: 'none',
                      }}
                    />
                  </div>
                );
              })}

              <button onClick={saveTradeEdit} disabled={tradeEditBusy} style={{
                width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 6, border: 'none',
                background: tradeEditBusy ? '#2A2F3E' : '#F5A623',
                color: tradeEditBusy ? '#8A9AB5' : '#1A1D26',
                cursor: tradeEditBusy ? 'not-allowed' : 'pointer',
                fontSize: 12, fontWeight: 700, fontFamily: baseFont,
              }}>{tradeEditBusy ? '저장 중...' : '시트에 저장'}</button>
            </div>
          </div>
        )}

        {/* ── 도움말 탭 ── */}
        {tab === "help" && <HelpTab baseFont={baseFont} />}

        {/* ── 평가 카드 적재 모달 ── */}
        {evalIngestOpen && (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, zIndex: 200,
          }} onClick={(e) => { if (e.target === e.currentTarget) setEvalIngestOpen(false); }}>
            <div style={{
              background: '#1A1D26', borderRadius: 12, width: '100%', maxWidth: 560,
              maxHeight: '90vh', overflowY: 'auto', padding: '20px 18px',
              border: '1px solid #2A2F3E',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#60A5FA' }}>평가 결과 저장</div>
                <button onClick={() => setEvalIngestOpen(false)} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: '#8A9AB5', fontSize: 18, padding: 0, lineHeight: 1,
                }}>✕</button>
              </div>

              <textarea
                value={evalIngestRaw}
                onChange={(e) => { setEvalIngestRaw(e.target.value); setEvalIngestParsed(null); setEvalIngestMsg(''); }}
                placeholder="JSON 블록 붙여넣기"
                style={{
                  width: '100%', minHeight: 140, boxSizing: 'border-box',
                  background: '#0F1218', color: '#E8EAF0', border: '1px solid #2A2F3E',
                  borderRadius: 8, padding: 10, fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace',
                  lineHeight: 1.5, resize: 'vertical', outline: 'none',
                }}
              />

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={() => {
                  const r = tryParseEvalJson(evalIngestRaw);
                  if (r.ok) { setEvalIngestParsed(r.data); setEvalIngestMsg('✓ 파싱 완료. 검토 후 적재하세요.'); }
                  else { setEvalIngestParsed(null); setEvalIngestMsg(`⚠️ ${r.error}`); }
                }} style={{
                  flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #2A2F3E',
                  background: 'transparent', color: '#9CA3AF', cursor: 'pointer',
                  fontSize: 11, fontFamily: baseFont,
                }}>파싱</button>
                <button onClick={ingestEvaluation} disabled={!evalIngestParsed || evalIngestBusy} style={{
                  flex: 1, padding: '8px 12px', borderRadius: 6, border: 'none',
                  background: evalIngestParsed && !evalIngestBusy ? '#3B82F6' : '#2A2F3E',
                  color: evalIngestParsed && !evalIngestBusy ? '#fff' : '#8A9AB5',
                  cursor: evalIngestParsed && !evalIngestBusy ? 'pointer' : 'not-allowed',
                  fontSize: 11, fontWeight: 600, fontFamily: baseFont,
                }}>{evalIngestBusy ? '적재 중...' : '시트에 적재'}</button>
              </div>

              {evalIngestMsg && (
                <div style={{
                  marginTop: 10, padding: '8px 12px', borderRadius: 6,
                  background: '#0F1218', fontSize: 11,
                  color: evalIngestMsg.startsWith('✓') ? '#4ADE80'
                       : evalIngestMsg.startsWith('⚠️') ? '#F59E0B'
                       : evalIngestMsg.includes('실패') ? '#F87171' : '#9CA3AF',
                  lineHeight: 1.5,
                }}>{evalIngestMsg}</div>
              )}

              {/* 파싱 결과 미리보기 + 편집 */}
              {evalIngestParsed && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #2A2F3E' }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: '#8A9AB5', marginBottom: 8 }}>미리보기 (편집 가능)</div>
                  {[
                    { k: 'date', label: '평가일' },
                    { k: 'name', label: '종목명' },
                    { k: 'ticker', label: '종목코드' },
                    { k: 'market', label: '시장' },
                    { k: 'conclusion', label: '결론' },
                    { k: 'status', label: '매수여부' },
                    { k: 'buyDate', label: '매수일' },
                    { k: 'buyPrice', label: '매수가' },
                    { k: 'targetTerm', label: '목표기간' },
                    { k: 'targetRet', label: '목표수익률' },
                    { k: 'aiNote', label: 'AI 의견' },
                    { k: 'frankMemo', label: 'Frank 메모' },
                  ].map(({ k, label }) => (
                    <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <div style={{ width: 80, fontSize: 10, color: '#8A9AB5', textAlign: 'right', flexShrink: 0 }}>{label}</div>
                      <input
                        value={evalIngestParsed[k] || ''}
                        onChange={(e) => setEvalIngestParsed({ ...evalIngestParsed, [k]: e.target.value })}
                        style={{
                          flex: 1, background: '#0F1218', border: '1px solid #2A2F3E',
                          borderRadius: 4, padding: '4px 8px', color: '#E8EAF0', fontSize: 11,
                          fontFamily: baseFont, outline: 'none',
                        }}
                      />
                    </div>
                  ))}

                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 10, color: '#8A9AB5', marginBottom: 4 }}>5축 등급</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {Object.entries(evalIngestParsed.grades).map(([axis, val]) => (
                        <div key={axis} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ fontSize: 10, color: '#9CA3AF' }}>{axis}</span>
                          <input
                            value={val}
                            onChange={(e) => setEvalIngestParsed({
                              ...evalIngestParsed,
                              grades: { ...evalIngestParsed.grades, [axis]: e.target.value },
                            })}
                            style={{
                              width: 44, background: '#0F1218', border: '1px solid #2A2F3E',
                              borderRadius: 4, padding: '3px 6px', color: '#E8EAF0', fontSize: 11,
                              textAlign: 'center', fontFamily: baseFont, outline: 'none',
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ marginTop: 10, fontSize: 10, color: '#8A9AB5' }}>
                    근거 {evalIngestParsed.reasons.length}건 · 리스크 {evalIngestParsed.risks.length}건 · 액션 {evalIngestParsed.actions.length}건
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── 평가 의뢰 모달 ── */}
        {evalQueueOpen && (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, zIndex: 200,
          }} onClick={(e) => { if (e.target === e.currentTarget) setEvalQueueOpen(false); }}>
            <div style={{
              background: '#1A1D26', borderRadius: 12, width: '100%', maxWidth: 420,
              maxHeight: '90vh', overflowY: 'auto', padding: '20px 18px',
              border: '1px solid #2A2F3E',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#F5A623' }}>평가 의뢰</div>
                <button onClick={() => setEvalQueueOpen(false)} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: '#8A9AB5', fontSize: 18, padding: 0, lineHeight: 1,
                }}>✕</button>
              </div>

              {/* 종목명 */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: '#8A9AB5', marginBottom: 4, letterSpacing: 1 }}>종목명</div>
                <input
                  value={evalQueueName}
                  onChange={(e) => { setEvalQueueName(e.target.value); setEvalQueueMsg(''); }}
                  placeholder="예: 삼성전자 또는 NVDA"
                  autoFocus
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: '#0F1218', border: '1px solid #2A2F3E',
                    borderRadius: 6, padding: '8px 10px', color: '#E8EAF0', fontSize: 13,
                    fontFamily: baseFont, outline: 'none',
                  }}
                />
              </div>

              {/* 시장 */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: '#8A9AB5', marginBottom: 4, letterSpacing: 1 }}>시장</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['KR', 'US'].map(m => (
                    <button key={m} onClick={() => setEvalQueueMarket(m)} style={{
                      flex: 1, padding: '8px 12px', borderRadius: 6,
                      border: `1px solid ${evalQueueMarket === m ? '#3B82F6' : '#2A2F3E'}`,
                      background: evalQueueMarket === m ? '#1E3A5F' : 'transparent',
                      color: evalQueueMarket === m ? '#60A5FA' : '#9CA3AF',
                      cursor: 'pointer', fontSize: 11, fontFamily: baseFont, fontWeight: 600,
                    }}>{m}</button>
                  ))}
                </div>
              </div>

              {/* 메모 */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: '#8A9AB5', marginBottom: 4, letterSpacing: 1 }}>메모 (선택)</div>
                <input
                  value={evalQueueMemo}
                  onChange={(e) => setEvalQueueMemo(e.target.value)}
                  placeholder="평가 시 참고할 맥락 (예: 1분기 어닝 후 재평가)"
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: '#0F1218', border: '1px solid #2A2F3E',
                    borderRadius: 6, padding: '8px 10px', color: '#E8EAF0', fontSize: 12,
                    fontFamily: baseFont, outline: 'none',
                  }}
                />
              </div>

              <button onClick={submitEvalQueue} disabled={!evalQueueName.trim() || evalQueueBusy} style={{
                width: '100%', padding: '10px 12px', borderRadius: 6, border: 'none',
                background: (evalQueueName.trim() && !evalQueueBusy) ? '#F5A623' : '#2A2F3E',
                color: (evalQueueName.trim() && !evalQueueBusy) ? '#1A1D26' : '#8A9AB5',
                cursor: (evalQueueName.trim() && !evalQueueBusy) ? 'pointer' : 'not-allowed',
                fontSize: 12, fontWeight: 700, fontFamily: baseFont,
              }}>
                {evalQueueBusy ? '추가 중...' : '큐에 추가'}
              </button>

              {evalQueueMsg && (
                <div style={{
                  marginTop: 10, padding: '8px 12px', borderRadius: 6,
                  background: '#0F1218', fontSize: 11,
                  color: evalQueueMsg.startsWith('✓') ? '#4ADE80'
                       : evalQueueMsg.startsWith('⚠️') ? '#F59E0B'
                       : evalQueueMsg.includes('실패') ? '#F87171' : '#9CA3AF',
                  lineHeight: 1.5,
                }}>{evalQueueMsg}</div>
              )}

              {/* 큐 미리보기 */}
              {evalQueue.entries.length > 0 && (
                <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #2A2F3E' }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: '#8A9AB5', marginBottom: 8 }}>
                    최근 의뢰 ({evalQueue.entries.length}건)
                  </div>
                  {evalQueue.entries.slice(0, 5).map((e, i) => (
                    <div key={i} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '6px 0', fontSize: 10, borderBottom: i < 4 ? '1px solid #1E2233' : 'none',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span style={{
                          fontSize: 9, padding: '1px 6px', borderRadius: 3,
                          background: e.status === '완료' ? '#1E3D2A'
                                    : e.status === '처리중' ? '#1E3A5F'
                                    : e.status === '오류' ? '#4A1E1E' : '#3D2E14',
                          color: e.status === '완료' ? '#4ADE80'
                               : e.status === '처리중' ? '#60A5FA'
                               : e.status === '오류' ? '#F87171' : '#F5A623',
                        }}>{e.status}</span>
                        <span style={{ color: '#E8EAF0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {e.name}
                        </span>
                        {e.market && <span style={{ color: '#8A9AB5', fontSize: 9 }}>{e.market}</span>}
                      </div>
                      <span style={{ color: '#8A9AB5', fontSize: 9, flexShrink: 0, marginLeft: 8 }}>
                        {e.requestedAt.slice(5)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── 학습 모듈 슬라이드 패널 ── */}
        {evalSelectedMetric && LEARNING_MODULES[evalSelectedMetric] && (
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0,
            background: '#1A1D26', borderTop: '2px solid #3B82F6',
            padding: '16px 20px 24px', maxHeight: '60vh', overflowY: 'auto',
            boxShadow: '0 -8px 30px rgba(0,0,0,0.6)', zIndex: 100,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#60A5FA', display: 'flex', alignItems: 'center', gap: 6 }}>
                📘 {LEARNING_MODULES[evalSelectedMetric].title}
              </div>
              <button onClick={() => setEvalSelectedMetric(null)} style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: '#8A9AB5', fontSize: 18, padding: 0, lineHeight: 1,
              }}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: '#E8EAF0', lineHeight: 1.6, marginBottom: 10 }}>
              {LEARNING_MODULES[evalSelectedMetric].summary}
            </div>
            <div style={{ background: '#0F1218', borderRadius: 6, padding: '8px 12px', fontSize: 11, color: '#9CA3AF', lineHeight: 1.5 }}>
              <span style={{ color: '#F5A623', marginRight: 6 }}>임계값</span>
              {LEARNING_MODULES[evalSelectedMetric].threshold}
            </div>
          </div>
        )}

      </div>

      <div style={{ padding: "12px 16px 32px", textAlign: "center", fontSize: 9, color: "#2A2F3E", letterSpacing: 2 }}>
        {(sheets.lastSync || new Date()).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })} · 바나나 은퇴 준비 포트폴리오
      </div>

      {/* 동기화/저장 피드백 토스트 (하단 고정) */}
      {balanceSyncMsg && (() => {
        const isErr = balanceSyncMsg.includes('실패') || balanceSyncMsg.includes('없음') || balanceSyncMsg.includes('올바르게');
        return (
          <div style={{
            position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)",
            zIndex: 2000, maxWidth: "90%",
            padding: "12px 20px", borderRadius: 10,
            background: isErr ? "#3A1518" : "#143526",
            border: `1px solid ${isErr ? "#7F1D1D" : "#15803D"}`,
            color: isErr ? "#FCA5A5" : "#86EFAC",
            fontSize: 13, fontWeight: 600, fontFamily: baseFont,
            boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <span>{isErr ? "⚠️" : "✓"}</span>
            <span>{balanceSyncMsg}</span>
          </div>
        );
      })()}
    </div>
  );
}
