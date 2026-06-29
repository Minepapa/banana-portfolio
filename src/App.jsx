import { useState, useEffect, useCallback, useRef } from "react";
import { parseJobStatus } from './lib/jobHealth.js';
import {
  profitColor, relTime, DEFAULT_ACCOUNTS,
} from './lib/constants.js';
import { useGoogleSheets, CONFIGURED } from './hooks/useGoogleSheets.js';
import { useTradeSync } from './hooks/useTradeSync.js';
import { useEvalCard } from './hooks/useEvalCard.js';
import { usePortfolioEdits } from './hooks/usePortfolioEdits.js';
import { useSavingsEdit } from './hooks/useSavingsEdit.js';
import { useRebalanceTargets } from './hooks/useRebalanceTargets.js';
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
import TodayTab from './tabs/TodayTab.jsx';
import PositionJournalTab from './tabs/PositionJournalTab.jsx';
import PreferenceTab from './tabs/PreferenceTab.jsx';
import BuyEvaluationTab from './tabs/BuyEvaluationTab.jsx';
import SellEvaluationTab from './tabs/SellEvaluationTab.jsx';
import LearningModuleModal from './tabs/LearningModuleModal.jsx';
import TradeEditModal from './tabs/TradeEditModal.jsx';
import EvalIngestModal from './tabs/EvalIngestModal.jsx';
import EvalQueueModal from './tabs/EvalQueueModal.jsx';
import AddHoldingForm from './tabs/AddHoldingForm.jsx';
import JobHealthBanner from './tabs/JobHealthBanner.jsx';
import SyncBanner from './tabs/SyncBanner.jsx';

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

