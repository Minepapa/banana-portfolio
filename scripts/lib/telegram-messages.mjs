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

// Zeus가 텔레그램에서 직접(부서를 안 거치고) 말할 때·부서 보고에 판단 코멘트를 얹을
// 때 공통으로 쓰는 마커 — 2026-09-14 오너 재지적("제우스인가 헤르메스인가 여전히 안
// 보인다")으로 "[Zeus]"(영문)와 zeus.md/PANTHEON.md가 새로 규정한 "[제우스]"(국문)
// 두 표기가 같은 화자를 가리키며 공존하던 걸 발견·통일(코드리뷰 지적) — 다른 모든
// 부서 라벨이 국문(운영실 Hermes 등)인 것과도 맞춤.
export const ZEUS_MARKER = '[제우스]';

// 부서 보고와 Zeus 판단 코멘트를 한 메시지에 합친다(2026-08-05 오너 확정 — 텔레그램
// 알림 개수를 늘리지 않기 위함). zeusComment가 없으면(아직 Zeus 판단 전 등) 부서
// 보고만 나간다.
export function formatDepartmentMessage({ departmentLabel, body, zeusComment = null, tag = null }) {
  const header = buildHeader(departmentLabel, tag);
  let msg = `${header}\n${SEPARATOR}\n${body}`;
  if (zeusComment) msg += `\n\n${ZEUS_MARKER} ${zeusComment}`;
  return msg;
}

// 텔레그램 알림 표준 구조(2026-08-17 오너 확정, 2026-08-23 태그·구분선 추가, 2026-08-31
// 3단 구조로 확장, 2026-09-01 오너가 실제 메시지를 손으로 고쳐 4단 구조로 재확정) —
// [부서] → [결론](LLM 한 줄 결론) → [사실](Node가 계산한 사실, 개조식) → [맥락]
// (LLM 근거 서술 — 왜 그 결론·의사결정이 나왔는지) → [의사결정](LLM이 제시하는 실제
// 의사결정 항목, 개조식 — "생각해볼 점"에서 개명, 오너 지시: "생각해볼 점 대신
// 의사결정 항목"). 구분선(SEPARATOR)은 뺐다 — 대괄호 섹션 4개가 이미 시각적 구분을
// 준다(오너가 보여준 예시에 구분선 없음). conclusion·context·decisions 전부 없으면
// (health-watcher처럼 애초에 LLM을 안 부르는 순수 운영 알림, 또는 조용한 날의
// morning-briefing처럼 LLM 호출 자체를 생략한 경우) [사실]만 나간다 —
// formatDepartmentMessage와 달리 body를 자유 문자열로 안 받고 facts 배열을 강제해,
// 호출부가 사실과 해석을 섞어서 쓰지 않도록 구조로 유도한다.
// 마커 상수(2026-08-31 신설, 코드리뷰 지적 — 2026-09-01 4단 구조로 확장하며 갱신) —
// 이 마커 문자열들이 파서(아래)와 각 잡의 프롬프트에 각자 하드코딩돼 있으면, 한쪽만
// 표기를 바꿔도 나머지가 조용히 폴백 모드로 떨어진다(테스트도 안 잡아줌) —
// macro-overlay-facts.mjs의 "[경고]" 문자열 커플링과 같은 클래스. 프롬프트 쪽은 이
// 상수를 템플릿 리터럴로 참조해서 쓴다.
export const CONCLUSION_MARKER = '[결론]';
export const FACTS_MARKER = '[사실]';
export const CONTEXT_MARKER = '[맥락]';
export const DECISIONS_MARKER = '[의사결정]'; // 2026-09-01 CONSIDERATIONS_MARKER('[생각해볼 점]')에서 개명

// 긴 하이픈(em dash, —) 전면 금지(2026-09-01 오너 지시 — "문장에 긴 하이픈이 많은데
// 이건 다 제외하면 돼"). 프롬프트에도 금지 지시를 명시하지만(1차 방어), 모델이 그래도
// 쓰는 경우를 대비해 방어적으로 마침표+공백으로 치환(2차 방어) — 완전 삭제(공백으로만
// 치환)하면 두 절이 접속사 없이 붙어버려 오히려 안 읽히므로, 문장 경계로 취급하는
// 쪽이 더 자연스럽다.
//
// ⚠️ 코드리뷰 지적(2026-09-01, HIGH 2건) — (1) 첫 버전은 `\s{2,}` 압축이 줄바꿈까지
// 삼켜서, 빈 줄로 구분된 여러 [의사결정] 불릿이나 여러 문장으로 나뉜 [맥락]을 한
// 줄로 뭉개버렸다(각 프롬프트가 명시하는 "문장 사이는 줄바꿈으로 분리해라"를 정면
// 위반) — `[^\S\n]`(줄바꿈 제외 공백)로 좁혀 가로 공백만 압축한다. (2) 이 함수를
// 파서(parseDepartmentResponse) 안에서만 부르고 있어서, 그 파서를 안 거치는 다른
// 소비자(예: proposal-flow.mjs가 부서 LLM의 reason을 직접 context에 꽂는 경로)엔
// 긴 하이픈 금지가 전혀 적용되지 않았다 — 실제로 가장 자주 나가는 메시지 클래스(매수·
// 매도 제안)에서 규칙이 조용히 안 지켜지고 있었다. 파싱 시점이 아니라 **렌더링
// 시점**(formatFactsMessage)에서 걸어 모든 소비자에게 일괄 적용한다.
export function stripEmDash(s) {
  return String(s ?? '')
    .replace(/[^\S\n]*—[^\S\n]*/g, '. ')
    .replace(/\.(\s*\.)+/g, '.')
    .replace(/^\s*\.\s*/, '') // 섹션 맨 앞의 하이픈이 남긴 선행 마침표 제거
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim();
}

