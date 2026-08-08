import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findOcfAtOrBefore, cacheOcfHistory, ocfAtOrBefore, ocfAt,
  MAX_ZERO_HISTORY_RATIO, MIN_BATCH_FOR_RATIO_GUARD,
} from './ocf-history-cache.mjs';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'ocf-history');
// 실데이터와 안 겹치는 가짜 corpCode로 테스트 — 끝나면 지운다(실제 캐시 디렉토리를
// 공유하지만 이 접두사를 쓰는 테스트만 건드림).
const cleanup = (corpCodes) => corpCodes.forEach((c) => rmSync(join(CACHE_DIR, `${c}.json`), { force: true }));

const rpt = (disclosureDate, operCf, overrides = {}) => ({ bsnsYear: '2020', reprtCode: '11013', disclosureDate, operCf, ...overrides });

test('findOcfAtOrBefore: targetDate 이하 공시일 중 가장 최근 것 선택', () => {
  const history = [rpt('2020-05-15', 100), rpt('2020-08-14', 200), rpt('2020-11-14', 300)];
  const result = findOcfAtOrBefore(history, '2020-09-01');
  assert.equal(result.operCf, 200); // 8/14 공시가 9/1 시점 최신, 11/14는 아직 미공시
});

test('findOcfAtOrBefore: 정확히 공시일 당일이면 포함(<=)', () => {
  const history = [rpt('2020-05-15', 100)];
  assert.equal(findOcfAtOrBefore(history, '2020-05-15').operCf, 100);
});

test('findOcfAtOrBefore: targetDate 이전 공시가 하나도 없으면 null(추정 안 함 — 룩어헤드 방지)', () => {
  const history = [rpt('2020-05-15', 100)];
  assert.equal(findOcfAtOrBefore(history, '2020-01-01'), null);
});

test('findOcfAtOrBefore: 이력이 없거나 빈 배열이면 null', () => {
  assert.equal(findOcfAtOrBefore([], '2020-01-01'), null);
  assert.equal(findOcfAtOrBefore(undefined, '2020-01-01'), null);
  assert.equal(findOcfAtOrBefore(null, '2020-01-01'), null);
});

test('findOcfAtOrBefore: 정렬 안 된 이력도 정확히 최신 값을 고른다', () => {
  const history = [rpt('2020-11-14', 300), rpt('2020-05-15', 100), rpt('2020-08-14', 200)];
  assert.equal(findOcfAtOrBefore(history, '2020-12-31').operCf, 300);
});

test('MAX_ZERO_HISTORY_RATIO: 상수 확인(0~1 범위)', () => {
  assert.ok(MAX_ZERO_HISTORY_RATIO > 0 && MAX_ZERO_HISTORY_RATIO < 1);
});

// 회귀테스트 — 2026-08-08 코드리뷰 HIGH: 실패율 가드가 트립되기 전에 결과를 이미
// 디스크에 써버려서, 재개 실행이 "이미 캐시됨"으로 오인해 영구히 빈 이력으로 고정되던
// 버그. 이제는 전부 메모리에 모은 뒤 가드를 통과해야만 쓴다 — 실패 시 아무 파일도
// 안 남아야 함을 직접 검증.
test('cacheOcfHistory: 실패율 과다면 예외 던지고 아무 파일도 디스크에 안 남긴다(재개 시 전부 재시도 가능해야 함)', async () => {
  const codes = Array.from({ length: MIN_BATCH_FOR_RATIO_GUARD }, (_, i) => `TEST-ZERO-${i}`);
  cleanup(codes);
  const entries = codes.map((corpCode) => ({ stockCode: corpCode, corpCode }));
  // 전부 빈 이력을 내는 가짜 fetchOne(네트워크 없음) — 100% 실패율
  const fetchOne = async () => [];

  await assert.rejects(
    () => cacheOcfHistory(entries, { fromYear: 2020, toYear: 2020, apiKey: 'x', fetchOne }),
    /비율 과다/,
  );
  for (const c of codes) assert.equal(existsSync(join(CACHE_DIR, `${c}.json`)), false, `${c} 캐시 파일이 남아있으면 안 됨`);
  cleanup(codes);
});

