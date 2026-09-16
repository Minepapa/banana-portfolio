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

// targetDate "이하"가 아니라 targetDate보다 **엄격히 이전**인 가장 최근 날짜를 찾는다
// (2026-09-14 신설) — daily-breakout-signal-scan.mjs가 "오늘"을 사전필터 기준일로
// 잘못 쓰던 실사고 수정용. 개별종목 시세 캐시(historical-prices/*.csv)는 매일 아침
// 전일까지만 갱신되므로 장중엔 구조적으로 "오늘"자 데이터를 가질 수 없는데, 벤치마크
// (코스피 지수) 캐시에 오늘자가 섞여 들어올 경로가 있으면(2026-09-16 기준: 이
// 파일을 쓰는 두 잡 자신은 이제 어제까지만 요청하지만, 다른 잡·수동 백테스트가
// 명시적으로 --to=오늘로 같은 공유 캐시 파일을 갱신하는 경로는 여전히 남아있음)
// 그 오늘자를 그대로 사전필터 기준일(cachedDate)로 쓰면 개별종목 캐시와 날짜가
// 구조적으로 절대 안 맞아 전 종목이 탈락한다(2026-09-14 실전 첫 테스트에서 발견 —
// 상세 경위는 Log/Implementation/2026-09-13-돌파매매-백테스트엔진-구현.md "실전
// 첫 테스트 결과" 절 참고). findIndexAtOrBefore를 재사용해 targetDate 자신이
// 걸리면 한 칸 더 물러난다. dates에 targetDate보다 이전 날짜가 없으면 null.
export function findLatestDateStrictlyBefore(dates, targetDate) {
  let idx = findIndexAtOrBefore(dates, targetDate);
  // 코드리뷰 지적(2026-09-14, LOW) — dates에 targetDate 중복이 있으면(이 프로젝트의
  // 실제 캐시엔 없지만, 이 함수의 존재 이유가 "오늘을 절대 안 씀"을 강제하는 것이라
  // 입력 가정이 깨졌을 때도 그 불변식만은 지켜야 함) 한 칸만 물러나서는 여전히
  // targetDate 자신을 가리킬 수 있다 — while로 전부 건너뛴다.
  while (idx >= 0 && dates[idx] === targetDate) idx -= 1;
  return idx >= 0 ? dates[idx] : null;
}
