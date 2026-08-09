// 시가총액 순위 — 순수함수(Phase 10 진단 전용, 카이로스 요청 2026-08-09). OCF/P
// 전략의 백테스트 열위가 "동일가중 10종목 vs 시총가중 지수" 구조 자체 때문인지,
// 아니면 OCF/P 팩터 선택 자체 때문인지 분리 진단하기 위한 대조군 — 새 투자전략
// 후보가 아니라 원인 분해용 중립 벤치마크다(§8 원칙: "새 조합 시도"가 아니라
// "같은 팩터에 대한 분해 분석").
//
// quant-factor.mjs의 rankByOcfToPrice와 같은 모양({Code,...,rank})을 내서
// walk-forward-simulator.mjs의 computeTargetHoldings에 그대로 꽂을 수 있다 — 시뮬레이션
// 로직 자체는 재사용, 순위 기준(OCF/P 대신 Marcap)만 다르다.
export function rankByMarketCap(candidates) {
  const withMarcap = candidates.filter((c) => c.Marcap > 0);
  withMarcap.sort((a, b) => b.Marcap - a.Marcap);
  return withMarcap.map((c, i) => ({ ...c, rank: i + 1 }));
}
