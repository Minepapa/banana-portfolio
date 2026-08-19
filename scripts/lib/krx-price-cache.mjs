// KRX 일별시세 로컬 캐시 — 종목별 OHLCV·시가총액 히스토리(RSI·52주고저·PBR용 marketCap
// 등, fundamentals.mjs의 KR 기술지표 산출용). ocf-history-cache.mjs와 같은 원칙(캐시
// 파일 atomic write)을 따르지만 캐시 단위가 "종목별"이 아니라 "거래일별"이다 — KRX
// API가 종목 단위가 아니라 그 날의 시장 전체를 한 번에 반환하기 때문에, 종목별로
// 캐시하면 종목 수만큼 같은 날짜를 중복 조회하게 된다(예: 20개 보유종목의 90일치를
// 각자 걸어가면 90×20=1,800회). 하루치를 한 번만 받아 캐싱해두면 그 뒤로 몇 종목을
// 조회하든 그 날짜분 API 호출이 다시 늘지 않는다 — 캐시 웜업 이후엔 디스크만 읽는다.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchStockDaily, fetchEtfDaily, ymd } from './krx.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '..', '.cache', 'krx-daily');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dayPath(basDd) { return join(CACHE_DIR, `${basDd}.json`); }

// 임시파일에 먼저 쓰고 rename — 같은 파일시스템 내 rename은 원자적이라 쓰는 도중
// 프로세스가 죽어도 절반만 쓰인 JSON이 영구 오염되지 않는다(ocf-history-cache.mjs와 동일 관례).
function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function readDayCache(basDd) {
  if (!existsSync(dayPath(basDd))) return null;
  try { return JSON.parse(readFileSync(dayPath(basDd), 'utf8')); } catch { return null; }
}

// basDd 하루치(KOSPI+KOSDAQ+ETF)를 캐시에서 읽거나, 없으면 KRX에서 받아 캐싱한다. 휴장일
// (전부 빈 배열)도 그대로 캐싱해 다음에 같은 휴장일을 또 조회하지 않게 한다. ETF는
// sto/{stk,ksq}_bydd_trd에 안 섞여 있고 별도 카테고리(etp/etf_bydd_trd)라 반드시 같이
// 받아야 한다(krx.mjs fetchEtfDaily 주석 참고 — 안 그러면 ETF 종목은 항상 "KRX에 없음"으로
// 잘못 실패한다).
async function ensureDay(basDd, { apiKey, fetchImpl } = {}) {
  const cached = readDayCache(basDd);
  // ETF 키가 없는 캐시는 ETF 지원 추가 전(2026-08-19 버그 수정 이전)에 쓰인 구버전
  // 스키마다 — 그대로 재사용하면 ETF 종목이 그 날짜에서 영구히 "없음"으로 캐시 고착된다.
  // 코드리뷰 지적(2026-08-19): 구버전 캐시는 신뢰하지 않고 다시 받는다.
  if (cached && 'ETF' in cached) return { day: cached, fromNetwork: false };
  const [kospi, kosdaq, etf] = await Promise.all([
    fetchStockDaily('KOSPI', basDd, { apiKey, fetchImpl }),
    fetchStockDaily('KOSDAQ', basDd, { apiKey, fetchImpl }),
    fetchEtfDaily(basDd, { apiKey, fetchImpl }),
  ]);
  const day = { KOSPI: kospi, KOSDAQ: kosdaq, ETF: etf };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeAtomic(dayPath(basDd), JSON.stringify(day));
  return { day, fromNetwork: true };
}

// startDate에서 과거로 하루씩 걸어가며 "실제 거래일"만 days건 모은다(krx.mjs
// fetchTradingDaySeries와 동일한 워크백 규칙 — 주말은 호출 자체를 안 하고, 평일인데
// 양쪽 시장 다 빈 배열이면 휴장/미발행으로 스킵). 캐시에 이미 있는 날은 네트워크
// 호출 없이 즉시 재사용하고, 실제로 네트워크를 탄 날만 delayMs만큼 쉰다(캐시 웜업 후
// 반복 조회는 지연 없이 즉시 끝난다). 반환: [{basDd, KOSPI, KOSDAQ}, ...] 과거→현재.
export async function ensurePriceHistory(days, {
  apiKey = process.env.KRX_API_KEY, fetchImpl, delayMs = 120, startDate = new Date(), maxScanDays,
} = {}) {
  const budget = maxScanDays ?? days * 2 + 15;
  const out = [];
  let d = new Date(startDate);
  let scanned = 0;
  while (out.length < days && scanned < budget) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      const basDd = ymd(d);
      const { day, fromNetwork } = await ensureDay(basDd, { apiKey, fetchImpl });
      const hasData = (day.KOSPI?.length || 0) + (day.KOSDAQ?.length || 0) + (day.ETF?.length || 0) > 0;
      if (hasData) out.push({ basDd, ...day });
      scanned++;
      if (fromNetwork && delayMs > 0 && scanned < budget && out.length < days) await sleep(delayMs);
    }
    d = new Date(d.getTime() - 86400000);
  }
  return out.reverse();
}

// Number('')===0이라 "필드 자체가 없음/빈 문자열"과 "진짜 0"을 구분 못 하는 함정이 있다
// (kis.mjs parseBalanceResponse와 동일 문제 — KRX 지수시리즈 응답의 CLSPRC_IDX 등도 값이
// 없을 때 빈 문자열로 온다, 2026-08-19 실측). 빈 문자열/null/undefined는 Number()를
// 아예 안 부르고 먼저 null 처리한다.
const numOrNull = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// history(ensurePriceHistory 결과, 과거→현재)에서 code 하나의 시계열을 뽑는다. 그
// 종목이 안 보이는 날(상장 전·거래정지 등)은 건너뛴다(추정하지 않음) — fundamentals.mjs
// computeRsi14 등은 결측 없는 연속 배열을 기대하므로, 반환 배열들은 항상 같은 길이·
// 같은 날짜 순서로 정렬돼 있다. 순수함수 — 테스트 가능(네트워크·디스크와 분리).
export function extractSeries(history, code) {
  const basDds = [], closes = [], highs = [], lows = [], volumes = [], values = [], marketCaps = [];
  for (const day of history ?? []) {
    const row = (day.KOSPI || []).find((r) => r.ISU_CD === code)
      ?? (day.KOSDAQ || []).find((r) => r.ISU_CD === code)
      ?? (day.ETF || []).find((r) => r.ISU_CD === code);
    if (!row) continue;
    const close = numOrNull(row.TDD_CLSPRC);
    if (close == null) continue; // 종가 없는 행은 신뢰 불가(거래정지 등) — 스킵
    basDds.push(day.basDd);
    closes.push(close);
    highs.push(numOrNull(row.TDD_HGPRC) ?? close);
    lows.push(numOrNull(row.TDD_LWPRC) ?? close);
    volumes.push(numOrNull(row.ACC_TRDVOL) ?? 0);
    values.push(numOrNull(row.ACC_TRDVAL));
    marketCaps.push(numOrNull(row.MKTCAP));
  }
  return { basDds, closes, highs, lows, volumes, values, marketCaps };
}

// fetchKrMarketData(fundamentals.mjs)가 쓰는 최종 진입점 — code의 최근 days거래일 시계열을
// (캐시 활용해) 확보하고 바로 시리즈로 뽑아 반환한다.
export async function fetchKrxPriceSeries(code, days, opts = {}) {
  const history = await ensurePriceHistory(days, opts);
  return extractSeries(history, code);
}
