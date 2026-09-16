import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cacheIndexPrices, loadIndexSeries, indexPriceAtOrBefore, indexPricesAt, addDays,
} from './index-price-cache.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '..', '.cache', 'index-prices');
const KOSPI_CACHE_PATH = join(CACHE_DIR, 'KOSPI.json');

function row(date, close) { return { date, close }; }

// addDays export(2026-09-16) — daily-breakout-signal-scan.mjs·breakout-watchlist-
// preview.mjs가 "오늘"이 아니라 "어제"까지만 캐시를 요청하려고 재사용한다(KRX
// 지수 배치데이터가 당일 미발행일 수 있어 endDate=오늘 요청이 실패하던 실사고
// 수정, 그 두 잡은 애초에 "오늘" 값이 필요하지 않았음).
test('addDays: 평범한 덧셈·뺄셈', () => {
  assert.equal(addDays('2026-09-15', 1), '2026-09-16');
  assert.equal(addDays('2026-09-15', -1), '2026-09-14');
});

test('addDays: 월/연도 경계를 정확히 넘음', () => {
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01'); // 2026은 평년
});

// ⚠️ 이 테스트파일은 seed/삭제를 KOSPI.json 실제 캐시 경로에 대해 직접 한다(주입식
// fetchSeries로 네트워크는 안 타지만, 파일시스템은 실제 운영 캐시와 같은 파일을
// 쓴다) — 이 세션에서 16분 걸려 재구축한 실제 프로덕션 캐시(2014~2026, 3117거래일)를
// 테스트가 지워버리면 안 되므로, 스위트 시작 시 원본을 메모리에 백업했다가 스위트
// 종료 시(모든 테스트가 afterEach로 지운 뒤) 그대로 복원한다.
let realKospiCacheBackup = null;
before(() => {
  if (existsSync(KOSPI_CACHE_PATH)) realKospiCacheBackup = readFileSync(KOSPI_CACHE_PATH, 'utf8');
});
after(() => {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (realKospiCacheBackup != null) writeFileSync(KOSPI_CACHE_PATH, realKospiCacheBackup, 'utf8');
  else if (existsSync(KOSPI_CACHE_PATH)) rmSync(KOSPI_CACHE_PATH);
});

test('cacheIndexPrices: 알 수 없는 indexName은 즉시 throw', async () => {
  await assert.rejects(() => cacheIndexPrices('NASDAQ', '2026-01-01', '2026-01-31'), /알 수 없는 지수명/);
});

test('cacheIndexPrices: startDate가 endDate보다 나중이면 즉시 throw(네트워크 호출 전)', async () => {
  let called = false;
  const fetchSeries = async () => { called = true; return []; };
  await assert.rejects(
    () => cacheIndexPrices('KOSPI', '2026-02-01', '2026-01-01', { fetchSeries }),
    /나중일 수 없음/,
  );
  assert.equal(called, false, 'startDate>endDate면 fetchSeries가 호출되면 안 됨');
});

// 아래부터는 INDEX_NAMES_KR에 등록된 실제 키('KOSPI')로 테스트하되, fetchSeries를
// 주입해 실제 네트워크를 타지 않는다. 각 테스트 뒤엔 afterEach로 파일을 지우고(다음
// 테스트가 깨끗한 상태에서 시작), 스위트 전체가 끝나면 위 after()가 원본을 복원한다.
function seedKospiCache(startDate, endDate, series) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(KOSPI_CACHE_PATH, JSON.stringify({ startDate, endDate, series }), 'utf8');
}
function cleanupKospiCache() {
  if (existsSync(KOSPI_CACHE_PATH)) rmSync(KOSPI_CACHE_PATH);
}
test.afterEach(cleanupKospiCache);

test('cacheIndexPrices: 캐시 없으면 요청구간 전체를 한 번만 조회', async () => {
  const calls = [];
  const fetchSeries = async (indexName, indexNm, s, e) => {
    calls.push([s, e]);
    return [row('2026-01-05', 2500), row('2026-01-06', 2510)];
  };
  const result = await cacheIndexPrices('KOSPI', '2026-01-05', '2026-01-06', { fetchSeries });
  assert.equal(result, 'fetched');
  assert.deepEqual(calls, [['2026-01-05', '2026-01-06']]);
  const cached = JSON.parse(readFileSync(KOSPI_CACHE_PATH, 'utf8'));
  assert.equal(cached.startDate, '2026-01-05');
  assert.equal(cached.endDate, '2026-01-06');
});

