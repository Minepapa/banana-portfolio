// 역사적 후보(historical-universe.mjs 형태) → OCF/P 랭킹 입력(quant-factor.mjs 형태)
// 변환 — 구현계획서 Phase 10. 새 랭킹 로직을 만들지 않는다: Phase 9의 rankByOcfToPrice
// (이미 리뷰·검증된 순수함수)를 그대로 재사용하고, 이 파일은 필드 이름·데이터 소스만
// 이어붙인다(historical-universe.mjs는 code/name/marcap 소문자, quant-factor.mjs는
// Code/Name/Marcap 대문자 — fdr-universe.py의 기존 컨벤션과 맞추기 위한 어댑터).
// 순수함수 — 테스트 가능(corpCode 해석·OCF 조회 결과를 인자로 받아 조립만 함, 자체
// 조회 없음).

// candidates: historical-universe.mjs computePointInTimeUniverse/attachLiquidity 결과.
// corpCodeByStock: { [stockCode]: corpCode|null } — instruments.mjs krCorpCodeByStock을
// 미리 호출해 모아둔 매핑(호출측 책임 — 이 함수는 조회하지 않음).
// ocfByCorpCode: ocf-history-cache.mjs ocfAt() 결과.
// 반환: rankByOcfToPrice가 바로 받을 수 있는 { Code, Name, Marcap, operCf, ...원본필드 }
// 배열 — 법인코드 매칭 실패·그 시점 공시 미확인은 operCf:null로 남겨(추정 안 함)
// rankByOcfToPrice가 알아서 순위에서 제외하게 둔다(quant-ranking.mjs와 동일 원칙).
export function attachHistoricalOcf(candidates, corpCodeByStock, ocfByCorpCode, targetDate) {
  return candidates.map((c) => {
    const corpCode = corpCodeByStock[c.code] ?? null;
    const ocfEntry = corpCode ? (ocfByCorpCode[corpCode]?.[targetDate] ?? null) : null;
    return { ...c, Code: c.code, Name: c.name, Marcap: c.marcap, operCf: ocfEntry?.operCf ?? null, ocfDisclosureDate: ocfEntry?.disclosureDate ?? null };
  });
}
