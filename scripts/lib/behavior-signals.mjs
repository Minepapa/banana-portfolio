// 행동 신호 조립기 — 순수 함수(네트워크 없음). 체결·평가·포지션저널 raw rows에서
// Frank의 "드러난 성향"을 결정론으로 산출한다. LLM은 이 사실을 §3과 대조해 해석만 할 뿐,
// 신호 자체는 LLM이 만들지 않는다(코드베이스 철학: raw 숫자는 LLM이 만들지 않는다).
//
// 임계값은 src/lib/metrics.js computeBehaviorMetrics와 일치(500만 원칙·30일 매칭창).

// 컬럼 레이아웃은 sheet-contracts.mjs 단일 정본에서 import — 로컬 중복 하드코딩 금지
// (writer HEADER와의 정합은 sheet-contracts.test.js가 고정).
import { EXEC_COL as T, NOTE_COL as N, JOURNAL_COL as J, RISK_COL as R } from './sheet-contracts.mjs';

const RULE500_WON = 5_000_000;        // 1회 매수 체결금액 상한(성향: 적립식)
const MATCH_WINDOW_DAYS = 30;         // 🟢 평가 → 매수 매칭창
const LESSON_LOOKBACK_DAYS = 60;      // 청산 교훈 수집 범위
const RULE_LOOKBACK_DAYS = 90;        // 500만 원칙 집계 범위(주간은 표본이 작아 최근 누적으로 본다)

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[,%+\s]/g, '')); return Number.isFinite(n) ? n : null; };
const s = (v) => String(v ?? '').trim();
const round1 = (v) => Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
const daysBetween = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 86400000;

function parseBuy(r) {
  const amount = num(r[T.AMOUNT]) ?? (num(r[T.PRICE]) != null && num(r[T.QTY]) != null ? num(r[T.PRICE]) * num(r[T.QTY]) : null);
  return { date: s(r[T.DATE]), name: s(r[T.NAME]), account: s(r[T.ACCT]), assetType: s(r[T.ASSET]),
    price: num(r[T.PRICE]), qty: num(r[T.QTY]), amount };
}
// 매도 실현수익률은 체결행 M열(수익률=포지션 현재 스냅샷, 미실현)이 아니라
// "체결 이력의 매입평균(Σ매수금액/Σ매수수량, 매도일 이전)" 대비로 산출한다(결정론·정확).
function parseSell(r, buysAll) {
  const date = s(r[T.DATE]); const name = s(r[T.NAME]);
  const price = num(r[T.PRICE]);
  const priorBuys = buysAll.filter(b => b.name === name && b.date && b.date < date && b.amount != null && b.qty);
  const boughtQty = priorBuys.reduce((s_, b) => s_ + b.qty, 0);
  const boughtAmt = priorBuys.reduce((s_, b) => s_ + b.amount, 0);
  const avgBuy = boughtQty > 0 ? boughtAmt / boughtQty : null;
  const realizedPct = (avgBuy && price != null) ? round1((price - avgBuy) / avgBuy * 100) : null;
  return { date, name, account: s(r[T.ACCT]), price, qty: num(r[T.QTY]), avgBuy, realizedPct };
}

/**
 * @param input.asof        발행일 'YYYY-MM-DD'
 * @param input.weekStart   이번 주 시작일(이상)
 * @param input.tradeRows   체결내역!A2:M
 * @param input.noteRows    종목투자노트!A2:U
 * @param input.journalRows 포지션저널!A2:P
 * @param input.riskRows    리스크모니터!A2:H (선택 — 🔴 미매도 감지)
 */
