// 성향관찰 시트 → 프롬프트 주입 공유 유틸. drain·risk-monitor·weekly-report 공용.
// 이 앱의 목적은 일반 시장 분석이 아니라 "Frank 맞춤 판단"이므로, 평가·리스크·리포트
// 모든 LLM 판단에 확정된 학습 성향을 동일하게 주입한다.
// 시트 스키마: 성향관찰!A2:H = [날짜, 신호유형, 관찰, 증거, §3대비, 신뢰도, 상태, 갱신시각]
export const PREF_SHEET = '성향관찰';

// 시트 행들 → 프롬프트용 압축 텍스트. 신호유형(B)·관찰(C)·§3대비(E)·상태(G)만. 기각은 제외.
// confirmedOnly=true 면 status='확정'만(평가·리스크·리포트 주입용), false 면 기각 외 전체(관찰 추출용).
export function renderPrefRows(rows, { confirmedOnly = false } = {}) {
  const lines = [];
  for (const r of rows) {
    const obs = String(r[2] ?? '').trim();
    const status = String(r[6] ?? '').trim() || '관찰';
    if (!obs || status === '기각') continue;
    if (confirmedOnly && status !== '확정') continue;
    lines.push(`- [${status}] ${String(r[1] ?? '').trim()}: ${obs}${r[4] ? ` (§3 대비 ${String(r[4]).trim()})` : ''}`);
  }
  return lines.join('\n');
}

// 확정 성향 프롬프트 블록 — drain·risk-monitor 판단에 동일 주입. 명시 성향(§3/Hub 프로필)과
// 함께 판단 기준으로 쓰되, 둘이 다르면 드러난 행동(학습 성향)을 우선한다.
export function prefBlock(confirmedText) {
  return `[확정 학습 성향 — Frank의 실제 행동에서 학습돼 본인이 확인한 성향. 명시 성향(§3 또는 Hub 프로필)과 함께 판단 기준으로 쓸 것. 둘이 다르면 드러난 행동(학습 성향)을 우선.]
${confirmedText || '(아직 확정된 학습 성향 없음 — 명시 성향만 사용)'}`;
}

// 구조조정 안건5 — 승격후보 TTL(4주 무응답 시 자동 관찰 보류). 순수 판정만 하는 함수 —
// 실제 시트 되돌리기(G·H열 업데이트)는 호출부(weekly-report.mjs)가 이 결과로 수행한다.
// rows: 성향관찰!A2:H 원본. 상태(G열=idx6)가 '승격후보'이고 갱신시각(H열=idx7, 없으면
// 날짜 A열=idx0으로 폴백)이 ttlWeeks 이상 지난 행을 찾는다. 날짜 파싱 불가 시 판정을
// 보류한다(추정 금지 — 이 세션의 숫자 무결성 원칙과 동일선상).
const WEEK_MS = 7 * 24 * 3600_000;

export function findExpiredPromotions(rows, { now = new Date(), ttlWeeks = 4 } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const out = [];
  (rows || []).forEach((r, idx) => {
    if (String(r?.[6] ?? '').trim() !== '승격후보') return;
    const tsStr = String(r?.[7] ?? '').trim() || String(r?.[0] ?? '').trim();
    const ts = Date.parse(tsStr);
    if (!Number.isFinite(ts)) return;
    const ageWeeks = (nowMs - ts) / WEEK_MS;
    if (ageWeeks >= ttlWeeks) out.push({ rowNum: idx + 2, obs: String(r?.[2] ?? '').trim(), ageWeeks: Math.floor(ageWeeks) });
  });
  return out;
}
