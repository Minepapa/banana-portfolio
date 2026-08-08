import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTargetHoldings, computePeriodReturn, simulateWalkForward, extractReturns, cumulativeReturns, countDataGaps,
} from './walk-forward-simulator.mjs';

const rank = (code, r) => ({ Code: code, Name: code, rank: r, ocfToPrice: 0.1 });

test('computeTargetHoldings: 빈 보유에서 시작 — buyRank 이내 전부 신규진입', () => {
  const ranked = [rank('A', 1), rank('B', 10), rank('C', 11)];
  const next = computeTargetHoldings(new Set(), ranked, { buyRank: 10, sellRank: 20 });
  assert.deepEqual([...next].sort(), ['A', 'B']);
});

test('computeTargetHoldings: 보유중이고 sellRank 이내면 유지(버퍼존 — 재진입 조건 재충족 불필요)', () => {
  const ranked = [rank('A', 15)]; // buyRank(10) 밖이지만 sellRank(20) 이내
  const next = computeTargetHoldings(new Set(['A']), ranked, { buyRank: 10, sellRank: 20 });
  assert.deepEqual([...next], ['A']);
});

test('computeTargetHoldings: 보유중인데 sellRank 밖으로 밀리면 제외', () => {
  const ranked = [rank('A', 25)];
  const next = computeTargetHoldings(new Set(['A']), ranked, { buyRank: 10, sellRank: 20 });
  assert.deepEqual([...next], []);
});

test('computeTargetHoldings: 보유중인데 이번 랭킹에 아예 없으면(needsReview) 백테스트는 매도로 단순화', () => {
  const ranked = [rank('B', 1)]; // A는 랭킹에 없음
  const next = computeTargetHoldings(new Set(['A']), ranked, { buyRank: 10, sellRank: 20 });
  assert.deepEqual([...next], ['B']);
});

test('computePeriodReturn: 동일가중 평균 수익률', () => {
  const holdings = new Set(['A', 'B']);
  const prices = { A: { d0: 100, d1: 110 }, B: { d0: 200, d1: 180 } }; // A:+10%, B:-10%
  const r = computePeriodReturn(holdings, prices, 'd0', 'd1');
  assert.ok(Math.abs(r - 0) < 1e-9);
});

test('computePeriodReturn: 가격 결측 종목은 그 구간 계산에서 제외(추정 안 함)', () => {
  const holdings = new Set(['A', 'B']);
  const prices = { A: { d0: 100, d1: 110 }, B: { d0: 200 } }; // B는 d1 가격 없음
  const r = computePeriodReturn(holdings, prices, 'd0', 'd1');
  assert.ok(Math.abs(r - 0.1) < 1e-9); // A만으로 계산
});

test('computePeriodReturn: 보유종목 전부 가격 결측이면 null', () => {
  const r = computePeriodReturn(new Set(['A']), {}, 'd0', 'd1');
  assert.equal(r, null);
});

test('computePeriodReturn: 보유종목이 없으면(빈 포트폴리오) null', () => {
  const r = computePeriodReturn(new Set(), { A: { d0: 100, d1: 110 } }, 'd0', 'd1');
  assert.equal(r, null);
});

// 핵심 성질(룩어헤드 방지) — 이번 시점에 "새로 진입"한 종목은 이번 구간(직전~이번)의
// 수익률에 포함되면 안 된다(아직 사지도 않았던 구간). simulateWalkForward가 순서를
// 지키는지 직접 검증.
test('simulateWalkForward: 신규진입 종목은 진입 시점 이전 구간 수익률에 포함되지 않는다(룩어헤드 방지)', () => {
  const rankingsByDate = {
    '2020-01-01': [rank('A', 1)], // A 신규진입
    '2020-02-01': [rank('A', 1), rank('B', 1)], // B 신규진입 — 이 구간 수익률엔 A만 있어야 함
  };
  const prices = {
    A: { '2020-01-01': 100, '2020-02-01': 110 }, // A: +10%
    B: { '2020-01-01': 9999, '2020-02-01': 1 },  // B: 진입 전 대폭락(이 구간에 반영되면 안 됨)
  };
  const result = simulateWalkForward(rankingsByDate, prices, { buyRank: 10, sellRank: 20 });
  assert.equal(result[0].periodReturn, null); // 첫 시점은 구간 없음
  assert.ok(Math.abs(result[1].periodReturn - 0.1) < 1e-9); // A만의 수익률(+10%), B의 폭락 미반영
  assert.deepEqual(result[0].holdings, ['A']);
  assert.deepEqual(result[1].holdings.sort(), ['A', 'B']);
});

