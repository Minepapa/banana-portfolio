// OCF/P 팩터 계산·순위 — 순수 함수(구현계획서 Phase 9).
// docs/ARCHITECTURE-V2.md "팩터 선택 — 가치 단일 뼈대, OCF/P" 절 그대로: 복합점수가
// 아니라 검증된 단일 지표(영업현금흐름/시가총액) 하나만 쓴다. 진입은 순수 상대(횡단면)
// 순위 기반 — 절대 저평가 기준은 따로 두지 않는다("투자철학" 절).

// OCF/P — marcap이 0 이하이거나 operCf가 없으면(추정 안 함) null.
export function computeOcfToPrice(operCf, marcap) {
  if (operCf == null || !(marcap > 0)) return null;
  return operCf / marcap;
}

// candidates: [{ Code, Name, Marcap, operCf }, ...] (operCf는 fetchOcfPointInTime 결과
// 병합 — corpCode 매칭 실패·공시 미확인 등으로 못 구했으면 null). ocfToPrice가 null인
// 항목(추정 불가)은 순위 자체에서 제외한다 — "이번 달은 후보에서 빠짐"이 안전.
// 반환: ocfToPrice·rank가 붙은 채로 내림차순 정렬된 배열(값이 클수록 저평가=1위).
export function rankByOcfToPrice(candidates) {
  const withScore = candidates
    .map((c) => ({ ...c, ocfToPrice: computeOcfToPrice(c.operCf, c.Marcap) }))
    .filter((c) => c.ocfToPrice != null);
  withScore.sort((a, b) => b.ocfToPrice - a.ocfToPrice);
  return withScore.map((c, i) => ({ ...c, rank: i + 1 }));
}
