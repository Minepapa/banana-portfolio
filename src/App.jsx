import { useState, useEffect, useCallback, useRef } from "react";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from "recharts";

// ── 구글 시트 설정 ─────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
const SHEET_ID = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';
const CONFIGURED = !GOOGLE_CLIENT_ID.startsWith('YOUR_') && !SHEET_ID.startsWith('YOUR_');

const SHEET_RANGES = {
  ISA:          'ISA!A2:I',            // 0
  위탁:         '위탁!A2:I',           // 1
  연금저축:     '연금저축!A2:I',       // 2
  IRP:          'IRP!A2:I',            // 3
  위탁리밸:     '자산분배!B3:D9',      // 4  목표+현재+리밸 한 범위로 (row 2 = 계좌 레이블)
  연금저축리밸: '자산분배!B12:D18',    // 5
  ISA리밸:      '자산분배!B21:D21',    // 6
  IRP리밸:      '자산분배!B24:D24',    // 7
  월별잔고:     '월별잔고!A2:H',       // 8
  배당금:       '배당금!A2:C',         // 9
  수익금:       '수익금!A2:F',         // 10
  평가노트:     '종목투자노트!A2:U',   // 11  (없거나 비어있어도 안전)
  평가요청:     '평가요청!A2:F',       // 12  비동기 평가 의뢰 큐 (모바일에서 추가 → Claude Pro가 처리)
};

const REBAL_TARGET_START = { ISA: 21, 위탁: 3, 연금저축: 12, IRP: 24 };

// 체결내역 A~M 컬럼 레이블
const CHEOL_COLS = [
  { key: 'A', label: '날짜',     placeholder: 'YYYY-MM-DD' },
  { key: 'B', label: '매수/매도', placeholder: '매수 or 매도' },
  { key: 'C', label: '계좌',     placeholder: 'ISA / 위탁 / 연금저축 / IRP' },
  { key: 'D', label: '주문유형', placeholder: '' },
  { key: 'E', label: '자산유형', placeholder: '채권 / 국내주식 / 해외주식 ...' },
  { key: 'F', label: '종목명',   placeholder: '삼성전자' },
  { key: 'G', label: '체결가',   placeholder: '0' },
  { key: 'H', label: '수량',     placeholder: '0' },
  { key: 'I', label: '체결금액', placeholder: '0' },
  { key: 'J', label: '현재가',   placeholder: '0' },
  { key: 'K', label: '수수료',   placeholder: '0' },
  { key: 'L', label: '세금',     placeholder: '0' },
  { key: 'M', label: '정산금액', placeholder: '0' },
];

// 한국 주식 색상 체계: 이익=빨강, 손실=파랑
const PROFIT_POS = '#EF4444';
const PROFIT_NEG = '#60A5FA';
const CHART_BAR_COLOR = '#3B82F6';

// ── 색상 팔레트 ───────────────────────────────────────────────────────────────
const COLORS = {
  채권: "#4A90D9", 금: "#F5C842", 달러: "#7EC8A4", 배당주: "#F4845F",
  리츠: "#B07FE8", 국내주식: "#E85F7A", 해외주식: "#52C8D4", TDF: "#A8D672",
};

// ── 학습 모듈 + AI 능동 평가 (Trading Agent/learning/ 참조) ─────────────────
const LEARNING_MODULES = {
  // 수익성
  revenue_growth:   { title: '매출성장률 YoY', summary: '작년 같은 분기 대비 매출이 몇 % 늘었나. 회사의 외형 성장 속도. 마진과 함께 봐야 의미 있음.', threshold: 'Frank 확정: 10%+ 3년 유지면 성장주로 분류. 마진 동시 상승이면 강력. (2026-05 인터뷰)' },
  operating_margin: { title: '영업이익률', summary: '본업으로 매출 100원에 영업단계 얼마 남는지. 동종 평균 1.5배 이상이면 가격결정력 강함.', threshold: 'Frank: 동종 대비 1.5배 + 3년 추세 평탄/상승이면 매수 근거' },
  roic:             { title: 'ROIC (투하자본수익률)', summary: '빚+자기자본을 굴려 얼마 남기는지. 15% 이상 5년 유지면 해자(moat) 강력. ROE보다 정직.', threshold: 'Frank: 15% 이상 5년 평균 → 매수 후보, 10% 미만 → 신중' },

  // 재무 안정성
  net_debt_ebitda:  { title: '순부채/EBITDA', summary: '회사가 번 돈(EBITDA)으로 빚을 갚는 데 몇 년 걸리는지. 1배 이하면 빚 부담 없음, 3배 이상이면 위험.', threshold: 'Frank: < 1배 양호, 1~3배 보통, > 3배 신중. 사이클 산업은 더 보수적으로' },
  interest_coverage:{ title: '이자보상배율 (EBIT/이자비용)', summary: '영업이익으로 이자를 몇 번 갚을 수 있는지. 5배 이상이 안전선, 2배 이하면 위험.', threshold: 'Frank: > 5배 안전, 3~5 보통, < 3 신중. 금리 상승기엔 5배 이상 권장' },
  current_ratio:    { title: '유동비율', summary: '1년 안에 갚을 빚(유동부채) 대비 1년 안에 현금화 가능한 자산(유동자산). 150%+ 양호.', threshold: 'Frank: > 150% 양호, 100~150% 보통, < 100% 단기 유동성 리스크' },

  // 밸류에이션
  fwd_per:          { title: 'Forward PER 5년 밴드', summary: '예상 EPS 기준 PER이 지난 5년 밴드 어디인지. 자기 자신과의 비교라 업종 차이 흡수.', threshold: 'Frank: 밴드 P25 이하 + 펀더멘털 OK → 적극 매수, P75 이상 → 보류' },
  ev_ebitda:        { title: 'EV/EBITDA', summary: '회사 전체 가격(EV) ÷ 본업 현금이익(EBITDA). PER보다 부채·세금·감가상각 영향 제거해 더 정직.', threshold: 'Frank: < 8배 저평가, 8~12 보통, > 15 고평가. 동종/5년 밴드와 같이' },
  pbr:              { title: 'PBR (주가순자산비율)', summary: '주가 ÷ 주당순자산. 회사를 청산해서 받는 돈 대비 시장가. 1배 이하 = 청산가치 미달.', threshold: 'Frank: 자산형 회사(은행·금융지주) 0.5~1배, 성장주는 PBR로 판단하지 말 것' },

  // 현금흐름
  fcf_yield:        { title: 'FCF yield', summary: 'FCF/시가총액. 시가총액 대비 매년 회수되는 현금. 회계이익은 거짓말 가능, 현금은 사실.', threshold: 'Frank: 매수 시 영업이익만 보지 말 것. 배당주는 FCF 커버리지 80% 마지노선' },
  payout_ratio:     { title: '배당성향', summary: '순이익 중 배당으로 나가는 비율. 70% 넘으면 성장 재투자 여력 적음, 100% 넘으면 배당컷 임박.', threshold: 'Frank 확정: 40~60% 이상적 (메리츠금융지주형 균형). 80%+면 FCF 커버리지 같이 확인. (2026-05 인터뷰)' },
  dividend_sustainability:{ title: '배당지속가능성 (FCF 커버리지)', summary: '배당총액/FCF. 회사가 버는 현금으로 배당을 얼마나 여유롭게 지급하나. 80% 넘으면 배당컷 리스크.', threshold: 'Frank: < 80% 안전, 80~100% 경계, > 100% 배당컷 경보' },

  // 모멘텀
  rsi:              { title: 'RSI (상대강도지수)', summary: '14거래일 상승/하락 비율. 30 이하 = 일방적 매도세(반등 확률↑), 70 이상 = 과열.', threshold: 'CLAUDE.md §4: RSI 30 이하 → 적극 매수 / 70 이상 → 일부 차익실현' },
  pos_52w:          { title: '52주 위치', summary: '현재가가 52주 최저~최고 어디인지. 하단 20% = 저점 매수, 상단 80% = 차익실현 검토.', threshold: 'CLAUDE.md §4: 52주 고점 +20% 초과 → 일부 매도 / ≤20% + 펀더멘털 OK → 적극 매수' },
  foreign_flow:     { title: '외국인·기관 수급', summary: '한국 시장에서 외국인은 시총 ~35% 보유, 시장 방향 결정. 4거래일 흐름 + 환율 같이.', threshold: 'Frank: 외국인 4일 연속 순매도 → 추가 매수 보류 / 동반 순매수 4일 → 적립식 가속' },
  sector_rs:        { title: '섹터 상대강도', summary: '해당 섹터 ETF 수익률 − 시장 지수 수익률. 양수면 섹터가 시장을 이기는 중, 강세 모멘텀 시그널.', threshold: 'Frank: 보유 섹터의 RS가 4주 연속 양수면 비중 유지/확대, 음수 전환 시 점검' },

  // KPI (운용)
  twr:              { title: 'TWR (시간가중수익률)', summary: '입출금 효과 제거한 순수 운용 수익률. 단순 수익률과의 차이가 곧 타이밍 효과.', threshold: 'Frank 확정: 연 TWR 시장 혼합(KOSPI:S&P500=50:50) 대비 +3~5%p (균형형 알파 목표). (2026-05 인터뷰)' },
  sharpe:           { title: '샤프 비율', summary: '(수익률 − 무위험) / 변동성. 위험 1단위당 초과 수익. 1.0~1.5가 개인 포트폴리오 목표.', threshold: 'Frank 확정: 1년 샤프 0.8~1.2 (개인 적극 운용 합리적 목표). (2026-05 인터뷰)' },
  mdd:              { title: '최대낙폭 (MDD)', summary: '최고점 대비 최저점 하락폭. 평균은 행복해도 거기서 못 견디면 의미 없다.', threshold: 'Frank 확정: 1년 MDD −25% 이내 (성장형) / 3년 −35% 이내 / 회복 12개월 이내. (2026-05 인터뷰)' },
};

// 5축 → 학습 모듈 metric key. 시트 적재 카드는 axis grade만 있어 지표별 📘가 안 보이므로
// axis 단위로 학습 모듈 진입 칩을 묶어 보여준다.
const AXIS_METRICS = {
  '수익성':     ['revenue_growth', 'operating_margin', 'roic'],
  '재무 안정성': ['net_debt_ebitda', 'interest_coverage', 'current_ratio'],
  '밸류에이션':  ['fwd_per', 'ev_ebitda', 'pbr'],
  '현금흐름':    ['fcf_yield', 'payout_ratio', 'dividend_sustainability'],
  '모멘텀':      ['rsi', 'pos_52w', 'foreign_flow', 'sector_rs'],
};

const SAMPLE_EVALUATION = {
  stock: { name: 'SK하이닉스', ticker: '000660', market: 'KR' },
  date: '2026-05-17',
  axes: [
    { label: '수익성', grade: '🟢', items: [
      { label: '매출성장률 YoY', value: '+47%',   source: 'OpenDart Q1',   metric: 'revenue_growth' },
      { label: '영업이익률',    value: '32.1%',  source: 'HBM 마진 견인', metric: 'operating_margin' },
      { label: 'ROIC',          value: '21.4%',  source: 'vs 동종 12%',   metric: 'roic' },
    ]},
    { label: '재무 안정성', grade: '🟢', items: [
      { label: '순부채/EBITDA', value: '0.8',   source: '양호', metric: 'net_debt_ebitda' },
      { label: '이자보상배율',  value: '11x',   source: '양호', metric: 'interest_coverage' },
      { label: '유동비율',      value: '185%',                  metric: 'current_ratio' },
    ]},
    { label: '밸류에이션', grade: '🟢', items: [
      { label: 'Forward PER',  value: '6.8x',  source: '5년 밴드 하단, 평균 12x', metric: 'fwd_per' },
      { label: 'EV/EBITDA',    value: '4.2x',                                      metric: 'ev_ebitda' },
      { label: 'PBR',          value: '1.8x',                                      metric: 'pbr' },
    ]},
    { label: '현금흐름', grade: '🟢', items: [
      { label: 'FCF yield',         value: '8.2%', source: '시장금리 4.6% 대비 우수', metric: 'fcf_yield' },
      { label: '배당성향',          value: '12%',                                       metric: 'payout_ratio' },
      { label: '배당지속가능성',    value: '✅',  source: 'FCF 8% > 배당 1%',           metric: 'dividend_sustainability' },
    ]},
    { label: '모멘텀', grade: '🟡', items: [
      { label: 'RSI(14)',        value: '58',         source: '중립',                  metric: 'rsi' },
      { label: '52주 위치',      value: '78%',        source: '상단 영역',             metric: 'pos_52w' },
      { label: '외국인 4일',     value: '−2,300억',   source: '순매도',                metric: 'foreign_flow' },
      { label: '섹터 상대강도',  value: '+4.2%',      source: '반도체 vs 코스피',      metric: 'sector_rs' },
    ]},
  ],
  conclusion: { grade: '🟢', label: '매수 적합 O' },
  reasons: [
    'HBM 사이클 구조적 수혜로 영업이익률 30%대 정착, 동종 평균 12% 대비 2.6배.',
    'Fwd PER 6.8x는 5년 밴드 하단 + FCF yield 8.2%로 채권(4.6%) 대비 매력.',
    'ROIC 21.4% 5년 추세 유효 — 자본 효율 강력.',
  ],
  risks: [
    '외국인 4거래일 순매도 −2,300억 — 단기 환율/지정학 영향 가능.',
    '미·중 반도체 규제 강화 시 중국향 매출(전체 22%) 노출.',
  ],
  actions: [
    '1회 300만원 미만 분할 매수 가능 (CLAUDE.md §3).',
    '외국인 4일 흐름이 순매수 전환 후 1차 진입 권장.',
    '52주 위치 60% 이하로 눌림 발생 시 추가 매수 트리거.',
  ],
  sources: [
    'OpenDart Q1 2026 (조회일 2026-05-17)',
    'NaverFinance 종목페이지 (조회일 2026-05-17)',
    '5/17 weekly_report 외부 변수',
  ],
};

const EVAL_PROMPT_TEMPLATE = `[종목 능동 평가 요청]
종목: <여기에 종목명 또는 티커 입력>

다음 플레이북에 따라 5축 평가 카드를 생성해줘:
- 단일 출처: Trading Agent/playbooks/active-evaluation.md
- 출력 양식: §5의 표준 카드 (5축 + 결론 🟢/🟡/🔴 + 근거 3줄 + 리스크 2줄 + Frank 액션)
- 데이터: KR=OpenDart MCP, US=UsStockInfo MCP
- 모든 수치 출처/기준일 표기, 누락 항목은 '데이터 부족'으로 명시
- 학습 모듈 옆 📘 표시 유지

마지막에 반드시 아래 JSON 블록을 \`\`\`json ... \`\`\` 펜스로 출력해줘
(banana-portfolio 평가 탭에 1-클릭 적재용):

\`\`\`json
{
  "date": "YYYY-MM-DD",
  "name": "종목명",
  "ticker": "티커 또는 종목코드",
  "market": "KR | US",
  "conclusion": "🟢 O | 🟡 △ | 🔴 X",
  "grades": {
    "수익성": "🟢|🟡|🔴",
    "안정성": "🟢|🟡|🔴",
    "밸류에이션": "🟢|🟡|🔴",
    "현금흐름": "🟢|🟡|🔴",
    "모멘텀": "🟢|🟡|🔴"
  },
  "reasons": ["근거1", "근거2", "근거3"],
  "risks": ["리스크1", "리스크2"],
  "actions": ["액션1", "액션2", "액션3"],
  "frankMemo": "",
  "status": "보류 | 매수 | 매도",
  "buyDate": "",
  "buyPrice": "",
  "targetTerm": "장기 | 1Y | 3Y",
  "targetRet": "30%",
  "aiNote": "한 줄 요약"
}
\`\`\``;

// ── 기본 데이터 ───────────────────────────────────────────────────────────────
const DEFAULT_ACCOUNTS = {
  ISA: {
    label: "ISA", sub: "NH · 배당포트",
    total_invest: 0, total_eval: 0, profit: 0, color: "#F4845F",
    assets: [{ name: "배당주", ratio: 0, invest: 0, eval: 0, target: 0 }],
    holdings: [],
  },
  위탁: {
    label: "위탁+기타", sub: "NH · 수비형포트",
    total_invest: 0, total_eval: 0, profit: 0, color: "#52C8D4",
    assets: [
      { name: "채권",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "금",      ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "달러",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "배당주",  ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "리츠",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "국내주식", ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "해외주식", ratio: 0, invest: 0, eval: 0, target: 0 },
    ],
    holdings: [],
  },
  연금저축: {
    label: "연금저축", sub: "삼성 · 공격형포트",
    total_invest: 0, total_eval: 0, profit: 0, color: "#B07FE8",
    assets: [
      { name: "채권",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "금",      ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "달러",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "배당주",  ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "리츠",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "국내주식", ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "해외주식", ratio: 0, invest: 0, eval: 0, target: 0 },
    ],
    holdings: [],
  },
  IRP: {
    label: "IRP", sub: "한투 · TDF",
    total_invest: 0, total_eval: 0, profit: 0, color: "#A8D672",
    assets: [{ name: "TDF", ratio: 0, invest: 0, eval: 0, target: 0 }],
    holdings: [],
  },
};