test('cacheIndexPrices: 캐시가 요청구간을 이미 덮으면 재조회 없이 cached 반환', async () => {
  seedKospiCache('2026-01-01', '2026-01-31', [row('2026-01-05', 2500)]);
  let called = false;
  const fetchSeries = async () => { called = true; return []; };
  const result = await cacheIndexPrices('KOSPI', '2026-01-10', '2026-01-20', { fetchSeries });
  assert.equal(result, 'cached');
  assert.equal(called, false);
});

test('cacheIndexPrices: 증분(핵심) — 기존 캐시 뒤로 부족한 구간만 조회, 이미 있는 구간은 재조회 안 함', async () => {
  seedKospiCache('2014-01-02', '2026-09-14', [row('2026-09-12', 6900), row('2026-09-13', 6910), row('2026-09-14', 6684.37)]);
  const calls = [];
  const fetchSeries = async (indexName, indexNm, s, e) => {
    calls.push([s, e]);
    return [row('2026-09-15', 6700)];
  };
  const result = await cacheIndexPrices('KOSPI', '2014-01-02', '2026-09-15', { fetchSeries });
  assert.equal(result, 'fetched');
  // 딱 부족분(9/15 하루)만 조회했는지 — 2014년부터 통째로 재조회하는 회귀 재발 방지 가드
  assert.deepEqual(calls, [['2026-09-15', '2026-09-15']]);
  const cached = JSON.parse(readFileSync(KOSPI_CACHE_PATH, 'utf8'));
  assert.deepEqual(cached.series.map((r) => r.date), ['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15']);
  assert.equal(cached.endDate, '2026-09-15');
});

test('cacheIndexPrices: 증분 — 기존 캐시 앞으로 부족한 구간(prefix)만 조회', async () => {
  seedKospiCache('2020-01-02', '2020-01-10', [row('2020-01-02', 2100), row('2020-01-10', 2200)]);
  const calls = [];
  const fetchSeries = async (indexName, indexNm, s, e) => {
    calls.push([s, e]);
    return [row('2019-12-30', 2000)];
  };
  const result = await cacheIndexPrices('KOSPI', '2019-12-30', '2020-01-10', { fetchSeries });
  assert.equal(result, 'fetched');
  assert.deepEqual(calls, [['2019-12-30', '2020-01-01']]);
  const cached = JSON.parse(readFileSync(KOSPI_CACHE_PATH, 'utf8'));
  assert.deepEqual(cached.series.map((r) => r.date), ['2019-12-30', '2020-01-02', '2020-01-10']);
  assert.equal(cached.startDate, '2019-12-30');
});

// 2026-09-16 실사고 정확 재현 — 이 프로젝트의 모든 실전 호출부(daily-breakout-
// signal-scan.mjs·breakout-watchlist-preview.mjs)가 관례로 쓰는 startDate=
// '2014-01-01'(신정 공휴일, 실제 첫 거래일이 아님)이 캐시의 실제 첫 거래일
// ('2014-01-02')과 항상 하루 어긋나 있었다 — prefix 분기가 매 실행 1일짜리 빈
// 창을 재조회 시도했고, 이걸 무조건 throw로 처리하던 시절엔 **라이브 신호스캔이
// 단 한 번도 성공할 수 없었다**(실측 확인). 이 정확한 시나리오를 회귀 테스트로 고정.
test('cacheIndexPrices: 연초 공휴일 하루짜리 prefix 어긋남은 throw 없이 통과(2014-01-01 관례값 vs 실제 첫 거래일 2014-01-02 — 2026-09-16 CRITICAL 회귀 가드)', async () => {
  seedKospiCache('2014-01-02', '2026-09-14', [row('2014-01-02', 1000), row('2026-09-14', 6684)]);
  const calls = [];
  const fetchSeries = async (indexName, indexNm, s, e) => {
    calls.push([s, e]);
    if (s === '2014-01-01') return []; // 신정 공휴일 — 실제로 거래일 없음
    return [row('2026-09-15', 6627)];
  };
  const result = await cacheIndexPrices('KOSPI', '2014-01-01', '2026-09-15', { fetchSeries });
  assert.equal(result, 'fetched');
  assert.deepEqual(calls, [['2014-01-01', '2014-01-01'], ['2026-09-15', '2026-09-15']]);
  const cached = JSON.parse(readFileSync(KOSPI_CACHE_PATH, 'utf8'));
  assert.deepEqual(cached.series.map((r) => r.date), ['2014-01-02', '2026-09-14', '2026-09-15']);
  assert.equal(cached.startDate, '2014-01-02'); // 관측된 실제 첫 거래일 그대로(관례값 아님)
});

