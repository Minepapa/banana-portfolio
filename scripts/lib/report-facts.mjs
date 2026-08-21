// 주간 리포트 facts 조립기 — 순수 함수(네트워크 없음). weekly-report.mjs가 읽은 Vault
// 데이터를 받아 리포트 프롬프트에 주입할 facts 객체 + factsText로 조립한다.
// 원칙(risk-monitor·eval-facts와 동일): raw 숫자는 LLM이 만들지 않는다. 여기서 계산한 값만 쓴다.
//
// ⚠️ 2026-08-20 Vault 네이티브 재작성(MVP 범위, docs/IMPLEMENTATION-PLAN.md 주간리포트
// v2 이관 참고) — holdings는 이제 State/Holdings 원본(계좌당 파일 하나, 평가액·현재가를
// 이미 자체적으로 들고 있음)이라 v1의 sheetByName(시트 현재가·평가액 별도 조회) 개념이
// 통째로 불필요해졌다. 라이브 시장지표(52주위치·RSI·PER·PBR)·펀더멘털(marketByName·
// fundByName)·리스크신호 재인용(riskRows)·기준선(baselineRows)·매수노트(noteRows)는
// 아직 Vault에 살아있는 쓰기 주체가 없어(리스크모니터=risk-b 미이관, 종목투자노트=Vault
// 경로 자체가 없음) MVP 범위에서 뺐다 — 없는 데이터를 있는 척 텅 빈 섹션으로 채우지
// 않는다(feedback-no-silent-fallback 원칙). 나중에 그 소스들이 Vault 네이티브가 되면
// 이 함수에 파라미터로 되살리면 된다.
//
// tradeRows·dividendRows는 v1과 동일한 row-array 스키마를 그대로 유지한다(EXEC_COL
// 인덱스 기반) — behavior-signals.mjs의 parseSell/collectBuys(매입평균 기반 실현손익
// 계산, 2026-07 현대차·삼성바이오로직스 사고 회귀방지 로직)를 손대지 않고 그대로
// 재사용하기 위함. 호출부(weekly-report.mjs)가 Vault Executions/Dividends 객체를 이
// row-array로 변환해 넘긴다.
import { EXEC_COL as T } from './sheet-contracts.mjs';
import { parseSell, collectBuys } from './behavior-signals.mjs';

const round1 = (v) => Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
const won = (v) => Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '데이터 부족';

// 체결내역 스키마: A날짜0 B구분1 C계좌2 D코드3 E자산군4 F종목명5 G체결가6 H수량7 I금액8
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
 * @param input.holdings      State/Holdings 원본 배열(frontmatter 객체 그대로 — 계좌당 파일 하나)
 * @param input.macro         fetchMacroIndicators() 결과
 * @param input.tradeRows     체결내역 row-array(EXEC_COL 인덱스, weekly-report.mjs가 변환)
 * @param input.dividendRows  배당 row-array([날짜, 금액, 종목명], weekly-report.mjs가 변환)
 * @param input.prevReport    {date, summary} | null
 */
export function buildReportFacts(input) {
  const {
    asof, weekStart, holdings = [], macro = {}, tradeRows = [], dividendRows = [], prevReport = null,
  } = input;

  // ── 종목명 기준 집계(같은 종목이 여러 계좌에 걸치면 합산 — 위탁+연금저축 동시보유 등) ──
  const byName = new Map();
  for (const h of holdings) {
    const name = String(h.name ?? '').trim();
    if (!name) continue;
    const cur = byName.get(name) || {
      name, market: String(h.assetClass ?? '').includes('해외') ? 'US' : 'KR',
      type: h.assetClass || '기타', qty: 0, invest: 0, evalValue: 0, hasEval: false, isCashLike: !!h.isCashLike,
    };
    cur.qty += Number(h.qty) || 0;
    cur.invest += Number(h.invest) || 0;
    if (Number.isFinite(h.evalAmount)) { cur.evalValue += h.evalAmount; cur.hasEval = true; }
    byName.set(name, cur);
  }
  const hList = [...byName.values()].map((h) => ({
    name: h.name, market: h.market, type: h.type, qty: h.qty, invest: h.invest,
    evalValue: h.hasEval ? Math.round(h.evalValue) : null,
    totalReturnPct: (h.hasEval && h.invest > 0) ? Math.round((h.evalValue - h.invest) / h.invest * 1000) / 10 : null,
  }));

  // ── 자산군 비중(평가액 기준) ─────────────────────────
  const totalEval = hList.reduce((s, h) => s + (h.evalValue || 0), 0) || 1;
  const byType = {};
  for (const h of hList) byType[h.type || '기타'] = (byType[h.type || '기타'] || 0) + (h.evalValue || 0);
  const assetClasses = Object.entries(byType)
    .map(([type, evalValue]) => ({ type, evalValue, weightPct: Math.round(evalValue / totalEval * 1000) / 10 }))
    .sort((a, b) => b.evalValue - a.evalValue);

  // ── 계좌별 합계(원본 Vault holding 그대로 — 계좌당 파일 하나라 배분 계산 자체가 불필요,
  // v1은 종목 하나를 여러 계좌 시트에서 각각 봐야 했지만 Vault는 이미 계좌 단위 원자 레코드) ──
  const byAcct = {};
  for (const h of holdings) {
    const acct = String(h.account ?? '').trim();
    if (!acct) continue;
    byAcct[acct] = byAcct[acct] || { acct, invest: 0, evalValue: 0 };
    byAcct[acct].invest += Number(h.invest) || 0;
    if (Number.isFinite(h.evalAmount)) byAcct[acct].evalValue += h.evalAmount;
  }
  const accounts = Object.values(byAcct).map((a) => ({ ...a, evalValue: Math.round(a.evalValue) }));

  // ── 이번 주 체결·배당 (weekStart 이상) ────────────────
  const inWeek = (d) => weekStart ? (d && d >= weekStart) : true;
  const buysAll = collectBuys(tradeRows);
  const weekTrades = tradeRows.map(r => parseTrade(r, buysAll)).filter(t => t.name && inWeek(t.date));
  const weekDividends = dividendRows.map(parseDividend).filter(d => d.name && inWeek(d.date));

  const facts = {
    asof, weekStart, totalEval: hList.some(h => h.evalValue != null) ? totalEval : null,
    macro, holdings: hList, assetClasses, accounts, weekTrades, weekDividends, prevReport,
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

  L.push('\n■ 보유 종목 (현재가·라이브 지표는 이번 버전에 없음 — 평가액·총수익률만)');
  for (const h of f.holdings) {
    L.push(`  · ${h.name} (${h.market}/${h.type}) 수량 ${h.qty} · 원금 ${won(h.invest)}원`
      + ` · 평가액 ${h.evalValue != null ? won(h.evalValue) + '원' : '데이터 부족'}`
      + ` · 총수익률 ${h.totalReturnPct != null ? `${h.totalReturnPct}%` : '데이터 부족'}`);
  }

  L.push('\n■ 자산군 비중 (평가액 기준)');
  for (const a of f.assetClasses) L.push(`  - ${a.type}: ${a.weightPct}% (${won(a.evalValue)}원)`);
  L.push(`  - 총 평가액: ${f.totalEval != null ? won(f.totalEval) + '원' : '데이터 부족'}`);

  L.push('\n■ 계좌별 합계');
  for (const a of f.accounts) L.push(`  - ${a.acct}: 원금 ${won(a.invest)}원 · 평가액 ${won(a.evalValue)}원`);

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
