// 주간 리포트 facts 조립기 — 순수 함수(네트워크 없음). weekly-report.mjs가 페치한 결정론
// 데이터를 받아 리포트 프롬프트에 주입할 facts 객체 + factsText로 조립한다.
// 원칙(risk-monitor·eval-facts와 동일): raw 숫자는 LLM이 만들지 않는다. 여기서 계산한 값만 쓴다.
import { EXEC_COL as T } from './sheet-contracts.mjs';
import { parseSell, collectBuys } from './behavior-signals.mjs';

const round1 = (v) => Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
const won = (v) => Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '데이터 부족';
const pct = (v) => v == null ? '데이터 부족' : `${v}%`;

// 체결내역 스키마: A날짜0 B구분1 C계좌2 D코드3 E자산군4 F종목명5 G체결가6 H수량7 I금액8
// buysAll: 전체 매수 이력(behavior-signals.mjs parseBuy 결과) — 매도 행의 실현손익 계산용.
// 매도의 익절/손절은 반드시 여기서 계산한 realizedPct로만 판단한다 — 체결행 자체의
// 손익/수익률 컬럼(K/L/M)은 매도 후에도 현재가로 계속 재계산되는 라이브 스냅샷이라 실제
// 매도손익이 아니다(2026-07 삼성바이오로직스·현대차 리포트가 이 컬럼을 그대로 서술에 써서
// 손절을 익절로 잘못 보고한 사고 — LLM에게 근거 숫자를 안 주고 "성향 부합 코멘트"만
// 시켰더니 스스로 방향을 추측/날조했던 것도 같은 사고의 원인이었다).
function parseTrade(r, buysAll) {
  const side = String(r[T.SIDE] ?? '').trim();
  const base = {
    date: String(r[T.DATE] ?? '').trim(), side,
    account: String(r[T.ACCT] ?? '').trim(), name: String(r[T.NAME] ?? '').trim(),
    price: String(r[T.PRICE] ?? '').trim(), qty: String(r[T.QTY] ?? '').trim(), amount: String(r[T.AMOUNT] ?? '').trim(),
  };
  if (side !== '매도') return { ...base, realizedPct: null, partialHistory: false };
  const { realizedPct, partialHistory } = parseSell(r, buysAll);
  return { ...base, realizedPct, partialHistory };
}
// 배당금 스키마: A날짜0 B금액1 C종목명2
function parseDividend(r) {
  return { date: String(r[0] ?? '').trim(), amount: String(r[1] ?? '').trim(), name: String(r[2] ?? '').trim() };
}

/**
 * @param input.asof          발행일 'YYYY-MM-DD'
 * @param input.weekStart     이번 주 시작일 'YYYY-MM-DD' (체결·배당 필터 기준, 이상)
 * @param input.holdings      readHoldings() 결과
 * @param input.macro         fetchMacroIndicators() 결과
 * @param input.sheetByName    Map<name, {price, eval, qty}> — 시트 현재가(F)·평가액(H)·수량(D). 자산 값의 정본(추정 금지)
 * @param input.marketByName  Map<name, {weekChange, pos52w, rsi14, forwardPE, pbr, high52w, source}> — 분석 지표만(자산 값 아님)
 * @param input.fundByName    Map<name, {opMargin, roe, debtRatio, revenueYoY, source}>
 * @param input.riskRows      리스크모니터!A2:H
 * @param input.baselineRows  리스크기준선!A2:J
 * @param input.noteRows      종목투자노트!A2:U
 * @param input.tradeRows     체결내역 rows
 * @param input.dividendRows  배당금!A2:C
 * @param input.prevReport    {date, summary} | null
 */
