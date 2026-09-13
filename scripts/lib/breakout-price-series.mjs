// 돌파매매 백테스트용 가격 시계열 로더 — Node 네이티브로 CSV를 직접 읽는다(Python
// 서브프로세스 왕복 없이). 일별 이벤트 기반 시뮬레이션(scripts/lib/breakout-simulator.mjs)이
// 종목당 수천 개 날짜를 반복 조회해야 해서, historical-universe.py를 매번 호출하던
// 월간 리밸런싱(run-quant-backtest.mjs) 방식은 비용이 너무 크다 — 종목당 CSV를
// 한 번만 읽어 메모리에 올려두고 그 위에서 전부 계산한다.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '..', '.cache', 'historical-prices');

// {code}.csv(Date,Open,Close,High,Low,Volume 헤더, historical-universe.py cache_prices
// 산출물 — Open은 2026-09-13 추가, 다음날 시가 체결 시뮬레이션용)를 전체 로드 —
// {dates, opens, closes, highs, lows, volumes}(전부 오름차순 배열). 캐시가 없거나
// 헤더뿐(빈 결과로 확정된 종목)이면 null(추정 안 함). opens는 구버전 캐시(Open 컬럼
// 없음)와의 호환을 위해 컬럼이 없으면 null로 채운다(추정 안 함 — 그 종목의 다음날
// 시가 진입은 데이터 없어 스킵됨을 뜻함).
export function loadPriceSeries(code, { cacheDir = CACHE_DIR } = {}) {
  const path = join(cacheDir, `${code}.csv`);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').trim();
  const lines = raw.split('\n');
  if (lines.length < 2) return null;
  const header = lines[0].split(',');
  const colIndex = Object.fromEntries(header.map((h, i) => [h, i]));
  if (colIndex.Close == null) return null;
  const dates = [];
  const opens = [];
  const closes = [];
  const highs = [];
  const lows = [];
  const volumes = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    dates.push(cols[0]);
    opens.push(colIndex.Open != null ? Number(cols[colIndex.Open]) : null);
    closes.push(Number(cols[colIndex.Close]));
    highs.push(colIndex.High != null ? Number(cols[colIndex.High]) : null);
    lows.push(colIndex.Low != null ? Number(cols[colIndex.Low]) : null);
    volumes.push(colIndex.Volume != null ? Number(cols[colIndex.Volume]) : null);
  }
  return { dates, opens, closes, highs, lows, volumes };
}

// codes 전체를 한 번에 로드 — {code: series|null}.
export function loadPriceSeriesBatch(codes, opts = {}) {
  const out = {};
  for (const code of codes) out[code] = loadPriceSeries(code, opts);
  return out;
}

// series(loadPriceSeries 결과)에서 targetDate 이하 가장 최근 인덱스를 이분탐색으로 찾는다
// (dates가 오름차순 정렬돼 있다는 전제 — cache_prices가 pandas DataFrame을 그대로
// CSV로 저장해 항상 오름차순). 못 찾으면 -1.
export function findIndexAtOrBefore(dates, targetDate) {
  let lo = 0;
  let hi = dates.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= targetDate) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}
