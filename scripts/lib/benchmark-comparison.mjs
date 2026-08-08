// 벤치마크 대비 상대비교 — 순수함수(구현계획서 Phase 10). DSR은 N(실제로 시도해본
// 전략 변형 수)≥2가 있어야 수학적으로 계산 가능한데, 지금까지 OCF/P 단일팩터(N=1)만
// 실제로 연구·구현했다(오너 확정, 2026-08-08) — MSCI 3지표 조합 등을 "N을 맞추려고"
// 억지로 구현하지 않는다(§8 근거없는 임의 조합 금지 원칙과 정합 — 실제 연구 이력을
// 부풀리는 게 아니라 있는 그대로 반영). 그래서 구현계획서 원래 통과판정 기준
// ("벤치마크 대비 상대비교, 절대숫자 금지")을 그대로 쓴다.
//
// 이 파일은 비교 사실만 계산한다 — "이 정도면 통과"라는 임계치는 여기 없다(판단
// 하드코딩 금지 원칙, feedback-no-hardcoded-judgment). 반환하는 사실들을 LLM(Zeus/
// Themis)+오너가 종합 판단해 통과/재검토를 결정한다.
import { mean, sampleVariance, sharpeRatio } from './stats.mjs';

// strategyReturns·benchmarkReturns: 같은 기간·같은 개수(구간별로 정확히 대응)의 수익률
// 배열 — 호출측이 날짜 정렬을 맞춰서 넘겨야 함(이 함수는 날짜를 모름). 길이가 다르면
// null(추정 안 함).
export function computeExcessReturns(strategyReturns, benchmarkReturns) {
  if (!strategyReturns || !benchmarkReturns || strategyReturns.length !== benchmarkReturns.length) return null;
  return strategyReturns.map((r, i) => r - benchmarkReturns[i]);
}

// 정보비율(Information Ratio) = 초과수익 평균 / 초과수익 표준편차(연율화 옵션).
// 표본 2개 미만이거나 초과수익 분산이 0(전략이 벤치마크와 항상 완전히 같은 움직임)
// 이면 null.
export function computeInformationRatio(excessReturns, { periodsPerYear = 1 } = {}) {
  if (!excessReturns || excessReturns.length < 2) return null;
  const m = mean(excessReturns);
  const v = sampleVariance(excessReturns);
  if (v == null || !(v > 0)) return null;
  return (m / Math.sqrt(v)) * Math.sqrt(periodsPerYear);
}

// 누적 초과수익(단순 합산 — 복리 아닌 산술 근사, "대략 얼마나 앞섰는지" 직관적 지표).
// 정확한 복리 누적수익은 이 함수의 범위 밖 — walk-forward-simulator.mjs의
// cumulativeReturns(strategyReturns)·cumulativeReturns(benchmarkReturns)를 각각
// 따로 호출해서 비교할 것(이 리포트 객체 자체엔 그 필드가 없음 — 코드리뷰 지적,
// 2026-08-08: 주석이 "strategyCumulative를 따로 볼 것"이라면서 그 필드가 실제로는
// 어디에도 없어 안내가 허공에 뜬 상태였음).
export function cumulativeExcessReturn(excessReturns) {
  return excessReturns.reduce((s, r) => s + r, 0);
}

// 전략·벤치마크 수익률 시계열(같은 기간, 같은 주기)을 받아 상대비교 사실 묶음을
// 낸다 — 통과/실패 판정 없이 숫자만. periodsPerYear: 수익률 주기(월간이면 12).
// 구간이 0개면(빈 배열) null — mean([])이 0/0=NaN을 내는데 이 모듈은 "추정 안 함"
// 원칙상 NaN을 그대로 흘려보내면 안 된다(코드리뷰 지적, 2026-08-08 — JSON.stringify를
// 거치면 NaN이 null로 조용히 바뀌어 버그가 가려지는데, 메모리 상 객체를 직접 쓰는
// 호출측엔 NaN이 그대로 노출돼 있었음).
export function buildComparisonReport(strategyReturns, benchmarkReturns, { periodsPerYear = 12 } = {}) {
  const excess = computeExcessReturns(strategyReturns, benchmarkReturns);
  if (excess == null || !excess.length) return null;
  return {
    periodCount: excess.length,
    cumulativeExcessReturn: cumulativeExcessReturn(excess),
    meanExcessReturn: mean(excess),
    informationRatio: computeInformationRatio(excess, { periodsPerYear }),
    strategySharpe: sharpeRatio(strategyReturns, { periodsPerYear }),
    benchmarkSharpe: sharpeRatio(benchmarkReturns, { periodsPerYear }),
  };
}
