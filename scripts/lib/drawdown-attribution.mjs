// 최대낙폭 구간 종목별 기여도 분석 — 순수함수(Phase 10 진단 전용, 카이로스 요청
// 2026-08-09). "OCF/P 전략의 MDD가 벤치마크보다 나쁜 게 소수 밸류트랩 종목 때문인지,
// 전반적 하락 때문인지" 분리 진단용 — 새 판단·필터가 아니라 이미 나온 백테스트 결과를
// 뜯어보는 사후분석이다.

// cumulativeReturns: walk-forward-simulator.mjs cumulativeReturns() 결과(1.0=원금 시작).
// 최대낙폭 구간(고점→저점)을 찾는다 — stats.mjs maxDrawdown()은 낙폭 크기(비율)만 내고
// "어느 구간이었는지"는 안 내서 이 함수로 보완. 인덱스는 cumulativeReturns 배열 기준
// (즉 cumulativeReturns[0]=1.0 시작점 포함).
export function findMaxDrawdownWindow(cumulativeReturns) {
  let peakIdx = 0, peakVal = cumulativeReturns[0];
  let worstDD = 0, worstPeakIdx = 0, worstTroughIdx = 0;
  for (let i = 0; i < cumulativeReturns.length; i++) {
    if (cumulativeReturns[i] > peakVal) { peakVal = cumulativeReturns[i]; peakIdx = i; }
    const dd = peakVal > 0 ? (peakVal - cumulativeReturns[i]) / peakVal : 0;
    if (dd > worstDD) { worstDD = dd; worstPeakIdx = peakIdx; worstTroughIdx = i; }
  }
  return { peakIndex: worstPeakIdx, troughIndex: worstTroughIdx, drawdown: worstDD };
}

// simulationResult: walk-forward-simulator.mjs simulateWalkForward() 결과 그대로
// ([{date, holdings, periodReturn}, ...]). pricesByCode: historical-universe.mjs
// fetchPricesAt() 결과와 같은 모양. windowStart/windowEnd: simulationResult 인덱스
// (findMaxDrawdownWindow가 낸 peakIndex/troughIndex를 그대로 씀).
//
// 낙폭구간 동안 실제로 보유했던 각 종목의 그 구간 내 누적수익률(보유했던 개월만 복리) —
// 가장 많이 깎아먹은 순(낮은 수익률 순)으로 정렬. 가격 결측 구간은 그 구간만 제외
// (추정 안 함, computePeriodReturn과 동일 원칙).
export function computeDrawdownContributions(simulationResult, pricesByCode, windowStart, windowEnd) {
  const byCode = new Map();
  for (let i = windowStart + 1; i <= windowEnd; i++) {
    const fromDate = simulationResult[i - 1].date;
    const toDate = simulationResult[i].date;
    // i번째 구간(fromDate~toDate) 동안 보유했던 종목 = 직전 리밸런싱(i-1 시점)에서
    // 확정된 holdings(simulateWalkForward의 "이번 구간 수익률은 직전 확정 보유로
    // 계산" 순서와 동일 원칙).
    for (const code of simulationResult[i - 1].holdings) {
      const p0 = pricesByCode[code]?.[fromDate];
      const p1 = pricesByCode[code]?.[toDate];
      if (p0 == null || p1 == null || !(p0 > 0)) continue;
      const r = (p1 - p0) / p0;
      const entry = byCode.get(code) ?? { code, monthsHeld: 0, cumulativeReturn: 1 };
      entry.monthsHeld += 1;
      entry.cumulativeReturn *= (1 + r);
      byCode.set(code, entry);
    }
  }
  return [...byCode.values()]
    .map((e) => ({ ...e, cumulativeReturn: e.cumulativeReturn - 1 }))
    .sort((a, b) => a.cumulativeReturn - b.cumulativeReturn);
}
