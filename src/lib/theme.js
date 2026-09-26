// 편안한 파스텔 디자인 토큰 — 따뜻한 종이 배경, 부드러운 라임 강조, 옅은 테두리와 은은한 그림자.
// 색·테두리·그림자·라운드의 정본. 카드·버튼 등 공유 표면은 여기 스타일 객체를 import해 쓴다.

// ── 코어 팔레트 ────────────────────────────────────────────────────────────────
export const PAPER = '#F5F2EA';
export const PAPER_2 = '#ECE7DA';
export const CARD_BG = '#FEFCF6';
export const INK = '#242019';
export const INK_2 = '#7A7566';
export const ACCENT = '#DCEEA3';
export const ALERT = '#FF9466';

// ── 구조 토큰 ─────────────────────────────────────────────────────────────────
export const BORDER_COLOR = 'rgba(36, 32, 25, 0.6)';
export const RADIUS = 12;
export const RADIUS_SM = 8;
export const RADIUS_LG = 16;
export const BORDER = `1.5px solid ${BORDER_COLOR}`;
export const BORDER_HEAVY = `2px solid ${BORDER_COLOR}`;
export const SHADOW = '0 3px 10px rgba(36,32,25,0.10), 0 1px 2px rgba(36,32,25,0.06)';
export const SHADOW_SM = '0 2px 5px rgba(36,32,25,0.10)';

// 숫자·데이터 — 모노스페이스로 브루탈리스트 데이터 캐릭터. 웹폰트 의존 0.
export const MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, monospace";

// ── 공유 표면 스타일 객체 ──────────────────────────────────────────────────────
// 흰 카드: 종이 위 흰 블록 + 두꺼운 검정 테두리 + 오프셋 그림자 + 직각.
export const CARD = {
  background: CARD_BG,
  border: BORDER,
  borderRadius: RADIUS,
  boxShadow: SHADOW,
};

// 기본 버튼: 종이 면 + 검정 테두리 + 작은 오프셋.
export const BTN = {
  background: CARD_BG,
  color: INK,
  border: BORDER,
  borderRadius: RADIUS,
  boxShadow: SHADOW_SM,
  fontWeight: 700,
  cursor: 'pointer',
};

// 주요 CTA: 라임 fill + 검정 텍스트.
export const BTN_PRIMARY = {
  ...BTN,
  background: ACCENT,
  color: INK,
};

// 경보 CTA: 오렌지 fill + 흰 텍스트.
export const BTN_ALERT = {
  ...BTN,
  background: ALERT,
  color: '#FFFFFF',
};
