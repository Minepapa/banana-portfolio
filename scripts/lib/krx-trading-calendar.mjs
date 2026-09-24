// KRX 거래일 캐시. KIS 국내휴장일조회는 원장 서비스 부하 때문에 하루 1회 호출을
// 권고하므로, updater 한 곳에서 갱신하고 주문·신호 경로는 당일 캐시만 동기 조회한다.
// 캐시가 없거나 날짜가 다르거나 손상됐으면 거래일로 추정하지 않는다.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const KRX_CALENDAR_CACHE_DIR = join(HERE, '..', '.cache', 'krx-trading-calendar');

export function kstDateLabel(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(date);
}

function cacheFile(date, cacheDir) {
  return join(cacheDir, `${date}.json`);
}

export function readKrxTradingDayStatus(date = new Date(), { cacheDir = KRX_CALENDAR_CACHE_DIR, now = new Date() } = {}) {
  const label = kstDateLabel(date);
  const filepath = cacheFile(label, cacheDir);
  if (!existsSync(filepath)) return { date: label, isOpen: null, reason: '당일 KRX 거래일 캐시 없음' };
  try {
    const record = JSON.parse(readFileSync(filepath, 'utf8'));
    const queriedAt = new Date(record.queriedAt);
    if (record.date !== label || !['open', 'closed'].includes(record.status)
      || !Number.isFinite(queriedAt.getTime()) || kstDateLabel(queriedAt) !== label
      || queriedAt > now) {
      return { date: label, isOpen: null, reason: '당일 KRX 거래일 캐시 형식 오류' };
    }
    return { date: label, isOpen: record.status === 'open', reason: record.reason || null };
  } catch {
    return { date: label, isOpen: null, reason: '당일 KRX 거래일 캐시를 읽을 수 없음' };
  }
}

export function isKrxTradingDay(date = new Date(), options) {
  return readKrxTradingDayStatus(date, options).isOpen === true;
}

export function writeKrxTradingDayStatus(
  { date, isOpen, queriedAt = new Date().toISOString() },
  { cacheDir = KRX_CALENDAR_CACHE_DIR, now = new Date() } = {},
) {
  const queriedAtDate = new Date(queriedAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || typeof isOpen !== 'boolean'
    || !Number.isFinite(queriedAtDate.getTime()) || kstDateLabel(queriedAtDate) !== date
    || queriedAtDate > now) {
    throw new Error('KRX 거래일 캐시 기록 입력이 유효하지 않음');
  }
  mkdirSync(cacheDir, { recursive: true });
  const filepath = cacheFile(date, cacheDir);
  const temp = `${filepath}.${process.pid}.tmp`;
  const record = { date, status: isOpen ? 'open' : 'closed', queriedAt, source: 'KIS CTCA0903R' };
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temp, filepath);
  return record;
}