test('cacheOcfHistory: 배치가 minBatchForRatioGuard 미만이면 실패율 100%여도 예외 없이 정상 캐시(소규모 재개 시 오탐 방지)', async () => {
  const codes = ['TEST-SMALL-A'];
  cleanup(codes);
  const entries = codes.map((corpCode) => ({ stockCode: corpCode, corpCode }));
  const fetchOne = async () => []; // 신규상장 등으로 진짜 이력이 없는 정상 케이스를 흉내

  const result = await cacheOcfHistory(entries, { fromYear: 2020, toYear: 2020, apiKey: 'x', fetchOne });
  assert.equal(result.zeroHistory, 1);
  assert.equal(existsSync(join(CACHE_DIR, 'TEST-SMALL-A.json')), true);
  cleanup(codes);
});

test('cacheOcfHistory: 정상 수집 후 파일에 정확히 기록되고, 재실행은 스킵(resumable)', async () => {
  const codes = ['TEST-OK-A', 'TEST-OK-B'];
  cleanup(codes);
  const entries = codes.map((corpCode) => ({ stockCode: corpCode, corpCode }));
  const history = [{ bsnsYear: '2020', reprtCode: '11013', disclosureDate: '2020-05-15', operCf: 12345 }];
  const fetchOne = async () => history;

  const result1 = await cacheOcfHistory(entries, { fromYear: 2020, toYear: 2020, apiKey: 'x', fetchOne });
  assert.deepEqual(result1, { fetched: 2, cached: 0, zeroHistory: 0, total: 2 });
  assert.deepEqual(
    JSON.parse(readFileSync(join(CACHE_DIR, 'TEST-OK-A.json'), 'utf8')),
    { fromYear: 2020, toYear: 2020, history },
  );

  const fetchOneShouldNotBeCalled = async () => { throw new Error('재실행에서 이미 캐시된 항목을 다시 조회함 — resumable 아님'); };
  const result2 = await cacheOcfHistory(entries, { fromYear: 2020, toYear: 2020, apiKey: 'x', fetchOne: fetchOneShouldNotBeCalled });
  assert.deepEqual(result2, { fetched: 0, cached: 2, zeroHistory: 0, total: 2 });

  assert.equal(ocfAtOrBefore('TEST-OK-A', '2020-12-31').operCf, 12345);
  assert.equal(ocfAt(['TEST-OK-A'], ['2020-12-31'])['TEST-OK-A']['2020-12-31'].operCf, 12345);
  cleanup(codes);
});

test('ocfAtOrBefore·ocfAt: targetDate가 "YYYY-MM-DD" 형식이 아니면 즉시 예외', () => {
  assert.throws(() => ocfAtOrBefore('ANY', new Date('2020-01-01')));
  assert.throws(() => ocfAtOrBefore('ANY', '2020/01/01'));
  assert.throws(() => ocfAt(['ANY'], ['2020-1-1']));
});

// 회귀테스트 — 장시간 대량 수집에서 배치 단위로 검증·기록해야, 도중에 실패해도 이미
// 성공한 앞쪽 배치는 안전하게 남는다(2026-08-08, 전체 백테스트 구간 대량 수집을 앞두고
// 추가 — "끝까지 다 모았다가 한 번에 쓰기"였다면 이 시나리오에서 배치1도 같이 날아감).
test('cacheOcfHistory: batchSize로 나누면 앞선 배치는 뒤 배치가 실패해도 디스크에 남는다', async () => {
  const okCodes = Array.from({ length: MIN_BATCH_FOR_RATIO_GUARD }, (_, i) => `TEST-BATCH-OK-${i}`);
  const failCodes = Array.from({ length: MIN_BATCH_FOR_RATIO_GUARD }, (_, i) => `TEST-BATCH-FAIL-${i}`);
  cleanup([...okCodes, ...failCodes]);
  const entries = [...okCodes, ...failCodes].map((corpCode) => ({ stockCode: corpCode, corpCode }));
  const history = [{ bsnsYear: '2020', reprtCode: '11013', disclosureDate: '2020-05-15', operCf: 1 }];
  const fetchOne = async (corpCode) => (corpCode.startsWith('TEST-BATCH-FAIL') ? [] : history);

  await assert.rejects(
    () => cacheOcfHistory(entries, { fromYear: 2020, toYear: 2020, apiKey: 'x', fetchOne, batchSize: MIN_BATCH_FOR_RATIO_GUARD }),
    /비율 과다/,
  );
  for (const c of okCodes) assert.equal(existsSync(join(CACHE_DIR, `${c}.json`)), true, `${c}(첫 배치)는 남아있어야 함`);
  for (const c of failCodes) assert.equal(existsSync(join(CACHE_DIR, `${c}.json`)), false, `${c}(실패 배치)는 안 남아야 함`);
  cleanup([...okCodes, ...failCodes]);
});

