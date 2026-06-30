// 네오 브루탈리즘 디자인 토큰 — 종이 배경 + 두꺼운 검정 테두리 + 애시드 강조 + 하드 오프셋 그림자 + 직각.
// 색·테두리·그림자·라운드의 정본. 카드·버튼 등 공유 표면은 여기 스타일 객체를 import해 쓴다.
// (탭들의 인라인 hex는 별도 스윕으로 이 값에 맞춰 치환됨 — 레이아웃 불변.)

// ── 코어 팔레트 ────────────────────────────────────────────────────────────────
export const PAPER = '#F4F1E9';   // 앱 배경 (따뜻한 오프화이트)
export const PAPER_2 = '#EAE6DA'; // 인셋·비활성 표면
export const CARD_BG = '#FFFFFF'; // 카드 면 (paper 위 흰 블록)
export const INK = '#141414';     // 본문 텍스트 + 모든 테두리
export const INK_2 = '#6B675C';   // 보조·캡션 텍스트 (웜 그레이)
export const ACCENT = '#C9F23E';  // 애시드 라임 — 활성·핵심 강조 (위에 ink 텍스트)
export const ALERT = '#FF5C2B';   // 시그널 오렌지 — 경보·긴급 CTA 전용

// ── 구조 토큰 ─────────────────────────────────────────────────────────────────
export const RADIUS = 0;                       // 직각 (샤프)
export const BORDER = `2px solid ${INK}`;       // 기본 테두리
export const BORDER_HEAVY = `3px solid ${INK}`; // 헤더·강조 구획
export const SHADOW = `4px 4px 0 ${INK}`;       // 하드 오프셋 (블러 0)
export const SHADOW_SM = `2px 2px 0 ${INK}`;    // 작은 칩·버튼용

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