export function buildReportFacts(input) {
  const {
    asof, weekStart, holdings = [], macro = {},
    sheetByName = new Map(), marketByName = new Map(), fundByName = new Map(),
    riskRows = [], baselineRows = [], noteRows = [], tradeRows = [], dividendRows = [], prevReport = null,
  } = input;

  // ── 보유 종목별 산출 ──────────────────────────────────
  // 자산 값(현재가·평가액·수량)은 항상 시트에서 읽는다(추정·재계산 금지 — 시트가 정본).
  // 분석 지표(52주위치·RSI·밸류에이션·펀더멘털)만 yfinance/OpenDart 라이브.
  const hList = holdings.map((h) => {
    const qty = h.accounts.reduce((s, a) => s + (a.qty || 0), 0);
    const invest = h.accounts.reduce((s, a) => s + (a.invest || 0), 0);
    const sheet = sheetByName.get(h.name) || {};
    const mkt = marketByName.get(h.name) || {};
    const fund = fundByName.get(h.name) || {};
    const cp = Number.isFinite(sheet.price) ? sheet.price : null;       // 현재가 = 시트(F열)
    const evalValue = Number.isFinite(sheet.eval) ? Math.round(sheet.eval) : null;  // 평가액 = 시트(H열)
    const totalReturnPct = (evalValue != null && invest > 0)
      ? Math.round((evalValue - invest) / invest * 1000) / 10 : null;
    return {
      name: h.name, market: h.market, type: h.type, qty, invest,
      currentPrice: cp, evalValue, totalReturnPct,
      weekChange: round1(mkt.weekChange), pos52w: round1(mkt.pos52w), rsi14: round1(mkt.rsi14),
      forwardPE: mkt.forwardPE ?? null, pbr: mkt.pbr ?? null, high52w: mkt.high52w ?? null,
      fundamentals: {
        opMargin: fund.opMargin ?? null, roe: fund.roe ?? null,
        debtRatio: fund.debtRatio ?? null, revenueYoY: fund.revenueYoY ?? null,
      },
      marketSource: mkt.source || '데이터 부족', fundSource: fund.source || '데이터 부족',
    };
  });

  // ── 자산군 비중(평가액 기준) ─────────────────────────
  const totalEval = hList.reduce((s, h) => s + (h.evalValue || 0), 0) || 1;
  const byType = {};
  for (const h of hList) byType[h.type || '기타'] = (byType[h.type || '기타'] || 0) + (h.evalValue || 0);
  const assetClasses = Object.entries(byType)
    .map(([type, evalValue]) => ({ type, evalValue, weightPct: Math.round(evalValue / totalEval * 1000) / 10 }))
    .sort((a, b) => b.evalValue - a.evalValue);

  // ── 계좌별 합계 ──────────────────────────────────────
  // 종목 평가액(시트값)을 계좌별로 배분. 수량>0이면 수량 비중, 수량 0(현금성·MMF)이면 원금 비중,
  // 둘 다 0이면 계좌 수 균등 — 어떤 경우든 종목 평가액 총합이 계좌 합계와 일치하도록(누락 방지).
  const evalByName = new Map(hList.map(h => [h.name, h]));
  const byAcct = {};
  for (const h of holdings) {
    const he = evalByName.get(h.name);
    const totalQty = h.accounts.reduce((s, a) => s + (a.qty || 0), 0);
    const totalInv = h.accounts.reduce((s, a) => s + (a.invest || 0), 0);
    const n = h.accounts.length;
    h.accounts.forEach((a, i) => {
      byAcct[a.acct] = byAcct[a.acct] || { acct: a.acct, invest: 0, evalValue: 0 };
      byAcct[a.acct].invest += a.invest || 0;
      if (he?.evalValue == null) return;
      const w = totalQty > 0 ? (a.qty || 0) / totalQty
        : totalInv > 0 ? (a.invest || 0) / totalInv
        : 1 / n;
      byAcct[a.acct].evalValue += Math.round(he.evalValue * w);
    });
  }
  const accounts = Object.values(byAcct);

  // ── 리스크 신호 재인용 (재계산 금지) ─────────────────
  // 최신 거시(D): 가장 최근 날짜의 D 행. 종목별 논리(B): 종목별 최신 1건.
  let macroSignal = null;
  const bByTarget = new Map();
  for (const r of riskRows) {
    const date = String(r[0] ?? '').trim(), type = String(r[1] ?? '').trim();
    const target = String(r[2] ?? '').trim(), signal = String(r[3] ?? '').trim();
    const summary = String(r[4] ?? '').trim();
    if (type === 'D') {
      if (!macroSignal || date > macroSignal.date) macroSignal = { date, target, signal, summary };
    } else if (type === 'B') {
      const prev = bByTarget.get(target);
      if (!prev || date > prev.date) bByTarget.set(target, { date, target, signal, summary });
    }
  }
  const logicSignals = [...bByTarget.values()];

  // ── 기준선·매수노트 ──────────────────────────────────
  const baselines = baselineRows.map((r) => ({
    name: String(r[0] ?? '').trim(), date: String(r[3] ?? '').trim(),
    grossMargin: r[4], opMargin: r[5], roe: r[6], debtRatio: r[7], eps: r[8], pbr: r[9],
  })).filter(b => b.name);
  const buyNotes = (() => {
    const m = new Map();
    for (const r of noteRows) {
      const name = String(r[1] ?? '').trim();
      const date = String(r[0] ?? '').trim();
      if (!name || String(r[14] ?? '').trim() === '매도') continue;
      const cur = m.get(name);
      if (!cur || date > cur.date) {
        m.set(name, { name, date, conclusion: String(r[4] ?? '').trim(),
          reasons: String(r[10] ?? '').trim(), risks: String(r[11] ?? '').trim() });
      }
    }
    return [...m.values()];
  })();

  // ── 이번 주 체결·배당 (weekStart 이상) ────────────────
  const inWeek = (d) => weekStart ? (d && d >= weekStart) : true;
  // buysAll은 전체 이력(주간 필터 전) — 이번 주 매도가 그 이전 매수와 매칭돼야 하므로.
  const buysAll = collectBuys(tradeRows);
  const weekTrades = tradeRows.map(r => parseTrade(r, buysAll)).filter(t => t.name && inWeek(t.date));
  const weekDividends = dividendRows.map(parseDividend).filter(d => d.name && inWeek(d.date));

  const facts = {
    asof, weekStart, totalEval: hList.some(h => h.evalValue != null) ? totalEval : null,
    macro, holdings: hList, assetClasses, accounts,
    macroSignal, logicSignals, baselines, buyNotes, weekTrades, weekDividends, prevReport,
  };

  return { facts, factsText: renderFactsText(facts) };
}

