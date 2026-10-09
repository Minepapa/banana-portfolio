#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { clientPath, loadClient, OAUTH_SCOPES, tokenPath } from '../lib/google-oauth.mjs';

export function authorizationUrl({ clientId, redirectUri, state, challenge }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: OAUTH_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value);
  return url;
}

export function saveRefreshToken(refreshToken, path = tokenPath()) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temporary = join(dir, `.google-oauth-token-${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ refresh_token: refreshToken }) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* rename 성공 전후 모두 원래 오류를 유지한다. */ }
    throw error;
  }
  return path;
}

export async function setup({ fetchImpl = fetch, openBrowser = (url) => spawn('open', [url], { stdio: 'ignore' }), createServerImpl = createServer } = {}) {
  const client = loadClient(clientPath());
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let settle;
  const code = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const server = createServerImpl((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400).end('state mismatch');
      return;
    }
    const value = url.searchParams.get('code');
    if (!value) {
      res.writeHead(400).end('authorization failed');
      settle.reject(new Error(`OAuth 동의 실패 (${url.searchParams.get('error') || 'code 없음'})`));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('연결을 마쳤습니다. 이 창을 닫아도 됩니다.');
    settle.resolve(value);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
    const authUrl = authorizationUrl({ clientId: client.client_id, redirectUri, state, challenge });
    console.log(`동의 URL: ${authUrl}`);
    openBrowser(String(authUrl));
    const timer = setTimeout(() => settle.reject(new Error('OAuth 동의 제한 시간 5분 초과')), 5 * 60_000);
    let authorizationCode;
    try { authorizationCode = await code; } finally { clearTimeout(timer); }
    const response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, code: authorizationCode, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
      signal: AbortSignal.timeout(15000),
    });
    const token = await response.json();
    if (!response.ok || !token.refresh_token) throw new Error(`OAuth 토큰 교환 실패 (${String(token.error || response.status).replace(/[^a-zA-Z0-9_-]/g, '')})`);
    const path = saveRefreshToken(token.refresh_token);
    console.log(`연결 완료(이메일 범위 없음, 저장 위치: ${path})`);
  } finally { server.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) setup().catch((error) => { console.error(error.message); process.exitCode = 1; });
