// 헤드리스 claude를 부르는 잡의 실행 결과 판정 — 조용한 실패 방지(2026-10-31, media-memory-orb 조사).
// run.sh는 종료코드로만 OK/FAIL을 기록한다. 실패를 잡아 로그만 남기고 정상 종료하면 판단이 전부 실패해도 OK로 남는다
// (10-18 사진 구슬 50개가 전부 실패했는데 OK). 그래서 claude 호출 잡은 모두 이 규칙 하나로 종료코드를 정한다.
// - 시도가 있었는데 성공이 0건이고 실패가 1건 이상이면 잡 실패(exitCode=1) → health-watcher가 연속 실패를 알린다.
// - 쿨다운·사용량 한도·시간 상한으로 멈춘 것은 실패로 세지 않는다(호출부가 failed에 넣지 않고 limited에 센다) — 다음 실행이 다시 시도하니까.
//   예외(2026-10-31 제우스): 다시 시도할 수단이 없는 단발 잡(retryable: false — 주 1회·분기 창 잡처럼 마커·재실행 없이 그 회차가 그냥 지나가는 잡)은
//   한도로 멈춰도 실패로 둔다. 그 회차 점검이 알림 없이 빠지면 안 된다.
// - 부분 실패(성공이 1건 이상)는 OK로 두고 로그만 남긴다 — 일부 항목 실패마다 경보가 나가면 경보 피로가 생긴다.
export function llmRunFailed({ succeeded = 0, failed = 0, limited = 0, retryable = true } = {}) {
  if (succeeded > 0) return false;
  return failed > 0 || (!retryable && limited > 0);
}

// 호출부 공용: 규칙에 걸리면 이유를 남기고 exitCode=1(이미 1 이상이면 그대로). 걸렸는지 돌려준다.
export function markLlmRunOutcome(counts, { job, log = console.error, proc = process } = {}) {
  if (!llmRunFailed(counts)) return false;
  const limited = counts.limited ? `·한도로 멈춤 ${counts.limited}건(다시 시도 수단 없는 잡)` : '';
  log(`[${job}] claude 판단 성공 0건·실패 ${counts.failed ?? 0}건${limited} — 잡 실패로 기록(exitCode=1)`);
  if (!proc.exitCode) proc.exitCode = 1;
  return true;
}
