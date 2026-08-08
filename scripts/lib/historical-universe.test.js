import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePointInTimeUniverse } from './historical-universe.mjs';

const candidate = (overrides) => ({
  code: 'X', name: '테스트', market: 'KOSPI', sharesOutstanding: 100,
  listingDate: null, delistingDate: null, ...overrides,
});

// Date 객체나 형식이 다른 문자열을 넘기면 조용히 빈 유니버스가 나오는 게 아니라
// 시끄럽게 실패해야 한다(코드리뷰 지적, 2026-08-08 — Python이 돌려준 키와 안 맞는
// 형태를 넘기면 매칭 자체가 안 돼 [] 가 나오는데 그게 "정상"처럼 보이면 위험).
test('computePointInTimeUniverse: targetDate가 "YYYY-MM-DD" 형식이 아니면 즉시 예외(조용한 빈 결과 방지)', () => {
  const pool = [candidate({ code: 'A' })];
  const prices = { A: { '2020-01-01': 100 } };
  assert.throws(() => computePointInTimeUniverse(pool, prices, new Date('2020-01-01')));
  assert.throws(() => computePointInTimeUniverse(pool, prices, '2020/01/01'));
  assert.throws(() => computePointInTimeUniverse(pool, prices, '2020-1-1'));
});

test('computePointInTimeUniverse: 시가총액 = price * sharesOutstanding', () => {
  const pool = [candidate({ code: 'A', sharesOutstanding: 1000 })];
  const prices = { A: { '2020-01-01': 500 } };
  const out = computePointInTimeUniverse(pool, prices, '2020-01-01');
  assert.equal(out[0].marcap, 500_000);
});

test('computePointInTimeUniverse: 그 날짜에 가격이 없으면(null) 제외 — 추정 안 함', () => {
  const pool = [candidate({ code: 'A' }), candidate({ code: 'B' })];
  const prices = { A: { '2020-01-01': 100 }, B: { '2020-01-01': null } };
  const out = computePointInTimeUniverse(pool, prices, '2020-01-01');
  assert.deepEqual(out.map((c) => c.code), ['A']);
});

test('computePointInTimeUniverse: pricesByCode에 그 코드 자체가 없어도(캐싱 안 됨) 제외', () => {
  const pool = [candidate({ code: 'A' })];
  const out = computePointInTimeUniverse(pool, {}, '2020-01-01');
  assert.deepEqual(out, []);
});

test('computePointInTimeUniverse: 상장일이 기준일보다 나중이면 제외(미래 상장)', () => {
  const pool = [candidate({ code: 'A', listingDate: '2021-01-01' })];
  const prices = { A: { '2020-01-01': 100 } };
  assert.deepEqual(computePointInTimeUniverse(pool, prices, '2020-01-01'), []);
});

test('computePointInTimeUniverse: 상장일이 기준일과 같거나 이전이면 포함', () => {
  const pool = [candidate({ code: 'A', listingDate: '2020-01-01' })];
  const prices = { A: { '2020-01-01': 100 } };
  assert.equal(computePointInTimeUniverse(pool, prices, '2020-01-01').length, 1);
});

test('computePointInTimeUniverse: 상장폐지일이 기준일과 같거나 이전이면 제외(경계값 포함 — 그날 이미 폐지)', () => {
  const pool = [candidate({ code: 'A', delistingDate: '2020-01-01' })];
  const prices = { A: { '2020-01-01': 100 } };
  assert.deepEqual(computePointInTimeUniverse(pool, prices, '2020-01-01'), []);
});

test('computePointInTimeUniverse: 상장폐지일이 기준일보다 나중이면 포함(아직 살아있음)', () => {
  const pool = [candidate({ code: 'A', delistingDate: '2020-01-02' })];
  const prices = { A: { '2020-01-01': 100 } };
  assert.equal(computePointInTimeUniverse(pool, prices, '2020-01-01').length, 1);
});

test('computePointInTimeUniverse: 시가총액 내림차순 정렬 + 시장별 상위 N개만', () => {
  const pool = [
    candidate({ code: 'A' }), candidate({ code: 'B' }), candidate({ code: 'C' }),
  ];
  const prices = { A: { '2020-01-01': 10 }, B: { '2020-01-01': 30 }, C: { '2020-01-01': 20 } };
  const out = computePointInTimeUniverse(pool, prices, '2020-01-01', { nKospi: 2, nKosdaq: 0 });
  assert.deepEqual(out.map((c) => c.code), ['B', 'C']); // 30 > 20 > 10, 상위 2개만
});

test('computePointInTimeUniverse: 시장별로 독립적으로 순위·상한 적용(코스피·코스닥 안 섞임)', () => {
  const pool = [
    candidate({ code: 'K1', market: 'KOSPI' }), candidate({ code: 'K2', market: 'KOSPI' }),
    candidate({ code: 'D1', market: 'KOSDAQ' }),
  ];
  const prices = { K1: { '2020-01-01': 100 }, K2: { '2020-01-01': 200 }, D1: { '2020-01-01': 50 } };
  const out = computePointInTimeUniverse(pool, prices, '2020-01-01', { nKospi: 1, nKosdaq: 5 });
  // 코스피는 상위 1개(K2)만, 코스닥은 D1 하나뿐이라 그대로 포함
  assert.deepEqual(out.map((c) => c.code).sort(), ['D1', 'K2']);
});
