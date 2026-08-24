import { useState, useMemo } from "react";
import { PAPER, INK, INK_2, ACCENT, CARD_BG, MONO, BORDER_HEAVY } from './lib/theme.js';
import { relTime, fmt } from './lib/textFormat.js';
import { isMirrorStale } from './lib/mirrorFreshness.js';
import {
  accountsFromMirror, rebalanceAccountFromMirror, pooledAccountFromMirror,
  monthlyDividendsFromMirror, monthlyProfitsFromMirror, sortedTradesFromMirror,
  monthlyBalancesFromMirror,
} from './lib/mirrorAdapters.js';
import { useIsMobile } from './hooks/useIsMobile.js';
import { useFirestoreMirror } from './hooks/useFirestoreMirror.js';
import DashboardTab from './tabs/DashboardTab.jsx';
import ReportTab from './tabs/ReportTab.jsx';
import RebalanceTab from './tabs/RebalanceTab.jsx';
import HoldingsTab from './tabs/HoldingsTab.jsx';
import ExecutionsTab from './tabs/ExecutionsTab.jsx';
import DividendTab from './tabs/DividendTab.jsx';
import ProfitTab from './tabs/ProfitTab.jsx';

// ── 앱(v2 — Firestore mirror 읽기 전용, 2026-08-13 재배선) ──────────────────────
// docs/IMPLEMENTATION-PLAN.md Phase 6 확정: 7개 탭(홈·보유종목·자산분배·배당금·수익금·
// 체결내역·리포트)만 남긴다. 쓰기는 전부 텔레그램 승인 흐름을 거쳐 Vault에 반영되고
// (useFirestoreMirror.js 원칙), 이 앱은 그 결과를 보여만 준다 — 수정하려면 판테온에게
// 텔레그램으로 요청.
export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [hideAmounts, setHideAmounts] = useState(() => {
    try { return localStorage.getItem('banana_hide_amounts') === '1'; } catch { return false; }
  });
  const toggleHideAmounts = () => setHideAmounts(prev => {
    const next = !prev;
    try { localStorage.setItem('banana_hide_amounts', next ? '1' : '0'); } catch { /* 프라이빗 모드 등 — 세션 내에서만 유지 */ }
    return next;
  });
  const [acctKey, setAcctKey] = useState("위탁");
  const [holdSort, setHoldSort] = useState('sheet');
  const isMobile = useIsMobile();

  const { auth, sync, mirrors, signIn, signOut } = useFirestoreMirror();

  const accounts = useMemo(() => accountsFromMirror(mirrors.holdings), [mirrors.holdings]);
  const acct = accounts[acctKey] ?? Object.values(accounts)[0];
  // 자산분배 탭 전용 4개 뷰(2026-08-22 오너 확정 — 위탁·연금저축·금은 "통합" 하나로,
  // ISA·IRP·CMA만 각자 별도) — acctKey(홈·보유종목 탭이 쓰는 실계좌 선택)와 무관하게
  // 항상 이 4개를 전부 준비해둔다(RebalanceTab이 자기 안에서 고른다).
  const rebalanceViews = useMemo(() => {
    const base = { allocationMirror: mirrors.allocation, holdingsMirror: mirrors.holdings };
    return {
      POOLED: pooledAccountFromMirror(base),
      ISA: rebalanceAccountFromMirror({ ...base, acctKey: 'ISA' }),
      IRP: rebalanceAccountFromMirror({ ...base, acctKey: 'IRP' }),
      CMA: rebalanceAccountFromMirror({ ...base, acctKey: 'CMA' }),
    };
  }, [mirrors.allocation, mirrors.holdings]);
  const dividendData = useMemo(() => monthlyDividendsFromMirror(mirrors.dividends), [mirrors.dividends]);
  const profitData = useMemo(() => monthlyProfitsFromMirror(mirrors.profits), [mirrors.profits]);
  const trades = useMemo(() => sortedTradesFromMirror(mirrors.trades), [mirrors.trades]);
  const monthlyBalances = useMemo(() => monthlyBalancesFromMirror(mirrors.monthlyBalances), [mirrors.monthlyBalances]);

  const totalEval = mirrors.home?.totalEval ?? 0;
  const totalInvest = mirrors.home?.totalInvest ?? 0;
  const totalProfit = mirrors.home?.totalProfit ?? 0;
  const pendingProposalCount = mirrors.home?.pendingProposalCount ?? 0;
  const stale = isMirrorStale(mirrors.home?.updatedAt);

  const syncLabel =
    sync === 'syncing' ? '동기화 중...' :
    sync === 'error'   ? '동기화 실패' :
    mirrors.home?.updatedAt ? `${relTime(mirrors.home.updatedAt)} 갱신` :
    '';

  // 왼쪽 BANANA 배지와 높이를 맞추기 위한 버튼 스타일(2026-08-22 오너 지시) — 배지와
  // 동일하게 fontSize 9·padding "2px 6px"·fontWeight 800·letterSpacing 없음으로
  // 통일. 헤더 타이틀 줄의 숨기기·로그인/로그아웃 버튼이 전부 이걸 쓴다.
  const badgeHeightBtn = {
    padding: "2px 6px", borderRadius: 0,
    border: "1px solid #141414", background: PAPER,
    color: INK, cursor: "pointer", fontWeight: 800, lineHeight: 1.4,
    fontSize: 9, fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
  };

  const baseFont = "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif";

  return (
    <div style={{
      minHeight: "100vh", background: PAPER, color: INK,
      fontFamily: baseFont, padding: 0,
    }}>
      {/* ── 헤더 ── */}
      <div style={{
        background: PAPER,
        borderBottom: BORDER_HEAVY,
        padding: isMobile ? "14px 16px 12px" : "20px 24px 16px",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        {/* 타이틀 줄 — 왼쪽: 배지·제안대기 배지 / 오른쪽: 숨기기 토글·로그인·로그아웃
            (2026-08-22 오너 지시 — 로그아웃·숨기기 버튼을 평가손익 위 이 줄로 올리고,
            왼쪽 BANANA 배지와 높이를 맞춤: fontSize 9·padding "2px 6px"·fontWeight 800로
            통일해 badgeHeightBtn 하나로 관리).
            ⚠️ 줄바꿈 금지(2026-08-24 오너 지적) — 제안대기 배지가 뜨면(예: "제안 대기
            12건") 폭이 늘어나 오른쪽 토글·로그아웃 버튼이 다음 줄로 밀렸다. 세 컨테이너
            전부 flexWrap을 nowrap으로 고정해 항상 한 줄을 유지한다(제목을 "BANANA
            포트폴리오"로 줄인 것도 같은 목적 — 왼쪽 폭 자체를 줄여 여유를 만듦). */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: 'nowrap' }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: 'nowrap', minWidth: 0 }}>
            <div style={{ display: "inline-block", whiteSpace: "nowrap", fontSize: 9, fontWeight: 800, letterSpacing: isMobile ? 1 : 2, color: INK, background: ACCENT, padding: "2px 6px" }}>
              BANANA 포트폴리오
            </div>
            {pendingProposalCount > 0 && (
              <div title="텔레그램에서 승인/거부 대기 중인 제안" style={{ display: "inline-block", whiteSpace: "nowrap", fontSize: 9, fontWeight: 800, letterSpacing: 1, color: "#fff", background: "#E0A000", padding: "2px 6px" }}>
                제안 대기 {pendingProposalCount}건
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, flexWrap: 'nowrap' }}>
            {auth === 'loading' && (
              <span style={{ fontSize: 9, color: INK_2 }}>Google 초기화 중...</span>
            )}
            {auth === 'signed-in' && (
              <span style={{ fontSize: 9, fontWeight: 700, color: sync === 'error' ? "#E5484D" : INK_2, whiteSpace: 'nowrap' }}>
                {syncLabel}
              </span>
            )}
            <button onClick={toggleHideAmounts} aria-label={hideAmounts ? "금액 표시" : "금액 숨기기"} title={hideAmounts ? "금액 표시" : "금액 숨기기"}
              style={{ ...badgeHeightBtn, background: hideAmounts ? ACCENT : PAPER }}>
              {hideAmounts ? "🙈" : "👀"}
            </button>
            {auth === 'signed-out' && (
              <button onClick={signIn} aria-label="Google 계정으로 로그인" style={{ ...badgeHeightBtn, background: ACCENT }}>
                로그인
              </button>
            )}
            {auth === 'signed-in' && (
              <button onClick={signOut} aria-label="로그아웃" style={{ ...badgeHeightBtn, color: "#E5484D" }}>
                로그아웃
              </button>
            )}
            {auth === 'error' && (
              <span style={{ fontSize: 9, fontWeight: 700, color: "#E5484D" }}>Google 연결 오류</span>
            )}
          </div>
        </div>

        {/* 총잔고 | 평가손익 — 둘 다 라벨+금액 2단 구조로 맞춰서 alignItems: center로
            금액 글자를 가운데 정렬(2026-08-22 오너 지시 — 전엔 왼쪽은 라벨 없이 숫자만,
            오른쪽은 라벨+숫자라 구조가 안 맞아 가운데가 안 맞았음). */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 0, marginRight: 8 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: INK_2, letterSpacing: 2, marginBottom: 2 }}>총 잔고</div>
            <div style={{ fontSize: isMobile ? 22 : 27, fontWeight: 800, letterSpacing: -0.5, color: INK, fontFamily: MONO }}>
              {hideAmounts ? "₩••••••" : `₩${fmt(totalEval)}`}
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: INK_2, letterSpacing: 2, marginBottom: 2 }}>평가손익</div>
            <div style={{ fontSize: isMobile ? 14 : 16, fontWeight: 800, color: hideAmounts ? INK_2 : (totalProfit >= 0 ? '#159E52' : '#E5484D'), fontFamily: MONO }}>
              {hideAmounts ? "••••••" : <>{totalProfit > 0 ? '▲ ' : totalProfit < 0 ? '▼ ' : ''}₩{fmt(Math.abs(totalProfit))}</>}
            </div>
          </div>
        </div>

        {/* 탭 */}
        <div className="tab-bar" role="tablist" aria-label="화면 전환" style={{ display: "flex", gap: 4, marginTop: isMobile ? 10 : 16, flexWrap: "nowrap", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          {[
            { key: "dashboard", label: "홈" },
            { key: "holdings",  label: "보유종목" },
            { key: "rebalance", label: "자산분배" },
            { key: "체결내역",  label: "체결" },
            { key: "dividend",  label: "배당금" },
            { key: "profit",    label: "수익금" },
            { key: "report",    label: "리포트" },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setTab(key)}
              role="tab" aria-selected={tab === key} aria-label={label} style={{
              padding: "5px 12px",
              minHeight: 32,
              flexShrink: 0,
              borderRadius: 0, border: "1px solid #141414", cursor: "pointer",
              fontSize: 12, fontWeight: tab === key ? 800 : 600, letterSpacing: 0.5, fontFamily: baseFont,
              background: tab === key ? "#E4F5A0" : CARD_BG,
              color: INK,
              boxShadow: "none",
              transition: "none",
            }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "20px 16px" }}>

        {/* 동기화 실패 배너 */}
        {auth === 'signed-in' && sync === 'error' && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            background: '#FBE3E4', border: '1px solid #E5484D', borderRadius: 0,
            padding: '8px 12px', marginBottom: 12,
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#E5484D', textAlign: 'left' }}>
              동기화 실패 — 표시 중인 데이터가 최신이 아닐 수 있습니다
            </span>
          </div>
        )}

        {/* 데이터 신선도 배너 — updatedAt이 2시간 넘게 안 갱신되면 옛 데이터임을 명시 */}
        {auth === 'signed-in' && sync === 'synced' && stale && (
          <div style={{
            background: '#FDF3D8', border: '1px solid #E0A000', borderRadius: 0,
            padding: '8px 12px', marginBottom: 12,
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#8A6200' }}>
              ⚠ 데이터가 오래됐습니다({syncLabel || '갱신 이력 없음'}) — 무인 잡이 멈췄을 수 있습니다
            </span>
          </div>
        )}

        {(auth === 'signed-out' || auth === 'error') && (
          <div style={{
            background: CARD_BG,
            border: "1px solid #141414", borderRadius: 0, boxShadow: "3px 3px 0 #141414",
            padding: "20px 16px", marginBottom: 16, textAlign: "center",
          }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: INK, marginBottom: 6 }}>
              {auth === 'error' ? 'Google 연결 오류' : '로그인이 필요합니다'}
            </div>
            <div style={{ fontSize: 11, color: INK_2, lineHeight: 1.5, marginBottom: 14 }}>
              {auth === 'error'
                ? 'Firestore 연결에 문제가 있어 데이터를 불러오지 못했습니다.'
                : '로그인하면 실제 포트폴리오가 표시됩니다.'}
            </div>
            <button onClick={signIn} style={{
              padding: "10px 24px", borderRadius: 0, border: "1px solid #141414", boxShadow: "3px 3px 0 #141414",
              background: ACCENT, color: INK, cursor: "pointer",
              fontSize: 13, fontWeight: 800, fontFamily: baseFont, minHeight: 44,
            }}>
              {auth === 'error' ? '다시 로그인' : 'Google 로그인'}
            </button>
          </div>
        )}

        {/* ── 대시보드 탭 ── */}
        {tab === "dashboard" && (
          <DashboardTab
            totalInvest={totalInvest} totalEval={totalEval} totalProfit={totalProfit}
            accounts={accounts} fmt={fmt} isMobile={isMobile}
            setAcctKey={setAcctKey} setTab={setTab} monthlyBalances={monthlyBalances}
          />
        )}

        {/* ── 리포트 탭 ── */}
        {tab === "report" && (
          <ReportTab report={mirrors.latestReport} />
        )}

        {/* ── 자산분배 탭 ── */}
        {tab === "rebalance" && (
          <RebalanceTab
            views={rebalanceViews}
            isMobile={isMobile} baseFont={baseFont} fmt={fmt}
          />
        )}

        {/* ── 종목 탭 ── */}
        {tab === "holdings" && (
          <HoldingsTab
            accounts={accounts} acct={acct} acctKey={acctKey} setAcctKey={setAcctKey}
            isMobile={isMobile} baseFont={baseFont} fmt={fmt}
            holdSort={holdSort} setHoldSort={setHoldSort}
          />
        )}

        {/* ── 배당금 탭 ── */}
        {tab === "dividend" && (
          <DividendTab dividendData={dividendData} isMobile={isMobile} baseFont={baseFont} fmt={fmt} />
        )}
        {/* ── 수익금 탭 ── */}
        {tab === "profit" && (
          <ProfitTab profitData={profitData} isMobile={isMobile} baseFont={baseFont} fmt={fmt} />
        )}

        {/* ── 체결내역 탭 ── */}
        {tab === "체결내역" && (
          <ExecutionsTab trades={trades} isMobile={isMobile} baseFont={baseFont} fmt={fmt} />
        )}

      </div>

      <div style={{ padding: "12px 16px 32px", textAlign: "center", fontSize: 9, color: "#141414", letterSpacing: 2 }}>
        {(mirrors.home?.updatedAt ? new Date(mirrors.home.updatedAt) : new Date()).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })} · 바나나 은퇴 준비 포트폴리오
      </div>
    </div>
  );
}
