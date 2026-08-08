// 백테스트 성적표용 기초 통계 — 순수 함수(구현계획서 Phase 10). Deflated Sharpe Ratio가
// 요구하는 정확한 컨벤션(비초과 첨도 등)에 맞춰 여기서부터 확실히 잡아둔다 — scipy/pandas
// 기본값과 다른 컨벤션이 섞이면 DSR이 조용히 틀어진다(연구 검증 결과, 2026-08-08:
// Bailey & López de Prado 2014 원 논문 cross-check 완료, quantstrat R 구현과 대조).

export function mean(xs) {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

// 표본분산(n-1 분모) — 여러 시도(trial)의 Sharpe 값처럼 "표본에서 모수를 추정"하는
// 상황에 맞는 컨벤션(DSR의 V[{ŜR_n}]와 동일 성격).
export function sampleVariance(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const ss = xs.reduce((s, x) => s + (x - m) ** 2, 0);
  return ss / (xs.length - 1);
}

// 왜도(skewness) — 적률비(모멘트) 방식, 모집단(n 분모) 컨벤션. γ̂₃ 표기 자체가 추정 방식을
// 못 박지 않아(연구 결과) 가장 단순·투명한 정의를 택하고 여기 명시한다.
export function skewness(xs) {
  const n = xs.length;
  if (n < 2) return null;
  const m = mean(xs);
  const m2 = xs.reduce((s, x) => s + (x - m) ** 2, 0) / n;
  const m3 = xs.reduce((s, x) => s + (x - m) ** 3, 0) / n;
  if (m2 === 0) return null; // 분산 0(전부 같은 값) — 왜도 정의 불가
  return m3 / m2 ** 1.5;
}

// 첨도(kurtosis) — ⚠️ 비초과(non-excess) 컨벤션: 정규분포 → 3.0 (초과첨도 컨벤션은
// 정규분포 → 0.0인데, scipy.stats.kurtosis()·pandas .kurt() 둘 다 기본값이 초과첨도라
// 그대로 갖다 쓰면 DSR 공식이 조용히 틀어진다 — 연구에서 확인된 가장 흔한 구현 버그).
// 적률비 방식(m4/m2²)으로 직접 계산하면 정규분포에서 자연히 3이 나와 "+3 보정"을 따로
// 안 해도 된다 — 그 자체가 이 함수의 설계 의도.
export function kurtosis(xs) {
  const n = xs.length;
  if (n < 2) return null;
  const m = mean(xs);
  const m2 = xs.reduce((s, x) => s + (x - m) ** 2, 0) / n;
  const m4 = xs.reduce((s, x) => s + (x - m) ** 4, 0) / n;
  if (m2 === 0) return null;
  return m4 / m2 ** 2;
}

// 표준정규 CDF Φ(x) — erf 근사(Abramowitz & Stegun 7.1.26, 최대오차 1.5e-7).
export function standardNormalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

// 표준정규 역CDF(분위함수) Φ⁻¹(p) — Acklam 알고리즘(유리함수 근사, 상대오차 ~1.15e-9,
// DSR 논문의 SR0 계산에 필요한 표준 구현). p가 (0,1) 밖이면 정의되지 않아 추정하지 않고
// null(ADR 0003 폴백 금지 원칙과 동일 정신).
export function standardNormalInvCdf(p) {
  if (!(p > 0 && p < 1)) return null;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Sharpe 비율 — periodsPerYear로 연율화(일간수익률=252, 월간=12 등 호출측이 명시).
// riskFreeRate는 같은 주기(연율 아님) 단위로 넘겨야 함 — 호출측 책임(추정하지 않음).
export function sharpeRatio(returns, { riskFreeRate = 0, periodsPerYear = 12 } = {}) {
  if (returns.length < 2) return null;
  const excess = returns.map((r) => r - riskFreeRate);
  const m = mean(excess);
  const sd = Math.sqrt(sampleVariance(excess) ?? NaN);
  if (!(sd > 0)) return null;
  return (m / sd) * Math.sqrt(periodsPerYear);
}

// 최대낙폭(MDD) — 누적 수익률 곡선(1.0=원금) 기준 고점 대비 최대 하락폭(0~1, 양수로 반환).
export function maxDrawdown(cumulativeReturns) {
  if (!cumulativeReturns.length) return null;
  let peak = cumulativeReturns[0];
  let worst = 0;
  for (const v of cumulativeReturns) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > worst) worst = dd;
  }
  return worst;
}

// 연평균수익률(CAGR) — cumulativeReturns[0]=1.0(원금) 가정, years는 관측기간(년, 소수 허용).
export function annualizedReturn(cumulativeReturns, years) {
  if (!cumulativeReturns.length || !(years > 0)) return null;
  const start = cumulativeReturns[0];
  const end = cumulativeReturns[cumulativeReturns.length - 1];
  if (!(start > 0)) return null;
  return (end / start) ** (1 / years) - 1;
}
