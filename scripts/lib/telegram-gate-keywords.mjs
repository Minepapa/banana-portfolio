// 텔레그램 창구 낱말 라우팅 표 — 낱말이 분명하면 제우스 판단을 건너뛰고 그 담당 상시 프로세스로 바로 보낸다
// (2026-11-06 오너 승인, 속도 개선 2차 A-2). 이 객체 하나가 정본이고 telegram-gate-keywords.test.js가 강제한다.
//
// 규칙:
// - 한 담당의 낱말만 나오면 그 담당. 여러 담당 낱말이 섞이면 제우스(종합이 필요).
// - 판단·제안을 묻는 말("해도 될까"·"어떻게 하면 좋을까" 등)이 있으면 제우스(판단은 제우스가 종합하거나 넘긴다).
// - 낱말이 없으면 제우스. 오너가 담당 이름으로 부른 경우·사진·전달·여러 건 묶음은 이 표를 보지 않는다(routeTarget).
import { gateMcpToolsFor } from './telegram-gate-tool-table.mjs';

export const GATE_KEYWORD_TABLE = Object.freeze({
  hermes: Object.freeze(['일정', '캘린더', '미용실', '결제', '소비', '지출', '쓴 돈', '어디 갔', '어디갔', '동선', '출근', '퇴근', '할 일', '할일']),
  plutus: Object.freeze(['체결', '예수금', '보유', '주가', '시세', '리밸런싱', '매수', '매도', '배당', '포트폴리오', '수익률', '연금저축', 'IRP', 'ISA']),
  athena: Object.freeze(['미네']),
});

export const JUDGMENT_RE = /(해도\s*될까|해도\s*돼|어떻게\s*하면|하면\s*좋|좋을까|좋겠어|좋겠니|나을까|어떨까|괜찮을까|할까|말까|해야\s*할까|추천|제안|판단|의견)/u;

// 처리에 특정 도구가 필요한 요청(리뷰 HIGH): 약속·조건부 알림은 promise_add(제우스 전용), 기록·메모 요청은 memo_record(클리오 전용).
// 이런 요청은 낱말이 분명해도 그 도구가 있는 프로세스가 받아야 한다 — 담당 도구 표에 없으면 직행하지 않고 제우스에 둔다.
export const TOOL_NEEDING_REQUESTS = Object.freeze([
  { name: '약속·조건부 알림', re: /((되|끝나|오|나오|들어오|생기|바뀌|뜨|떨어지|오르)면\s*(바로\s*)?(알려|말해|연락)|약속|리마인더|알림\s*(줘|해\s*줘|설정|걸어)|잊지\s*않게)/u, tool: 'promise_add' },
  { name: '기록 요청', re: /(기록해|기록\s*해\s*줘|기록\s*남겨|남겨\s*(줘|둬)|메모해|메모\s*남겨|저장해|적어\s*(줘|둬))/u, tool: 'memo_record' },
]);

// 순수 함수: 오너 글 → 담당 id 또는 null(제우스). toolsFor(agent) → 그 담당 창구 MCP 도구 이름 목록(도구 표).
export function keywordTarget(text, { toolsFor = gateMcpToolsFor } = {}) {
  const t = String(text ?? '');
  if (!t.trim() || JUDGMENT_RE.test(t)) return null;
  const hits = Object.entries(GATE_KEYWORD_TABLE).filter(([, words]) => words.some((w) => t.includes(w))).map(([agent]) => agent);
  if (hits.length !== 1) return null;
  const needs = TOOL_NEEDING_REQUESTS.filter((r) => r.re.test(t));
  // 필요한 도구가 하나라도 그 담당에 없으면 제우스(제우스는 약속을 직접 맡고, 기록은 클리오에게 넘긴다).
  if (needs.some((r) => !toolsFor(hits[0]).includes(r.tool))) return null;
  return hits[0];
}
