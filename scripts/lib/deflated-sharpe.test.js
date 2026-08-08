import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSR0, computeDeflatedSharpeRatio } from './deflated-sharpe.mjs';
import { sharpeRatio, skewness, kurtosis } from './stats.mjs';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

test('computeSR0: 시도 5개 — 손계산 대조', () => {
  const sr0 = computeSR0([0.3, 0.5, 0.8, 0.2, 0.6]);
  assert.ok(close(sr0, 0.2847279153825815, 1e-9));
});

test('computeSR0: 시도 1개 이하 또는 빈 배열이면 null(분산·"선택" 자체가 정의 안 됨)', () => {
  assert.equal(computeSR0([0.5]), null);
  assert.equal(computeSR0([]), null);
  assert.equal(computeSR0(undefined), null);
});

test('computeSR0: 시도 횟수가 많을수록(같은 분산대라면) 대체로 커진다 — "운으로 나올 수 있는 최댓값"이 커지는 방향', () => {
  const few = computeSR0([0.1, -0.1, 0.2, -0.2, 0.15]);
  const many = computeSR0(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.1 : -0.1) + (i % 5) * 0.02));
  assert.ok(many > few, `many(${many}) should exceed few(${few})`);
});

test('computeDeflatedSharpeRatio: 관측 Sharpe가 SR0보다 훨씬 크면 DSR은 1에 가깝다(확신)', () => {
  const dsr = computeDeflatedSharpeRatio({
    sharpeRatio: 3.0, sampleSize: 60, skewness: 0, kurtosis: 3,
    trialSharpeRatios: [0.3, 0.5, 0.8, 0.2, 0.6],
  });
  assert.ok(dsr > 0.999);
});

test('computeDeflatedSharpeRatio: 관측 Sharpe가 낮으면 DSR도 낮다(회의적)', () => {
  const dsr = computeDeflatedSharpeRatio({
    sharpeRatio: 0.1, sampleSize: 60, skewness: 0, kurtosis: 3,
    trialSharpeRatios: [0.3, 0.5, 0.8, 0.2, 0.6],
  });
  assert.ok(close(dsr, 0.07847743674262597, 1e-9));
});

test('computeDeflatedSharpeRatio: 항상 0~1 확률 범위(Sharpe 값이 아님)', () => {
  for (const sr of [-2, -0.5, 0, 0.5, 1, 2, 5]) {
    const dsr = computeDeflatedSharpeRatio({
      sharpeRatio: sr, sampleSize: 60, skewness: 0.3, kurtosis: 4,
      trialSharpeRatios: [0.1, 0.2, 0.3, 0.4],
    });
    assert.ok(dsr >= 0 && dsr <= 1, `sr=${sr} → dsr=${dsr}`);
  }
});

// 핵심 성질(선택편향 보정의 존재 이유) — 같은 관측 Sharpe·같은 표본이어도 "몇 개 시도해서
// 이걸 골랐는지"가 늘어나면 DSR은 낮아져야 한다(더 많이 시도할수록 순전히 운으로도 좋은
// 결과가 나올 여지가 커지므로 더 회의적으로 판정).
test('computeDeflatedSharpeRatio: 같은 조건에서 시도횟수(N)가 늘면 DSR은 낮아진다(선택편향 보정)', () => {
  const fewTrials = [0.3, 0.5, 0.8, 0.2, 0.6];
  const manyTrials = [...fewTrials, 0.9, 0.85, 0.95, 0.75, 0.88, 0.92, 0.7, 0.65, 0.55, 0.45, 0.4, 0.35, 0.25, 0.15, 0.1, 1.0, 0.05];
  const dsrFew = computeDeflatedSharpeRatio({ sharpeRatio: 1.0, sampleSize: 60, skewness: 0, kurtosis: 3, trialSharpeRatios: fewTrials });
  const dsrMany = computeDeflatedSharpeRatio({ sharpeRatio: 1.0, sampleSize: 60, skewness: 0, kurtosis: 3, trialSharpeRatios: manyTrials });
  assert.ok(dsrMany < dsrFew, `dsrMany(${dsrMany}) should be less than dsrFew(${dsrFew})`);
});

