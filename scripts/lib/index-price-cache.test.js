import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cacheIndexPrices, loadIndexSeries, indexPriceAtOrBefore, indexPricesAt,
} from './index-price-cache.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '..', '.cache', 'index-prices');
const KOSPI_CACHE_PATH = join(CACHE_DIR, 'KOSPI.json');

function row(date, close) { return { date, close }; }

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

test('cacheIndexPrices: 소스가 빈 배열을 주면 throw(데이터 소스 장애 의심)', async () => {
  const fetchSeries = async () => [];
  await assert.rejects(() => cacheIndexPrices('KOSPI', '2026-01-01', '2026-01-05', { fetchSeries }), /조회 결과 0건/);
});

test('cacheIndexPrices: 캐시 로드 후 loadIndexSeries·indexPriceAtOrBefore·indexPricesAt 정상 동작', async () => {
  const fetchSeries = async () => [row('2026-01-05', 2500), row('2026-01-06', 2510)];
  await cacheIndexPrices('KOSPI', '2026-01-05', '2026-01-06', { fetchSeries });
  assert.deepEqual(loadIndexSeries('KOSPI'), { dates: ['2026-01-05', '2026-01-06'], closes: [2500, 2510] });
  assert.equal(indexPriceAtOrBefore('KOSPI', '2026-01-06'), 2510);
  assert.deepEqual(indexPricesAt('KOSPI', ['2026-01-05', '2026-01-06']), { '2026-01-05': 2500, '2026-01-06': 2510 });
});
