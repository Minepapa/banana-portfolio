import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizationUrl, saveRefreshToken, setup } from './google-oauth-setup.mjs';
import { OAUTH_SCOPES } from '../lib/google-oauth.mjs';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('OAuth 동의 URL: 루프백·PKCE S256·state·오프라인 권한과 선택 캘린더 조회 권한', () => {
  const url = authorizationUrl({ clientId: 'client', redirectUri: 'http://127.0.0.1:12345/callback', state: 'random-state', challenge: 'hashed-verifier' });
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:12345/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'hashed-verifier');
  assert.equal(url.searchParams.get('state'), 'random-state');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.deepEqual(url.searchParams.get('scope').split(' '), OAUTH_SCOPES);
  assert.ok(OAUTH_SCOPES.includes('https://www.googleapis.com/auth/calendar.calendarlist.readonly'));
});

 test('기존 토큰 파일을 덮어써도 권한 600으로 축소', () => {
  const dir = mkdtempSync(join(tmpdir(), 'google-oauth-setup-'));
  const path = join(dir, 'token.json');
  try {
    writeFileSync(path, 'old');
    chmodSync(path, 0o644);
    assert.equal(saveRefreshToken('new-refresh', OAUTH_SCOPES.join(' '), path), path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { refresh_token: 'new-refresh', scope: OAUTH_SCOPES.join(' ') });
    assert.deepEqual(readdirSync(dir), ['token.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('잘못된 OAuth state 뒤 올바른 callback을 기다리고, 교환 요청에는 15초 제한을 둔다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'google-oauth-loopback-'));
  process.env.GOOGLE_OAUTH_DIR = dir;
  writeFileSync(join(dir, 'google-oauth-client.json'), JSON.stringify({ installed: { client_id: 'client', client_secret: 'secret' } }));
  let handler;
  const createServerImpl = (callback) => {
    handler = callback;
    return { once() {}, listen(_port, _host, done) { done(); }, address() { return { port: 12345 }; }, close(done) { done(); } };
  };
  const callback = (url) => {
    let status;
    handler({ url }, { writeHead(code) { status = code; return this; }, end() {} });
    return status;
  };
  try {
    let opened;
    const running = setup({ createServerImpl, log: () => {}, openBrowser: (url) => { opened = new URL(url); }, fetchImpl: async (_url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => ({ refresh_token: 'new-refresh', scope: OAUTH_SCOPES.join(' ') }) };
    } });
    while (!opened) await new Promise((resolve) => setImmediate(resolve));
    const redirect = opened.searchParams.get('redirect_uri');
    assert.equal(callback(`${redirect}?state=wrong&code=bad`), 400);
    assert.equal(callback(`${redirect}?state=${opened.searchParams.get('state')}&code=good`), 200);
    await running;
    assert.equal(JSON.parse(readFileSync(join(dir, 'google-oauth-token.json'), 'utf8')).refresh_token, 'new-refresh');
  } finally { delete process.env.GOOGLE_OAUTH_DIR; rmSync(dir, { recursive: true, force: true }); }
});
