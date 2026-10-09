import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.file',
];
export const oauthDir = () => process.env.GOOGLE_OAUTH_DIR || join(homedir(), '.config', 'banana-portfolio-v2');
export const clientPath = () => join(oauthDir(), 'google-oauth-client.json');
export const tokenPath = () => join(oauthDir(), 'google-oauth-token.json');
const missingClient = 'OAuth 클라이언트 파일 없음(설정 안내: scripts/tools/google-oauth-setup.mjs)';
let cached = null;

export function loadClient(path = clientPath()) {
  try {
    const installed = JSON.parse(readFileSync(path, 'utf8')).installed;
    if (typeof installed?.client_id !== 'string' || !installed.client_id || typeof installed?.client_secret !== 'string' || !installed.client_secret) throw new Error('invalid client');
    return installed;
  } catch { throw new Error(missingClient); }
}

export function isConfigured() { return existsSync(clientPath()) && existsSync(tokenPath()); }

export async function getAccessToken({ fetchImpl = fetch, now = Date.now } = {}) {
  const current = typeof now === 'function' ? now() : now;
  const path = tokenPath();
  if (cached?.path === path && current < cached.expiresAt - 60_000) return cached.accessToken;
  const client = loadClient();
  let refreshToken;
  try { refreshToken = JSON.parse(readFileSync(path, 'utf8')).refresh_token; }
  catch { throw new Error('OAuth 토큰 파일 없음 — google-oauth-setup 필요'); }
  if (typeof refreshToken !== 'string' || !refreshToken) throw new Error('OAuth 갱신 토큰 없음 — google-oauth-setup 필요');
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token || !Number.isFinite(Number(data.expires_in))) {
    // Google 오류 코드만 드러낸다. description에는 토큰이나 요청 정보가 섞일 수 있다.
    const reason = String(data.error || response.status).replace(/[^a-zA-Z0-9_-]/g, '');
    const advice = reason === 'invalid_grant' ? ' — 연결 만료 — node scripts/tools/google-oauth-setup.mjs 다시 실행(동의 화면이 \'테스트 중\'이면 7일마다 만료)' : '';
    throw new Error(`OAuth 액세스 토큰 갱신 실패 (${reason})${advice}`);
  }
  cached = { path, accessToken: data.access_token, expiresAt: current + Number(data.expires_in) * 1000 };
  return cached.accessToken;
}
