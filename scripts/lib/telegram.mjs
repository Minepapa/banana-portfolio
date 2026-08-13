import { readFileSync } from 'fs';

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
