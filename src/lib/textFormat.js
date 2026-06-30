// 순수 문자열 포맷·파싱 헬퍼. App.jsx에서 추출 (동작 불변, JSX 없음).

// 콤마·공백 섞인 문자열 → 숫자 (실패 시 0)
export function parseNum(v) {
  return parseFloat(String(v ?? 0).replace(/,/g, '')) || 0;
}

// 시트 날짜 셀 → "YYYY-MM-DD" 문자열.
// 셀 포맷이 '일반'이면 날짜가 구글 시트 시리얼 넘버(예: 46189.25)로 들어온다.
// 이미 "2026-06-15" 같은 텍스트면 앞 10자만 잘라 그대로 반환. 순수 숫자형만 변환.
// 시리얼 기준일 1899-12-30(구글 시트), 1일 = 86400000ms.
export function toDateStr(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d+(\.\d+)?$/.test(s)) {                 // 순수 숫자 = 시리얼로 간주
    const serial = parseFloat(s);
    if (serial > 1) {                            // 1900년 이후만 (0·1은 무효 방지)
      const ms = Math.round((serial - 25569) * 86400000); // 25569 = 1970-01-01의 시리얼
      const d = new Date(ms);
      if (!isNaN(d)) return d.toISOString().slice(0, 10);
    }
  }
  return s.slice(0, 10);                          // "2026-06-15 06:11" → "2026-06-15"
}

// 상대 시각 ("3분 전" · "2시간 전") — 마지막 갱신 표시용
export const relTime = (date) => {
  if (!date) return '';
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return '방금 전';
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
};

// 이모지·픽토그램·별표 제거 후 중복 공백 정리 (도움말은 텍스트만 표시)
export function stripEmoji(text) {
  return String(text)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}]|\u{FE0F}|\u{200D}|\u{20E3}/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ── 등급 표시: 🟢🟡🔴⚪ → 폰트 비의존 CSS 원 ───────────────────────────────────
export const GRADE_COLORS = { '🟢': '#10B981', '🟡': '#F5C842', '🔴': '#EF4444', '⚪': '#6B7280' };
export function gradeColor(s) {
  const str = String(s ?? '');
  for (const k of Object.keys(GRADE_COLORS)) if (str.includes(k)) return GRADE_COLORS[k];
  return '#6B7280';
}
export function stripGrade(s) {
  return String(s ?? '').replace(/[🟢🟡🔴⚪]/gu, '').trim();
}
// 항목명에서 연도·분기 표기(중복) 제거 — 출처는 숫자 아래에 따로 표기됨.
// "RSI(14)" 같은 파라미터 괄호는 보존(연도/분기 토큰이 있을 때만 제거).
export function stripPeriod(label) {
  const PERIOD = /\d{4}|분기|반기|연간|[1-4]\s*분기|[1-4]\s*Q|Q[1-4]|FY\d|TTM/i;
  return String(label ?? '')
    .replace(/\s*[([][^)\]]*[)\]]\s*$/g, (m) => (PERIOD.test(m) ? '' : m))
    .replace(/\s*[,·]\s*(?:[^,·()]*(?:\d{4}|분기|반기|연간|TTM|Q[1-4])[^,·()]*)\s*$/i, '')
    .trim();
}

// ── 마침표·의미(— · 등) 단위로 줄바꿈 ───────────────────────────────────────────
export function breakUnits(text) {
  return String(text ?? '')
    .replace(/\s*[—–]\s*/g, '\n')          // 줄표 → 의미 끊김
    .replace(/\s+→\s+/g, '\n')             // 흐름 화살표(공백 양옆) → 단계 줄바꿈
    .replace(/([.。!?…])\s+/g, '$1\n')      // 문장 종결 뒤 → 줄바꿈
    .split('\n').map(s => s.trim()).filter(Boolean);
}
// 문장 종결(. 。 ! ? …) 뒤에서만 줄바꿈 — — · → 는 끊지 않음(카드 끝까지 채움).
export function breakSentences(text) {
  return String(text ?? '')
    .replace(/([.。!?…])\s+/g, '$1\n')
    .split('\n').map(s => s.trim()).filter(Boolean);
}