// ── 반응형 훅 ─────────────────────────────────────────────────────────────────
function useIsMobile(bp = 640) {
  const [m, setM] = useState(() => window.innerWidth < bp);
  useEffect(() => {
    const h = () => setM(window.innerWidth < bp);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, [bp]);
  return m;
}

// ── 유틸 함수 ─────────────────────────────────────────────────────────────────
const fmt = (n) => {
  if (n == null) return '-';
  return Math.round(Math.abs(n)).toLocaleString('ko-KR');
};

// ── 구글 스크립트 동적 로더 ───────────────────────────────────────────────────
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

// ── 파싱 함수들 ───────────────────────────────────────────────────────────────
function parseNum(v) {
  return parseFloat(String(v ?? 0).replace(/,/g, '')) || 0;
}

function computeAssets(holdings, totalEval, defaultAssets) {
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
function computeKPI(data) {
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

  // MDD (전체 기간 총잔고 기준)
  let peak = data[0].value;
  let mdd  = 0;
  for (const d of data) {
    if (d.value > peak) peak = d.value;
    const dd = peak > 0 ? (d.value - peak) / peak : 0;
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

  return { twr: twrAnn, sharpe, mdd, months: returns.length };
}

function parseMonthly(vr) {
  const rows = vr?.values ?? [];
  let lastYear = 0;
  const result = [];
  rows.forEach(r => {
    // B열(index 0): 연도 — 숫자만 추출하므로 "2024", "2024년", "2,024" 모두 처리
    const bNum = parseInt(String(r[0] ?? '').replace(/[^0-9]/g, ''));
    if (bNum >= 2000) lastYear = bNum;

    // C열(index 1): 월 — 숫자만 추출하므로 "1", "1월", "01" 모두 처리
    const month = parseInt(String(r[1] ?? '').replace(/[^0-9]/g, ''));

    // I열(index 7 in B:I 범위): 총잔고
    const total = parseNum(r[7]);

    if (!total || !month || !lastYear) return;
    const yearShort = String(lastYear).slice(-2);
    const savings = parseNum(r[2]);
    result.push({ label: `${yearShort}.${String(month).padStart(2, '0')}`, value: total, savings, year: lastYear });
  });
  return result;
}

function findMonthlyRow(vr) {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const rows = vr?.values ?? [];
  let lastYear = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const bNum = parseInt(String(r[0] ?? '').replace(/[^0-9]/g, ''));
    if (bNum >= 2000) lastYear = bNum;
    const mNum = parseInt(String(r[1] ?? '').replace(/[^0-9]/g, ''));
    if (lastYear === year && mNum === month) return 2 + i;
  }
  return null;
}

function parseDividends(vrAll) {
  const result = {};
  (vrAll?.values ?? []).forEach(r => {
    const dateStr = String(r[0] ?? '').trim();
    const amt  = parseNum(r[1] ?? 0);  // B열: 금액
    const name = String(r[2] ?? '').trim(); // C열: 종목명
    if (!dateStr || !amt) return;
    const parts = dateStr.split('-');
    if (parts.length < 2) return;
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    if (!year || !month) return;
    const key = `${year}-${month}`;
    if (!result[key]) result[key] = { year, month, amount: 0, items: [] };
    result[key].amount += amt;
    result[key].items.push({ date: dateStr, name, amount: amt });
  });
  return Object.values(result).sort((a, b) => a.year - b.year || a.month - b.month);
}

function parseProfits(vr) {
  const result = {};
  (vr?.values ?? []).forEach(r => {
    const dateStr = String(r[0] ?? '').trim();
    const name    = String(r[1] ?? '').trim();
    const profit  = parseNum(r[5]); // F열: 수익금
    if (!dateStr) return;
    const parts = dateStr.split('-');
    if (parts.length < 2) return;
    const year  = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    if (!year || !month) return;
    const key = `${year}-${month}`;
    if (!result[key]) result[key] = { year, month, total: 0, items: [] };
    result[key].total += profit;
    if (name) result[key].items.push({ date: dateStr, name, profit });
  });
  return Object.values(result).sort((a, b) => a.year - b.year || a.month - b.month);
}

// 종목투자노트 탭 (playbook §6 컬럼 A~T) → 평가 카드 객체 배열
function parseEvaluations(vr) {
  const rows = vr?.values ?? [];
  const splitNumbered = (s) => {
    const t = String(s ?? '').trim();
    if (!t) return [];
    // "1) ... 2) ..." or "1. ... 2. ..." or 줄바꿈 분리
    if (/\d[).]\s/.test(t)) {
      return t.split(/(?=\d[).]\s)/).map(x => x.replace(/^\d[).]\s*/, '').trim()).filter(Boolean);
    }
    return t.split(/[\n;]+/).map(x => x.trim()).filter(Boolean);
  };
  const splitBullets = (s) => splitNumbered(s).length
    ? splitNumbered(s)
    : String(s ?? '').split(/\.\s+(?=[A-Z가-힣])/).map(x => x.trim()).filter(Boolean);

  return rows.map(r => {
    const date = String(r[0] ?? '').trim();
    const name = String(r[1] ?? '').trim();
    if (!date || !name) return null;
    return {
      stock: {
        name,
        ticker: String(r[2] ?? '').trim(),
        market: String(r[3] ?? '').trim(),
      },
      date,
      conclusion: { raw: String(r[4] ?? '').trim() },
      axisGrades: {
        수익성:     String(r[5] ?? '').trim(),
        안정성:     String(r[6] ?? '').trim(),
        밸류에이션: String(r[7] ?? '').trim(),
        현금흐름:   String(r[8] ?? '').trim(),
        모멘텀:     String(r[9] ?? '').trim(),
      },
      reasons:   splitNumbered(r[10]),
      risks:     splitNumbered(r[11]),
      actions:   splitBullets(r[12]),
      frankMemo: String(r[13] ?? '').trim(),
      status:    String(r[14] ?? '').trim(),  // 매수 / 보류 / 매도
      buyDate:   String(r[15] ?? '').trim(),
      buyPrice:  String(r[16] ?? '').trim(),
      targetTerm:String(r[17] ?? '').trim(),
      targetRet: String(r[18] ?? '').trim(),
      aiNote:    String(r[19] ?? '').trim(),
      axisItems: (() => { try { const v = String(r[20] ?? '').trim(); return v ? JSON.parse(v) : null; } catch { return null; } })(),
    };
  }).filter(Boolean).reverse();  // 최신순
}

// 평가요청 큐 (컬럼 A~F) → { entries, counts }
function parseEvalQueue(vr) {
  const rows = vr?.values ?? [];
  const entries = rows.map((r, idx) => {
    const requestedAt = String(r[0] ?? '').trim();
    const name = String(r[1] ?? '').trim();
    if (!requestedAt || !name) return null;
    return {
      rowIndex: idx,
      requestedAt,
      name,
      market: String(r[2] ?? '').trim(),
      status: String(r[3] ?? '').trim() || '대기',
      processedAt: String(r[4] ?? '').trim(),
      memo: String(r[5] ?? '').trim(),
    };
  }).filter(Boolean);

  const counts = entries.reduce((acc, e) => {
    const k = e.status === '완료' ? 'done'
            : e.status === '처리중' ? 'processing'
            : e.status === '오류' ? 'error'
            : 'pending';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, { pending: 0, processing: 0, done: 0, error: 0 });

  // 최신 요청 순으로 정렬해서 반환
  return { entries: entries.slice().reverse(), counts };
}

function parseSheetData(valueRanges) {
  // indices: ISA(0) 위탁(1) 연금저축(2) IRP(3)
  //          위탁리밸(4) 연금저축리밸(5) ISA리밸(6) IRP리밸(7)
  //          월별잔고(8) 배당금(9)
  const accountKeys = ['ISA', '위탁', '연금저축', 'IRP'];
  const result = {};
  let anyData = false;

  accountKeys.forEach((key, i) => {
    const allRows = valueRanges[i]?.values ?? [];
    let lastType = '';
    const holdings = [];
    allRows.forEach((r, rowOffset) => {
      if (!r[1]) return;
      const type = String(r[0] ?? '').trim();
      if (type) lastType = type;
      holdings.push({
        name: String(r[1] ?? ''),
        price: parseNum(r[2]),
        qty: parseNum(r[3]),
        invest: parseNum(r[4]),
        currentPrice: parseNum(r[5]),
        eval: parseNum(r[7]),
        profit: parseNum(r[6]),
        rate: parseNum(r[8]),
        type: lastType,
        rowOffset,
      });
    });
    if (!holdings.length) return;
    anyData = true;

    const total_invest = holdings.reduce((s, h) => s + h.invest, 0);
    const total_eval = holdings.reduce((s, h) => s + h.eval, 0);

    result[key] = {
      ...DEFAULT_ACCOUNTS[key],
      total_invest,
      total_eval,
      profit: total_eval - total_invest,
      holdings,
      assets: computeAssets(holdings, total_eval, DEFAULT_ACCOUNTS[key].assets),
    };
  });

  // 리밸런싱: 각 계좌별 단일 범위 [목표비율(B), 현재비율(C), 리밸런싱금액(D)]
  const parseRebalRows = (vr) => {
    const rows = vr?.values ?? [];
    return {
      targets:  rows.map(r => parseNum(r[0])),
      currents: rows.map(r => parseNum(r[1])),
      rebals:   rows.map(r => parseNum(r[2])),
    };
  };

  if (result['위탁']) {
    const { targets, currents, rebals } = parseRebalRows(valueRanges[4]);
    result['위탁'].assets = result['위탁'].assets.map((a, i) => ({
      ...a,
      target: targets[i] ?? a.target,
      sheetCurrent: currents[i] ?? 0,
      rebalAmt: rebals[i] ?? 0,
    }));
  }

  if (result['연금저축']) {
    const { targets, currents, rebals } = parseRebalRows(valueRanges[5]);
    result['연금저축'].assets = result['연금저축'].assets.map((a, i) => ({
      ...a,
      target: targets[i] ?? a.target,
      sheetCurrent: currents[i] ?? 0,
      rebalAmt: rebals[i] ?? 0,
    }));
  }

  if (result['ISA']) {
    const { targets, currents, rebals } = parseRebalRows(valueRanges[6]);
    result['ISA'].assets = result['ISA'].assets.map((a, i) => ({
      ...a,
      target: i === 0 ? (targets[0] ?? a.target) : a.target,
      sheetCurrent: i === 0 ? (currents[0] ?? 0) : 0,
      rebalAmt: i === 0 ? (rebals[0] ?? 0) : 0,
    }));
  }

  if (result['IRP']) {
    const { targets, currents, rebals } = parseRebalRows(valueRanges[7]);
    result['IRP'].assets = result['IRP'].assets.map((a, i) => ({
      ...a,
      target: i === 0 ? (targets[0] ?? a.target) : a.target,
      sheetCurrent: i === 0 ? (currents[0] ?? 0) : 0,
      rebalAmt: i === 0 ? (rebals[0] ?? 0) : 0,
    }));
  }

  const monthly = parseMonthly(valueRanges[8]);
  const monthlyRow = findMonthlyRow(valueRanges[8]);
  const dividends = parseDividends(valueRanges[9]);
  const profits = parseProfits(valueRanges[10]);
  const evaluations = parseEvaluations(valueRanges[11]);
  const evalQueue = parseEvalQueue(valueRanges[12]);

  return anyData ? { accounts: result, monthly, monthlyRow, dividends, profits, evaluations, evalQueue } : null;
}

// ── useGoogleSheets 훅 ────────────────────────────────────────────────────────
function useGoogleSheets(onData) {
  const [auth, setAuth] = useState('idle');
  const [sync, setSync] = useState('idle');
  const [lastSync, setLastSync] = useState(null);
  const lastSyncRef = useRef(null);
  const [tc, setTc] = useState(null);
  const onDataRef = useRef(onData);
  useEffect(() => { onDataRef.current = onData; });

  const doFetch = useCallback(async () => {
    setSync('syncing');
    try {
      const resp = await window.gapi.client.sheets.spreadsheets.values.batchGet({
        spreadsheetId: SHEET_ID,
        ranges: Object.values(SHEET_RANGES),
      });
      const parsed = parseSheetData(resp.result.valueRanges);
      if (parsed) {
        onDataRef.current({
          accounts: parsed.accounts,
          monthly: parsed.monthly,
          monthlyRow: parsed.monthlyRow,
          dividends: parsed.dividends,
          profits: parsed.profits,
          evaluations: parsed.evaluations,
        });
      }
      const now = new Date();
      lastSyncRef.current = now;
      setLastSync(now);
      setSync('synced');
    } catch (e) {
      console.error('Sheets fetch error:', e);
      setSync('error');
    }
  }, []);

  useEffect(() => {
    if (!CONFIGURED) return;
    setAuth('loading');
    Promise.all([
      loadScript('https://apis.google.com/js/api.js'),
      loadScript('https://accounts.google.com/gsi/client'),
    ]).then(() => {
      window.gapi.load('client', async () => {
        try {
          await window.gapi.client.init({
            discoveryDocs: ['https://sheets.googleapis.com/$discovery/rest?version=v4'],
          });
          const tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope: SCOPES,
            callback: async (resp) => {
              if (resp.error) { setAuth('error'); return; }
              setAuth('signed-in');
              await doFetch();
            },
          });
          setTc(tokenClient);
          setAuth('signed-out');
        } catch (e) {
          console.error('Google init error:', e);
          setAuth('error');
        }
      });
    }).catch(() => setAuth('error'));
  }, [doFetch]);

  const signIn = useCallback(() => {
    if (tc) tc.requestAccessToken({ prompt: '' });
  }, [tc]);

  const signOut = useCallback(() => {
    const token = window.gapi?.client?.getToken?.();
    if (token) {
      window.google.accounts.oauth2.revoke(token.access_token);
      window.gapi.client.setToken(null);
    }
    setAuth('signed-out');
    setSync('idle');
    setLastSync(null);
  }, []);

  const appendRow = useCallback(async (range, rowData) => {
    await window.gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [rowData] },
    });
    await doFetch();
  }, [doFetch]);

  const clearRows = useCallback(async (ranges) => {
    await window.gapi.client.sheets.spreadsheets.values.batchClear({
      spreadsheetId: SHEET_ID,
      resource: { ranges },
    });
    await doFetch();
  }, [doFetch]);

  const readRange = useCallback(async (range, renderOption) => {
    const resp = await window.gapi.client.sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
      ...(renderOption ? { valueRenderOption: renderOption } : {}),
    });
    return resp.result.values ?? [];
  }, []);

  const writeRange = useCallback(async (range, rowData) => {
    await window.gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [rowData] },
    });
  }, []);

  const writeRangeMulti = useCallback(async (range, rows) => {
    await window.gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: rows },
    });
  }, []);

  // 진짜 append (시트 끝에 새 행 추가) — values.append API
  const appendValues = useCallback(async (range, rows) => {
    await window.gapi.client.sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: rows },
    });
    await doFetch();
  }, [doFetch]);

  const insertRowAfter = useCallback(async (sheetName, startIndex) => {
    const meta = await window.gapi.client.sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: 'sheets.properties',
    });
    const sheet = meta.result.sheets.find(s => s.properties.title === sheetName);
    if (!sheet) throw new Error(`Sheet ${sheetName} not found`);
    await window.gapi.client.sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [{
          insertDimension: {
            range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex, endIndex: startIndex + 1 },
            inheritFromBefore: true,
          }
        }]
      }
    });
  }, []);

  const clearRowsRaw = useCallback(async (ranges) => {
    await window.gapi.client.sheets.spreadsheets.values.batchClear({
      spreadsheetId: SHEET_ID,
      resource: { ranges },
    });
  }, []);

  const getSheetId = useCallback(async (sheetName) => {
    const meta = await window.gapi.client.sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: 'sheets.properties',
    });
    const sheet = meta.result.sheets.find(s => s.properties.title === sheetName);
    return sheet?.properties?.sheetId ?? null;
  }, []);

  const readTradeProcessedFlags = useCallback(async () => {
    const resp = await window.gapi.client.sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      ranges: ['체결내역!A2:A200'],
      includeGridData: true,
      fields: 'sheets.data.rowData.values.userEnteredFormat.backgroundColor',
    });
    const rows = resp.result.sheets?.[0]?.data?.[0]?.rowData ?? [];
    return rows.map(r => {
      const bg = r?.values?.[0]?.userEnteredFormat?.backgroundColor;
      if (!bg) return false;
      return (bg.green ?? 0) > 0.5 && (bg.red ?? 1) < 0.5;
    });
  }, []);

  const markTradeProcessed = useCallback(async (sheetId, rowIndex) => {
    await window.gapi.client.sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [{
          repeatCell: {
            range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: 1 },
            cell: { userEnteredFormat: { backgroundColor: { red: 0.204, green: 0.659, blue: 0.325 } } },
            fields: 'userEnteredFormat.backgroundColor',
          },
        }],
      },
    });
  }, []);

  return { auth, sync, lastSync, lastSyncRef, signIn, signOut, fetch: doFetch, appendRow, appendValues, clearRows, clearRowsRaw, readRange, writeRange, writeRangeMulti, insertRowAfter, getSheetId, readTradeProcessedFlags, markTradeProcessed };
}

// ── 종목추가 폼 컴포넌트 ──────────────────────────────────────────────────────
const START_ROWS = { ISA: 2, 위탁: 2, 연금저축: 2, IRP: 2 };

// 계좌별 A:B 읽기 범위 (A=자산군, B=종목명 여부 확인용)
const KL_CFG = {
  ISA:      { range: 'ISA!A2:B60',      start: 2, end: 60 },
  위탁:     { range: '위탁!A2:B60',     start: 2, end: 60 },
  연금저축: { range: '연금저축!A2:B60', start: 2, end: 60 },
  IRP:      { range: 'IRP!A2:B30',      start: 2, end: 30 },
};

function buildRowMap(rows, start, end) {
  let lastType = '';
  const result = [];
  for (let i = 0; i < end - start + 1; i++) {
    const r = rows[i] ?? [];
    const k = String(r[0] ?? '').trim();
    if (k) lastType = k;
    result.push({ row: start + i, type: lastType, empty: !String(r[1] ?? '').trim(), hasA: !!k });
  }
  return result;
}

