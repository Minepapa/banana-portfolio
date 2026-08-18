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

export function loadTelegramConfig() {
  const env = readFileSync(TG_ENV, 'utf8');
  const m = env.match(/TELEGRAM_BOT_TOKEN\s*=\s*(\S+)/);
  if (!m) throw new Error('TELEGRAM_BOT_TOKEN 누락 (channels/telegram/.env)');
  const access = JSON.parse(readFileSync(TG_ACCESS, 'utf8'));
  const chatId = (access.allowFrom || [])[0];
  if (!chatId) throw new Error('수신 chat_id 누락 (access.json allowFrom)');
  return { botToken: m[1], chatId };
}

export async function sendTelegram(text, chatId) {
  const cfg = loadTelegramConfig();
  const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId || cfg.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) throw new Error(`텔레그램 전송 실패: ${await res.text()}`);
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
