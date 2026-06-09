// 자산·KPI·행동 지표 계산 (순수 함수). App.jsx에서 추출 (동작 불변).
import { parseNum } from './textFormat.js';
import { sameStock } from './stockIdentity.js';

export function computeAssets(holdings, totalEval, defaultAssets) {
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

// ── KPI 계산 (TWR·Sharpe·MDD) ──────────────────────────────────────────────
export function computeKPI(data) {
  // data: [{ label, value (총잔고), savings (저축금), year }]  시간순
  if (!data || data.length < 2) return null;

  // 월별 수정 수익률 (TWR 방식: 입출금 제거)
  const returns = [];
  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1].value;
    const curr = data[i].value;
    const cf   = data[i].savings || 0; // 당월 순유입
    if (prev <= 0) continue;
    returns.push((curr - cf) / prev - 1);
  }
  if (returns.length === 0) return null;

  // TWR 누적 → 연환산
  const twrCum = returns.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const twrAnn = Math.pow(1 + twrCum, 12 / returns.length) - 1;

  // 벤치마크 TWR: KOSPI 50% + S&P500 50% (지수값이 있는 월만)
  const bmReturns = [];
  for (let i = 1; i < data.length; i++) {
    const pk = data[i - 1].kospi;  const ck = data[i].kospi;
    const ps = data[i - 1].sp500; const cs = data[i].sp500;
    if (pk > 0 && ck > 0 && ps > 0 && cs > 0) {
      bmReturns.push(0.5 * (ck / pk - 1) + 0.5 * (cs / ps - 1));
    }
  }
  let benchmarkTWR = null;
  let benchmarkTWRCum = null;
  if (bmReturns.length >= 2) {
    const bmCum = bmReturns.reduce((acc, r) => acc * (1 + r), 1) - 1;
    benchmarkTWR = Math.pow(1 + bmCum, 12 / bmReturns.length) - 1;
    benchmarkTWRCum = bmCum;
  }

  // MDD: TWR 누적 지수(입출금 제거) 기준.
  // 총잔고를 그대로 쓰면 매월 저축 유입으로 고점이 계속 갱신돼, 보유 손실 중에도
  // 낙폭이 0으로 가려진다. returns(현금흐름 제거된 월수익률)로 운용 곡선을 만들어 낙폭 측정.
  let mdd = 0;
  let eq = 1, eqPeak = 1;
  for (const r of returns) {
    eq *= (1 + r);
    if (eq > eqPeak) eqPeak = eq;
    const dd = (eq - eqPeak) / eqPeak;
    if (dd < mdd) mdd = dd;
  }

  // Sharpe (최근 12개월, 무위험 3.5% 연)
  const recent = returns.slice(-12);
  const mean   = recent.reduce((s, r) => s + r, 0) / recent.length;
  const variance = recent.reduce((s, r) => s + (r - mean) ** 2, 0) / recent.length;
  const std    = Math.sqrt(variance);
  const rfM    = 0.035 / 12;
  // std < 0.001 (월 0.1% 이하 변동) → 데이터 부족 처리. 비정상 값 방지.
  const sharpeRaw = std >= 0.001 ? ((mean - rfM) / std) * Math.sqrt(12) : null;
  const sharpe = sharpeRaw !== null ? Math.max(-10, Math.min(10, sharpeRaw)) : null;

  return { twr: twrAnn, twrCum, benchmarkTWR, benchmarkTWRCum, sharpe, mdd, months: returns.length };
}