function AddHoldingForm({ acctKey, accounts, onSave, onCancel, readRange }) {
  const assetNames = accounts[acctKey].assets.map(a => a.name);

  const [자산군, set자산군] = useState(assetNames[0] || '');
  const [종목명, set종목명] = useState('');
  const [티커유형, set티커유형] = useState('국내(GOOGLEFINANCE)');
  const [티커, set티커] = useState('');
  const [현재가수기, set현재가수기] = useState('');
  const [매수단가, set매수단가] = useState('');
  const [수량, set수량] = useState('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [rowMap, setRowMap] = useState(null);

  const loadRowMap = useCallback(() => {
    const cfg = KL_CFG[acctKey];
    if (!cfg) return;
    readRange(cfg.range)
      .then(rows => setRowMap(buildRowMap(rows, cfg.start, cfg.end)))
      .catch(() => setRowMap([]));
  }, [acctKey, readRange]);

  useEffect(() => { setRowMap(null); loadRowMap(); }, [loadRowMap]);

  const hasAInSheet = rowMap ? rowMap.some(r => r.hasA && r.type === 자산군) : null;
  const emptySlots = rowMap ? rowMap.filter(r => r.type === 자산군 && r.empty && r.hasA).length : null;
  const sheetWarning = rowMap !== null && (!hasAInSheet || emptySlots === 0);
  const notReady = rowMap === null || saving || sheetWarning;

  const inputStyle = {
    background: '#0D1520', border: '1px solid #2A2F3E', borderRadius: 6,
    color: '#E8EAF0', padding: '6px 10px', fontSize: 12,
    fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
    width: '100%', boxSizing: 'border-box',
  };
  const labelStyle = { fontSize: 10, color: '#5A6478', marginBottom: 4, display: 'block' };

  const handleSubmit = async () => {
    if (!종목명.trim() || !매수단가 || !수량 || !rowMap || sheetWarning) return;
    // 자산군의 첫 번째 빈 행 찾기
    let targetRow = null;
    for (const r of rowMap) {
      if (r.type === 자산군 && r.empty && r.hasA) { targetRow = r.row; break; }
    }
    if (targetRow === null) return;
    setSaving(true);
    try {
      let 현재가formula = '';
      if (티커유형 === '국내(GOOGLEFINANCE)') 현재가formula = `=GOOGLEFINANCE("${티커}")`;
      else if (티커유형 === '해외(GOOGLEFINANCE)') 현재가formula = `=GOOGLEFINANCE("${티커}")*설정!B2`;
      else if (티커유형 === '네이버') 현재가formula = `=IMPORTXML("https://finance.naver.com/item/main.naver?code=${티커}","//p[@class='no_today']/em/span[1]")`;
      else if (티커유형 === '수기입력') 현재가formula = parseFloat(현재가수기) || 0;
      const n = targetRow;
      const 투자금 = parseFloat(매수단가) * parseFloat(수량);
      await onSave(`${acctKey}!B${n}:I${n}`, [
        종목명, parseFloat(매수단가), parseFloat(수량),
        `=C${n}*D${n}`,
        현재가formula,
        `=H${n}-E${n}`, `=D${n}*F${n}`, `=H${n}/E${n}-1`,
      ], 투자금);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
      set종목명(''); set티커(''); set현재가수기(''); set매수단가(''); set수량('');
      loadRowMap();
    } catch (e) {
      console.error('종목추가 오류:', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      background: '#1A1D26', border: '1px solid #2A2F3E', borderRadius: 12,
      padding: 16, marginBottom: 16,
    }}>
      <div style={{ fontSize: 11, letterSpacing: 2, color: '#5A6478', marginBottom: 12 }}>종목 추가</div>
      {rowMap !== null && sheetWarning && (
        <div style={{
          background: '#2D1A1A', border: '1px solid #7F1D1D', borderRadius: 6,
          padding: '7px 11px', marginBottom: 10, fontSize: 11, color: '#FCA5A5',
        }}>
          ⚠ {!hasAInSheet ? `시트 A열에 '${자산군}' 자산군 없음` : '빈 행 없음 — 시트에 공백 행 추가 필요'}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div>
          <label style={labelStyle}>
            자산군{rowMap !== null && hasAInSheet && (
              <span style={{ marginLeft: 5, color: emptySlots > 0 ? '#6EE7B7' : '#FCA5A5' }}>
                ({emptySlots}개 가능)
              </span>
            )}
          </label>
          <select value={자산군} onChange={e => set자산군(e.target.value)} style={inputStyle}>
            {assetNames.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>종목명</label>
          <input type="text" value={종목명} onChange={e => set종목명(e.target.value)}
            placeholder="예: TIGER 미국나스닥100" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>티커유형</label>
          <select value={티커유형} onChange={e => set티커유형(e.target.value)} style={inputStyle}>
            {['국내(GOOGLEFINANCE)', '해외(GOOGLEFINANCE)', '네이버', '수기입력'].map(o =>
              <option key={o} value={o}>{o}</option>
            )}
          </select>
        </div>
        {티커유형 !== '수기입력' ? (
          <div>
            <label style={labelStyle}>티커</label>
            <input type="text" value={티커} onChange={e => set티커(e.target.value)}
              placeholder="예: KRX:360750" style={inputStyle} />
          </div>
        ) : (
          <div>
            <label style={labelStyle}>현재가</label>
            <input type="number" value={현재가수기} onChange={e => set현재가수기(e.target.value)}
              placeholder="0" style={inputStyle} />
          </div>
        )}
        <div>
          <label style={labelStyle}>매수단가</label>
          <input type="number" value={매수단가} onChange={e => set매수단가(e.target.value)}
            placeholder="0" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>수량</label>
          <input type="number" value={수량} onChange={e => set수량(e.target.value)}
            placeholder="0" style={inputStyle} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{
          padding: '6px 14px', borderRadius: 6, border: '1px solid #2A2F3E',
          background: 'transparent', color: '#6B7280', cursor: 'pointer', fontSize: 11,
          fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
        }}>취소</button>
        <button onClick={handleSubmit} disabled={notReady} style={{
          padding: '6px 14px', borderRadius: 6, border: 'none',
          background: notReady ? '#2A2F3E' : '#3B82F6',
          color: '#fff', cursor: notReady ? 'not-allowed' : 'pointer',
          fontSize: 11, fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
        }}>
          {saving ? '저장 중...' : success ? '저장됨 ✓' : rowMap === null ? '로딩...' : '저장'}
        </button>
      </div>
    </div>
  );
}

// ── 앱 ────────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [acctKey, setAcctKey] = useState("위탁");
  const [accounts, setAccounts] = useState(DEFAULT_ACCOUNTS);
  const [monthlyData, setMonthlyData] = useState([]);
  const [dividendData, setDividendData] = useState([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showDeleteMode, setShowDeleteMode] = useState(false);
  const [selectedToDelete, setSelectedToDelete] = useState(new Set());
  const [editingHolding, setEditingHolding] = useState(null);
  const [editPrice, setEditPrice] = useState('');
  const [editQty, setEditQty] = useState('');
  const [editCurrentPrice, setEditCurrentPrice] = useState('');
  const [editIncludeSavings, setEditIncludeSavings] = useState(false);
  const [editingAllTargets, setEditingAllTargets] = useState(false);
  const [allTargetInputs, setAllTargetInputs] = useState([]);
  const lpRef = useRef(null);
  const [monthlyRow, setMonthlyRow] = useState(null);
  const monthlyRowRef = useRef(null);
  const lastBalanceSyncRef = useRef(null);
  const isBalanceWritingRef = useRef(false);
  const [balanceSyncMsg, setBalanceSyncMsg] = useState('');
  const [prevDayEval, setPrevDayEval] = useState(() => {
    const today = new Date().toISOString().slice(0, 10);
    const history = JSON.parse(localStorage.getItem('banana_eval_history') || '{}');
    const prevDate = Object.keys(history).filter(d => d < today).sort().pop();
    return prevDate ? history[prevDate] : null;
  });
  const [showSavings, setShowSavings] = useState(false);
  const [showSavingsEdit, setShowSavingsEdit] = useState(false);
  const [savingsEditValue, setSavingsEditValue] = useState('');
  const savingsLpRef = useRef(null);
  const savingsLpFiredRef = useRef(false);
  const [divYear, setDivYear] = useState('전체');
  const [selectedDivKey, setSelectedDivKey] = useState(null);
  const [monthYear, setMonthYear] = useState('전체');
  const [tradeRows, setTradeRows] = useState([]);
  const [tradeSyncing, setTradeSyncing] = useState(false);
  const [tradeSyncMsg, setTradeSyncMsg] = useState('');
  const [savingsAppliedRows, setSavingsAppliedRows] = useState(new Set());
  const [savingsMode, setSavingsMode] = useState(false);
  const [tradeEditOpen, setTradeEditOpen] = useState(false);
  const [tradeEditRowIdx, setTradeEditRowIdx] = useState(null);
  const [tradeEditValues, setTradeEditValues] = useState(Array(13).fill(''));
  const [tradeEditBusy, setTradeEditBusy] = useState(false);
  const tradeLpRef = useRef(null);
  const [profitData, setProfitData] = useState([]);
  const [profitYear, setProfitYear] = useState('전체');
  const [selectedProfitKey, setSelectedProfitKey] = useState(null);
  const isMobile = useIsMobile();
  const [evalSelectedMetric, setEvalSelectedMetric] = useState(null);
  const [evalPromptCopied, setEvalPromptCopied] = useState(false);
  const [evaluations, setEvaluations] = useState([]);
  const [evalSelectedIdx, setEvalSelectedIdx] = useState(0);
  const [evalIngestOpen, setEvalIngestOpen] = useState(false);
  const [evalIngestRaw, setEvalIngestRaw] = useState('');
  const [evalIngestParsed, setEvalIngestParsed] = useState(null);
  const [evalIngestMsg, setEvalIngestMsg] = useState('');
  const [evalIngestBusy, setEvalIngestBusy] = useState(false);
  const [noteSelectedStock, setNoteSelectedStock] = useState(null);
  const [noteSellCopied, setNoteSellCopied] = useState(false);
  const [evalQueue, setEvalQueue] = useState({ entries: [], counts: { pending: 0, processing: 0, done: 0, error: 0 } });
  const [evalQueueOpen, setEvalQueueOpen] = useState(false);
  const [evalQueueName, setEvalQueueName] = useState('');
  const [evalQueueMarket, setEvalQueueMarket] = useState('KR');
  const [evalQueueMemo, setEvalQueueMemo] = useState('');
  const [evalQueueBusy, setEvalQueueBusy] = useState(false);
  const [evalQueueMsg, setEvalQueueMsg] = useState('');

  const onData = useCallback(({ accounts: a, monthly: m, dividends: d, monthlyRow: mr, profits: p, evaluations: ev, evalQueue: q }) => {
    setAccounts(prev => ({ ...prev, ...a }));
    setMonthlyData(m || []);
    setDividendData(d || []);
    setProfitData(p || []);
    monthlyRowRef.current = mr ?? null;
    setMonthlyRow(mr ?? null);
    setEvaluations(ev || []);
    setEvalSelectedIdx(0);
    if (q) setEvalQueue(q);
  }, []);

  const sheets = useGoogleSheets(onData);

  // ── 평가 카드 JSON 파싱·적재 ────────────────────────────────────────────
  const tryParseEvalJson = useCallback((raw) => {
    if (!raw || !raw.trim()) return { ok: false, error: '입력이 비어있습니다.' };
    // ```json ... ``` 펜스 우선 추출
    const fence = raw.match(/```json\s*([\s\S]*?)\s*```/i) || raw.match(/```\s*([\s\S]*?)\s*```/);
    let candidate = fence ? fence[1] : raw;
    // 가장 바깥 { ... } 추출
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first < 0 || last < 0 || last < first) return { ok: false, error: 'JSON 블록을 찾지 못했습니다.' };
    candidate = candidate.slice(first, last + 1);
    try {
      const obj = JSON.parse(candidate);
      const required = ['date', 'name', 'conclusion'];
      const missing = required.filter(k => !obj[k]);
      if (missing.length) return { ok: false, error: `필수 필드 누락: ${missing.join(', ')}` };
      const grades = obj.grades || {};
      return { ok: true, data: {
        date:       String(obj.date ?? ''),
        name:       String(obj.name ?? ''),
        ticker:     String(obj.ticker ?? ''),
        market:     String(obj.market ?? ''),
        conclusion: String(obj.conclusion ?? ''),
        grades: {
          수익성:     String(grades.수익성 ?? ''),
          안정성:     String(grades.안정성 ?? ''),
          밸류에이션: String(grades.밸류에이션 ?? ''),
          현금흐름:   String(grades.현금흐름 ?? ''),
          모멘텀:     String(grades.모멘텀 ?? ''),
        },
        reasons:    Array.isArray(obj.reasons) ? obj.reasons.map(String) : [],
        risks:      Array.isArray(obj.risks)   ? obj.risks.map(String)   : [],
        actions:    Array.isArray(obj.actions) ? obj.actions.map(String) : [],
        frankMemo:  String(obj.frankMemo ?? ''),
        status:     String(obj.status ?? '보류'),
        buyDate:    String(obj.buyDate ?? ''),
        buyPrice:   String(obj.buyPrice ?? ''),
        targetTerm: String(obj.targetTerm ?? ''),
        targetRet:  String(obj.targetRet ?? ''),
        aiNote:     String(obj.aiNote ?? ''),
        axisItems:  obj.axisItems && typeof obj.axisItems === 'object' ? obj.axisItems : null,
      }};
    } catch (e) {
      return { ok: false, error: `JSON 파싱 실패: ${e.message}` };
    }
  }, []);

  const buildEvalRow = useCallback((d) => {
    const joinNumbered = (arr) => (arr || []).map((s, i) => `${i + 1}) ${s}`).join(' ');
    return [
      d.date, d.name, d.ticker, d.market,
      d.conclusion,
      d.grades.수익성, d.grades.안정성, d.grades.밸류에이션, d.grades.현금흐름, d.grades.모멘텀,
      joinNumbered(d.reasons),
      joinNumbered(d.risks),
      joinNumbered(d.actions),
      d.frankMemo,
      d.status,
      d.buyDate, d.buyPrice,
      d.targetTerm, d.targetRet,
      d.aiNote,
      d.axisItems ? JSON.stringify(d.axisItems) : '',
    ];
  }, []);

  // 매도 평가 프롬프트 빌더 — 종목 정보 + 최초 매수 카드를 채워 sell-evaluation.md §2 입력 컨트랙트로 변환
  const buildSellEvalPrompt = useCallback((stock, earliestEval, position) => {
    const e = earliestEval;
    const reasonLines = (e?.reasons || []).slice(0, 3).map((r, i) => `근거 ${i + 1}: ${r}`).join('\n');
    const riskLines   = (e?.risks   || []).slice(0, 2).map((r, i) => `리스크 ${i + 1}: ${r}`).join('\n');
    return `[매도 평가 요청]
종목: ${stock.name}${stock.ticker ? ` (${stock.ticker})` : ''}
시장: ${stock.market || (/^[0-9]{6}$/.test(stock.ticker || '') ? 'KR' : 'US')}
트리거: 수동 요청 (banana-portfolio 노트 탭)

[최초 매수 카드]
${e ? `일자: ${e.date}
결론: ${e.conclusion?.raw || '—'}
${reasonLines || '(근거 미기록)'}
${riskLines || ''}` : '(최초 매수 카드 없음 — 시트 종목투자노트에 평가 기록부터 필요)'}

[현재 보유]
보유수량: ${position.qty}주
평균단가: ₩${Math.round(position.avgPrice).toLocaleString('ko-KR')}
평가금: ₩${Math.round(position.evalSum).toLocaleString('ko-KR')}
수익률: ${position.rate >= 0 ? '+' : ''}${position.rate.toFixed(1)}%
계좌: ${position.accounts.map(a => a.acct).join(' / ')}

다음 플레이북에 따라 매도 평가 카드를 생성해줘:
- 단일 출처: Trading Agent/playbooks/sell-evaluation.md
- 출력 양식: §5 표준 카드 (최초 ↔ 현재 ↔ 근거 점검 ↔ 리스크 점검 ↔ 판정 ↔ 권고 4안)
- 4단계 판정: 🟢 유효 / 🟡 약화 / 🔴 훼손 / ⚪ 판단보류
- 데이터 재산출: KR=OpenDart MCP, US=UsStockInfo MCP (active-evaluation.md §3 동일 5축)
- 모든 수치 출처/기준일 표기, 누락 항목은 '데이터 부족'으로 명시
- 분할 매도 시나리오 최소 3안 (CLAUDE.md §3 분할 매도 원칙)
- 다음 재평가 시점 명시

마지막에 반드시 \`\`\`json ... \`\`\` 펜스로 20필드 JSON 출력 (적재용):

\`\`\`json
{
  "date": "YYYY-MM-DD",
  "name": "${stock.name}",
  "ticker": "${stock.ticker || ''}",
  "market": "${stock.market || ''}",
  "conclusion": "🟢 유효 | 🟡 약화 | 🔴 훼손 | ⚪ 판단보류",
  "grades": { "수익성":"", "안정성":"", "밸류에이션":"", "현금흐름":"", "모멘텀":"" },
  "reasons": ["현 시점 유지 정당화 또는 유지 어려움 근거"],
  "risks": ["현 시점 추가/해소된 리스크"],
  "actions": ["권고 시나리오 4안 요약"],
  "frankMemo": "",
  "status": "매도 | 보류",
  "buyDate": "${e?.buyDate || ''}",
  "buyPrice": "${e?.buyPrice || ''}",
  "targetTerm": "${e?.targetTerm || ''}",
  "targetRet": "${e?.targetRet || ''}",
  "aiNote": "한 줄 요약 (예: 'PER 회복으로 매력 일부 소진, 펀더멘털은 강화')"
}
\`\`\``;
  }, []);

  const submitEvalQueue = useCallback(async () => {
    const name = evalQueueName.trim();
    if (!name) { setEvalQueueMsg('⚠️ 종목명을 입력해주세요.'); return; }
    setEvalQueueBusy(true);
    setEvalQueueMsg('큐에 추가 중...');
    try {
      const requestedAt = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const row = [requestedAt, name, evalQueueMarket, '대기', '', evalQueueMemo.trim()];
      await sheets.appendValues('평가요청!A2:F', [row]);
      setEvalQueueMsg('✓ 큐에 추가됨');
      setTimeout(() => {
        setEvalQueueOpen(false);
        setEvalQueueName('');
        setEvalQueueMemo('');
        setEvalQueueMsg('');
      }, 1500);
    } catch (e) {
      setEvalQueueMsg(`큐 추가 실패: ${e.message || e}`);
    } finally {
      setEvalQueueBusy(false);
    }
  }, [evalQueueName, evalQueueMarket, evalQueueMemo, sheets]);

  const ingestEvaluation = useCallback(async () => {
    if (!evalIngestParsed) return;
    setEvalIngestBusy(true);
    setEvalIngestMsg('적재 중...');
    try {
      const row = buildEvalRow(evalIngestParsed);
      await sheets.appendValues('종목투자노트!A2:U', [row]);
      setEvalIngestMsg('✓ 적재 완료 — 카드 갱신됨');
      setTimeout(() => {
        setEvalIngestOpen(false);
        setEvalIngestRaw('');
        setEvalIngestParsed(null);
        setEvalIngestMsg('');
      }, 1200);
    } catch (e) {
      setEvalIngestMsg(`적재 실패: ${e.message || e}`);
    } finally {
      setEvalIngestBusy(false);
    }
  }, [evalIngestParsed, buildEvalRow, sheets]);

  const totalEval = Object.values(accounts).reduce((s, a) => s + a.total_eval, 0);

  // 어제 대비 평가금 추적
  useEffect(() => {
    if (sheets.sync !== 'synced' || totalEval === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const history = JSON.parse(localStorage.getItem('banana_eval_history') || '{}');
    const prevDate = Object.keys(history).filter(d => d < today).sort().pop();
    setPrevDayEval(prevDate ? history[prevDate] : null);
    history[today] = totalEval;
    const dates = Object.keys(history).sort();
    while (dates.length > 7) delete history[dates.shift()];
    localStorage.setItem('banana_eval_history', JSON.stringify(history));
  }, [sheets.sync, totalEval]); // eslint-disable-line react-hooks/exhaustive-deps

  // 잔고 자동 동기화 — write 후 re-fetch 하여 월별 그래프도 즉시 갱신
  useEffect(() => {
    if (isBalanceWritingRef.current) return;
    if (sheets.sync !== 'synced' || !sheets.lastSync) return;
    if (lastBalanceSyncRef.current === sheets.lastSync) return;
    lastBalanceSyncRef.current = sheets.lastSync;
    const mr = monthlyRowRef.current;
    if (!mr) {
      setBalanceSyncMsg('이번 달 행 없음');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    isBalanceWritingRef.current = true;
    const _isa = accounts['ISA']?.total_eval ?? 0;
    const _위탁 = accounts['위탁']?.total_eval ?? 0;
    const _연금 = accounts['연금저축']?.total_eval ?? 0;
    const _irp = accounts['IRP']?.total_eval ?? 0;
    sheets.writeRange(`월별잔고!D${mr}:H${mr}`, [
      _isa, _위탁, _연금, _irp, _isa + _위탁 + _연금 + _irp,
    ]).then(async () => {
      await sheets.fetch();
      // fetch 완료 후 lastSyncRef.current = t2 → 다음 effect 실행 시 중복 write 방지
      lastBalanceSyncRef.current = sheets.lastSyncRef.current;
      setBalanceSyncMsg('잔고 동기화됨');
      setTimeout(() => setBalanceSyncMsg(''), 3000);
    }).catch(() => {
      setBalanceSyncMsg('잔고 동기화 실패');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
    }).finally(() => {
      isBalanceWritingRef.current = false;
    });
  }, [sheets.sync, sheets.lastSync, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDeleteSelected = async () => {
    const ranges = [...selectedToDelete].map(idx => {
      const sheetRow = START_ROWS[acctKey] + acct.holdings[idx].rowOffset;
      return `${acctKey}!B${sheetRow}:I${sheetRow}`;
    });
    await sheets.clearRows(ranges);
    setShowDeleteMode(false);
    setSelectedToDelete(new Set());
  };

  const startLP = (origIdx, h) => {
    lpRef.current = setTimeout(async () => {
      const sheetRow = START_ROWS[acctKey] + h.rowOffset;
      let isManual = false;
      try {
        const vals = await sheets.readRange(`${acctKey}!F${sheetRow}`, 'FORMULA');
        const cell = String(vals[0]?.[0] ?? '');
        isManual = cell !== '' && !cell.startsWith('=');
      } catch {}
      setEditingHolding({ origIdx, sheetRow, oldPrice: h.price, oldQty: h.qty, isManual });
      setEditPrice(String(h.price || ''));
      setEditQty(String(h.qty || ''));
      setEditCurrentPrice(String(isManual ? (h.currentPrice || '') : ''));
      setEditIncludeSavings(false);
    }, 1000);
  };

  const endLP = () => {
    if (lpRef.current) { clearTimeout(lpRef.current); lpRef.current = null; }
  };

  const saveEdit = async () => {
    if (!editingHolding) return;
    const { sheetRow, oldPrice, oldQty, isManual } = editingHolding;
    const p = parseFloat(editPrice) || 0;
    const q = parseFloat(editQty) || 0;
    await sheets.appendRow(`${acctKey}!C${sheetRow}:D${sheetRow}`, [p, q]);
    if (isManual && editCurrentPrice !== '') {
      await sheets.writeRange(`${acctKey}!F${sheetRow}`, [parseFloat(editCurrentPrice) || 0]);
    }
    if (editIncludeSavings) {
      const mr = monthlyRowRef.current;
      if (!mr) {
        setBalanceSyncMsg('이번 달 행 없음 — 저축금 미반영');
        setTimeout(() => setBalanceSyncMsg(''), 4000);
      } else {
        try {
          const delta = (p * q) - ((oldPrice || 0) * (oldQty || 0));
          if (delta !== 0) {
            const rows = await sheets.readRange(`월별잔고!C${mr}:C${mr}`);
            const current = parseNum(rows[0]?.[0]);
            await sheets.writeRange(`월별잔고!C${mr}:C${mr}`, [current + delta]);
            setBalanceSyncMsg('저축금 반영됨');
            setTimeout(() => setBalanceSyncMsg(''), 3000);
          }
        } catch {
          setBalanceSyncMsg('저축금 업데이트 실패');
          setTimeout(() => setBalanceSyncMsg(''), 4000);
        }
      }
    }
    setEditingHolding(null);
    setEditIncludeSavings(false);
  };

  const repairFormulas = useCallback(async () => {
    setTradeSyncMsg('수식 복구 중...');
    try {
      for (const key of ['ISA', '위탁', '연금저축', 'IRP']) {
        const rows = await sheets.readRange(`${key}!B2:B60`);
        for (let r = 0; r < rows.length; r++) {
          if (!String(rows[r]?.[0] ?? '').trim()) continue;
          const n = 2 + r;
          await sheets.writeRange(`${key}!E${n}:E${n}`, [`=C${n}*D${n}`]);
          await sheets.writeRange(`${key}!G${n}:G${n}`, [`=H${n}-E${n}`]);
          await sheets.writeRange(`${key}!H${n}:H${n}`, [`=D${n}*F${n}`]);
          await sheets.writeRange(`${key}!I${n}:I${n}`, [`=H${n}/E${n}-1`]);
        }
      }
      setTradeSyncMsg('수식 복구 완료');
      setTimeout(() => setTradeSyncMsg(''), 3000);
      await sheets.fetch();
    } catch (e) {
      console.error('수식 복구 오류:', e);
      setTradeSyncMsg('수식 복구 오류');
      setTimeout(() => setTradeSyncMsg(''), 4000);
    }
  }, [sheets]);

  const addHoldingFromTrade = useCallback(async (acctKey, assetType, stockName, price, qty, currentPrice) => {
    const cfg = KL_CFG[acctKey];
    if (!cfg) throw new Error(`알 수 없는 계좌: ${acctKey}`);
    const rows = await sheets.readRange(cfg.range);
    const rowMap = buildRowMap(rows, cfg.start, cfg.end);
    let targetRow = null;
    for (const r of rowMap) {
      if (r.type === assetType && r.empty && r.hasA) { targetRow = r.row; break; }
    }
    if (targetRow === null) throw new Error(`${acctKey} > ${assetType}: 빈 행 없음`);
    const n = targetRow;
    await sheets.writeRange(`${acctKey}!B${n}:I${n}`, [
      stockName, price, qty,
      `=C${n}*D${n}`,
      currentPrice,
      `=H${n}-E${n}`,
      `=D${n}*F${n}`,
      `=H${n}/E${n}-1`,
    ]);
  }, [sheets]);

  const syncTradeExecutions = useCallback(async () => {
    if (tradeSyncing) return;
    setTradeSyncing(true);
    setTradeSyncMsg('동기화 중...');
    try {
      const tradeValues = await sheets.readRange('체결내역!A2:M');
      const tradeJFormulas = await sheets.readRange('체결내역!J2:J', 'FORMULA');
      const flags = await sheets.readTradeProcessedFlags();

      const rowsWithStatus = tradeValues.map((row, i) => ({ row, processed: flags[i] ?? false }));
      setTradeRows(rowsWithStatus);

      const toProcess = rowsWithStatus
        .map(({ row, processed }, i) => ({ row, i, processed }))
        .filter(({ row, processed }) => {
          if (processed) return false;
          if (row.length < 13) return false;
          return row.slice(0, 13).every(cell => String(cell ?? '').trim() !== '');
        });

      if (toProcess.length === 0) {
        setTradeSyncMsg(tradeValues.length > 0 ? '처리할 신규 내역 없음' : '체결내역 없음');
        setTimeout(() => setTradeSyncMsg(''), 3000);
        return;
      }

      const cheolSheetId = await sheets.getSheetId('체결내역');
      let processed = 0;
      const errors = [];

      for (const { row, i } of toProcess) {
        try {
          const buySell   = String(row[1] ?? '').trim(); // B
          const account   = String(row[2] ?? '').trim(); // C
          const assetType = String(row[4] ?? '').trim(); // E
          const stockName = String(row[5] ?? '').trim(); // F
          const price     = parseNum(row[6]);             // G
          const qty       = parseNum(row[7]);             // H
          const jFormula  = String(tradeJFormulas[i]?.[0] ?? '').trim();
          const currentPrice = jFormula.startsWith('=') ? jFormula : parseNum(row[9]); // J (formula or number)

          if (!account || !stockName) continue;

          const acctKey = ['ISA', '위탁', '연금저축', 'IRP'].find(k => account.includes(k));
          if (!acctKey) continue;

          const holdingRows = await sheets.readRange(`${acctKey}!A2:D60`);
          let matchRow = null;
          let lastType = '';
          for (let r = 0; r < holdingRows.length; r++) {
            const hr = holdingRows[r];
            const typeVal = String(hr[0] ?? '').trim();
            if (typeVal) lastType = typeVal;
            if (String(hr[1] ?? '').trim() === stockName) {
              matchRow = { row: 2 + r, type: lastType, price: parseNum(hr[2]), qty: parseNum(hr[3]) };
              break;
            }
          }

          const isBuy  = buySell.includes('매수');
          const isSell = buySell.includes('매도');

          if (isBuy) {
            if (matchRow) {
              const newQty = matchRow.qty + qty;
              const newAvgPrice = newQty > 0
                ? Math.round((matchRow.price * matchRow.qty + price * qty) / newQty)
                : price;
              await sheets.writeRange(`${acctKey}!C${matchRow.row}:D${matchRow.row}`, [newAvgPrice, newQty]);
            } else {
              await addHoldingFromTrade(acctKey, assetType, stockName, price, qty, currentPrice);
            }
          } else if (isSell && matchRow) {
            const avgBuyPrice = matchRow.price; // 매도 전 평균매수단가 보존
            const newQty = matchRow.qty - qty;
            if (newQty <= 0) {
              await sheets.clearRowsRaw([`${acctKey}!B${matchRow.row}:I${matchRow.row}`]);
            } else {
              await sheets.writeRange(`${acctKey}!D${matchRow.row}`, [newQty]);
            }
            // 수익금 시트에 매도 내역 기록
            const profitRows = await sheets.readRange('수익금!A2:A');
            const nextRow = (profitRows?.length ?? 0) + 2;
            const dateStr = String(row[0] ?? '').trim();
            await sheets.writeRange(`수익금!A${nextRow}:F${nextRow}`, [
              dateStr, stockName, qty, avgBuyPrice, price,
              `=(E${nextRow}-D${nextRow})*C${nextRow}`,
            ]);
          } else if (isSell && !matchRow) {
            errors.push(`${stockName}: 계좌(${acctKey})에서 종목을 찾을 수 없음 — 처리 건너뜀`);
            continue; // 완료 마킹 스킵
          }

          if (cheolSheetId !== null) {
            await sheets.markTradeProcessed(cheolSheetId, i + 1); // row2 → 0-based index 1
          }
          processed++;
        } catch (e) {
          errors.push(String(e?.message ?? e));
        }
      }

      await sheets.fetch();

      const newValues = await sheets.readRange('체결내역!A2:M');
      const newFlags  = await sheets.readTradeProcessedFlags();
      setTradeRows(newValues.map((row, i) => ({ row, processed: newFlags[i] ?? false })));

      setTradeSyncMsg(errors.length > 0
        ? `${processed}건 완료 · ${errors.length}건 오류`
        : `${processed}건 동기화 완료`);
      setTimeout(() => setTradeSyncMsg(''), 5000);
    } catch (e) {
      console.error('체결내역 동기화 오류:', e);
      setTradeSyncMsg('동기화 오류');
      setTimeout(() => setTradeSyncMsg(''), 4000);
    } finally {
      setTradeSyncing(false);
    }
  }, [sheets, tradeSyncing, addHoldingFromTrade]);

  const saveTradeEdit = useCallback(async () => {
    if (tradeEditRowIdx === null) return;
    setTradeEditBusy(true);
    try {
      const n = tradeEditRowIdx + 2; // 시트 행 번호 (A2 기준)
      await sheets.writeRange(`체결내역!A${n}:M${n}`, tradeEditValues);
      const newValues = await sheets.readRange('체결내역!A2:M');
      const newFlags  = await sheets.readTradeProcessedFlags();
      setTradeRows(newValues.map((row, i) => ({ row, processed: newFlags[i] ?? false })));
      setTradeEditOpen(false);
      setTradeEditRowIdx(null);
      setTradeSyncMsg('셀 업데이트 완료');
      setTimeout(() => setTradeSyncMsg(''), 3000);
    } catch (e) {
      setTradeSyncMsg(`저장 실패: ${e.message}`);
      setTimeout(() => setTradeSyncMsg(''), 4000);
    } finally {
      setTradeEditBusy(false);
    }
  }, [sheets, tradeEditRowIdx, tradeEditValues]);

  const applySavingsFromTrade = useCallback(async (tradeDate, amount, isBuy, rowIdx) => {
    setTradeSyncMsg('저축금 반영 중...');
    try {
      const parts = tradeDate.split('-');
      if (parts.length < 2) throw new Error('날짜 형식 오류');
      const year = parseInt(parts[0]);
      const month = parseInt(parts[1]);

      const values = await sheets.readRange('월별잔고!A2:H');
      let lastYear = 0;
      let targetRow = null;
      for (let i = 0; i < values.length; i++) {
        const r = values[i];
        const bNum = parseInt(String(r[0] ?? '').replace(/[^0-9]/g, ''));
        if (bNum >= 2000) lastYear = bNum;
        const mNum = parseInt(String(r[1] ?? '').replace(/[^0-9]/g, ''));
        if (lastYear === year && mNum === month) { targetRow = 2 + i; break; }
      }
      if (!targetRow) throw new Error(`${year}년 ${month}월 행 없음`);

      const rows = await sheets.readRange(`월별잔고!C${targetRow}:C${targetRow}`);
      const current = parseNum(rows[0]?.[0]);
      const delta = isBuy ? amount : -amount;
      await sheets.writeRange(`월별잔고!C${targetRow}:C${targetRow}`, [current + delta]);

      setSavingsAppliedRows(prev => new Set([...prev, rowIdx]));
      setTradeSyncMsg(`${year}.${String(month).padStart(2,'0')} 저축금 ${isBuy ? '+' : '−'}₩${amount.toLocaleString()} 반영됨`);
      setTimeout(() => setTradeSyncMsg(''), 4000);
    } catch (e) {
      setTradeSyncMsg(`저축금 반영 실패: ${e.message}`);
      setTimeout(() => setTradeSyncMsg(''), 4000);
    }
  }, [sheets]);

  const saveAllTargets = async () => {
    const sum = allTargetInputs.reduce((s, v) => s + (parseFloat(v) || 0), 0);
    if (Math.abs(sum - 100) > 0.1) {
      alert(`합계가 ${sum.toFixed(1)}%입니다. 100%가 되어야 합니다.`);
      return;
    }
    setEditingAllTargets(false);
    const startRow = REBAL_TARGET_START[acctKey];
    await sheets.writeRangeMulti(
      `자산분배!B${startRow}:B${startRow + allTargetInputs.length - 1}`,
      allTargetInputs.map(v => [(parseFloat(v) || 0) / 100])
    );
    await sheets.fetch();
  };

  const startSavingsLP = () => {
    savingsLpFiredRef.current = false;
    savingsLpRef.current = setTimeout(async () => {
      savingsLpFiredRef.current = true;
      const mr = monthlyRowRef.current;
      if (!mr) {
        setBalanceSyncMsg('이번 달 행 없음');
        setTimeout(() => setBalanceSyncMsg(''), 3000);
        return;
      }
      try {
        const rows = await sheets.readRange(`월별잔고!C${mr}:C${mr}`);
        setSavingsEditValue(String(parseNum(rows[0]?.[0]) || ''));
      } catch {
        setSavingsEditValue('');
      }
      setShowSavingsEdit(true);
    }, 1000);
  };

  const endSavingsLP = () => {
    if (savingsLpRef.current) { clearTimeout(savingsLpRef.current); savingsLpRef.current = null; }
  };

  const saveSavingsEdit = async () => {
    const mr = monthlyRowRef.current;
    if (!mr) {
      setBalanceSyncMsg('이번 달 행 없음');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      setShowSavingsEdit(false);
      return;
    }
    try {
      await sheets.writeRange(`월별잔고!C${mr}:C${mr}`, [parseFloat(savingsEditValue) || 0]);
      setBalanceSyncMsg('저축금 저장됨');
      setTimeout(() => setBalanceSyncMsg(''), 3000);
    } catch {
      setBalanceSyncMsg('저축금 저장 실패');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
    }
    setShowSavingsEdit(false);
  };

  useEffect(() => {
    if (tab === '체결내역' && sheets.auth === 'signed-in') {
      syncTradeExecutions();
    }
  }, [tab, sheets.auth]); // eslint-disable-line

  const acct = accounts[acctKey];
  const totalInvest = Object.values(accounts).reduce((s, a) => s + a.total_invest, 0);
  const totalProfit = totalEval - totalInvest;
  const dailyDelta = sheets.auth === 'signed-in' && prevDayEval != null ? totalEval - prevDayEval : null;

  const syncLabel =
    sheets.sync === 'syncing' ? '동기화 중...' :
    sheets.sync === 'error'   ? '동기화 실패' :
    sheets.lastSync           ? `↑ ${sheets.lastSync.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` :
    '';

  const sheetBtnStyle = {
    padding: "3px 8px", borderRadius: 4,
    border: "1px solid #2A2F3E", background: "transparent",
    color: "#9CA3AF", cursor: "pointer",
    fontSize: 10, fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
  };

  const baseFont = "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif";

  // 배당금 탭 필터링
  const divYears = ['전체', ...[...new Set(dividendData.map(d => String(d.year)))].sort()];
  const filteredDividends = divYear === '전체'
    ? dividendData
    : dividendData.filter(d => String(d.year) === divYear);

  return (
    <div style={{
      minHeight: "100vh", background: "#0D0F14", color: "#E8EAF0",
      fontFamily: baseFont, padding: 0,
    }}>
      {/* ── 헤더 ── */}
      <div style={{
        background: "linear-gradient(135deg, #1A1D26 0%, #0D1520 100%)",
        borderBottom: "1px solid #2A2F3E",
        padding: isMobile ? "14px 16px 12px" : "20px 24px 16px",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0, marginRight: 8 }}>
            <div style={{ fontSize: 9, letterSpacing: 3, color: "#5A6478", marginBottom: 4 }}>
              BANANA · 은퇴 준비 포트폴리오
            </div>
            <div style={{ fontSize: isMobile ? 20 : 24, fontWeight: 700, letterSpacing: -1, color: "#F5F7FF" }}>
              ₩{totalEval.toLocaleString()}
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 9, color: "#5A6478", letterSpacing: 2 }}>평가손익</div>
            <div style={{ fontSize: isMobile ? 13 : 15, fontWeight: 700, color: totalProfit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
              ₩{fmt(Math.abs(totalProfit))}
            </div>
            {dailyDelta != null && (
              <div style={{ fontSize: 10, color: dailyDelta >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                ₩{fmt(Math.abs(dailyDelta))}
              </div>
            )}
          </div>
        </div>

        {/* 구글 시트 동기화 UI */}
        {CONFIGURED && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {sheets.auth === 'loading' && (
              <span style={{ fontSize: 10, color: "#5A6478" }}>Google 초기화 중...</span>
            )}
            {sheets.auth === 'signed-out' && (
              <button onClick={sheets.signIn}
                style={{ ...sheetBtnStyle, background: "#1E3A5F", color: "#60A5FA", borderColor: "#3B82F6" }}>
                로그인
              </button>
            )}
            {sheets.auth === 'signed-in' && (
              <>
                <span style={{ fontSize: 10, color: sheets.sync === 'error' ? "#F87171" : "#5A6478" }}>
                  {syncLabel}
                </span>
                {balanceSyncMsg && (
                  <span style={{ fontSize: 10, color: balanceSyncMsg.includes('실패') || balanceSyncMsg.includes('없음') ? '#F87171' : '#4ADE80' }}>
                    · {balanceSyncMsg}
                  </span>
                )}
                <button onClick={sheets.fetch} disabled={sheets.sync === 'syncing'}
                  style={sheetBtnStyle} title="시트에서 최신 데이터 가져오기">
                  ↻ 새로고침
                </button>
                <button onClick={sheets.signOut} style={{ ...sheetBtnStyle, color: "#F87171" }}>
                  로그아웃
                </button>
              </>
            )}
            {sheets.auth === 'error' && (
              <span style={{ fontSize: 10, color: "#F87171" }}>Google 연결 오류</span>
            )}
          </div>
        )}

        {/* 탭 */}
        <div style={{ display: "flex", gap: 4, marginTop: isMobile ? 10 : 16, flexWrap: "nowrap", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          {[
            { key: "dashboard", label: "홈" },
            { key: "rebalance", label: "자산분배" },
            { key: "holdings", label: "종목" },
            { key: "dividend", label: "배당금" },
            { key: "profit", label: "수익금" },
            { key: "체결내역", label: "체결" },
            { key: "평가", label: "평가" },
            { key: "노트", label: "노트" },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: "10px 10px",
              flexShrink: 0,
              borderRadius: 6, border: "none", cursor: "pointer",
              fontSize: 11, letterSpacing: 1, fontFamily: baseFont,
              background: tab === key ? "#3B82F6" : "#1E2233",
              color: tab === key ? "#fff" : "#6B7280",
              transition: "all 0.2s",
            }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "20px 16px" }}>

        {/* ── 대시보드 탭 ── */}
        {tab === "dashboard" && (
          <div>
            {/* 요약 카드 3개 */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 8, marginBottom: 20,
            }}>
              {[
                { label: "총 투자금", value: `₩${fmt(totalInvest)}`, color: "#9CA3AF" },
                { label: "총 평가금", value: `₩${fmt(totalEval)}`, color: "#F5F7FF" },
                { label: "수익률", value: `${totalProfit >= 0 ? '+' : ''}${totalInvest > 0 ? ((totalProfit / totalInvest) * 100).toFixed(1) : '0.0'}%`, color: totalProfit >= 0 ? PROFIT_POS : PROFIT_NEG },
              ].map((s) => (
                <div key={s.label} style={{
                  background: "#1A1D26", borderRadius: 10, padding: "12px 10px", textAlign: "center",
                }}>
                  <div style={{ fontSize: 9, color: "#5A6478", marginBottom: 4, letterSpacing: 1 }}>{s.label}</div>
                  <div style={{
                    fontSize: isMobile ? 10 : 13, fontWeight: 700, color: s.color,
                    wordBreak: "break-all",
                  }}>
                    {s.value}
                  </div>
                </div>
              ))}
            </div>

            {/* 계좌 카드 그리드 (2열) */}
            <div style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
              gap: 10, marginBottom: 20,
            }}>
              {Object.entries(accounts).map(([k, v]) => {
                const isPos = v.profit >= 0;
                const pRate = v.total_invest > 0
                  ? ((v.profit / v.total_invest) * 100).toFixed(1)
                  : '0.0';
                return (
                  <div key={k} onClick={() => { setAcctKey(k); setTab("holdings"); }}
                    style={{
                      background: "#1A1D26", border: `1px solid ${v.color}33`,
                      borderRadius: 12, padding: "14px 16px",
                      cursor: "pointer", transition: "all 0.2s",
                      boxShadow: `0 0 20px ${v.color}11`,
                    }}>
                    <div style={{ fontSize: 9, letterSpacing: 2, color: v.color, marginBottom: 4 }}>
                      {v.sub.toUpperCase()}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, color: "#F5F7FF" }}>
                          {v.label}
                        </div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: "#F5F7FF", marginBottom: 2 }}>
                          ₩{fmt(v.total_eval)}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 9, color: "#5A6478", marginBottom: 2 }}>수익</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: isPos ? PROFIT_POS : PROFIT_NEG }}>
                          ₩{fmt(v.profit)}
                        </div>
                        <div style={{ fontSize: 11, color: isPos ? PROFIT_POS : PROFIT_NEG }}>
                          {isPos ? '+' : ''}{pRate}%
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 전체 평가금 추이 바차트 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478" }}>전체 평가금 추이</div>
                  <button
                    onClick={() => { if (!savingsLpFiredRef.current) setShowSavings(p => !p); }}
                    onMouseDown={startSavingsLP}
                    onMouseUp={endSavingsLP}
                    onMouseLeave={endSavingsLP}
                    onTouchStart={e => { e.preventDefault(); startSavingsLP(); }}
                    onTouchEnd={endSavingsLP}
                    onTouchCancel={endSavingsLP}
                    onContextMenu={e => e.preventDefault()}
                    style={{
                      padding: '3px 10px', borderRadius: 4,
                      border: `1px solid ${showSavings ? '#10B981' : '#2A2F3E'}`,
                      background: showSavings ? '#0D2B1A' : 'transparent',
                      color: showSavings ? '#10B981' : '#6B7280',
                      cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
                      userSelect: 'none', WebkitUserSelect: 'none',
                    }}
                  >저축금</button>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {['전체', '2025', '2026'].map(y => (
                    <button key={y} onClick={() => setMonthYear(y)} style={{
                      padding: '3px 10px', borderRadius: 4,
                      border: `1px solid ${monthYear === y ? '#3B82F6' : '#2A2F3E'}`,
                      background: monthYear === y ? '#1E3A5F' : 'transparent',
                      color: monthYear === y ? '#60A5FA' : '#6B7280',
                      cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
                    }}>{y}</button>
                  ))}
                </div>
              </div>
              {(() => {
                const data = monthYear === '전체' ? monthlyData : monthlyData.filter(d => String(d.year) === monthYear);
                const chartData = showSavings
                  ? data.map(d => ({ ...d, base: Math.max(0, d.value - (d.savings || 0)), savingsAmt: d.savings || 0 }))
                  : data;
                return data.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={chartData} barSize={isMobile ? 8 : 14}>
                      <XAxis dataKey="label" tick={{ fill: "#5A6478", fontSize: 9 }} axisLine={false} tickLine={false} />
                      <YAxis tickFormatter={v => `${(v / 100000000).toFixed(1)}억`} tick={{ fill: "#5A6478", fontSize: 9 }} width={40} axisLine={false} tickLine={false} />
                      <Tooltip
                        formatter={(v, name) => {
                          if (name === 'base') return [`₩${v.toLocaleString()}`, '잔고'];
                          if (name === 'savingsAmt') return [`₩${v.toLocaleString()}`, '저축금'];
                          return [`₩${v.toLocaleString()}`, '평가금'];
                        }}
                        contentStyle={{ background: "#1E2233", border: "1px solid #2A2F3E", borderRadius: 8, fontSize: 11 }}
                        labelStyle={{ color: '#E8EAF0' }}
                        itemStyle={{ color: '#E8EAF0' }}
                      />
                      {showSavings ? (
                        <>
                          <Bar dataKey="base" stackId="a" fill={CHART_BAR_COLOR} />
                          <Bar dataKey="savingsAmt" stackId="a" fill={CHART_BAR_COLOR} radius={[3, 3, 0, 0]} />
                        </>
                      ) : (
                        <Bar dataKey="value" fill={CHART_BAR_COLOR} radius={[3, 3, 0, 0]} />
                      )}
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5A6478', fontSize: 12 }}>
                    데이터가 없습니다
                  </div>
                );
              })()}
              {showSavingsEdit && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #2A2F3E' }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: '#5A6478', marginBottom: 8 }}>이번 달 저축금 수정</div>
                  <input
                    type="number"
                    value={savingsEditValue}
                    onChange={e => setSavingsEditValue(e.target.value)}
                    style={{
                      width: '100%', boxSizing: 'border-box', marginBottom: 8,
                      background: '#0D1520', border: '1px solid #2A2F3E', borderRadius: 6,
                      color: '#E8EAF0', padding: '6px 10px', fontSize: 12, fontFamily: baseFont,
                    }}
                    placeholder="0"
                  />
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => setShowSavingsEdit(false)} style={{
                      padding: '6px 12px', borderRadius: 6, border: '1px solid #2A2F3E',
                      background: 'transparent', color: '#6B7280', cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
                    }}>취소</button>
                    <button onClick={saveSavingsEdit} style={{
                      padding: '6px 12px', borderRadius: 6, border: 'none',
                      background: '#10B981', color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
                    }}>저장</button>
                  </div>
                </div>
              )}
            </div>

            {/* ── KPI 카드 (TWR · Sharpe · MDD) ── */}
            {(() => {
              const kpi = computeKPI(monthlyData);
              if (!kpi) return null;

              const twrPct  = (kpi.twr  * 100).toFixed(1);
              const mddPct  = (kpi.mdd  * 100).toFixed(1);
              const sharpeV = kpi.sharpe !== null ? kpi.sharpe.toFixed(2) : '–';

              // 상태 판정
              const twrStatus  = kpi.twr >= 0
                ? { icon: '✅', color: '#10B981', label: '양호' }
                : { icon: '🔴', color: '#EF4444', label: '손실' };
              const sharpeStatus = kpi.sharpe === null ? { icon: '–', color: '#6B7280', label: '데이터 부족' }
                : kpi.sharpe >= 0.8 ? { icon: '✅', color: '#10B981', label: '양호' }
                : kpi.sharpe >= 0.5 ? { icon: '⚠️', color: '#F59E0B', label: '주의' }
                : { icon: '🔴', color: '#EF4444', label: '미달' };
              const mddStatus  = kpi.mdd >= -0.25
                ? { icon: '✅', color: '#10B981', label: '이내' }
                : kpi.mdd >= -0.35
                ? { icon: '⚠️', color: '#F59E0B', label: '주의' }
                : { icon: '🔴', color: '#EF4444', label: '초과' };

              const cards = [
                {
                  label: 'TWR (연환산)',
                  value: `${kpi.twr >= 0 ? '+' : ''}${twrPct}%`,
                  sub: `목표 시장+3~5%p · ${kpi.months}개월`,
                  status: twrStatus,
                  metric: 'twr',
                },
                {
                  label: 'Sharpe',
                  value: sharpeV,
                  sub: '목표 0.8~1.2 · 최근 12M',
                  status: sharpeStatus,
                  metric: 'sharpe',
                },
                {
                  label: 'MDD',
                  value: `${mddPct}%`,
                  sub: '목표 −25% 이내',
                  status: mddStatus,
                  metric: 'mdd',
                },
              ];

              return (
                <div style={{ marginTop: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <div style={{ fontSize: 10, letterSpacing: 3, color: '#5A6478' }}>운용 KPI</div>
                    <span style={{ fontSize: 9, color: '#3B82F6' }}>📘 탭하면 용어 설명</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    {cards.map(c => (
                      <button key={c.label}
                        onClick={() => setEvalSelectedMetric(prev => prev === c.metric ? null : c.metric)}
                        style={{
                          background: evalSelectedMetric === c.metric ? '#1E3A5F' : '#1A1D26',
                          borderRadius: 10,
                          padding: '12px 8px', textAlign: 'center',
                          border: `1px solid ${evalSelectedMetric === c.metric ? '#3B82F6' : c.status.color + '22'}`,
                          cursor: 'pointer', fontFamily: 'inherit',
                          width: '100%', display: 'block',
                        }}>
                        <div style={{ fontSize: 8, color: '#5A6478', marginBottom: 4, letterSpacing: 1 }}>
                          {c.label} <span style={{ color: '#3B82F6' }}>📘</span>
                        </div>
                        <div style={{ fontSize: isMobile ? 13 : 15, fontWeight: 700, color: c.status.color, marginBottom: 2 }}>
                          {c.value}
                        </div>
                        <div style={{ fontSize: 9, color: c.status.color, marginBottom: 4 }}>
                          {c.status.icon} {c.status.label}
                        </div>
                        <div style={{ fontSize: 8, color: '#3A4050', lineHeight: 1.3 }}>{c.sub}</div>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* ── 리밸런싱 탭 ── */}
        {tab === "rebalance" && (
          <div>
            {/* 계좌 선택 (4개) */}
            <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
              {Object.keys(accounts).map((k) => (
                <button key={k} onClick={() => setAcctKey(k)} style={{
                  flex: 1, padding: isMobile ? "8px 4px" : "6px 4px",
                  textAlign: 'center',
                  borderRadius: 20,
                  border: `1px solid ${acctKey === k ? accounts[k].color : "#2A2F3E"}`,
                  background: acctKey === k ? `${accounts[k].color}22` : "transparent",
                  color: acctKey === k ? accounts[k].color : "#6B7280",
                  cursor: "pointer", fontSize: 11, fontFamily: baseFont,
                }}>
                  {accounts[k].label}
                </button>
              ))}
            </div>

            {/* 자산군 구성 파이 (최상단) */}
            {acct.assets.some(a => a.eval > 0) && (
              <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 12 }}>자산군 구성</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <ResponsiveContainer width="100%" height={160}>
                      <PieChart>
                        <Pie
                          data={acct.assets.filter(a => a.eval > 0).map(a => ({ name: a.name, value: a.eval }))}
                          cx="50%" cy="50%" innerRadius={40} outerRadius={65} dataKey="value" paddingAngle={3}>
                          {acct.assets.filter(a => a.eval > 0).map((a, i) => (
                            <Cell key={i} fill={COLORS[a.name] || "#aaa"} stroke="#0D0F14" strokeWidth={2} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(v) => `₩${v.toLocaleString()}`}
                          contentStyle={{ background: "#1E2233", border: "1px solid #2A2F3E", borderRadius: 8, fontSize: 11 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ width: 120, flexShrink: 0 }}>
                    {acct.assets.filter(a => a.eval > 0).map(a => (
                      <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                        <span style={{ fontSize: 11, color: '#9CA3AF', flex: 1 }}>{a.name}</span>
                        <span style={{ fontSize: 11, color: '#E8EAF0' }}>
                          {acct.total_eval > 0 ? (a.eval / acct.total_eval * 100).toFixed(1) : '0.0'}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* 현재 vs 목표 비중 테이블 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
              <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478" }}>목표 vs 현재 비중</div>
                {sheets.auth === 'signed-in' && (
                  <button
                    onClick={() => { setAllTargetInputs(acct.assets.map(a => String(a.target))); setEditingAllTargets(true); }}
                    style={{ position: 'absolute', right: 0, padding: '4px 8px', borderRadius: 4, border: '1px solid #2A2F3E', background: 'transparent', color: '#5A6478', cursor: 'pointer', fontSize: 13, fontFamily: baseFont, lineHeight: 1 }}
                  >⋯</button>
                )}
              </div>
              {editingAllTargets && (
                <div style={{ marginBottom: 12, background: '#141927', borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 8 }}>목표 비중 수정 — 합계 100%</div>
                  {acct.assets.map((a, i) => (
                    <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                      <span style={{ fontSize: 12, flex: 1, color: '#E8EAF0' }}>{a.name}</span>
                      <input
                        type="number"
                        value={allTargetInputs[i] ?? ''}
                        onChange={e => setAllTargetInputs(prev => { const n = [...prev]; n[i] = e.target.value; return n; })}
                        style={{ width: 60, padding: '3px 6px', borderRadius: 4, border: '1px solid #3B82F6', background: '#0D1520', color: '#E8EAF0', fontSize: 12, textAlign: 'right', fontFamily: baseFont, outline: 'none' }}
                      />
                      <span style={{ fontSize: 11, color: '#5A6478' }}>%</span>
                    </div>
                  ))}
                  <div style={{ fontSize: 11, marginBottom: 8, color: (() => { const s = allTargetInputs.reduce((acc, v) => acc + (parseFloat(v)||0), 0); return Math.abs(s-100) < 0.1 ? '#4ADE80' : '#F87171'; })() }}>
                    합계: {allTargetInputs.reduce((acc, v) => acc + (parseFloat(v)||0), 0).toFixed(1)}%
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => setEditingAllTargets(false)} style={{ padding: '5px 12px', borderRadius: 5, border: '1px solid #2A2F3E', background: 'transparent', color: '#6B7280', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>취소</button>
                    <button onClick={saveAllTargets} style={{ padding: '5px 12px', borderRadius: 5, border: 'none', background: '#3B82F6', color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>저장</button>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', marginBottom: 4 }}>
                <div style={{ flex: 1, fontSize: 10, color: '#5A6478', textAlign: 'center' }}>자산군</div>
                <div style={{ width: 60, textAlign: 'center', fontSize: 10, color: '#5A6478' }}>목표%</div>
                <div style={{ width: 50, textAlign: 'center', fontSize: 10, color: '#5A6478' }}>현재%</div>
                <div style={{ width: 60, textAlign: 'center', fontSize: 10, color: '#5A6478' }}>차이</div>
              </div>
              {acct.assets.map((a) => {
                const curr = a.sheetCurrent ?? a.ratio;
                const diff = parseFloat((curr - a.target).toFixed(1));
                const highlight = Math.abs(diff) >= 5;
                return (
                  <div key={a.name} style={{
                    display: 'flex', alignItems: 'center', padding: '7px 8px',
                    borderRadius: 6, marginBottom: 2,
                    background: highlight ? '#1A2035' : 'transparent',
                    borderLeft: highlight ? `3px solid ${diff > 0 ? PROFIT_POS : PROFIT_NEG}` : '3px solid transparent',
                  }}>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                      <span style={{ fontSize: 12 }}>{a.name}</span>
                    </div>
                    <div style={{ width: 60, textAlign: 'center', fontSize: 12, color: '#9CA3AF' }}>
                      {a.target}%
                    </div>
                    <div style={{ width: 50, textAlign: 'center', fontSize: 12, color: '#E8EAF0' }}>{curr}%</div>
                    <div style={{ width: 60, textAlign: 'right', fontSize: 12, fontWeight: 700,
                      color: diff > 0 ? PROFIT_POS : diff < 0 ? PROFIT_NEG : '#9CA3AF' }}>
                      {diff > 0 ? '+' : ''}{diff}%p
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 리밸런싱 필요 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px" }}>
              <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 12 }}>리밸런싱 필요</div>
              {acct.assets.map((a) => {
                const amt = a.rebalAmt ?? 0;
                const curr = a.sheetCurrent ?? a.ratio;
                const diff = parseFloat((curr - a.target).toFixed(1));
                const highlight = Math.abs(diff) >= 5;
                return (
                  <div key={a.name} style={{
                    display: 'flex', alignItems: 'center', padding: '10px 12px',
                    borderRadius: 6, marginBottom: 4,
                    background: highlight ? '#1A2035' : 'transparent',
                    borderLeft: highlight ? `3px solid ${amt > 0 ? PROFIT_POS : PROFIT_NEG}` : '3px solid transparent',
                  }}>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                      <span style={{ fontSize: 12 }}>{a.name}</span>
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: amt > 0 ? PROFIT_POS : amt < 0 ? PROFIT_NEG : '#9CA3AF' }}>
                      ₩{fmt(amt)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── 종목 탭 ── */}
        {tab === "holdings" && (
          <div>
            {/* 계좌 선택 (4개 모두) */}
            <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
              {Object.keys(accounts).map((k) => (
                <button key={k} onClick={() => { setAcctKey(k); setShowAddForm(false); setEditingHolding(null); }} style={{
                  flex: 1, padding: isMobile ? "8px 4px" : "6px 4px",
                  textAlign: 'center',
                  borderRadius: 20,
                  border: `1px solid ${acctKey === k ? accounts[k].color : "#2A2F3E"}`,
                  background: acctKey === k ? `${accounts[k].color}22` : "transparent",
                  color: acctKey === k ? accounts[k].color : "#6B7280",
                  cursor: "pointer", fontSize: 11, fontFamily: baseFont,
                }}>
                  {accounts[k].label}
                </button>
              ))}
            </div>

            {/* 계좌 요약 카드 */}
            <div style={{
              background: `linear-gradient(135deg, ${acct.color}22, #1A1D26)`,
              border: `1px solid ${acct.color}44`,
              borderRadius: 12, padding: "16px", marginBottom: 16,
            }}>
              <div style={{ fontSize: 10, letterSpacing: 2, color: acct.color, marginBottom: 4 }}>
                {acct.sub.toUpperCase()}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
                <div>
                  <div style={{ fontSize: isMobile ? 16 : 20, fontWeight: 700, color: "#F5F7FF" }}>
                    ₩{fmt(acct.total_eval)}
                  </div>
                  <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>
                    투자금 ₩{fmt(acct.total_invest)}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{
                    fontSize: isMobile ? 13 : 16, fontWeight: 700,
                    color: acct.profit >= 0 ? PROFIT_POS : PROFIT_NEG,
                  }}>
                    ₩{fmt(acct.profit)}
                  </div>
                  <div style={{ fontSize: 11, color: acct.profit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                    {acct.profit >= 0 ? '+' : ''}
                    {acct.total_invest > 0 ? ((acct.profit / acct.total_invest) * 100).toFixed(1) : '0.0'}%
                  </div>
                </div>
              </div>
            </div>

            {/* 종목추가/삭제 버튼 + 폼 */}
            {sheets.auth === 'signed-in' && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 }}>
                  <button onClick={() => { setShowDeleteMode(p => !p); setSelectedToDelete(new Set()); setShowAddForm(false); }} style={{
                    width: 30, height: 30, padding: 0, borderRadius: 6, flexShrink: 0,
                    border: showDeleteMode ? `1px solid ${PROFIT_POS}` : '1px solid #2A2F3E',
                    background: showDeleteMode ? '#2A1A1A' : 'transparent',
                    color: showDeleteMode ? PROFIT_POS : '#6B7280',
                    cursor: 'pointer', fontSize: 16, fontFamily: baseFont,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {showDeleteMode ? '✕' : '−'}
                  </button>
                  <button onClick={() => { setShowAddForm(p => !p); setShowDeleteMode(false); }} style={{
                    width: 30, height: 30, padding: 0, borderRadius: 6, flexShrink: 0,
                    border: showAddForm ? `1px solid ${PROFIT_POS}` : '1px solid #2A2F3E',
                    background: showAddForm ? '#2A1A1A' : 'transparent',
                    color: showAddForm ? PROFIT_POS : '#6B7280',
                    cursor: 'pointer', fontSize: 16, fontFamily: baseFont,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {showAddForm ? '✕' : '+'}
                  </button>
                </div>
                {showAddForm && (
                  <AddHoldingForm
                    acctKey={acctKey}
                    accounts={accounts}
                    readRange={sheets.readRange}
                    insertRowAfter={sheets.insertRowAfter}
                    onSave={async (range, row, investAmount) => {
                      await sheets.appendRow(range, row);
                      const mr = monthlyRowRef.current;
                      if (!mr) {
                        setBalanceSyncMsg('이번 달 행 없음 — 저축금 미반영');
                        setTimeout(() => setBalanceSyncMsg(''), 4000);
                      } else {
                        try {
                          const rows = await sheets.readRange(`월별잔고!C${mr}:C${mr}`);
                          const current = parseNum(rows[0]?.[0]);
                          await sheets.writeRange(`월별잔고!C${mr}:C${mr}`, [current + investAmount]);
                          setBalanceSyncMsg('저축금 반영됨');
                          setTimeout(() => setBalanceSyncMsg(''), 3000);
                        } catch {
                          setBalanceSyncMsg('저축금 업데이트 실패');
                          setTimeout(() => setBalanceSyncMsg(''), 4000);
                        }
                      }
                      setShowAddForm(false);
                    }}
                    onCancel={() => setShowAddForm(false)}
                  />
                )}
              </div>
            )}

            {/* 보유 종목 목록 */}
            <div style={{ background: "#1A1D26", borderRadius: 12, overflow: "hidden" }}>
              {(() => {
                const vis = acct.holdings
                  .map((h, origIdx) => ({ h, origIdx }))
                  .filter(({ h }) => h.invest > 0 && h.eval > 0);
                return (<>
                  <div style={{ padding: "12px 16px", borderBottom: "1px solid #2A2F3E", fontSize: 10, letterSpacing: 3, color: "#5A6478" }}>
                    보유 종목 ({vis.length})
                  </div>
                  {vis.length === 0 && (
                    <div style={{ padding: 24, textAlign: 'center', color: '#5A6478', fontSize: 12 }}>
                      종목이 없습니다
                    </div>
                  )}
                  {vis.map(({ h, origIdx }, vi) => {
                    const color = h.rate >= 0 ? PROFIT_POS : PROFIT_NEG;
                    const typeName = h.type || '';
                    const isEditing = editingHolding?.origIdx === origIdx;
                    const lpHandlers = sheets.auth === 'signed-in' && !showDeleteMode ? {
                      onMouseDown: () => startLP(origIdx, h),
                      onMouseUp: endLP,
                      onMouseLeave: endLP,
                      onTouchStart: (e) => { e.preventDefault(); startLP(origIdx, h); },
                      onTouchEnd: endLP,
                      onTouchCancel: endLP,
                      onContextMenu: (e) => e.preventDefault(),
                    } : {};
                    return (
                    <div key={origIdx} style={{ borderBottom: vi < vis.length - 1 ? "1px solid #1E2233" : "none" }}>
                      <div style={{
                        padding: isMobile ? "10px 16px" : "12px 16px",
                        display: "flex", alignItems: "center", gap: 10,
                        background: isEditing ? '#1A2035' : selectedToDelete.has(origIdx) ? '#1A1520' : 'transparent',
                        userSelect: 'none', WebkitUserSelect: 'none',
                      }} {...lpHandlers}>
                      {showDeleteMode && (
                        <input type="checkbox" checked={selectedToDelete.has(origIdx)}
                          onChange={() => setSelectedToDelete(prev => {
                            const next = new Set(prev);
                            if (next.has(origIdx)) next.delete(origIdx); else next.add(origIdx);
                            return next;
                          })}
                          style={{ marginRight: 2, accentColor: PROFIT_POS, flexShrink: 0 }}
                        />
                      )}
                      {typeName && (
                        <div style={{
                          fontSize: 10,
                          background: (COLORS[typeName] || '#aaa') + '33',
                          color: COLORS[typeName] || '#aaa',
                          padding: '2px 6px', borderRadius: 4, flexShrink: 0, whiteSpace: 'nowrap',
                        }}>
                          {typeName}
                        </div>
                      )}
                      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#E8EAF0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {h.name}
                        </div>
                        <div style={{ fontSize: 10, color: "#5A6478", marginTop: 2 }}>
                          {h.qty}주 · ₩{fmt(h.price)}
                        </div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: isMobile ? 11 : 12, color: "#E8EAF0" }}>₩{fmt(h.eval)}</div>
                        <div style={{ fontSize: isMobile ? 10 : 11, fontWeight: 700, color }}>
                          ₩{fmt(Math.abs(h.profit))}
                        </div>
                        <div style={{ fontSize: 10, color }}>
                          {h.rate >= 0 ? '+' : ''}{h.rate.toFixed(1)}%
                        </div>
                      </div>
                    </div>
                    {isEditing && (
                      <div style={{
                        padding: '12px 16px', background: '#141927',
                        borderTop: '1px solid #2A2F3E',
                      }}>
                        <div style={{ fontSize: 10, letterSpacing: 2, color: '#5A6478', marginBottom: 10 }}>종목 수정</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                          <div>
                            <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4 }}>매수단가</div>
                            <input
                              type="number"
                              value={editPrice}
                              onChange={e => setEditPrice(e.target.value)}
                              style={{
                                background: '#0D1520', border: '1px solid #2A2F3E', borderRadius: 6,
                                color: '#E8EAF0', padding: '6px 10px', fontSize: 12,
                                fontFamily: baseFont, width: '100%', boxSizing: 'border-box',
                              }}
                            />
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4 }}>수량</div>
                            <input
                              type="number"
                              value={editQty}
                              onChange={e => setEditQty(e.target.value)}
                              style={{
                                background: '#0D1520', border: '1px solid #2A2F3E', borderRadius: 6,
                                color: '#E8EAF0', padding: '6px 10px', fontSize: 12,
                                fontFamily: baseFont, width: '100%', boxSizing: 'border-box',
                              }}
                            />
                          </div>
                        </div>
                        {editingHolding?.isManual && (
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4 }}>현재가 (수기)</div>
                            <input
                              type="number"
                              value={editCurrentPrice}
                              onChange={e => setEditCurrentPrice(e.target.value)}
                              style={{
                                background: '#0D1520', border: '1px solid #3B82F6', borderRadius: 6,
                                color: '#E8EAF0', padding: '6px 10px', fontSize: 12,
                                fontFamily: baseFont, width: '100%', boxSizing: 'border-box',
                              }}
                            />
                          </div>
                        )}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9CA3AF', marginBottom: 10, cursor: 'pointer', userSelect: 'none' }}>
                          <input
                            type="checkbox"
                            checked={editIncludeSavings}
                            onChange={e => setEditIncludeSavings(e.target.checked)}
                            style={{ accentColor: '#3B82F6' }}
                          />
                          신규 매수 반영 (저축금 업데이트)
                        </label>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                          <button onClick={() => { setEditingHolding(null); setEditIncludeSavings(false); }} style={{
                            padding: '6px 14px', borderRadius: 6, border: '1px solid #2A2F3E',
                            background: 'transparent', color: '#6B7280', cursor: 'pointer',
                            fontSize: 11, fontFamily: baseFont,
                          }}>취소</button>
                          <button onClick={saveEdit} style={{
                            padding: '6px 14px', borderRadius: 6, border: 'none',
                            background: '#3B82F6', color: '#fff', cursor: 'pointer',
                            fontSize: 11, fontFamily: baseFont,
                          }}>저장</button>
                        </div>
                      </div>
                    )}
                    </div>
                );
              })}
              {showDeleteMode && selectedToDelete.size > 0 && (
                <div style={{ padding: '12px 16px', borderTop: '1px solid #2A2F3E' }}>
                  <button onClick={handleDeleteSelected} style={{
                    width: '100%', padding: 10, borderRadius: 6, border: 'none',
                    background: PROFIT_POS, color: '#fff', cursor: 'pointer',
                    fontSize: 12, fontFamily: baseFont,
                  }}>
                    선택 삭제 ({selectedToDelete.size}개)
                  </button>
                </div>
              )}
                </>);
              })()}
            </div>
          </div>
        )}

        {/* ── 배당금 탭 ── */}
        {tab === "dividend" && (() => {
          const divYearTotals = divYears.filter(y => y !== '전체').map(y => ({
            year: y,
            total: dividendData.filter(d => String(d.year) === y).reduce((s, d) => s + d.amount, 0),
          }));
          const selectedDivItem = selectedDivKey ? dividendData.find(d => `${d.year}-${d.month}` === selectedDivKey) : null;

          return (
            <div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
                {divYears.map(y => (
                  <button key={y} onClick={() => { setDivYear(y); setSelectedDivKey(null); }} style={{
                    padding: isMobile ? "8px 14px" : "6px 14px",
                    borderRadius: 20,
                    border: `1px solid ${divYear === y ? '#3B82F6' : '#2A2F3E'}`,
                    background: divYear === y ? '#1E3A5F' : 'transparent',
                    color: divYear === y ? '#60A5FA' : '#6B7280',
                    cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
                  }}>{y}</button>
                ))}
              </div>

              <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 16 }}>월별 배당금</div>
                {filteredDividends.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart
                      data={filteredDividends.map(d => ({ ...d, label: `${String(d.year).slice(-2)}.${String(d.month).padStart(2, '0')}` }))}
                      barSize={isMobile ? 10 : 16}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3E" />
                      <XAxis dataKey="label" tick={{ fill: "#5A6478", fontSize: 9 }} />
                      <YAxis tickFormatter={v => v.toLocaleString()} tick={{ fill: "#5A6478", fontSize: 9 }} width={55} />
                      <Tooltip
                        formatter={v => [`₩${v.toLocaleString()}`, '배당금']}
                        contentStyle={{ background: "#1E2233", border: "1px solid #2A2F3E", borderRadius: 8, fontSize: 11 }}
                        labelStyle={{ color: '#E8EAF0' }}
                        itemStyle={{ color: '#E8EAF0' }}
                      />
                      <Bar dataKey="amount" fill={CHART_BAR_COLOR} radius={[3, 3, 0, 0]} cursor="pointer"
                        onClick={(data) => {
                          const key = `${data.year}-${data.month}`;
                          setSelectedDivKey(prev => prev === key ? null : key);
                        }} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5A6478', fontSize: 12 }}>
                    배당 데이터가 없습니다
                  </div>
                )}

                {selectedDivItem && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #2A2F3E' }}>
                    <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 8, letterSpacing: 1 }}>
                      {selectedDivItem.year}년 {selectedDivItem.month}월 상세
                    </div>
                    {selectedDivItem.items.map((item, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #1E2233' }}>
                        <span style={{ fontSize: 12, color: '#E8EAF0' }}>{item.name}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: PROFIT_POS }}>
                          ₩{fmt(item.amount)}
                        </span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8 }}>
                      <span style={{ fontSize: 11, color: '#9CA3AF' }}>합계</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: PROFIT_POS }}>
                        ₩{fmt(selectedDivItem.amount)}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px" }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 12 }}>연도별 합계</div>
                {divYearTotals.map(row => (
                  <div key={row.year} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #1E2233' }}>
                    <span style={{ fontSize: 12, color: '#9CA3AF' }}>{row.year}년 합계</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: PROFIT_POS }}>₩{fmt(row.total)}</span>
                  </div>
                ))}
                {(() => { const gt = dividendData.reduce((s, d) => s + d.amount, 0); return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10 }}>
                    <span style={{ fontSize: 12, color: '#E8EAF0', fontWeight: 600 }}>전체 합계</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: PROFIT_POS }}>₩{fmt(gt)}</span>
                  </div>
                ); })()}
              </div>
            </div>
          );
        })()}
        {/* ── 수익금 탭 ── */}
        {tab === "profit" && (() => {
          const profitYears = ['전체', ...[...new Set(profitData.map(d => String(d.year)))].sort()];
          const filtered = profitYear === '전체' ? profitData : profitData.filter(d => String(d.year) === profitYear);
          const selectedItem = selectedProfitKey ? profitData.find(d => `${d.year}-${d.month}` === selectedProfitKey) : null;
          const yearTotals = profitYears.filter(y => y !== '전체').map(y => ({
            year: y,
            total: profitData.filter(d => String(d.year) === y).reduce((s, d) => s + d.total, 0),
          }));

          return (
            <div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
                {profitYears.map(y => (
                  <button key={y} onClick={() => { setProfitYear(y); setSelectedProfitKey(null); }} style={{
                    padding: isMobile ? "8px 14px" : "6px 14px",
                    borderRadius: 20,
                    border: `1px solid ${profitYear === y ? '#3B82F6' : '#2A2F3E'}`,
                    background: profitYear === y ? '#1E3A5F' : 'transparent',
                    color: profitYear === y ? '#60A5FA' : '#6B7280',
                    cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
                  }}>{y}</button>
                ))}
              </div>

              <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 16 }}>월별 수익금</div>
                {filtered.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart
                      data={filtered.map(d => ({ ...d, label: `${String(d.year).slice(-2)}.${String(d.month).padStart(2, '0')}` }))}
                      barSize={isMobile ? 10 : 16}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3E" />
                      <XAxis dataKey="label" tick={{ fill: "#5A6478", fontSize: 9 }} />
                      <YAxis tickFormatter={v => v.toLocaleString()} tick={{ fill: "#5A6478", fontSize: 9 }} width={55} />
                      <Tooltip
                        formatter={v => [`₩${v.toLocaleString()}`, '수익금']}
                        contentStyle={{ background: "#1E2233", border: "1px solid #2A2F3E", borderRadius: 8, fontSize: 11 }}
                        labelStyle={{ color: '#E8EAF0' }}
                        itemStyle={{ color: '#E8EAF0' }}
                      />
                      <Bar dataKey="total" radius={[3, 3, 0, 0]} cursor="pointer"
                        onClick={(data) => {
                          const key = `${data.year}-${data.month}`;
                          setSelectedProfitKey(prev => prev === key ? null : key);
                        }}>
                        {filtered.map((d, i) => (
                          <Cell key={i} fill={d.total >= 0 ? PROFIT_POS : PROFIT_NEG} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5A6478', fontSize: 12 }}>
                    수익금 데이터가 없습니다
                  </div>
                )}

                {selectedItem && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #2A2F3E' }}>
                    <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 8, letterSpacing: 1 }}>
                      {selectedItem.year}년 {selectedItem.month}월 상세
                    </div>
                    {selectedItem.items.map((item, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #1E2233' }}>
                        <span style={{ fontSize: 12, color: '#E8EAF0' }}>{item.name}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: item.profit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                          ₩{fmt(Math.abs(item.profit))}
                        </span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8 }}>
                      <span style={{ fontSize: 11, color: '#9CA3AF' }}>합계</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: selectedItem.total >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                        ₩{fmt(Math.abs(selectedItem.total))}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px" }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: "#5A6478", marginBottom: 12 }}>연도별 합계</div>
                {yearTotals.map(row => (
                  <div key={row.year} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #1E2233' }}>
                    <span style={{ fontSize: 12, color: '#9CA3AF' }}>{row.year}년 합계</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: row.total >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                      ₩{fmt(Math.abs(row.total))}
                    </span>
                  </div>
                ))}
                {(() => { const gt = profitData.reduce((s, d) => s + d.total, 0); return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10 }}>
                    <span style={{ fontSize: 12, color: '#E8EAF0', fontWeight: 600 }}>전체 합계</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: gt >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                      ₩{fmt(Math.abs(gt))}
                    </span>
                  </div>
                ); })()}
              </div>
            </div>
          );
        })()}

        {/* ── 체결내역 탭 ── */}
        {tab === "체결내역" && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 10, letterSpacing: 3, color: '#5A6478' }}>체결내역 자동 동기화</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {tradeSyncMsg && (
                  <span style={{ fontSize: 10, color: tradeSyncMsg.includes('오류') ? '#F87171' : '#4ADE80' }}>
                    {tradeSyncMsg}
                  </span>
                )}
                <button onClick={() => setSavingsMode(p => !p)} disabled={sheets.auth !== 'signed-in'} style={{
                  padding: '5px 12px', borderRadius: 6,
                  border: `1px solid ${savingsMode ? '#3B82F6' : '#2A2F3E'}`,
                  background: savingsMode ? '#1E3A5F' : 'transparent',
                  color: savingsMode ? '#60A5FA' : '#9CA3AF',
                  cursor: sheets.auth !== 'signed-in' ? 'not-allowed' : 'pointer',
                  fontSize: 10, fontFamily: baseFont,
                }}>
                  저축금
                </button>
                <button onClick={syncTradeExecutions} disabled={tradeSyncing || sheets.auth !== 'signed-in'} style={{
                  padding: '5px 12px', borderRadius: 6, border: '1px solid #2A2F3E',
                  background: 'transparent', color: '#9CA3AF',
                  cursor: (tradeSyncing || sheets.auth !== 'signed-in') ? 'not-allowed' : 'pointer',
                  fontSize: 10, fontFamily: baseFont,
                }}>
                  ↻
                </button>
              </div>
            </div>

            {sheets.auth !== 'signed-in' ? (
              <div style={{ padding: 32, textAlign: 'center', color: '#5A6478', fontSize: 12 }}>
                로그인 후 이용할 수 있습니다
              </div>
            ) : tradeRows.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: '#5A6478', fontSize: 12 }}>
                {tradeSyncing ? '불러오는 중...' : '체결내역이 없습니다'}
              </div>
            ) : (
              <div style={{ background: '#1A1D26', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ padding: '10px 16px', borderBottom: '1px solid #2A2F3E', fontSize: 10, letterSpacing: 3, color: '#5A6478' }}>
                  전체 {tradeRows.length}건 · 처리완료 {tradeRows.filter(r => r.processed).length}건
                </div>
                {tradeRows.map(({ row, processed }, idx) => {
                  const date     = String(row[0] ?? '').trim();
                  const buySell  = String(row[1] ?? '').trim();
                  const account  = String(row[2] ?? '').trim();
                  const stockName = String(row[5] ?? '').trim();
                  const price    = parseNum(row[6]);
                  const qty      = parseNum(row[7]);
                  const amount   = Math.round(price * qty);
                  const isComplete = row.length >= 13 && row.slice(0, 13).every(cell => String(cell ?? '').trim() !== '');
                  const isBuy = buySell.includes('매수');
                  const savingsApplied = savingsAppliedRows.has(idx);
                  const canApplySavings = isComplete && amount > 0 && date && !savingsApplied;
                  const openTradeEdit = () => {
                    if (isComplete) return;
                    const vals = Array(13).fill('').map((_, ci) => String(row[ci] ?? ''));
                    setTradeEditValues(vals);
                    setTradeEditRowIdx(idx);
                    setTradeEditOpen(true);
                  };
                  return (
                    <div key={idx}
                      onTouchStart={() => { tradeLpRef.current = setTimeout(openTradeEdit, 500); }}
                      onTouchEnd={() => clearTimeout(tradeLpRef.current)}
                      onTouchMove={() => clearTimeout(tradeLpRef.current)}
                      onContextMenu={(e) => { e.preventDefault(); openTradeEdit(); }}
                      style={{
                        padding: '12px 16px',
                        borderBottom: idx < tradeRows.length - 1 ? '1px solid #1E2233' : 'none',
                        display: 'flex', alignItems: 'center', gap: 12,
                        opacity: processed ? 0.55 : 1,
                        cursor: !isComplete ? 'pointer' : 'default',
                      }}>
                      <div style={{
                        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                        background: processed ? '#34A853' : isComplete ? '#F5A623' : '#3B4152',
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                          <span style={{
                            fontSize: 10, padding: '1px 5px', borderRadius: 3,
                            background: isBuy ? '#1E3A5F' : '#4A1E1E',
                            color: isBuy ? '#60A5FA' : '#F87171',
                          }}>{buySell || '—'}</span>
                          <span style={{ fontSize: 10, color: '#5A6478' }}>{account}</span>
                          <span style={{ fontSize: 10, color: '#3A3F4E' }}>·</span>
                          <span style={{ fontSize: 10, color: '#5A6478' }}>{date}</span>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#E8EAF0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {stockName || '—'}
                        </div>
                        <div style={{ fontSize: 10, color: '#5A6478', marginTop: 2 }}>
                          {qty > 0 ? `${qty}주` : ''}{qty > 0 && price > 0 ? ' · ' : ''}{price > 0 ? `₩${price.toLocaleString()}` : ''}
                          {!isComplete && <span style={{ marginLeft: 6, color: '#F59E0B' }}>셀 미완성</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                        {processed && (
                          <span style={{ fontSize: 10, color: '#34A853' }}>완료</span>
                        )}
                        {savingsApplied ? (
                          <span style={{ fontSize: 10, color: '#4ADE80' }}>저축금 ✓</span>
                        ) : savingsMode && (
                          <button
                            onClick={() => canApplySavings && applySavingsFromTrade(date, amount, isBuy, idx)}
                            disabled={!canApplySavings}
                            style={{
                              padding: '3px 8px', borderRadius: 4, border: '1px solid',
                              borderColor: canApplySavings ? (isBuy ? '#3B82F6' : '#EF4444') : '#2A2F3E',
                              background: 'transparent',
                              color: canApplySavings ? (isBuy ? '#60A5FA' : '#F87171') : '#3A3F4E',
                              cursor: canApplySavings ? 'pointer' : 'not-allowed',
                              fontSize: 10, fontFamily: baseFont,
                            }}
                          >
                            {isBuy ? '+저축' : '−저축'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

          </div>
        )}

        {/* ── 평가 탭 ── */}
        {tab === "평가" && (() => {
          const fromSheet = evaluations.length > 0;
          const current = fromSheet ? evaluations[evalSelectedIdx] : null;
          // 시트 카드를 SAMPLE 카드와 같은 모양으로 정규화 (axes는 grade만, items 없음)
          const card = current ? {
            stock: current.stock,
            date: current.date,
            axes: [
              { label: '수익성',     grade: current.axisGrades.수익성,     items: current.axisItems?.['수익성'] || [] },
              { label: '재무 안정성', grade: current.axisGrades.안정성,     items: current.axisItems?.['안정성'] || [] },
              { label: '밸류에이션',  grade: current.axisGrades.밸류에이션, items: current.axisItems?.['밸류에이션'] || [] },
              { label: '현금흐름',    grade: current.axisGrades.현금흐름,   items: current.axisItems?.['현금흐름'] || [] },
              { label: '모멘텀',      grade: current.axisGrades.모멘텀,     items: current.axisItems?.['모멘텀'] || [] },
            ],
            conclusion: { raw: current.conclusion.raw, label: current.conclusion.raw },
            reasons: current.reasons,
            risks: current.risks,
            actions: current.actions,
            sources: [],
            statusBar: { status: current.status, buyDate: current.buyDate, buyPrice: current.buyPrice, targetTerm: current.targetTerm, targetRet: current.targetRet, aiNote: current.aiNote, frankMemo: current.frankMemo },
          } : SAMPLE_EVALUATION;

          return (
          <div>
            {/* 헤더 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 10, letterSpacing: 3, color: '#5A6478' }}>🤖 AI 능동 종목 평가</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => setEvalQueueOpen(true)} disabled={sheets.auth !== 'signed-in'} style={{
                  padding: '5px 12px', borderRadius: 6, border: '1px solid #F5A623',
                  background: '#3D2E14', color: '#F5A623',
                  cursor: sheets.auth !== 'signed-in' ? 'not-allowed' : 'pointer',
                  opacity: sheets.auth !== 'signed-in' ? 0.4 : 1,
                  fontSize: 10, fontFamily: baseFont, fontWeight: 600,
                }}>
                  평가 의뢰
                </button>
                <button onClick={() => setEvalIngestOpen(true)} disabled={sheets.auth !== 'signed-in'} style={{
                  padding: '5px 12px', borderRadius: 6, border: '1px solid #3B82F6',
                  background: '#1E3A5F', color: '#60A5FA',
                  cursor: sheets.auth !== 'signed-in' ? 'not-allowed' : 'pointer',
                  opacity: sheets.auth !== 'signed-in' ? 0.4 : 1,
                  fontSize: 10, fontFamily: baseFont,
                }}>
                  평가 결과 저장
                </button>
                <button onClick={() => {
                  navigator.clipboard.writeText(EVAL_PROMPT_TEMPLATE);
                  setEvalPromptCopied(true);
                  setTimeout(() => setEvalPromptCopied(false), 2000);
                }} style={{
                  padding: '5px 10px', borderRadius: 6, border: '1px solid #2A2F3E',
                  background: 'transparent', color: evalPromptCopied ? '#4ADE80' : '#5A6478',
                  cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
                }} title="데스크탑용 — 프롬프트 클립보드 복사">
                  {evalPromptCopied ? '✓' : '📋'}
                </button>
              </div>
            </div>

            {/* 평가 의뢰 큐 상태 */}
            {(evalQueue.counts.pending + evalQueue.counts.processing + evalQueue.counts.error) > 0 && (
              <div style={{
                background: '#0F1218', borderRadius: 8, padding: '8px 12px', marginBottom: 12,
                fontSize: 10, color: '#9CA3AF', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center',
              }}>
                <span style={{ color: '#5A6478', letterSpacing: 1 }}>📥 의뢰 큐</span>
                {evalQueue.counts.pending > 0 && <span>대기 <span style={{ color: '#F5A623', fontWeight: 600 }}>{evalQueue.counts.pending}</span></span>}
                {evalQueue.counts.processing > 0 && <span>처리중 <span style={{ color: '#60A5FA', fontWeight: 600 }}>{evalQueue.counts.processing}</span></span>}
                {evalQueue.counts.error > 0 && <span>오류 <span style={{ color: '#F87171', fontWeight: 600 }}>{evalQueue.counts.error}</span></span>}
              </div>
            )}

            {/* 종목 선택 드롭다운 (시트 데이터 있을 때만) */}
            {fromSheet && evaluations.length > 1 && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                {evaluations.map((ev, i) => (
                  <button key={i} onClick={() => setEvalSelectedIdx(i)} style={{
                    padding: '4px 10px', borderRadius: 6,
                    border: `1px solid ${i === evalSelectedIdx ? '#3B82F6' : '#2A2F3E'}`,
                    background: i === evalSelectedIdx ? '#1E3A5F' : 'transparent',
                    color: i === evalSelectedIdx ? '#60A5FA' : '#9CA3AF',
                    cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
                  }}>{ev.stock.name}</button>
                ))}
              </div>
            )}

            <div style={{ fontSize: 9, letterSpacing: 2, color: '#5A6478', marginBottom: 8 }}>
              {fromSheet ? `시트 데이터 (${card.stock.name} · ${card.date} 기준)` : `샘플 (${card.stock.name} · ${card.date} 기준)`}
            </div>

            {/* 평가 카드 */}
            <div style={{ background: '#1A1D26', borderRadius: 12, padding: '16px 16px 12px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#E8EAF0' }}>
                    {card.stock.name}{card.stock.ticker ? ` (${card.stock.ticker})` : ''}
                  </div>
                  <div style={{ fontSize: 9, color: '#5A6478', marginTop: 2, letterSpacing: 1 }}>
                    {card.stock.market || '—'} · {card.date}
                  </div>
                </div>
                {fromSheet && card.statusBar?.status && (
                  <div style={{
                    padding: '3px 10px', borderRadius: 4, fontSize: 10,
                    background: card.statusBar.status === '매수' ? '#1E3A5F'
                              : card.statusBar.status === '매도' ? '#4A1E1E' : '#2A2F3E',
                    color:      card.statusBar.status === '매수' ? '#60A5FA'
                              : card.statusBar.status === '매도' ? '#F87171' : '#9CA3AF',
                  }}>{card.statusBar.status}</div>
                )}
              </div>

              {/* 5축 */}
              {card.axes.map((axis, ai) => (
                <div key={ai} style={{ borderTop: '1px solid #1E2233', padding: '10px 0' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#E8EAF0', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{axis.grade || '⚪'}</span>
                    <span>{ai + 1}. {axis.label}</span>
                  </div>
                  {/* 시트 카드(items 없음)는 axis 단위 학습 모듈 칩으로 📘 진입 보장 */}
                  {axis.items.length === 0 && AXIS_METRICS[axis.label] && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
                      {AXIS_METRICS[axis.label].map(metric => (
                        <button key={metric} onClick={() => setEvalSelectedMetric(metric)} style={{
                          padding: '3px 8px', borderRadius: 4, border: '1px solid #2A2F3E',
                          background: 'transparent', color: '#9CA3AF',
                          cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                        }} title={LEARNING_MODULES[metric]?.title}>
                          <span>📘</span>
                          <span>{LEARNING_MODULES[metric]?.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {axis.items.map((item, ii) => (
                    <div key={ii} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', fontSize: 11 }}>
                      <div style={{ color: '#9CA3AF', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>{item.label}</span>
                        {item.metric && (
                          <button onClick={() => setEvalSelectedMetric(item.metric)} style={{
                            background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, fontSize: 10, lineHeight: 1,
                          }} title={LEARNING_MODULES[item.metric]?.title}>📘</button>
                        )}
                      </div>
                      <div style={{ color: '#E8EAF0', display: 'flex', alignItems: 'baseline', gap: 6, textAlign: 'right' }}>
                        <span style={{ fontWeight: 600 }}>{item.value}</span>
                        {item.source && <span style={{ fontSize: 9, color: '#5A6478' }}>{item.source}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              ))}

              {/* 결론·근거·리스크·액션·출처 */}
              <div style={{ borderTop: '1px solid #2A2F3E', marginTop: 10, paddingTop: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#4ADE80', marginBottom: 12 }}>
                  결론: {fromSheet ? card.conclusion.raw : `${card.conclusion.grade} ${card.conclusion.label}`}
                </div>

                {card.reasons.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4, letterSpacing: 1 }}>근거</div>
                    {card.reasons.map((r, i) => (
                      <div key={i} style={{ fontSize: 11, color: '#9CA3AF', paddingLeft: 8, lineHeight: 1.5, marginBottom: 3 }}>
                        {i + 1}. {r}
                      </div>
                    ))}
                  </div>
                )}

                {card.risks.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4, letterSpacing: 1 }}>리스크</div>
                    {card.risks.map((r, i) => (
                      <div key={i} style={{ fontSize: 11, color: '#F87171', paddingLeft: 8, lineHeight: 1.5, marginBottom: 3 }}>
                        {i + 1}. {r}
                      </div>
                    ))}
                  </div>
                )}

                {card.actions.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4, letterSpacing: 1 }}>Frank 액션 권고</div>
                    {card.actions.map((a, i) => (
                      <div key={i} style={{ fontSize: 11, color: '#60A5FA', paddingLeft: 8, lineHeight: 1.5, marginBottom: 3 }}>
                        • {a}
                      </div>
                    ))}
                  </div>
                )}

                {/* 시트 메타 (매수일·목표 등) */}
                {fromSheet && (card.statusBar?.buyDate || card.statusBar?.targetTerm || card.statusBar?.aiNote || card.statusBar?.frankMemo) && (
                  <div style={{ background: '#0F1218', borderRadius: 6, padding: '8px 12px', marginTop: 8, fontSize: 10, color: '#9CA3AF', lineHeight: 1.6 }}>
                    {card.statusBar.buyDate  && <div>매수일: <span style={{ color: '#E8EAF0' }}>{card.statusBar.buyDate}</span>{card.statusBar.buyPrice ? ` · ${card.statusBar.buyPrice}` : ''}</div>}
                    {card.statusBar.targetTerm && <div>목표: <span style={{ color: '#E8EAF0' }}>{card.statusBar.targetTerm}{card.statusBar.targetRet ? ` · ${card.statusBar.targetRet}` : ''}</span></div>}
                    {card.statusBar.aiNote   && <div>AI: <span style={{ color: '#E8EAF0' }}>{card.statusBar.aiNote}</span></div>}
                    {card.statusBar.frankMemo && <div>Frank: <span style={{ color: '#E8EAF0' }}>{card.statusBar.frankMemo}</span></div>}
                  </div>
                )}

                {card.sources?.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4, letterSpacing: 1 }}>출처</div>
                    {card.sources.map((s, i) => (
                      <div key={i} style={{ fontSize: 9, color: '#5A6478', paddingLeft: 8, lineHeight: 1.4 }}>· {s}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>

          </div>
          );
        })()}

        {/* ── 노트 탭 ── */}
        {tab === "노트" && (() => {
          // 4계좌 holdings 합산 — 종목명 key로 unique
          const stockMap = {};
          Object.entries(accounts).forEach(([acctKey, acct]) => {
            (acct.holdings || []).forEach(h => {
              const name = String(h.name ?? '').trim();
              if (!name) return;
              if (!stockMap[name]) {
                stockMap[name] = { name, type: h.type, qty: 0, investSum: 0, evalSum: 0, profitSum: 0, accounts: [] };
              }
              const s = stockMap[name];
              s.qty += h.qty || 0;
              s.investSum += h.invest || 0;
              s.evalSum   += h.eval   || 0;
              s.profitSum += h.profit || 0;
              s.accounts.push({ acct: acctKey, qty: h.qty, price: h.price, currentPrice: h.currentPrice });
            });
          });
          const stocks = Object.values(stockMap)
            .filter(s => s.qty > 0)
            .map(s => ({
              ...s,
              avgPrice: s.investSum > 0 && s.qty > 0 ? s.investSum / s.qty : 0,
              rate: s.investSum > 0 ? (s.profitSum / s.investSum) * 100 : 0,
            }))
            .sort((a, b) => b.evalSum - a.evalSum);

          const currentName = noteSelectedStock || stocks[0]?.name || null;
          const stock = stocks.find(s => s.name === currentName);
          const stockEvals = evaluations.filter(e => e.stock?.name === currentName);

          if (sheets.auth !== 'signed-in') {
            return (
              <div style={{ padding: 32, textAlign: 'center', color: '#5A6478', fontSize: 12 }}>
                로그인 후 이용할 수 있습니다
              </div>
            );
          }
          if (stocks.length === 0) {
            return (
              <div style={{ padding: 32, textAlign: 'center', color: '#5A6478', fontSize: 12 }}>
                보유 종목이 없습니다
              </div>
            );
          }

          return (
            <div>
              {/* 헤더 */}
              <div style={{ fontSize: 10, letterSpacing: 3, color: '#5A6478', marginBottom: 12 }}>
                📒 종목 노트 — 보유 {stocks.length}종목
              </div>

              {/* 종목 선택 칩 */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
                {stocks.map(s => {
                  const evCount = evaluations.filter(e => e.stock?.name === s.name).length;
                  const isSelected = s.name === currentName;
                  const profitColor = s.profitSum >= 0 ? PROFIT_POS : PROFIT_NEG;
                  return (
                    <button key={s.name} onClick={() => setNoteSelectedStock(s.name)} style={{
                      padding: '6px 10px', borderRadius: 6,
                      border: `1px solid ${isSelected ? '#3B82F6' : '#2A2F3E'}`,
                      background: isSelected ? '#1E3A5F' : '#1A1D26',
                      color: isSelected ? '#60A5FA' : '#9CA3AF',
                      cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      <span>{s.name}</span>
                      <span style={{ fontSize: 9, color: profitColor }}>
                        {s.profitSum >= 0 ? '+' : ''}{s.rate.toFixed(1)}%
                      </span>
                      {evCount > 0 && (
                        <span style={{
                          fontSize: 8, padding: '0 4px', borderRadius: 8,
                          background: '#2A2F3E', color: '#9CA3AF',
                        }}>📘{evCount}</span>
                      )}
                    </button>
                  );
                })}
              </div>

              {stock && (() => {
                const earliestEval = stockEvals[stockEvals.length - 1] || null;
                const canSellEval = !!earliestEval && earliestEval.reasons.length > 0;
                const onSellEvalClick = async () => {
                  const prompt = buildSellEvalPrompt(
                    { name: stock.name, ticker: earliestEval?.stock?.ticker || '', market: earliestEval?.stock?.market || '' },
                    earliestEval,
                    { qty: stock.qty, avgPrice: stock.avgPrice, evalSum: stock.evalSum, rate: stock.rate, accounts: stock.accounts }
                  );
                  await navigator.clipboard.writeText(prompt);
                  setNoteSellCopied(true);
                  setTimeout(() => setNoteSellCopied(false), 2000);
                };
                return (
                <>
                  {/* 보유 정보 카드 */}
                  <div style={{ background: '#1A1D26', borderRadius: 12, padding: '16px 16px 14px', marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                      <div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: '#E8EAF0' }}>{stock.name}</div>
                        <div style={{ fontSize: 9, color: '#5A6478', marginTop: 2, letterSpacing: 1 }}>
                          {stock.type || '—'} · {stock.accounts.map(a => a.acct).join(' / ')}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: stock.profitSum >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                          {stock.profitSum >= 0 ? '+' : ''}{stock.rate.toFixed(1)}%
                        </div>
                        <div style={{ fontSize: 9, color: '#5A6478', marginTop: 2 }}>
                          {stock.profitSum >= 0 ? '+' : ''}₩{fmt(stock.profitSum)}
                        </div>
                      </div>
                    </div>

                    {/* 매도 평가 트리거 */}
                    <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                      <button onClick={onSellEvalClick} disabled={!canSellEval} title={canSellEval ? '매도 평가 프롬프트 복사' : '최초 매수 이유가 없어 매도 평가 불가'} style={{
                        flex: 1, padding: '6px 10px', borderRadius: 6,
                        border: `1px solid ${canSellEval ? '#F87171' : '#2A2F3E'}`,
                        background: canSellEval ? (noteSellCopied ? '#4ADE8033' : '#4A1E1E33') : 'transparent',
                        color: canSellEval ? (noteSellCopied ? '#4ADE80' : '#F87171') : '#3A3F4E',
                        cursor: canSellEval ? 'pointer' : 'not-allowed',
                        fontSize: 10, fontFamily: baseFont, fontWeight: 600,
                      }}>
                        {noteSellCopied ? '✓ 복사됨' : '매도 평가'}
                      </button>
                      <button onClick={() => setEvalIngestOpen(true)} disabled={sheets.auth !== 'signed-in'} style={{
                        padding: '6px 10px', borderRadius: 6, border: '1px solid #3B82F6',
                        background: '#1E3A5F', color: '#60A5FA',
                        cursor: sheets.auth !== 'signed-in' ? 'not-allowed' : 'pointer',
                        opacity: sheets.auth !== 'signed-in' ? 0.4 : 1,
                        fontSize: 10, fontFamily: baseFont,
                      }}>평가 결과 저장</button>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: 10 }}>
                      <div>
                        <div style={{ color: '#5A6478', letterSpacing: 1, marginBottom: 2 }}>보유</div>
                        <div style={{ color: '#E8EAF0', fontWeight: 600 }}>{fmt(stock.qty)}주</div>
                      </div>
                      <div>
                        <div style={{ color: '#5A6478', letterSpacing: 1, marginBottom: 2 }}>평균단가</div>
                        <div style={{ color: '#E8EAF0', fontWeight: 600 }}>₩{fmt(stock.avgPrice)}</div>
                      </div>
                      <div>
                        <div style={{ color: '#5A6478', letterSpacing: 1, marginBottom: 2 }}>평가금</div>
                        <div style={{ color: '#E8EAF0', fontWeight: 600 }}>₩{fmt(stock.evalSum)}</div>
                      </div>
                    </div>

                    {stock.accounts.length > 1 && (
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1E2233' }}>
                        <div style={{ fontSize: 9, letterSpacing: 1, color: '#5A6478', marginBottom: 4 }}>계좌별 보유</div>
                        {stock.accounts.map((a, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '2px 0' }}>
                            <span style={{ color: '#9CA3AF' }}>{a.acct}</span>
                            <span style={{ color: '#E8EAF0' }}>
                              {fmt(a.qty)}주 · 매수가 ₩{fmt(a.price)}{a.currentPrice ? ` · 현재가 ₩${fmt(a.currentPrice)}` : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 매수 이유 — 첫 평가의 reasons 또는 최신 평가의 reasons */}
                  {stockEvals.length > 0 && (() => {
                    const earliest = stockEvals[stockEvals.length - 1]; // evaluations는 최신순이므로 last가 가장 오래된 = 최초
                    const latest = stockEvals[0];
                    return (
                      <div style={{ background: '#1A1D26', borderRadius: 12, padding: '14px 16px', marginBottom: 12 }}>
                        <div style={{ fontSize: 10, letterSpacing: 2, color: '#5A6478', marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline' }}>
                          <span>📝 최초 매수 근거</span>
                          <span style={{ color: '#9CA3AF' }}>
                            매수일 <span style={{ color: earliest.buyDate ? '#E8EAF0' : '#5A6478' }}>{earliest.buyDate || '미입력'}</span>
                          </span>
                          <span style={{ color: '#3A3F4E' }}>·</span>
                          <span style={{ color: '#9CA3AF' }}>
                            평가일 <span style={{ color: '#E8EAF0' }}>{earliest.date}</span>
                          </span>
                        </div>
                        {earliest.reasons.length === 0 ? (
                          <div style={{ fontSize: 11, color: '#5A6478' }}>(근거 미기록)</div>
                        ) : earliest.reasons.map((r, i) => (
                          <div key={i} style={{ fontSize: 11, color: '#9CA3AF', paddingLeft: 4, lineHeight: 1.6, marginBottom: 3 }}>
                            {i + 1}. {r}
                          </div>
                        ))}

                        {latest.aiNote && (
                          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1E2233' }}>
                            <div style={{ fontSize: 10, letterSpacing: 2, color: '#5A6478', marginBottom: 4 }}>AI 한 줄 (최신 평가)</div>
                            <div style={{ fontSize: 11, color: '#E8EAF0', lineHeight: 1.5 }}>{latest.aiNote}</div>
                          </div>
                        )}

                        {latest.frankMemo && (
                          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1E2233' }}>
                            <div style={{ fontSize: 10, letterSpacing: 2, color: '#5A6478', marginBottom: 4 }}>Frank 메모</div>
                            <div style={{ fontSize: 11, color: '#E8EAF0', lineHeight: 1.5 }}>{latest.frankMemo}</div>
                          </div>
                        )}

                        {(latest.targetTerm || latest.targetRet || latest.status) && (
                          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1E2233', display: 'flex', gap: 12, fontSize: 10, color: '#5A6478' }}>
                            {latest.status && <span>상태: <span style={{ color: '#E8EAF0' }}>{latest.status}</span></span>}
                            {latest.targetTerm && <span>목표기간: <span style={{ color: '#E8EAF0' }}>{latest.targetTerm}</span></span>}
                            {latest.targetRet && <span>목표수익률: <span style={{ color: '#E8EAF0' }}>{latest.targetRet}</span></span>}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* 평가 히스토리 시계열 */}
                  {stockEvals.length > 0 ? (
                    <div style={{ background: '#1A1D26', borderRadius: 12, padding: '14px 16px', marginBottom: 12 }}>
                      <div style={{ fontSize: 10, letterSpacing: 2, color: '#5A6478', marginBottom: 10 }}>
                        📊 평가 히스토리 ({stockEvals.length}건, 최신순)
                      </div>
                      {stockEvals.map((ev, i) => (
                        <div key={i} style={{
                          padding: '8px 0',
                          borderTop: i === 0 ? 'none' : '1px solid #1E2233',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                            <div style={{ fontSize: 11, color: '#E8EAF0', fontWeight: 600 }}>
                              {ev.date} · {ev.conclusion.raw || '—'}
                            </div>
                            <div style={{ fontSize: 9, color: '#5A6478' }}>
                              {[ev.axisGrades.수익성, ev.axisGrades.안정성, ev.axisGrades.밸류에이션, ev.axisGrades.현금흐름, ev.axisGrades.모멘텀].join(' ')}
                            </div>
                          </div>
                          {ev.aiNote && (
                            <div style={{ fontSize: 10, color: '#9CA3AF', lineHeight: 1.5, paddingLeft: 4 }}>
                              {ev.aiNote}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ background: '#1A1D26', borderRadius: 12, padding: '20px 16px', marginBottom: 12, textAlign: 'center' }}>
                      <div style={{ fontSize: 11, color: '#5A6478', marginBottom: 8 }}>
                        아직 평가 기록이 없습니다
                      </div>
                      <button onClick={() => setTab('평가')} style={{
                        padding: '6px 12px', borderRadius: 6, border: '1px solid #3B82F6',
                        background: '#1E3A5F', color: '#60A5FA',
                        cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
                      }}>
                        평가 탭에서 추가 →
                      </button>
                    </div>
                  )}

                </>
                );
              })()}
            </div>
          );
        })()}

        {/* ── 체결내역 셀 편집 모달 ── */}
        {tradeEditOpen && tradeEditRowIdx !== null && (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, zIndex: 200,
          }} onClick={(e) => { if (e.target === e.currentTarget) setTradeEditOpen(false); }}>
            <div style={{
              background: '#1A1D26', borderRadius: 12, width: '100%', maxWidth: 440,
              maxHeight: '90vh', overflowY: 'auto', padding: '20px 18px',
              border: '1px solid #2A2F3E',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#F5A623' }}>셀 값 입력</div>
                <button onClick={() => setTradeEditOpen(false)} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: '#5A6478', fontSize: 18, padding: 0, lineHeight: 1,
                }}>✕</button>
              </div>

              {CHEOL_COLS.map((col, ci) => {
                const isEmpty = !tradeEditValues[ci];
                return (
                  <div key={col.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{
                      width: 64, fontSize: 10, color: isEmpty ? '#F59E0B' : '#5A6478',
                      textAlign: 'right', flexShrink: 0,
                    }}>
                      {col.key} · {col.label}
                    </div>
                    <input
                      value={tradeEditValues[ci]}
                      onChange={(e) => {
                        const next = [...tradeEditValues];
                        next[ci] = e.target.value;
                        setTradeEditValues(next);
                      }}
                      placeholder={col.placeholder}
                      style={{
                        flex: 1, background: isEmpty ? '#1E1A0F' : '#0F1218',
                        border: `1px solid ${isEmpty ? '#F59E0B' : '#2A2F3E'}`,
                        borderRadius: 4, padding: '6px 8px', color: '#E8EAF0',
                        fontSize: 12, fontFamily: baseFont, outline: 'none',
                      }}
                    />
                  </div>
                );
              })}

              <button onClick={saveTradeEdit} disabled={tradeEditBusy} style={{
                width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 6, border: 'none',
                background: tradeEditBusy ? '#2A2F3E' : '#F5A623',
                color: tradeEditBusy ? '#5A6478' : '#1A1D26',
                cursor: tradeEditBusy ? 'not-allowed' : 'pointer',
                fontSize: 12, fontWeight: 700, fontFamily: baseFont,
              }}>{tradeEditBusy ? '저장 중...' : '시트에 저장'}</button>
            </div>
          </div>
        )}

        {/* ── 평가 카드 적재 모달 ── */}
        {evalIngestOpen && (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, zIndex: 200,
          }} onClick={(e) => { if (e.target === e.currentTarget) setEvalIngestOpen(false); }}>
            <div style={{
              background: '#1A1D26', borderRadius: 12, width: '100%', maxWidth: 560,
              maxHeight: '90vh', overflowY: 'auto', padding: '20px 18px',
              border: '1px solid #2A2F3E',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#60A5FA' }}>평가 결과 저장</div>
                <button onClick={() => setEvalIngestOpen(false)} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: '#5A6478', fontSize: 18, padding: 0, lineHeight: 1,
                }}>✕</button>
              </div>

              <textarea
                value={evalIngestRaw}
                onChange={(e) => { setEvalIngestRaw(e.target.value); setEvalIngestParsed(null); setEvalIngestMsg(''); }}
                placeholder="JSON 블록 붙여넣기"
                style={{
                  width: '100%', minHeight: 140, boxSizing: 'border-box',
                  background: '#0F1218', color: '#E8EAF0', border: '1px solid #2A2F3E',
                  borderRadius: 8, padding: 10, fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace',
                  lineHeight: 1.5, resize: 'vertical', outline: 'none',
                }}
              />

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={() => {
                  const r = tryParseEvalJson(evalIngestRaw);
                  if (r.ok) { setEvalIngestParsed(r.data); setEvalIngestMsg('✓ 파싱 완료. 검토 후 적재하세요.'); }
                  else { setEvalIngestParsed(null); setEvalIngestMsg(`⚠️ ${r.error}`); }
                }} style={{
                  flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #2A2F3E',
                  background: 'transparent', color: '#9CA3AF', cursor: 'pointer',
                  fontSize: 11, fontFamily: baseFont,
                }}>파싱</button>
                <button onClick={ingestEvaluation} disabled={!evalIngestParsed || evalIngestBusy} style={{
                  flex: 1, padding: '8px 12px', borderRadius: 6, border: 'none',
                  background: evalIngestParsed && !evalIngestBusy ? '#3B82F6' : '#2A2F3E',
                  color: evalIngestParsed && !evalIngestBusy ? '#fff' : '#5A6478',
                  cursor: evalIngestParsed && !evalIngestBusy ? 'pointer' : 'not-allowed',
                  fontSize: 11, fontWeight: 600, fontFamily: baseFont,
                }}>{evalIngestBusy ? '적재 중...' : '시트에 적재'}</button>
              </div>

              {evalIngestMsg && (
                <div style={{
                  marginTop: 10, padding: '8px 12px', borderRadius: 6,
                  background: '#0F1218', fontSize: 11,
                  color: evalIngestMsg.startsWith('✓') ? '#4ADE80'
                       : evalIngestMsg.startsWith('⚠️') ? '#F59E0B'
                       : evalIngestMsg.includes('실패') ? '#F87171' : '#9CA3AF',
                  lineHeight: 1.5,
                }}>{evalIngestMsg}</div>
              )}

              {/* 파싱 결과 미리보기 + 편집 */}
              {evalIngestParsed && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #2A2F3E' }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: '#5A6478', marginBottom: 8 }}>미리보기 (편집 가능)</div>
                  {[
                    { k: 'date', label: '평가일' },
                    { k: 'name', label: '종목명' },
                    { k: 'ticker', label: '종목코드' },
                    { k: 'market', label: '시장' },
                    { k: 'conclusion', label: '결론' },
                    { k: 'status', label: '매수여부' },
                    { k: 'buyDate', label: '매수일' },
                    { k: 'buyPrice', label: '매수가' },
                    { k: 'targetTerm', label: '목표기간' },
                    { k: 'targetRet', label: '목표수익률' },
                    { k: 'aiNote', label: 'AI 의견' },
                    { k: 'frankMemo', label: 'Frank 메모' },
                  ].map(({ k, label }) => (
                    <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <div style={{ width: 80, fontSize: 10, color: '#5A6478', textAlign: 'right', flexShrink: 0 }}>{label}</div>
                      <input
                        value={evalIngestParsed[k] || ''}
                        onChange={(e) => setEvalIngestParsed({ ...evalIngestParsed, [k]: e.target.value })}
                        style={{
                          flex: 1, background: '#0F1218', border: '1px solid #2A2F3E',
                          borderRadius: 4, padding: '4px 8px', color: '#E8EAF0', fontSize: 11,
                          fontFamily: baseFont, outline: 'none',
                        }}
                      />
                    </div>
                  ))}

                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4 }}>5축 등급</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {Object.entries(evalIngestParsed.grades).map(([axis, val]) => (
                        <div key={axis} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ fontSize: 10, color: '#9CA3AF' }}>{axis}</span>
                          <input
                            value={val}
                            onChange={(e) => setEvalIngestParsed({
                              ...evalIngestParsed,
                              grades: { ...evalIngestParsed.grades, [axis]: e.target.value },
                            })}
                            style={{
                              width: 44, background: '#0F1218', border: '1px solid #2A2F3E',
                              borderRadius: 4, padding: '3px 6px', color: '#E8EAF0', fontSize: 11,
                              textAlign: 'center', fontFamily: baseFont, outline: 'none',
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ marginTop: 10, fontSize: 10, color: '#5A6478' }}>
                    근거 {evalIngestParsed.reasons.length}건 · 리스크 {evalIngestParsed.risks.length}건 · 액션 {evalIngestParsed.actions.length}건
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── 평가 의뢰 모달 ── */}
        {evalQueueOpen && (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, zIndex: 200,
          }} onClick={(e) => { if (e.target === e.currentTarget) setEvalQueueOpen(false); }}>
            <div style={{
              background: '#1A1D26', borderRadius: 12, width: '100%', maxWidth: 420,
              maxHeight: '90vh', overflowY: 'auto', padding: '20px 18px',
              border: '1px solid #2A2F3E',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#F5A623' }}>평가 의뢰</div>
                <button onClick={() => setEvalQueueOpen(false)} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: '#5A6478', fontSize: 18, padding: 0, lineHeight: 1,
                }}>✕</button>
              </div>

              {/* 종목명 */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4, letterSpacing: 1 }}>종목명</div>
                <input
                  value={evalQueueName}
                  onChange={(e) => { setEvalQueueName(e.target.value); setEvalQueueMsg(''); }}
                  placeholder="예: 삼성전자 또는 NVDA"
                  autoFocus
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: '#0F1218', border: '1px solid #2A2F3E',
                    borderRadius: 6, padding: '8px 10px', color: '#E8EAF0', fontSize: 13,
                    fontFamily: baseFont, outline: 'none',
                  }}
                />
              </div>

              {/* 시장 */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4, letterSpacing: 1 }}>시장</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['KR', 'US'].map(m => (
                    <button key={m} onClick={() => setEvalQueueMarket(m)} style={{
                      flex: 1, padding: '8px 12px', borderRadius: 6,
                      border: `1px solid ${evalQueueMarket === m ? '#3B82F6' : '#2A2F3E'}`,
                      background: evalQueueMarket === m ? '#1E3A5F' : 'transparent',
                      color: evalQueueMarket === m ? '#60A5FA' : '#9CA3AF',
                      cursor: 'pointer', fontSize: 11, fontFamily: baseFont, fontWeight: 600,
                    }}>{m}</button>
                  ))}
                </div>
              </div>

              {/* 메모 */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4, letterSpacing: 1 }}>메모 (선택)</div>
                <input
                  value={evalQueueMemo}
                  onChange={(e) => setEvalQueueMemo(e.target.value)}
                  placeholder="평가 시 참고할 맥락 (예: 1분기 어닝 후 재평가)"
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: '#0F1218', border: '1px solid #2A2F3E',
                    borderRadius: 6, padding: '8px 10px', color: '#E8EAF0', fontSize: 12,
                    fontFamily: baseFont, outline: 'none',
                  }}
                />
              </div>

              <button onClick={submitEvalQueue} disabled={!evalQueueName.trim() || evalQueueBusy} style={{
                width: '100%', padding: '10px 12px', borderRadius: 6, border: 'none',
                background: (evalQueueName.trim() && !evalQueueBusy) ? '#F5A623' : '#2A2F3E',
                color: (evalQueueName.trim() && !evalQueueBusy) ? '#1A1D26' : '#5A6478',
                cursor: (evalQueueName.trim() && !evalQueueBusy) ? 'pointer' : 'not-allowed',
                fontSize: 12, fontWeight: 700, fontFamily: baseFont,
              }}>
                {evalQueueBusy ? '추가 중...' : '큐에 추가'}
              </button>

              {evalQueueMsg && (
                <div style={{
                  marginTop: 10, padding: '8px 12px', borderRadius: 6,
                  background: '#0F1218', fontSize: 11,
                  color: evalQueueMsg.startsWith('✓') ? '#4ADE80'
                       : evalQueueMsg.startsWith('⚠️') ? '#F59E0B'
                       : evalQueueMsg.includes('실패') ? '#F87171' : '#9CA3AF',
                  lineHeight: 1.5,
                }}>{evalQueueMsg}</div>
              )}

              {/* 큐 미리보기 */}
              {evalQueue.entries.length > 0 && (
                <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #2A2F3E' }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: '#5A6478', marginBottom: 8 }}>
                    최근 의뢰 ({evalQueue.entries.length}건)
                  </div>
                  {evalQueue.entries.slice(0, 5).map((e, i) => (
                    <div key={i} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '6px 0', fontSize: 10, borderBottom: i < 4 ? '1px solid #1E2233' : 'none',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span style={{
                          fontSize: 9, padding: '1px 6px', borderRadius: 3,
                          background: e.status === '완료' ? '#1E3D2A'
                                    : e.status === '처리중' ? '#1E3A5F'
                                    : e.status === '오류' ? '#4A1E1E' : '#3D2E14',
                          color: e.status === '완료' ? '#4ADE80'
                               : e.status === '처리중' ? '#60A5FA'
                               : e.status === '오류' ? '#F87171' : '#F5A623',
                        }}>{e.status}</span>
                        <span style={{ color: '#E8EAF0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {e.name}
                        </span>
                        {e.market && <span style={{ color: '#5A6478', fontSize: 9 }}>{e.market}</span>}
                      </div>
                      <span style={{ color: '#5A6478', fontSize: 9, flexShrink: 0, marginLeft: 8 }}>
                        {e.requestedAt.slice(5)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── 학습 모듈 슬라이드 패널 ── */}
        {evalSelectedMetric && LEARNING_MODULES[evalSelectedMetric] && (
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0,
            background: '#1A1D26', borderTop: '2px solid #3B82F6',
            padding: '16px 20px 24px', maxHeight: '60vh', overflowY: 'auto',
            boxShadow: '0 -8px 30px rgba(0,0,0,0.6)', zIndex: 100,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#60A5FA', display: 'flex', alignItems: 'center', gap: 6 }}>
                📘 {LEARNING_MODULES[evalSelectedMetric].title}
              </div>
              <button onClick={() => setEvalSelectedMetric(null)} style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: '#5A6478', fontSize: 18, padding: 0, lineHeight: 1,
              }}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: '#E8EAF0', lineHeight: 1.6, marginBottom: 10 }}>
              {LEARNING_MODULES[evalSelectedMetric].summary}
            </div>
            <div style={{ background: '#0F1218', borderRadius: 6, padding: '8px 12px', fontSize: 11, color: '#9CA3AF', lineHeight: 1.5 }}>
              <span style={{ color: '#F5A623', marginRight: 6 }}>임계값</span>
              {LEARNING_MODULES[evalSelectedMetric].threshold}
            </div>
          </div>
        )}

      </div>

      <div style={{ padding: "12px 16px 32px", textAlign: "center", fontSize: 9, color: "#2A2F3E", letterSpacing: 2 }}>
        2026-04-25 · 바나나 은퇴 준비 포트폴리오
      </div>
    </div>
  );
}
