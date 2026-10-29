import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransient, withTransientRetry } from './transient-retry.mjs';

const noSleep = { sleep: async () => {} };

test('네트워크 끊김·5xx는 다시 시도하고, 성공하면 그 값을 돌려준다', async () => {
  let calls = 0;
  const value = await withTransientRetry(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new TypeError('fetch failed'));
    if (calls === 2) throw Object.assign(new Error('HTTP 500'), { status: 500 });
    return 'ok';
  }, noSleep);
  assert.equal(value, 'ok');
  assert.equal(calls, 3);
});

test('4xx 같은 영구 오류는 바로 던지고, 일시적 오류도 정해진 횟수 뒤에는 던진다', async () => {
  let calls = 0;
  await assert.rejects(() => withTransientRetry(async () => { calls += 1; throw Object.assign(new Error('HTTP 403'), { status: 403 }); }, noSleep));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(() => withTransientRetry(async () => { calls += 1; throw new TypeError('fetch failed'); }, noSleep));
  assert.equal(calls, 3);
  assert.equal(isTransient(Object.assign(new Error('x'), { status: 429 })), true);
  assert.equal(isTransient(new Error('plain')), false);
});
