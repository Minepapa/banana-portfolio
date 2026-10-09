import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAccessToken, isConfigured, loadClient } from './google-oauth.mjs';

test('OAuth 클라이언트 검사, 갱신 캐시, 실패 원인과 토큰 비노출', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'google-oauth-'));
  process.env.GOOGLE_OAUTH_DIR = dir;
  try {
    assert.equal(isConfigured(), false);
    assert.throws(() => loadClient(), /OAuth 클라이언트 파일 없음/);
    writeFileSync(join(dir, 'google-oauth-client.json'), JSON.stringify({ installed: { client_id: 'client', client_secret: 'secret' } }));
    writeFileSync(join(dir, 'google-oauth-token.json'), JSON.stringify({ refresh_token: 'REFRESH_SECRET' }));
    chmodSync(join(dir, 'google-oauth-token.json'), 0o600);
    assert.equal(isConfigured(), true);
    let calls = 0;
    const fakeFetch = async (_url, options) => {
      calls++;
      assert.equal(options.body.get('refresh_token'), 'REFRESH_SECRET');
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => ({ access_token: `ACCESS_${calls}`, expires_in: 3600 }) };
    };
    assert.equal(await getAccessToken({ fetchImpl: fakeFetch, now: 1000 }), 'ACCESS_1');
    assert.equal(await getAccessToken({ fetchImpl: fakeFetch, now: 3_500_000 }), 'ACCESS_1');
    assert.equal(await getAccessToken({ fetchImpl: fakeFetch, now: 3_550_000 }), 'ACCESS_2');
    await assert.rejects(() => getAccessToken({ now: 8_000_000, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'REFRESH_SECRET' }) }) }), (error) => error.message.includes('invalid_grant') && error.message.includes('node scripts/tools/google-oauth-setup.mjs 다시 실행') && error.message.includes('7일마다 만료') && !error.message.includes('REFRESH_SECRET'));
  } finally { delete process.env.GOOGLE_OAUTH_DIR; rmSync(dir, { recursive: true, force: true }); }
});
