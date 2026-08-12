// 텔레그램 메시지 포맷 + 인바운드 텍스트 해석 — 순수 함수.
// docs/ARCHITECTURE-V2.md "메시지 형식 — 부서 라벨 + Zeus 판단 코멘트" 절 +
// 구현계획서 Phase 5(오너 확정, 2026-08-05: 부서 보고+Zeus 코멘트는 한 메시지에 합침).

// 부서 보고와 [Zeus] 판단 코멘트를 한 메시지에 합친다(2026-08-05 오너 확정 — 텔레그램
// 알림 개수를 늘리지 않기 위함). zeusComment가 없으면(아직 Zeus 판단 전 등) 부서
// 보고만 나간다.
export function formatDepartmentMessage({ departmentLabel, body, zeusComment = null }) {
  const header = `[${departmentLabel}]`;
  if (!zeusComment) return `${header}\n${body}`;
  return `${header}\n${body}\n\n[Zeus] ${zeusComment}`;
}

// Frank의 답장 텍스트에서 승인/거부 의사를 읽는다. "승인"·"거부"가 둘 다 있거나(모순)
// 둘 다 없으면 null — 추정하지 않는다(ADR 0003 폴백 금지 원칙). reply_to 매칭 자체는
// 이 함수의 책임이 아니다(order-gate.checkApprovalMatch + proposal-vault.
// findProposalByTelegramMessageId가 담당) — 이 함수는 텍스트 내용만 본다.
export function parseReplyDecision(text) {
  const t = String(text ?? '').trim();
  const hasApprove = t.includes('승인');
  const hasReject = t.includes('거부');
  if (hasApprove && !hasReject) return '승인';
  if (hasReject && !hasApprove) return '거부';
  return null;
}

// 킬스위치 명령 — 정확히 일치하는 명령어만 인정한다(캐주얼한 언급과 구분하기 위해
// 부분일치 대신 정확일치). ✅ 최종 확정(오너, 2026-08-12) — 2026-08-05에 "정지"/"해제"가
// 일상 대화에서도 흔히 쓰는 일반 단어라 오작동 위험이 있다고 지적돼 "재정의 전까지의
// 임시값"으로 남아있던 것을 이번에 확정. "실전전환"/"섀도우전환"과 동일한 원칙(이 목적
// 전용 복합어로 캐주얼한 단독 언급 위험을 낮춤)으로 "긴급정지"/"정지해제"로 교체.
// STOP/stop은 영문 명령으로 남겨둠(한국어 일상 대화에 섞여 나올 위험이 낮음, 오너가
// 이 부분은 이의 없음).
const ACTIVATE_WORDS = new Set(['긴급정지', 'STOP', 'stop']);
const DEACTIVATE_WORDS = new Set(['정지해제']);

export function parseKillSwitchCommand(text) {
  const t = String(text ?? '').trim();
  if (ACTIVATE_WORDS.has(t)) return 'activate';
  if (DEACTIVATE_WORDS.has(t)) return 'deactivate';
  return null;
}

// 체결모드(섀도우|실전) 전환 명령 — Phase 12. "실전전환"/"섀도우전환"은 구현계획서
// Phase 12 작업 설명에 이미 그대로 지정된 명령어라 그대로 채택(킬스위치의 "정지"/"해제"
// 처럼 일상 대화에 흔한 단일 단어가 아니라 이 목적 전용 복합어라 오작동 위험이 낮음 —
// 킬스위치 쪽 오너 지적과 동일한 우려가 여기선 상대적으로 적음). 정확일치만 인정
// (킬스위치와 동일 원칙 — "전환해볼까 실전전환처럼?" 같은 캐주얼한 언급과 구분).
const LIVE_WORDS = new Set(['실전전환']);
const SHADOW_WORDS = new Set(['섀도우전환']);

export function parseExecutionModeCommand(text) {
  const t = String(text ?? '').trim();
  if (LIVE_WORDS.has(t)) return 'live';
  if (SHADOW_WORDS.has(t)) return 'shadow';
  return null;
}

// "카이로스, ~" 같은 부서 직접호출 — 메시지 시작 부분의 부서명 키워드만 본다(구현
// 메모: "메시지 시작 부분의 부서명 키워드 매칭으로 우선 단순 구현 가능"). 구분자는
// 쉼표·공백 어느 쪽이든 허용.
const DEPARTMENTS = ['제우스', '아테나', '카이로스', '테미스', '헤르메스', '아폴로'];

export function parseDepartmentCall(text) {
  const t = String(text ?? '').trim();
  for (const name of DEPARTMENTS) {
    if (t.startsWith(name)) {
      const rest = t.slice(name.length).replace(/^[,\s]+/, '');
      return { department: name, message: rest };
    }
  }
  return null;
}
