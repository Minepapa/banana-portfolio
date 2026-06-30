// fetchRetry 테스트 — 일시적 5xx/429·네트워크 오류 재시도, 비재시도성 즉시 반환.
// 실제 네트워크/대기 없이: fetchImpl·sleep 을 주입(DI)해 결정론적으로 검증.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRetry, RETRYABLE_STATUS } from './fetch-retry.mjs';

// 호출 순서대로 응답/예외를 돌려주는 가짜 fetch.
function mockFetch(sequence) {
  let i = 0;
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const step = sequence[Math.min(i, sequence.length - 1)];
    i++;
    if (step instanceof Error) throw step;
    return step;
  };
  fn.count = () => i;
  fn.calls = calls;
  return fn;
}
const res = (status) => ({ ok: status >= 200 && status < 300, status, text: async () => `HTTP ${status}` });
const noSleep = async () => {};        // 대기 제거(테스트 즉시 완료)

test('성공(200)은 1회 호출 후 즉시 반환', async () => {
  const f = mockFetch([res(200)]);
  const r = await fetchRetry('u', {}, { fetchImpl: f, sleep: noSleep, onRetry: null });
  assert.equal(r.status, 200);
  assert.equal(f.count(), 1);
});

test('503 두 번 후 200 — 3회 호출, 최종 200 반환', async () => {
  const f = mockFetch([res(503), res(503), res(200)]);
  let retries = 0;
  const r = await fetchRetry('u', {}, { fetchImpl: f, sleep: noSleep, onRetry: () => retries++ });
  assert.equal(r.status, 200);
  assert.equal(f.count(), 3);
  assert.equal(retries, 2);
});

test('재시도 소진 시 마지막 503 응답을 throw 없이 반환(호출부가 !res.ok 처리)', async () => {
  const f = mockFetch([res(503)]);
  const r = await fetchRetry('u', {}, { retries: 2, fetchImpl: f, sleep: noSleep, onRetry: null });
  assert.equal(r.status, 503);
  assert.equal(f.count(), 3);          // 최초 1 + 재시도 2
});

test('비재시도성 상태(403)는 재시도 없이 즉시 반환', async () => {
  const f = mockFetch([res(403), res(200)]);
  const r = await fetchRetry('u', {}, { fetchImpl: f, sleep: noSleep, onRetry: null });
  assert.equal(r.status, 403);
  assert.equal(f.count(), 1);
});

test('네트워크 오류(fetch failed) 후 200 — 재시도 성공', async () => {
  const f = mockFetch([new TypeError('fetch failed'), res(200)]);
  const r = await fetchRetry('u', {}, { fetchImpl: f, sleep: noSleep, onRetry: null });
  assert.equal(r.status, 200);
  assert.equal(f.count(), 2);
});

test('네트워크 오류가 재시도 소진까지 지속되면 마지막 예외를 throw', async () => {
  const f = mockFetch([new TypeError('fetch failed')]);
  await assert.rejects(
    fetchRetry('u', {}, { retries: 1, fetchImpl: f, sleep: noSleep, onRetry: null }),
    /fetch failed/,
  );
  assert.equal(f.count(), 2);          // 최초 1 + 재시도 1
});

test('백오프 지연은 지수적으로 증가하고 jitter 범위 내(base*2^n ≤ d < base*2^n+250)', async () => {
  const f = mockFetch([res(503), res(503), res(503), res(200)]);
  const delays = [];
  const r = await fetchRetry('u', {}, {
    baseDelayMs: 100, fetchImpl: f, sleep: async (ms) => { delays.push(ms); }, onRetry: null,
  });
  assert.equal(r.status, 200);
  assert.equal(delays.length, 3);                 // 503 세 번 → 재시도 3회
  for (let n = 0; n < 3; n++) {
    const lo = 100 * 2 ** n;                       // 100, 200, 400
    assert.ok(delays[n] >= lo && delays[n] < lo + 250, `delay[${n}]=${delays[n]} ∈ [${lo}, ${lo + 250})`);
  }
  // 단조증가 어서션 제거: jitter[0,249]로 인해 delay[0]>delay[1]이 ~18% 확률 발생(플레이크). lo 범위 검증이 지수 성장을 충분히 보장함.
});

test('RETRYABLE_STATUS는 429·500·502·503·504 포함, 404·403 미포함', () => {
  for (const s of [429, 500, 502, 503, 504]) assert.ok(RETRYABLE_STATUS.has(s), `${s} 재시도 대상`);
  for (const s of [400, 401, 403, 404]) assert.ok(!RETRYABLE_STATUS.has(s), `${s} 비재시도`);
});
