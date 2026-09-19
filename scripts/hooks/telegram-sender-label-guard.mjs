#!/usr/bin/env node
/**
 * PreToolUse 훅 — 텔레그램 상시세션(Zeus)이 reply/edit_message로 오너에게 직접
 * 보내는 메시지에 발신자 라벨(`[Zeus]` 또는 부서 라벨)이 없으면 도구 호출 자체를
 * 막는다(2026-09-19, DevRequest — "대화 주체 없이 메시지가 발송된 게 여러 번
 * 있다, 이거 해결한 거 아니냐"는 오너 재지적).
 *
 * ⚠️ 왜 프로즈 규칙이 아니라 구조적 가드인가 — zeus.md(2026-09-14 재지적으로
 * 규칙 강화, "Zeus가 텔레그램에서 직접 답할 때도 예외 없이 매 메시지 첫 줄에
 * `[제우스]`를 붙인다")가 이미 명문화돼 있었는데도 2026-09-19 세션에서 라벨
 * 없는 reply가 실제로 2건 발송됐다. `telegram-format-compliance.test.js`(2026-
 * 09-14)는 Node 코드(sendTelegram 호출부)의 4단구조만 검증하고, 이 상시세션이
 * reply 도구로 "직접" 보내는 텍스트는 검사 범위 밖이었다 — 그 경로에 처음
 * 만드는 구조적 가드가 이것. CLAUDE.md·feedback-telegram-format-needs-
 * structural-guard 메모리와 동일 원칙: "7차례 재설계됐는데도 재발"한 클래스의
 * 문제는 프롬프트 지시문만으로는 안 지켜진다.
 *
 * 범위: reply·edit_message 둘 다 검사(사용자에게 실제로 전달되는 텍스트 도구).
 * react는 텍스트가 없어(이모지 리액션만) 대상 아님.
 *
 * 예외(둘 다 zeus.md 원문 그대로): ① 부서 직접호출("카이로스, ~")을 중계할 때는
 * 그 부서 자신의 라벨([퀀트전략실 Kairos] 등, 각 에이전트 정의 파일이 스스로
 * 붙임)이 이미 있으니 당연히 통과 ② "안녕" 생존확인처럼 텍스트 자체가 없는
 * 경우는 이 훅의 검사 대상(reply/edit_message에 text가 있는 경우)에 애초에 안
 * 걸림.
 *
 * 계약(Claude Code PreToolUse 훅) — stdin JSON({tool_name, tool_input, ...}),
 * stdout JSON({hookSpecificOutput:{hookEventName:'PreToolUse',
 * permissionDecision:'allow'|'deny', permissionDecisionReason:'...'}}), 항상
 * exit 0(훅 자체 실패로 무관한 도구 호출까지 막으면 안 됨).
 *
 * ⚠️ CLAUDE_TELEGRAM_SESSION 가드 — telegram-reply-guard.mjs와 동일 패턴. 이
 * 프로젝트 cwd의 모든 세션(오너 터미널 세션 포함)에서 PreToolUse마다 실행되므로,
 * 텔레그램 세션 전용 env var로 그 외 세션에서는 즉시 통과시킨다.
 */
import { pathToFileURL } from 'node:url';

