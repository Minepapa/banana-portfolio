// 워크포워드 분석 — 구간 분할 순수함수(구현계획서 Phase 10, ARCHITECTURE-V2.md "05
// 시뮬레이션" 절: 5년 in-sample → 1년 out-of-sample, 윈도우 이동). 실제 백테스트 실행은
// 다른 모듈(리컨스티튜션 시뮬레이터) 몫 — 이 파일은 "언제부터 언제까지가 in/out-sample
// 인가"만 결정론으로 계산한다.

// startDate·endDate: 전체 사용 가능 데이터 구간(Date). inSampleYears·outSampleYears·
// stepYears(윈도우 이동 폭, 기본 outSampleYears와 동일 — 겹치지 않는 연속 구간).
// 반환: [{ inSampleStart, inSampleEnd, outSampleStart, outSampleEnd }, ...] — outSampleEnd가
// endDate를 넘지 않는 윈도우만 포함(불완전한 마지막 윈도우는 버림 — 추정하지 않음).
export function splitWalkForwardWindows({ startDate, endDate, inSampleYears = 5, outSampleYears = 1, stepYears = outSampleYears }) {
  if (!(startDate instanceof Date) || !(endDate instanceof Date) || !(endDate > startDate)) return [];
  if (!(inSampleYears > 0) || !(outSampleYears > 0) || !(stepYears > 0)) return [];

  const addYears = (d, y) => {
    const r = new Date(d.getTime());
    r.setUTCFullYear(r.getUTCFullYear() + y);
    return r;
  };

  const windows = [];
  let inSampleStart = new Date(startDate.getTime());
  while (true) {
    const inSampleEnd = addYears(inSampleStart, inSampleYears);
    // inSampleEnd와 같은 Date 인스턴스를 공유하지 않는다 — 지금은 반환값이 읽기전용으로만
    // 쓰이지만, 나중에 호출측이 한쪽을 변형(mutate)하면 다른 쪽도 조용히 같이 바뀌는
    // 앨리어싱 사고를 원천 차단(코드리뷰 지적, 2026-08-08).
    const outSampleStart = new Date(inSampleEnd.getTime());
    const outSampleEnd = addYears(outSampleStart, outSampleYears);
    if (outSampleEnd > endDate) break;
    windows.push({ inSampleStart, inSampleEnd, outSampleStart, outSampleEnd });
    inSampleStart = addYears(inSampleStart, stepYears);
  }
  return windows;
}
