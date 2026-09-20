import { readFileSync } from 'fs';
import { setDefaultAutoSelectFamily } from 'node:net';

// ⚠️ 실사고 근본원인(2026-08-18, task #34) — health-watcher·daily-asset-allocation-
// check·new-cash-allocation 등에서 "텔레그램 알림 실패: fetch failed"가 반복되던
// 진짜 원인을 찾았다. curl은 api.telegram.org에 즉시 연결되는데(IPv6는 "No route to
// host"로 빠르게 실패 후 IPv4로 자연 전환) Node의 fetch()는 같은 IPv4 주소에서
// ETIMEDOUT으로 멈췄다 — Node 20+ 기본 활성화된 Happy Eyeballs(RFC 8305, 이중스택
// 동시접속 경쟁) 구현이 "IPv6가 즉각 거부되지만 IPv4는 느리게 응답하는" 이 머신의
// 네트워크 조건에서 오작동하는 것으로 확인(재현: 이 옵션 없이 매번 실패, 있으면
// 매번 즉시 성공). "상시세션 재연결 불안정"으로 보고됐던 문제의 실체는 상시세션
// 자체(bun 기반 MCP 서버, 별도 런타임이라 이 버그와 무관해 보임)가 아니라, 알림을
// 보내는 별개 launchd Node 잡들이 매번 이 타임아웃에 걸려 알림 발송에 실패하던
// 것이었다 — "재연결이 불안정하다"는 증상 설명이 원인을 잘못 짚고 있었다.
setDefaultAutoSelectFamily(false);

const TG_ENV = `${process.env.HOME}/.claude/channels/telegram/.env`;
const TG_ACCESS = `${process.env.HOME}/.claude/channels/telegram/access.json`;

// HTML 특수문자 이스케이프 — parse_mode:'HTML'로 보내기 전에 "우리가 의도한 태그가
// 아닌" 동적/원문 텍스트(로그 원문·예외 메시지·오너 자유입력 등)에 먼저 적용해야
// 한다. 원래 weekly-report.mjs에만 로컬로 있던 함수를 공유 위치로 승격(2026-09-18,
// 코드리뷰 지적 — record-heartbeat-vault.mjs:44가 잡 로그 tail 원문을 그대로
// <b>/<code> 서식 안에 끼워 넣다가 파이썬 트레이스백의 "<module>"에 걸려 텔레그램
// 발송 자체가 거부된 실사고의 발신 지점이었음). sendTelegram/editTelegramMessage의
// HTML-파싱-실패 시 plain text 재시도는 "모르는 경로"용 안전망이고, 이 함수는
// "아는 경로"(호출부가 직접 원문을 끼워넣는 지점)에서 원천적으로 막는 용도 —
// 두 방어는 서로 대체가 아니라 보완 관계.
export function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function loadTelegramConfig() {
  const env = readFileSync(TG_ENV, 'utf8');
  const m = env.match(/TELEGRAM_BOT_TOKEN\s*=\s*(\S+)/);
  if (!m) throw new Error('TELEGRAM_BOT_TOKEN 누락 (channels/telegram/.env)');
  const access = JSON.parse(readFileSync(TG_ACCESS, 'utf8'));
  const chatId = (access.allowFrom || [])[0];
  if (!chatId) throw new Error('수신 chat_id 누락 (access.json allowFrom)');
  return { botToken: m[1], chatId };
}

// HTML parse_mode 요청이 "can't parse entities" 계열로 거부되면 서식을 포기하고
// plain text로 한 번 더 시도 — 순수 판정 로직만 분리(테스트 가능, 2026-09-18
// 실사고 대응 아래 sendTelegram 주석 참고).
export function isHtmlParseFailure(status, bodyText) {
  return status === 400 && /can't parse entities/i.test(bodyText || '');
}