// 행동 추적 지표 계산
// kpiTrades: [{row:[date,buySell,acct,type,assetType,name,price,qty,amount,...]}]
// evaluations: parseEvaluations() 결과
export function computeBehaviorMetrics(kpiTrades, evaluations) {
  if (!kpiTrades || kpiTrades.length === 0) return null;
  const buys  = kpiTrades.filter(r => String(r.row?.[1]||'').trim() === '매수');
  const sells = kpiTrades.filter(r => String(r.row?.[1]||'').trim() === '매도');

  // 500만 원칙 (1회 매수 체결금액 ≤ 5,000,000)
  const rule500OK = buys.filter(r => {
    const amt = Math.round(parseNum(r.row?.[6]) * parseNum(r.row?.[7]));
    return amt > 0 && amt <= 5000000;
  }).length;

  // 🟢 평가 → 매수 매칭 (매칭 기간 내 동일 종목 매수 여부)
  // 3분류: 실행(matched) / 미실행-기간경과(missed, 진짜 누락) / 유예(pending, 기간 미경과)
  // 일치율 분모는 "실행 기회가 있었던 평가"(matched+missed)만 — 유예는 제외해야 의미 있음.
  const MATCH_WINDOW_DAYS = 30;
  const windowMs = MATCH_WINDOW_DAYS * 86400000;
  const nowTs = Date.now();
  const greenEvals = (evaluations || []).filter(e => {
    const raw = String(e.conclusion?.raw || '');
    return raw.includes('🟢') || (raw.includes('O') && !raw.includes('X'));
  });
  const matchedEvals = [], missedEvals = [], pendingEvals = [];
  greenEvals.forEach(ev => {
    const evalTs = new Date(ev.date).getTime();
    const bought = !isNaN(evalTs) && buys.some(r => {
      const ts = new Date(String(r.row?.[0]||'')).getTime();
      return sameStock(r.row?.[3], r.row?.[5], ev.stock?.ticker, ev.stock?.name)
        && !isNaN(ts) && ts >= evalTs && ts <= evalTs + windowMs;
    });
    if (bought) matchedEvals.push(ev);
    else if (isNaN(evalTs) || nowTs >= evalTs + windowMs) missedEvals.push(ev);  // 기간 경과 미실행
    else pendingEvals.push(ev);                                                   // 기간 미경과 = 유예
  });
  const evalEligible = matchedEvals.length + missedEvals.length;

  // 최근 30일 거래
  const now = Date.now();
  const recent30 = kpiTrades.filter(r => {
    const ts = new Date(String(r.row?.[0]||'')).getTime();
    return !isNaN(ts) && now - ts <= 30 * 86400000;
  });

  // 매도 규율: 매도 전 N일 내 해당 종목 평가(근거 점검)가 있었는지 — 충동 매도 방지 추적
  const sellDisciplineOK = sells.filter(s => {
    const sellTs = new Date(String(s.row?.[0]||'')).getTime();
    const nm = String(s.row?.[5]||'').trim();
    if (isNaN(sellTs) || !nm) return false;
    return (evaluations || []).some(ev => {
      const evTs = new Date(ev.date).getTime();
      return sameStock(s.row?.[3], nm, ev.stock?.ticker, ev.stock?.name)
        && !isNaN(evTs) && evTs <= sellTs && evTs >= sellTs - windowMs;
    });
  }).length;

  // 거래 빈도: 최근 30일 건수 vs 전체 기간 30일당 평균 (자기 기준선 대비 과열 감지)
  // 분할매수 전략은 절대 건수가 높을 수 있어 고정 임계 대신 본인 평소 빈도와 비교한다.
  const tradeTs = kpiTrades.map(r => new Date(String(r.row?.[0]||'')).getTime()).filter(t => !isNaN(t));
  let freqAvg30 = null, freqRatio = null;
  if (tradeTs.length >= 2) {
    const spanDays = (Math.max(...tradeTs) - Math.min(...tradeTs)) / 86400000;
    if (spanDays >= 45) {                       // 기준선 신뢰 위해 최소 45일 이력 필요
      freqAvg30 = kpiTrades.length / spanDays * 30;
      freqRatio = freqAvg30 > 0 ? recent30.length / freqAvg30 : null;
    }
  }

  // 미연결 매수: 어떤 평가와도 (코드/이름) 매칭 안 되는 매수 — 이름 오타·평가 누락 신호
  const unlinkedBuys = buys.filter(r => {
    return !(evaluations || []).some(ev =>
      sameStock(r.row?.[3], r.row?.[5], ev.stock?.ticker, ev.stock?.name));
  }).length;

  return {
    totalBuys: buys.length, totalSells: sells.length,
    sellDisciplineOK, sellDisciplineTotal: sells.length,
    sellDisciplineRate: sells.length > 0 ? Math.round(sellDisciplineOK / sells.length * 100) : null,
    freqAvg30, freqRatio,
    rule500OK, rule500Total: buys.length,
    rule500Rate: buys.length > 0 ? Math.round(rule500OK / buys.length * 100) : null,
    greenEvalTotal: greenEvals.length,
    evalMatchCount: matchedEvals.length,
    evalEligible,
    evalMatchRate: evalEligible > 0 ? Math.round(matchedEvals.length / evalEligible * 100) : null,
    missedEvals,
    pendingCount: pendingEvals.length,
    matchWindowDays: MATCH_WINDOW_DAYS,
    recent30Count: recent30.length,
    recent30Buys: recent30.filter(r => String(r.row?.[1]||'').trim() === '매수').length,
    unlinkedBuys,
  };
}
