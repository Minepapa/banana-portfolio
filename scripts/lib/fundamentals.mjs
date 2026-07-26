// 결정론적 펀더멘털 데이터 계층 — risk-monitor(B)·backfill-baselines가 사용.
// 원칙: raw 숫자는 절대 LLM이 만들지 않는다. 여기서 조회·계산한 값만 시트와 프롬프트에 쓴다.
import { spawnSync } from 'node:child_process';

// CLAUDE.md 데이터 기준: 1~3월=전년 사업(11011), 4~5월=1Q(11013), 6~8월=반기(11012), 9~12월=3Q(11014)
export function reprtCodeForDate(d = new Date()) {
  const y = d.getFullYear(), m = d.getMonth() + 1;
  if (m <= 3) return { bsnsYear: String(y - 1), reprtCode: '11011' };
  if (m <= 5) return { bsnsYear: String(y), reprtCode: '11013' };
  if (m <= 8) return { bsnsYear: String(y), reprtCode: '11012' };
  return { bsnsYear: String(y), reprtCode: '11014' };
}

// 미공시 폴백 + 직전 보고서(2분기 연속 추세용): 1Q→전년 사업→전년 3Q→전년 반기→...
const ORDER = ['11013', '11012', '11014', '11011']; // 연중 시간순
export function prevPeriod({ bsnsYear, reprtCode }) {
  const i = ORDER.indexOf(reprtCode);
  if (i === 0) return { bsnsYear: String(Number(bsnsYear) - 1), reprtCode: '11011' };
  return { bsnsYear, reprtCode: ORDER[i - 1] };
}

// 분기보고서 add_amount는 연초 누적치(반기=1~2분기 합, 3분기=1~3분기 합, 사업=1~4분기 합).
// 같은 해 "직전" 리포트 코드 — 이 리포트의 누적치를 빼면 해당 분기 하나만 남는다.
// 1분기(11013)는 이미 단일분기라 뺄 대상 없음(맵에 없음 → quarterStandalone이 그대로 반환).
export const SAME_YEAR_PRIOR_REPORT = { 11012: '11013', 11014: '11012', 11011: '11014' };

// 누적치(cum)에서 같은 해 직전 리포트 누적치(priorCum)를 빼 단일분기 수치로 환산.
// priorCum 결측(조회 실패 등)은 "1분기라 뺄 게 없음"과 다른 상태라 여기선 구분하지 않고 null —
// 1분기 예외 판단은 quarterStandalone이 SAME_YEAR_PRIOR_REPORT 유무로 미리 내린다.
export function standaloneAmounts(cum, priorCum) {
  if (cum?.curr == null || cum?.prev == null || priorCum?.curr == null || priorCum?.prev == null) return null;
  return { curr: cum.curr - priorCum.curr, prev: cum.prev - priorCum.prev };
}

// period 리포트를 단일분기로 환산. 1분기는 이미 단일분기라 그대로 반환(조회 자체가 없음).
// 그 외 분기인데 priorOp 조회가 실패했으면(네트워크 오류 등) — cum을 그대로 쓰면 옛 버그
// (다분기 누적을 단일분기인 척 계산)가 조용히 재발하므로 null로 명확히 실패시킨다.
export function quarterStandalone(period, cum, priorOp) {
  if (!SAME_YEAR_PRIOR_REPORT[period.reprtCode]) return cum;
  return standaloneAmounts(cum, priorOp);
}