// ⚠️ 실사고 근본원인(2026-09-18, Log/DevRequests/2026-09-18-macro-cache-데이터신선도
// -알람공백.md) — 잡이 파이썬 예외 메시지(예: 트레이스백의 "<module>")를 그대로
// 텔레그램 본문에 넣으면, 그 문자열이 우리가 의도한 <b> 서식 태그와 구분 안 돼
// Telegram이 "Bad Request: can't parse entities: Unsupported start tag \"module\""
// 로 전송 자체를 거부한다. 로그엔 실패가 찍히지만 오너에게는 그 실패 사실조차
// 전혀 도달하지 않는 완전한 침묵 장애였다(호출부가 전부 catch해서 console.error만
// 남기고 넘어가는 관행 — 알림 발송 실패로 또 알림을 보내려 하면 무한루프 위험이라
// 그 관행 자체는 맞음, 문제는 애초에 발송이 실패한다는 것).
//
// 모든 호출부(수십 곳)에서 매번 이스케이프하도록 강제하는 대신(누락 위험이 계속
// 남음, feedback-no-silent-fallback과 같은 "구조적 가드 우선" 원칙), 이 함수
// 자신이 안전망 역할을 한다 — HTML 파싱 실패를 감지하면 같은 텍스트를 parse_mode
// 없이(plain text) 한 번 더 시도한다. <b> 등 의도한 서식은 깨져서 화면에 그대로
// 보이지만("<b>제목</b>" 처럼), 그보다 "메시지 자체가 오너에게 안 감"이 훨씬 나쁜
// 실패모드라 이쪽을 택한다.
//
// ⚠️ 코드리뷰 지적(2026-09-18) 2건 반영 — ①폴백이 조용히 성공하면(예외 없음,
// job-alerts.mjs가 텔레그램 실패 자체는 또 삼킴) "어디선가 서식이 깨지고 있다"는
// 사실이 영원히 아무 데도 안 남는다 — 폴백 본문 맨 앞에 눈에 띄는 마커를 붙여
// 오너 화면에서 바로 보이게 한다. ②`bodyText`(텔레그램 응답 전문, 길 수 있음)를
// 그대로 console.error에 찍으면 run.sh의 `tail -n 3`(잡상태 detail)가 이 긴 줄에
// 밀려 정작 원래 경고 요약(job-alerts.mjs가 먼저 찍은 "⚠ 경고 N건: ...")을 못
// 담을 수 있어 길이를 제한한다.
const FALLBACK_ERROR_LOG_MAX_LEN = 200;

// Telegram Bot API 메시지 본문 상한(4096 UTF-16 코드유닛) — 안 지키면 400 "message
// is too long"으로 발송 자체가 거부되고, job-alerts.mjs의 flushWarnings가 그 실패를
// catch해 경고 배치 전체가 조용히 유실된다(2026-09-20 독립 코드리뷰 MEDIUM 지적 —
// weekly-report.mjs의 위치정보 포함 경고나 facts 항목이 많은 메시지가 이 상한을
// 넘기기 쉬워짐: "· " 불릿 + 빈 줄 분리를 이번에 추가하면서 메시지 길이가 더 늘었다).
// 각 호출부에서 개별적으로 길이를 신경 쓰게 하는 대신(누락 위험) 발송 함수 자신이
// 최종 안전망으로 자른다 — HTML 태그가 잘려 파싱 실패가 나도 아래 plain text
// 폴백이 이미 있어 "아예 안 감"보다는 낫다.
const MAX_TELEGRAM_TEXT_LEN = 4096;
const TRUNCATE_MARKER = '\n\n…(길이 제한으로 생략됨, 전체 내용은 로그 파일 참고)';
export function truncateForTelegram(text) {
  const t = String(text ?? '');
  if (t.length <= MAX_TELEGRAM_TEXT_LEN) return t;
  return t.slice(0, MAX_TELEGRAM_TEXT_LEN - TRUNCATE_MARKER.length) + TRUNCATE_MARKER;
}

