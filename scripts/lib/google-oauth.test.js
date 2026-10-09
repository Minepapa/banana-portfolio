import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAccessToken, isConfigured, loadClient, OAUTH_SCOPES, CALENDAR_READ_SCOPES, CALENDAR_WRITE_SCOPES, DRIVE_BACKUP_SCOPES } from './google-oauth.mjs';

test('OAuth 클라이언트 검사, 갱신 캐시, 실패 원인과 토큰 비노출', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'google-oauth-'));
  process.env.GOOGLE_OAUTH_DIR = dir;
  try {
    assert.equal(isConfigured(), false);
    assert.throws(() => loadClient(), /OAuth 클라이언트 파일 없음/);
    writeFileSync(join(dir, 'google-oauth-client.json'), JSON.stringify({ installed: { client_id: 'client', client_secret: 'secret' } }));
    writeFileSync(join(dir, 'google-oauth-token.json'), JSON.stringify({ refresh_token: 'REFRESH_SECRET', scope: OAUTH_SCOPES.join(' ') }));
    chmodSync(join(dir, 'google-oauth-token.json'), 0o600);
    assert.equal(isConfigured(), true);
    let calls = 0;
    const fakeFetch = async (_url, options) => {
      calls++;
      assert.equal(options.body.get('refresh_token'), 'REFRESH_SECRET');
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => ({ access_token: `ACCESS_${calls}`, expires_in: 3600, scope: OAUTH_SCOPES.join(' ') }) };
    };
    assert.equal(await getAccessToken({ fetchImpl: fakeFetch, now: 1000 }), 'ACCESS_1');
    assert.equal(await getAccessToken({ fetchImpl: fakeFetch, now: 3_500_000 }), 'ACCESS_1');
    assert.equal(await getAccessToken({ fetchImpl: fakeFetch, now: 3_550_000 }), 'ACCESS_2');
    await assert.rejects(() => getAccessToken({ now: 8_000_000, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'REFRESH_SECRET' }) }) }), (error) => error.message.includes('invalid_grant') && error.message.includes('node scripts/tools/google-oauth-setup.mjs 다시 실행') && error.message.includes('7일마다 만료') && !error.message.includes('REFRESH_SECRET'));
  } finally { delete process.env.GOOGLE_OAUTH_DIR; rmSync(dir, { recursive: true, force: true }); }
});

test('레거시 scope 없는 토큰을 갱신하고 읽기·쓰기·백업 권한을 용도별로 검사한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'google-oauth-scope-'));
  process.env.GOOGLE_OAUTH_DIR = dir;
  try {
    writeFileSync(join(dir, 'google-oauth-client.json'), JSON.stringify({ installed: { client_id: 'client', client_secret: 'secret' } }));
    const path = join(dir, 'google-oauth-token.json');
    writeFileSync(path, JSON.stringify({ refresh_token: 'fake', custom: 'keep' }));
    const legacyScope = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.file';
    const legacyFetch = async () => ({ ok: true, json: async () => ({ access_token: 'legacy', expires_in: 3600, scope: legacyScope }) });
    assert.equal(await getAccessToken({ now: 100_000_000, requiredScopes: CALENDAR_READ_SCOPES, fetchImpl: legacyFetch }), 'legacy');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).custom, 'keep');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);
    assert.equal(await getAccessToken({ now: 100_000_000, requiredScopes: DRIVE_BACKUP_SCOPES, fetchImpl: () => { throw new Error('cached'); } }), 'legacy');
    await assert.rejects(() => getAccessToken({ now: 100_000_000, requiredScopes: CALENDAR_WRITE_SCOPES, fetchImpl: () => { throw new Error('cached'); } }), /권한 범위 부족/);
    const before = statSync(path).mtimeMs;
    assert.equal(await getAccessToken({ now: 104_000_000, requiredScopes: CALENDAR_READ_SCOPES, fetchImpl: legacyFetch }), 'legacy');
    assert.equal(statSync(path).mtimeMs, before);
    await assert.rejects(() => getAccessToken({ now: 108_000_000, requiredScopes: CALENDAR_READ_SCOPES, fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'narrow', expires_in: 3600, scope: OAUTH_SCOPES[0] }) }) }), /권한 범위 부족/);
  } finally { delete process.env.GOOGLE_OAUTH_DIR; rmSync(dir, { recursive: true, force: true }); }
});
