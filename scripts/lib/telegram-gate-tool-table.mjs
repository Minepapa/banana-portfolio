// 텔레그램 창구 담당별 도구 표 — 어느 담당 프로세스가 어떤 창구 MCP 도구를 쓸 수 있는지의 정본은 이 객체 하나다
// (2026-11-06 오너 결정 B안, 볼트 요청 `텔레그램 창구 답변 속도 개선`).
//
// 원칙(테스트가 강제한다: telegram-gate-tool-table.test.js):
// - 모든 담당: Read·Grep·Glob(읽기 가드·비밀 거부 규칙은 그대로) + 사실 도구(department_facts·facts_tool) + 요청 기록(request_record).
// - 볼트 기록 쓰기(📜 메모·사진 판독 기록·장소 등록·위키 답)는 클리오만 한다. 요청 기록과 활동 로그는 각 담당이 쓴다(B안).
// - 어떤 담당에도 Write·Edit·Bash 같은 직접 파일 쓰기·셸 도구는 주지 않는다. 실행은 창구 MCP 도구로만.
// - 돈: order_stage는 지금처럼 "접수 대기 + 창구 재확인"까지만(제우스·플루토스). 실제 주문 도구는 어디에도 없다.
// - 제우스는 창구 대표라 일정·할 일 등록·약속·제안 답장을 그대로 갖고, 볼트 기록이 필요하면 클리오에게 넘긴다(handoff).
export const GATE_READ_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);
export const GATE_COMMON_MCP_TOOLS = Object.freeze(['department_facts', 'facts_tool', 'request_record']);
export const VAULT_RECORD_TOOLS = Object.freeze(['memo_record', 'photo_record', 'place_register', 'wiki_question_resolve']);

export const GATE_TOOL_TABLE = Object.freeze({
  zeus: Object.freeze([...GATE_COMMON_MCP_TOOLS, 'calendar_list', 'calendar_add_event', 'tasks_add', 'tasks_delete', 'proposal_reply', 'order_stage',
    'promise_add', 'promise_cancel', 'promise_list']),
  hermes: Object.freeze([...GATE_COMMON_MCP_TOOLS, 'calendar_list', 'calendar_add_event', 'tasks_add', 'tasks_delete']),
  plutus: Object.freeze([...GATE_COMMON_MCP_TOOLS, 'order_stage', 'proposal_reply']),
  athena: Object.freeze([...GATE_COMMON_MCP_TOOLS]),
  themis: Object.freeze([...GATE_COMMON_MCP_TOOLS]),
  clio: Object.freeze([...GATE_COMMON_MCP_TOOLS, ...VAULT_RECORD_TOOLS]),
});

// 내장 도구: 모두 읽기 도구만. 하위 에이전트(Agent)는 없다 — 제우스는 담당 상시 프로세스로 넘긴다(handoff). 창구는 판테온 루트 밖에서
// 떠서(A-4) 루트의 담당 정의(.claude/agents)를 싣지 않으므로 Agent를 줘도 담당을 부를 수 없다.
export function gateBuiltinTools(agent) {
  gateMcpToolsFor(agent);
  return [...GATE_READ_TOOLS];
}

export function gateMcpToolsFor(agent) {
  const tools = GATE_TOOL_TABLE[agent];
  if (!tools) throw new Error(`도구 표에 없는 담당: ${agent}`);
  return tools;
}
