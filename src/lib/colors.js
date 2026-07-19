// 앱 색상 시스템 — 손익 색상·차트·자산군 팔레트. constants.js에서 분리 (동작 불변).
import { ACCENT } from './theme.js';

// 한국 주식 색상 체계: 이익=빨강, 손실=파랑, 변동없음=중립회색 (브루탈 톤: 볼드·고대비)
export const PROFIT_POS = '#E5484D';
export const PROFIT_NEG = '#2F62E8';
export const PROFIT_FLAT = '#6B675C';
export const CHART_BAR_COLOR = '#C9F23E';

// 손익 색상: 0은 중립색 (색맹·변동없음 혼란 방지)
export const profitColor = (n) => n > 0 ? PROFIT_POS : n < 0 ? PROFIT_NEG : PROFIT_FLAT;

// ── 리스크 신호 색상 — 2단 체계 ────────────────────────────────────────────
// ①심각도색(signalColor): 개별 신호 카드처럼 "이 신호 자체가 얼마나 위험한가"를
//   보여줄 때만 이모지(🔴/🟡/🟢)로 파생 — 오늘·리스크·포지션 탭 공유 단일 정본.
// ②카테고리색(SIGNAL_OPPORTUNITY): "경보/주의"(위험)와 "기회"(급락 매수 기회)는
//   같은 요약 묶음 안에서 나란히 보이는 서로 다른 종류라 심각도색을 그대로 쓰면
//   구분이 안 된다(기회 신호가 보통 🔴라 "경보"와 똑같은 빨강이 됨). 요약 칩·체크
//   리스트 항목처럼 "묶음 종류"를 표시하는 자리는 심각도 대신 이 고정색을 쓴다.
// 예외: O(급락매수)는 리스크가 아니라 기회라 상세 카드에서도 심각도 대신 이 카테고리색을
//   쓴다(요약 칩뿐 아니라 개별 카드까지 — RiskTab cardColor/statusLabel 참조). O를 🔴처럼
//   "경보"로 표시하면 위험이 아닌데 위험처럼 읽혀 원칙①에 대한 유일한 예외로 둔다.
// (2026-07 사고 ①: 탭마다 색을 따로 정의해 같은 급락 신호가 주황/파랑/빨강으로
//  제각각. 사고 ②: 심각도색 통일 후엔 "경보"·"기회" 칩이 둘 다 빨강이 되어버림.
//  사고 ③: 기회 칩만 카테고리색 적용 후 그 칩이 세는 개별 카드는 여전히 빨강+"경보"로
//  남아 칩-카드 색·라벨이 어긋남 — O는 상세 카드까지 카테고리색으로 예외 처리.)
export const SIGNAL_RED = '#E5484D';
export const SIGNAL_AMBER = '#E0A000';
export const SIGNAL_GREEN = '#159E52';
// 마젠타 — 위험 계열(빨강/주황/초록)과 겹치지 않는 고유색. 오늘 탭 다른 항목 accent
// (검정·빨강·주황·초록·연두·하늘·보라 — 주간정리 #52C8D4, 월간회고 #8B5CF6 등)와도 안 겹치게
// 새 색을 골랐다(#8B5CF6는 월간회고와 같은 날 동시에 뜰 수 있어 재충돌 위험 — 실제 지적됨).
export const SIGNAL_OPPORTUNITY = '#EC4899';
export const signalColor = (signal) => {
  const s = String(signal ?? '');
  return s.includes('🔴') ? SIGNAL_RED : s.includes('🟡') ? SIGNAL_AMBER : SIGNAL_GREEN;
};

// ── 자산군 색상 팔레트 ─────────────────────────────────────────────────────────
export const COLORS = {
  채권: "#4A90D9", 금: "#F5C842", 달러: "#7EC8A4", 배당주: "#F4845F",
  리츠: "#B07FE8", 국내주식: "#E85F7A", 해외주식: "#52C8D4", TDF: "#A8D672",
  현금성: "#8A93A6",
};

// ── 판테온 부서 색상·아이콘 — 앱 UX에 조직 정체성을 입히는 배지(DeptBadge)가 소비 ──────
// Zeus는 신규 hex 대신 기존 ACCENT 재사용(CHART_BAR_COLOR도 이미 이렇게 씀 — 기존 관례).
// 나머지 4색은 위 COLORS·SIGNAL_*·PROFIT_*와 전수 대조해 구별되게 골랐음. 단 Apollo 골드
// 계열(#D9A441)은 금(#F5C842)·SIGNAL_AMBER(#E0A000)와 계열이 가까워 육안 재확인 대상.
export const DEPARTMENTS = {
  zeus:   { name: 'Zeus',   label: '대표',         color: ACCENT,    icon: '⚡' },
  athena: { name: 'Athena', label: '투자전략실',   color: '#5B7B4F', icon: '🛡️' },
  themis: { name: 'Themis', label: '리스크관리실', color: '#3D4A7A', icon: '⚖️' },
  hermes: { name: 'Hermes', label: '운영실',       color: '#B5722E', icon: '🪽' },
  apollo: { name: 'Apollo', label: '비서실',       color: '#B8862F', icon: '☀️' }, // 육안 확인 후 짙게 조정(대비 확보)
};
