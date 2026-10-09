import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  // Hermes 등 기존 브리핑은 calendarList.list로 선택된 캘린더를 조회한다.
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.file',
];
const scope = (name) => `https://www.googleapis.com/auth/${name}`;
export const CALENDAR_READ_SCOPES = [
  [scope('calendar.events'), scope('calendar.readonly')],
  [scope('calendar.calendarlist.readonly'), scope('calendar.readonly')],
];
export const CALENDAR_WRITE_SCOPES = [scope('calendar.events')];
export const DRIVE_BACKUP_SCOPES = [scope('drive.file')];
export const oauthDir = () => process.env.GOOGLE_OAUTH_DIR || join(homedir(), '.config', 'banana-portfolio-v2');
export const clientPath = () => join(oauthDir(), 'google-oauth-client.json');
export const tokenPath = () => join(oauthDir(), 'google-oauth-token.json');
const missingClient = 'OAuth 클라이언트 파일 없음(설정 안내: scripts/tools/google-oauth-setup.mjs)';
let cached = null;
export const hasRequiredScopes = (grantedScope, requiredScopes = OAUTH_SCOPES) => {
  const granted = new Set(typeof grantedScope === 'string' ? grantedScope.split(/\s+/) : []);
  return requiredScopes.every((required) => (Array.isArray(required) ? required : [required]).some((value) => granted.has(value)));
};
const insufficientScopes = '권한 범위 부족 — google-oauth-setup 다시 실행';

export function loadClient(path = clientPath()) {
  try {
    const installed = JSON.parse(readFileSync(path, 'utf8')).installed;
    if (typeof installed?.client_id !== 'string' || !installed.client_id || typeof installed?.client_secret !== 'string' || !installed.client_secret) throw new Error('invalid client');
    return installed;
  } catch { throw new Error(missingClient); }
}

export function isConfigured() { return existsSync(clientPath()) && existsSync(tokenPath()); }

export async function getAccessToken({ fetchImpl = fetch, now = Date.now, requiredScopes = [] } = {}) {
  const current = typeof now === 'function' ? now() : now;
  const path = tokenPath();
  if (cached?.path === path && current < cached.expiresAt - 60_000) {
    if (!hasRequiredScopes(cached.scope, requiredScopes)) throw new Error(insufficientScopes);
    return cached.accessToken;
  }
  const client = loadClient();
  let stored;
  try { stored = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('OAuth 토큰 파일 없음 — google-oauth-setup 필요'); }
  const refreshToken = stored.refresh_token;
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
  if (typeof data.scope !== 'string') throw new Error(insufficientScopes);
  if (stored.scope !== data.scope) {
    const temporary = join(dirname(path), `.google-oauth-token-${randomBytes(8).toString('hex')}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify({ ...stored, scope: data.scope }) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* 원래 오류를 유지한다. */ }
      throw error;
    }
  }
  if (!hasRequiredScopes(data.scope, requiredScopes)) throw new Error(insufficientScopes);
  cached = { path, accessToken: data.access_token, scope: data.scope, expiresAt: current + Number(data.expires_in) * 1000 };
  return cached.accessToken;
}