// ── 앱 ────────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [acctKey, setAcctKey] = useState("위탁");
  const [holdSort, setHoldSort] = useState('sheet'); // sheet | rate_desc | rate_asc | eval_desc | profit_desc
  const [accounts, setAccounts] = useState(DEFAULT_ACCOUNTS);
  const [monthlyData, setMonthlyData] = useState([]);
  const [dividendData, setDividendData] = useState([]);
  const [evalMode, setEvalMode] = useState('매수'); // 평가 탭 토글: '매수' | '매도'
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
  const [kpiTrades, setKpiTrades] = useState(null); // null=미로딩, []이상=로딩완료
  const [jobStatus, setJobStatus] = useState(null); // null=미로딩
  const [execPending, setExecPending] = useState(null); // 오늘 탭: 미처리 체결 수(읽기전용). null=미로딩
  const [savingsMode, setSavingsMode] = useState(false);
  const [profitData, setProfitData] = useState([]);
  const isMobile = useIsMobile();
  const [evalSelectedMetric, setEvalSelectedMetric] = useState(null);
  const [evaluations, setEvaluations] = useState([]);
  const [evalSelectedIdx, setEvalSelectedIdx] = useState(0);
  const [evalQueue, setEvalQueue] = useState({ entries: [], counts: { pending: 0, processing: 0, done: 0, error: 0 } });

  const [weeklyReports, setWeeklyReports] = useState([]);
  const [riskMonitor, setRiskMonitor] = useState([]);
  const [baselines, setBaselines] = useState([]);
  const [positionJournal, setPositionJournal] = useState([]);
  const [preferences, setPreferences] = useState([]); // 성향 학습 관찰
  const [usdRate, setUsdRate] = useState(0); // USD/KRW 환율

  const onData = useCallback(({ accounts: a, monthly: m, dividends: d, monthlyRow: mr, profits: p, evaluations: ev, evalQueue: q, weeklyReports: wr, riskMonitor: rm, baselines: bl, positionJournal: pj, usdRate: ur, preferences: pref }) => {
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
    if (pref) setPreferences(pref);
    if (ur > 0) setUsdRate(ur);
  }, []);

  const sheets = useGoogleSheets(onData);

  const {
    tradeRows,
    tradeSyncing,
    tradeSyncMsg,
    savingsAppliedRows,
    tradeEditOpen, setTradeEditOpen,
    tradeEditRowIdx, setTradeEditRowIdx,
    tradeEditValues, setTradeEditValues,
    tradeEditBusy,
    syncTradeExecutions,
    saveTradeEdit,
    applySavingsFromTrade,
  } = useTradeSync({ sheets, usdRate });

  const {
    evalIngestOpen, setEvalIngestOpen,
    evalIngestRaw, setEvalIngestRaw,
    evalIngestParsed, setEvalIngestParsed,
    evalIngestMsg, setEvalIngestMsg,
    evalIngestBusy,
    evalQueueOpen, setEvalQueueOpen,
    evalQueueName, setEvalQueueName,
    evalQueueMarket, setEvalQueueMarket,
    evalQueueMemo, setEvalQueueMemo,
    evalQueueMsg, setEvalQueueMsg,
    evalQueueBusy,
    requeueBusyIdx,
    tryParseEvalJson,
    ingestEvaluation,
    submitEvalQueue,
    requeueEval,
  } = useEvalCard({ sheets });

  const {
    showAddForm, setShowAddForm,
    showDeleteMode, setShowDeleteMode,
    selectedToDelete, setSelectedToDelete,
    editingHolding, setEditingHolding,
    editPrice, setEditPrice,
    editQty, setEditQty,
    editCurrentPrice, setEditCurrentPrice,
    editIncludeSavings, setEditIncludeSavings,
    editingCash, setEditingCash,
    editCashValue, setEditCashValue,
    editingDollar, setEditingDollar,
    editDollarValue, setEditDollarValue,
    handleDeleteSelected,
    beginEdit,
    saveEdit, saveCash, saveDollar,
    handleAddHoldingSave,
  } = usePortfolioEdits({ sheets, accounts, acctKey, monthlyRowRef, setBalanceSyncMsg });

  const {
    showSavingsEdit, setShowSavingsEdit,
    savingsEditValue, setSavingsEditValue,
    beginSavingsEdit, saveSavingsEdit,
  } = useSavingsEdit({ sheets, monthlyRowRef, setBalanceSyncMsg });

  const {
    editingAllTargets, setEditingAllTargets,
    allTargetInputs, setAllTargetInputs,
    saveAllTargets,
  } = useRebalanceTargets({ sheets, acctKey, setBalanceSyncMsg });

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

  useEffect(() => {
    if (tab === '체결내역' && sheets.auth === 'signed-in') {
      syncTradeExecutions();
    }
  }, [tab, sheets.auth]); // eslint-disable-line

  useEffect(() => {
    if (tab === 'kpi' && sheets.auth === 'signed-in' && kpiTrades === null) {
      sheets.readRange('체결내역!A2:M')
        .then(vals => setKpiTrades((vals || []).map(row => ({ row }))))
        .catch(() => setKpiTrades([]));
    }
  }, [tab, sheets.auth]); // eslint-disable-line

  // 잡 상태는 별도 '잡상태' 시트라 메인 batchGet(doFetch)에 안 실린다 → 따로 읽는다.
  // 복원-만료 토큰 경로(useGoogleSheets)는 토큰 적용 전 잠깐 signed-in 이 되므로 첫 시도가
  // 401 로 죽을 수 있다. 그땐 jobStatus 가 null 로 남는데, 토큰 갱신→doFetch 성공으로
  // lastSync 가 바뀌면(=토큰 준비됨 신호) 이 effect 가 재발화해 채운다. 한 번 채워지면 즉시 스킵.
  useEffect(() => {
    if (sheets.auth === 'signed-in' && jobStatus === null) {
      sheets.readRange('잡상태!A2:E')
        .then(rows => setJobStatus(parseJobStatus(rows)))
        // 실패 시 jobStatus는 null 유지 → 배너 숨김([]는 "전부 미실행"으로 오표시되므로 금지).
        // 401(토큰 미적용 레이스)은 조용히 — lastSync 갱신 때 재시도한다. 그 외만 흔적 남김.
        .catch(e => { if (e?.status !== 401) console.error('잡상태 read failed:', e); });
    }
  }, [sheets.auth, jobStatus, sheets.lastSync]); // eslint-disable-line

  // 오늘 탭: 미처리 체결 수를 읽기전용으로 집계(동기화는 쓰기라 탭 진입만으로 호출 금지).
  // 탭 진입·전역 새로고침(lastSync) 때마다 재조회 — 종목명 있고 미처리(초록 아님)인 행만 카운트.
  useEffect(() => {
    if (tab !== '오늘' || sheets.auth !== 'signed-in') return;
    let cancelled = false;
    Promise.all([sheets.readRange('체결내역!A2:M'), sheets.readTradeProcessedFlags()])
      .then(([vals, flags]) => {
        if (cancelled) return;
        const n = (vals || []).filter((row, i) => String(row[5] ?? '').trim() !== '' && !(flags[i] ?? false)).length;
        setExecPending(n);
      })
      .catch(() => { if (!cancelled) setExecPending(0); });
    return () => { cancelled = true; };
  }, [tab, sheets.auth, sheets.lastSync]); // eslint-disable-line

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
              {totalProfit > 0 ? '▲ ' : totalProfit < 0 ? '▼ ' : ''}₩{fmt(Math.abs(totalProfit))}
            </div>
            {dailyDelta != null && (
              <div style={{ fontSize: 10, color: profitColor(dailyDelta) }}>
                {dailyDelta > 0 ? '▲ ' : dailyDelta < 0 ? '▼ ' : ''}₩{fmt(Math.abs(dailyDelta))}
                {prevDayEval > 0 ? ` (${dailyDelta >= 0 ? '+' : '−'}${Math.abs(dailyDelta / prevDayEval * 100).toFixed(2)}%)` : ''}
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
            { key: "오늘",      label: "오늘" },
            { key: "report",    label: "리포트" },
            { key: "리스크",    label: "리스크" },
            { key: "평가",      label: "평가" },
            { key: "holdings",  label: "보유종목" },
            { key: "rebalance", label: "자산분배" },
            { key: "체결내역",  label: "체결" },
            { key: "dividend",  label: "배당금" },
            { key: "profit",    label: "수익금" },
            { key: "저널",      label: "포지션" },
            { key: "성향",      label: "성향" },
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
                : '로그인하면 실제 포트폴리오가 표시됩니다.'}
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

        {/* ── 대시보드 탭 ── */}
        {tab === "dashboard" && (
          <DashboardTab
            totalInvest={totalInvest} totalEval={totalEval} totalProfit={totalProfit}
            accounts={accounts} monthlyData={monthlyData} fmt={fmt} isMobile={isMobile} baseFont={baseFont}
            setAcctKey={setAcctKey} setTab={setTab}
            showSavings={showSavings} setShowSavings={setShowSavings} showSavingsEdit={showSavingsEdit}
            savingsEditValue={savingsEditValue} setSavingsEditValue={setSavingsEditValue}
            beginSavingsEdit={beginSavingsEdit}
            saveSavingsEdit={saveSavingsEdit} setShowSavingsEdit={setShowSavingsEdit}
          />
        )}

        {/* ── KPI 탭 ── */}
        {tab === "kpi" && (<>
          <JobHealthBanner jobStatus={jobStatus} />
          <KpiTab monthlyData={monthlyData} kpiTrades={kpiTrades} evaluations={evaluations} isMobile={isMobile} evalSelectedMetric={evalSelectedMetric} setEvalSelectedMetric={setEvalSelectedMetric} jobStatus={jobStatus} />
        </>)}

        {/* ── 리포트 탭 ── */}
        {tab === "report" && (
          <ReportTab weeklyReports={weeklyReports} />
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
            beginEdit={beginEdit} saveEdit={saveEdit} saveCash={saveCash}
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

        {/* ── 오늘 탭 (매일 처리할 행동 체크리스트 — 거래결정 탭 대체) ── */}
        {tab === "오늘" && (
          <TodayTab
            riskMonitor={riskMonitor} positionJournal={positionJournal} accounts={accounts}
            weeklyReports={weeklyReports} execPending={execPending} jobStatus={jobStatus}
            preferences={preferences}
            setTab={setTab} baseFont={baseFont}
          />
        )}

        {/* ── 포지션저널 탭 (거래 생애주기 전제) ── */}
        {tab === "저널" && (
          <PositionJournalTab
            positionJournal={positionJournal} riskMonitor={riskMonitor} sheets={sheets} baseFont={baseFont}
          />
        )}

        {/* ── 성향확인 탭 (행동 학습 관찰 확인) ── */}
        {tab === "성향" && (
          <PreferenceTab preferences={preferences} sheets={sheets} baseFont={baseFont} />
        )}

        {/* ── 체결내역 탭 ── */}
        {tab === "체결내역" && (
          <ExecutionsTab
            tradeRows={tradeRows} tradeSyncMsg={tradeSyncMsg} tradeSyncing={tradeSyncing}
            syncTradeExecutions={syncTradeExecutions}
            savingsMode={savingsMode} setSavingsMode={setSavingsMode}
            savingsAppliedRows={savingsAppliedRows} applySavingsFromTrade={applySavingsFromTrade}
            setTradeEditValues={setTradeEditValues} setTradeEditRowIdx={setTradeEditRowIdx}
            setTradeEditOpen={setTradeEditOpen}
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
        <TradeEditModal
          tradeEditOpen={tradeEditOpen} tradeEditRowIdx={tradeEditRowIdx} setTradeEditOpen={setTradeEditOpen}
          tradeEditValues={tradeEditValues} setTradeEditValues={setTradeEditValues}
          saveTradeEdit={saveTradeEdit} tradeEditBusy={tradeEditBusy} baseFont={baseFont}
        />

        {/* ── 도움말 탭 ── */}
        {tab === "help" && <HelpTab baseFont={baseFont} />}

        {/* ── 평가 카드 적재 모달 ── */}
        <EvalIngestModal
          evalIngestOpen={evalIngestOpen} setEvalIngestOpen={setEvalIngestOpen}
          evalIngestRaw={evalIngestRaw} setEvalIngestRaw={setEvalIngestRaw}
          evalIngestParsed={evalIngestParsed} setEvalIngestParsed={setEvalIngestParsed}
          evalIngestMsg={evalIngestMsg} setEvalIngestMsg={setEvalIngestMsg}
          evalIngestBusy={evalIngestBusy} tryParseEvalJson={tryParseEvalJson}
          ingestEvaluation={ingestEvaluation} baseFont={baseFont}
        />

        {/* ── 평가 의뢰 모달 ── */}
        <EvalQueueModal
          evalQueueOpen={evalQueueOpen} setEvalQueueOpen={setEvalQueueOpen}
          evalQueueName={evalQueueName} setEvalQueueName={setEvalQueueName}
          evalQueueMarket={evalQueueMarket} setEvalQueueMarket={setEvalQueueMarket}
          evalQueueMemo={evalQueueMemo} setEvalQueueMemo={setEvalQueueMemo}
          evalQueueMsg={evalQueueMsg} setEvalQueueMsg={setEvalQueueMsg}
          evalQueueBusy={evalQueueBusy} submitEvalQueue={submitEvalQueue}
          evalQueue={evalQueue} baseFont={baseFont}
        />

        {/* ── 학습 모듈 슬라이드 패널 ── */}
        <LearningModuleModal evalSelectedMetric={evalSelectedMetric} setEvalSelectedMetric={setEvalSelectedMetric} />

      </div>

      <div style={{ padding: "12px 16px 32px", textAlign: "center", fontSize: 9, color: "#2A2F3E", letterSpacing: 2 }}>
        {(sheets.lastSync || new Date()).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })} · 바나나 은퇴 준비 포트폴리오
      </div>

      {/* 동기화/저장 피드백 토스트 (하단 고정) */}
      <SyncBanner message={balanceSyncMsg} baseFont={baseFont} />
    </div>
  );
}
