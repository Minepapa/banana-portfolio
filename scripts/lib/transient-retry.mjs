// 일시적인 실패(네트워크 끊김·시간 초과, HTTP 429·5xx)는 잠시 뒤 다시 시도한다.
// 2026-10-25: 원본 암호화 백업이 자정에 'fetch failed'로 시작 1초 만에 실패했다(볼트 백업은 정상).
export const TRANSIENT_RETRY_MS = Object.freeze([2000, 8000]);

export const isTransient = (error) => error?.status === 429 || error?.status >= 500
  || (error?.status === undefined && ['TypeError', 'TimeoutError', 'AbortError'].includes(error?.name));

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** [attempt]를 부르고, 일시적인 실패면 [delays] 간격으로 다시 시도한다. 그 밖의 오류는 그대로 던진다. */
export async function withTransientRetry(attempt, { delays = TRANSIENT_RETRY_MS, sleep = pause } = {}) {
  for (let i = 0; ; i += 1) {
    try { return await attempt(); }
    catch (error) {
      if (i >= delays.length || !isTransient(error)) throw error;
      await sleep(delays[i]);
    }
  }
}
