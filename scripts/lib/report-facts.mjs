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

// Facts/Ledger/Profits(type: "realized-profit") 정본 조회 키 — date|account|name|qty
// 정확일치만(추정 금지, ADR 0003과 동일 원칙). 2026-08-30 오너 신고로 발견: PLUS
// 고배당주·TIGER 미국배당다우존스가 리포트에서 "손익 미확정"으로 나왔는데, 이유는
// Executions 원장에 매수 체결이 하나도 없어서였다(v1→v2 이관 이전 매수 포지션이라
// 매수 "체결" 자체가 기록된 적 없음, 매도 4건만 있음) — 그래서 아래 parseSell의
// 매입평균 재구성이 항상 실패. 그런데 Facts/Ledger/Profits엔 이미 정확한 실현손익이
// 있다(대시보드 "수익금" 탭이 정확히 읽고 있는 바로 그 원장) — 리포트가 이 원장
// 자체를 안 읽고 있던 게 진짜 원인. 이 키 함수를 만들고 정확일치로 우선 조회한다.
const profitKey = (date, account, name, qty) => `${date}|${account}|${name}|${qty}`;

// 체결내역 스키마: A날짜0 B구분1 C계좌2 D코드3 E자산군4 F종목명5 G체결가6 H수량7 I금액8
// profitByKey: Facts/Ledger/Profits 정본을 위 profitKey로 인덱싱한 Map(비어있으면 항상
// fallback으로 감 — 하위호환, 호출부가 안 넘겨도 기존 동작 그대로).
function parseTrade(r, buysAll, profitByKey, profitByKeyNoAccount) {
  const side = String(r[T.SIDE] ?? '').trim();
  const date = String(r[T.DATE] ?? '').trim();
  const account = String(r[T.ACCT] ?? '').trim();
  const name = String(r[T.NAME] ?? '').trim();
  const qty = String(r[T.QTY] ?? '').trim();
  const base = {
    date, side, account, name,
    price: String(r[T.PRICE] ?? '').trim(), qty, amount: String(r[T.AMOUNT] ?? '').trim(),
  };
  if (side !== '매도') return { ...base, realizedPct: null, realizedWon: null, partialHistory: false, ledgerMatched: false };

  // ⚠️ 코드리뷰 지적(2026-08-30) — ledgerMatched를 매칭 성공 여부만으로 true 처리하면,
  // 원장 레코드에 profit이 없는(malformed) 극단 케이스에서 realizedWon이 null인데도
  // "정본 원장" 표시가 나가 렌더링 시 `null >= 0`이 JS에서 true로 강제변환돼
  // "실현손익 +데이터 부족원(정본 원장)" 같은 말이 안 되는 텍스트가 LLM에 그대로
  // 주입될 뻔했다(프롬프트가 "정본 원장 표시가 있으면 그대로 인용해라"라고 시키므로
  // 그대로 리포트에 나갈 수 있었음). profit이 실제로 유한수일 때만 매칭 성공으로 친다.
  const ledgerHit = profitByKey?.get(profitKey(date, account, name, qty))
    ?? profitByKeyNoAccount?.get(`${date}|${name}|${qty}`);
  if (ledgerHit && Number.isFinite(ledgerHit.profit)) {
    const pct = Number.isFinite(ledgerHit.buyPrice) && ledgerHit.buyPrice > 0
      ? round1((ledgerHit.sellPrice - ledgerHit.buyPrice) / ledgerHit.buyPrice * 100) : null;
    return { ...base, realizedPct: pct, realizedWon: Math.round(ledgerHit.profit), partialHistory: false, ledgerMatched: true };
  }
  const { realizedPct, partialHistory } = parseSell(r, buysAll);
  return { ...base, realizedPct, realizedWon: null, partialHistory, ledgerMatched: false };
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
    asof, weekStart, holdings = [], macro = {}, tradeRows = [], dividendRows = [], profitRows = [], prevReport = null,
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
    // allCash: 코드리뷰 지적(2026-08-30) — "이 계좌는 전액 현금이라 현금 합계에 이미
    // 포함됨" 노트를 문장으로 단정하지 말고 실제로 검증하라는 지적. 계좌 안의 보유가
    // 전부 assetClass "현금"일 때만 true로 남는다(현금 아닌 보유가 하나라도 섞이면
    // 그 즉시 false로 굳어짐 — 나중에 그 계좌에 다른 자산이 들어와도 이 판정이 자동
    // 갱신되게).
    byAcct[acct] = byAcct[acct] || { acct, invest: 0, evalValue: 0, allCash: true };
    byAcct[acct].invest += Number(h.invest) || 0;
    if (Number.isFinite(h.evalAmount)) byAcct[acct].evalValue += h.evalAmount;
    if (h.assetClass !== '현금') byAcct[acct].allCash = false;
  }
  const accounts = Object.values(byAcct).map((a) => ({ ...a, evalValue: Math.round(a.evalValue) }));

  // ── 이번 주 체결·배당 (weekStart 이상) ────────────────
  const inWeek = (d) => weekStart ? (d && d >= weekStart) : true;
  const buysAll = collectBuys(tradeRows);
  // ⚠️ 코드리뷰 지적(2026-08-30) — account가 정확일치 키에 필수라 v1 이관 레거시
  // Profits 레코드(account: null, 실측 37건 중 23건)가 전부 조용히 버려지고 있었다
  // (feedback-no-silent-fallback 원칙 위반 — 가용성보다 출처 추적성이 우선이라지만
  // "매칭 안 됨"과 "데이터 자체가 없음"은 다른 사실이라 최소한 매칭은 시도해야 한다).
  // account 있는 레코드는 기존처럼 4필드 정확일치(우선), account 없는 레코드만 3필드
  // (date|name|qty)로 별도 보조 조회 — 완전정본(계좌까지 일치)이 항상 우선이고, 보조
  // 조회는 그게 없을 때만 쓰인다.
  const profitByKey = new Map();
  const profitByKeyNoAccount = new Map();
  for (const p of profitRows) {
    if (!p.date || !p.stockName || p.quantity == null) continue;
    if (p.account) profitByKey.set(profitKey(String(p.date), String(p.account), String(p.stockName), String(p.quantity)), p);
    else profitByKeyNoAccount.set(`${p.date}|${p.stockName}|${p.quantity}`, p);
  }
  const weekTrades = tradeRows.map(r => parseTrade(r, buysAll, profitByKey, profitByKeyNoAccount)).filter(t => t.name && inWeek(t.date));
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
  // ⚠️ 전액 현금 계좌(예: CMA)는 위 "자산군 비중"의 현금 항목에 이미 포함돼 있다 —
  // 둘을 따로 더하면 이중계산이다(2026-08-30 오너 신고로 발견: 리포트가 "CMA
  // (21,054,004원) + 현금(30,132,560원) 실탄 충분"이라고 둘을 더해 써서, 실제
  // 30,132,560원인 총 실탄을 51,186,564원으로 부풀려 보고한 사고). 코드리뷰 지적으로
  // "CMA는 전액 현금이다"를 문장으로 단정하지 않고 실제 보유 구성에서 검증
  // (allCash, 위 계좌별 합계 계산부 참고) — 'CMA'라는 계좌명 하드코딩도 제거해
  // 앞으로 다른 계좌가 전액현금이 돼도 동일하게 잡힌다.
  for (const a of f.accounts) {
    if (a.allCash && a.evalValue > 0) L.push(`  ⚠️ ${a.acct}(${won(a.evalValue)}원)는 전액 현금이라 위 "자산군 비중"의 현금 합계 안에 이미 포함됨 — 실탄 계산 시 현금 합계에 ${a.acct}를 별도로 또 더하지 말 것.`);
  }

  L.push('\n■ 이번 주 체결');
  if (f.weekTrades.length) for (const t of f.weekTrades)
    L.push(`  - ${t.date} ${t.side} ${t.name} ${t.qty}주 @${t.price} (${t.account})`
      + (t.side === '매도'
        ? t.ledgerMatched
          // Facts/Ledger/Profits 정본 매칭(2026-08-30 신설) — 대시보드 "수익금" 탭과
          // 같은 원장, 정확한 원화 실현손익. 재구성(추정)이 아니라 기록된 사실이라
          // "정본" 표기로 프롬프트에서도 구분되게 한다.
          ? ` · 실현손익 ${t.realizedWon >= 0 ? '+' : ''}${won(t.realizedWon)}원(${t.realizedPct != null ? `${t.realizedPct >= 0 ? '+' : ''}${t.realizedPct}%, ` : ''}정본 원장)`
          : ` · 실현 ${t.realizedPct != null ? (t.realizedPct >= 0 ? '+' : '') + t.realizedPct + '%' : '매입평균 불명'}`
            + (t.partialHistory ? ' (매입이력 일부만 추적됨)' : '')
        : ''));
  else L.push('  - (이번 주 체결 없음)');

  L.push('\n■ 이번 주 배당');
  if (f.weekDividends.length) for (const d of f.weekDividends) L.push(`  - ${d.date} ${d.name} ${won(Number(d.amount))}원`);
  else L.push('  - (이번 주 배당 없음)');

  return L.join('\n');
}
