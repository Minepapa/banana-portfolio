import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'kis-token-test-'));
process.env.KIS_TOKEN_CACHE_FILE = join(root, 'kis-token.json');
process.env.KIS_LEGACY_TOKEN_CACHE_FILE = join(root, 'legacy-token.json');
process.env.KIS_KEY_FILE = join(root, 'kis-key.json');
const { getKisToken, getKrQuote, placeKrOrder } = await import('./kis.mjs');

test('KIS 토큰 발급 fetch에 15초 타임아웃 signal 전달', async () => {
  await getKisToken({ appkey: 'timeout-key', appsecret: 's', fetchImpl: async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    return { ok: true, json: async () => ({ access_token: 't', access_token_token_expired: '2099-01-01 00:00:00' }) };
  } });
});

test('KIS msg_cd EGW00121·EGW00123은 토큰 갱신 대상', async () => {
  for (const code of ['EGW00121', 'EGW00123']) {
    cachedToken();
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push(options.method);
      const payload = url.includes('/oauth2/tokenP')
        ? { access_token: 'new', access_token_token_expired: '2099-01-01 00:00:00' }
        : options.headers.authorization === 'Bearer new'
          ? { rt_cd: '0', output: { stck_prpr: '70000' } }
          : { rt_cd: '1', msg_cd: code, msg1: 'authentication failed' };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
    };
    assert.equal((await getKrQuote({ token: 'old', appkey: 'k', appsecret: 's', code: '005930', fetchImpl })).price, 70000);
    assert.deepEqual(calls, ['GET', 'POST', 'GET']);
  }
});

test('KIS 토큰 재발급 실패는 원 오류의 cause로 남고 HTTP 429는 그대로 전달', async () => {
  for (const status of [500, 429]) {
    cachedToken();
    const fetchImpl = async (url) => {
      if (url.includes('/oauth2/tokenP')) return {
        ok: false, status, text: async () => 'token request failed',
      };
      const payload = { rt_cd: '1', msg_cd: 'EGW00121', msg1: 'invalid token' };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
    await assert.rejects(() => getKrQuote({ token: 'old', appkey: 'k', appsecret: 's',
      code: '005930', fetchImpl }), (error) => {
      if (status === 429) assert.equal(error.code, 'RATE_LIMIT');
      else {
        assert.match(error.message, /invalid token/);
        assert.match(error.cause.message, /HTTP 500/);
      }
      return true;
    });
  }
});

test('KIS 토큰 갱신 후 GET 재시도의 비JSON HTTP 429는 RATE_LIMIT로 전파', async () => {
  cachedToken();
  const fetchImpl = async (url, options) => {
    if (url.includes('/oauth2/tokenP')) {
      const payload = { access_token: 'new', access_token_token_expired: '2099-01-01 00:00:00' };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
    }
    if (options.headers.authorization === 'Bearer new') return {
      ok: false, status: 429, text: async () => '<html>rate limited</html>',
    };
    const payload = { rt_cd: '1', msg_cd: 'EGW00121', msg1: 'invalid token' };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  await assert.rejects(() => getKrQuote({ token: 'old', appkey: 'k', appsecret: 's',
    code: '005930', fetchImpl }), (error) => {
    assert.equal(error.code, 'RATE_LIMIT');
    assert.equal(error.status, 429);
    assert.match(error.message, /rate limited/);
    return true;
  });
});

function cachedToken() {
  writeFileSync(process.env.KIS_TOKEN_CACHE_FILE, JSON.stringify({
    k: { token: 'old', expiresAt: Date.now() + 86_400_000 },
  }));
}

test('KIS GET만 무효 토큰을 한 번 갱신하며 두 번째 실패는 원래 오류', async () => {
  cachedToken();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(options.method);
    const payload = url.includes('/oauth2/tokenP')
      ? { access_token: 'new', access_token_token_expired: '2099-01-01 00:00:00' }
      : options.headers.authorization === 'Bearer new'
        ? { rt_cd: '0', output: { stck_prpr: '70000' } }
        : { rt_cd: '1', msg_cd: 'invalid_token', msg1: '유효하지 않은 token' };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
  };
  assert.equal((await getKrQuote({ token: 'old', appkey: 'k', appsecret: 's', code: '005930', fetchImpl })).price, 70000);
  assert.deepEqual(calls, ['GET', 'POST', 'GET']);

  cachedToken();
  let attempts = 0;
  const failingFetch = async (url) => {
    attempts++;
    const payload = url.includes('/oauth2/tokenP')
      ? { access_token: 'new', access_token_token_expired: '2099-01-01 00:00:00' }
      : { rt_cd: '1', msg_cd: 'invalid_token', msg1: 'first invalid token' };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
  };
  await assert.rejects(() => getKrQuote({ token: 'old', appkey: 'k', appsecret: 's',
    code: '005930', fetchImpl: failingFetch }), /first invalid token/);
  assert.equal(attempts, 3);
});

test('KIS POST 주문은 무효 토큰이어도 재시도하지 않는다', async () => {
  cachedToken();
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    return { ok: true, status: 200, text: async () => JSON.stringify({
      rt_cd: '1', msg_cd: 'invalid_token', msg1: '유효하지 않은 token',
    }) };
  };
  await assert.rejects(() => placeKrOrder({ token: 'old', appkey: 'k', appsecret: 's',
    cano: '12345678', acntPrdtCd: '01', code: '005930', side: '매수', quantity: 1,
    price: 70000, fetchImpl }));
  assert.equal(attempts, 1);
});

test('KIS 캐시가 이미 교체됐으면 재발급 없이 새 토큰으로 조회를 재시도한다', async () => {
  writeFileSync(process.env.KIS_TOKEN_CACHE_FILE, JSON.stringify({
    k: { token: 'already-new', expiresAt: Date.now() + 86_400_000 },
  }));
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url.includes('/oauth2/tokenP'), false);
    const payload = options.headers.authorization === 'Bearer already-new'
      ? { rt_cd: '0', output: { stck_prpr: '70000' } }
      : { rt_cd: '1', msg_cd: 'invalid_token', msg1: '유효하지 않은 token' };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  assert.equal((await getKrQuote({ token: 'superseded', appkey: 'k', appsecret: 's',
    code: '005930', fetchImpl })).price, 70000);
  assert.equal(calls, 2);
});
