import { writeFileSync, readFileSync, unlinkSync } from 'fs';

export const COOLDOWN_FILE = process.env.COOLDOWN_FILE
  || `${process.env.HOME}/.config/banana-portfolio/quota-cooldown.json`;
export const LIMIT_RE = /hit your (limit|session limit)|usage limit|사용량 한도/i;

// 한도 메시지의 "resets 10:50am (Asia/Seoul)" → KST 기준 다음 도래 시각(ms).
// 분 생략("8pm")·이미 지난 시각(다음날 롤오버) 처리. 파싱 실패 시 null.
export function parseResetTime(message, now = Date.now()) {
  const m = String(message ?? '').match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3].toLowerCase();
  if (hour === 12) hour = 0;            // 12am→0, 12pm→12(아래서 +12)
  if (ap === 'pm') hour += 12;
  if (hour > 23 || min > 59) return null;
  const KST = 9 * 3600_000;
  const kstNow = new Date(now + KST);
  const y = kstNow.getUTCFullYear(), mo = kstNow.getUTCMonth(), d = kstNow.getUTCDate();
  let resetUtc = Date.UTC(y, mo, d, hour, min) - KST;
  if (resetUtc <= now) resetUtc += 24 * 3600_000;
  return resetUtc;
}

export function setCooldown(resetAt, reason = '') {
  try {
    writeFileSync(COOLDOWN_FILE, JSON.stringify({ resetAt, reason, setAt: Date.now() }));
  } catch { /* 파일 못 쓰면 무시 */ }
}

export function getCooldown(now = Date.now()) {
  let data;
  try { data = JSON.parse(readFileSync(COOLDOWN_FILE, 'utf8')); }
  catch { return null; }
  if (!data || typeof data.resetAt !== 'number' || now >= data.resetAt) {
    try { unlinkSync(COOLDOWN_FILE); } catch { /* noop */ }
    return null;
  }
  return { resetAt: data.resetAt, reason: data.reason || '' };
}

export function cooldownActive() {
  const cd = getCooldown();
  if (!cd) return false;
  const when = new Date(cd.resetAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`⏳ 사용량 한도 쿨다운 중 (reset ${when}) — claude 호출 skip`);
  return true;
}
