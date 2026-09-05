#!/usr/bin/env node
/**
 * PreToolUse 훅(reply 도구 전용) — "안녕" 생존확인 2단계(😘, 답변 준비 완료) 리액션을
 * 모델 의존 없이 확정적으로 발생시킨다(2026-09-05, 오너 지적 "1단계처럼 훅으로
 * 확정적으로 만들면 되지 않나" 반영).
 *
 * ⚠️ 왜 필요한가 — 1단계(😎, 메시지 수신 즉시)는 텔레그램 플러그인 서버 코드 자체에
 * 패치해 이미 확정적으로 해결됐다(Log/Implementation/2026-09-01-텔레그램세션-
 * 안녕키워드-플러그인레벨확정적리액션.md). 반면 2단계(😘, 답변 준비 완료)는
 * `.claude/agents/zeus.md`의 프롬프트 지시문에만 의존했는데, 실사용에서 모델이 "안녕"
 * 같은 트리비얼한 메시지에서 지시받은 도구 호출 자체를 생략하는 습성이 반복
 * 재현됐다(2026-09-01 3/3 실패 실측, 같은 근본원인이 2026-09-04
 * [[Log/Implementation/2026-09-04-텔레그램세션-채널응답강제-Stop훅]]에서도 재확인됨) —
 * 그래서 그 문서에도 "2단계는 여전히 모델 의존이라 미해결"로 명시적으로 남아있었다.
 *
 * 이 훅은 reply 도구가 실제로 호출되기 **직전**(PreToolUse)에 개입해, 모델이 react를
 * 따로 호출하는 걸 기다리지 않고 훅 자신이 텔레그램 Bot API(`setMessageReaction`)를
 * 직접 호출해 리액션을 바꾼다 — 1단계와 동일한 "모델 판단에 의존하지 않는 확정적
 * 개입" 원칙을 2단계에도 적용한 것.
 *
 * ⚠️ 완전 우회가 아니다 — 이 훅은 reply 도구 호출이 **실제로 일어나야만** 발동한다
 * (PreToolUse는 그 도구가 정말 호출될 때만 훅 자체가 실행되는 이벤트). 세션이
 * 멈춰서 reply를 영영 안 부르면(=Stop 훅의 재시도도 소진되면) 이 훅도 발동 기회가
 * 없어 😘로 안 바뀐다 — telegram-reply-guard.mjs의 Stop 훅이 지킨 것과 동일한
 * "진짜 생존신호" 원칙(가짜 확정 응답이 아니라 실제 모델 동작에 연동됨).
 *
 * ⚠️ 1단계 패치(플러그인 캐시 파일 직접 수정)와 달리 이 파일은 프로젝트 저장소
 * 안(git 추적)이라 텔레그램 플러그인 업데이트에 영향받지 않는다 — 1단계 패치가 겪는
 * "플러그인 업데이트 시 소실" 문제가 이쪽엔 없음.
 *
 * ⚠️ 신호 의미가 미묘하게 좁혀졌다(2026-09-05 코드리뷰 지적, 설계 트레이드오프로
 * 수용) — zeus.md 원안의 2단계는 "reply 호출 이전, 처리 중"이라는 폭넓은 상태를
 * 의미했지만, 이 훅은 정확히 reply 도구 호출 **직전**에만 발동한다. "안녕"처럼
 * 처리가 즉시 끝나는 메시지에서는 😘와 실제 답장이 사실상 동시에 도착해 "받았지만
 * 아직 처리 중"이라는 중간 관측 구간이 짧아진다 — 다만 이건 정확히 훅이 절대
 * 우회하면 안 되는 지점(reply가 실제로 호출돼야만 발동)과 정면으로 상충하는
 * 요구라, 현재로선 최선의 절충으로 판단.
 *
 * 범위: 채널 메시지 전체 텍스트가 정확히 "안녕"일 때만(zeus.md 생존확인 프로토콜과
 * 동일 스코프, telegram-reply-guard.mjs의 Stop 훅처럼 전체 메시지로 일반화하지
 * 않음 — 2단계 리액션 자체가 애초에 "안녕" 전용 프로토콜이었으므로).
 *
 * 계약(Claude Code PreToolUse 훅) — stdin JSON({tool_name, tool_input,
 * transcript_path, session_id, ...}). 이 훅은 절대 reply 자체를 막거나 지연시키면
 * 안 되므로 hookSpecificOutput 없이 항상 그대로 통과(사이드이펙트만 수행) — 실패해도
 * (토큰 없음·네트워크 오류·transcript 파싱 실패 등) 조용히 넘어간다(훅 자체 실패로
 * 세션을 막지 않는다는 telegram-reply-guard.mjs와 동일 최상위 원칙).
 *
 * ⚠️ CLAUDE_TELEGRAM_SESSION 가드 — telegram-reply-guard.mjs와 동일 패턴, 오너
 * 인터랙티브 세션에서는 즉시 통과.
 *
 * ⚠️ 2026-09-05 코드리뷰(REQUEST CHANGES) 반영 — 최초 구현은 (a) fetch에 타임아웃이
 * 없어 응답이 안 오면 reply가 최악의 경우 훅 타임아웃(10초)만큼 지연될 수 있었고
 * (오너 요구 "reply를 막거나 지연시키면 안 된다"를 실측으로 위배), (b) API 호출이
 * 실패해도(네트워크 오류·401·400 등) 무조건 "보냄"으로 가드파일을 기록해 재시도가
 * 막혔으며, (c) 모든 실패 경로가 완전히 무음이라 훅이 죽어도 "모델이 깜빡한 것"과
 * 구분할 수 없었다. AbortSignal.timeout + res.ok 확인 + 실패 시 console.error 한
 * 줄로 세 가지를 모두 고쳤다(아래 참고).
 *
 * ⚠️ 리뷰 검증 중 실제 사고 발생 — 리뷰어가 가짜 transcript로 훅을 실행하며 HOME을
 * 오버라이드하려 했으나 zsh에서 env 인자가 의도대로 안 먹어, 실제 오너 텔레그램
 * 채팅으로 진짜 setMessageReaction 호출이 한 번 나갔다(오너에게 별도 보고·확인
 * 요청함). 앞으로 이 훅을 라이브로 검증할 때는 반드시 존재하지 않는 transcript_path
 * 또는 빈 TELEGRAM_BOT_TOKEN으로 실제 API 호출 자체가 안 나가는 조건에서 할 것.
 *
 * ⚠️ 실사용 1차 검증 실패 → Happy Eyeballs 버그 재발 확인(2026-09-05) — 배포 직후
 * 실제 "안녕" 2회 테스트에서 😘가 안 붙어 transcript의 훅 attachment stderr를 직접
 * 확인한 결과 매번 `TypeError: fetch failed`. 이건 `scripts/lib/telegram.mjs`
 * 헤더 주석(2026-08-18, task #34)이 이미 이 머신에서 확정 진단해둔 것과 정확히
 * 같은 버그 — Node 20+ 기본 활성화된 Happy Eyeballs(RFC 8305, IPv6/IPv4 동시접속
 * 경쟁)가 "IPv6는 즉각 거부되지만 IPv4는 느리게 응답하는" 이 머신의 네트워크
 * 조건에서 api.telegram.org 연결 시 오작동해 ETIMEDOUT으로 멈춘다. 그 문서가
 * 발견한 고정(`setDefaultAutoSelectFamily(false)`)을 이 훅도 적용해야 하는데,
 * 처음 구현할 때 그 선례를 확인 안 하고 새 파일을 만들어 놓쳤다 — telegram.mjs를
 * 쓰는 다른 잡(sendTelegram 등)들은 멀쩡히 동작하니 "다른 잡은 되는데 이 훅만
 * 안 된다"가 재발하면 이 주석부터 볼 것.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { setDefaultAutoSelectFamily } from 'node:net';
import { readTranscriptTailLines, getMessageText, readStdin, cleanupStaleGuardFiles } from './telegram-reply-guard.mjs';

setDefaultAutoSelectFamily(false);

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD_DIR = join(HERE, '..', '.cache', 'telegram-progress-reaction');
const DEFAULT_ENV_PATH = join(homedir(), '.claude', 'channels', 'telegram', '.env');
const GREETING_TEXT = '안녕';
const PROGRESS_EMOJI = '😘';
const FETCH_TIMEOUT_MS = 2500;

// 채널 메시지 태그 안의 실제 텍스트(태그 속성이 아니라 본문)까지 캡처 — 2단계
// 발동 대상을 "안녕"으로 한정하려면 telegram-reply-guard.mjs의 CHANNEL_TAG_RE(속성만
// 캡처)로는 부족해서 별도 정규식을 쓴다. ⚠️ chat_id → message_id 속성 순서에 의존
// (2026-09-05 코드리뷰 LOW 지적) — 현재 플러그인 출력·형제 정규식과 동일 가정이라
// 지금은 안전하지만, 플러그인이 속성 순서를 바꾸면 이 정규식이 조용히 매치 실패한다.
const CHANNEL_MSG_RE = /<channel\s+source="plugin:telegram:telegram"[^>]*\bchat_id="([^"]*)"[^>]*\bmessage_id="([^"]*)"[^>]*>\n?([\s\S]*?)\n?<\/channel>/;

// 순수함수(테스트 가능) — 가장 최근 텔레그램 채널 메시지가 정확히 "안녕"이면
// {chatId, messageId}, 아니면(다른 문구·채널 메시지 없음) null. telegram-reply-
// guard.mjs의 analyzeTranscriptTail과 마찬가지로 사이드체인(위임된 서브에이전트가
// 채널 태그 원문을 인용하는 경우) 라인은 오탐 방지를 위해 제외한다.
export function findLastGreetingChannelMessage(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const d = lines[i];
    if (d?.isSidechain === true) continue;
    if (d?.type !== 'user') continue;
    const text = getMessageText(d.message);
    const m = CHANNEL_MSG_RE.exec(text);
    if (!m) continue;
    return m[3].trim() === GREETING_TEXT ? { chatId: m[1], messageId: m[2] } : null;
  }
  return null;
}

// chatId도 키에 포함(telegram-reply-guard.mjs와 동일 이유 — 채팅이 여러 개로
// 늘어나도 message_id 충돌로 다른 채팅의 가드를 잘못 공유하지 않게 미리 방지).
export function guardFilePath(guardDir, chatId, messageId) {
  const safe = (s) => String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(guardDir, `${safe(chatId)}-${safe(messageId)}.sent`);
}

export function hasAlreadySentReaction(guardDir, chatId, messageId) {
  return existsSync(guardFilePath(guardDir, chatId, messageId));
}

// 쓰기 실패는 조용히 무시(베스트에포트 — 이 가드가 못 남아도 최악의 경우 같은
// 메시지에 😘 API를 한 번 더 호출하는 정도라 텔레그램 쪽에서도 멱등하게 처리됨,
// telegram-reply-guard.mjs의 재시도 카운터와 달리 무한루프 위험이 없어 fail-open
// 수준을 더 단순하게 가져감).
export function markReactionSent(guardDir, chatId, messageId) {
  try {
    mkdirSync(guardDir, { recursive: true });
    writeFileSync(guardFilePath(guardDir, chatId, messageId), String(Date.now()));
  } catch { /* 무시 — 하우스키핑 실패가 훅 동작을 막으면 안 됨 */ }
}

