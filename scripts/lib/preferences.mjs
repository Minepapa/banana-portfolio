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