export async function sendTelegram(text, chatId, { fetchImpl = fetch } = {}) {
  const cfg = loadTelegramConfig();
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  const payload = { chat_id: chatId || cfg.chatId, text: truncateForTelegram(text), disable_web_page_preview: true };
  let res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    if (isHtmlParseFailure(res.status, bodyText)) {
      console.error(`⚠️ 텔레그램 HTML 파싱 실패 — 서식 포기하고 plain text로 재시도: ${bodyText.slice(0, FALLBACK_ERROR_LOG_MAX_LEN)}`);
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, text: truncateForTelegram(`[서식 오류 — 원문 그대로 발송]\n${payload.text}`) }), // parse_mode 없음 = plain text
      });
      if (!res.ok) throw new Error(`텔레그램 전송 실패(plain text 재시도도 실패): ${await res.text()}`);
      return res.json();
    }
    throw new Error(`텔레그램 전송 실패: ${bodyText}`);
  }
  return res.json();
}

// 원본 제안 메시지(제안 발송 시 sendTelegram이 반환한 message_id)를 승인/거부 처리 후
// 갱신하는 용도(2026-08-23 신설, ARCHITECTURE-V2.md 설계에 있었지만 미구현이던 부분) —
// 지금은 승인/거부해도 텔레그램 화면에 아무 표시가 안 남아 나중에 스크롤해서 어느
// 제안이 어떻게 됐는지 찾기 어려웠다. Bot API editMessageText는 append가 아니라 전체
// 텍스트를 새로 보내는 방식이라, 호출부(process-telegram-reply.mjs)가 상태를 반영한
// 완성된 텍스트를 통째로 넘겨야 한다.
// sendTelegram과 동일한 HTML 파싱 실패 안전망(2026-09-18) — 이 경로도 동적 텍스트를
// <b> 서식과 함께 보낼 수 있어 같은 실패모드에 노출된다.
export async function editTelegramMessage(messageId, text, chatId, { fetchImpl = fetch } = {}) {
  const cfg = loadTelegramConfig();
  const url = `https://api.telegram.org/bot${cfg.botToken}/editMessageText`;
  const payload = { chat_id: chatId || cfg.chatId, message_id: messageId, text: truncateForTelegram(text), disable_web_page_preview: true };
  let res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    if (isHtmlParseFailure(res.status, bodyText)) {
      console.error(`⚠️ 텔레그램 메시지 편집 HTML 파싱 실패 — plain text로 재시도: ${bodyText.slice(0, FALLBACK_ERROR_LOG_MAX_LEN)}`);
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, text: truncateForTelegram(`[서식 오류 — 원문 그대로 발송]\n${payload.text}`) }),
      });
      if (!res.ok) throw new Error(`텔레그램 메시지 편집 실패(plain text 재시도도 실패): ${await res.text()}`);
      return res.json();
    }
    throw new Error(`텔레그램 메시지 편집 실패: ${bodyText}`);
  }
  return res.json();
}

// getWebhookInfo — 상시세션의 getUpdates 롱폴링이 실제로 큐를 비우고 있는지 외부에서
// 확인하는 용도(2026-08-13, task #34 — 프로세스는 살아있는데 폴링만 조용히 끊긴
// "좀비" 상태 감지). getUpdates 자체를 호출하지 않는 별개 read-only 엔드포인트라
// 상시세션의 단일 소비자 슬롯과 절대 충돌하지 않는다(409 Conflict 없음, plist 주석의
// "getUpdates 소비자는 1개만 허용" 제약과 무관).
export async function getTelegramWebhookInfo() {
  const cfg = loadTelegramConfig();
  const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/getWebhookInfo`);
  if (!res.ok) throw new Error(`getWebhookInfo 실패: ${await res.text()}`);
  const json = await res.json();
  if (!json.ok) throw new Error(`getWebhookInfo 오류: ${json.description || '알 수 없음'}`);
  return json.result; // { url, pending_update_count, last_error_date?, last_error_message? }
}
