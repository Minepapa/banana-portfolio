import { useState, useEffect, useCallback, useRef } from "react";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from "recharts";
import guideRaw from "../docs/USER-GUIDE.md?raw";
// 도움말 탭: 상단 H1·인트로(첫 --- 이전)는 앱에서 SectionTitle로 대체 → 본문만 렌더
const guideBody = String(guideRaw).replace(/\r\n/g, '\n').replace(/^[\s\S]*?\n---\n/, '');

// ── 도움말: USER-GUIDE.md 경량 마크다운 렌더러 ───────────────────────────────────
// 가이드에서 실제 쓰는 문법만 처리(헤더·표·리스트·인용·hr·볼드/이탤릭/코드/링크).
// 이모지·픽토그램·별표 제거 후 중복 공백 정리 (도움말은 텍스트만 표시)
function stripEmoji(text) {
  return String(text)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function mdInline(text) {
  text = stripEmoji(text);
  const out = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={k++} style={{ color: '#E8EAF0', fontWeight: 700 }}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={k++} style={{ color: '#B6BECC', fontStyle: 'italic' }}>{m[2]}</em>);
    else if (m[3] !== undefined) out.push(<code key={k++} style={{ background: '#0F1218', color: '#9CD7C0', padding: '1px 5px', borderRadius: 4, fontSize: '0.92em', fontFamily: 'ui-monospace, Menlo, monospace' }}>{m[3]}</code>);
    else out.push(<a key={k++} href={m[5]} style={{ color: '#60A5FA', textDecoration: 'none' }}>{m[4]}</a>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const blocks = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    // hr
    if (/^---+$/.test(line.trim())) { blocks.push(<hr key={key++} style={{ border: 'none', borderTop: '1px solid #2A2F3E', margin: '22px 0' }} />); i++; continue; }
    // 헤더
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const content = mdInline(h[2]);
      if (h[1].length === 1) blocks.push(<h1 key={key++} style={{ fontSize: 18, fontWeight: 800, color: '#E8EAF0', margin: '4px 0 14px' }}>{content}</h1>);
      else if (h[1].length === 2) blocks.push(<h2 key={key++} style={{ fontSize: 15, fontWeight: 700, color: '#60A5FA', margin: '24px 0 10px' }}>{content}</h2>);
      else blocks.push(<h3 key={key++} style={{ fontSize: 13, fontWeight: 700, color: '#F5A623', margin: '18px 0 8px' }}>{content}</h3>);
      i++; continue;
    }
    // 인용
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i++; }
      blocks.push(<blockquote key={key++} style={{ borderLeft: '3px solid #3B82F6', background: '#161A23', padding: '8px 12px', margin: '12px 0', color: '#9CA3AF', fontSize: 12, lineHeight: 1.6, borderRadius: '0 6px 6px 0' }}>{quote.map((q, qi) => <div key={qi}>{mdInline(q)}</div>)}</blockquote>);
      continue;
    }
    // 표
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1].trim()) && lines[i + 1].includes('-')) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
      blocks.push(
        <div key={key++} style={{ overflowX: 'auto', margin: '12px 0' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11 }}>
            <thead><tr>{header.map((c, ci) => <th key={ci} style={{ textAlign: 'left', padding: '7px 9px', background: '#1E2233', color: '#9CA3AF', borderBottom: '1px solid #2A2F3E', fontWeight: 700, whiteSpace: 'nowrap' }}>{mdInline(c)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} style={{ padding: '7px 9px', color: '#C2C8D4', borderBottom: '1px solid #20242F', verticalAlign: 'top', lineHeight: 1.5 }}>{breakUnits(c).map((ln, li) => <div key={li}>{mdInline(ln)}</div>)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      continue;
    }
    // 순서 없는 리스트
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const indent = lines[i].match(/^(\s*)/)[1].length;
        items.push({ indent, text: lines[i].replace(/^\s*[-*]\s+/, '') });
        i++;
      }
      blocks.push(<ul key={key++} style={{ margin: '8px 0', paddingLeft: 18, color: '#C2C8D4', fontSize: 12, lineHeight: 1.7 }}>{items.map((it, ii) => <li key={ii} style={{ marginLeft: it.indent >= 2 ? 16 : 0 }}>{mdInline(it.text)}</li>)}</ul>);
      continue;
    }
    // 순서 있는 리스트
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      blocks.push(<ol key={key++} style={{ margin: '8px 0', paddingLeft: 22, color: '#C2C8D4', fontSize: 12, lineHeight: 1.7 }}>{items.map((it, ii) => <li key={ii}>{mdInline(it)}</li>)}</ol>);
      continue;
    }
    // 문단
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3}\s|>\s?|---+\s*$|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i]) && !lines[i].trim().startsWith('|')) {
      para.push(lines[i]); i++;
    }
    blocks.push(<p key={key++} style={{ margin: '8px 0', color: '#C2C8D4', fontSize: 12, lineHeight: 1.7 }}>{para.map((pl, pi) => <span key={pi}>{pi > 0 && <br />}{mdInline(pl)}</span>)}</p>);
  }
  return blocks;
}

// ── 섹션/카드 제목: 중앙 정렬 + 색 밑줄 강조 ─────────────────────────────────────
function SectionTitle({ children, color = '#3B82F6', sub, size = 13, mb = 16 }) {
  return (
    <div style={{ textAlign: 'center', marginBottom: mb }}>
      <div style={{ fontSize: size, fontWeight: 700, letterSpacing: 0.5, color: '#E8EAF0' }}>{children}</div>
      {sub != null && sub !== '' && <div style={{ fontSize: 10, color: '#5A6478', marginTop: 4, lineHeight: 1.5 }}>{sub}</div>}
      <div style={{ width: 26, height: 3, borderRadius: 2, background: color, margin: '8px auto 0' }} />
    </div>
  );
}

// ── 등급 표시: 🟢🟡🔴⚪ → 폰트 비의존 CSS 원 ───────────────────────────────────
const GRADE_COLORS = { '🟢': '#10B981', '🟡': '#F5C842', '🔴': '#EF4444', '⚪': '#6B7280' };
function gradeColor(s) {
  const str = String(s ?? '');
  for (const k of Object.keys(GRADE_COLORS)) if (str.includes(k)) return GRADE_COLORS[k];
  return '#6B7280';
}
function GradeDot({ grade, size = 9 }) {
  return <span style={{ width: size, height: size, borderRadius: '50%', background: gradeColor(grade), flexShrink: 0, display: 'inline-block' }} />;
}
function stripGrade(s) {
  return String(s ?? '').replace(/[🟢🟡🔴⚪]/g, '').trim();
}
// 항목명에서 연도·분기 표기(중복) 제거 — 출처는 숫자 아래에 따로 표기됨.
// "RSI(14)" 같은 파라미터 괄호는 보존(연도/분기 토큰이 있을 때만 제거).
function stripPeriod(label) {
  const PERIOD = /\d{4}|분기|반기|연간|[1-4]\s*분기|[1-4]\s*Q|Q[1-4]|FY\d|TTM/i;
  return String(label ?? '')
    .replace(/\s*[([][^)\]]*[)\]]\s*$/g, (m) => (PERIOD.test(m) ? '' : m))
    .replace(/\s*[,·]\s*(?:[^,·()]*(?:\d{4}|분기|반기|연간|TTM|Q[1-4])[^,·()]*)\s*$/i, '')
    .trim();
}

