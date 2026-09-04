#!/usr/bin/env node
/**
 * Stop 훅 — 텔레그램 상시세션이 채널 메시지에 답장 없이 턴을 끝내려 하면 강제로
 * 한 번 더 돌려서 실제로 reply/react를 호출하게 만든다(2026-09-04, 오너 신고
 * "안녕 이모지 변화도 답장도 없다" 조사 결과).
 *
 * ⚠️ 왜 필요한가 — 텔레그램 플러그인은 "이 세션의 텍스트 출력은 오너 화면에 절대
 * 안 뜨고, reply/react 등 도구 호출을 거쳐야만 전달된다"고 명시하는데, 모델이
 * 트리비얼한 메시지("안녕" 등)에서 이 도구 호출 자체를 생략하고 일반 대화하듯
 * 텍스트만 생성한 채 끝내는 습성이 실사고로 재현됐다(2026-09-01 최초 발견,
 * `.claude/agents/zeus.md` 프롬프트 지시문만으로 3/3 실패해 플러그인 서버 패치로
 * 1단계(😎)만 부분 해결 — `Log/Implementation/2026-09-01-텔레그램세션-안녕키워드-
 * 플러그인레벨확정적리액션.md` 참고. 2단계·실제 답장은 그때도 "모델 의존이라 미해결"
 * 로 명시적으로 남겨뒀었고, 2026-09-04에 같은 증상이 실제로 재현됨을 세션 transcript
 * 직접 확인으로 재확인).
 *
 * ⚠️ 완전 우회(플러그인이 모델과 무관하게 기계적으로 답장까지 대신 보내는 방식)는
 * 일부러 안 쓴다 — 오너 지적(2026-09-04): "그럼 세션이 죽어있어도 그냥 정해진
 * 출력을 뱉는 것과 다른가?" 그 방식은 세션이 진짜 멈춰있어도 항상 응답이 오는
 * 가짜 생존신호가 된다. 이 훅은 Stop **이벤트 자체가 실제로 발생해야만** 개입할 수
 * 있으므로(세션이 진짜 멈춰있으면 이 훅도 발동 기회가 없다), "모델이 깜빡한 걸
 * 강제로 재시도시키는" 방식으로 진짜 생존신호 의미를 지킨다.
 *
 * 범위: "안녕"에 국한하지 않고 텔레그램 채널로 들어온 모든 메시지에 일반화 —
 * 근본 원인(채널 메시지에 텍스트만 내고 도구를 안 부르는 습성)이 인사말에만
 * 한정된 문제가 아니기 때문(오너 확인, 2026-09-04).
 *
 * 계약(Claude Code Stop 훅) — stdin JSON({session_id, transcript_path, cwd, ...}),
 * stdout JSON({continue:false, decision:'block', reason:'...'} 또는
 * {continue:true, suppressOutput:true}). 항상 exit 0(훅 자체 실패로 세션을 막으면
 * 안 됨 — OMC의 context-guard-stop.mjs와 동일 안전원칙).
 *
 * ⚠️ CLAUDE_TELEGRAM_SESSION 가드 — `.claude/settings.json`에 등록되면 이 프로젝트
 * cwd의 모든 세션(오너 터미널 세션 포함)에서 Stop마다 실행된다. 텔레그램 세션
 * 전용 env var로 그 외 세션에서는 즉시 통과(telegram-session-context.mjs와 동일
 * 패턴).
 *
 * 무한루프 방지: (session_id, message_id) 쌍별로 재시도 횟수를 scripts/.cache/에
 * 기록, MAX_RETRIES 도달하면 포기하고 통과시킨다(OMC context-guard-stop.mjs의
 * retry guard와 동일 원칙). 가드파일은 24시간 지나면 베스트에포트로 정리(무한 누적
 * 방지).
 *
 * ⚠️ context-limit·사용자중단 Stop은 절대 막지 않는다(shouldSkipBlocking) — 이
 * 환경에 실제로 설치돼 있는 다른 Stop 훅(OMC context-guard-stop.mjs)이 쓰는 것과
 * 동일한 방어. 안 막으면 컴팩션 자체가 영영 못 일어나는 데드락 위험, 사용자 중단을
 * 억지로 이어가는 것도 잘못된 개입.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, fstatSync, readSync, closeSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD_DIR = join(HERE, '..', '.cache', 'telegram-reply-guard');
const MAX_RETRIES = 2;
const TAIL_BYTES = 1_000_000;
const GUARD_FILE_TTL_MS = 24 * 3600_000;

// context-limit·사용자 중단으로 인한 Stop까지 강제 재시도로 막으면 안 된다 —
// OMC의 context-guard-stop.mjs(이 환경에 실제로 설치돼 살아있는 다른 Stop 훅)가
// 쓰는 것과 동일한 방어 패턴을 그대로 가져옴: context-limit stop을 막으면 컴팩션
// 자체가 영영 못 일어나는 데드락이 될 수 있고, 사용자가 명시적으로 중단한 걸
// 억지로 이어가는 것도 잘못된 개입이다. 정확한 필드명은 이 런타임에서 미확정이라
// (공식 문서 미확인) 여러 후보 필드·부분일치 패턴을 넓게 잡아 방어적으로 스킵한다.
const SKIP_BLOCK_PATTERNS = [
  'context_limit', 'context_window', 'context_exceeded', 'context_full',
  'max_context', 'token_limit', 'max_tokens', 'conversation_too_long', 'input_too_long',
  'aborted', 'abort', 'cancel', 'interrupt', 'user_cancel', 'user_interrupt', 'ctrl_c', 'manual_stop',
];

export function shouldSkipBlocking(data) {
  if (data?.user_requested || data?.userRequested) return true;
  const reasons = [data?.stop_reason, data?.stopReason, data?.end_turn_reason, data?.endTurnReason, data?.reason]
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.toLowerCase().replace(/[\s-]+/g, '_'));
  return reasons.some((r) => SKIP_BLOCK_PATTERNS.some((p) => r.includes(p)));
}

// 텔레그램으로 실제 응답이 "전달됐다"고 볼 수 있는 도구 — 채널 응답 도구 3종
// (com.banana2.telegram-session.plist의 --allowedTools 목록과 동일) + Agent(부서
// 위임 후 완료를 기다리는 정당한 패턴, efe58b33 세션 실측 — 위임 직후엔 아직 답장
// 전이라도 강제로 재촉하면 안 됨).
const DELIVERY_TOOL_NAMES = new Set([
  'mcp__plugin_telegram_telegram__reply',
  'mcp__plugin_telegram_telegram__react',
  'mcp__plugin_telegram_telegram__edit_message',
  'Agent',
]);

const CHANNEL_TAG_RE = /<channel\s+source="plugin:telegram:telegram"[^>]*\bchat_id="([^"]*)"[^>]*\bmessage_id="([^"]*)"/;

function getMessageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c?.type === 'text').map((c) => c.text ?? '').join('\n');
  }
  return '';
}

// 순수함수(테스트 가능) — 파싱된 JSONL 라인(오래된 것→최신 순) 중 가장 최근 텔레그램
// 채널 사용자 메시지를 찾는다. 그 이후(=index 뒤)로 reply/react/edit_message/Agent
// 도구 호출이 있었는지까지 같이 판단해 "강제 재시도가 필요한가"를 반환한다.
//
// ⚠️ isSidechain 제외(코드리뷰 지적, 2026-09-04) — 위임된 서브에이전트(Agent) 프롬프트가
// 채널 태그 원문을 그대로 인용하는 경우, 그 사이드체인 라인까지 "최근 채널 메시지"로
// 잘못 잡으면 실제로는 이미 정상 답장한 뒤인데도 강제재시도가 될 수 있다 — 메인
// 대화 라인(isSidechain !== true)만 본다.
export function analyzeTranscriptTail(lines) {
  let lastChannelIdx = -1;
  let chatId = null, messageId = null;
  for (let i = 0; i < lines.length; i++) {
    const d = lines[i];
    if (d?.isSidechain === true) continue;
    if (d?.type !== 'user') continue;
    const text = getMessageText(d.message);
    const m = CHANNEL_TAG_RE.exec(text);
    if (m) {
      lastChannelIdx = i;
      chatId = m[1];
      messageId = m[2];
    }
  }
  if (lastChannelIdx === -1) return { shouldForceReply: false, chatId: null, messageId: null };

  let delivered = false;
  for (let i = lastChannelIdx + 1; i < lines.length; i++) {
    const d = lines[i];
    if (d?.isSidechain === true) continue;
    if (d?.type !== 'assistant') continue;
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === 'tool_use' && DELIVERY_TOOL_NAMES.has(c.name)) { delivered = true; break; }
    }
    if (delivered) break;
  }
  return { shouldForceReply: !delivered, chatId, messageId };
}

// ⚠️ "55MB" 정정(2026-09-04 후속 코드리뷰) — 이전 주석이 인용한 55MB는 실제로는
// 이 프로젝트 cwd로 뜬 다른(오너 인터랙티브) 세션의 transcript였다(CLAUDE.md 프롬프트가
// 예시로 채널 태그 원문을 인용해서 grep이 오탐한 것) — 실측으로 재확인한 진짜 텔레그램
// 세션 transcript 크기는 최대 362KB뿐(telegram-session-handoff.mjs 헤더 주석 참고).
// 그래도 tail-read 자체는 무해한 안전마진이라 유지 — TAIL_BYTES만 읽어 JSONL로 파싱,
// 하루 종일 누적되는 파일 전체를 매번 읽지 않는다. 앞부분 잘린 줄 하나는 버림(어차피
// 우리가 찾는 최신 메시지는 끝쪽에 있음).
export function readTranscriptTailLines(transcriptPath, maxBytes = TAIL_BYTES) {
  const fd = openSync(transcriptPath, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    // ⚠️ readSync 반환값(실제 읽은 바이트 수) 확인 필수(코드리뷰 지적, 2026-09-04) —
    // 무시하면 short read 시 buf 뒷부분이 Buffer.alloc의 0바이트 패딩으로 남아
    // 마지막(=우리가 가장 원하는) 줄이 NUL로 오염돼 JSON.parse가 조용히 실패할 수
    // 있다. 실제로 읽힌 만큼만 잘라서 디코드.
    const bytesRead = readSync(fd, buf, 0, buf.length, start);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const rawLines = text.split('\n').slice(start > 0 ? 1 : 0);
    const parsed = [];
    for (const line of rawLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { parsed.push(JSON.parse(trimmed)); } catch { /* 잘린 줄 등 — 스킵 */ }
    }
    return parsed;
  } finally {
    closeSync(fd);
  }
}

