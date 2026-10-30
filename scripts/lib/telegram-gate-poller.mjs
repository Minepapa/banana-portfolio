// 텔레그램 관문 수신 루프의 재시도·경보 판정(2026-10-30, 관문 1단계). 네트워크 호출은 주입받는다.
// - 409(다른 소비자가 같은 봇을 폴링 = 가로채기): 포기하고 끝내지 않는다. 경보를 보내고 백오프하며 다시 잡는다.
//   옛 플러그인은 409가 8번 이어지면 폴링을 멈춰 "프로세스는 살아 있는데 귀가 먹은" 상태가 됐다(2026-10-24 요청).
// - 429: Bot API가 준 retry_after만큼 쉰다.
// - 연결 단절·5xx: 1초부터 두 배씩, 최대 60초.
// - 그 밖의 4xx(401 토큰 폐기 등): 사람이 고쳐야 하니 5분 간격으로 늦추고 경보한다.

export const POLL_TIMEOUT_SEC = 50;
const CONFLICT_ALERT_INTERVAL_MS = 30 * 60 * 1000;

export function classifyPollError(error) {
  if (error?.name === 'AbortError') return 'aborted';
  if (error?.conflict) return 'conflict';
  if (error?.rateLimited) return 'rate-limited';
  if (error?.network || (Number.isFinite(error?.status) && error.status >= 500)) return 'network';
  return 'fatal';
}

// 순수 함수: 연속 실패 횟수(attempt, 1부터)와 오류 → 다음 시도까지 쉴 시간(ms).
export function pollRetryDelayMs(error, attempt) {
  const kind = classifyPollError(error);
  const n = Math.max(1, attempt);
  if (kind === 'rate-limited') return Math.max(1, error.retryAfterSec ?? 5) * 1000;
  if (kind === 'conflict') return Math.min(5000 * 2 ** (n - 1), 60_000);
  if (kind === 'network') return Math.min(1000 * 2 ** (n - 1), 60_000);
  if (kind === 'fatal') return 5 * 60 * 1000;
  return 0;
}

// 순수 함수: 이번 오류를 오너에게 알릴지. 409·치명 오류만, 같은 종류는 30분에 한 번.
export function shouldAlertPollError(error, { lastAlertAt = null, lastKind = null, now }) {
  const kind = classifyPollError(error);
  if (kind !== 'conflict' && kind !== 'fatal') return false;
  if (lastKind !== kind || lastAlertAt === null) return true;
  return now - lastAlertAt >= CONFLICT_ALERT_INTERVAL_MS;
}

// 한 바퀴: getUpdates → 저장(fsync) → offset 확정. 저장이 끝나기 전에는 offset을 넘기지 않는다(inbox 순서 불변식).
// sanitize: 저장 전에 업데이트를 거르는 함수(허용 밖 발신자 원문을 남기지 않기, router.sanitizeUpdate).
export async function pollOnce({ inbox, getUpdates, signal, sanitize = (u) => u }) {
  const offset = inbox.readOffset();
  const updates = await getUpdates({ offset: offset ?? undefined, timeoutSec: POLL_TIMEOUT_SEC }, { signal });
  const list = Array.isArray(updates) ? updates : [];
  const fresh = inbox.appendUpdates(list.map(sanitize));
  const ids = list.map((u) => u?.update_id).filter(Number.isInteger);
  if (ids.length) inbox.commitOffset(Math.max(...ids) + 1);
  return { received: list.length, fresh: fresh.length };
}
