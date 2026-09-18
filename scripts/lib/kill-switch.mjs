// 킬스위치 — docs/ARCHITECTURE-V2.md "안전장치 계층 > 킬스위치" 절.
// Frank가 텔레그램에 "정지"/"STOP"을 보내면 즉시 모든 자동 실행이 멈춘다(새 제안 생성은
// 계속되되, 승인이 와도 체결은 안 나감). 해제는 명시적 명령어로만 — 자동 재개 없음.
// 텔레그램 명령 파싱·State 파일 실제 쓰기는 Phase 5(텔레그램 승인 흐름) 소관 — 이 모듈은
// 상태 판정 로직만 순수 함수로 제공한다.
//
// ⚠️ 전역 단일 스위치 — 트랙 구분 없음(2026-09-18 코드리뷰 MEDIUM 지적으로 문서화).
// execute-quant-proposal.mjs·execute-asset-allocation-proposal.mjs(자산분배·구퀀트,
// 오너 승인 후 체결)에 이어 2026-09-18부터 place-breakout-entry-order.mjs·
// place-breakout-fallback-entry.mjs(카이로스 돌파매매, 승인 없는 완전자동)까지 이
// 하나의 State/KillSwitch/KillSwitch.md를 공유한다. 즉 "카이로스만 멈추고 싶어서"
// 켜면 승인 거친 자산분배 주문까지 같이 멈추고, 반대로 다른 트랙 사유로 켜둔 동안엔
// 카이로스도 조용히 멈춘 채 대기항목이 쌓인다(place-breakout-fallback-entry.mjs의
// isPendingEntryStale이 그 누적을 무기한 방치하지 않게 하는 별도 안전장치). 트랙별
// 스코프 분리가 필요해지면 이 파일에 track 파라미터를 추가하는 대신 별도 State
// 경로(예: State/KillSwitch/Kairos.md)를 신설하는 편이 기존 세 실행부의 계약을
// 안 건드리고 확장하기 쉽다.
import { buildFrontmatter, parseFrontmatter } from './vault-frontmatter.mjs';

const DEFAULT_STATE = { active: false, reason: '', changedAt: null };

export function buildKillSwitchState({ active, reason = '', now = new Date() }) {
  return buildFrontmatter({ active, reason, changedAt: now.toISOString() });
}

export function parseKillSwitchState(content) {
  if (!content) return { ...DEFAULT_STATE }; // 파일이 아직 없으면 = 꺼짐(안전 기본값)
  const p = parseFrontmatter(content);
  return { active: p.active === true, reason: p.reason ?? '', changedAt: p.changedAt ?? null };
}

export function isKillSwitchActive(content) {
  return parseKillSwitchState(content).active;
}
