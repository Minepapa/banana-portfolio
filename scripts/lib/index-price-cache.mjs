// 코스피·코스닥 지수 종가 캐싱 — 백테스트 벤치마크 비교용(구현계획서 Phase 10).
// historical-universe.py의 개별종목 시세 캐싱과 별도 파일인 이유: 대상이 지수 2개뿐이라
// 그 파일의 대량(4천여 종목) 후보풀·유동성 로직이 전혀 필요 없다 — 훨씬 작고 단순한
// 전용 캐시.
//
// ⚠️ 데이터소스 마이그레이션(2026-09-15) — 원래 FinanceDataReader(KS11·KQ11)를 썼는데,
// docs/DATA-SOURCES.md §5가 이 대체(Naver/FDR류 지수종가 → KRX)를 "미실행 후보"로만
// 올려뒀을 뿐 실제 전환은 안 돼 있었다(발견 경위: 2026-09-15 오전 돌파매매 RS 계산이
// "코스피 60거래일 -26%"라는 극단값을 내서 데이터 오염을 의심했으나, 같은 날짜를
// KRX 공식 API(`idx/kospi_dd_trd`)로 독립 대조한 결과 **완전히 동일한 값**이 나와
// FDR 자체는 정상이었다고 확인됨 — 2026년 6월 이후 코스피가 실제로 그 정도로
// 극심한 변동장이었음. 다만 이 기회에 나머지 프로젝트와 동일한 정본 소스(KRX)로
// 맞춰 일관성을 확보 + yfinance/FDR 지연 이슈에서도 벗어난다, docs/DATA-SOURCES.md
// §4에 반영). `krx.mjs`의 `fetchIndexCloseSeriesInRange`를 사용 — 날짜별 순차 조회라
// FDR의 한 번에 구간 조회보다 느리다(전체 이력 첫 백필은 수 분 걸릴 수 있음).
// **증분 병합**(2026-09-15 코드리뷰 CRITICAL 지적으로 신설) — 최초 버전은 캐시가
// 요청범위를 못 덮으면 "기존범위∪요청범위" 전체를 매번 통째로 재조회했다. 이러면
// 라이브 잡(daily-breakout-signal-scan.mjs)이 매일 `endDate=todayKST()`로 부르는데
// endDate가 매일 바뀌어 캐시가 절대 "완전히 덮음" 판정을 못 받고, 매일 2014년부터
// 전체(3천여 거래일 = 수천 회 순차 HTTP 호출, 실측 15~30분)를 다시 받는 회귀가
// 있었다(실측 재현 확인) — 15:32 신호스캔→15:40 발주창을 넘길 수 있는 실거래 리스크.
// 지금은 기존 캐시 앞/뒤로 **부족한 구간만** 추가 조회해 이어붙인다(아래
// cacheIndexPrices 본문 참고) — 일일 증분은 보통 1~3거래일이라 수 초.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchIndexCloseSeriesInRange } from './krx.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '..', '.cache', 'index-prices');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const INDEX_NAMES_KR = { KOSPI: '코스피', KOSDAQ: '코스닥' }; // krx.mjs fetchIndexDaily의 IDX_NM 매칭용

function cachePath(indexName) {
  return join(CACHE_DIR, `${indexName}.json`);
}

function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

