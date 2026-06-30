// 앱 색상 시스템 — 손익 색상·차트·자산군 팔레트. constants.js에서 분리 (동작 불변).

// 한국 주식 색상 체계: 이익=빨강, 손실=파랑, 변동없음=중립회색 (브루탈 톤: 볼드·고대비)
export const PROFIT_POS = '#E5484D';
export const PROFIT_NEG = '#2F62E8';
export const PROFIT_FLAT = '#6B675C';
export const CHART_BAR_COLOR = '#141414';

// 손익 색상: 0은 중립색 (색맹·변동없음 혼란 방지)
export const profitColor = (n) => n > 0 ? PROFIT_POS : n < 0 ? PROFIT_NEG : PROFIT_FLAT;

// ── 자산군 색상 팔레트 ─────────────────────────────────────────────────────────
export const COLORS = {
  채권: "#4A90D9", 금: "#F5C842", 달러: "#7EC8A4", 배당주: "#F4845F",
  리츠: "#B07FE8", 국내주식: "#E85F7A", 해외주식: "#52C8D4", TDF: "#A8D672",
  현금성: "#8A93A6",
};
