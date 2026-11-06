// 텔레그램 창구 낱말 라우팅 표 — 낱말이 분명하면 제우스 판단을 건너뛰고 그 담당 상시 프로세스로 바로 보낸다
// (2026-11-06 오너 승인, 속도 개선 2차 A-2). 이 객체 하나가 정본이고 telegram-gate-keywords.test.js가 강제한다.
//
// 규칙:
// - 한 담당의 낱말만 나오면 그 담당. 여러 담당 낱말이 섞이면 제우스(종합이 필요).
// - 판단·제안을 묻는 말("해도 될까"·"어떻게 하면 좋을까" 등)이 있으면 제우스(판단은 제우스가 종합하거나 넘긴다).
// - 낱말이 없으면 제우스. 오너가 담당 이름으로 부른 경우·사진·전달·여러 건 묶음은 이 표를 보지 않는다(routeTarget).
export const GATE_KEYWORD_TABLE = Object.freeze({
  hermes: Object.freeze(['일정', '약속', '캘린더', '미용실', '결제', '소비', '지출', '쓴 돈', '어디 갔', '어디갔', '동선', '출근', '퇴근', '할 일', '할일', '리마인더']),
  plutus: Object.freeze(['체결', '예수금', '보유', '주가', '시세', '리밸런싱', '매수', '매도', '배당', '포트폴리오', '수익률', '연금저축', 'IRP', 'ISA']),
  athena: Object.freeze(['미네']),
});

export const JUDGMENT_RE = /(해도\s*될까|해도\s*돼|어떻게\s*하면|하면\s*좋|좋을까|좋겠어|좋겠니|나을까|어떨까|괜찮을까|할까|말까|해야\s*할까|추천|제안|판단|의견)/u;

// 순수 함수: 오너 글 → 담당 id 또는 null(제우스).
export function keywordTarget(text) {
  const t = String(text ?? '');
  if (!t.trim() || JUDGMENT_RE.test(t)) return null;
  const hits = Object.entries(GATE_KEYWORD_TABLE).filter(([, words]) => words.some((w) => t.includes(w))).map(([agent]) => agent);
  return hits.length === 1 ? hits[0] : null;
}