// 왜도·첨도 항이 실제로 부호·계수까지 반영되는지 — 0~1 범위 체크만으로는 계수 자체가
// 틀려도(부호는 맞는데 크기가 틀린 경우) 못 잡는다(코드리뷰 지적, 2026-08-08). 왜도≠0·
// 첨도≠3인 손계산값을 정확히 고정한다.
test('computeDeflatedSharpeRatio: 왜도·첨도가 0/3이 아닌 경우도 정확한 값으로 고정(범위 체크만으론 계수 오류를 못 잡음)', () => {
  const dsr = computeDeflatedSharpeRatio({
    sharpeRatio: 1.2, sampleSize: 48, skewness: 0.3, kurtosis: 5,
    trialSharpeRatios: [0.3, 0.5, 0.8, 0.2, 0.6],
  });
  assert.ok(close(dsr, 0.9999932122146241, 1e-9));
});

// 계약(연구·코드리뷰에서 확인된 가장 흔한 실수) — sharpeRatio가 연율화됐는데 sampleSize는
// 기간당 관측치 그대로면 DSR이 "부정확하게 낙관적"으로 나온다. 실제 수익률 배열로
// stats.sharpeRatio()를 거쳐 computeDeflatedSharpeRatio에 넣는 전체 배선을 통합테스트로
// 고정 — periodsPerYear:1(기간당)이 올바른 사용법이고, 연율화 값을 그대로 섞으면 다른
// (더 낙관적인) 결과가 나온다는 것 자체를 회귀로 남긴다.
test('computeDeflatedSharpeRatio 통합: 연율화 SR을 기간당 sampleSize와 섞으면(계약 위반) DSR이 부정확하게 낙관적으로 나온다', () => {
  const returns = [0.02, -0.01, 0.03, 0.01, -0.005, 0.015, 0.02, -0.01, 0.005, 0.01, 0.02, -0.005];
  const trialReturns = [
    returns,
    [0.01, -0.02, 0.015, 0.01, 0.005, -0.01, 0.02, 0.01, -0.005, 0.015, 0.01, 0.005],
    [0.005, 0.01, -0.01, 0.02, 0.01, -0.005, 0.015, 0.01, 0.02, -0.01, 0.005, 0.01],
  ];
  const perPeriodSRs = trialReturns.map((r) => sharpeRatio(r, { periodsPerYear: 1 }));
  const annualizedSRs = trialReturns.map((r) => sharpeRatio(r, { periodsPerYear: 12 }));

  const correctDsr = computeDeflatedSharpeRatio({
    sharpeRatio: perPeriodSRs[0], sampleSize: returns.length,
    skewness: skewness(returns), kurtosis: kurtosis(returns), trialSharpeRatios: perPeriodSRs,
  });
  const wrongDsr = computeDeflatedSharpeRatio({
    sharpeRatio: annualizedSRs[0], sampleSize: returns.length, // 주기 불일치: 연율화 SR + 기간당 T
    skewness: skewness(returns), kurtosis: kurtosis(returns), trialSharpeRatios: annualizedSRs,
  });

  assert.ok(close(correctDsr, 0.9548000379508916, 1e-9));
  assert.ok(wrongDsr > correctDsr, `wrongDsr(${wrongDsr})가 correctDsr(${correctDsr})보다 낙관적으로 높아야 계약위반 사례가 성립`);
});

test('computeDeflatedSharpeRatio: sampleSize가 1 이하면 null', () => {
  assert.equal(computeDeflatedSharpeRatio({
    sharpeRatio: 1, sampleSize: 1, skewness: 0, kurtosis: 3, trialSharpeRatios: [0.1, 0.2],
  }), null);
});

test('computeDeflatedSharpeRatio: 시도 이력이 없으면(N<2) null — SR0를 추정하지 않음', () => {
  assert.equal(computeDeflatedSharpeRatio({
    sharpeRatio: 1, sampleSize: 60, skewness: 0, kurtosis: 3, trialSharpeRatios: [0.5],
  }), null);
});

test('computeDeflatedSharpeRatio: 왜도·첨도 항이 음수로 튀어 분산 계산이 안 되면(비정상 입력) null', () => {
  // 극단적 왜도·SR 조합으로 (1 - skew*SR + ((kurt-1)/4)*SR²)가 음수가 되는 경우
  // (kurtosis=1 → 첨도항이 0이 돼 왜도항만으로도 음수를 만들 수 있음: 1 - 5*10 + 0 = -49)
  const dsr = computeDeflatedSharpeRatio({
    sharpeRatio: 10, sampleSize: 60, skewness: 5, kurtosis: 1, trialSharpeRatios: [0.1, 0.2],
  });
  assert.equal(dsr, null);
});