export function buildBehaviorSignals(input) {
  const { asof, weekStart, tradeRows = [], noteRows = [], journalRows = [], riskRows = [] } = input;
  const inWeek = (d) => weekStart ? (d && d >= weekStart) : true;

  const buysAll = tradeRows.filter(r => s(r[T.SIDE]) === '매수' && s(r[T.NAME])).map(parseBuy);
  const sellsAll = tradeRows.filter(r => s(r[T.SIDE]) === '매도' && s(r[T.NAME])).map(r => parseSell(r, buysAll));

  const week = {
    buys: buysAll.filter(b => inWeek(b.date)),
    sells: sellsAll.filter(s_ => inWeek(s_.date)),
  };

  // 익절/손절 — 이번 주 매도의 실현수익률(체결이력 매입평균 대비) 부호. 매입평균 불명이면 분류 제외.
  const tp = week.sells.filter(x => x.realizedPct != null && x.realizedPct > 0);
  const sl = week.sells.filter(x => x.realizedPct != null && x.realizedPct < 0);
  const avg = (arr) => arr.length ? round1(arr.reduce((s_, x) => s_ + x.realizedPct, 0) / arr.length) : null;
  const takeProfit = { count: tp.length, avgPct: avg(tp), items: tp };
  const stopLoss = { count: sl.length, avgPct: avg(sl), items: sl };

  // 500만 원칙 — 최근 RULE_LOOKBACK_DAYS 매수 누적 기준(주간 표본이 작아 최근 흐름으로 본다). 위반 목록.
  const ruleBuys = buysAll.filter(b => !asof || !b.date || daysBetween(b.date, asof) <= RULE_LOOKBACK_DAYS);
  const violations = ruleBuys.filter(b => b.amount != null && b.amount > RULE500_WON);
  const rule500 = { total: ruleBuys.length, okCount: ruleBuys.length - violations.length, violations };

  // 🟢 평가 후 미매수(망설임) — status가 '매수'가 아니고, 결론 🟢/유효, 평가 후 매수 없음.
  const greenNotes = noteRows.filter(r => {
    const concl = s(r[N.CONCL]); const status = s(r[N.STATUS]);
    const isGreen = concl.includes('🟢') || /유효|적합/.test(concl);
    return s(r[N.NAME]) && isGreen && status !== '매수';
  });
  const missedGreen = greenNotes.filter(r => {
    const name = s(r[N.NAME]); const evDate = s(r[N.DATE]);
    const boughtAfter = buysAll.some(b => b.name === name && b.date >= evDate
      && daysBetween(evDate, b.date) <= MATCH_WINDOW_DAYS);
    return !boughtAfter;
  }).map(r => ({ name: s(r[N.NAME]), date: s(r[N.DATE]) }));

  // 🔴 리스크인데 미매도(미련·손실회피) — 최신 🔴 대상이 이번 주 매도되지 않음.
  const redTargets = new Map();
  for (const r of riskRows) {
    if (!s(r[R.SIGNAL]).includes('🔴')) continue;
    const t = s(r[R.TARGET]); const d = s(r[R.DATE]);
    if (!redTargets.has(t) || d > redTargets.get(t)) redTargets.set(t, d);
  }
  const unsoldRed = [...redTargets.keys()]
    .filter(name => !sellsAll.some(x => x.name === name && x.date >= (redTargets.get(name) || '').slice(0, 10)))
    .map(name => ({ name, since: redTargets.get(name) }));

  // 청산 교훈 — 최근 LESSON_LOOKBACK_DAYS 내 청산 + 교훈 작성.
  const lessons = journalRows.filter(r => {
    if (s(r[J.STATUS]) !== '청산' || !s(r[J.LESSON])) return false;
    const exit = s(r[J.EXITDATE]);
    return !exit || (asof && daysBetween(exit, asof) <= LESSON_LOOKBACK_DAYS);
  }).map(r => ({ name: s(r[J.NAME]), result: s(r[J.RESULT]), lesson: s(r[J.LESSON]), exitDate: s(r[J.EXITDATE]) }));

  const signals = { asof, weekStart, week, takeProfit, stopLoss, rule500, missedGreen, unsoldRed, lessons };
  return { signals, signalsText: renderSignalsText(signals) };
}

// LLM 관찰 추출 프롬프트 주입용 — 결정론 신호를 사실 텍스트로(여기 값만 인용하도록).
function renderSignalsText(g) {
  const L = [];
  L.push(`■ 기간 ${g.weekStart}~${g.asof}`);

  L.push('\n■ 이번 주 매수');
  if (g.week.buys.length) for (const b of g.week.buys)
    L.push(`  - ${b.date} ${b.name} ${b.qty ?? '?'}주 @${b.price ?? '?'} = ${b.amount != null ? b.amount.toLocaleString('en-US') : '?'}원 (${b.account})`);
  else L.push('  - (없음)');

  L.push('\n■ 이번 주 매도 (실현수익률 = 체결가 vs 체결이력 매입평균)');
  if (g.week.sells.length) for (const x of g.week.sells)
    L.push(`  - ${x.date} ${x.name} ${x.qty ?? '?'}주 @${x.price ?? '?'}`
      + ` · 실현 ${x.realizedPct != null ? (x.realizedPct >= 0 ? '+' : '') + x.realizedPct + '%' : '매입평균 불명'}`
      + ` (${x.account})`);
  else L.push('  - (없음)');

  L.push(`\n■ 익절/손절: 익절 ${g.takeProfit.count}건(평균 ${g.takeProfit.avgPct ?? '–'}%) · 손절 ${g.stopLoss.count}건(평균 ${g.stopLoss.avgPct ?? '–'}%)`);
  L.push(`■ 1회 500만 원칙: 매수 ${g.rule500.total}건 중 위반 ${g.rule500.violations.length}건`
    + (g.rule500.violations.length ? ` (${g.rule500.violations.map(v => `${v.name} ${v.amount.toLocaleString('en-US')}원`).join(', ')})` : ''));

  L.push('\n■ 🟢 평가 후 미매수(망설임 신호)');
  if (g.missedGreen.length) for (const m of g.missedGreen) L.push(`  - ${m.name} (평가 ${m.date}, 30일 내 미매수)`);
  else L.push('  - (없음)');

  L.push('\n■ 🔴 리스크 보유 지속(미련 신호)');
  if (g.unsoldRed.length) for (const u of g.unsoldRed) L.push(`  - ${u.name} (🔴 ${u.since} 이후 미매도)`);
  else L.push('  - (없음)');

  L.push('\n■ 최근 청산 교훈');
  if (g.lessons.length) for (const l of g.lessons) L.push(`  - ${l.name}: ${l.result} — "${l.lesson}"`);
  else L.push('  - (없음)');

  return L.join('\n');
}