// ── 마침표·의미(— · 등) 단위로 줄바꿈 ───────────────────────────────────────────
function breakUnits(text) {
  return String(text ?? '')
    .replace(/\s*[—–]\s*/g, '\n')          // 줄표 → 의미 끊김
    .replace(/\s+→\s+/g, '\n')             // 흐름 화살표(공백 양옆) → 단계 줄바꿈
    .replace(/([.。!?…])\s+/g, '$1\n')      // 문장 종결 뒤 → 줄바꿈
    .split('\n').map(s => s.trim()).filter(Boolean);
}
// 문장 종결(. 。 ! ? …) 뒤에서만 줄바꿈 — — · → 는 끊지 않음(카드 끝까지 채움).
function breakSentences(text) {
  return String(text ?? '')
    .replace(/([.。!?…])\s+/g, '$1\n')
    .split('\n').map(s => s.trim()).filter(Boolean);
}
// 문장 단위로 각 줄을 렌더(공통 스타일 적용). sentenceOnly=true면 문장 종결에서만 줄바꿈.
function Sentences({ text, style, sentenceOnly }) {
  const lines = sentenceOnly ? breakSentences(text) : breakUnits(text);
  return lines.map((l, i) => <div key={i} style={style}>{l}</div>);
}
// 소제목 캡션: 색 점 + 라벨(좌측, 리스트 머리)
function SubLabel({ children, color = '#5A6478' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: '#7A8499' }}>{children}</span>
    </div>
  );
}
// 번호 매김 리스트: 번호 열 + 문장 단위 줄바꿈
function NumberedItem({ n, text, color = '#9CA3AF', numColor = '#5A6478' }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 7 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: numColor, flexShrink: 0, lineHeight: 1.6 }}>{n}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {breakUnits(text).map((l, i) => (
          <div key={i} style={{ fontSize: 11, color, lineHeight: 1.6 }}>{l}</div>
        ))}
      </div>
    </div>
  );
}

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
  월별잔고:     '월별잔고!A2:J',       // 8  (I=KOSPI지수, J=S&P500지수)
  배당금:       '배당금!A2:C',         // 9
  수익금:       '수익금!A2:F',         // 10
  평가노트:     '종목투자노트!A2:U',   // 11  (없거나 비어있어도 안전)
  평가요청:     '평가요청!A2:F',       // 12  비동기 평가 의뢰 큐 (모바일에서 추가 → Claude Pro가 처리)
  주간리포트:   '주간리포트!A2:C',     // 13  주간 AI 리포트 (날짜, 요약, 본문)
  리스크모니터: '리스크모니터!A2:H',   // 14  AI 리스크 신호 (날짜,유형,대상,신호,요약,상세,근거,기준선참조)
  리스크기준선: '리스크기준선!A2:J',   // 15  펀더멘털 기준선 (종목,티커,시장,기준일,매총이,영익,ROE,부채,EPS,비고)
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
  revenue_growth:   { title: '매출성장률 YoY', summary: '작년 같은 분기 대비 매출이 몇 % 늘었나. 회사의 외형 성장 속도. 마진과 함께 봐야 의미 있음.', threshold: 'Frank 확정: 10%+ 3년 유지면 성장주로 분류. 마진 동시 상승이면 강력.' },
  operating_margin: { title: '영업이익률', summary: '본업으로 매출 100원에 영업단계 얼마 남는지. 동종 평균 1.5배 이상이면 가격결정력 강함.', threshold: 'Frank: 동종 대비 1.5배 + 3년 추세 평탄/상승이면 매수 근거' },
  gross_margin:     { title: '매출총이익률 (Gross Margin)', summary: '매출에서 원가를 빼고 남는 비율. 회사의 원가 경쟁력과 가격결정력의 1차 지표. 영업이익률의 상한선.', threshold: 'Frank: 50%+ 소프트웨어/플랫폼급, 30~50% 제조업 우수, 20% 미만 → 가격 경쟁 치열' },
  roe:              { title: 'ROE (자기자본이익률)', summary: '주주 자본 대비 순이익. 자기 돈을 굴려 얼마 벌었는지. 부채 레버리지 포함이라 ROIC와 함께 봐야 정확.', threshold: 'Frank: 15%+ 3년 유지면 우수. 단 부채비율 100% 이상이면 레버리지 효과 감안 필요' },
  roic:             { title: 'ROIC (투하자본수익률)', summary: '빚+자기자본을 굴려 얼마 남기는지. 15% 이상 5년 유지면 해자(moat) 강력. ROE보다 정직.', threshold: 'Frank: 15% 이상 5년 평균 → 매수 후보, 10% 미만 → 신중' },

  // 재무 안정성
  debt_ratio:       { title: '부채비율', summary: '부채총계 ÷ 자기자본. 100%면 빚과 자본이 같다는 뜻. 업종마다 정상 범위 다름.', threshold: 'Frank: 제조업 < 100% 양호, 금융업은 별도 기준. 200% 초과 → 재무 리스크 점검' },
  equity_ratio:     { title: '자기자본비율', summary: '자기자본 ÷ 총자산. 높을수록 재무 안전. 부채비율의 역수 관계.', threshold: 'Frank: 50%+ 양호, 30~50% 보통, 30% 미만 → 차입 의존도 높음' },
  debt_to_equity:   { title: 'D/E (부채자본비율)', summary: '총부채 ÷ 자기자본. 부채비율과 동일 개념이나 US 기업 분석에서 주로 사용. 낮을수록 안전.', threshold: 'Frank: 테크 < 50% 양호, 유틸리티/리츠는 100%+ 정상. 업종 맥락 필수' },
  net_cash:         { title: '순현금', summary: '보유 현금 − 총차입금. 양수면 빚보다 현금이 많아 재무 안전. 음수(순부채)면 차입 의존.', threshold: 'Frank: 순현금 양수 → 재무 리스크 낮음. 순부채 전환 추세면 경계' },
  net_debt_ebitda:  { title: '순부채/EBITDA', summary: '회사가 번 돈(EBITDA)으로 빚을 갚는 데 몇 년 걸리는지. 1배 이하면 빚 부담 없음, 3배 이상이면 위험.', threshold: 'Frank: < 1배 양호, 1~3배 보통, > 3배 신중. 사이클 산업은 더 보수적으로' },
  interest_coverage:{ title: '이자보상배율 (EBIT/이자비용)', summary: '영업이익으로 이자를 몇 번 갚을 수 있는지. 5배 이상이 안전선, 2배 이하면 위험.', threshold: 'Frank: > 5배 안전, 3~5 보통, < 3 신중. 금리 상승기엔 5배 이상 권장' },
  current_ratio:    { title: '유동비율', summary: '1년 안에 갚을 빚(유동부채) 대비 1년 안에 현금화 가능한 자산(유동자산). 150%+ 양호.', threshold: 'Frank: > 150% 양호, 100~150% 보통, < 100% 단기 유동성 리스크' },

  // 밸류에이션
  fwd_per:          { title: 'Forward PER 5년 밴드', summary: '애널리스트 컨센서스 예상 EPS 기준 PER이 지난 5년 밴드 어디인지. 자기 자신과의 비교라 업종 차이를 흡수. 미래 이익에 대한 기대를 반영해 Trailing PER보다 낮게 나오는 경우가 많음.', threshold: 'Frank: 밴드 P25 이하 + 펀더멘털 OK → 적극 매수, P75 이상 → 보류' },
  trailing_per:     { title: 'Trailing PER (실적 PER)', summary: '지난 12개월(LTM/TTM) 실제 EPS 기준 PER. 이미 확인된 이익을 기반으로 현재 주가 수준을 평가. 추정 오차 없이 사실 기반.\n\nForward PER과 비교:\n· Trailing > Forward → 시장이 이익 증가를 기대\n· Trailing < Forward → 이익 감소 우려', threshold: '동종 업종 평균 대비 낮으면 저평가 신호. 단, 일시적 이익 급증으로 낮아 보일 수 있으니 Forward PER, EV/EBITDA와 함께 비교할 것.' },
  ev_ebitda:        { title: 'EV/EBITDA', summary: '회사 전체 가격(EV) ÷ 본업 현금이익(EBITDA). PER보다 부채·세금·감가상각 영향 제거해 더 정직.', threshold: 'Frank: < 8배 저평가, 8~12 보통, > 15 고평가. 동종/5년 밴드와 같이' },
  pbr:              { title: 'PBR (주가순자산비율)', summary: '주가 ÷ 주당순자산. 회사를 청산해서 받는 돈 대비 시장가. 1배 이하 = 청산가치 미달.', threshold: 'Frank: 자산형 회사(은행·금융지주) 0.5~1배, 성장주는 PBR로 판단하지 말 것' },
  peg:              { title: 'PEG (PER ÷ 성장률)', summary: 'PER을 이익성장률로 나눈 값. 성장 속도 대비 주가가 비싼지 판단. 1 미만이면 성장 대비 저평가, 2 이상이면 성장을 이미 다 반영.', threshold: 'Frank: < 0.8 적극 매수, 0.8~1.2 합리적, 1.5+ 성장 프리미엄 과다. 단 적자 전환 시 무의미' },
  ps_ratio:         { title: 'P/S (주가매출비율)', summary: '시가총액 ÷ 매출. 적자 기업이나 고성장 기업에서 PER 대신 사용. 매출 1원에 시장이 얼마를 지불하는지.', threshold: 'Frank: SaaS/플랫폼 10~20x 정상, 제조업 1~3x. 같은 업종 내 비교 필수' },

  // 현금흐름
  fcf_yield:        { title: 'FCF yield', summary: 'FCF/시가총액. 시가총액 대비 매년 회수되는 현금. 회계이익은 거짓말 가능, 현금은 사실.', threshold: 'Frank: 매수 시 영업이익만 보지 말 것. 배당주는 FCF 커버리지 80% 마지노선' },
  payout_ratio:     { title: '배당성향', summary: '순이익 중 배당으로 나가는 비율. 70% 넘으면 성장 재투자 여력 적음, 100% 넘으면 배당컷 임박.', threshold: 'Frank 확정: 40~60% 이상적 (메리츠금융지주형 균형). 80%+면 FCF 커버리지 같이 확인.' },
  dividend_sustainability:{ title: '배당지속가능성 (FCF 커버리지)', summary: '배당총액/FCF. 회사가 버는 현금으로 배당을 얼마나 여유롭게 지급하나. 80% 넘으면 배당컷 리스크.', threshold: 'Frank: < 80% 안전, 80~100% 경계, > 100% 배당컷 경보' },

  // 모멘텀
  rsi:              { title: 'RSI (상대강도지수)', summary: '14거래일 상승/하락 비율. 30 이하 = 일방적 매도세(반등 확률↑), 70 이상 = 과열.', threshold: 'RSI 30 이하 → 적극 매수 / 70 이상 → 일부 차익실현' },
  pos_52w:          { title: '52주 위치', summary: '현재가가 52주 최저~최고 어디인지. 하단 20% = 저점 매수, 상단 80% = 차익실현 검토.', threshold: '52주 고점 +20% 초과 → 일부 매도 / ≤20% + 펀더멘털 OK → 적극 매수' },
  foreign_flow:     { title: '외국인·기관 수급', summary: '한국 시장에서 외국인은 시총 ~35% 보유, 시장 방향 결정. 4거래일 흐름 + 환율 같이.', threshold: 'Frank: 외국인 4일 연속 순매도 → 추가 매수 보류 / 동반 순매수 4일 → 적립식 가속' },
  sector_rs:        { title: '섹터 상대강도', summary: '해당 섹터 ETF 수익률 − 시장 지수 수익률. 양수면 섹터가 시장을 이기는 중, 강세 모멘텀 시그널.', threshold: 'Frank: 보유 섹터의 RS가 4주 연속 양수면 비중 유지/확대, 음수 전환 시 점검' },

  // KPI (운용)
  twr:    { title: 'TWR (시간가중수익률)',
    summary: '저축·입금 효과를 제거하고 순수 운용 실력만 측정하는 지표.\n\n"단순 수익률은 얼마 벌었나, TWR은 운용을 잘했나."\n\n고점에 많이 입금하고 저점에 적게 입금하면 운용이 좋아도 단순 수익률은 낮게 나온다. TWR은 그 왜곡을 제거한다. 단순 수익률 vs TWR의 차이가 곧 타이밍 효과 — 실력은 TWR만 본다. 펀드·ETF·기관 모두 표준.',
    threshold: 'Frank 확정: 연 TWR 시장 혼합(KOSPI:S&P500=50:50) 대비 +3~5%p 목표.\n· +3%p 미만 → 인덱스 ETF 위주 운용이 더 효율적일 수 있다는 신호\n· +5%p 초과 → 매우 우수, 종목 선별 운 가능성 점검' },
  sharpe: { title: '샤프 비율 (위험 효율)',
    summary: '(수익률 − 무위험수익률) ÷ 표준편차. "위험 1단위당 초과 수익."\n\n같은 +30% 수익이라도:\n· 변동성 10% → 샤프 ~3.0 (매우 우수)\n· 변동성 50% → 샤프 ~0.6 (평범)\n\n수익률만 보면 무모한 운용이 이긴다. 샤프는 "별점과 표준편차를 같이 본다."',
    threshold: '샤프 해석:\n· < 0.5: 비효율\n· 0.5~1.0: 평범\n· 1.0~2.0: 좋음\n· 2.0+: 매우 우수(장기 유지 어려움)\n\nFrank 확정: 1년 샤프 0.8~1.2 목표. 0.8 미만 → 위험 대비 효율이 시장 평균과 큰 차이 없음 → 자산배분 점검.' },
  mdd:    { title: '최대낙폭 (MDD)',
    summary: '일정 기간 최고점 대비 최저점까지의 하락폭(%). "운용의 가장 어두운 골짜기."\n\n같은 연 +10%여도:\n· MDD −10% 운용 vs MDD −50% 운용\n→ 완전히 다른 경험. 후자는 중간에 패닉 매도할 확률이 훨씬 높다.\n\n평균은 행복해 보여도 거기서 못 견디고 던지면 평균은 의미 없다. 회복 시간(months to recovery)도 함께 봐야 한다.',
    threshold: 'Frank 확정:\n· 1년 MDD −25% 이내\n· 3년 MDD −35% 이내\n· 회복 12개월 이내\n이 한계 넘으면 패닉 매도 위험↑ → 자산배분 보수화 검토.' },
};

// 5축 → 학습 모듈 metric key. 시트 적재 카드는 axis grade만 있어 지표별 📘가 안 보이므로
// axis 단위로 학습 모듈 진입 칩을 묶어 보여준다.
const AXIS_METRICS = {
  '수익성':     ['revenue_growth', 'operating_margin', 'gross_margin', 'roe', 'roic'],
  '재무 안정성': ['debt_ratio', 'equity_ratio', 'debt_to_equity', 'net_cash', 'net_debt_ebitda', 'interest_coverage', 'current_ratio'],
  '밸류에이션':  ['fwd_per', 'trailing_per', 'ev_ebitda', 'pbr', 'peg', 'ps_ratio'],
  '현금흐름':    ['fcf_yield', 'payout_ratio', 'dividend_sustainability'],
  '모멘텀':      ['rsi', 'pos_52w', 'foreign_flow', 'sector_rs'],
};

