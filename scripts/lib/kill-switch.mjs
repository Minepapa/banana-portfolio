// 킬스위치 — docs/ARCHITECTURE-V2.md "안전장치 계층 > 킬스위치" 절.
// Frank가 텔레그램에 "정지"/"STOP"을 보내면 즉시 모든 자동 실행이 멈춘다(새 제안 생성은
// 계속되되, 승인이 와도 체결은 안 나감). 해제는 명시적 명령어로만 — 자동 재개 없음.
// 텔레그램 명령 파싱·State 파일 실제 쓰기는 Phase 5(텔레그램 승인 흐름) 소관 — 이 모듈은
// 상태 판정 로직만 순수 함수로 제공한다.
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
