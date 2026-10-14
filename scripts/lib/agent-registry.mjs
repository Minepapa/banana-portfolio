import { readFileSync } from 'node:fs';
// 담당 레지스트리 — 정본은 볼트 헌장(90_Delphi/Agents 머리말). build-agent-defs.mjs가 생성한 파일을 읽는다.
// 코드는 담당 이름을 문자열로 박지 않는다(옛 이름 잔존 사고 2026-10-14). 이름이 꼭 필요하면 담당 id나 업무 키로 부른다.
// 바꾸려면 헌장을 고치고 `node scripts/tools/build-agent-defs.mjs`를 다시 돌린다. 손으로 고치지 않는다.
const REGISTRY = JSON.parse(readFileSync(new URL('./agent-registry.generated.json', import.meta.url), 'utf8'));

export const AGENT_IDS = Object.freeze(Object.keys(REGISTRY.agents));

function agent(id) {
  const entry = REGISTRY.agents[id];
  if (!entry) throw new Error(`미등록 담당: ${id}`);
  return entry;
}

// '플루토스'
export const agentTitle = (id) => agent(id).title;
// '플루토스 Plutus' — 텔레그램 첫 줄 헤더 안쪽 문자열
export const agentLabel = (id) => agent(id).label;
// 업무 키(헌장 decisionDocs 키, 예: '거시 위험 트리거') → 담당 id
export function ownerOf(duty) {
  const id = REGISTRY.duties[duty];
  if (!id) throw new Error(`담당 없는 업무: ${duty}`);
  return id;
}