// chatId도 키에 포함(코드리뷰 지적, 2026-09-04) — 지금은 오너 한 명(chat_id 고정)뿐이라
// message_id 단독으로도 실제 충돌은 없지만, 나중에 두 번째 채팅(그룹·다른 계정 등)이
// 열리면 텔레그램의 message_id는 채팅별로 독립 채번되므로 서로 다른 채팅의 같은
// message_id가 재시도 카운트를 잘못 공유할 수 있다 — 미리 막아둠.
function guardFilePath(sessionId, chatId, messageId) {
  const safe = (s) => String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(GUARD_DIR, `${safe(sessionId)}-${safe(chatId)}-${safe(messageId)}.json`);
}

function getRetryCount(sessionId, chatId, messageId) {
  const fp = guardFilePath(sessionId, chatId, messageId);
  try {
    if (existsSync(fp)) return JSON.parse(readFileSync(fp, 'utf8')).retryCount || 0;
  } catch { /* 손상된 가드파일 — 0으로 취급 */ }
  return 0;
}

// 쓰기 실패 시 null 반환(코드리뷰 CRITICAL 지적, 2026-09-04) — 예전엔 실패해도
// count를 그대로 반환해 호출부가 정상 진행했는데, 그러면 다음 실행에서
// getRetryCount가 여전히 0을 읽어(아무것도 실제로 안 남았으므로) MAX_RETRIES에
// 영원히 도달 못 하고 매 Stop마다 무한 block — 이 훅의 유일한 루프 방지 장치가
// 무력화된다. 쓰기 실패는 "재시도 횟수를 보장 못 함"이므로 이번엔 안전한 쪽
// (block 포기하고 통과)으로 fail — 이 훅의 최상위 원칙(훅 자체 실패로 세션을
// 막지 않는다)과 동일 정신.
function incrementRetryCount(sessionId, chatId, messageId) {
  const fp = guardFilePath(sessionId, chatId, messageId);
  const count = getRetryCount(sessionId, chatId, messageId) + 1;
  try {
    mkdirSync(GUARD_DIR, { recursive: true });
    writeFileSync(fp, JSON.stringify({ retryCount: count }));
    return count;
  } catch {
    return null;
  }
}