// zeus.md·각 에이전트 정의 파일(athena.md 등) "라벨만 유지한다" 절과 정확히
// 동일한 문자열 — 한쪽만 바뀌면 이 목록도 같이 갱신할 것.
//
// ⚠️ "[제우스]"는 레거시로 당분간 병행 허용(2026-09-19, 오너 지시로 "[Zeus]"가
// 정식 라벨로 환원 — DevRequest 2026-09-19-제우스-라벨-영문표기-Zeus.md). 상시
// 텔레그램 세션(com.banana2.telegram-session)이 재시작 전까지는 옛 zeus.md
// 지시문을 컨텍스트에 그대로 들고 있어 "[제우스]"를 계속 낼 수 있다 — 이 가드가
// 그 즉시 거부하면 오너에게 응답 자체가 안 나가는 무응답 사고가 된다(위험을
// DevRequest 자신이 명시).
//
// 제거 시점: `com.banana2.telegram-session-restart`가 **매일 04:00 KST**에
// bootout+bootstrap으로 이 세션을 예방적으로 재시작한다(plist StartCalendarInterval
// Hour=4·Minute=0 확인) — 다음 04:00 이후엔 구 지시문이 메모리에 남아있을 수
// 없으므로, 2026-09-20 04:00 이후 세션에서 아래 LEGACY_ZEUS_LABEL 사용 로그
// (stderr, 코드리뷰 지적 — 조용한 폴백 금지 원칙과 동일)가 더 안 찍히는지 확인한
// 뒤 이 배열에서 "[제우스]"를 빼는 정리 커밋을 진행할 것.
const LEGACY_ZEUS_LABEL = '[제우스]';
export const VALID_SENDER_LABELS = [
  '[Zeus]', LEGACY_ZEUS_LABEL,
  '[투자전략실 Athena]', '[퀀트전략실 Kairos]', '[리스크관리실 Themis]', '[운영실 Hermes]', '[비서실 Apollo]',
];

// 순수함수 — 텍스트 맨 앞(공백 제거 후)이 알려진 라벨로 시작하는지만 본다. 문장
// 중간·끝에 라벨 비슷한 문구가 있어도 인정 안 함(zeus.md 규칙이 "첫 줄"을 명시).
export function hasSenderLabel(text) {
  const t = String(text ?? '').trimStart();
  return VALID_SENDER_LABELS.some((label) => t.startsWith(label));
}

const TEXT_TOOL_NAMES = new Set([
  'mcp__plugin_telegram_telegram__reply',
  'mcp__plugin_telegram_telegram__edit_message',
]);

function allow() {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }));
}

function deny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

async function readStdin(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); done(); });
    process.stdin.on('error', () => { clearTimeout(timer); done(); });
    if (process.stdin.readableEnded) { clearTimeout(timer); done(); }
  });
}

async function main() {
  if (!process.env.CLAUDE_TELEGRAM_SESSION) { allow(); return; }

  try {
    const raw = await readStdin();
    const data = JSON.parse(raw);
    const toolName = data?.tool_name;
    if (!TEXT_TOOL_NAMES.has(toolName)) { allow(); return; }

    // 도구별 텍스트 파라미터명이 다를 가능성을 방어(reply·edit_message 둘 다 text로
    // 확인됐으나, 플러그인이 바뀌어도 조용히 무력화되지 않게 두 후보 다 확인).
    const text = data?.tool_input?.text ?? data?.tool_input?.message;
    if (hasSenderLabel(text)) {
      // 레거시 라벨 사용을 stderr로 남긴다(코드리뷰 지적 — 위 VALID_SENDER_LABELS
      // 주석의 "제거 시점" 판단 근거. stdout은 훅 계약상 JSON만 와야 해서 안전한
      // stderr에만 남김, 108행의 기존 오류로그와 동일 패턴).
      if (String(text ?? '').trimStart().startsWith(LEGACY_ZEUS_LABEL)) {
        console.error(`[telegram-sender-label-guard] 레거시 라벨 "${LEGACY_ZEUS_LABEL}" 사용 감지 — 다음 04:00(com.banana2.telegram-session-restart) 이후에도 계속 찍히면 그 세션이 새 zeus.md를 아직 안 읽은 것`);
      }
      allow();
      return;
    }

    deny(
      `텔레그램으로 나가는 메시지 첫 줄에 발신자 라벨이 없습니다(zeus.md "발신자 라벨" 절). ` +
      `직접 답할 때는 "[Zeus] "로 시작하고, 부서를 중계할 때는 그 부서 자신의 라벨을 그대로 두세요. ` +
      `같은 텍스트 앞에 라벨만 추가해 ${toolName}을 다시 호출하세요.`,
    );
  } catch (e) {
    console.error(`telegram-sender-label-guard 오류(통과 처리): ${e?.message ?? e}`);
    allow();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
