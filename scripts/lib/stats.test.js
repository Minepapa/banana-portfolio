import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mean, sampleVariance, skewness, kurtosis, standardNormalCdf, standardNormalInvCdf,
  sharpeRatio, maxDrawdown, annualizedReturn,
} from './stats.mjs';

const close = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

test('mean·sampleVariance: 기본 계산', () => {
  assert.equal(mean([1, 2, 3, 4, 5]), 3);
  assert.equal(sampleVariance([1, 2, 3, 4, 5]), 2.5);
});

test('sampleVariance: 표본 1개 이하면 null(분산 정의 불가)', () => {
  assert.equal(sampleVariance([1]), null);
  assert.equal(sampleVariance([]), null);
});

test('skewness: 대칭 데이터는 0', () => {
  assert.equal(skewness([1, 2, 3, 4, 5]), 0);
});

test('skewness: 오른쪽 꼬리(우측 이상치)면 양수', () => {
  const s = skewness([1, 2, 3, 4, 10]);
  assert.ok(close(s, 1.1384199576606167, 1e-9));
});

// 비초과(non-excess) 컨벤션 검증 — 손계산: [1,2,3,4,5] 편차 -2,-1,0,1,2, m2=2, m4=6.8,
// kurtosis=m4/m2²=6.8/4=1.7 (초과첨도 컨벤션이었다면 1.7-3=-1.3이 나왔을 것 — 부호까지
// 다른 값이라 컨벤션을 틀리면 테스트가 바로 잡아낸다).
test('kurtosis: 비초과(non-excess) 컨벤션 — 정규분포면 3.0에 가까워야 함, 손계산 사례로 고정', () => {
  assert.equal(kurtosis([1, 2, 3, 4, 5]), 1.7);
});

test('kurtosis·skewness: 표본 1개 이하 또는 분산 0이면 null', () => {
  assert.equal(kurtosis([5]), null);
  assert.equal(kurtosis([5, 5, 5]), null); // 분산 0 — m2=0
  assert.equal(skewness([5, 5, 5]), null);
});

test('standardNormalCdf: 표준정규분포표 대조(Φ(0)=0.5, Φ(1.96)≈0.975, Φ(-1.96)≈0.025) — A&S 7.1.26 오차한계(1.5e-7) 대비 넉넉한 허용치', () => {
  assert.ok(close(standardNormalCdf(0), 0.5, 1e-6));
  assert.ok(close(standardNormalCdf(1.959964), 0.975, 1e-6));
  assert.ok(close(standardNormalCdf(-1.959964), 0.025, 1e-6));
});

test('standardNormalInvCdf: 표준정규분포표 대조(분위함수) — Acklam 알고리즘, 오차 ~1e-9', () => {
  assert.ok(close(standardNormalInvCdf(0.5), 0, 1e-8));
  assert.ok(close(standardNormalInvCdf(0.975), 1.9599639845400545, 1e-8));
  assert.ok(close(standardNormalInvCdf(0.025), -1.9599639845400545, 1e-8));
  assert.ok(close(standardNormalInvCdf(0.995), 2.5758293035489004, 1e-8));
  assert.ok(close(standardNormalInvCdf(0.1), -1.2815515655446004, 1e-8));
});

test('standardNormalInvCdf: p가 (0,1) 밖이면 null(추정하지 않음)', () => {
  assert.equal(standardNormalInvCdf(0), null);
  assert.equal(standardNormalInvCdf(1), null);
  assert.equal(standardNormalInvCdf(-0.1), null);
  assert.equal(standardNormalInvCdf(1.1), null);
});

test('standardNormalCdf·standardNormalInvCdf: 서로 역함수 관계(왕복 일치)', () => {
  for (const p of [0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
    const x = standardNormalInvCdf(p);
    assert.ok(close(standardNormalCdf(x), p, 1e-6), `p=${p}`);
  }
});

test('sharpeRatio: 연율화(월간 12) — 손계산 검증', () => {
  const sr = sharpeRatio([0.01, 0.02, -0.01, 0.03, 0.00], { riskFreeRate: 0, periodsPerYear: 12 });
  assert.ok(close(sr, 2.190890230020664, 1e-9));
});

test('sharpeRatio: 무위험수익률 차감 후 계산(초과수익 기준)', () => {
  const withRf = sharpeRatio([0.02, 0.02, 0.02], { riskFreeRate: 0.01, periodsPerYear: 12 });
  // 초과수익이 전부 0.01로 동일 → 분산 0 → null(0으로 나누기 방지, 추정 안 함)
  assert.equal(withRf, null);
});

test('sharpeRatio: 표본 2개 미만이면 null', () => {
  assert.equal(sharpeRatio([0.01]), null);
});

test('maxDrawdown: 고점 대비 최대 하락폭', () => {
  const mdd = maxDrawdown([1, 1.1, 1.05, 0.9, 1.2]);
  assert.ok(close(mdd, 0.18181818181818185, 1e-9)); // 고점 1.1 → 저점 0.9
});

test('maxDrawdown: 계속 상승만 하면 0', () => {
  assert.equal(maxDrawdown([1, 1.1, 1.2, 1.3]), 0);
});

test('annualizedReturn: CAGR 손계산 검증', () => {
  const cagr = annualizedReturn([1, 1.5], 2);
  assert.ok(close(cagr, 0.22474487139158894, 1e-9));
});

test('annualizedReturn: years가 0 이하거나 배열이 비어있으면 null', () => {
  assert.equal(annualizedReturn([1, 1.5], 0), null);
  assert.equal(annualizedReturn([], 1), null);
});
