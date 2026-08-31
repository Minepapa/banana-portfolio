// 텔레그램 메시지 포맷 + 인바운드 텍스트 해석 — 순수 함수.
// docs/ARCHITECTURE-V2.md "메시지 형식 — 부서 라벨 + Zeus 판단 코멘트" 절 +
// 구현계획서 Phase 5(오너 확정, 2026-08-05: 부서 보고+Zeus 코멘트는 한 메시지에 합침).
//
// ⚠️ 전면 개정(2026-08-23, 오너 지시 — "텔레그램 구조 개선, 이모티콘 전부 제외,
// 기호 충분히 활용, 모바일 줄바꿈 고려") — 이모지(✅❌⚠️⏳⛔📰 등)를 전부 없애고
// 대괄호 태그(예: [경고][완료][취소][차단][만료][오류][제안][안내])로 상태를 명시하는
// 방식으로 교체(오너가 미리보기 3안 중 "대괄호 태그형"을 확정). 부서 헤더 아래 구분선
// (SEPARATOR)을 추가해 모바일에서 헤더/본문 경계가 시각적으로 분명해지게 했다.
const SEPARATOR = '─'.repeat(16);

// tag: 이 메시지의 상태를 나타내는 대괄호 단어(예: '제안'·'완료'·'경고') — 없으면
// (기본값) 태그 없이 부서 헤더만. 아래 두 포맷 함수가 공유하는 헤더 규칙.
function buildHeader(departmentLabel, tag) {
  return tag ? `[${tag}] [${departmentLabel}]` : `[${departmentLabel}]`;
}

// 부서 보고와 [Zeus] 판단 코멘트를 한 메시지에 합친다(2026-08-05 오너 확정 — 텔레그램
// 알림 개수를 늘리지 않기 위함). zeusComment가 없으면(아직 Zeus 판단 전 등) 부서
// 보고만 나간다.
export function formatDepartmentMessage({ departmentLabel, body, zeusComment = null, tag = null }) {
  const header = buildHeader(departmentLabel, tag);
  let msg = `${header}\n${SEPARATOR}\n${body}`;
  if (zeusComment) msg += `\n\n[Zeus] ${zeusComment}`;
  return msg;
}

// 텔레그램 알림 표준 구조(2026-08-17 오너 확정, 2026-08-23 태그·구분선 추가, 2026-08-31
// 3단 구조로 확장) — [부서]로 시작 → Node가 계산한 사실을 개조식(중점 불릿)으로 나열 →
// LLM이 그 사실이 왜 중요한지 서술형 문단(context)으로 붙이고 → 생각해볼 점/선택지를
// 다시 개조식(considerations)으로 붙인다. 오너 지적(2026-08-31) — 예전엔 "사실+해석
// 문단 1개"뿐이라 숫자만 보고 실제로 뭘 고민해야 하는지가 안 나왔다. context·considerations
// 둘 다 없으면(health-watcher처럼 애초에 LLM을 안 부르는 순수 운영 알림, 또는 조용한
// 날의 morning-briefing처럼 LLM 호출 자체를 생략한 경우) 사실만 나간다 —
// formatDepartmentMessage와 달리 body를 자유 문자열로 안 받고 facts 배열을 강제해,
// 호출부가 사실과 해석을 섞어서 쓰지 않도록 구조로 유도한다.
export function formatFactsMessage({ departmentLabel, facts, context = null, considerations = null, zeusComment = null, tag = null }) {
  const header = buildHeader(departmentLabel, tag);
  const factBlock = (facts ?? []).map((f) => `· ${f}`).join('\n');
  let msg = `${header}\n${SEPARATOR}\n${factBlock}`;
  if (context) msg += `\n\n${context}`;
  if (considerations?.length) msg += `\n\n[생각해볼 점]\n${considerations.map((c) => `· ${c}`).join('\n')}`;
  if (zeusComment) msg += `\n\n[Zeus] ${zeusComment}`;
  return msg;
}

// 마커 상수(2026-08-31 신설, 코드리뷰 지적) — 이 두 마커 문자열이 파서(아래)와 5개
// 잡의 프롬프트에 각자 하드코딩돼 있으면, 한쪽만 표기를 바꿔도 나머지가 조용히
// 폴백 모드로 떨어진다(테스트도 안 잡아줌) — macro-overlay-facts.mjs의 "[경고]" 문자열
// 커플링과 같은 클래스. 프롬프트 쪽은 이 상수를 템플릿 리터럴로 참조해서 쓴다.
export const CONTEXT_MARKER = '[맥락]';
export const CONSIDERATIONS_MARKER = '[생각해볼 점]';

