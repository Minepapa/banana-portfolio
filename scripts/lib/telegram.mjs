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
