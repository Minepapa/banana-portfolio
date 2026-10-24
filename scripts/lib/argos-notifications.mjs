// 아르고스가 보낸 투자 알림(95_Etna/Events의 notification.received, 분류 '투자')을 읽고
// 카카오 알림 파서와 같은 파서로 거른다. 2026-10-24부터 투자·소비 알림은 채널·앱 전체를
// 받으므로(오너), 장부에 쓸 알림만 고르는 일은 여기 파싱에서 한다.
// 병행 기간에는 장부에 쓰지 않는다 — 카카오 알림 앱 경로가 정본이고, 이 모듈은 대조 도구가 쓴다.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseCashAlarm, parseDividend, parseExchange, parseExecution, parseFundBuy, parseFundValuation, parseGoldBuy,
} from './notification-parsers.mjs';

// parse-notifications-to-vault.mjs의 처리 순서와 같다.
export const INVESTMENT_PARSERS = Object.freeze([
  ['체결', parseExecution], ['배당', parseDividend], ['금현물', parseGoldBuy], ['예수금', parseCashAlarm],
  ['펀드적립', parseFundBuy], ['펀드평가', parseFundValuation], ['환전', parseExchange],
]);

/** epoch ms → 카카오 수신함과 같은 'YYYY-MM-DD HH:mm:ss'(KST). */
export function kstTimestamp(ms) {
  const d = new Date(ms + 9 * 3600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 날짜(YYYY-MM-DD) 하루치 이벤트 파일에서 아르고스 투자 알림만 꺼낸다. 파일이 없으면 빈 목록. */
export function readArgosInvestmentNotifications(eventsDir, date) {
  const path = join(eventsDir, date.slice(0, 4), `${date}.jsonl`);
  if (!existsSync(path)) return [];
  const items = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const payload = event?.payload;
    if (event?.type !== 'notification.received' || payload?.category !== '투자') continue;
    const body = typeof payload.body === 'string' ? payload.body : '';
    const at = Number(payload.postedAt ?? event.occurred_at);
    if (!body || !Number.isFinite(at)) continue;
    items.push({ id: String(event.id ?? ''), ts: kstTimestamp(at), body, sender: String(payload.sender ?? payload.appLabel ?? '') });
  }
  return items;
}

/** 장부에 쓸 투자 알림이면 { type, parsed }, 아니면(광고·안내 등) null. */
export function classifyInvestmentNotification(body, ts) {
  for (const [type, parse] of INVESTMENT_PARSERS) {
    const parsed = parse(body, ts);
    if (parsed) return { type, parsed };
  }
  return null;
}

const listMd = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : []);
const LEDGER_NAME = /^(\d{4}-\d{2}-\d{2})-(\d{6})-(.+)\.md$/;
const epochOf = (date, hhmmss) => Date.parse(`${date}T${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}+09:00`);

/**
 * 같은 알림을 카카오 경로가 이미 장부에 남겼는지 본다. 파일명은 '날짜-시각-나머지.md'인데 시각은 수신 시각이라
 * 두 앱이 몇 초 다를 수 있어, 나머지가 같고 시각 차이가 toleranceSec 안이면 같은 기록으로 본다(자정을 넘어도).
 * prefix: 나머지가 '기대값-…'으로 이어져도 맞다고 본다(체결 파일명 끝의 주문번호·이벤트 id).
 * used: 이미 짝지은 장부 파일 — 한 장부 기록을 두 알림에 짝짓지 않는다.
 */
export function findLedgerTwin(filename, dir, { toleranceSec = 180, prefix = false, used = new Set() } = {}) {
  const m = filename.match(LEDGER_NAME);
  if (!m) {
    const exact = listMd(dir).includes(filename) && !used.has(join(dir, filename));
    if (exact) used.add(join(dir, filename));
    return exact ? filename : null;
  }
  const at = epochOf(m[1], m[2]);
  let best = null;
  for (const other of listMd(dir)) {
    const o = other.match(LEDGER_NAME);
    if (!o || used.has(join(dir, other))) continue;
    if (!(o[3] === m[3] || (prefix && o[3].startsWith(`${m[3]}-`)))) continue;
    const gap = Math.abs(epochOf(o[1], o[2]) - at);
    if (gap <= toleranceSec * 1000 && (!best || gap < best.gap)) best = { other, gap };
  }
  if (best) used.add(join(dir, best.other));
  return best?.other ?? null;
}
