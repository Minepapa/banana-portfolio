#!/usr/bin/env node
// NH PLUG(나무 Namuh) API 크리덴셜 입력용 로컬 웹서버 — 2026-09-01 신설.
//
// 오너 지시: "터미널 명령을 나에게 입력하게 하거나, 파일을 직접 편집하라고 시키지
// 말고... 입력해야 할 값이 있으면 가능한 한 웹사이트 화면을 띄워서 친절한 설명과
// 함께 입력할 수 있게 해줘." — APP KEY/APP SECRET을 대화창에 붙여넣게 하면 세션
// 로그에 그대로 남는다. 대신 로컬(127.0.0.1 전용, 외부 노출 없음)에 폼 페이지를
// 띄우고 브라우저에서 직접 입력받아 그 자리에서 파일로 저장한다
// (vendor/nhplug-auto-trader의 setup.py가 쓰는 것과 같은 패턴 — 표준 라이브러리만
// 사용, 서버 프레임워크 불필요).
//
// 저장 위치: ~/.config/banana-portfolio/nhplug-key.json — 기존 kis-key.json과
// 같은 디렉토리 관례(scripts/lib/kis.mjs KIS_KEY_FILE 참고).
//
// ⚠️ 보안 강화(2026-09-01 코드리뷰 MEDIUM 지적 반영) — 이 서버는 127.0.0.1에만
// 바인딩돼 외부 네트워크에서는 애초에 못 닿지만, 같은 기기 안에서는:
//   1) 다른 로컬 프로세스가 /save에 직접 POST하거나
//   2) 오너가 열어둔 다른 탭의 악성 페이지가 CORS "simple request"로 이 엔드포인트에
//      조용히 폼을 제출하거나(POST 응답을 못 읽어도 공격자는 그럴 필요가 없음 —
//      값을 "쓰기만" 하면 되므로)
// 오너가 붙여넣지 않은 값이 크리덴셜 파일에 들어갈 수 있었다. 서버 시작 시 1회용
// 난수 토큰을 발급해 폼에 숨겨 넣고 제출 시 대조(CSRF 토큰), Origin/Host 헤더도
// 함께 확인해 방어를 이중화한다. 5분 동안 아무도 제출 안 하면 자동 종료(방치된
// 서버가 무기한 열려있지 않게).
//
// 사용법: node scripts/setup/nhplug-credential-setup.mjs
//   → http://127.0.0.1:{PORT} 안내 후 브라우저로 열어 입력 → 저장되면 서버 자동 종료.
//   (CSRF 토큰은 GET 응답 폼에 숨은 필드로 자동 포함됨 — URL에 안 실어도 됨)
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const KEY_FILE = `${homedir()}/.config/banana-portfolio/nhplug-key.json`;
const PORT = 8765;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const AUTH_TOKEN = randomBytes(16).toString('hex'); // 서버 인스턴스마다 새로 발급 — CSRF 방지
const MAX_BODY_BYTES = 8 * 1024; // 두 필드면 충분, 그 이상은 비정상 요청으로 간주
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 방치된 서버가 무기한 안 열려있게

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(message = '') {
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<title>NH PLUG 크리덴셜 설정</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 560px; margin: 60px auto; padding: 0 20px; color: #222; }
  h1 { font-size: 20px; }
  p.hint { color: #666; font-size: 14px; line-height: 1.6; }
  label { display: block; margin-top: 18px; font-weight: 600; font-size: 14px; }
  input { width: 100%; box-sizing: border-box; padding: 10px; margin-top: 6px; font-size: 14px;
          border: 1px solid #ccc; border-radius: 6px; }
  button { margin-top: 24px; padding: 12px 20px; font-size: 15px; background: #1b5e20; color: #fff;
           border: none; border-radius: 6px; cursor: pointer; }
  .msg { margin-top: 16px; padding: 10px; border-radius: 6px; background: #fff3e0; color: #e65100; font-size: 14px; }
</style></head>
<body>
  <h1>NH PLUG(나무 Namuh) API 키 입력</h1>
  <p class="hint">nhplug.com에서 발급받은 APP KEY / APP SECRET을 붙여넣어주세요.
  이 페이지는 이 컴퓨터에서만 열리고(127.0.0.1), 저장 즉시 서버가 종료됩니다.
  실전·모의투자 둘 다 이 키 하나로 씁니다(base URL만 달라짐).</p>
  ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ''}
  <form method="POST" action="/save">
    <input type="hidden" name="token" value="${AUTH_TOKEN}">
    <label>APP KEY</label>
    <input type="password" name="appkey" autocomplete="off" required>
    <label>APP SECRET</label>
    <input type="password" name="appsecret" autocomplete="off" required>
    <button type="submit">저장</button>
  </form>
</body></html>`;
}

let idleTimer;
function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log('⏳ 5분간 입력 없음 — 서버 종료');
    server.close(() => process.exit(0));
  }, IDLE_TIMEOUT_MS);
  idleTimer.unref();
}

// Origin·Host 검증 — CORS simple request(폼 POST)는 브라우저가 Origin 헤더를 붙여서
// 보내므로, 이 값이 우리 자신이 아니면 다른 탭·페이지에서 온 요청으로 간주해 거부.
// 같은 탭에서 정상적으로 폼을 제출하면 Origin이 없을 수도 있어(direct navigation)
// 그 경우는 통과시키고, 대신 아래 AUTH_TOKEN 대조가 실질적 방어선.
export function isSameOrigin(req) {
  if (req.headers.host !== `127.0.0.1:${PORT}`) return false;
  if (req.headers.origin && req.headers.origin !== ORIGIN) return false;
  return true;
}

const server = createServer((req, res) => {
  resetIdleTimer();

  if (!isSameOrigin(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('요청 출처가 이 서버 자신이 아님 — 거부');
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page());
    return;
  }
  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    let tooLarge = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return; // req.destroy()가 이미 소켓을 끊음 — 응답 불필요
      const params = new URLSearchParams(body);
      if (params.get('token') !== AUTH_TOKEN) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('토큰 불일치 — 이 서버가 발급한 폼에서 제출된 요청이 아님');
        return;
      }
      const appkey = (params.get('appkey') || '').trim();
      const appsecret = (params.get('appsecret') || '').trim();
      if (!appkey || !appsecret) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('APP KEY·APP SECRET 둘 다 입력해주세요.'));
        return;
      }
      mkdirSync(dirname(KEY_FILE), { recursive: true });
      // mode 0o600을 writeFileSync 시점에 바로 지정 — 이전엔 mode 없이 썼다가
      // chmodSync로 뒤늦게 좁혀서, 그 사이(생성~chmod) 짧은 창에서 umask 022 환경이면
      // 파일이 0644(다른 로컬 사용자도 읽기 가능)로 잠깐 노출됐다(2026-09-01 코드리뷰
      // MEDIUM 지적 — 실측: 이 파일 최초 버전도 이 창 때문에 세계-읽기 가능한 채로
      // 생성됐었음). chmodSync는 이미 존재하던 파일(예: 재실행)의 권한도 좁히기 위해
      // 그대로 유지.
      writeFileSync(KEY_FILE, JSON.stringify({ appkey, appsecret }, null, 2) + '\n', { mode: 0o600 });
      chmodSync(KEY_FILE, 0o600);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>저장 완료</title>
        <style>body{font-family:-apple-system,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#222}</style>
        </head><body><h1>저장 완료</h1><p>${escapeHtml(KEY_FILE)}</p><p>이 탭은 닫으셔도 됩니다.</p></body></html>`);
      console.log(`✅ 저장됨: ${KEY_FILE}`);
      clearTimeout(idleTimer);
      setTimeout(() => { server.close(); process.exit(0); }, 500);
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ 포트 ${PORT}가 이미 사용 중입니다 — 이전에 띄운 설정 서버가 아직 떠있는지 확인하세요 (lsof -i :${PORT}).`);
  } else {
    console.error('❌ 서버 오류:', e.message);
  }
  process.exit(1);
});

// import.meta.url 가드 — escapeHtml·isSameOrigin을 테스트가 직접 import한다(2026-09-01
// 코드리뷰 지적으로 테스트 신설). 가드 없이 최상위에서 listen()을 부르면 테스트가
// 이 모듈을 import하는 순간 실제로 포트 8765를 점유해버린다(다른 잡들의 동일한
// import.meta.url 가드 관례와 같은 이유).
if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, '127.0.0.1', () => {
    resetIdleTimer();
    console.log(`${ORIGIN}/ 에서 대기 중... (5분간 미입력 시 자동 종료)`);
  });
}