// 플러그인 README가 문서화한 것과 동일 우선순위(셸 환경변수가 .env보다 우선) —
// server.ts의 TOKEN 로딩과 같은 소스를 그대로 재사용(새 토큰 저장소를 만들지 않음).
// 따옴표·`export ` 접두사 방어(2026-09-05 코드리뷰 LOW 지적) — `.env` 파일을 손으로
// 고치다 보면 `TELEGRAM_BOT_TOKEN="123:abc"`나 `export TELEGRAM_BOT_TOKEN=...` 형태가
// 섞여 들어올 수 있다.
export function readBotToken(envPath = DEFAULT_ENV_PATH) {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    const raw = readFileSync(envPath, 'utf8');
    const m = /^(?:export\s+)?TELEGRAM_BOT_TOKEN=(.+)$/m.exec(raw);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

async function main() {
  if (!process.env.CLAUDE_TELEGRAM_SESSION) return;
  try {
    cleanupStaleGuardFiles(GUARD_DIR);

    const raw = await readStdin(3000);
    const data = JSON.parse(raw);
    const transcriptPath = data.transcript_path || data.transcriptPath || '';
    if (!transcriptPath || !existsSync(transcriptPath)) return;

    const lines = readTranscriptTailLines(transcriptPath);
    const target = findLastGreetingChannelMessage(lines);
    if (!target) return;

    // reply 도구가 실제로 향하는 chat_id와 대조(2026-09-05 코드리뷰 MEDIUM 지적) —
    // transcript의 "가장 최근 채널 메시지"와 지금 막 호출되려는 reply가 서로 다른
    // 채팅을 향하는 경우(오너가 여러 채팅을 쓰게 되는 미래 대비) 엉뚱한 채팅에
    // 리액션이 붙는 걸 막는다. tool_input에 값이 없으면(구버전 플러그인 등) 굳이
    // 막을 근거가 없으니 통과.
    const toolInput = data.tool_input || data.toolInput || {};
    const replyChatId = String(toolInput.chat_id ?? '');
    if (replyChatId && replyChatId !== String(target.chatId)) return;

    if (hasAlreadySentReaction(GUARD_DIR, target.chatId, target.messageId)) return;

    // message_id는 텔레그램에서 항상 정수지만, transcript 파싱이 어긋나 비정상
    // 값이 나오면 NaN → JSON에서 null로 직렬화돼 API가 400을 내는데도 조용히
    // 넘어갈 수 있었다(2026-09-05 코드리뷰 LOW 지적) — 여기서 미리 걸러낸다.
    const messageIdNum = Number(target.messageId);
    if (!Number.isFinite(messageIdNum)) return;

    const token = readBotToken();
    if (!token) return;

    const res = await fetch(`https://api.telegram.org/bot${token}/setMessageReaction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 타임아웃 필수(2026-09-05 코드리뷰 HIGH 지적, 실측 재현됨) — undici 기본
      // 응답 타임아웃(300초)에 맡기면 응답이 안 오는 상황(방화벽 블랙홀 등)에서
      // 이 훅이 걸린 reply 호출이 훅 타임아웃(10초)만큼 지연될 수 있다. 하필
      // "세션 생존확인" 시나리오에서 그 지연을 만드는 건 이 훅이 없애려는 증상과
      // 같아진다 — 2.5초는 훅 타임아웃(10초)·readStdin(3초)을 합쳐도 여유가 남는 값.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify({
        chat_id: target.chatId,
        message_id: messageIdNum,
        reaction: [{ type: 'emoji', emoji: PROGRESS_EMOJI }],
      }),
    }).catch((e) => {
      console.error(`telegram-progress-reaction: setMessageReaction 요청 실패(네트워크/타임아웃) — ${e?.name ?? e}`);
      return null;
    });

    // 성공했을 때만 가드파일 기록(2026-09-05 코드리뷰 MEDIUM 지적) — 실패까지
    // "보냄"으로 기록하면 다음 reply 호출에서도 재시도가 안 돼 영영 😘가 안 붙는다.
    // 상태 코드만 로그(토큰이 URL에 실려 있으므로 에러 객체 전문·URL은 절대 안 찍음).
    if (res?.ok) {
      markReactionSent(GUARD_DIR, target.chatId, target.messageId);
      console.error(`telegram-progress-reaction: 😘 리액션 전송 성공(chat_id=${target.chatId}, message_id=${target.messageId})`);
    } else {
      console.error(`telegram-progress-reaction: 리액션 전송 실패(status=${res?.status ?? 'network'}) — 다음 reply에서 재시도`);
    }
  } catch (e) {
    console.error(`telegram-progress-reaction 오류(무시하고 통과): ${e?.message ?? e}`);
  }
}

// entrypoint 가드 — telegram-reply-guard.mjs와 동일 이유(테스트가 순수함수만
// import해도 main()이 stdin 대기로 side effect를 일으키면 안 됨). pathToFileURL
// 사용 이유는 telegram-reply-guard.mjs의 동일 가드 주석 참고.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