// ocf-history-cache.mjs와 동일한 이유로 캐시에 실제 조회 범위(startDate/endDate)도
// 같이 저장한다 — 파일 존재 여부만 보면 좁은 범위로 먼저 캐싱된 지수가 나중에 더
// 넓은 범위 요청을 영구히 가로막는다(코드리뷰 지적, 2026-08-08 — OCF 캐시에서 실제로
// 겪은 사고와 같은 버그 클래스, 여기서도 재발할 뻔했음을 확인).
function readCacheFile(indexName) {
  const path = cachePath(indexName);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function coversRange(cached, startDate, endDate) {
  if (!cached || !cached.startDate || !cached.endDate) return false;
  return cached.startDate <= startDate && cached.endDate >= endDate;
}

// export(2026-09-16) — daily-breakout-signal-scan.mjs·breakout-watchlist-preview.mjs가
// "오늘"이 아니라 "어제"까지만 캐시를 요청하려고 재사용한다(아래 두 파일의 사용처
// 주석 참고 — KRX 지수 배치데이터가 당일엔 아직 미발행일 수 있어 endDate=오늘로
// 요청하면 실패하는데, 그 두 잡은 애초에 "오늘" 값이 필요하지도 않았다).
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00`); // 정오 파싱(파일 상단 마이그레이션 노트와 동일 이유)
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function calendarDaysBetween(fromDate, toDate) {
  return Math.round((new Date(`${toDate}T12:00:00`) - new Date(`${fromDate}T12:00:00`)) / 86400000);
}

// 연휴(설·추석 등)가 며칠씩 겹칠 수 있어 여유를 둔다 — 요청 경계와 실제 첫/마지막
// 거래일 사이 차이가 이 값을 넘으면 "그 경계 부근에 소스가 데이터를 안 가진 것"으로
// 보고 조용히 부분캐시하지 않고 throw(feedback-no-silent-fallback 원칙, 2026-09-15
// 코드리뷰 HIGH 지적 — 원래는 요청한 effStart/effEnd를 실제 수신 여부와 무관하게
// 그대로 캐시에 "커버함"으로 기록해, 소스가 일부만 갖고 있어도 이후 영원히
// 재조회되지 않는 무언 오염 버그가 있었다).
const COVERAGE_TOLERANCE_DAYS = 10;

// 요청 구간을 실제로 커버하는지 검증 — 못 미치면 throw(부분 캐시 금지).
//
// ⚠️ 빈 응답(series.length===0) 처리를 관용일 기반으로 수정(2026-09-16 코드리뷰
// CRITICAL/HIGH 지적으로 재작성) — 원래는 빈 응답을 무조건 "데이터 소스 장애"로
// 단정해 throw했는데, 이게 실제로는 **이 프로젝트 전체가 이미 확립한 계약**(krx.mjs
// 상단 주석: "비거래일(주말·공휴일·데이터 미발행 당일)은 에러가 아니라 빈 배열로
// 온다 — 호출측이 빈 배열을 휴장일/미발행으로 스킵 처리하면 된다")을 이 함수만
// 어기고 있었다. 실사고로 재현됨: ①모든 호출부가 관례로 쓰는 startDate='2014-01-01'
// 이 신정 공휴일이라 실제 첫 거래일(2014-01-02)과 하루 어긋나는데, 캐시가 이미
// 2014-01-02부터 있으면 매 실행마다 "2014-01-01~2014-01-01"(1일짜리 빈 창) prefix
// 재조회를 시도해 무조건 throw — **라이브 신호스캔 잡이 단 한 번도 성공할 수
// 없었다**(2026-09-16 실측, npm test는 이 경로를 안 타서 놓침). ②suffix 쪽도
// "월요일 2회차 실행"(주말만 요청)이나 "연휴 다음 첫 거래일"(주말+공휴일 연속)처럼
// 요청창에 거래일이 아예 없는 정상적인 경우가 흔한데 그때마다 throw. 요청창의
// 달력일 길이가 COVERAGE_TOLERANCE_DAYS(연휴 흡수용 여유) 이내면 "이 구간엔 거래일
// 자체가 없었다"로 보고 빈 채로 통과시킨다(병합할 게 없으니 merged는 그대로 유지됨,
// 별도 처리 불필요) — 그보다 큰 창이 통째로 비면 여전히 데이터 소스 장애로 throw.
function assertCoverage(series, reqStart, reqEnd, indexName) {
  if (!series.length) {
    if (calendarDaysBetween(reqStart, reqEnd) <= COVERAGE_TOLERANCE_DAYS) return; // 정상 — 그 구간에 거래일이 없었을 뿐
    throw new Error(`${indexName} 지수 조회 결과 0건(${reqStart}~${reqEnd}) — 데이터 소스 장애 의심`);
  }
  const actualStart = series[0].date;
  const actualEnd = series[series.length - 1].date;
  if (calendarDaysBetween(reqStart, actualStart) > COVERAGE_TOLERANCE_DAYS) {
    throw new Error(`${indexName} 지수 데이터가 요청 시작일(${reqStart})을 못 덮음 — 실제 첫 거래일 ${actualStart}(소스가 이 구간을 갖고 있지 않을 가능성, 부분캐시 안 함)`);
  }
  if (calendarDaysBetween(actualEnd, reqEnd) > COVERAGE_TOLERANCE_DAYS) {
    throw new Error(`${indexName} 지수 데이터가 요청 종료일(${reqEnd})을 못 덮음 — 실제 마지막 거래일 ${actualEnd}(소스가 이 구간을 갖고 있지 않을 가능성, 부분캐시 안 함)`);
  }
}

// indexName: 'KOSPI'|'KOSDAQ'. 캐시가 요청 범위를 이미 덮으면 그대로 반환. 못 덮으면
// **부족한 구간만** 추가 조회해 기존 캐시 앞/뒤로 이어붙인다(2026-09-15 코드리뷰
// CRITICAL 지적으로 전면 재작성 — 이전엔 매번 합집합 범위 전체를 재조회했음, 위
// 파일 상단 마이그레이션 노트 참고). 캐시엔 요청범위가 아니라 **실제 수신한
// 첫/마지막 날짜**를 저장(부분 응답을 "완전 커버"로 잘못 기록하는 걸 구조적으로
// 방지). fetchSeries는 테스트 주입용(DI, 기본값 실제 KRX 조회). 반환:
// 'cached'|'fetched'. ⚠️ 2026-09-15부터 async(KRX API는 날짜별 순차 조회라 네트워크
// 호출 — 기존 FDR 버전은 spawnSync라 동기였음, 호출부 전부 await로 갱신 필요).
export async function cacheIndexPrices(indexName, startDate, endDate, { fetchSeries = fetchIndexCloseSeriesInRange } = {}) {
  assertDateString(startDate);
  const end = endDate || new Date().toISOString().slice(0, 10);
  assertDateString(end);
  if (startDate > end) throw new Error(`시작일(${startDate})이 종료일(${end})보다 나중일 수 없음`);

  mkdirSync(CACHE_DIR, { recursive: true });
  const existing = readCacheFile(indexName);
  if (coversRange(existing, startDate, end)) return 'cached';

  const indexNm = INDEX_NAMES_KR[indexName];
  if (!indexNm) throw new Error(`알 수 없는 지수명: ${indexName}(허용: ${Object.keys(INDEX_NAMES_KR).join(', ')})`);

  let merged = existing?.series ?? [];
  if (!existing || startDate < existing.startDate) {
    const prefixEnd = existing ? addDays(existing.startDate, -1) : end;
    const prefixSeries = await fetchSeries(indexName, indexNm, startDate, prefixEnd);
    assertCoverage(prefixSeries, startDate, prefixEnd, indexName);
    merged = [...prefixSeries, ...merged];
  }
  if (existing && end > existing.endDate) {
    const suffixStart = addDays(existing.endDate, 1);
    const suffixSeries = await fetchSeries(indexName, indexNm, suffixStart, end);
    assertCoverage(suffixSeries, suffixStart, end, indexName);
    merged = [...merged, ...suffixSeries];
  }

  const observedStart = merged[0]?.date ?? startDate;
  const observedEnd = merged[merged.length - 1]?.date ?? end;
  writeAtomic(cachePath(indexName), JSON.stringify({ startDate: observedStart, endDate: observedEnd, series: merged }));
  return 'fetched';
}

function loadSeries(indexName) {
  return readCacheFile(indexName)?.series ?? null;
}

function assertDateString(d) {
  if (typeof d !== 'string' || !DATE_RE.test(d)) {
    throw new Error(`날짜는 "YYYY-MM-DD" 문자열이어야 함(ocf-history-cache.mjs와 동일 계약): ${JSON.stringify(d)}`);
  }
}

// targetDate 이하 가장 최근 거래일 종가 — 캐시가 없거나 조건 만족 데이터가 없으면 null
// (추정 안 함, historical-universe.py price_at_or_before와 동일 원칙).
export function indexPriceAtOrBefore(indexName, targetDate) {
  assertDateString(targetDate);
  const series = loadSeries(indexName);
  if (!series || !series.length) return null;
  let best = null;
  for (const r of series) {
    if (r.date <= targetDate && (!best || r.date > best.date)) best = r;
  }
  return best ? best.close : null;
}

// 캐시된 지수 시계열 전체를 {dates, closes}(오름차순 배열)로 반환 — 돌파매매 일별
// 백테스트(breakout-simulator.mjs)가 특정 날짜들만 점조회하는 게 아니라 상대강도(RS)
// 계산에 전체 구간이 필요해 신설(2026-09-12). 캐시 없으면 null(추정 안 함).
export function loadIndexSeries(indexName) {
  const series = loadSeries(indexName);
  if (!series || !series.length) return null;
  return { dates: series.map((r) => r.date), closes: series.map((r) => r.close) };
}

// indexName × targetDates 여러 개를 한 번에 조회(로드-후-질의 패턴).
export function indexPricesAt(indexName, targetDates) {
  targetDates.forEach(assertDateString);
  const series = loadSeries(indexName);
  const out = {};
  for (const d of targetDates) {
    if (!series || !series.length) { out[d] = null; continue; }
    let best = null;
    for (const r of series) {
      if (r.date <= d && (!best || r.date > best.date)) best = r;
    }
    out[d] = best ? best.close : null;
  }
  return out;
}
