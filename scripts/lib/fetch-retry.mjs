export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function defaultOnRetry(n, delayMs, err) {
  console.warn(`   ⏳ 시트 호출 일시오류(${err?.message || '?'}) — ${(delayMs / 1000).toFixed(1)}s 후 재시도 (${n})`);
}

// fetch 래퍼: 재시도성 상태/네트워크 오류면 지수 백오프 후 재시도.
// 성공·비재시도성(4xx 등)·재시도 소진 시엔 Response 를 그대로 반환 → 호출부의
// `if (!res.ok) throw` 가 기존과 동일하게 동작(에러 메시지 보존). 네트워크 오류가
// 끝까지 지속되면 마지막 예외를 throw. fetchImpl/sleep/onRetry 는 테스트 주입용(DI).
// retries=4 → 최초 1회 + 재시도 4회 = 최대 5회 시도(누적 백오프 최악 ~8.5s, 헤드리스 12분 내 무해).
// appendValues 비멱등성 주의: 503(미처리)은 재시도 안전, 504(완료후 응답 유실)는 중복 가능.
// '유실=비싼 재평가' vs '중복=앱이 최신카드만 표시·정리 쉬움' → 중복 감수하고 유실 방지.
export async function fetchRetry(url, opts = {}, {
  retries = 4,
  baseDelayMs = 500,
  fetchImpl = fetch,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  onRetry = defaultOnRetry,
} = {}) {
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(url, opts);
      if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt >= retries) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (attempt >= retries) throw e;
      lastErr = e;
    }
    const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
    onRetry?.(attempt + 1, delay, lastErr);
    await sleep(delay);
  }
}
