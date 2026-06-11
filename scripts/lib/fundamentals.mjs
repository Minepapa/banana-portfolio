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

const num = (s) => { const n = parseFloat(String(s ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };

export function computeYoY(curr, prev) {
  if (curr == null || prev == null || prev === 0) return null;
  return Math.round((curr - prev) / Math.abs(prev) * 1000) / 10;
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

export async function fetchKrFundamentals(corpCode, now = new Date(), apiKey = process.env.DART_API_KEY) {
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

  let ratios = { grossMargin: null, opMargin: null, roe: null, debtRatio: null };
  for (const idx of ['M210000', 'M220000']) {
    const list = await dartJson('fnlttSinglIndx.json', {
      corp_code: corpCode, bsns_year: cur.period.bsnsYear, reprt_code: cur.period.reprtCode, idx_cl_code: idx,
    }, apiKey).catch(() => null);
    if (list) ratios = { ...ratios, ...Object.fromEntries(Object.entries(parseKrRatios(list)).filter(([, v]) => v != null)) };
  }
  // 비율 API 미제공 시 금액으로 직접 계산(영업이익률·부채비율)
  if (ratios.opMargin == null && a.opIncome.curr != null && a.revenue.curr) ratios.opMargin = Math.round(a.opIncome.curr / a.revenue.curr * 1000) / 10;
  if (ratios.debtRatio == null && a.liabilities.curr != null && a.equity.curr) ratios.debtRatio = Math.round(a.liabilities.curr / a.equity.curr * 1000) / 10;

  return {
    market: 'KR',
    source: `OpenDart ${cur.period.bsnsYear} ${REPRT_LABEL[cur.period.reprtCode]}(연결)${cur.fellBack ? ' (분기 미공시 폴백)' : ''}`,
    revenue: a.revenue.curr, revenueYoY: computeYoY(a.revenue.curr, a.revenue.prev),
    opIncome: a.opIncome.curr,
    opYoYCurr: computeYoY(a.opIncome.curr, a.opIncome.prev),
    opYoYPrev: pa ? computeYoY(pa.opIncome.curr, pa.opIncome.prev) : null,
    netIncomeYoY: computeYoY(a.netIncome.curr, a.netIncome.prev),
    ...ratios, eps: null,
  };
}

export function fetchUsFundamentals(ticker) {
  const py = new URL('./yf-fundamentals.py', import.meta.url).pathname;
  const r = spawnSync('python3', [py, ticker], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`yfinance 실패: ${(r.stderr || '').slice(-200)}`);
  return { market: 'US', revenue: null, opIncome: null, netIncomeYoY: null, ...JSON.parse(r.stdout) };
}