export function formatFactsMessage({ departmentLabel, facts, conclusion = null, context = null, decisions = null, zeusComment = null, tag = null }) {
  const header = buildHeader(departmentLabel, tag);
  let msg = header;
  if (conclusion) msg += `\n\n${CONCLUSION_MARKER}\n${stripEmDash(conclusion)}`;
  // ⚠️ facts는 stripEmDash 대상이 아니다(2026-09-14 코드리뷰 지적으로 명시) — 긴
  // 하이픈 전면 금지(2026-09-01)는 LLM이 생성하는 conclusion·context·decisions·
  // zeusComment를 겨냥한 규칙이었다. facts는 Node가 직접 조립하는 사실 배열이고,
  // 이 코드베이스 전반에 이미 "· 항목 — 부연설명" 식으로 em dash를 쓰는 하드코딩
  // facts 라인이 다수 존재한다(기존 관행) — 여기서 새삼 stripEmDash를 걸면 그
  // 기존 관행 전체가 조용히 바뀌는 훨씬 큰 변경이 된다. facts에도 금지를 확장할지는
  // 오너 확인 후 별도 결정.
  const factBlock = (facts ?? []).map((f) => `· ${f}`).join('\n');
  msg += `\n\n${FACTS_MARKER}\n${factBlock}`;
  if (context) msg += `\n\n${CONTEXT_MARKER}\n${stripEmDash(context)}`;
  if (decisions?.length) msg += `\n\n${DECISIONS_MARKER}\n${decisions.map((d) => `· ${stripEmDash(d)}`).join('\n')}`;
  if (zeusComment) msg += `\n\n${ZEUS_MARKER} ${stripEmDash(zeusComment)}`;
  return msg;
}

const BULLET_RE = /^[·\-*•]\s*/;
// 모델이 "빈 채로 둬라" 지시를 안 지키고 굳이 "없음"류 채움말을 써서 항목 1개짜리로
// 응답하는 경우 — 정보 없는 불릿을 그대로 노출하면 저정보 메시지 제거 취지에 반한다.
const NO_OP_RE = /^\(?(해당\s*)?없음\)?$/;

// 불릿 목록 파싱 — 불릿 프리픽스가 있는 줄만 "새 항목"으로 취급하고 프리픽스 없는
// 줄(모델이 긴 문장을 줄바꿈으로 감싼 경우)은 직전 항목에 이어붙인다(2026-08-31
// 코드리뷰 지적 재발 방지 — 그렇게 안 하면 한 항목이 여러 불릿으로 쪼개짐).
function parseBulletList(sectionText) {
  const items = [];
  for (const raw of sectionText.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (BULLET_RE.test(line)) items.push(line.replace(BULLET_RE, ''));
    else if (items.length) items[items.length - 1] += ` ${line}`;
    else items.push(line);
  }
  return items.filter((c) => !NO_OP_RE.test(c));
}

// 마커 위치 탐색 — 줄 맨 앞(line-start)에 있는 걸 우선한다(정규식 `^marker`, multiline).
// 모델이 서두에 "요청하신 [결론]/[맥락]/[의사결정] 형식으로 답변드립니다" 같은 프리앰블을
// 붙이면, 그 안의 마커 문자열은 같은 줄 중간(다른 텍스트 뒤)에 있어 `^` 앵커에 안 걸린다
// — 오직 실제로 그 줄을 "그 마커로 시작"한 경우만 잡힌다(2026-09-01 코드리뷰 지적,
// MEDIUM — 프리앰블이 세 마커를 전부 나열해버리면 실제 답변 전체가 decisions로 밀려
// 들어가는 사고가 있었음). 줄 맨 앞에서 하나도 못 찾으면(모델이 마커를 문장 중간에
// 섞어 쓴 완전한 형식 위반) 기존처럼 어디든 있는 위치로 폴백 — 완벽하진 않아도 아예
// 놓치는 것보다 낫다(손실 없는 쪽 우선 원칙).
function findMarkerIndex(t, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineStart = t.match(new RegExp(`^${escaped}`, 'm'));
  if (lineStart) return lineStart.index;
  return t.indexOf(marker);
}

