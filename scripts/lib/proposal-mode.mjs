// 제안모드(허용|금지) — 오너가 "제안금지"/"제안요청"으로 자동 제안 생성 자체를 켜고
// 끄는 전역 스위치(2026-08-29, 오너 지시 — 자산분배 트랙 제안이 기준 없이 쌓여 대기
// 18건까지 늘어난 사고 이후 신설). 킬스위치(kill-switch.mjs)와의 차이: 킬스위치는
// "이미 승인된 제안의 실제 체결"만 막고 제안 생성 자체는 계속되지만, 이 스위치는
// 제안이 **생성·발송되는 것 자체**를 막는다 — 오너가 레거시 포지션(배당주·리츠·개별
// 종목)을 수동으로 정리하는 동안 새 자동 제안이 계속 쌓이지 않게 하려는 목적.
//
// **기본값은 반드시 허용(제안 생성 계속)** — State 파일이 아예 없거나 읽기 실패해도
// 안전한 쪽(기존 동작 유지)으로 떨어져야 한다(shadow-mode.mjs와 동일 원칙 — 설정
// 유실이 "의도치 않게 조용해짐"으로 이어지면 그 자체가 새로운 사고 유형이 된다).
import { buildFrontmatter, parseFrontmatter } from './vault-frontmatter.mjs';

export const MODE_ALLOWED = '허용';
export const MODE_BLOCKED = '금지';

export function buildProposalModeState({ mode, reason = '', now = new Date() }) {
  if (mode !== MODE_ALLOWED && mode !== MODE_BLOCKED) {
    throw new Error(`알 수 없는 제안모드: ${mode} (허용: ${MODE_ALLOWED}|${MODE_BLOCKED})`);
  }
  return buildFrontmatter({ mode, reason, changedAt: now.toISOString() });
}

export function getProposalMode(content) {
  if (!content) return MODE_ALLOWED;
  const p = parseFrontmatter(content);
  return p.mode === MODE_BLOCKED ? MODE_BLOCKED : MODE_ALLOWED;
}

export function isProposalBlocked(content) {
  return getProposalMode(content) === MODE_BLOCKED;
}