test('simulateWalkForward: 버퍼존 유지가 여러 시점에 걸쳐 정상 작동', () => {
  const rankingsByDate = {
    '2020-01-01': [rank('A', 1)],
    '2020-02-01': [rank('A', 15)], // buyRank 밖이지만 sellRank 이내 — 유지
    '2020-03-01': [rank('A', 25)], // sellRank 밖 — 매도
  };
  const prices = {
    A: { '2020-01-01': 100, '2020-02-01': 110, '2020-03-01': 121 },
  };
  const result = simulateWalkForward(rankingsByDate, prices, { buyRank: 10, sellRank: 20 });
  assert.deepEqual(result[0].holdings, ['A']);
  assert.deepEqual(result[1].holdings, ['A']); // 버퍼존 유지
  assert.deepEqual(result[2].holdings, []); // 매도
  assert.ok(Math.abs(result[2].periodReturn - 0.1) < 1e-9); // 매도되기 전 마지막 구간(2월→3월) 수익은 반영됨
});

test('extractReturns: 첫 시점 null 제외, 나머지 구간수익률만 추출', () => {
  const sim = [{ periodReturn: null }, { periodReturn: 0.05 }, { periodReturn: -0.02 }];
  assert.deepEqual(extractReturns(sim), [0.05, -0.02]);
});

// 회귀테스트(코드리뷰 지적, 2026-08-08) — 현금보유 구간(보유종목 0개)은 "관측 없음"이
// 아니라 진짜 0% 수익이다. 원래는 이 경우도 null로 뭉뚱그려 extractReturns가 드롭했는데,
// 그러면 실제로는 존재했던 "수익률 0%인 달"이 시계열에서 통째로 사라져 Sharpe·DSR
// 계산이 왜곡된다.
test('simulateWalkForward: 보유종목이 아예 없는 구간(현금보유)은 0%로 기록되지 null이 아니다', () => {
  const rankingsByDate = {
    '2020-01-01': [rank('A', 25)], // buyRank(10) 밖이라 아무것도 안 삼(빈 포트폴리오로 시작)
    '2020-02-01': [rank('A', 1)],  // 이제서야 진입
  };
  const prices = { A: { '2020-01-01': 100, '2020-02-01': 110 } };
  const result = simulateWalkForward(rankingsByDate, prices, { buyRank: 10, sellRank: 20 });
  assert.deepEqual(result[0].holdings, []); // 첫 시점부터 보유 없음
  assert.equal(result[1].periodReturn, 0); // null이 아니라 진짜 0%(현금 보유 구간)
  assert.equal(result[1].dataGap, false);
  assert.deepEqual(extractReturns(result), [0]); // 드롭되지 않고 시계열에 포함됨
});

// 회귀테스트 — 보유종목은 있는데 그 종목들의 가격을 못 찾는 "진짜 데이터 결측"은
// 현금보유(0%)와 구분돼야 한다(dataGap:true로 표시, periodReturn은 여전히 null).
test('simulateWalkForward: 보유종목은 있는데 가격을 못 찾으면 dataGap:true + periodReturn null(현금보유와 구분)', () => {
  const rankingsByDate = {
    '2020-01-01': [rank('A', 1)],
    '2020-02-01': [rank('A', 1)],
  };
  const prices = {}; // A의 가격이 아예 캐싱 안 됨(법인코드 매칭 실패 등을 흉내)
  const result = simulateWalkForward(rankingsByDate, prices, { buyRank: 10, sellRank: 20 });
  assert.deepEqual(result[0].holdings, ['A']); // 보유는 함(랭킹엔 있었음)
  assert.equal(result[1].periodReturn, null);
  assert.equal(result[1].dataGap, true);
  assert.equal(countDataGaps(result), 1);
});

test('countDataGaps: dataGap:true인 구간 수만 센다', () => {
  const sim = [{ dataGap: false }, { dataGap: true }, { dataGap: true }, { dataGap: false }];
  assert.equal(countDataGaps(sim), 2);
});

test('cumulativeReturns: 1.0에서 시작해 순차 복리 적용', () => {
  const c = cumulativeReturns([0.1, -0.1]);
  assert.ok(Math.abs(c[0] - 1) < 1e-9);
  assert.ok(Math.abs(c[1] - 1.1) < 1e-9);
  assert.ok(Math.abs(c[2] - 0.99) < 1e-9); // 1.1 * 0.9
});
