#!/usr/bin/env node
/**
 * Stop 훅 — "안녕" 생존확인 2단계(😘, 처리 완료) 리액션을 모델 의존 없이
 * 확정적으로 발생시킨다(2026-09-05, 오너 지적 "1단계처럼 훅으로 확정적으로
 * 만들면 되지 않나" 반영, 같은 날 후속 지시로 PreToolUse→Stop 전환).
 *
 * ⚠️ 왜 필요한가 — 1단계(😎, 메시지 수신 즉시)는 텔레그램 플러그인 서버 코드 자체에
 * 패치해 이미 확정적으로 해결됐다(Log/Implementation/2026-09-01-텔레그램세션-
 * 안녕키워드-플러그인레벨확정적리액션.md). 반면 2단계(😘)는 `.claude/agents/
 * zeus.md`의 프롬프트 지시문에만 의존했는데, 실사용에서 모델이 "안녕" 같은
 * 트리비얼한 메시지에서 지시받은 도구 호출 자체를 생략하는 습성이 반복
 * 재현됐다(2026-09-01 3/3 실패 실측).
 *
 * ⚠️ 설계 전환 — PreToolUse(reply 직전)에서 Stop으로(2026-09-05, 오너 결정) —
 * 최초 구현은 `reply` 도구 호출 직전(PreToolUse)에 개입했으나, 오너가 실사용
 * 확인 후 "이모티콘 변화가 확실히 되면 답장은 안 해도 될 것 같다 — 세션이
 * 살아있는지 보는 용도"라고 판단해 "안녕"에 대한 텍스트 답장 자체를 더 이상
 * 요구하지 않기로 했다(zeus.md 갱신). 그러면 reply 호출을 트리거로 삼는 설계는
 * 모델이 reply를 아예 안 부르는 순간 2단계가 영영 발동하지 않는 문제가 생긴다
 * — 그래서 트리거를 "reply 호출 직전"에서 "모델의 턴이 끝나는 시점"(Stop
 * 이벤트)으로 옮겼다. telegram-reply-guard.mjs와 같은 Stop 훅이라 등록도
 * 자연스럽게 그 파일과 나란히(.claude/settings.json의 "Stop" 배열에 커맨드
 * 하나 더 추가하는 형태)로 들어간다.
 *
 * ⚠️ 완전 우회가 아니다 — 이 훅은 Stop 이벤트 자체가 실제로 발생해야만
 * 발동한다(모델의 턴이 실제로 끝나야 훅이 실행되는 이벤트). 세션이 진짜
 * 멈춰서 턴 자체가 끝나지 않으면 이 훅도 발동 기회가 없어 😘로 안 바뀐다 —
 * telegram-reply-guard.mjs의 Stop 훅이 지킨 것과 동일한 "진짜 생존신호"
 * 원칙(가짜 확정 응답이 아니라 실제 세션 동작에 연동됨). 이 버전은 이전
 * PreToolUse 버전보다 오히려 이 원칙에 더 가깝다 — reply라는 모델의 자의적
 * 선택(하느냐 마느냐)에 더 이상 의존하지 않고, "턴이 끝났다"는 더 근본적인
 * 사실 하나에만 의존한다.
 *
 * ⚠️ 1단계 패치(플러그인 캐시 파일 직접 수정)와 달리 이 파일은 프로젝트 저장소
 * 안(git 추적)이라 텔레그램 플러그인 업데이트에 영향받지 않는다 — 1단계 패치가 겪는
 * "플러그인 업데이트 시 소실" 문제가 이쪽엔 없음.
 *
 * 범위: 채널 메시지 전체 텍스트가 정확히 "안녕"일 때만(zeus.md 생존확인 프로토콜과
 * 동일 스코프) — telegram-reply-guard.mjs도 "안녕"이면 이제 텍스트 답장을
 * 강제하지 않는다(그쪽 파일의 analyzeTranscriptTail 갱신 참고, 이 훅이 확정적
 * 대체 신호를 보장하므로).
 *
 * 계약(Claude Code Stop 훅) — stdin JSON({session_id, transcript_path, cwd, ...}),
 * stdout JSON({continue:true, suppressOutput:true})을 항상 반환(이 훅은 Stop을
 * 절대 막지 않는다 — 순수 사이드이펙트 훅). 실패해도(토큰 없음·네트워크 오류·
 * transcript 파싱 실패 등) 조용히 넘어간다(훅 자체 실패로 세션을 막지 않는다는
 * telegram-reply-guard.mjs와 동일 최상위 원칙).
 *
 * ⚠️ CLAUDE_TELEGRAM_SESSION 가드 — telegram-reply-guard.mjs와 동일 패턴, 오너
 * 인터랙티브 세션에서는 즉시 통과.
 *
 * ⚠️ 2026-09-05 코드리뷰(REQUEST CHANGES, PreToolUse 버전 기준) 반영 — (a) fetch에
 * 타임아웃이 없어 응답이 안 오면 훅 실행이 지연될 수 있었던 문제, (b) API 호출이
 * 실패해도 무조건 "보냄"으로 가드파일을 기록해 재시도가 막히던 문제, (c) 모든
 * 실패 경로가 완전히 무음이라 훅이 죽어도 알 방법이 없던 문제 — 이 세 가지는
 * Stop 전환 후에도 그대로 유효한 지적이라 유지(AbortSignal.timeout + res.ok
 * 확인 + 실패 시 console.error). tool_input.chat_id 대조는 Stop 훅엔 tool_input
 * 자체가 없어 제거.
 *
 * ⚠️ 리뷰 검증 중 실제 사고 발생 — 리뷰어가 가짜 transcript로 훅을 실행하며 HOME을
 * 오버라이드하려 했으나 zsh에서 env 인자가 의도대로 안 먹어, 실제 오너 텔레그램
 * 채팅으로 진짜 setMessageReaction 호출이 한 번 나갔다. 앞으로 이 훅을 라이브로
 * 검증할 때는 반드시 존재하지 않는 transcript_path 또는 빈 TELEGRAM_BOT_TOKEN으로
 * 실제 API 호출 자체가 안 나가는 조건에서 할 것.
 *
 * ⚠️ 실사용 1차 검증 실패 → Happy Eyeballs 버그 재발 확인(2026-09-05) — PreToolUse
 * 버전 배포 직후 실제 "안녕" 2회 테스트에서 😘가 안 붙어 transcript의 훅
 * attachment stderr를 직접 확인한 결과 매번 `TypeError: fetch failed`. 이건
 * `scripts/lib/telegram.mjs` 헤더 주석(2026-08-18, task #34)이 이미 이
 * 머신에서 확정 진단해둔 것과 정확히 같은 버그 — Node 20+ 기본 활성화된 Happy
 * Eyeballs(RFC 8305, IPv6/IPv4 동시접속 경쟁)가 "IPv6는 즉각 거부되지만 IPv4는
 * 느리게 응답하는" 이 머신의 네트워크 조건에서 api.telegram.org 연결 시
 * 오작동해 ETIMEDOUT으로 멈춘다. 그 문서가 발견한 고정
 * (`setDefaultAutoSelectFamily(false)`)을 이 훅도 적용해야 하는데, 처음 구현할
 * 때 그 선례를 확인 안 하고 새 파일을 만들어 놓쳤다 — telegram.mjs를 쓰는
 * 다른 잡(sendTelegram 등)들은 멀쩡히 동작하니 "다른 잡은 되는데 이 훅만 안
 * 된다"가 재발하면 이 주석부터 볼 것.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { setDefaultAutoSelectFamily } from 'node:net';
import { readTranscriptTailLines, readStdin, cleanupStaleGuardFiles, findLastGreetingChannelMessage } from './telegram-reply-guard.mjs';

setDefaultAutoSelectFamily(false);

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD_DIR = join(HERE, '..', '.cache', 'telegram-progress-reaction');
const DEFAULT_ENV_PATH = join(homedir(), '.claude', 'channels', 'telegram', '.env');
const PROGRESS_EMOJI = '😘';
const FETCH_TIMEOUT_MS = 2500;

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

// Stop 훅은 절대 Stop 자체를 막으면 안 되므로 항상 이 출력으로 끝난다(telegram-
// reply-guard.mjs의 pass()와 동일 계약).
function pass() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function main() {
  if (!process.env.CLAUDE_TELEGRAM_SESSION) { pass(); return; }
  try {
    cleanupStaleGuardFiles(GUARD_DIR);

    const raw = await readStdin(3000);
    const data = JSON.parse(raw);
    const transcriptPath = data.transcript_path || data.transcriptPath || '';
    if (!transcriptPath || !existsSync(transcriptPath)) { pass(); return; }

    const lines = readTranscriptTailLines(transcriptPath);
    const target = findLastGreetingChannelMessage(lines);
    if (!target) { pass(); return; }

    if (hasAlreadySentReaction(GUARD_DIR, target.chatId, target.messageId)) { pass(); return; }

    // message_id는 텔레그램에서 항상 정수지만, transcript 파싱이 어긋나 비정상
    // 값이 나오면 NaN → JSON에서 null로 직렬화돼 API가 400을 내는데도 조용히
    // 넘어갈 수 있었다(2026-09-05 코드리뷰 LOW 지적) — 여기서 미리 걸러낸다.
    const messageIdNum = Number(target.messageId);
    if (!Number.isFinite(messageIdNum)) { pass(); return; }

    const token = readBotToken();
    if (!token) { pass(); return; }

    const res = await fetch(`https://api.telegram.org/bot${token}/setMessageReaction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 타임아웃 필수(2026-09-05 코드리뷰 HIGH 지적, 실측 재현됨) — undici 기본
      // 응답 타임아웃(300초)에 맡기면 응답이 안 오는 상황(방화벽 블랙홀 등)에서
      // 이 훅의 Stop 처리가 그만큼 지연될 수 있다. 2.5초는 훅 타임아웃(10초)·
      // readStdin(3초)을 합쳐도 여유가 남는 값.
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
    // "보냄"으로 기록하면 다음 Stop에서도 재시도가 안 돼 영영 😘가 안 붙는다.
    // 상태 코드만 로그(토큰이 URL에 실려 있으므로 에러 객체 전문·URL은 절대 안 찍음).
    if (res?.ok) {
      markReactionSent(GUARD_DIR, target.chatId, target.messageId);
      console.error(`telegram-progress-reaction: 😘 리액션 전송 성공(chat_id=${target.chatId}, message_id=${target.messageId})`);
    } else {
      console.error(`telegram-progress-reaction: 리액션 전송 실패(status=${res?.status ?? 'network'}) — 다음 Stop에서 재시도`);
    }
    pass();
  } catch (e) {
    console.error(`telegram-progress-reaction 오류(무시하고 통과): ${e?.message ?? e}`);
    pass();
  }
}

// entrypoint 가드 — telegram-reply-guard.mjs와 동일 이유(테스트가 순수함수만
// import해도 main()이 stdin 대기로 side effect를 일으키면 안 됨). pathToFileURL
// 사용 이유는 telegram-reply-guard.mjs의 동일 가드 주석 참고.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