// 가드파일은 message_id마다 하나씩 영구히 남아 상시세션이 오래 돌수록 조용히
// 쌓인다 — 매 실행마다 24시간 지난 파일을 베스트에포트로 정리(실패해도 훅 판단에
// 영향 없음, 순수 하우스키핑). 락 없이 단순 삭제라 동시성 걱정 없음(이 세션은
// 항상 순차 실행되는 단일 프로세스).
function cleanupStaleGuardFiles() {
  try {
    if (!existsSync(GUARD_DIR)) return;
    const now = Date.now();
    for (const f of readdirSync(GUARD_DIR)) {
      const fp = join(GUARD_DIR, f);
      try {
        if (now - statSync(fp).mtimeMs > GUARD_FILE_TTL_MS) unlinkSync(fp);
      } catch { /* 개별 파일 정리 실패는 무시 */ }
    }
  } catch { /* 디렉터리 읽기 실패도 무시 — 하우스키핑일 뿐 */ }
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

function pass() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function main() {
  if (!process.env.CLAUDE_TELEGRAM_SESSION) { pass(); return; }

  try {
    const raw = await readStdin();
    const data = JSON.parse(raw);
    if (shouldSkipBlocking(data)) { pass(); return; }

    cleanupStaleGuardFiles();

    const sessionId = data.session_id || data.sessionId || '';
    const transcriptPath = data.transcript_path || data.transcriptPath || '';
    if (!transcriptPath || !existsSync(transcriptPath)) { pass(); return; }

    const lines = readTranscriptTailLines(transcriptPath);
    const { shouldForceReply, chatId, messageId } = analyzeTranscriptTail(lines);
    if (!shouldForceReply) { pass(); return; }

    const retryCount = getRetryCount(sessionId, chatId, messageId);
    if (retryCount >= MAX_RETRIES) {
      console.error(`telegram-reply-guard: 재시도 ${MAX_RETRIES}회 소진, 포기 — chat_id=${chatId} message_id=${messageId}`);
      pass();
      return;
    }
    const newCount = incrementRetryCount(sessionId, chatId, messageId);
    if (newCount === null) {
      // 가드파일 쓰기 실패 — 재시도 횟수를 보장 못 하니 이번엔 block 대신 통과
      // (위 incrementRetryCount 헤더 주석 참고, 코드리뷰 CRITICAL 지적 반영).
      console.error(`telegram-reply-guard: 가드파일 쓰기 실패로 이번엔 통과 — chat_id=${chatId} message_id=${messageId}`);
      pass();
      return;
    }

    console.log(JSON.stringify({
      continue: false,
      decision: 'block',
      reason: `텔레그램 채널 메시지(message_id=${messageId})에 응답 텍스트는 생성했지만 reply/react 도구를 호출하지 않았습니다. ` +
        `이 채널은 도구 호출 없이는 오너에게 아무것도 전달되지 않습니다 — 지금 바로 mcp__plugin_telegram_telegram__reply(chat_id="${chatId}", ` +
        `text=..., reply_to="${messageId}")를 호출해 실제로 답장을 보내세요.`,
    }));
  } catch (e) {
    console.error(`telegram-reply-guard 오류(통과 처리): ${e?.message ?? e}`);
    pass();
  }
}

// entrypoint 가드 — 없으면 테스트가 이 파일을 import(analyzeTranscriptTail 등 순수함수
// 사용)만 해도 main()이 실행돼 stdin 대기·stdout 오염이 side effect로 발생한다
// (reconcile-irp.mjs 등 이 코드베이스 관례와 동일).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