// LLM 프롬프트 주입용 — facts를 압축 텍스트로. 모든 수치는 여기 값만 인용하도록 강제.
function renderFactsText(f) {
  const L = [];
  L.push(`■ 발행일 ${f.asof} · 주간 구간 ${f.weekStart}~${f.asof}`);
  if (f.prevReport) L.push(`■ 직전 리포트(${f.prevReport.date}) 요약: ${f.prevReport.summary}`);

  L.push('\n■ 거시 지표 (5거래일 변화 %)');
  for (const [k, o] of Object.entries(f.macro)) {
    if (!o || o.value == null) { L.push(`  - ${k}: 데이터 없음`); continue; }
    const c = o.change5d == null ? '' : ` (5d ${o.change5d >= 0 ? '+' : ''}${o.change5d}%)`;
    L.push(`  - ${k}: ${o.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${c} [${o.source || ''}]`);
  }

  L.push('\n■ 보유 종목 (현재가·평가액·총수익률은 결정론 산출값)');
  for (const h of f.holdings) {
    L.push(`  · ${h.name} (${h.market}/${h.type}) 수량 ${h.qty} · 원금 ${won(h.invest)}원`
      + ` · 현재가 ${h.currentPrice != null ? won(h.currentPrice) : '데이터 부족'}`
      + ` · 평가액 ${h.evalValue != null ? won(h.evalValue) + '원' : '데이터 부족'}`
      + ` · 총수익률 ${pct(h.totalReturnPct)}`
      + ` · 주간 ${pct(h.weekChange)} · 52주위치 ${pct(h.pos52w)} · RSI ${h.rsi14 ?? '–'}`
      + ` · FwdPER ${h.forwardPE ?? '–'} · PBR ${h.pbr ?? '–'}`);
    L.push(`      펀더멘털: 영익률 ${pct(h.fundamentals.opMargin)} · ROE ${pct(h.fundamentals.roe)}`
      + ` · 부채 ${pct(h.fundamentals.debtRatio)} · 매출YoY ${pct(h.fundamentals.revenueYoY)} [${h.fundSource}]`);
  }

  L.push('\n■ 자산군 비중 (평가액 기준)');
  for (const a of f.assetClasses) L.push(`  - ${a.type}: ${a.weightPct}% (${won(a.evalValue)}원)`);
  L.push(`  - 총 평가액: ${f.totalEval != null ? won(f.totalEval) + '원' : '데이터 부족'}`);

  L.push('\n■ 계좌별 합계');
  for (const a of f.accounts) L.push(`  - ${a.acct}: 원금 ${won(a.invest)}원 · 평가액 ${won(a.evalValue)}원`);

  L.push('\n■ 리스크 신호 (리스크모니터 탭 재인용 — 재계산 금지)');
  L.push(`  - 거시(D): ${f.macroSignal ? `${f.macroSignal.signal} ${f.macroSignal.summary} (${f.macroSignal.date})` : '기록 없음'}`);
  for (const s of f.logicSignals) L.push(`  - 논리(B) ${s.target}: ${s.signal} ${s.summary} (${s.date})`);

  if (f.buyNotes.length) {
    L.push('\n■ 매수 논리 (종목투자노트)');
    for (const n of f.buyNotes) L.push(`  - ${n.name}(${n.date}) ${n.conclusion} · 근거: ${n.reasons} · 리스크: ${n.risks}`);
  }

  L.push('\n■ 이번 주 체결');
  if (f.weekTrades.length) for (const t of f.weekTrades)
    L.push(`  - ${t.date} ${t.side} ${t.name} ${t.qty}주 @${t.price} (${t.account})`
      + (t.side === '매도'
        ? ` · 실현 ${t.realizedPct != null ? (t.realizedPct >= 0 ? '+' : '') + t.realizedPct + '%' : '매입평균 불명'}`
          + (t.partialHistory ? ' (매입이력 일부만 추적됨)' : '')
        : ''));
  else L.push('  - (이번 주 체결 없음)');

  L.push('\n■ 이번 주 배당');
  if (f.weekDividends.length) for (const d of f.weekDividends) L.push(`  - ${d.date} ${d.name} ${won(Number(d.amount))}원`);
  else L.push('  - (이번 주 배당 없음)');

  return L.join('\n');
}