test('cacheIndexPrices: 소스가 요청구간 일부만 주면(부분응답) throw — "완전 커버"로 조용히 캐시 안 함', async () => {
  seedKospiCache('2020-01-01', '2020-01-10', [row('2020-01-10', 2200)]);
  // 2020-01-11~2020-02-28을 요청했는데 소스가 2020-02-01부터만 준다(앞부분 결측 가정)
  const fetchSeries = async () => [row('2020-02-01', 2300), row('2020-02-28', 2350)];
  await assert.rejects(
    () => cacheIndexPrices('KOSPI', '2020-01-01', '2020-02-28', { fetchSeries }),
    /요청 시작일.*못 덮음/,
  );
  // throw 이후 캐시 파일이 오염(잘못된 endDate로 덮어써짐)되지 않았는지 확인
  const cached = JSON.parse(readFileSync(KOSPI_CACHE_PATH, 'utf8'));
  assert.equal(cached.endDate, '2020-01-10');
});

// 2026-09-16 코드리뷰 CRITICAL/HIGH 지적 재현 사례를 그대로 회귀 테스트로 고정 —
// 원래는 "소스가 빈 배열을 주면 무조건 throw"였는데, 이게 라이브 신호스캔이 매번
// 걸려 넘어지는 실제 사고였다: 모든 호출부가 관례로 쓰는 startDate='2014-01-01'
// (신정 공휴일)이 실제 첫 거래일(2014-01-02)과 하루 어긋나 매 실행마다 1일짜리
// prefix 재조회가 빈 응답으로 돌아왔고, "월요일 2회차 실행"·"연휴 다음 첫 거래일"
// 같은 정상 상황에서도 suffix 요청창에 거래일이 0개일 수 있었다. 작은 요청창
// (COVERAGE_TOLERANCE_DAYS 이내)이 통째로 비면 "그 구간에 거래일 자체가 없었을
// 뿐"으로 보고 통과시키되, 큰 요청창이 비면 여전히 데이터 소스 장애로 throw한다.
test('cacheIndexPrices: 작은 요청창(관용일 이내)이 통째로 비면 throw 안 함 — 연휴·주말처럼 거래일 자체가 없는 정상 상황(2026-09-16 실사고 회귀 가드)', async () => {
  const fetchSeries = async () => [];
  const result = await cacheIndexPrices('KOSPI', '2026-01-01', '2026-01-05', { fetchSeries }); // 4일짜리 창
  assert.equal(result, 'fetched');
  const cached = JSON.parse(readFileSync(KOSPI_CACHE_PATH, 'utf8'));
  assert.deepEqual(cached.series, []); // 병합할 데이터 없음, 하지만 throw는 안 함
});

test('cacheIndexPrices: 큰 요청창(관용일 초과)이 통째로 비면 여전히 throw(진짜 데이터 소스 장애 구분)', async () => {
  const fetchSeries = async () => [];
  await assert.rejects(
    () => cacheIndexPrices('KOSPI', '2026-01-01', '2026-02-01', { fetchSeries }), // 32일짜리 창 — 어떤 연휴도 이만큼 길지 않음
    /조회 결과 0건/,
  );
});

test('cacheIndexPrices: 캐시 로드 후 loadIndexSeries·indexPriceAtOrBefore·indexPricesAt 정상 동작', async () => {
  const fetchSeries = async () => [row('2026-01-05', 2500), row('2026-01-06', 2510)];
  await cacheIndexPrices('KOSPI', '2026-01-05', '2026-01-06', { fetchSeries });
  assert.deepEqual(loadIndexSeries('KOSPI'), { dates: ['2026-01-05', '2026-01-06'], closes: [2500, 2510] });
  assert.equal(indexPriceAtOrBefore('KOSPI', '2026-01-06'), 2510);
  assert.deepEqual(indexPricesAt('KOSPI', ['2026-01-05', '2026-01-06']), { '2026-01-05': 2500, '2026-01-06': 2510 });
});
