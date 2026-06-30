import { createServer } from 'http';
import { exec } from 'child_process';
import { readFileSync } from 'fs';
import { createSign } from 'crypto';

export const CLIENT_ID = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
export const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const REDIRECT = 'http://localhost:8085/callback';

export const SA_KEY_FILE = process.env.SA_KEY_FILE
  || `${process.env.HOME}/.config/banana-portfolio/sa-key.json`;

const AUTH_TIMEOUT_MS = 120_000;

export function loadEnv() {
  try {
    const txt = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* .env 없으면 무시 */ }
}

export function hasServiceAccount() {
  try { readFileSync(SA_KEY_FILE); return true; } catch { return false; }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function getServiceAccountToken(keyFile = SA_KEY_FILE) {
  const key = JSON.parse(readFileSync(keyFile, 'utf8'));
  if (!key.client_email || !key.private_key) {
    throw new Error('SA 키에 client_email/private_key 없음');
  }
  const aud = key.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(key.private_key))}`;
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`SA 토큰 교환 실패: ${await res.text()}`);
  return (await res.json()).access_token;
}

export function getTokenViaBrowser() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/callback')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body>
<p>인증 처리 중...</p>
<script>
  const p = new URLSearchParams(location.hash.slice(1));
  const t = p.get('access_token');
  if (t) {
    fetch('/token', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token: t}) })
      .then(() => { document.body.innerHTML = '<h2 style="font-family:sans-serif">✅ 인증 완료! 이 창을 닫으세요.</h2>'; });
  } else {
    document.body.innerHTML = '<h2 style="font-family:sans-serif;color:red">⚠️ 토큰을 받지 못했습니다.</h2>';
  }
</script></body></html>`);
        return;
      }
      if (req.method === 'POST' && req.url === '/token') {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          try {
            const { token } = JSON.parse(body);
            res.writeHead(200); res.end('ok');
            server.close(); clearTimeout(timer); resolve(token);
          } catch (e) {
            res.writeHead(400); res.end('bad');
            reject(new Error('토큰 파싱 실패: ' + e.message));
          }
        });
        return;
      }
      res.writeHead(404); res.end();
    });

    const timer = setTimeout(() => { server.close(); reject(new Error('OAuth 타임아웃 (2분 초과)')); }, AUTH_TIMEOUT_MS);

    server.listen(8085, () => {
      const url = `https://accounts.google.com/o/oauth2/v2/auth` +
        `?client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&response_type=token` +
        `&scope=${encodeURIComponent(SCOPE)}`;
      console.log('\n브라우저에서 Google 로그인 창을 엽니다...');
      console.log('자동으로 열리지 않으면 아래 URL을 복사:\n');
      console.log(url + '\n');
      exec(`open "${url}"`);
    });

    server.on('error', e => {
      clearTimeout(timer);
      if (e.code === 'EADDRINUSE') reject(new Error('포트 8085 사용 중. 토큰 직접 전달: <스크립트> <TOKEN>'));
      else reject(e);
    });
  });
}

// 통합 토큰 획득: 명시 토큰 > 서비스 계정(무인) > 브라우저(대화형).
// allowBrowser=false 면 무인 전용(SA 없으면 즉시 실패 — launchd 안전장치).
export async function getToken(explicit, { allowBrowser = true } = {}) {
  if (explicit) return explicit;
  if (hasServiceAccount()) return getServiceAccountToken();
  if (allowBrowser) return getTokenViaBrowser();
  throw new Error(`무인 토큰 없음: 서비스 계정 키(${SA_KEY_FILE}) 필요`);
}
