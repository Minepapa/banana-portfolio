// 주간리포트 다음 발행 D-day 계산 — 고정 주기(매주 일요일, JOB_INTERVALS['weekly-report']와
// 동일 전제)로 산출. now를 인자로 받아 순수성 유지(jobHealth.js computeJobHealth(rows, cadence, now)
// 관례와 동일 — 렌더 중 Date.now() 직접 호출 회피).
export function nextReportDday(weeklyReports, now = new Date()) {
  const dow = now.getDay(); // 일=0 ... 토=6
  const days = (7 - dow) % 7;
  const list = weeklyReports || [];
  const lastDate = list.length ? (list[0]?.date ?? null) : null;
  return { days, lastDate };
}
