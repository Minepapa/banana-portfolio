// 결정론적 펀더멘털 데이터 계층 — risk-monitor(B)·backfill-baselines가 사용.
// 원칙: raw 숫자는 절대 LLM이 만들지 않는다. 여기서 조회·계산한 값만 시트와 프롬프트에 쓴다.

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

// fnlttSinglIndx(재무비율) 응답 파싱 — idx_nm 변형을 정규식으로 흡수.
export function parseKrRatios(list) {
  const find = (re) => { const r = (list || []).find(x => re.test(String(x.idx_nm ?? ''))); return r ? num(r.idx_val) : null; };
  return {
    grossMargin: find(/총이익률/),
    opMargin: find(/영업이익률/),
    roe: find(/ROE|자기자본.*이익률/i),
    debtRatio: find(/부채비율/),
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