// 항목 label → metric key (item.metric 없을 때 자동 추론용)
const LABEL_TO_METRIC = {
  '매출성장률 yoy': 'revenue_growth', '매출성장률': 'revenue_growth',
  '영업이익률': 'operating_margin',
  '매출총이익률': 'gross_margin', 'gross margin': 'gross_margin', '매출총이익률 (gross margin)': 'gross_margin',
  'roe': 'roe', 'roe (자기자본이익률)': 'roe', '자기자본이익률': 'roe',
  'roic': 'roic', 'roic (투하자본수익률)': 'roic',
  '부채비율': 'debt_ratio',
  '자기자본비율': 'equity_ratio',
  'd/e': 'debt_to_equity', 'd/e (부채자본비율)': 'debt_to_equity', '부채자본비율': 'debt_to_equity',
  '순현금': 'net_cash',
  '순부채/ebitda': 'net_debt_ebitda',
  '이자보상배율': 'interest_coverage', '이자보상배율 (ebit/이자비용)': 'interest_coverage',
  '유동비율': 'current_ratio',
  'forward per': 'fwd_per', 'forward per 5년 밴드': 'fwd_per', 'fwd per': 'fwd_per',
  'trailing per': 'trailing_per', 'trailing per (ttm)': 'trailing_per', 'per (ttm)': 'trailing_per', 'trailing p/e': 'trailing_per',
  'ev/ebitda': 'ev_ebitda',
  'pbr': 'pbr', 'pbr (주가순자산비율)': 'pbr',
  'peg': 'peg', 'peg (per ÷ 성장률)': 'peg',
  'p/s': 'ps_ratio', 'p/s (주가매출비율)': 'ps_ratio', '주가매출비율': 'ps_ratio',
  'fcf yield': 'fcf_yield',
  '배당성향': 'payout_ratio',
  '배당지속가능성': 'dividend_sustainability', '배당지속가능성 (fcf 커버리지)': 'dividend_sustainability', '배당커버': 'dividend_sustainability',
  'rsi': 'rsi', 'rsi(14)': 'rsi', 'rsi (상대강도지수)': 'rsi',
  '52주 위치': 'pos_52w',
  '외국인·기관 수급': 'foreign_flow', '외국인 4일': 'foreign_flow', '외국인·기관': 'foreign_flow',
  '섹터 상대강도': 'sector_rs',
  'twr': 'twr', 'twr (시간가중수익률)': 'twr',
  '샤프 비율': 'sharpe', 'sharpe': 'sharpe',
  '최대낙폭': 'mdd', 'mdd': 'mdd', '최대낙폭 (mdd)': 'mdd',
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
    '1회 500만원 미만 분할 매수 가능.',
    '외국인 4일 흐름이 순매수 전환 후 1차 진입 권장.',
    '52주 위치 60% 이하로 눌림 발생 시 추가 매수 트리거.',
  ],
  sources: [
    'OpenDart Q1 2026 (조회일 2026-05-17)',
    'NaverFinance 종목페이지 (조회일 2026-05-17)',
    '5/17 weekly_report 외부 변수',
  ],
};

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
function computeBehaviorMetrics(kpiTrades, evaluations) {
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
      return String(r.row?.[5]||'').trim() === String(ev.stock?.name||'').trim()
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
      return String(ev.stock?.name||'').trim() === nm && !isNaN(evTs) && evTs <= sellTs && evTs >= sellTs - windowMs;
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
  };
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
    const kospi  = parseNum(r[8]);   // I열: KOSPI 월말 지수 (0이면 미입력)
    const sp500  = parseNum(r[9]);   // J열: S&P500 월말 지수 (0이면 미입력)
    result.push({ label: `${yearShort}.${String(month).padStart(2, '0')}`, value: total, savings, year: lastYear, kospi, sp500 });
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
  (vrAll?.values ?? []).forEach((r, i) => {
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
    // row: 배당금!A2:C 기준 시트 행번호 (종목명 편집 시 C열 타겟)
    result[key].items.push({ date: dateStr, name, amount: amt, row: i + 2 });
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

// 결론(E) 표준 어휘 — 단일 통합 4단계 (매수·매도 공통). 이모지가 표준 단어를 결정.
const CONCLUSION_STD = { '🟢': '🟢 유효', '🟡': '🟡 관망', '🔴': '🔴 부적합', '⚪': '⚪ 판단보류' };
function normalizeConclusion(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  // 이모지 우선 (includes — 정규식 charclass의 surrogate 깨짐 회피)
  if (s.includes('🟢')) return CONCLUSION_STD['🟢'];
  if (s.includes('🟡')) return CONCLUSION_STD['🟡'];
  if (s.includes('🔴')) return CONCLUSION_STD['🔴'];
  if (s.includes('⚪')) return CONCLUSION_STD['⚪'];
  // 이모지 없으면 단어로 추정 (구체→일반 순서)
  if (/판단\s*보류/.test(s)) return CONCLUSION_STD['⚪'];
  if (/부적합|훼손|불가|매도|\bX\b/i.test(s)) return CONCLUSION_STD['🔴'];
  if (/관망|약화|보류|축소|△/.test(s)) return CONCLUSION_STD['🟡'];
  if (/유효|적합|매수|\bO\b/i.test(s)) return CONCLUSION_STD['🟢'];
  return s;
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
      conclusion: { raw: normalizeConclusion(r[4]) },
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

// 주간리포트 파서 (날짜, 요약, 본문) → 최신순 배열
function parseWeeklyReports(vr) {
  const rows = vr?.values ?? [];
  return rows.map(r => {
    const date = String(r[0] ?? '').trim();
    if (!date) return null;
    return { date, summary: String(r[1] ?? '').trim(), body: String(r[2] ?? '').trim() };
  }).filter(Boolean).reverse();
}

// 리스크모니터 파서 (날짜,유형,대상,신호,요약,상세,근거,기준선참조) → 최신순
function parseRiskMonitor(vr) {
  const rows = vr?.values ?? [];
  return rows.map(r => {
    const date = String(r[0] ?? '').trim();
    if (!date) return null;
    return {
      date,
      type: String(r[1] ?? '').trim(),       // B(논리) | D(거시)
      target: String(r[2] ?? '').trim(),
      signal: String(r[3] ?? '').trim(),     // 🟢 | 🟡 | 🔴
      summary: String(r[4] ?? '').trim(),
      detail: String(r[5] ?? '').trim(),
      evidence: String(r[6] ?? '').trim(),   // JSON 문자열
      baselineRef: String(r[7] ?? '').trim(),
    };
  }).filter(Boolean).reverse();
}

// 리스크기준선 파서 (종목,티커,시장,기준일,매총이,영익,ROE,부채,EPS,비고)
function parseBaselines(vr) {
  const rows = vr?.values ?? [];
  return rows.map(r => {
    const name = String(r[0] ?? '').trim();
    if (!name) return null;
    return {
      name,
      ticker: String(r[1] ?? '').trim(),
      market: String(r[2] ?? '').trim(),
      date: String(r[3] ?? '').trim(),
      grossMargin: String(r[4] ?? '').trim(),
      operatingMargin: String(r[5] ?? '').trim(),
      roe: String(r[6] ?? '').trim(),
      debtRatio: String(r[7] ?? '').trim(),
      eps: String(r[8] ?? '').trim(),
      note: String(r[9] ?? '').trim(),
    };
  }).filter(Boolean);
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
  const weeklyReports = parseWeeklyReports(valueRanges[13]);
  const riskMonitor = parseRiskMonitor(valueRanges[14]);
  const baselines = parseBaselines(valueRanges[15]);

  return anyData ? { accounts: result, monthly, monthlyRow, dividends, profits, evaluations, evalQueue, weeklyReports, riskMonitor, baselines } : null;
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
          weeklyReports: parsed.weeklyReports,
          riskMonitor: parsed.riskMonitor,
          baselines: parsed.baselines,
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
  const [holdSort, setHoldSort] = useState('sheet'); // sheet | rate_desc | rate_asc | eval_desc | profit_desc
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
  const [editingDivRow, setEditingDivRow] = useState(null); // 배당 종목명 편집 중인 시트 행
  const [editDivName, setEditDivName] = useState('');
  const [divSaving, setDivSaving] = useState(false);
  const divLongPress = useRef(null); // 종목명 롱프레스 타이머
  const [selectedDivKey, setSelectedDivKey] = useState(null);
  const [monthYear, setMonthYear] = useState('전체');
  const [tradeRows, setTradeRows] = useState([]);
  const [tradeSyncing, setTradeSyncing] = useState(false);
  const [kpiTrades, setKpiTrades] = useState(null); // null=미로딩, []이상=로딩완료
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
  const [evaluations, setEvaluations] = useState([]);
  const [evalSelectedIdx, setEvalSelectedIdx] = useState(0);
  const [evalIngestOpen, setEvalIngestOpen] = useState(false);
  const [evalIngestRaw, setEvalIngestRaw] = useState('');
  const [evalIngestParsed, setEvalIngestParsed] = useState(null);
  const [evalIngestMsg, setEvalIngestMsg] = useState('');
  const [evalIngestBusy, setEvalIngestBusy] = useState(false);
  const [noteSelectedStock, setNoteSelectedStock] = useState(null);
  const [noteSellCopied, setNoteSellCopied] = useState(false);
  const [noteSellBusy, setNoteSellBusy] = useState(false);
  const [evalQueue, setEvalQueue] = useState({ entries: [], counts: { pending: 0, processing: 0, done: 0, error: 0 } });
  const [evalQueueOpen, setEvalQueueOpen] = useState(false);
  const [evalQueueName, setEvalQueueName] = useState('');
  const [evalQueueMarket, setEvalQueueMarket] = useState('KR');
  const [evalQueueMemo, setEvalQueueMemo] = useState('');
  const [evalQueueBusy, setEvalQueueBusy] = useState(false);
  const [evalQueueMsg, setEvalQueueMsg] = useState('');

  const [weeklyReports, setWeeklyReports] = useState([]);
  const [weeklyExpanded, setWeeklyExpanded] = useState(false);
  const [riskMonitor, setRiskMonitor] = useState([]);
  const [baselines, setBaselines] = useState([]);
  const [riskOpen, setRiskOpen] = useState(new Set());

  const onData = useCallback(({ accounts: a, monthly: m, dividends: d, monthlyRow: mr, profits: p, evaluations: ev, evalQueue: q, weeklyReports: wr, riskMonitor: rm, baselines: bl }) => {
    setAccounts(prev => ({ ...prev, ...a }));
    setMonthlyData(m || []);
    setDividendData(d || []);
    setProfitData(p || []);
    monthlyRowRef.current = mr ?? null;
    setMonthlyRow(mr ?? null);
    setEvaluations(ev || []);
    setEvalSelectedIdx(0);
    if (q) setEvalQueue(q);
    if (wr) setWeeklyReports(wr);
    if (rm) setRiskMonitor(rm);
    if (bl) setBaselines(bl);
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
  "conclusion": "🟢 유효 | 🟡 관망 | 🔴 부적합 | ⚪ 판단보류",
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
      const _now = new Date();
      const requestedAt = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')} ${String(_now.getHours()).padStart(2,'0')}:${String(_now.getMinutes()).padStart(2,'0')}`;
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

  useEffect(() => {
    if (tab === 'kpi' && sheets.auth === 'signed-in' && kpiTrades === null) {
      sheets.readRange('체결내역!A2:M')
        .then(vals => setKpiTrades((vals || []).map(row => ({ row }))))
        .catch(() => setKpiTrades([]));
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
        <div className="tab-bar" style={{ display: "flex", gap: 4, marginTop: isMobile ? 10 : 16, flexWrap: "nowrap", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          {[
            { key: "dashboard", label: "홈" },
            { key: "리스크",    label: "리스크" },
            { key: "평가",      label: "매수평가" },
            { key: "노트",      label: "매도검토" },
            { key: "holdings",  label: "보유종목" },
            { key: "rebalance", label: "자산분배" },
            { key: "report",    label: "리포트" },
            { key: "kpi",       label: "KPI" },
            { key: "체결내역",  label: "체결" },
            { key: "dividend",  label: "배당금" },
            { key: "profit",    label: "수익금" },
            { key: "help",      label: "도움말" },
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

          </div>
        )}

        {/* ── KPI 탭 ── */}
        {tab === "kpi" && (() => {
          const kpi = computeKPI(monthlyData);
          if (!kpi) return (
            <div style={{ padding: 40, textAlign: 'center', color: '#5A6478', fontSize: 13 }}>
              월별잔고 데이터가 2개월 이상 있어야 KPI를 계산할 수 있습니다.
            </div>
          );

          const twrPct    = (kpi.twr    * 100).toFixed(1);
          const twrCumPct = (kpi.twrCum * 100).toFixed(1);
          const mddPct    = (kpi.mdd    * 100).toFixed(1);
          const sharpeV   = kpi.sharpe !== null ? kpi.sharpe.toFixed(2) : '–';
          const bmPct     = kpi.benchmarkTWR !== null ? (kpi.benchmarkTWR * 100).toFixed(1) : null;
          const alphaPct  = bmPct !== null ? ((kpi.twr - kpi.benchmarkTWR) * 100).toFixed(1) : null;

          const twrStatus = alphaPct !== null
            ? (parseFloat(alphaPct) >= 3  ? { icon: '✅', color: '#10B981', label: `알파 +${alphaPct}%p` }
             : parseFloat(alphaPct) >= 0  ? { icon: '⚠️', color: '#F59E0B', label: `알파 +${alphaPct}%p` }
             :                              { icon: '🔴', color: '#EF4444', label: `알파 ${alphaPct}%p` })
            : kpi.twr >= 0 ? { icon: '✅', color: '#10B981', label: '양호' }
            :                { icon: '🔴', color: '#EF4444', label: '손실' };
          const sharpeStatus = kpi.sharpe === null ? { icon: '–', color: '#6B7280', label: '데이터 부족' }
            : kpi.sharpe >= 0.8 ? { icon: '✅', color: '#10B981', label: '양호' }
            : kpi.sharpe >= 0.5 ? { icon: '⚠️', color: '#F59E0B', label: '주의' }
            : { icon: '🔴', color: '#EF4444', label: '미달' };
          const mddStatus = kpi.mdd >= -0.25 ? { icon: '✅', color: '#10B981', label: '이내' }
            : kpi.mdd >= -0.35 ? { icon: '⚠️', color: '#F59E0B', label: '주의' }
            : { icon: '🔴', color: '#EF4444', label: '초과' };

          const cards = [
            { label: 'TWR (연환산)', value: `${kpi.twr >= 0 ? '+' : ''}${twrPct}%`, sub: bmPct !== null ? `시장 ${parseFloat(bmPct) >= 0 ? '+' : ''}${bmPct}% · ${kpi.months}M` : `누적 ${kpi.twrCum >= 0 ? '+' : ''}${twrCumPct}% · ${kpi.months}M`, status: twrStatus, metric: 'twr' },
            { label: 'Sharpe',       value: sharpeV,                                  sub: '목표 0.8~1.2',              status: sharpeStatus, metric: 'sharpe' },
            { label: 'MDD',          value: `${mddPct}%`,                             sub: '목표 −25% 이내',             status: mddStatus,    metric: 'mdd' },
          ];

          return (
            <div>
              {/* 행동 추적 — 최상단 */}
              {(() => {
                const bm = computeBehaviorMetrics(kpiTrades, evaluations);
                if (kpiTrades === null) return (
                  <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginBottom: 16, textAlign: 'center', color: '#5A6478', fontSize: 11 }}>행동 추적 데이터 불러오는 중...</div>
                );
                if (!bm) return (
                  <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginBottom: 16, textAlign: 'center', color: '#5A6478', fontSize: 11 }}>체결 내역 없음 — 체결 탭에서 먼저 동기화하세요</div>
                );
                const r500Color = bm.rule500Rate === null ? '#5A6478' : bm.rule500Rate >= 80 ? '#10B981' : bm.rule500Rate >= 60 ? '#F59E0B' : '#EF4444';
                const emColor   = bm.evalMatchRate === null ? '#5A6478' : bm.evalMatchRate >= 60 ? '#10B981' : bm.evalMatchRate >= 30 ? '#F59E0B' : '#EF4444';
                const sdColor   = bm.sellDisciplineRate === null ? '#5A6478' : bm.sellDisciplineRate >= 60 ? '#10B981' : bm.sellDisciplineRate >= 30 ? '#F59E0B' : '#EF4444';
                const freqColor = bm.freqRatio === null ? '#5A6478' : bm.freqRatio <= 1.0 ? '#10B981' : bm.freqRatio <= 1.5 ? '#F59E0B' : '#EF4444';
                return (
                  <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginBottom: 16 }}>
                    <div style={{ fontSize: 10, letterSpacing: 3, color: '#5A6478', marginBottom: 14 }}>행동 추적</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
                      {[
                        { label: '500만 원칙', value: bm.rule500Rate !== null ? `${bm.rule500Rate}%` : '–', sub: `${bm.rule500OK}/${bm.rule500Total}건`, color: r500Color },
                        { label: '평가→매수', value: bm.evalMatchRate !== null ? `${bm.evalMatchRate}%` : '–', sub: `${bm.evalMatchCount}/${bm.evalEligible}건`, color: emColor },
                        { label: '매도 규율', value: bm.sellDisciplineRate !== null ? `${bm.sellDisciplineRate}%` : '–', sub: `점검 ${bm.sellDisciplineOK}/${bm.sellDisciplineTotal}건`, color: sdColor },
                        { label: '거래빈도', value: bm.freqRatio !== null ? `${bm.freqRatio.toFixed(1)}×` : '–', sub: bm.freqAvg30 !== null ? `평소 ${Math.round(bm.freqAvg30)}건/월` : '기간 부족', color: freqColor },
                        { label: '최근 30일', value: `${bm.recent30Count}건`, sub: `매수 ${bm.recent30Buys}건`, color: '#E8EAF0' },
                      ].map((card, i) => (
                        <div key={i} style={{ background: '#0F1117', borderRadius: 10, padding: '12px 10px', textAlign: 'center' }}>
                          <div style={{ fontSize: 9, color: '#5A6478', marginBottom: 4 }}>{card.label}</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: card.color }}>{card.value}</div>
                          <div style={{ fontSize: 9, color: '#5A6478', marginTop: 2 }}>{card.sub}</div>
                        </div>
                      ))}
                    </div>
                    {bm.missedEvals.length > 0 && (
                      <div>
                        <div style={{ fontSize: 9, color: '#F59E0B', letterSpacing: 1, marginBottom: 8 }}>🟢 평가 후 {bm.matchWindowDays}일 내 미매수 {bm.missedEvals.length}건 — 검토 필요</div>
                        {bm.missedEvals.slice(0, 5).map((ev, i, arr) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: i < arr.length - 1 ? '1px solid #1E2233' : 'none', fontSize: 11 }}>
                            <span style={{ color: '#E8EAF0' }}>{ev.stock?.name}</span>
                            <span style={{ color: '#5A6478' }}>{ev.date}</span>
                          </div>
                        ))}
                        {bm.missedEvals.length > 5 && <div style={{ fontSize: 10, color: '#5A6478', textAlign: 'center', paddingTop: 6 }}>+{bm.missedEvals.length - 5}건 더</div>}
                      </div>
                    )}
                  </div>
                );
              })()}
              <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginBottom: 12 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: '#5A6478', marginBottom: 12 }}>운용 성과</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  {cards.map(c => (
                    <button key={c.label}
                      onClick={() => setEvalSelectedMetric(prev => prev === c.metric ? null : c.metric)}
                      style={{
                        background: evalSelectedMetric === c.metric ? '#1E3A5F' : '#0F1117',
                        borderRadius: 10, padding: '14px 8px', textAlign: 'center',
                        border: `1px solid ${evalSelectedMetric === c.metric ? '#3B82F6' : c.status.color + '33'}`,
                        cursor: 'pointer', fontFamily: 'inherit', width: '100%', display: 'block',
                      }}>
                      <div style={{ fontSize: 8, color: '#5A6478', marginBottom: 6, letterSpacing: 1 }}>
                        {c.label} <span style={{ color: '#3B82F6' }}>📘</span>
                      </div>
                      <div style={{ fontSize: isMobile ? 15 : 17, fontWeight: 700, color: c.status.color, marginBottom: 4 }}>
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

              {/* 상세 지표 */}
              <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: '#5A6478', marginBottom: 12 }}>지표 상세</div>
                {[
                  { label: 'TWR 연환산', value: `${kpi.twr >= 0 ? '+' : ''}${twrPct}%`, color: twrStatus.color },
                  { label: 'TWR 누적',   value: `${kpi.twrCum >= 0 ? '+' : ''}${twrCumPct}%`, color: kpi.twrCum >= 0 ? '#10B981' : '#EF4444' },
                  ...(alphaPct !== null ? [{ label: '시장 대비 알파', value: `${parseFloat(alphaPct) >= 0 ? '+' : ''}${alphaPct}%p`, color: twrStatus.color }] : []),
                  { label: 'Sharpe',     value: sharpeV,             color: sharpeStatus.color },
                  { label: 'MDD',        value: `${mddPct}%`,        color: mddStatus.color },
                  { label: '산출 기간',  value: `${kpi.months}개월`, color: '#9CA3AF' },
                ].map((row, i, arr) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: i < arr.length - 1 ? '1px solid #1E2233' : 'none' }}>
                    <span style={{ fontSize: 12, color: '#9CA3AF' }}>{row.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: row.color }}>{row.value}</span>
                  </div>
                ))}
              </div>

              {/* 내 투자 기준 */}
              <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginTop: 12 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: '#5A6478', marginBottom: 14 }}>내 투자 기준</div>
                {[
                  { cat: '포트폴리오 성과', items: [
                    { label: 'TWR 목표',    value: '시장 대비 +3~5%p' },
                    { label: 'Sharpe 목표', value: '0.8~1.2 (1년)' },
                    { label: 'MDD 한도',    value: '1년 −25% · 3년 −35%' },
                    { label: 'MDD 회복',    value: '12개월 이내' },
                  ]},
                  { cat: '종목 매수 기준', items: [
                    { label: '매출성장률',  value: '10%+ 3년 유지' },
                    { label: 'ROIC',        value: '15%+ 5년 평균' },
                    { label: 'RSI',         value: '30↓ 매수 · 70↑ 차익실현' },
                    { label: '52주 위치',   value: '하단 20% 적극매수' },
                    { label: '외국인수급',  value: '4일 연속 순매도 → 보류' },
                  ]},
                  { cat: '배당 기준', items: [
                    { label: '배당성향',     value: '40~60%' },
                    { label: 'FCF 커버리지', value: '80% 미만' },
                  ]},
                ].map((section, si, all) => (
                  <div key={si} style={{ marginBottom: si < all.length - 1 ? 16 : 0 }}>
                    <div style={{ fontSize: 9, color: '#3B82F6', letterSpacing: 1, marginBottom: 6 }}>{section.cat}</div>
                    {section.items.map((item, ii, arr) => (
                      <div key={ii} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: ii < arr.length - 1 ? '1px solid #1E2233' : 'none' }}>
                        <span style={{ fontSize: 12, color: '#9CA3AF' }}>{item.label}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#E8EAF0' }}>{item.value}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

            </div>
          );
        })()}

        {/* ── 리포트 탭 ── */}
        {tab === "report" && (() => {
          const totalEval   = Object.values(accounts).reduce((s, a) => s + (a.total_eval   || 0), 0);
          const totalInvest = Object.values(accounts).reduce((s, a) => s + (a.total_invest || 0), 0);
          const totalProfit = totalEval - totalInvest;
          const totalRate   = totalInvest > 0 ? (totalProfit / totalInvest * 100) : 0;

          // 리밸런싱 경보 (±5%p 초과)
          const rebalAlerts = Object.entries(accounts).flatMap(([, a]) =>
            (a.assets || []).map(asset => {
              const curr = asset.sheetCurrent ?? asset.ratio;
              const diff = parseFloat((curr - asset.target).toFixed(1));
              return { acct: a.label, name: asset.name, diff, color: a.color };
            }).filter(x => Math.abs(x.diff) >= 5)
          );

          const today = new Date();
          const dateStr = `${today.getFullYear()}.${String(today.getMonth()+1).padStart(2,'0')}.${String(today.getDate()).padStart(2,'0')}`;

          return (
            <div>
              {/* 헤더 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#E8EAF0' }}>포트폴리오 리포트</div>
                <div style={{ fontSize: 10, color: '#5A6478' }}>{dateStr} 기준</div>
              </div>

              {/* 이번 주 행동 처방 — 최신 리포트의 "🎯 …처방" 섹션을 최상단에 고정 노출 */}
              {(() => {
                const rpt = weeklyReports[0];
                if (!rpt) return null;
                const pSec = rpt.body.split(/^## /m).filter(Boolean).find(s => /처방/.test(s.split('\n')[0]));
                if (!pSec) return null;
                const rest = pSec.split('\n').slice(1).join('\n').trim();
                const quote = rest.match(/^>\s*(.+)$/m);
                const action = quote ? quote[1].replace(/\*\*/g, '').replace(/^["“]\s*|\s*["”]$/g, '').trim() : '';
                if (!action) return null;
                let reason = rest.replace(/^>.*$/m, '').trim();
                const sep = reason.indexOf('\n---');
                if (sep >= 0) reason = reason.slice(0, sep).trim();
                reason = reason.replace(/^근거\s*[:：]\s*/, '').replace(/\*\*/g, '').trim();
                return (
                  <div style={{ background: 'linear-gradient(135deg,#2A2410,#1A1D26)', border: '1px solid #F5C842', borderRadius: 12, padding: 16, marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#F5C842', letterSpacing: 1 }}>🎯 이번 주 행동 처방</div>
                      <div style={{ fontSize: 9, color: '#5A6478' }}>{rpt.date}</div>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#F5F7FF', lineHeight: 1.5, marginBottom: reason ? 8 : 0 }}>{action}</div>
                    {reason && <div style={{ fontSize: 10, color: '#9CA3AF', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{reason}</div>}
                  </div>
                );
              })()}

              {/* 섹션 1: 포트폴리오 총괄 */}
              <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginBottom: 12 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: '#5A6478', marginBottom: 12 }}>포트폴리오 총괄</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: isMobile ? 20 : 24, fontWeight: 700, color: '#F5F7FF' }}>₩{fmt(totalEval)}</div>
                    <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>투자원금 ₩{fmt(totalInvest)}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: totalProfit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                      ₩{fmt(totalProfit)}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: totalProfit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                      {totalRate >= 0 ? '+' : ''}{totalRate.toFixed(1)}%
                    </div>
                  </div>
                </div>
                {/* 계좌별 도넛 차트 */}
                {(() => {
                  const donutData = Object.entries(accounts)
                    .filter(([, a]) => a.total_eval > 0)
                    .map(([, a]) => ({ label: a.label, value: a.total_eval, color: a.color }));
                  if (!donutData.length) return null;
                  const r = 38, circ = 2 * Math.PI * r;
                  let cumDash = 0;
                  const slices = donutData.map(d => {
                    const pct = totalEval > 0 ? d.value / totalEval : 0;
                    const dash = pct * circ;
                    const offset = circ / 4 - cumDash;
                    cumDash += dash;
                    return { ...d, dash, offset, pctStr: (pct * 100).toFixed(0) };
                  });
                  const evalAmt = totalEval >= 100000000
                    ? `${(totalEval/100000000).toFixed(1)}억`
                    : `${(totalEval/10000).toFixed(0)}만`;
                  return (
                    <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                      <svg viewBox="0 0 100 100" width="110" height="110" style={{ flexShrink: 0 }}>
                        {slices.map((s, i) => (
                          <circle key={i} cx="50" cy="50" r={r}
                            fill="none" stroke={s.color} strokeWidth="20"
                            strokeDasharray={`${s.dash} ${circ - s.dash}`}
                            strokeDashoffset={s.offset}
                          />
                        ))}
                        <text x="50" y="47" textAnchor="middle" fill="#E8EAF0" fontSize="9" fontWeight="700">{evalAmt}</text>
                        <text x="50" y="58" textAnchor="middle" fill="#9CA3AF" fontSize="7">총자산</text>
                      </svg>
                      <div style={{ flex: 1, minWidth: 80 }}>
                        {slices.map((s, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: i < slices.length - 1 ? '1px solid #1E2233' : 'none' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ width: 7, height: 7, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
                              <span style={{ fontSize: 10, color: '#9CA3AF' }}>{s.label}</span>
                            </div>
                            <span style={{ fontSize: 10, fontWeight: 600, color: '#E8EAF0' }}>{s.pctStr}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* 리포트 날짜 선택 */}
              {weeklyReports.length > 1 && (
                <div style={{ display: 'flex', gap: 4, marginBottom: 12, marginTop: 4, flexWrap: 'wrap' }}>
                  {weeklyReports.map((r, i) => (
                    <button key={i} onClick={() => { setWeeklyReports(prev => { const copy = [...prev]; const item = copy.splice(i, 1)[0]; copy.unshift(item); return copy; }); setWeeklyExpanded(false); }}
                      style={{ padding: '4px 10px', borderRadius: 4, border: `1px solid ${i === 0 ? '#3B82F6' : '#2A2F3E'}`, background: i === 0 ? '#1E3A5F' : 'transparent', color: i === 0 ? '#60A5FA' : '#5A6478', cursor: 'pointer', fontSize: 9 }}>
                      {r.date}
                    </button>
                  ))}
                </div>
              )}

              {/* 섹션 4: 주간 AI 리포트 */}
              {weeklyReports.length > 0 && (() => {
                const latest = weeklyReports[0];
                const sections = latest.body.split(/^## /m).filter(Boolean).map(s => {
                  const lines = s.split('\n');
                  const title = lines[0].trim();
                  const content = lines.slice(1).join('\n').trim();
                  return { title, content };
                });
                const visibleSections = weeklyExpanded ? sections : sections.slice(0, 3);
                return (
                  <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <div style={{ fontSize: 10, letterSpacing: 3, color: '#5A6478' }}>📋 주간 AI 리포트</div>
                      <div style={{ fontSize: 10, color: '#3A4050' }}>{latest.date}</div>
                    </div>
                    {visibleSections.map((sec, i) => (
                      <div key={i} style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#60A5FA', marginBottom: 6 }}>{sec.title}</div>
                        <div style={{ fontSize: 10, color: '#9CA3AF', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {sec.content.split('\n').map((line, j) => {
                            if (line.startsWith('|') && line.includes('|')) {
                              const cells = line.split('|').filter(Boolean).map(c => c.trim());
                              if (cells.every(c => /^[-:]+$/.test(c))) return null;
                              return (
                                <div key={j} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 9, borderBottom: '1px solid #1E2233' }}>
                                  {cells.map((c, k) => <span key={k} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.replace(/\*\*/g, '')}</span>)}
                                </div>
                              );
                            }
                            const cleaned = line.replace(/\*\*/g, '').replace(/^>\s*/, '');
                            if (!cleaned) return <br key={j} />;
                            if (line.startsWith('###')) return <div key={j} style={{ fontSize: 10, fontWeight: 600, color: '#E8EAF0', marginTop: 8, marginBottom: 4 }}>{cleaned.replace(/^#+\s*/, '')}</div>;
                            return <div key={j}>{cleaned}</div>;
                          })}
                        </div>
                      </div>
                    ))}
                    {sections.length > 3 && (
                      <button onClick={() => setWeeklyExpanded(!weeklyExpanded)} style={{
                        width: '100%', padding: '8px', borderRadius: 6, border: '1px solid #2A2F3E',
                        background: 'transparent', color: '#5A6478', cursor: 'pointer', fontSize: 10,
                      }}>
                        {weeklyExpanded ? '접기 ▲' : `전체 보기 (${sections.length}섹션) ▼`}
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* 섹션 5: 리밸런싱 신호 */}
              <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: '#5A6478', marginBottom: 12 }}>리밸런싱 신호 (±5%p 초과)</div>
                {rebalAlerts.length === 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 16 }}>✅</span>
                    <span style={{ fontSize: 12, color: '#10B981' }}>모든 자산군 목표 비중 이내</span>
                  </div>
                ) : (
                  rebalAlerts.map((a, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', borderRadius: 6, marginBottom: 4, background: '#1A2035', borderLeft: `3px solid ${a.diff > 0 ? PROFIT_POS : PROFIT_NEG}` }}>
                      <div>
                        <span style={{ fontSize: 11, color: '#E8EAF0' }}>{a.name}</span>
                        <span style={{ fontSize: 10, color: a.color, marginLeft: 6 }}>{a.acct}</span>
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: a.diff > 0 ? PROFIT_POS : PROFIT_NEG }}>
                        {a.diff > 0 ? '+' : ''}{a.diff}%p
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })()}

        {/* ── 리스크 탭 ── */}
        {tab === "리스크" && (() => {
          const today = new Date();
          const dateStr = `${today.getFullYear()}.${String(today.getMonth()+1).padStart(2,'0')}.${String(today.getDate()).padStart(2,'0')}`;
          const sigLevel = (s) => s.includes('🔴') ? 3 : s.includes('🟡') ? 2 : 1;
          const sigColor = (s) => s.includes('🔴') ? '#EF4444' : s.includes('🟡') ? '#F5C842' : '#10B981';
          // 검증 "항목"(무엇을 점검했나) — 중립 표기. 결과/상태와 분리.
          const typeLabel = (t) => t === 'B' ? '논리 점검' : t === 'D' ? '거시 점검' : t;
          // 점검 "결과"(상황) — 색상과 함께 표시.
          const statusLabel = (s) => s.includes('🔴') ? '경보' : s.includes('🟡') ? '주의' : '정상';
          // 기준선 수치 단위 통일(%): 숫자면 % 부착, 데이터 없으면 '데이터 부족'.
          const fmtPct = (v) => {
            const s = String(v ?? '').trim();
            if (!s || s === '—') return '—';
            if (/데이터\s*부족|N\/?A|없음|None|미분류/i.test(s)) return '데이터 부족';
            const n = parseFloat(s.replace(/[,%\s]/g, ''));
            if (isNaN(n)) return '데이터 부족';
            return `${Number.isInteger(n) ? n : parseFloat(n.toFixed(2))}%`;
          };

          // 동일 (유형+대상)은 최신 1건만 — riskMonitor는 최신순.
          // 거시(D)는 대상 텍스트가 실행마다 달라져 (유형+대상) 디듀프가 안 먹으므로,
          // 가장 최근 날짜의 D 신호만 노출(과거 날짜 누적분 자동 제거).
          const latestDDate = riskMonitor.reduce((mx, r) => (r.type === 'D' && r.date > mx ? r.date : mx), '');
          const seen = new Set();
          const latest = [];
          for (const r of riskMonitor) {
            if (r.type === 'D' && r.date !== latestDDate) continue;
            const k = `${r.type}|${r.target}`;
            if (seen.has(k)) continue;
            seen.add(k); latest.push(r);
          }
          latest.sort((a, b) => sigLevel(b.signal) - sigLevel(a.signal));
          const counts = { red: 0, amber: 0, green: 0 };
          latest.forEach(r => { const l = sigLevel(r.signal); if (l === 3) counts.red++; else if (l === 2) counts.amber++; else counts.green++; });
          const lastUpdated = riskMonitor[0]?.date || '—';

          const renderEvidence = (ev) => {
            if (!ev) return null;
            let obj;
            try { obj = JSON.parse(ev); } catch { return null; }
            if (!obj || typeof obj !== 'object') return null;
            const entries = Object.entries(obj).filter(([, v]) => v != null && typeof v !== 'object');
            if (!entries.length) return null;
            return (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {entries.map(([k, v], i) => (
                  <div key={i} style={{ fontSize: 9, color: '#9CA3AF', background: '#12141C', borderRadius: 4, padding: '3px 7px' }}>
                    <span style={{ color: '#5A6478' }}>{k}</span> {String(v)}
                  </div>
                ))}
              </div>
            );
          };

          return (
            <div style={{ textAlign: 'left' }}>
              {/* 헤더 */}
              <SectionTitle color="#EF4444" size={15} sub={`최근 점검 ${lastUpdated}`}>리스크 모니터</SectionTitle>

              {riskMonitor.length === 0 ? (
                <div style={{ background: '#1A1D26', borderRadius: 12, padding: 24, textAlign: 'center' }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🛡️</div>
                  <div style={{ fontSize: 12, color: '#9CA3AF', lineHeight: 1.6 }}>
                    아직 리스크 신호가 없습니다.<br />
                    <span style={{ fontSize: 10, color: '#5A6478' }}>risk-monitor 실행 후 B(논리 훼손)·D(거시 충격) 신호가 표시됩니다.</span>
                  </div>
                </div>
              ) : (
                <>
                  {/* 신호 요약 */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
                    {[
                      { label: '경보', n: counts.red, c: '#EF4444' },
                      { label: '주의', n: counts.amber, c: '#F5C842' },
                      { label: '정상', n: counts.green, c: '#10B981' },
                    ].map((x, i) => (
                      <div key={i} style={{ background: x.n > 0 ? `${x.c}14` : '#1A1D26', borderRadius: 12, padding: '14px 8px', textAlign: 'center', border: `1px solid ${x.n > 0 ? `${x.c}44` : '#232838'}` }}>
                        <div style={{ fontSize: 24, fontWeight: 800, color: x.n > 0 ? x.c : '#3A4050', lineHeight: 1 }}>{x.n}</div>
                        <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: x.c, display: 'inline-block' }} />{x.label}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* 신호 카드 목록 */}
                  {latest.map((r, i) => {
                    const color = sigColor(r.signal);
                    const isOpen = riskOpen.has(i);
                    // 거시(D) 머리글은 자산군 단위로 통합 — 구성종목 나열은 '자세히'로 내림
                    let headTitle = r.target, headRest = '';
                    if (r.type === 'D') {
                      const parts = r.target.split(/\s+[—–-]\s+/);
                      if (parts.length > 1) { headTitle = parts[0].trim(); headRest = parts.slice(1).join(' — ').trim(); }
                      else if (r.target.length > 40) { headTitle = r.target.slice(0, 40).trim() + '…'; headRest = r.target; }
                    }
                    return (
                      <div key={i} style={{ background: '#1A1D26', borderRadius: 12, padding: 14, marginBottom: 8, border: '1px solid #232838', borderLeft: `4px solid ${color}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                              {/* 상태 점(이모지 대신 CSS 원 — 폰트 의존 없이 항상 정상 표시) */}
                              <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
                              <span style={{ fontSize: 12, fontWeight: 700, color: '#E8EAF0' }}>{headTitle}</span>
                              {/* 검증 항목(중립 회색) */}
                              <span style={{ fontSize: 8, color: '#8A93A6', border: '1px solid #2E3442', borderRadius: 3, padding: '1px 5px' }}>{typeLabel(r.type)}</span>
                              {/* 결과 상태(색상) */}
                              <span style={{ fontSize: 8, color, background: `${color}22`, borderRadius: 3, padding: '1px 6px', fontWeight: 700 }}>{statusLabel(r.signal)}</span>
                            </div>
                            <Sentences text={r.summary} sentenceOnly style={{ fontSize: 11, color: '#9CA3AF', lineHeight: 1.55 }} />
                          </div>
                          <span style={{ fontSize: 9, color: '#3A4050', flexShrink: 0 }}>{r.date}</span>
                        </div>
                        {(r.detail || r.evidence) && (
                          <button onClick={() => setRiskOpen(prev => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                            style={{ marginTop: 8, padding: '4px 0', background: 'transparent', border: 'none', color: '#5A6478', cursor: 'pointer', fontSize: 9 }}>
                            {isOpen ? '접기 ▲' : '자세히 ▼'}
                          </button>
                        )}
                        {isOpen && (
                          <div style={{ marginTop: 6, paddingTop: 8, borderTop: '1px solid #1E2233' }}>
                            {headRest && <div style={{ fontSize: 9, color: '#5A6478', lineHeight: 1.5, marginBottom: 6, wordBreak: 'break-word' }}>구성: {headRest}</div>}
                            {r.detail && <Sentences text={r.detail} sentenceOnly style={{ fontSize: 10, color: '#9CA3AF', lineHeight: 1.6, wordBreak: 'break-word', marginBottom: 2 }} />}
                            {renderEvidence(r.evidence)}
                            {r.baselineRef && <div style={{ fontSize: 9, color: '#5A6478', marginTop: 8 }}>기준선: {r.baselineRef}</div>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}

              {/* 펀더멘털 기준선 */}
              {baselines.length > 0 && (
                <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginTop: 12 }}>
                  <SectionTitle color="#F5C842" size={12} mb={14} sub="논리 훼손 비교 기준">펀더멘털 기준선</SectionTitle>
                  <div style={{ display: 'flex', fontSize: 9, color: '#5A6478', padding: '0 0 6px', borderBottom: '1px solid #1E2233' }}>
                    <span style={{ flex: 2, minWidth: 0 }}>종목</span>
                    <span style={{ flex: 1, textAlign: 'right' }}>영익률</span>
                    <span style={{ flex: 1, textAlign: 'right' }}>ROE</span>
                    <span style={{ flex: 1, textAlign: 'right' }}>부채</span>
                  </div>
                  {baselines.map((b, i) => (
                    <div key={i} style={{ display: 'flex', fontSize: 10, color: '#E8EAF0', padding: '7px 0', borderBottom: i < baselines.length - 1 ? '1px solid #15171F' : 'none' }}>
                      <span style={{ flex: 2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
                      {[b.operatingMargin, b.roe, b.debtRatio].map((v, k) => {
                        const f = fmtPct(v);
                        return <span key={k} style={{ flex: 1, textAlign: 'right', color: f === '데이터 부족' ? '#5A6478' : '#9CA3AF', fontSize: f === '데이터 부족' ? 9 : 10 }}>{f}</span>;
                      })}
                    </div>
                  ))}
                  <div style={{ fontSize: 9, color: '#3A4050', marginTop: 8 }}>기준일 {baselines[0]?.date || '—'} · 가격 등락이 아닌 실적 훼손만 리스크로 평가</div>
                </div>
              )}

              <div style={{ fontSize: 9, color: '#3A4050', textAlign: 'center', marginTop: 16 }}>
                {dateStr} 조회 · 펀더멘털·거시 기반 (가격 과열 단독은 신호 아님)
              </div>
            </div>
          );
        })()}

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
        {tab === "holdings" && (() => {
          // ── 전체 계좌 합산 ─────────────────────────────────────────
          const totalPortEval   = Object.values(accounts).reduce((s, a) => s + (a.total_eval   || 0), 0);
          const totalPortInvest = Object.values(accounts).reduce((s, a) => s + (a.total_invest || 0), 0);
          const totalPortProfit = totalPortEval - totalPortInvest;

          // 전체 계좌 종목 합산 (acctKey === '전체' 시 사용)
          const allHoldingsFlat = Object.entries(accounts).flatMap(([k, a]) =>
            (a.holdings || [])
              .filter(h => h.invest > 0 && h.eval > 0)
              .map(h => ({ ...h, _acct: a.label, _acctKey: k }))
          );

          // 현재 표시할 종목 목록 (단일 계좌)
          const isTotalView = false;
          const rawHoldings = (acct.holdings || [])
            .map((h, origIdx) => ({ ...h, origIdx }))
            .filter(h => h.invest > 0 && h.eval > 0);

          // 정렬 (sheet = 시트 원래 순서 유지)
          const SORT_FN = {
            rate_desc:   (a, b) => b.rate   - a.rate,
            rate_asc:    (a, b) => a.rate   - b.rate,
            eval_desc:   (a, b) => b.eval   - a.eval,
            profit_desc: (a, b) => b.profit - a.profit,
          };
          const sortedHoldings = holdSort === 'sheet'
            ? rawHoldings
            : [...rawHoldings].sort(SORT_FN[holdSort] || SORT_FN.rate_desc);

          // 비중 계산 기준 (해당 계좌)
          const weightBase = acct.total_eval || 1;

          return (
          <div>
            {/* 계좌 선택 (4개) */}
            <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
              {Object.entries(accounts).map(([k, a]) => (
                <button key={k} onClick={() => { setAcctKey(k); setShowAddForm(false); setEditingHolding(null); }} style={{
                  flex: 1, padding: isMobile ? "8px 4px" : "6px 4px",
                  textAlign: 'center',
                  borderRadius: 20,
                  border: `1px solid ${acctKey === k ? a.color : "#2A2F3E"}`,
                  background: acctKey === k ? `${a.color}22` : "transparent",
                  color: acctKey === k ? a.color : "#6B7280",
                  cursor: "pointer", fontSize: 11, fontFamily: baseFont,
                }}>
                  {a.label}
                </button>
              ))}
            </div>

            {/* 계좌 요약 카드 */}
            {isTotalView ? (
              <div style={{ background: 'linear-gradient(135deg, #8B5CF622, #1A1D26)', border: '1px solid #8B5CF644', borderRadius: 12, padding: "16px", marginBottom: 16 }}>
                <div style={{ fontSize: 10, letterSpacing: 2, color: '#8B5CF6', marginBottom: 4 }}>전체 포트폴리오</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
                  <div>
                    <div style={{ fontSize: isMobile ? 16 : 20, fontWeight: 700, color: "#F5F7FF" }}>₩{fmt(totalPortEval)}</div>
                    <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>투자금 ₩{fmt(totalPortInvest)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: isMobile ? 13 : 16, fontWeight: 700, color: totalPortProfit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                      ₩{fmt(totalPortProfit)}
                    </div>
                    <div style={{ fontSize: 11, color: totalPortProfit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                      {totalPortProfit >= 0 ? '+' : ''}{totalPortInvest > 0 ? ((totalPortProfit / totalPortInvest) * 100).toFixed(1) : '0.0'}%
                    </div>
                  </div>
                </div>
              </div>
            ) : (
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
            )}

            {/* 정렬 버튼 */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: '#5A6478', flexShrink: 0 }}>정렬</span>
              {[
                { key: 'sheet',       label: '자산군순' },
                { key: 'rate_desc',   label: '수익률↓' },
                { key: 'rate_asc',    label: '수익률↑' },
                { key: 'eval_desc',   label: '평가금↓' },
              ].map(s => (
                <button key={s.key} onClick={() => setHoldSort(s.key)} style={{
                  padding: '4px 8px', borderRadius: 12, fontSize: 10,
                  border: `1px solid ${holdSort === s.key ? '#3B82F6' : '#2A2F3E'}`,
                  background: holdSort === s.key ? '#1E3A5F' : 'transparent',
                  color: holdSort === s.key ? '#60A5FA' : '#6B7280',
                  cursor: 'pointer', fontFamily: baseFont,
                }}>{s.label}</button>
              ))}
            </div>

            {/* 종목추가/삭제 버튼 + 폼 */}
            {sheets.auth === 'signed-in' && !isTotalView && (
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
              <div style={{ padding: "12px 16px", borderBottom: "1px solid #2A2F3E", fontSize: 10, letterSpacing: 3, color: "#5A6478" }}>
                보유 종목 ({sortedHoldings.length})
              </div>
              {sortedHoldings.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center', color: '#5A6478', fontSize: 12 }}>종목이 없습니다</div>
              )}
              {sortedHoldings.map((h, vi) => {
                const origIdx = h.origIdx ?? vi;
                const color = h.rate >= 0 ? PROFIT_POS : PROFIT_NEG;
                const typeName = h.type || '';
                const isEditing = !isTotalView && editingHolding?.origIdx === origIdx;
                const weightPct = weightBase > 0 ? (h.eval / weightBase * 100).toFixed(1) : '0.0';
                const lpHandlers = !isTotalView && sheets.auth === 'signed-in' && !showDeleteMode ? {
                  onMouseDown: () => startLP(origIdx, h),
                  onMouseUp: endLP,
                  onMouseLeave: endLP,
                  onTouchStart: (e) => { e.preventDefault(); startLP(origIdx, h); },
                  onTouchEnd: endLP,
                  onTouchCancel: endLP,
                  onContextMenu: (e) => e.preventDefault(),
                } : {};
                return (
                  <div key={`${h._acctKey ?? acctKey}-${origIdx}`} style={{ borderBottom: vi < sortedHoldings.length - 1 ? "1px solid #1E2233" : "none" }}>
                    <div style={{
                      padding: isMobile ? "10px 16px" : "12px 16px",
                      display: "flex", alignItems: "center", gap: 8,
                      background: isEditing ? '#1A2035' : selectedToDelete.has(origIdx) ? '#1A1520' : 'transparent',
                      userSelect: 'none', WebkitUserSelect: 'none',
                    }} {...lpHandlers}>
                      {!isTotalView && showDeleteMode && (
                        <input type="checkbox" checked={selectedToDelete.has(origIdx)}
                          onChange={() => setSelectedToDelete(prev => { const next = new Set(prev); if (next.has(origIdx)) next.delete(origIdx); else next.add(origIdx); return next; })}
                          style={{ marginRight: 2, accentColor: PROFIT_POS, flexShrink: 0 }}
                        />
                      )}
                      {/* 자산군 태그 or 계좌 태그(전체뷰) */}
                      {isTotalView ? (
                        <div style={{ fontSize: 9, background: (accounts[h._acctKey]?.color || '#aaa') + '33', color: accounts[h._acctKey]?.color || '#aaa', padding: '2px 5px', borderRadius: 4, flexShrink: 0, whiteSpace: 'nowrap' }}>
                          {h._acct}
                        </div>
                      ) : typeName ? (
                        <div style={{ fontSize: 10, background: (COLORS[typeName] || '#aaa') + '33', color: COLORS[typeName] || '#aaa', padding: '2px 6px', borderRadius: 4, flexShrink: 0, whiteSpace: 'nowrap' }}>
                          {typeName}
                        </div>
                      ) : null}
                      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#E8EAF0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {h.name}
                        </div>
                        <div style={{ fontSize: 10, color: "#5A6478", marginTop: 2 }}>
                          {h.qty}주 · ₩{fmt(h.price)}
                        </div>
                      </div>
                      {/* 비중% */}
                      <div style={{ textAlign: 'center', flexShrink: 0, minWidth: 32 }}>
                        <div style={{ fontSize: 9, color: '#5A6478' }}>비중</div>
                        <div style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 600 }}>{weightPct}%</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: isMobile ? 11 : 12, color: "#E8EAF0" }}>₩{fmt(h.eval)}</div>
                        <div style={{ fontSize: isMobile ? 10 : 11, fontWeight: 700, color }}>
                          {h.rate >= 0 ? '+' : ''}{h.rate.toFixed(1)}%
                        </div>
                        <div style={{ fontSize: 10, color }}>
                          ₩{fmt(Math.abs(h.profit))}
                        </div>
                      </div>
                    </div>
                    {isEditing && (
                      <div style={{ padding: '12px 16px', background: '#141927', borderTop: '1px solid #2A2F3E' }}>
                        <div style={{ fontSize: 10, letterSpacing: 2, color: '#5A6478', marginBottom: 10 }}>종목 수정</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                          <div>
                            <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4 }}>매수단가</div>
                            <input type="number" value={editPrice} onChange={e => setEditPrice(e.target.value)}
                              style={{ background: '#0D1520', border: '1px solid #2A2F3E', borderRadius: 6, color: '#E8EAF0', padding: '6px 10px', fontSize: 12, fontFamily: baseFont, width: '100%', boxSizing: 'border-box' }} />
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4 }}>수량</div>
                            <input type="number" value={editQty} onChange={e => setEditQty(e.target.value)}
                              style={{ background: '#0D1520', border: '1px solid #2A2F3E', borderRadius: 6, color: '#E8EAF0', padding: '6px 10px', fontSize: 12, fontFamily: baseFont, width: '100%', boxSizing: 'border-box' }} />
                          </div>
                        </div>
                        {editingHolding?.isManual && (
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 10, color: '#5A6478', marginBottom: 4 }}>현재가 (수기)</div>
                            <input type="number" value={editCurrentPrice} onChange={e => setEditCurrentPrice(e.target.value)}
                              style={{ background: '#0D1520', border: '1px solid #3B82F6', borderRadius: 6, color: '#E8EAF0', padding: '6px 10px', fontSize: 12, fontFamily: baseFont, width: '100%', boxSizing: 'border-box' }} />
                          </div>
                        )}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9CA3AF', marginBottom: 10, cursor: 'pointer', userSelect: 'none' }}>
                          <input type="checkbox" checked={editIncludeSavings} onChange={e => setEditIncludeSavings(e.target.checked)} style={{ accentColor: '#3B82F6' }} />
                          신규 매수 반영 (저축금 업데이트)
                        </label>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                          <button onClick={() => { setEditingHolding(null); setEditIncludeSavings(false); }} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #2A2F3E', background: 'transparent', color: '#6B7280', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>취소</button>
                          <button onClick={saveEdit} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#3B82F6', color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: baseFont }}>저장</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {!isTotalView && showDeleteMode && selectedToDelete.size > 0 && (
                <div style={{ padding: '12px 16px', borderTop: '1px solid #2A2F3E' }}>
                  <button onClick={handleDeleteSelected} style={{ width: '100%', padding: 10, borderRadius: 6, border: 'none', background: PROFIT_POS, color: '#fff', cursor: 'pointer', fontSize: 12, fontFamily: baseFont }}>
                    선택 삭제 ({selectedToDelete.size}개)
                  </button>
                </div>
              )}
            </div>
          </div>
          );
        })()}

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
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #1E2233' }}>
                        {editingDivRow === item.row ? (
                          <>
                            <input value={editDivName} onChange={e => setEditDivName(e.target.value)} autoFocus
                              style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '4px 6px', borderRadius: 4, border: '1px solid #3B82F6', background: '#0F1117', color: '#E8EAF0', fontFamily: baseFont }} />
                            <button disabled={divSaving} onClick={async () => {
                              const v = editDivName.trim(); if (!v) return;
                              setDivSaving(true);
                              try { await sheets.writeRange(`배당금!C${item.row}`, [v]); await sheets.fetch(); setEditingDivRow(null); }
                              finally { setDivSaving(false); }
                            }} style={{ fontSize: 11, padding: '4px 8px', borderRadius: 4, border: 'none', background: '#10B981', color: '#fff', cursor: 'pointer', flexShrink: 0 }}>{divSaving ? '…' : '저장'}</button>
                            <button onClick={() => setEditingDivRow(null)} style={{ fontSize: 11, padding: '4px 8px', borderRadius: 4, border: '1px solid #2A2F3E', background: 'transparent', color: '#9CA3AF', cursor: 'pointer', flexShrink: 0 }}>취소</button>
                          </>
                        ) : (
                          <>
                            {(() => {
                              const startPress = () => {
                                clearTimeout(divLongPress.current);
                                divLongPress.current = setTimeout(() => { setEditingDivRow(item.row); setEditDivName(item.name); }, 500);
                              };
                              const cancelPress = () => clearTimeout(divLongPress.current);
                              return (
                                <span
                                  onPointerDown={startPress}
                                  onPointerUp={cancelPress}
                                  onPointerLeave={cancelPress}
                                  onContextMenu={e => e.preventDefault()}
                                  title="길게 눌러 이름 수정"
                                  style={{ fontSize: 12, color: '#E8EAF0', cursor: 'pointer', flex: 1, minWidth: 0, textAlign: 'left', userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'manipulation' }}>
                                  {item.name || '(이름 없음)'}
                                </span>
                              );
                            })()}
                            <span style={{ fontSize: 12, fontWeight: 700, color: PROFIT_POS, flexShrink: 0 }}>₩{fmt(item.amount)}</span>
                          </>
                        )}
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
          // 종목별 최신 평가만 추출 + 노트 탭과 동일하게 evalSum 내림차순 정렬
          const uniqueEvals = (() => {
            const seen = new Map();
            evaluations.forEach((ev) => {
              const name = ev.stock?.name;
              if (name && !seen.has(name)) seen.set(name, ev);
            });
            const evalSumMap = {};
            Object.values(accounts).forEach(acct => {
              (acct.holdings || []).forEach(h => {
                const n = String(h.name ?? '').trim();
                if (!n) return;
                evalSumMap[n] = (evalSumMap[n] || 0) + (h.eval || 0);
              });
            });
            return [...seen.values()].sort((a, b) => (evalSumMap[b.stock?.name] || 0) - (evalSumMap[a.stock?.name] || 0));
          })();
          const current = fromSheet ? (uniqueEvals[evalSelectedIdx] || uniqueEvals[0]) : null;
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
          <div style={{ textAlign: 'left' }}>
            {/* 헤더 */}
            <SectionTitle color="#F5A623" mb={12}>AI 능동 종목 평가</SectionTitle>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
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
                  padding: '5px 10px', borderRadius: 6, border: '1px solid #2A2F3E',
                  background: 'transparent', color: '#5A6478',
                  cursor: sheets.auth !== 'signed-in' ? 'not-allowed' : 'pointer',
                  opacity: sheets.auth !== 'signed-in' ? 0.4 : 1,
                  fontSize: 10, fontFamily: baseFont,
                }} title="수동 평가 JSON 적재">
                  💾
                </button>
              </div>
            </div>

            {/* 평가 의뢰 큐 상태 */}
            {(evalQueue.counts.pending + evalQueue.counts.processing + evalQueue.counts.error) > 0 && (
              <div style={{
                background: '#0F1218', borderRadius: 8, padding: '8px 12px', marginBottom: 12,
                fontSize: 10, color: '#9CA3AF', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center',
              }}>
                <span style={{ color: '#5A6478', letterSpacing: 1 }}>의뢰 큐</span>
                {evalQueue.counts.pending > 0 && <span>대기 <span style={{ color: '#F5A623', fontWeight: 600 }}>{evalQueue.counts.pending}</span></span>}
                {evalQueue.counts.processing > 0 && <span>처리중 <span style={{ color: '#60A5FA', fontWeight: 600 }}>{evalQueue.counts.processing}</span></span>}
                {evalQueue.counts.error > 0 && <span>오류 <span style={{ color: '#F87171', fontWeight: 600 }}>{evalQueue.counts.error}</span></span>}
              </div>
            )}

            {/* 종목 선택 칩 (시트 데이터 있을 때만) — 노트 탭과 동일 순서 */}
            {fromSheet && uniqueEvals.length > 1 && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                {uniqueEvals.map((ev, i) => (
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
            <div style={{ background: 'linear-gradient(180deg, #1C2030 0%, #1A1D26 60%)', borderRadius: 14, padding: '18px 16px 12px', marginBottom: 16, border: '1px solid #232838' }}>
              {/* 카드 헤더 — 중앙 정렬 히어로 */}
              <div style={{ textAlign: 'center', marginBottom: 14 }}>
                <div style={{ fontSize: 19, fontWeight: 800, color: '#F5F7FF', letterSpacing: -0.3 }}>
                  {card.stock.name}{card.stock.ticker ? ` (${card.stock.ticker})` : ''}
                </div>
                <div style={{ fontSize: 10, color: '#5A6478', marginTop: 4, letterSpacing: 1 }}>
                  {card.stock.market || '—'} · {card.date}
                </div>
                {fromSheet && card.statusBar?.status && (
                  <div style={{
                    display: 'inline-block', marginTop: 8,
                    padding: '3px 12px', borderRadius: 20, fontSize: 10, fontWeight: 600,
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
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#E8EAF0', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 7 }}>
                    <GradeDot grade={axis.grade} size={9} />
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
                    <div key={ii} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '4px 0', fontSize: 11, gap: 6 }}>
                      <div style={{ color: '#9CA3AF', display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto', maxWidth: '42%', wordBreak: 'keep-all' }}>
                        <span>{stripPeriod(item.label)}</span>
                        {(() => {
                          const m = item.metric || LABEL_TO_METRIC[item.label?.toLowerCase()];
                          return m ? (
                            <button onClick={() => setEvalSelectedMetric(m)} style={{
                              background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, fontSize: 10, lineHeight: 1, flexShrink: 0,
                            }} title={LEARNING_MODULES[m]?.title}>📘</button>
                          ) : null;
                        })()}
                      </div>
                      <div style={{ color: '#E8EAF0', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, textAlign: 'right', minWidth: 0 }}>
                        <span style={{ fontWeight: 600, wordBreak: 'break-word' }}>{item.value}</span>
                        {item.source && <span style={{ fontSize: 9, color: '#5A6478', wordBreak: 'break-word' }}>{item.source}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              ))}

              {/* 결론·근거·리스크·액션·출처 */}
              <div style={{ borderTop: '1px solid #2A2F3E', marginTop: 10, paddingTop: 12 }}>
                {(() => {
                  const concRaw = fromSheet ? card.conclusion.raw : `${card.conclusion.grade} ${card.conclusion.label}`;
                  const cc = gradeColor(concRaw);
                  return (
                    <div style={{ textAlign: 'center', marginBottom: 14 }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9, padding: '8px 18px', borderRadius: 22, background: `${cc}1A`, border: `1px solid ${cc}66` }}>
                        <span style={{ fontSize: 10, color: '#5A6478', fontWeight: 600, letterSpacing: 1 }}>결론</span>
                        <GradeDot grade={concRaw} size={11} />
                        <span style={{ fontSize: 15, fontWeight: 800, color: cc, letterSpacing: 0.3 }}>{stripGrade(concRaw) || '—'}</span>
                      </div>
                    </div>
                  );
                })()}

                {card.reasons.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <SubLabel color="#10B981">근거</SubLabel>
                    {card.reasons.map((r, i) => <NumberedItem key={i} n={i + 1} text={r} color="#C2C8D4" numColor="#10B981" />)}
                  </div>
                )}

                {card.risks.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <SubLabel color="#F87171">리스크</SubLabel>
                    {card.risks.map((r, i) => <NumberedItem key={i} n={i + 1} text={r} color="#F8A4A4" numColor="#F87171" />)}
                  </div>
                )}

                {card.actions.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <SubLabel color="#60A5FA">Frank 액션 권고</SubLabel>
                    {card.actions.map((a, i) => <NumberedItem key={i} n={'•'} text={a} color="#A9C7F5" numColor="#60A5FA" />)}
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
            .filter(s => s.qty > 0 && evaluations.some(e => e.stock?.name === s.name))
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
                평가가 완료된 보유 종목이 없습니다.<br/>
                <span style={{ fontSize: 11, color: '#3A4050' }}>매수평가 탭에서 평가 후 보유 중이면 여기에 표시됩니다.</span>
              </div>
            );
          }

          return (
            <div style={{ textAlign: 'left' }}>
              {/* 헤더 */}
              <SectionTitle color="#F87171" sub={`평가 완료 ${stocks.length}종목 · 보유 중`}>매도검토</SectionTitle>

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
                const latestEval = stockEvals[0] || null;
                const canSellEval = !!earliestEval && earliestEval.reasons.length > 0 && sheets.auth === 'signed-in' && !noteSellBusy;

                // ── 상태 모니터 파생값 ──
                const daysSinceEval = latestEval?.date
                  ? Math.floor((Date.now() - new Date(latestEval.date).getTime()) / 86400000)
                  : null;
                const _momentum = latestEval?.axisItems?.모멘텀 || [];
                const rsiItem = _momentum.find(i => i.metric === 'rsi' || String(i.label||'').toUpperCase().includes('RSI'));
                const pos52Item = _momentum.find(i => i.metric === 'pos_52w' || String(i.label||'').includes('52주'));
                const rsiVal = rsiItem ? (parseFloat(String(rsiItem.value||'').replace(/[^0-9.]/g, '')) || null) : null;
                const pos52Val = pos52Item ? (parseFloat(String(pos52Item.value||'').replace(/[^0-9.]/g, '')) || null) : null;
                const rsiOver = rsiVal !== null && rsiVal > 70;
                const rsiUnder = rsiVal !== null && rsiVal < 30;
                const pos52Over = pos52Val !== null && pos52Val > 80;
                const hasAlerts = rsiOver || rsiUnder || pos52Over;
                const onSellEvalClick = async () => {
                  if (!canSellEval) return;
                  setNoteSellBusy(true);
                  try {
                    const market = earliestEval?.stock?.market || (/^[0-9]{6}$/.test(earliestEval?.stock?.ticker || '') ? 'KR' : 'US');
                    const _now2 = new Date();
                    const requestedAt = `${_now2.getFullYear()}-${String(_now2.getMonth()+1).padStart(2,'0')}-${String(_now2.getDate()).padStart(2,'0')} ${String(_now2.getHours()).padStart(2,'0')}:${String(_now2.getMinutes()).padStart(2,'0')}`;
                    const row = [requestedAt, stock.name, market, '대기', '', '매도 평가'];
                    await sheets.appendValues('평가요청!A2:F', [row]);
                    setNoteSellCopied(true);
                    setTimeout(() => setNoteSellCopied(false), 2000);
                  } catch (e) {
                    console.error('매도 평가 큐 추가 실패:', e);
                  } finally {
                    setNoteSellBusy(false);
                  }
                };
                return (
                <>
                  {/* 보유 정보 카드 */}
                  <div style={{ background: '#1A1D26', borderRadius: 12, padding: '16px 16px 14px', marginBottom: 12 }}>
                    {/* 경고 배너 */}
                    {hasAlerts && (
                      <div style={{ marginBottom: 10, padding: '6px 10px', borderRadius: 8, background: '#4A1E1E44', border: '1px solid #F8717144', fontSize: 10, color: '#F87171', fontWeight: 600 }}>
                        {[
                          rsiOver ? `RSI ${Math.round(rsiVal)} 과열 — 차익실현 검토` : null,
                          rsiUnder ? `RSI ${Math.round(rsiVal)} 급락 — 매수 기회 점검` : null,
                          pos52Over ? `52주 ${Math.round(pos52Val)}% 고점 근접` : null,
                        ].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    <div style={{ textAlign: 'center', marginBottom: 12 }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#E8EAF0', letterSpacing: 0.3 }}>{stock.name}</div>
                      <div style={{ fontSize: 9, color: '#5A6478', marginTop: 3, letterSpacing: 1 }}>
                        {stock.type || '—'} · {stock.accounts.map(a => a.acct).join(' / ')}
                      </div>
                      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontSize: 20, fontWeight: 800, color: stock.profitSum >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                          {stock.profitSum >= 0 ? '+' : ''}{stock.rate.toFixed(1)}%
                        </span>
                        <span style={{ fontSize: 11, color: '#5A6478' }}>
                          {stock.profitSum >= 0 ? '+' : ''}₩{fmt(stock.profitSum)}
                        </span>
                      </div>
                    </div>

                    {/* 매도 평가 의뢰 */}
                    <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                      <button onClick={onSellEvalClick} disabled={!canSellEval} title={canSellEval ? '매도 평가를 큐에 추가' : '최초 매수 이유가 없어 매도 평가 불가'} style={{
                        flex: 1, padding: '6px 10px', borderRadius: 6,
                        border: `1px solid ${canSellEval ? '#F87171' : '#2A2F3E'}`,
                        background: canSellEval ? (noteSellCopied ? '#4ADE8033' : '#4A1E1E33') : 'transparent',
                        color: canSellEval ? (noteSellCopied ? '#4ADE80' : '#F87171') : '#3A3F4E',
                        cursor: canSellEval ? 'pointer' : 'not-allowed',
                        fontSize: 10, fontFamily: baseFont, fontWeight: 600,
                      }}>
                        {noteSellBusy ? '요청 중...' : noteSellCopied ? '✓ 큐에 추가됨' : `근거 점검${daysSinceEval !== null ? ` · ${daysSinceEval}일 전 평가` : ''}`}
                      </button>
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

                    {/* 상태 배지 — 마지막 평가 기준 */}
                    {(rsiVal !== null || pos52Val !== null || daysSinceEval !== null) && (
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1E2233', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        {rsiVal !== null && (
                          <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 9, fontWeight: 600, background: rsiOver ? '#4A1E1E33' : rsiUnder ? '#1A3A2633' : '#1E2233', color: rsiOver ? '#F87171' : rsiUnder ? '#4ADE80' : '#9CA3AF', border: `1px solid ${rsiOver ? '#F8717144' : rsiUnder ? '#4ADE8044' : '#2A2F3E'}` }}>
                            RSI {Math.round(rsiVal)}
                          </span>
                        )}
                        {pos52Val !== null && (
                          <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 9, fontWeight: 600, background: pos52Over ? '#4A3A1E33' : '#1E2233', color: pos52Over ? '#FBBF24' : '#9CA3AF', border: `1px solid ${pos52Over ? '#FBBF2444' : '#2A2F3E'}` }}>
                            52주 {Math.round(pos52Val)}%
                          </span>
                        )}
                        {daysSinceEval !== null && (
                          <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 9, background: daysSinceEval > 90 ? '#4A1E1E33' : daysSinceEval > 30 ? '#3A2A1E33' : '#1E2233', color: daysSinceEval > 90 ? '#F87171' : daysSinceEval > 30 ? '#FBBF24' : '#5A6478', border: `1px solid ${daysSinceEval > 90 ? '#F8717144' : daysSinceEval > 30 ? '#FBBF2444' : '#2A2F3E'}` }}>
                            평가 {daysSinceEval}일 전
                          </span>
                        )}
                      </div>
                    )}

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
                        <SectionTitle color="#60A5FA" size={12} mb={10}
                          sub={`매수일 ${earliest.buyDate || '미입력'} · 평가일 ${earliest.date}`}>
                          최초 매수 근거
                        </SectionTitle>
                        {earliest.reasons.length === 0 ? (
                          <div style={{ fontSize: 11, color: '#5A6478' }}>(근거 미기록)</div>
                        ) : earliest.reasons.map((r, i) => (
                          <NumberedItem key={i} n={i + 1} text={r} color="#9CA3AF" numColor="#60A5FA" />
                        ))}

                        {latest.aiNote && (
                          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1E2233' }}>
                            <SubLabel>AI 한 줄 (최신 평가)</SubLabel>
                            <Sentences text={latest.aiNote} style={{ fontSize: 11, color: '#E8EAF0', lineHeight: 1.6 }} />
                          </div>
                        )}

                        {latest.frankMemo && (
                          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1E2233' }}>
                            <SubLabel>Frank 메모</SubLabel>
                            <Sentences text={latest.frankMemo} style={{ fontSize: 11, color: '#E8EAF0', lineHeight: 1.6 }} />
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
                      <SectionTitle color="#3B82F6" size={12} mb={12} sub="최신순">평가 히스토리 {stockEvals.length}건</SectionTitle>
                      {stockEvals.map((ev, i) => (
                        <div key={i} style={{
                          padding: '8px 0',
                          borderTop: i === 0 ? 'none' : '1px solid #1E2233',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                            <div style={{ fontSize: 11, color: '#E8EAF0', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span>{ev.date}</span>
                              <GradeDot grade={ev.conclusion.raw} size={8} />
                              <span>{stripGrade(ev.conclusion.raw) || '—'}</span>
                            </div>
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              {[ev.axisGrades.수익성, ev.axisGrades.안정성, ev.axisGrades.밸류에이션, ev.axisGrades.현금흐름, ev.axisGrades.모멘텀].map((g, gi) => <GradeDot key={gi} grade={g} size={7} />)}
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
                        매수평가 탭에서 추가 →
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

        {/* ── 도움말 탭 ── */}
        {tab === "help" && (
          <div style={{ maxWidth: 760, margin: '0 auto', fontFamily: baseFont, textAlign: 'left' }}>
            <SectionTitle color="#3B82F6" size={15} sub="각 탭을 언제·어떻게 쓰나">실전 사용 가이드</SectionTitle>
            {renderMarkdown(guideBody)}
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