test('cacheOcfHistory: entries 항목별 fromYear/toYear가 전역값보다 우선한다', async () => {
  const codes = ['TEST-PERYEAR-A'];
  cleanup(codes);
  const seenRanges = [];
  const fetchOne = async (corpCode, range) => { seenRanges.push(range); return []; };
  await cacheOcfHistory(
    [{ stockCode: 'A', corpCode: 'TEST-PERYEAR-A', fromYear: 2018, toYear: 2019 }],
    { fromYear: 2010, toYear: 2026, apiKey: 'x', fetchOne },
  );
  assert.deepEqual(seenRanges[0], { fromYear: 2018, toYear: 2019 });
  cleanup(codes);
});

// 회귀테스트 — 2026-08-08 실전 발견 버그: 좁은 범위(예: 파일럿 검증용 2023~2025)로
// 먼저 캐싱된 회사가 나중에 더 넓은 범위(예: 전체 백테스트 구간 2014~2026)로 다시
// 요청될 때, 파일 존재 여부만 보면 "이미 캐시됨"으로 오판해 좁은 범위 캐시가 넓은
// 범위 요청을 영구히 가로막는다. 삼성전자가 파일럿(2023~2025)에서 먼저 캐싱된 뒤
// 전체 구간(2014~2026) 수집에서 스킵돼, 2014~2022 재계산 시점에 통째로 랭킹에서
// 빠지는 실제 사고로 발견됨. 이제는 캐시 범위가 요청 범위를 못 덮으면 재수집한다.
test('cacheOcfHistory: 기존 캐시가 좁은 범위면 더 넓은 범위 요청 시 재수집한다(좁은 캐시가 넓은 요청을 막지 않음)', async () => {
  const codes = ['TEST-WIDEN-A'];
  cleanup(codes);
  const narrowHistory = [{ bsnsYear: '2023', reprtCode: '11013', disclosureDate: '2023-05-15', operCf: 1 }];
  const wideHistory = [
    { bsnsYear: '2014', reprtCode: '11013', disclosureDate: '2014-05-15', operCf: 2 },
    ...narrowHistory,
  ];
  let calls = 0;
  const fetchOneNarrow = async () => narrowHistory;
  await cacheOcfHistory(
    [{ stockCode: 'A', corpCode: 'TEST-WIDEN-A', fromYear: 2023, toYear: 2025 }],
    { apiKey: 'x', fetchOne: fetchOneNarrow },
  );
  assert.equal(ocfAtOrBefore('TEST-WIDEN-A', '2020-01-01'), null); // 좁은 캐시엔 2020년 데이터가 없음

  const fetchOneWide = async (corpCode, range) => { calls++; assert.deepEqual(range, { fromYear: 2014, toYear: 2026 }); return wideHistory; };
  const result = await cacheOcfHistory(
    [{ stockCode: 'A', corpCode: 'TEST-WIDEN-A', fromYear: 2014, toYear: 2026 }],
    { apiKey: 'x', fetchOne: fetchOneWide },
  );
  assert.equal(calls, 1, '좁은 캐시가 있어도 재수집이 실제로 일어나야 함');
  assert.equal(result.fetched, 1);
  assert.equal(ocfAtOrBefore('TEST-WIDEN-A', '2020-01-01').operCf, 2); // 이제 2014년 데이터로 커버됨
  cleanup(codes);
});

test('cacheOcfHistory: 기존 캐시가 요청 범위를 이미 덮으면 재수집 없이 스킵한다', async () => {
  const codes = ['TEST-COVERED-A'];
  cleanup(codes);
  const history = [{ bsnsYear: '2020', reprtCode: '11013', disclosureDate: '2020-05-15', operCf: 1 }];
  await cacheOcfHistory(
    [{ stockCode: 'A', corpCode: 'TEST-COVERED-A', fromYear: 2014, toYear: 2026 }],
    { apiKey: 'x', fetchOne: async () => history },
  );
  const shouldNotBeCalled = async () => { throw new Error('이미 넓은 범위로 캐시돼 있는데 재수집함'); };
  const result = await cacheOcfHistory(
    [{ stockCode: 'A', corpCode: 'TEST-COVERED-A', fromYear: 2018, toYear: 2020 }], // 기존 범위(2014-2026) 안에 완전히 포함
    { apiKey: 'x', fetchOne: shouldNotBeCalled },
  );
  assert.equal(result.fetched, 0);
  assert.equal(result.cached, 1);
  cleanup(codes);
});
