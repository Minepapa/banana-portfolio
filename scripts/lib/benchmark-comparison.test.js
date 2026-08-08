import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeExcessReturns, computeInformationRatio, cumulativeExcessReturn, buildComparisonReport,
} from './benchmark-comparison.mjs';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

test('computeExcessReturns: 구간별 전략-벤치마크 차이', () => {
  const excess = computeExcessReturns([0.05, 0.02], [0.02, 0.01]);
  assert.ok(close(excess[0], 0.03));
  assert.ok(close(excess[1], 0.01));
});

test('computeExcessReturns: 길이가 다르면 null(추정 안 함)', () => {
  assert.equal(computeExcessReturns([0.01], [0.01, 0.02]), null);
});

test('computeExcessReturns: 둘 중 하나라도 없으면 null', () => {
  assert.equal(computeExcessReturns(null, [0.01]), null);
  assert.equal(computeExcessReturns([0.01], undefined), null);
});

test('computeInformationRatio: 손계산 대조', () => {
  const excess = [0.03, 0.01, -0.01, 0.02];
  const ir = computeInformationRatio(excess, { periodsPerYear: 12 });
  assert.ok(close(ir, 2.535462764185549, 1e-9));
});

test('computeInformationRatio: 표본 2개 미만이면 null', () => {
  assert.equal(computeInformationRatio([0.01]), null);
  assert.equal(computeInformationRatio([]), null);
});

test('computeInformationRatio: 초과수익 분산이 0이면(전략이 벤치마크와 항상 동일) null', () => {
  assert.equal(computeInformationRatio([0.01, 0.01, 0.01]), null);
});

test('computeInformationRatio: NaN·Infinity가 섞여 있으면 null(추정 안 함)', () => {
  assert.equal(computeInformationRatio([0.01, NaN, 0.02]), null);
  assert.equal(computeInformationRatio([0.01, Infinity, 0.02]), null);
});

test('cumulativeExcessReturn: 산술 합산', () => {
  assert.ok(close(cumulativeExcessReturn([0.03, 0.01, -0.01, 0.02]), 0.05));
});

test('buildComparisonReport: 전략·벤치마크 Sharpe·정보비율·누적초과수익을 전부 담되 통과판정은 안 함', () => {
  const strat = [0.05, 0.02, -0.01, 0.03];
  const bench = [0.02, 0.01, 0.00, 0.01];
  const report = buildComparisonReport(strat, bench, { periodsPerYear: 12 });
  assert.equal(report.periodCount, 4);
  assert.ok(close(report.cumulativeExcessReturn, 0.05));
  assert.ok(close(report.informationRatio, 2.535462764185549, 1e-9));
  assert.ok(close(report.strategySharpe, 3.1176914536239786, 1e-9));
  assert.ok(close(report.benchmarkSharpe, 4.242640687119285, 1e-9));
  assert.ok(!('pass' in report) && !('통과' in report)); // 판정 필드 자체가 없어야 함(판단 하드코딩 금지)
});

test('buildComparisonReport: 길이가 안 맞으면 null', () => {
  assert.equal(buildComparisonReport([0.01], [0.01, 0.02]), null);
});

test('buildComparisonReport: 빈 배열이면 null(NaN을 그대로 흘려보내지 않음)', () => {
  assert.equal(buildComparisonReport([], []), null);
});

// 전략이 벤치마크와 매 구간 완전히 동일한 경우 — informationRatio는 null(분산 0)이지만
// Sharpe는 둘 다 정상 계산되고 서로 같아야 함, 누적초과수익은 정확히 0이어야 함
// (코드리뷰 지적, 2026-08-08 — 가장 헷갈리기 쉬운 축퇴 케이스인데 테스트가 없었음).
test('buildComparisonReport: 전략이 벤치마크와 완전히 동일하면 IR은 null이지만 나머지는 정합적으로 나온다', () => {
  const same = [0.02, 0.01, 0.03];
  const report = buildComparisonReport(same, same, { periodsPerYear: 12 });
  assert.equal(report.informationRatio, null);
  assert.ok(close(report.cumulativeExcessReturn, 0));
  assert.ok(close(report.meanExcessReturn, 0));
  assert.equal(report.strategySharpe, report.benchmarkSharpe);
});
