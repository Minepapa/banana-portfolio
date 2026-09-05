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
import { buildProfitLookup } from './realized-profit-ledger.mjs';
import { resolveDesignatedCashBalance, findCashBalance, DESIGNATED_CASH_ACCOUNTS, CASH_ELIGIBLE_ACCOUNTS } from './cash-ledger.mjs';
// 종목명 표준화(2026-09-05) — realized-profit-ledger.mjs 헤더 주석과 동일 원칙.
import { resolveCanonicalStockName } from './stock-registry.mjs';

const won = (v) => Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '데이터 부족';

// ⚠️ 계좌 간 현금 이동 가능 여부(2026-08-30 신설, 오너 지적으로 발견) — 리포트가
// "현금 합계(6계좌 전부) = 실탄"이라고 서술했는데, ARCHITECTURE-V2.md "계좌를 실제로
// 어떻게 옮기나" 절(2026-08-01/04 확정)이 이미 "연금저축은 중도 인출 시 세액공제
// 클로백·소득세가 붙어 계좌 밖으로 현금을 뺄 수 없다 — 계좌 간 조정은 실제 이체가
// 아니라 각 계좌가 자기 자금으로 내부에서만 매도·매수"라고 명시해뒀다. IRP(퇴직연금)·
// ISA(만기 전 인출 시 세제혜택 상실)도 같은 성격. 즉 "실탄"은 계좌 하나로 뭉뚱그려
// 말할 수 없고, 그 매수를 할 계좌 자신의 현금만 봐야 한다 — CMA 이중계산은 그 원칙이
// 드러난 한 사례일 뿐이었다.
//
// "위탁+금현물"만 자유롭게 합쳐 쓸 수 있는 현금이라는 정의는 이미 cash-ledger.mjs
// resolveDesignatedCashBalance에 있다(신규현금배분 잡이 실제로 쓰는 바로 그 함수) —
// 여기서 새로 정의하지 않고 그 함수를 그대로 재사용한다(같은 개념을 두 번 정의하면
// 갈라진다는 게 이번 사고 전체의 교훈).
//
// ⚠️ 후속 코드리뷰 지적(같은 날) — 처음엔 "그 계좌의 현금"을 `assetClass === '현금'`인
// 보유 전부를 더해서 독립적으로 재구현했는데, 이게 정확히 이 리팩터가 막으려던
// "같은 개념을 두 번 정의" 패턴의 재발이었다(new-cash-allocation.mjs는 "이름이
// 정확히 '예수금'인 보유 하나"라는 더 엄격한 규칙을 씀 — 외화RP처럼 isCashLike인데
// assetClass가 "현금"이 아닌 보유나, 계좌에 "현금" 보유가 두 개 이상 생기면 조용히
// 갈라질 뻔했다). findCashBalance 하나로 통일 — "그 계좌 현금이 뭔지"의 선택 규칙은
// 이제 cash-ledger.mjs 한 곳에만 있다.
const LOCKED_TAX_ADVANTAGED_ACCOUNTS = new Set(['연금저축', 'ISA', 'IRP']);
// cash-ledger.mjs DESIGNATED_CASH_ACCOUNTS(resolveDesignatedCashBalance의 실제
// 파라미터 목록)에서 그대로 파생 — 별도 계좌명 목록을 여기서 다시 하드코딩하지
// 않는다(코드리뷰 지적: 그러면 두 목록이 갈라질 수 있음).
const KNOWN_DESIGNATED_ACCOUNTS = new Set(DESIGNATED_CASH_ACCOUNTS);

