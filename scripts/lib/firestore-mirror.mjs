// Vault(Facts/State) → Firestore mirror/* 문서 빌더 — 순수 함수.
// docs/ARCHITECTURE-V2.md "Firestore 필드 스키마" 절에 확정된 필드 그대로.
// 실제 Firestore 쓰기(setDoc)는 호출부(scripts/jobs/sync-firestore-mirror.mjs)가 한다
// — 이 모듈은 fs도 firebase-admin도 만지지 않는다(입력을 이미 파싱된 데이터로 받음).
//
// ⚠️ 현재 상태(2026-08-05, Phase 6): State/Holdings·State/Allocation은 아직 실제
// 자산분배·퀀트 트랙 부서 로직(Phase 8·9)이 없어 비어있다 — 그래서 holdings·allocation·
// home 미러는 지금 빈 값(0·[])으로 정확하게 나온다(가짜 숫자를 채우지 않는다). Facts/
// Ledger(체결·배당)는 Phase 2에서 이미 실제로 기록되므로 trades·dividends 미러는
// 진짜 데이터로 채워진다.

// 최근 1년 이내 항목만 남긴다(mirror의 "이력형" 문서 원칙 — 그 이전은 Vault에서 조회).
function withinLastYear(dateStr, now) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (!Number.isFinite(d.getTime())) return false;
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  return d >= oneYearAgo;
}

export function buildHomeMirror({ holdings = [], accounts = [], pendingProposalCount = 0, usdRate = null, now = new Date() }) {
  // ⚠️ 버그 수정(2026-08-21, 실사고 — 로그인 후 총 투자금이 130억원으로 잘못 표시됨,
  // 오너가 대시보드에서 직접 발견) — avgPrice*qty로 재계산하면 한국 펀드 기준가
  // 관례(1,000좌당 표기, 예: VIP펀드 avgPrice=1560/qty=8202681)가 있는 보유는 실제
  // 투자금보다 1,000배 부풀려진다. State/Holdings가 이미 정확히 계산해 저장한
  // invest 필드를 그대로 합산해야 한다(재계산 금지 — update-holdings-prices.mjs의
  // unitScale 보정과 같은 값을 여기서 다시 만들 필요가 없다).
  const totalInvest = holdings.reduce((s, h) => s + (h.invest || 0), 0);
  const totalEval = holdings.reduce((s, h) => s + (h.evalAmount || 0), 0);
  const totalProfit = totalEval - totalInvest;
  const totalProfitPct = totalInvest > 0 ? (totalProfit / totalInvest) * 100 : 0;
  return {
    updatedAt: now.toISOString(),
    totalInvest, totalEval, totalProfit, totalProfitPct,
    usdRate,
    accounts,
    pendingProposalCount,
  };
}

// 필드를 명시적으로 골라 담는다(전체 스프레드 금지) — State/Holdings frontmatter에
// 나중에(Phase 8·9) 어떤 필드가 추가되든 여기 나열 안 한 값은 미러로 새 나가지 않는다
// (보안리뷰 지적, 2026-08-05 — buildTradesMirror·buildDividendsMirror와 같은 방식으로 통일).
export function buildHoldingsMirror({ holdings = [], now = new Date() }) {
  const totalEval = holdings.reduce((s, h) => s + (h.evalAmount || 0), 0);
  const items = holdings.map((h) => ({
    account: h.account ?? null, name: h.name, ticker: h.ticker ?? '', market: h.market ?? '',
    assetClass: h.assetClass ?? '', isCashLike: h.isCashLike ?? false,
    qty: h.qty, avgPrice: h.avgPrice, curPrice: h.curPrice ?? null,
    // invest: State/Holdings가 이미 정확히 계산한 값 — 화면에서 avgPrice*qty로
    // 재계산하지 말고 이 필드를 그대로 쓸 것(위 buildHomeMirror 주석과 같은 이유,
    // 한국 펀드 1,000좌당 기준가 관례에서 avgPrice*qty가 실제 투자금과 안 맞음).
    invest: h.invest ?? null,
    evalAmount: h.evalAmount, profitAmount: h.profitAmount ?? null, profitPct: h.profitPct ?? null,
    weightPct: totalEval > 0 ? ((h.evalAmount || 0) / totalEval) * 100 : 0,
  }));
  return { updatedAt: now.toISOString(), items };
}

export function buildAllocationMirror({ accounts = [], now = new Date() }) {
  return { updatedAt: now.toISOString(), accounts };
}

// dividendEvents: Facts/Ledger/Dividends 파싱 결과 배열({ date, stockName, afterTaxAmount, ... })
export function buildDividendsMirror({ dividendEvents = [], now = new Date() }) {
  const recent = dividendEvents.filter((d) => withinLastYear(d.date, now));
  const items = recent.map((d) => ({ date: d.date, ticker: d.ticker ?? '', name: d.stockName, amount: d.afterTaxAmount }));
  const ytdStart = `${now.getFullYear()}-01-01`;
  const monthStart = now.toISOString().slice(0, 7);
  const ytdTotal = items.filter((i) => i.date >= ytdStart).reduce((s, i) => s + i.amount, 0);
  const monthTotal = items.filter((i) => i.date.startsWith(monthStart)).reduce((s, i) => s + i.amount, 0);
  return { updatedAt: now.toISOString(), items, ytdTotal, monthTotal };
}

export function buildProfitsMirror({ profitEvents = [], now = new Date() }) {
  const items = profitEvents.filter((p) => withinLastYear(p.date, now));
  return { updatedAt: now.toISOString(), items };
}

// executionEvents: Facts/Ledger/Executions 파싱 결과({ tradeDate, tradeType, stockName, quantity, price, ... })
export function buildTradesMirror({ executionEvents = [], now = new Date() }) {
  const items = executionEvents
    .filter((e) => withinLastYear(e.tradeDate, now))
    .map((e) => ({
      date: e.tradeDate, side: e.tradeType, account: e.account ?? null, ticker: e.stockCode ?? '',
      assetClass: e.assetClass ?? '', name: e.stockName, price: e.price, qty: e.quantity,
      amount: e.price * e.quantity, fee: e.fee ?? 0, tax: e.tax ?? 0,
    }));
  return { updatedAt: now.toISOString(), items };
}

export function buildLatestReportMirror({ report = null, now = new Date() }) {
  if (!report) return { updatedAt: now.toISOString(), date: null, headline: '', summary: '', body: '' };
  return { updatedAt: now.toISOString(), ...report };
}

// 7개 문서를 한 번에 빌드 — sync-firestore-mirror.mjs가 이 결과를 그대로 setDoc한다.
export function buildAllMirrors(input) {
  const now = input.now ?? new Date();
  return {
    home: buildHomeMirror({ ...input, now }),
    holdings: buildHoldingsMirror({ ...input, now }),
    allocation: buildAllocationMirror({ ...input, now }),
    dividends: buildDividendsMirror({ ...input, now }),
    profits: buildProfitsMirror({ ...input, now }),
    trades: buildTradesMirror({ ...input, now }),
    latestReport: buildLatestReportMirror({ ...input, now }),
  };
}
