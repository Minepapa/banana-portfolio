// Deflated Sharpe Ratio(DSR) — Bailey & López de Prado(2014, JPM 40(5):94-107) Eq.1·2의
// 구현. 순수함수(구현계획서 Phase 10). 원 논문 직접 대조 + quantstrat(R, 공개 구현체) 교차
// 검증 완료(2026-08-08 연구) — 컨벤션·부호·자유도까지 원문 그대로.
//
// ⚠️ "시도 횟수(N)를 정직하게 세는 것" 자체가 이 통계량의 존재 이유다 — 실제로 시도한
// 파라미터 조합 중 일부만(예: "성공한 것만") 넘기면 보정이 무력화된다(연구에서 확인).
// N을 만들어내거나 어림잡지 않는다 — 실제 시도 이력이 없으면 이 함수 자체를 쓸 수 없다는
// 뜻이고, 그게 맞다(§8 근거없는 임의 추정 금지 원칙과 동일 정신).
import { standardNormalCdf, standardNormalInvCdf, sampleVariance } from './stats.mjs';

const EULER_MASCHERONI = 0.5772156649015329;

// SR0 — N개 "독립" 시도 중 진짜 SR이 0(순전히 운)이라는 귀무가설 하에서 기대되는 최댓값.
// trialSharpeRatios: 이 전략을 최종 채택하기까지 실제로 평가한 모든 후보의 Sharpe 값
// (채택된 것 포함, 탈락한 것도 전부 — 일부만 세면 안 됨). N=시도 개수는 이 배열 길이에서
// 그대로 뽑는다(별도 N 인자를 안 받는 이유 — "몇 개 시도했다"를 배열과 별개로 주장하게
// 두면 숫자가 어긋날 여지가 생긴다).
//
// ⚠️ 논문 Appendix A.3(Eq.7-9)은 시도들이 서로 상관돼 있을 때 "실효 독립시도수" N̂로
// 보정하는 절차를 추가로 제시하지만, 그 절차의 정확한 계수를 원문에서 글리프 단위까지
// 확인하지 못했다(연구 결과, 2026-08-08 — 수식 주변 서술로 얼개는 재구성했으나 원문 대조는
// 실패). 검증 안 된 수식을 임의로 구현하지 않고, 지금은 논문의 기본 케이스(Eq.1, 시도들이
// 독립이라는 가정)만 구현한다 — trialSharpeRatios 길이를 N 그대로 쓴다.
//
// 방향성(코드리뷰 확인 + 직접 재검증, 2026-08-08 — 최초 주석이 반대로 적혀 있었음):
// SR0는 N에 대해 단조증가한다(N이 클수록 "운만으로 나올 수 있는 최댓값"의 기댓값이
// 커짐 — 직접 수치 검증: 같은 분산대에서 N=3→SR0 0.49, N=300→SR0 1.45). 시도들이 실제로
// 상관돼 있어 실효 독립시도수 N̂이 명목 N보다 작다면, 이 구현은 명목 N을 그대로 써서
// SR0를 **과대평가**한다 → DSR(=Φ((SR-SR0)/σ))은 그만큼 **더 낮게** 나온다 → 게이트가
// 실제보다 더 엄격해지는 쪽(보수적)이다. 즉 이 생략의 위험은 "부적격 전략을 잘못
// 통과시킴"이 아니라 "적격 전략을 잘못 떨어뜨림" 쪽으로 치우친다 — 실전 자금 게이트
// 관점에서 안전한 방향.
export function computeSR0(trialSharpeRatios) {
  const n = trialSharpeRatios?.length ?? 0;
  if (n < 2) return null; // 시도 1개로는 "선택"이 없다 — 분산 자체가 정의 안 됨
  const v = sampleVariance(trialSharpeRatios);
  if (v == null || !(v >= 0)) return null;
  const invN = standardNormalInvCdf(1 - 1 / n);
  const invNe = standardNormalInvCdf(1 - 1 / (n * Math.E));
  if (invN == null || invNe == null) return null;
  return Math.sqrt(v) * ((1 - EULER_MASCHERONI) * invN + EULER_MASCHERONI * invNe);
}

// DSR 본체(논문 Eq.2). 반환값은 Sharpe 비율이 아니라 **확률**(0~1) — "진짜 SR이 SR0를
// 넘길 확률"이다. 게이트 판정은 이 확률에 임계치(예: 0.95)를 적용하는 방식으로 쓴다
// (Sharpe 값처럼 절대 크기 비교 금지 — 구현계획서 "통과판정(벤치마크 대비 상대비교,
// 절대숫자 금지)" 원칙과 정합).
//
// ⚠️ sharpeRatio는 반드시 "기간당(per-period)" 값이어야 한다 — stats.mjs의 sharpeRatio()
// 기본값(periodsPerYear=12)은 **연율화**된 값을 내는데, 그걸 그대로 여기 넣으면서
// sampleSize는 기간당 관측치 개수(연율화 안 됨)를 쓰면 서로 다른 주기가 섞여 DSR이 조용히
// 틀어진다(코드리뷰 실측 확인, 2026-08-08 — 같은 데이터로 기간당 SR 0.3→DSR 0.80,
// 연율화 SR 1.04→DSR 0.99999로 결과가 달라짐). DSR에 넣을 때는 반드시
// `sharpeRatio(returns, { periodsPerYear: 1 })`(연율화 안 함)로 계산한 값을 sharpeRatio·
// trialSharpeRatios 양쪽 다에 일관되게 써야 한다. skewness·kurtosis는 주기 자체와 무관
// (수익률 분포의 모양만 봄)하지만, kurtosis는 반드시 비초과 컨벤션(정규분포→3,
// stats.mjs kurtosis() 그대로 사용 — scipy/pandas 기본값인 초과첨도를 그대로 넣으면 안 됨).
//
// ⚠️ trialSharpeRatios는 이 전략을 고르기까지 **실제로 평가한 모든 후보**(채택됐든
// 탈락했든 전부)의 Sharpe여야 한다 — 이 함수는 순수함수라 호출측이 일부만(예: "잘 나온
// 것만") 넘겨도 걸러낼 방법이 없다. 몇 개를 실제로 시도했는지 정직하게 세는 책임은
// 호출측(Phase 10 백테스트 오케스트레이션)에 있다.
export function computeDeflatedSharpeRatio({ sharpeRatio, sampleSize, skewness, kurtosis, trialSharpeRatios }) {
  if (!(sampleSize > 1)) return null;
  const sr0 = computeSR0(trialSharpeRatios);
  if (sr0 == null) return null;
  const denomInner = 1 - skewness * sharpeRatio + ((kurtosis - 1) / 4) * sharpeRatio ** 2;
  if (!(denomInner > 0)) return null; // 음수면 sqrt 불가 — 비정상 입력, 추정하지 않고 null
  const sigma = Math.sqrt(denomInner / (sampleSize - 1));
  if (!(sigma > 0)) return null;
  return standardNormalCdf((sharpeRatio - sr0) / sigma);
}