// LLM 응답에서 [결론]·[맥락]·[의사결정] 세 섹션을 분리 — formatFactsMessage의
// conclusion·context·decisions 계약을 채우기 위한 출력 파서(2026-08-31 신설,
// 2026-09-01 2섹션→3섹션으로 확장). 프롬프트가 정확히 이 마커들로 나눠 응답하도록
// 요청하는 게 전제. 각 마커 위치를 findMarkerIndex로 찾아 등장 순서대로 정렬한 뒤
// 구간을 자른다 — 마커 순서가 뒤바뀌거나 일부가 없어도(형식 일부 위반) 있는 것만
// 최대한 살린다. 마커가 하나도 없으면 전체 텍스트를 context에 보존 — 파싱 실패로
// 내용을 통째로 버리지 않는다(추정 금지 원칙과 동일하게, 손실 없는 쪽으로 폴백).
export function parseDepartmentResponse(text) {
  const t = String(text ?? '').trim();
  if (!t) return { conclusion: null, context: null, decisions: null };

  const candidates = [
    { key: 'conclusion', marker: CONCLUSION_MARKER },
    { key: 'context', marker: CONTEXT_MARKER },
    { key: 'decisions', marker: DECISIONS_MARKER },
  ];
  const found = candidates
    .map((c) => ({ ...c, idx: findMarkerIndex(t, c.marker) }))
    .filter((c) => c.idx !== -1)
    .sort((a, b) => a.idx - b.idx);

  if (!found.length) {
    return { conclusion: null, context: stripEmDash(t) || null, decisions: null };
  }

  const result = { conclusion: null, context: null, decisions: null };
  for (let i = 0; i < found.length; i++) {
    const start = found[i].idx + found[i].marker.length;
    const end = i + 1 < found.length ? found[i + 1].idx : t.length;
    const sectionText = stripEmDash(t.slice(start, end).trim());
    if (found[i].key === 'decisions') {
      const items = parseBulletList(sectionText);
      result.decisions = items.length ? items : null;
    } else {
      result[found[i].key] = sectionText || null;
    }
  }
  return result;
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
// 부분일치 대신 정확일치). 2026-09-18 오너 지시로 세 스위치(킬스위치·체결모드·
// 제안모드) 명령어를 전부 "OO 온"/"OO 오프" 공통 패턴으로 통일 — "긴급정지"/
// "정지해제"·"실전전환"/"섀도우전환"·"제안금지"/"제안요청"처럼 스위치마다 어휘가
// 제각각이라 외우기 어렵다는 지적(2026-08-12에 "정지"/"해제" 단일단어에서
// "긴급정지"/"정지해제" 복합어로 한 번 바꿨던 것의 연장 — 그때도 기억하기 쉬운
// 방향으로 못 갔었음). STOP/stop 영문 별칭은 이번에 제거(오너가 명시한 최종형이
// "킬스위치 온"/"킬스위치 오프" 둘뿐이라, 요청에 없는 별칭을 임의로 유지하지 않음).
const ACTIVATE_WORDS = new Set(['킬스위치 온']);
const DEACTIVATE_WORDS = new Set(['킬스위치 오프']);

export function parseKillSwitchCommand(text) {
  const t = String(text ?? '').trim();
  if (ACTIVATE_WORDS.has(t)) return 'activate';
  if (DEACTIVATE_WORDS.has(t)) return 'deactivate';
  return null;
}

// 체결모드(섀도우|실전) 전환 명령 — 2026-09-18 "OO 온"/"OO 오프" 공통 패턴으로 개명
// (구 "실전전환"/"섀도우전환", 위 킬스위치 주석 참고). 정확일치만 인정(캐주얼한
// 언급과 구분).
const LIVE_WORDS = new Set(['실전모드 온']);
const SHADOW_WORDS = new Set(['실전모드 오프']);

export function parseExecutionModeCommand(text) {
  const t = String(text ?? '').trim();
  if (LIVE_WORDS.has(t)) return 'live';
  if (SHADOW_WORDS.has(t)) return 'shadow';
  return null;
}

// 제안모드(허용|금지) 전환 명령 — 2026-09-18 "OO 온"/"OO 오프" 공통 패턴으로 개명
// (구 "제안금지"/"제안요청", 위 킬스위치 주석 참고). "온"=제안 생성 허용(평소
// 기본값), "오프"=제안 생성 금지. 정확일치만 인정.
const PROPOSAL_BLOCK_WORDS = new Set(['제안모드 오프']);
const PROPOSAL_ALLOW_WORDS = new Set(['제안모드 온']);

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