// 체결내역 스키마: A날짜0 B구분1 C계좌2 D코드3 E자산군4 F종목명5 G체결가6 H수량7 I금액8
// profitLookup: realized-profit-ledger.mjs buildProfitLookup() 결과(비어있으면 항상
// fallback으로 감 — 하위호환, 호출부가 안 넘겨도 기존 동작 그대로). Profits 정본 조회
// "먼저 원장, 없으면 재구성" 분기 자체는 behavior-signals.mjs의 parseSell이 이미
// 구현하고 있다 — 여기서 같은 분기를 다시 쓰면 그 분기 로직 자체가 두 곳에 존재하게
// 돼(코드리뷰 지적, 2026-08-30) 한쪽만 고치면 갈라진다. parseSell에 위임하고 여기선
// 매도 행의 부가 필드(구분·계좌 등 문자열 원본)만 조립한다.
function parseTrade(r, buysAll, profitLookup, registry) {
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

  const sell = parseSell(r, buysAll, profitLookup, registry);
  return { ...base, realizedPct: sell.realizedPct, realizedWon: sell.realizedWon, partialHistory: sell.partialHistory, ledgerMatched: sell.ledgerMatched };
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
 * @param input.registry      stock-registry.mjs getCodeRegistry() 결과(선택, 2026-09-05
 *   신설) — 종목명 표시·Profits 매칭 정규화(behavior-signals.mjs @param input.registry
 *   와 동일 이유).
 */
export function buildReportFacts(input) {
  const {
    asof, weekStart, holdings = [], macro = {}, tradeRows = [], dividendRows = [], profitRows = [], prevReport = null,
    registry = new Map(),
  } = input;

  // ── 종목명 기준 집계(같은 종목이 여러 계좌에 걸치면 합산 — 위탁+연금저축 동시보유 등) ──
  const byName = new Map();
  for (const h of holdings) {
    const name = resolveCanonicalStockName(String(h.name ?? '').trim(), registry);
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
  // ⚠️ 코드리뷰 지적(2026-08-30) — rawTotalEval에 `|| 1`을 씌운 값을 그대로
  // facts.totalEval로 노출하고 있었다. 그 `|| 1`은 아래 weightPct 나눗셈(0으로 나누기
  // 방지)에만 필요한데, 보유가 전부 evalValue=0(null 아님)인 극단 케이스에서
  // "총 평가액: 1원"이라는 틀린 사실이 그대로 리포트에 노출될 뻔했다. 나눗셈용
  // 가드와 실제 노출값을 분리한다.
  const rawTotalEval = hList.reduce((s, h) => s + (h.evalValue || 0), 0);
  const totalEval = rawTotalEval || 1; // weightPct 분모 전용 — facts.totalEval엔 쓰지 않음
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
  const profitLookup = buildProfitLookup(profitRows, registry);
  const weekTrades = tradeRows.map(r => parseTrade(r, buysAll, profitLookup, registry)).filter(t => t.name && inWeek(t.date));
  const weekDividends = dividendRows.map(parseDividend).filter(d => d.name && inWeek(d.date));

  const facts = {
    asof, weekStart, totalEval: hList.some(h => h.evalValue != null) ? rawTotalEval : null,
    macro, holdings: hList, assetClasses, accounts, weekTrades, weekDividends, prevReport,
  };

  return { facts, factsText: renderFactsText(facts, holdings) };
}

// LLM 프롬프트 주입용 — facts를 압축 텍스트로. 모든 수치는 여기 값만 인용하도록 강제.
function renderFactsText(f, holdings = []) {
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

  // ⚠️ 계좌별 현금 가용성(2026-08-30 신설, 오너 지적으로 발견) — 원래 리포트가 "CMA
  // (21,054,004원) + 현금(30,132,560원) 실탄 충분"이라고 서술해, CMA가 이미 "현금"
  // 자산군 합계의 부분집합인데 별도로 더해 실탄을 51,186,564원으로 부풀렸다. 원인을
  // 더 파보니 문제는 CMA 하나가 아니었다 — ARCHITECTURE-V2.md "계좌를 실제로 어떻게
  // 옮기나" 절(2026-08-01/04 확정)이 이미 "연금저축·IRP·ISA는 세제혜택 계좌라 중도
  // 인출 시 페널티가 붙어 계좌 밖으로 현금을 뺄 수 없다 — 계좌 간 조정은 실제 이체가
  // 아니라 각 계좌가 자기 자금으로 내부에서만" 원칙을 명시해뒀다. 즉 "현금 합계 하나 =
  // 실탄"이라는 틀 자체가 틀렸다 — 그 매수를 할 계좌 자신의 현금만 실탄이다.
  //
  // "그 계좌의 현금이 뭔지"는 findCashBalance(cash-ledger.mjs, new-cash-allocation.mjs와
  // 공유)로만 조회한다 — assetClass 기반 자체 합산을 쓰지 않는다(코드리뷰 지적: 그러면
  // "같은 개념을 두 번 정의"가 재발함). "자유 재투자 가능" 합산도 resolveDesignatedCashBalance
  // (신규현금배분 잡이 실제로 쓰는 정의) 그대로 재사용.
  //
  // ⚠️ 계좌 목록을 닫힌 집합으로 하드코딩하지 않는다(코드리뷰 지적) — holdings에 실제
  // 등장하는 계좌를 전부 훑어 분류하고, 위탁·금현물·CMA·세제혜택 계좌 어디에도 안 속하는
  // 새 계좌(예: 향후 퀀트 KIS 계좌)가 생기면 "분류 미정"으로 명시해 조용히 사라지지
  // 않게 한다.
  const acctNames = [...new Set(holdings.map((h) => String(h.account ?? '').trim()).filter(Boolean))];
  // findCashBalance는 그 계좌에 예수금 레코드가 아예 없으면 null을 준다(0으로 추정
  // 안 함, cash-ledger.mjs 참고) — 여기서 실제로 보유가 있는 계좌인데 예수금만 없는
  // 경우(null)와 예수금이 실제로 0원인 경우를 절대 같은 값으로 합치지 않는다. 하나로
  // 합치면(예전엔 `cashByAcct[acct] ?? 0`) "위탁 예수금 데이터가 아직 없음"이 "위탁에
  // 쓸 돈이 0원"이라는 확정적 거짓 사실로 리포트에 그대로 나갈 뻔했다(코드리뷰 지적,
  // 2026-08-30 — LLM 프롬프트에 들어가는 텍스트라 이 차이가 실제 판단을 오도한다).
  const cashByAcct = Object.fromEntries(acctNames.map((acct) => [acct, findCashBalance(holdings, acct)]));
  const [wtCash, goldCash] = DESIGNATED_CASH_ACCOUNTS.map((acct) => cashByAcct[acct] ?? null);
  const designatedCash = resolveDesignatedCashBalance({ wtCash: wtCash ?? 0, goldCash: goldCash ?? 0 });
  const designatedUnknown = DESIGNATED_CASH_ACCOUNTS.filter((acct) => cashByAcct[acct] == null);
  const designatedNote = designatedUnknown.length
    ? ` (⚠️ ${designatedUnknown.join('·')} 예수금 데이터 없음 — 없는 부분은 0으로 간주해 계산됨, 실제보다 적을 수 있음)`
    : '';
  L.push('\n■ 계좌별 현금 가용성 (계좌 간 이동 불가 — 세제혜택 계좌 중도인출 페널티, 서로 못 더함)');
  L.push(`  - 자유 재투자 가능(위탁+금현물, 신규현금배분 실제 배정 대상): ${won(designatedCash)}원${designatedNote}`);
  // ⚠️ 계좌를 하나도 조용히 빠뜨리지 않는다(코드리뷰 지적) — 예전엔 `!(cash > 0)`이면
  // continue해서, 예수금 레코드가 아예 없는 계좌(퀀트KIS 등 신규 계좌)와 실제로 0원인
  // 계좌가 둘 다 리스트에서 사라졌다. 이제 지정계좌(위탁·금현물, 위에서 이미 별도
  // 서술)를 뺀 모든 계좌를 반드시 한 줄씩 남기고, null(데이터 없음)과 0(확인된 0원)을
  // 명확히 구분해 서술한다.
  for (const [acct, cash] of Object.entries(cashByAcct)) {
    if (KNOWN_DESIGNATED_ACCOUNTS.has(acct)) continue;
    if (cash == null) { L.push(`  - ${acct}: 데이터 부족(예수금 레코드 없음 — 0으로 추정 안 함)`); continue; }
    if (acct === 'CMA') L.push(`  - CMA: ${won(cash)}원 (위탁과 별도 계좌 — 세제혜택은 없어 자유롭게 옮길 수 있지만 자동배분 대상은 아님, 오너 재량)`);
    else if (LOCKED_TAX_ADVANTAGED_ACCOUNTS.has(acct)) {
      const elig = CASH_ELIGIBLE_ACCOUNTS.has(acct) ? ' · 신규현금배분 자동 배정 대상' : '';
      L.push(`  - ${acct}: ${won(cash)}원 (세제혜택 계좌 — 이 계좌 안에서만 재투자 가능, 다른 계좌로 못 옮김${elig})`);
    } else L.push(`  - ${acct}: ${won(cash)}원 (분류 미정 계좌 — 다른 계좌와 합산 가능 여부 확인 안 됨, 이 계좌 단독으로만 언급할 것)`);
  }
  L.push(`  ⚠️ 위 항목들을 서로 더해 "총 실탄"이라고 쓰지 마라 — 계좌마다 각자의 현금만 그 계좌의 매수에 쓸 수 있다. "자산군 비중"의 현금 합계(${won(f.assetClasses.find((a) => a.type === '현금')?.evalValue ?? 0)}원)는 전체 현황 참고용일 뿐 실탄이 아니다.`);

  L.push('\n■ 이번 주 체결');
  if (f.weekTrades.length) for (const t of f.weekTrades)
    L.push(`  - ${t.date} ${t.side} ${t.name} ${t.qty}주 @${t.price} (${t.account})`
      + (t.side === '매도'
        ? (t.ledgerMatched && Number.isFinite(t.realizedWon))
          // Facts/Ledger/Profits 정본 매칭(2026-08-30 신설) — 대시보드 "수익금" 탭과
          // 같은 원장, 정확한 원화 실현손익. 재구성(추정)이 아니라 기록된 사실이라
          // "정본" 표기로 프롬프트에서도 구분되게 한다. Number.isFinite 가드는
          // ledgerMatched=true가 항상 realizedWon 유한수를 함의한다는 암묵 전제를
          // 명시화한 방어(2026-08-31 코드리뷰 지적 — behavior-signals.mjs의 동일
          // 렌더 블록과 대칭 맞춤).
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