const num = (s) => { const n = parseFloat(String(s ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };

export function computeYoY(curr, prev) {
  if (curr == null || prev == null || prev === 0) return null;
  return Math.round((curr - prev) / Math.abs(prev) * 1000) / 10;
}

// TTM(4분기 누적) 순이익 = 직전 사업연도 연간 − 직전연도 동기간 누적 + 당기 누적.
// 손익은 add_amount(누적)이라 1Q=Q1·반기=상반기·3Q=9개월 — 어느 분기든 일반화된다.
// 분기보고서의 순이익(누적)으로 단순 ROE를 내면 과소평가되므로 TTM으로 환산한다.
export function computeTtmNetIncome(curCum, prevCum, annualPrev) {
  if (curCum == null || prevCum == null || annualPrev == null) return null;
  return annualPrev - prevCum + curCum;
}

// ROE(TTM, %) = TTM순이익 / 기초자기자본(직전 사업연도말) × 100. 분모 결측·0 → null.
// 기초자본 기준(네이버 정합) — 평균자본이 아닌 직전 사업연도말 자본을 분모로 둔다.
export function computeRoe(ttmNet, eqBegin) {
  if (ttmNet == null || !eqBegin) return null;
  return Math.round(ttmNet / eqBegin * 1000) / 10;
}

// fnlttSinglAcnt(주요계정) 응답 파싱. CFS 우선, 손익은 누적(add_amount) 우선.
export function parseKrAmounts(list) {
  const cfs = (list || []).filter(r => r.fs_div === 'CFS');
  const src = cfs.length ? cfs : (list || []).filter(r => r.fs_div === 'OFS');
  const pick = (...names) => src.find(r => names.includes(r.account_nm)) || null;
  const amt = (r, k) => r ? num(r[`${k}_add_amount`] ?? r[`${k}_amount`]) : null;
  const get = (...names) => { const r = pick(...names); return { curr: amt(r, 'thstrm'), prev: amt(r, 'frmtrm') }; };
  return {
    revenue: get('매출액', '수익(매출액)', '영업수익'),
    opIncome: get('영업이익', '영업이익(손실)'),
    netIncome: get('당기순이익(손실)', '당기순이익', '분기순이익', '반기순이익'),
    assets: get('자산총계'), liabilities: get('부채총계'), equity: get('자본총계'),
    // 주요계정엔 CF 3항목이 포함됨 — yfinance .KS freeCashflow 미제공 시 영업CF/시총으로 폴백.
    operCf: get('영업활동현금흐름', '영업활동으로 인한 현금흐름', '영업활동으로인한현금흐름'),
  };
}

// fnlttSinglIndx(재무비율) 응답 파싱 — idx_nm을 "정확히" 매칭한다.
// 부분일치는 오염 위험: 총자산'영업이익률'(5.0%)·유동'부채비율' 등 유사명이 진짜 값을
// 가로채 환각과 같은 거짓 수치를 만든다(실측에서 영업이익률이 5.0%로 잘못 잡힘). 미스→null.
// OpenDart 지표엔 순수 '영업이익률'이 없어 opMargin은 보통 null → 페처가 금액으로 직접 계산.
export function parseKrRatios(list) {
  const find = (re) => { const r = (list || []).find(x => re.test(String(x.idx_nm ?? '').trim())); return r ? num(r.idx_val) : null; };
  return {
    grossMargin: find(/^매출총이익률$/),
    opMargin: find(/^영업이익률$/),
    roe: find(/^ROE$/),
    debtRatio: find(/^부채비율$/),
    payoutRatio: find(/^현금배당성향$/),  // M310000(주당·배당지표) — yfinance .KS payoutRatio 미제공 시 폴백
  };
}

// 가드레일(결정론) — 해당 시 Node가 신호 하한을 🟡로 강제한다.
export function checkGuardrails(g) {
  const t = [];
  if (g.opYoYCurr != null && g.opYoYPrev != null && g.opYoYCurr < 0 && g.opYoYPrev < 0)
    t.push('영업이익 YoY 2분기 연속 감소');
  if (g.debtRatio != null && g.baselineDebtRatio != null && g.debtRatio - g.baselineDebtRatio >= 20)
    t.push('부채비율 급증(기준선 대비 +20%p 이상)');
  return t;
}

// ── 페처 (네트워크 — 순수 함수와 분리, 테스트는 순수부만) ──────────
const DART = 'https://opendart.fss.or.kr/api';

async function dartJson(path, params, apiKey) {
  const q = new URLSearchParams({ crtfc_key: apiKey, ...params });
  const res = await fetch(`${DART}/${path}?${q}`);
  if (!res.ok) throw new Error(`OpenDart HTTP ${res.status}`);
  const j = await res.json();
  if (j.status === '013') return null;            // 조회 데이터 없음(미공시)
  if (j.status !== '000') throw new Error(`OpenDart ${j.status}: ${j.message}`);
  return j.list;
}

// period 리포트를 단일분기로 환산하기 위한 "같은 해 직전 리포트"의 영업이익 누적치.
// 1분기 리포트는 SAME_YEAR_PRIOR_REPORT에 없어 호출 없이 null 반환(이미 단일분기).
async function fetchSameYearPriorOp(period, corpCode, apiKey) {
  const priorCode = SAME_YEAR_PRIOR_REPORT[period.reprtCode];
  if (!priorCode) return null;
  const list = await dartJson('fnlttSinglAcnt.json', {
    corp_code: corpCode, bsns_year: period.bsnsYear, reprt_code: priorCode,
  }, apiKey).catch(() => null);
  return list ? parseKrAmounts(list).opIncome : null;
}

// 미공시면 prevPeriod로 한 번 폴백. 그래도 없으면 null.
async function dartWithFallback(path, corpCode, period, extra, apiKey) {
  for (const p of [period, prevPeriod(period)]) {
    const list = await dartJson(path, {
      corp_code: corpCode, bsns_year: p.bsnsYear, reprt_code: p.reprtCode, ...extra,
    }, apiKey);
    if (list) return { list, period: p, fellBack: p !== period };
  }
  return null;
}

const REPRT_LABEL = { 11011: '사업보고서', 11013: '1분기보고서', 11012: '반기보고서', 11014: '3분기보고서' };

export async function fetchKrFundamentals(corpCode, now = new Date(), apiKey = process.env.DART_API_KEY, stockCode = null) {
  if (!apiKey) throw new Error('DART_API_KEY 미설정');
  const period = reprtCodeForDate(now);
  const cur = await dartWithFallback('fnlttSinglAcnt.json', corpCode, period, {}, apiKey);
  if (!cur) throw new Error('OpenDart 주요계정 조회 실패(당기·폴백 모두 미공시)');
  const prevP = prevPeriod(cur.period);
  const prevList = await dartJson('fnlttSinglAcnt.json', {
    corp_code: corpCode, bsns_year: prevP.bsnsYear, reprt_code: prevP.reprtCode,
  }, apiKey);

  const a = parseKrAmounts(cur.list);
  const pa = prevList ? parseKrAmounts(prevList) : null;

  // 영업이익 YoY는 "그 분기 하나만"의 단일분기 기준이어야 한다(가드레일 "2분기 연속 감소"의 전제).
  // 반기·3분기·사업보고서의 add_amount는 연초 누적치라 그대로 쓰면 다분기 실적이 섞인다 —
  // 같은 해 직전 리포트 누적치를 빼 단일분기로 환산(1분기는 이미 단일분기라 조회 없이 그대로 사용).
  const curPriorOp = await fetchSameYearPriorOp(cur.period, corpCode, apiKey);
  const curOpStandalone = quarterStandalone(cur.period, a.opIncome, curPriorOp);
  const prevPriorOp = pa ? await fetchSameYearPriorOp(prevP, corpCode, apiKey) : null;
  const prevOpStandalone = pa ? quarterStandalone(prevP, pa.opIncome, prevPriorOp) : null;

  let ratios = { grossMargin: null, opMargin: null, roe: null, debtRatio: null };
  for (const idx of ['M210000', 'M220000', 'M310000']) {  // M310000: 주당·배당지표(현금배당성향 포함)
    const list = await dartJson('fnlttSinglIndx.json', {
      corp_code: corpCode, bsns_year: cur.period.bsnsYear, reprt_code: cur.period.reprtCode, idx_cl_code: idx,
    }, apiKey).catch(() => null);
    if (list) ratios = { ...ratios, ...Object.fromEntries(Object.entries(parseKrRatios(list)).filter(([, v]) => v != null)) };
  }
  // 비율 API 미제공 시 금액으로 직접 계산(영업이익률·부채비율)
  if (ratios.opMargin == null && a.opIncome.curr != null && a.revenue.curr) ratios.opMargin = Math.round(a.opIncome.curr / a.revenue.curr * 1000) / 10;
  if (ratios.debtRatio == null && a.liabilities.curr != null && a.equity.curr) ratios.debtRatio = Math.round(a.liabilities.curr / a.equity.curr * 1000) / 10;

  // ROE를 OpenDart 분기값(누적순이익 기반·과소) 대신 TTM·기초자본 기준으로 재계산.
  // 사업보고서(11011)는 당기순이익이 곧 연간이라 추가 조회 불필요. 분기면 직전 사업연도 연간을 조회.
  let ttmNet = a.netIncome.curr;
  if (cur.period.reprtCode !== '11011') {
    const annualPrevList = await dartJson('fnlttSinglAcnt.json', {
      corp_code: corpCode, bsns_year: String(Number(cur.period.bsnsYear) - 1), reprt_code: '11011',
    }, apiKey).catch(() => null);
    const annualPrevNet = annualPrevList ? parseKrAmounts(annualPrevList).netIncome.curr : null;
    ttmNet = computeTtmNetIncome(a.netIncome.curr, a.netIncome.prev, annualPrevNet);
  }
  const ttmRoe = computeRoe(ttmNet, a.equity.prev); // 기초자본 = BS frmtrm(직전 사업연도말)
  if (ttmRoe != null) ratios.roe = ttmRoe;          // TTM 불가 시 OpenDart 분기 ROE 유지(폴백)

  // PBR: yfinance marketCap(.KS/.KQ) ÷ OpenDart equity. pykrx는 KRX 로그인 요구로 헤드리스 불가.
  let pbr = null;
  if (stockCode) {
    try {
      const mkt = fetchKrMarketData(stockCode);
      pbr = mkt?.pbr ?? computePbr(mkt?.marketCap, a.equity.curr);
    } catch { /* PBR 조회 실패 시 null 유지 */ }
  }

  return {
    market: 'KR',
    source: `OpenDart ${cur.period.bsnsYear} ${REPRT_LABEL[cur.period.reprtCode]}(연결)${cur.fellBack ? ' (분기 미공시 폴백)' : ''}`,
    // revenueYoY·netIncomeYoY는 (의도적으로) 단일분기 환산 없이 누적 YoY 그대로 — 가드레일이
    // opYoY*만 보므로 지금은 범위 밖. 반기·3분기 리포트에서는 다분기 누적 YoY라는 점 주의(후속 과제).
    revenue: a.revenue.curr, revenueYoY: computeYoY(a.revenue.curr, a.revenue.prev),
    opIncome: a.opIncome.curr,
    opYoYCurr: curOpStandalone ? computeYoY(curOpStandalone.curr, curOpStandalone.prev) : null,
    opYoYPrev: prevOpStandalone ? computeYoY(prevOpStandalone.curr, prevOpStandalone.prev) : null,
    netIncomeYoY: computeYoY(a.netIncome.curr, a.netIncome.prev),
    equity: a.equity.curr,
    operCf: a.operCf?.curr,
    ...ratios, eps: null, pbr,
  };
}

export function fetchUsFundamentals(ticker) {
  const py = new URL('./yf-fundamentals.py', import.meta.url).pathname;
  const r = spawnSync('python3', [py, ticker], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`yfinance 실패: ${(r.stderr || '').slice(-200)}`);
  const d = JSON.parse(r.stdout);
  return { market: 'US', revenue: null, opIncome: null, netIncomeYoY: null, ...d, pbr: d.pbr ?? null };
}

// 시세·밸류에이션 (KR/US 공통, yfinance). yahooTicker: US='AAPL', KR='005930.KS'.
// RSI·52주위치·FCF yield는 Node 순수함수로 계산 — raw만 python에서 받는다.
export function fetchMarketData(yahooTicker) {
  const py = new URL('./yf-marketdata.py', import.meta.url).pathname;
  const r = spawnSync('python3', [py, yahooTicker], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`yfinance 시세 조회 실패(${yahooTicker}): ${(r.stderr || '').slice(-200)}`);
  const d = JSON.parse(r.stdout);
  const round2 = (v) => Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  return {
    forwardPE: round2(d.forwardPE ?? d.trailingPE),
    pbr: round2(d.priceToBook),
    // closes는 MA60·MACD 워밍업 때문에 90개로 확대됐지만(2026-07), RSI14는 Wilder 평활이
    // 경로 의존적이라 윈도우가 넓어지면 시드값 잔존 가중치가 줄어 출력 자체가 달라진다
    // (코드리뷰 실측: 30개 윈도우 대비 90개 윈도우에서 동일 종목 RSI14가 수 포인트 이동).
    // 이 rsi14는 risk-monitor §4의 rsiLow(≤30) 결정론 트리거 입력이라, 이미 살아있는 트리거의
    // 경계값(RSI≈30 근처) 판정이 이 리팩터 하나로 조용히 뒤바뀌면 안 된다 — 기존 트리거가
    // 써오던 30개 윈도우 그대로 고정한다(다른 지표들만 90개 활용).
    rsi14: computeRsi14(d.closes.slice(-30)),
    pos52w: compute52wPosition(d.currentPrice, d.fiftyTwoWeekHigh, d.fiftyTwoWeekLow),
    fcfYield: computeFcfYield(d.freeCashflow, d.marketCap),
    payoutRatio: d.payoutRatio != null ? Math.round(d.payoutRatio * 1000) / 10 : null,
    marketCap: Number.isFinite(d.marketCap) ? d.marketCap : null,  // PBR 폴백 계산용(시총/자기자본)
    currentPrice: Number.isFinite(d.currentPrice) ? d.currentPrice : null,  // 주간리포트 평가액·주간수익률 산출용
    weekChange: computeMacroChange(d.closes)?.change5d ?? null,             // 5거래일(주간) 가격 등락률 %
    high52w: Number.isFinite(d.fiftyTwoWeekHigh) ? d.fiftyTwoWeekHigh : null,
    low52w: Number.isFinite(d.fiftyTwoWeekLow) ? d.fiftyTwoWeekLow : null,
    // 기술지표(보조 참고정보 전용 — §4 결정론 임계값은 안 바꿈, risk-monitor scanOpportunity 참고).
    tech: {
      macd: computeMacd(d.closes),
      maAlignment: computeMaAlignment(d.closes),
      atr: computeAtr(d.highs, d.lows, d.closes),
      stochastic: computeStochastic(d.highs, d.lows, d.closes),
      volumeSurge: computeVolumeSurge(d.volumes, d.closes),
    },
    source: `yfinance ${yahooTicker}`,
  };
}

// KR 6자리 → yahoo 티커. KOSPI .KS 우선, 빈 응답이면 .KQ 재시도(코스닥).
export function fetchKrMarketData(stockCode) {
  for (const sfx of ['.KS', '.KQ']) {
    try {
      const d = fetchMarketData(`${stockCode}${sfx}`);
      if (d.rsi14 != null || d.pos52w != null || d.forwardPE != null) return d;
    } catch { /* 다음 접미사 시도 */ }
  }
  return null;
}

// ── 평가 카드용 순수 지표 (drain --auto) ────────────────────────────
// 시세 raw에서 결정론적으로 산출 — LLM이 RSI·52주·FCF를 지어내던 환각을 차단.

// RSI(14) — Wilder 평활. closes: 과거→현재 종가배열. 15개 미만이면 null.
export function computeRsi14(closes, period = 14) {
  const a = (closes || []).filter(x => Number.isFinite(x));
  if (a.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = a[i] - a[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rsi = 100 - 100 / (1 + avgGain / avgLoss);
  return Math.round(rsi * 100) / 100;
}

// 52주 위치(%) = (현재-저)/(고-저)*100. 분모 0·결측 → null.
export function compute52wPosition(current, high, low) {
  if (![current, high, low].every(Number.isFinite)) return null;
  if (high === low) return null;
  return Math.round((current - low) / (high - low) * 1000) / 10;
}

// FCF yield(%) = 잉여현금흐름/시가총액*100. 결측·0분모 → null.
export function computeFcfYield(fcf, marketCap) {
  if (!Number.isFinite(fcf) || !Number.isFinite(marketCap) || marketCap === 0) return null;
  return Math.round(fcf / marketCap * 1000) / 10;
}

// PBR = 시가총액 / 자기자본. yfinance가 KR(.KS) priceToBook을 안 주는 종목(삼성전자 등)에서
// marketCap(yfinance)·자본총계(OpenDart)로 직접 산출 — pykrx는 KRX 로그인 요구로 헤드리스 불가.
// 자본총계는 비지배지분 포함이라 지배주주 BPS 기준 PBR 대비 소폭 과소(수 % 오차). 결측·0분모 → null.
export function computePbr(marketCap, equity) {
  if (!Number.isFinite(marketCap) || !Number.isFinite(equity) || equity <= 0) return null;
  return Math.round(marketCap / equity * 100) / 100;
}

// ── 기술지표 (KIS strategy_builder/backtester 참고 — 2026-07 Frank 결정: 별도 앱/Docker 없이
// 계산 로직만 흡수, 기존 O/B 신호의 "보조 참고정보"로만 사용. §4 결정론 임계값(가격 -10%/
// RSI30)은 그대로 유지 — 이 지표들이 신호 색상을 직접 바꾸지 않는다, 컨빅션 텍스트만 보강) ──

// EMA(지수이동평균) 시계열. 내부 헬퍼 — 첫 값은 그대로, 이후 표준 스무딩 공식.
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  values.forEach((v, i) => { prev = i === 0 ? v : v * k + prev * (1 - k); out.push(prev); });
  return out;
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((s, x) => s + x, 0) / period;
}

// MACD(12,26,9). closes: 과거→현재 종가배열. slow+signal 최소 길이 미만이면 null(워밍업 부족
// — EMA 초반값은 부정확해 신뢰 불가). crossUp/crossDown은 "어제→오늘" MACD선-시그널선 대소
// 역전(골든/데드크로스). 순수함수 — 테스트 가능.
export function computeMacd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const a = (closes || []).filter(Number.isFinite);
  if (a.length < slow + signalPeriod) return null;
  const emaFast = emaSeries(a, fast);
  const emaSlow = emaSeries(a, slow);
  const macdLine = a.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = emaSeries(macdLine, signalPeriod);
  const round2 = (v) => Math.round(v * 100) / 100;
  const macd = macdLine[macdLine.length - 1];
  const signal = signalLine[signalLine.length - 1];
  const prevMacd = macdLine[macdLine.length - 2];
  const prevSignal = signalLine[signalLine.length - 2];
  const crossUp = prevMacd != null && prevSignal != null && prevMacd <= prevSignal && macd > signal;
  const crossDown = prevMacd != null && prevSignal != null && prevMacd >= prevSignal && macd < signal;
  return { macd: round2(macd), signal: round2(signal), histogram: round2(macd - signal), crossUp, crossDown };
}

// 이동평균 정배열/역배열 + 단기·중기 골든/데드크로스. periods는 반드시 오름차순
// [단기,중기,장기](기본 5/20/60일). 정배열=단기>중기>장기(상승추세), 역배열=그 반대. 데이터
// 부족(가장 긴 기간 미만)이면 null. 순수함수 — 테스트 가능.
export function computeMaAlignment(closes, periods = [5, 20, 60]) {
  const a = (closes || []).filter(Number.isFinite);
  const [short, mid, long] = periods;
  const smas = { [short]: sma(a, short), [mid]: sma(a, mid), [long]: sma(a, long) };
  if (Object.values(smas).some(v => v == null)) return null;
  const bullish = smas[short] > smas[mid] && smas[mid] > smas[long];
  const bearish = smas[short] < smas[mid] && smas[mid] < smas[long];
  const prev = a.slice(0, -1);
  const prevShort = sma(prev, short), prevMid = sma(prev, mid);
  const goldenCross = prevShort != null && prevMid != null && prevShort <= prevMid && smas[short] > smas[mid];
  const deadCross = prevShort != null && prevMid != null && prevShort >= prevMid && smas[short] < smas[mid];
  return { sma: smas, alignment: bullish ? '정배열' : bearish ? '역배열' : '혼조', goldenCross, deadCross };
}

// ATR(Average True Range, Wilder 평활) — 절대값과 현재가 대비 비율(%) 둘 다 반환. 고정
// -10% 낙폭 임계값이 종목별 평소 변동성 대비 어느 정도인지 참고할 때 쓴다(임계값 자체는
// 안 바꿈). highs/lows/closes는 반드시 같은 날짜 정렬(yf-marketdata.py가 같은 슬라이스로
// 보장). 데이터 부족 시 null. 순수함수 — 테스트 가능.
export function computeAtr(highs, lows, closes, period = 14) {
  const n = Math.min(highs?.length ?? 0, lows?.length ?? 0, closes?.length ?? 0);
  if (n < period + 1) return null;
  const trs = [];
  for (let i = 1; i < n; i++) {
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  const currentPrice = closes[n - 1];
  const pct = currentPrice > 0 ? Math.round(atr / currentPrice * 1000) / 10 : null;
  return { atr: Math.round(atr * 100) / 100, pct };
}

// 스토캐스틱(%K/%D, 14/3) — RSI와 다른 계산식(최근 N일 고저 대비 종가 위치)으로 과매도/과열
// 이중 확인. highs/lows/closes 동일 정렬 필수. 데이터 부족 시 null. 순수함수 — 테스트 가능.
export function computeStochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  const n = Math.min(highs?.length ?? 0, lows?.length ?? 0, closes?.length ?? 0);
  if (n < kPeriod + dPeriod) return null;
  const kValues = [];
  for (let i = kPeriod - 1; i < n; i++) {
    const hh = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
    const ll = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
    kValues.push(hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100);
  }
  if (kValues.length < dPeriod) return null;
  const d = kValues.slice(-dPeriod).reduce((s, x) => s + x, 0) / dPeriod;
  const k = kValues[kValues.length - 1];
  const round2 = (v) => Math.round(v * 100) / 100;
  return { k: round2(k), d: round2(d), oversold: k <= 20, overbought: k >= 80 };
}

// 거래대금(거래량×종가) 급증 — 오늘 거래대금이 직전 window일 평균 대비 몇 배인지. Frank가
// "거래량은 신뢰도 높은 정보"로 강조 — 가격 급락이 대량 거래(투매/전환)를 동반했는지 참고용
// 확인 지표. volumes/closes 동일 정렬 필수. avgPrior 0/결측 시 null(0으로 나누기 방지).
// 순수함수 — 테스트 가능.
export function computeVolumeSurge(volumes, closes, window = 20) {
  const n = Math.min(volumes?.length ?? 0, closes?.length ?? 0);
  if (n < window + 1) return null;
  const value = [];
  for (let i = 0; i < n; i++) value.push(volumes[i] * closes[i]);
  const latest = value[n - 1];
  const avgPrior = value.slice(n - 1 - window, n - 1).reduce((s, x) => s + x, 0) / window;
  if (!(avgPrior > 0)) return null;
  return { ratio: Math.round(latest / avgPrior * 100) / 100, latest: Math.round(latest), avgPrior: Math.round(avgPrior) };
}

// ── 거시지표 (risk-monitor mode D) ──────────────────────────────
// 종가 배열(과거→현재)에서 현재값·5거래일 변화율을 계산. 데이터는 yfinance가 주고
// 숫자는 Node가 산출한다 — LLM이 환율·VIX·지수를 지어내던 환각을 차단(mode B와 동일 원칙).
export function computeMacroChange(closes) {
  const a = (closes || []).filter(x => Number.isFinite(x));
  if (!a.length) return { value: null, change5d: null };
  const value = a[a.length - 1];
  const prev = a.length >= 6 ? a[a.length - 6] : null;  // 5거래일 전
  const change5d = (prev != null && prev !== 0)
    ? Math.round((value - prev) / Math.abs(prev) * 10000) / 100 : null;
  return { value, change5d };
}

// 최근 window거래일 고점 대비 현재 종가의 낙폭(%). 끝점만 보는 change5d와 달리 창 안 고점을
// 기준 삼아 며칠에 걸친 누적 급락(예: 5일 -10%)도 포착 — 진행 중 급락 경보용. 결측·고점0 → null.
export function computeDrawdownFromPeak(closes, window = 5) {
  const a = (closes || []).filter(x => Number.isFinite(x));
  if (a.length < 2) return null;
  const recent = a.slice(-(window + 1));   // 오늘 + 직전 window거래일
  const peak = Math.max(...recent);
  if (!(peak > 0)) return null;
  return Math.round((a[a.length - 1] - peak) / peak * 10000) / 100;
}

// 최근 window거래일 저점 대비 현재 종가의 상승폭(%). computeDrawdownFromPeak의 반대 방향.
// USDKRW 급등(KRW 약세 충격) 탐지용 — 끝점비교가 놓치는 진행 중 급등 포착. 결측·저점0 → null.
export function computeRallyFromTrough(closes, window = 5) {
  const a = (closes || []).filter(x => Number.isFinite(x));
  if (a.length < 2) return null;
  const recent = a.slice(-(window + 1));
  const trough = Math.min(...recent);
  if (!(trough > 0)) return null;
  return Math.round((a[a.length - 1] - trough) / trough * 10000) / 100;
}

// 볼린저 밴드 (MA ± 2σ). 고정 임계값 대신 최근 N거래일 분포로 동적 극단값 판별.
// window=250 ≈ 12개월. 데이터가 window의 절반 미만이면 null(신뢰 부족).
export function computeBollingerBands(closes, window = 250) {
  const a = (closes || []).filter(x => Number.isFinite(x));
  if (a.length < Math.floor(window * 0.5)) return null;
  const slice = a.slice(-window);
  const n = slice.length;
  const ma = slice.reduce((s, x) => s + x, 0) / n;
  const variance = slice.reduce((s, x) => s + (x - ma) ** 2, 0) / n;
  const sigma = Math.sqrt(variance);
  const current = a[a.length - 1];
  const zscore = sigma > 0 ? (current - ma) / sigma : 0;
  const round2 = v => Math.round(v * 100) / 100;
  return {
    ma: round2(ma), sigma: round2(sigma),
    upper: round2(ma + 2 * sigma), lower: round2(ma - 2 * sigma),
    zscore: round2(zscore), window: n,
  };
}

// 네이버 siseJson 응답(JS 배열: 홑따옴표·trailing comma 포함) → 종가 시계열(과거→현재).
// 헤더행('종가' 문자열)·결측은 Number→NaN 으로 자동 제외. 파싱 불가 시 빈 배열(폴백 유도).
export function parseNaverSise(text) {
  try {
    const json = String(text || '').replace(/'/g, '"').replace(/,(\s*[\]}])/g, '$1');
    const rows = JSON.parse(json);
    if (!Array.isArray(rows)) return [];
    return rows.map(r => Number(r?.[4])).filter(Number.isFinite);
  } catch { return []; }
}

// 네이버 금융 지수 종가(무인증, 당일 마감 즉시 반영 — yfinance ^KS11 일봉 확정 지연 회피).
// curl 사용(Python urllib SSL 깨짐·WebFetch 차단). 실패·빈 응답 → [] → 호출부가 yfinance 폴백.
export function fetchNaverIndexCloses(symbol = 'KOSPI', startYmd, endYmd) {
  const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const start = startYmd || ymd(new Date(now.getTime() - 40 * 86400000));
  const end = endYmd || ymd(now);
  const url = `https://api.finance.naver.com/siseJson.naver?symbol=${symbol}&requestType=1&startTime=${start}&endTime=${end}&timeframe=day`;
  const r = spawnSync('curl', ['-sL', '--max-time', '15', url], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) return [];
  return parseNaverSise(r.stdout);
}

export const MACRO_TICKERS = {
  USDKRW: 'KRW=X', TNX: '^TNX', VIX: '^VIX', KOSPI: '^KS11', SP500: '^GSPC',
  KOSDAQ: '^KQ11', NASDAQ: '^IXIC', GOLD: 'GC=F', WTI: 'CL=F',  // 주간리포트 §1 외부변수 결정론화
};

export function fetchMacroIndicators() {
  const py = new URL('./yf-macro.py', import.meta.url).pathname;
  const r = spawnSync('python3', [py, ...Object.values(MACRO_TICKERS)], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`yfinance 거시 조회 실패: ${(r.stderr || '').slice(-200)}`);
  const raw = JSON.parse(r.stdout);
  // KOSPI는 네이버(비지연) 우선, 실패 시 yfinance ^KS11 폴백. 나머지(환율·금리·VIX·S&P)는 yfinance.
  const naverKospi = fetchNaverIndexCloses('KOSPI');
  const kospiCloses = naverKospi.length ? naverKospi : (raw['^KS11'] || []);
  const out = Object.fromEntries(Object.entries(MACRO_TICKERS).map(
    ([key, tk]) => [key, computeMacroChange(key === 'KOSPI' ? kospiCloses : raw[tk])]));
  // KOSPI: 네이버 비지연·5일 고점낙폭·출처 — 가드레일·폴백 가시화.
  out.KOSPI.drawdown5d = computeDrawdownFromPeak(kospiCloses);
  out.KOSPI.source = naverKospi.length ? '네이버(비지연)' : (kospiCloses.length ? 'yfinance(폴백·지연주의)' : '데이터없음');
  // USDKRW: 5일 저점 대비 상승폭(KRW 약세 충격) — 끝점비교 누락 보강. FX는 연속거래라 yfinance 지연 ~10h(허용).
  const usdkrwCloses = raw['KRW=X'] || [];
  out.USDKRW.rally5d = computeRallyFromTrough(usdkrwCloses);
  out.USDKRW.bands = computeBollingerBands(usdkrwCloses);
  out.USDKRW.source = usdkrwCloses.length ? 'yfinance(FX,~10h지연)' : '데이터없음';
  // SP500: 5일 고점 대비 낙폭 — 미증시 진행 중 급락 포착. yfinance 지연 무시 가능(US 이전 세션 종가).
  const sp500Closes = raw['^GSPC'] || [];
  out.SP500.drawdown5d = computeDrawdownFromPeak(sp500Closes);
  out.SP500.source = sp500Closes.length ? 'yfinance' : '데이터없음';
  // TNX·VIX: 출처 표기(임계 설정 어려워 LLM 판단 위임, 가시화만).
  out.TNX.source = (raw['^TNX'] || []).length ? 'yfinance' : '데이터없음';
  out.VIX.source = (raw['^VIX'] || []).length ? 'yfinance' : '데이터없음';
  // 주간리포트 §1 외부변수(가시화·판단 위임). KOSDAQ·나스닥·금·WTI 모두 yfinance.
  for (const [key, tk] of [['KOSDAQ', '^KQ11'], ['NASDAQ', '^IXIC'], ['GOLD', 'GC=F'], ['WTI', 'CL=F']]) {
    if (out[key]) out[key].source = (raw[tk] || []).length ? 'yfinance' : '데이터없음';
  }
  return out;
}