// LLM 응답에서 [맥락]·[생각해볼 점] 두 섹션을 분리 — formatFactsMessage의 context·
// considerations 계약을 채우기 위한 출력 파서(2026-08-31 신설). 프롬프트가 정확히 이
// 두 마커로 나눠 응답하도록 요청하는 게 전제(각 잡의 프롬프트에 명시). 마커가 하나도
// 없으면(모델이 형식을 안 지킨 예외) 전체 텍스트를 context로 보존하고 considerations는
// null — 파싱 실패로 내용을 통째로 버리지 않는다(추정 금지 원칙과 동일하게, 손실 없는
// 쪽으로 폴백).
//
// ⚠️ 코드리뷰 지적(2026-08-31, MEDIUM 2건) — 첫 버전은 (1) [맥락] 마커를 문자열
// "맨 앞"에서만 벗겨내(정규식 ^앵커) 모델이 서두 인사말을 붙이면 마커가 그대로
// 텔레그램에 노출됐고, (2) [생각해볼 점] 아래 모든 줄을 각각 별개 항목으로 취급해
// 한 항목이 줄바꿈으로 감싸지면(모델이 긴 문장을 두 줄로 나눠 쓰면) 하나가 두 개
// 불릿으로 쪼개졌다. [맥락]도 indexOf로 위치를 찾고(앵커 아님), considerations는
// 불릿 프리픽스가 있는 줄만 "새 항목"으로 취급하고 프리픽스 없는 줄은 직전 항목에
// 이어붙인다.
const CONSIDERATION_BULLET_RE = /^[·\-*•]\s*/;
// 모델이 "생각해볼 점 없음"을 프롬프트 지시("섹션을 빈 채로 둬라")대로 안 하고 굳이
// "없음"류 채움말을 써서 항목 1개짜리로 응답하는 경우 — 정보 없는 불릿을 그대로
// 노출하면 이 개선 자체의 취지(저정보 메시지 제거)에 반한다.
const NO_OP_CONSIDERATION_RE = /^\(?(해당\s*)?없음\)?$/;

export function parseContextConsiderations(text) {
  const t = String(text ?? '').trim();
  if (!t) return { context: null, considerations: null };
  const considerationsIdx = t.indexOf(CONSIDERATIONS_MARKER);
  const contextIdx = t.indexOf(CONTEXT_MARKER);
  if (considerationsIdx === -1) {
    const context = (contextIdx === -1 ? t : t.slice(contextIdx + CONTEXT_MARKER.length).trim()) || null;
    return { context, considerations: null };
  }
  const contextPart = contextIdx === -1
    ? t.slice(0, considerationsIdx).trim()
    : t.slice(contextIdx + CONTEXT_MARKER.length, considerationsIdx).trim();
  const considerationsPart = t.slice(considerationsIdx + CONSIDERATIONS_MARKER.length).trim();

  const considerations = [];
  for (const raw of considerationsPart.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (CONSIDERATION_BULLET_RE.test(line)) considerations.push(line.replace(CONSIDERATION_BULLET_RE, ''));
    else if (considerations.length) considerations[considerations.length - 1] += ` ${line}`;
    else considerations.push(line);
  }
  const filtered = considerations.filter((c) => !NO_OP_CONSIDERATION_RE.test(c));

  return { context: contextPart || null, considerations: filtered.length ? filtered : null };
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

// 제안모드(허용|금지) 전환 명령 — 2026-08-29 오너 지시(기준 없이 쌓이는 자동 제안을
// 멈출 수 있는 스위치 신설). 킬스위치·체결모드와 동일 원칙(이 목적 전용 복합어, 정확
// 일치만 인정 — "제안 좀 그만해줘" 같은 캐주얼한 언급과 구분하기 위해 일부러 딱딱한
// 고정 문구로 확정).
const PROPOSAL_BLOCK_WORDS = new Set(['제안금지']);
const PROPOSAL_ALLOW_WORDS = new Set(['제안요청']);

export function parseProposalModeCommand(text) {
  const t = String(text ?? '').trim();
  if (PROPOSAL_BLOCK_WORDS.has(t)) return 'blocked';
  if (PROPOSAL_ALLOW_WORDS.has(t)) return 'allowed';
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
