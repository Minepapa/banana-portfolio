/**
 * 공통 헬퍼 — AI 리스크 엔진 스크립트들이 공유.
 * (drain-eval-queue.mjs 의 검증된 로직을 모듈화. backfill-baselines / risk-monitor 가 import)
 *
 * 제공: loadEnv, getTokenViaBrowser, getRange, appendValues, updateCell,
 *       ensureSheet, runHeadlessClaude, readHoldings, HEADLESS_NOTE, 상수
 */

import { createServer } from 'http';
import { exec, spawn } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { createSign } from 'crypto';

export const SHEET_ID = '1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg';
export const CLIENT_ID = '107361333660-guipca83j7hqhuf0tc7l1cdilk7jgte3.apps.googleusercontent.com';
export const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const REDIRECT = 'http://localhost:8085/callback';
export const ACCOUNTS = ['위탁', '연금저축', 'ISA', 'IRP'];
const API = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
const AUTH_TIMEOUT_MS = 120_000;

// .env 로드 (DART_API_KEY 등) — 헤드리스 자식 프로세스로 전달
export function loadEnv() {
  try {
    const txt = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* .env 없으면 무시 */ }
}

// ── OAuth (implicit flow, 브라우저 팝업) ─────────────────
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

// ── 서비스 계정 인증 (완전 무인, launchd 용) ──────────────
// SA 키 JSON 으로 JWT 서명 → access token 교환. 대화형 로그인 0회.
// 키 파일 경로: 환경변수 SA_KEY_FILE 또는 기본값(아래).
export const SA_KEY_FILE = process.env.SA_KEY_FILE
  || `${process.env.HOME}/.config/banana-portfolio/sa-key.json`;

export function hasServiceAccount() {
  try { readFileSync(SA_KEY_FILE); return true; } catch { return false; }
}

// ── 사용량 한도 전역 쿨다운 ──────────────────────────────────────────────────
// claude -p 헤드리스 잡들과 대화형 Claude Code 가 단일 구독 quota 를 공유한다.
// 한 잡이 한도("You've hit your limit · resets …")를 만나면 reset 시각을 공유
// 파일에 기록하고, 모든 claude 호출 잡이 시작 시 확인해 쿨다운 중이면 조용히 skip
// → 불필요한 호출·로그 노이즈 제거.
export const COOLDOWN_FILE = process.env.COOLDOWN_FILE
  || `${process.env.HOME}/.config/banana-portfolio/quota-cooldown.json`;
export const LIMIT_RE = /hit your (limit|session limit)|usage limit|사용량 한도/i;

// 한도 메시지의 "resets 10:50am (Asia/Seoul)" → KST 기준 다음 도래 시각(ms).
// 분 생략("8pm")·이미 지난 시각(다음날 롤오버) 처리. 파싱 실패 시 null.
export function parseResetTime(message, now = Date.now()) {
  const m = String(message ?? '').match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3].toLowerCase();
  if (hour === 12) hour = 0;            // 12am→0, 12pm→12(아래서 +12)
  if (ap === 'pm') hour += 12;
  if (hour > 23 || min > 59) return null;
  // KST(UTC+9) 기준으로 오늘의 해당 시각을 UTC ms 로 환산.
  const KST = 9 * 3600_000;
  const kstNow = new Date(now + KST);
  const y = kstNow.getUTCFullYear(), mo = kstNow.getUTCMonth(), d = kstNow.getUTCDate();
  let resetUtc = Date.UTC(y, mo, d, hour, min) - KST;
  if (resetUtc <= now) resetUtc += 24 * 3600_000;   // 이미 지났으면 다음날
  return resetUtc;
}

export function setCooldown(resetAt, reason = '') {
  try {
    writeFileSync(COOLDOWN_FILE, JSON.stringify({ resetAt, reason, setAt: Date.now() }));
  } catch { /* 파일 못 쓰면 무시(쿨다운 미적용) */ }
}

// 활성 쿨다운이면 { resetAt, reason }, 아니면(없거나 만료) null. 만료 시 파일 삭제.
export function getCooldown(now = Date.now()) {
  let data;
  try { data = JSON.parse(readFileSync(COOLDOWN_FILE, 'utf8')); }
  catch { return null; }
  if (!data || typeof data.resetAt !== 'number' || now >= data.resetAt) {
    try { unlinkSync(COOLDOWN_FILE); } catch { /* noop */ }
    return null;
  }
  return { resetAt: data.resetAt, reason: data.reason || '' };
}

// 쿨다운 가드 — claude 호출 잡 시작 시 호출. 쿨다운 중이면 로그 후 true 반환(잡은 exit(0)).
export function cooldownActive() {
  const cd = getCooldown();
  if (!cd) return false;
  const when = new Date(cd.resetAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`⏳ 사용량 한도 쿨다운 중 (reset ${when}) — claude 호출 skip`);
  return true;
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

// 통합 토큰 획득: 명시 토큰 > 서비스 계정(무인) > 브라우저(대화형).
// allowBrowser=false 면 무인 전용(SA 없으면 즉시 실패 — launchd 안전장치).
export async function getToken(explicit, { allowBrowser = true } = {}) {
  if (explicit) return explicit;
  if (hasServiceAccount()) return getServiceAccountToken();
  if (allowBrowser) return getTokenViaBrowser();
  throw new Error(`무인 토큰 없음: 서비스 계정 키(${SA_KEY_FILE}) 필요`);
}

// ── HTTP 재시도 (일시적 5xx/429·네트워크 오류) ──────────────────
// Google Sheets/네트워크 일시 오류(503 UNAVAILABLE 등)로 시트 쓰기가 throw 되면
// 비싼 평가 결과가 통째로 유실된다(실제: claude 5분 평가 후 appendValues 503 → 카드 소실).
// 시트 REST 호출을 짧은 지수 백오프로 재시도해 유실을 막는다.
// (Google 공식 권장: 5xx/429 는 exponential backoff 재시도.)
//
// 멱등성 주의: getRange/updateCell/setValues 등은 멱등이라 재시도가 안전하다. 단 appendValues
// 는 비멱등 POST 다. 503(UNAVAILABLE)은 '요청 미처리'라 재시도해도 중복이 없지만(우리 사고도
// 미적재 503 이었다), 504(DEADLINE)·네트워크 단절은 서버가 이미 행을 커밋한 뒤 응답만 유실됐을
// 수 있어 append 재시도가 at-least-once 가 된다(드물게 중복 행). 평가 카드는 '유실=비싼 재평가
// (claude 수 분)' vs '중복=앱이 최신 카드만 표시·정리 쉬움' 이라, 중복을 감수하고 유실을 막는
// 쪽이 명백히 이득 → append 도 동일 재시도 대상으로 둔다. (recover-evals 는 name+date 로 dedupe.)
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function defaultOnRetry(n, delayMs, err) {
  console.warn(`   ⏳ 시트 호출 일시오류(${err?.message || '?'}) — ${(delayMs / 1000).toFixed(1)}s 후 재시도 (${n})`);
}

// fetch 래퍼: 재시도성 상태/네트워크 오류면 지수 백오프 후 재시도.
// 성공·비재시도성(4xx 등)·재시도 소진 시엔 Response 를 그대로 반환 → 호출부의
// `if (!res.ok) throw` 가 기존과 동일하게 동작(에러 메시지 보존). 네트워크 오류가
// 끝까지 지속되면 마지막 예외를 throw. fetchImpl/sleep/onRetry 는 테스트 주입용(DI).
// retries=4 → 최초 1회 + 재시도 4회 = 최대 5회 시도(누적 백오프 최악 ~8.5s, 헤드리스 12분 내 무해).
export async function fetchRetry(url, opts = {}, {
  retries = 4,
  baseDelayMs = 500,
  fetchImpl = fetch,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  onRetry = defaultOnRetry,
} = {}) {
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(url, opts);
      if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt >= retries) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (attempt >= retries) throw e;   // 네트워크 오류 — 재시도 소진
      lastErr = e;
    }
    const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
    onRetry?.(attempt + 1, delay, lastErr);
    await sleep(delay);
  }
}

// ── Sheets REST ────────────────────────────────────────
export async function getRange(token, range) {
  const res = await fetchRetry(`${API}/values/${encodeURIComponent(range)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`범위 조회 실패 (${range}): ${await res.text()}`);
  return (await res.json()).values || [];
}

// 표시형식과 무관하게 원본값을 읽는다(UNFORMATTED_VALUE). 날짜=직렬수, 숫자=수.
// 날짜 셀이 '날짜전용' 서식이어도 직렬값엔 시각이 남아있어 시각 복원에 쓴다.
export async function getRangeRaw(token, range) {
  const res = await fetchRetry(`${API}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`원본 범위 조회 실패 (${range}): ${await res.text()}`);
  return (await res.json()).values || [];
}

export async function appendValues(token, range, values) {
  const res = await fetchRetry(
    `${API}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) throw new Error(`append 실패 (${range}): ${await res.text()}`);
  return res.json();
}

export async function updateCell(token, range, value) {
  const res = await fetchRetry(
    `${API}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[value]] }),
    }
  );
  if (!res.ok) throw new Error(`셀 업데이트 실패 (${range}): ${await res.text()}`);
}

// 범위에 2차원 배열을 덮어쓴다(PUT). appendValues 와 달리 기존 셀을 갱신.
export async function setValues(token, range, values) {
  const res = await fetchRetry(
    `${API}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) throw new Error(`범위 쓰기 실패 (${range}): ${await res.text()}`);
}

// 범위의 값을 비운다(서식은 유지).
export async function clearValues(token, range) {
  const res = await fetchRetry(`${API}/values/${encodeURIComponent(range)}:clear`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`범위 비우기 실패 (${range}): ${await res.text()}`);
}

async function listSheetTitles(token) {
  const res = await fetchRetry(`${API}?fields=sheets.properties.title`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`시트 목록 조회 실패: ${await res.text()}`);
  return ((await res.json()).sheets || []).map(s => s.properties.title);
}

// 시트 제목 → 숫자 sheetId (batchUpdate 서식 요청에 필요)
export async function getSheetIdByTitle(token, title) {
  const res = await fetchRetry(`${API}?fields=sheets.properties(sheetId,title)`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`시트 ID 조회 실패: ${await res.text()}`);
  const s = ((await res.json()).sheets || []).find(x => x.properties.title === title);
  return s ? s.properties.sheetId : null;
}

// 지정 행 범위(1-based, 양끝 포함)의 A열 배경을 흰색으로 리셋.
// append(INSERT_ROWS)는 위 행 서식을 상속한다 → 위가 '처리완료(초록)'면 새 체결행이
// 초록으로 태어나 앱이 '처리완료'로 오인·스킵한다. 이를 방지해 항상 미처리(흰색)로 둔다.
export async function clearColumnABackground(token, title, startRow1, endRow1) {
  const sheetId = await getSheetIdByTitle(token, title);
  if (sheetId == null) throw new Error(`시트 없음: ${title}`);
  const res = await fetchRetry(`${API}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{
      repeatCell: {
        range: { sheetId, startRowIndex: startRow1 - 1, endRowIndex: endRow1, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    }] }),
  });
  if (!res.ok) throw new Error(`배경 리셋 실패 (${title} A${startRow1}:A${endRow1}): ${await res.text()}`);
}

// 탭이 없으면 생성하고 헤더 적재. 반환: 새로 만들었으면 true
export async function ensureSheet(token, title, header) {
  const titles = await listSheetTitles(token);
  if (titles.includes(title)) return false;
  const res = await fetchRetry(`${API}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
  if (!res.ok) throw new Error(`탭 생성 실패 (${title}): ${await res.text()}`);
  if (header) await appendValues(token, `${title}!A1`, [header]);
  console.log(`   🆕 탭 생성: ${title}`);
  return true;
}

// ── 보유종목 읽기 (4계좌) → 티커 기준 dedupe ───────────
// 계좌 시트 A2:I: [자산군(병합), 종목명, 평균단가, 수량, 투자금, ...]
// 반환: [{ name, ticker, market, accounts:[...], type }]
export async function readHoldings(token) {
  const map = new Map();
  for (const acct of ACCOUNTS) {
    const rows = await getRange(token, `${acct}!A2:I`);
    let lastType = '';
    for (const r of rows) {
      const t = String(r[0] ?? '').trim();
      if (t) lastType = t;
      const name = String(r[1] ?? '').trim();
      if (!name) continue;
      // 종목명 열이 비어도 자산군 헤더 행은 건너뜀: 수량/투자금 둘 다 0이면 스킵
      const qty = parseFloat(String(r[3] ?? '').replace(/[,%]/g, '')) || 0;
      const invest = parseFloat(String(r[4] ?? '').replace(/[,%]/g, '')) || 0;
      if (qty <= 0 && invest <= 0) continue;
      const key = name;
      if (!map.has(key)) {
        map.set(key, { name, ticker: '', market: lastType.includes('해외') || lastType.includes('미국') ? 'US' : 'KR', accounts: [], type: lastType });
      }
      map.get(key).accounts.push({ acct, type: lastType, qty, invest });
    }
  }
  return [...map.values()];
}

// ── 헤드리스 claude -p ─────────────────────────────────
export const HEADLESS_NOTE = `

[⚙️ 실행환경: 헤드리스 자동화 — MCP 도구 사용 불가. 모든 데이터는 Bash로 직접 조회할 것]
- HTTPS 호출은 python urllib 말고 반드시 curl 사용 (이 환경 python은 SSL 인증서 검증 실패함)
- KR 재무지표: OpenDart REST를 curl로 호출 (API 키는 환경변수 $DART_API_KEY 사용)
  · 재무비율: curl "https://opendart.fss.or.kr/api/fnlttSinglIndx.json?crtfc_key=$DART_API_KEY&corp_code={고유번호8자리}&bsns_year={연도}&reprt_code={사업11011·1Q11013·반기11012·3Q11014}&idx_cl_code={수익성M210000·안정성M220000·성장성M230000·활동성M240000}"
  · 단일회사 전체재무제표: .../fnlttSinglAcntAll.json (동일 파라미터 + fs_div=CFS)
  · 고유번호(corp_code) 모르면 종목코드로 매핑 (pykrx 또는 알려진 값 사용; 삼성전자=00126380)
- KR 시세/RSI(14)/52주: python3 pykrx 또는 curl Naver JSON (api.finance.naver.com/siseJson.naver?symbol={코드}&requestType=1&timeframe=day)
- US 재무/시세: python3 yfinance (yf.Ticker("AAPL").info / .quarterly_financials / .history)
- 거시지표: USDKRW=yf "KRW=X", 미10년물=yf "^TNX", VIX=yf "^VIX", KOSPI=yf "^KS11", S&P500=yf "^GSPC"
- 데이터를 못 구하면 추정 금지, 해당 항목에 "(데이터 부족: 소스)" 표기`;

export function runHeadlessClaude(prompt, model = 'sonnet', allowedTools = 'Bash,Read,Glob,Grep,WebFetch') {
  return new Promise((resolve, reject) => {
    const cp = spawn('claude', [
      '-p', prompt,
      '--permission-mode', 'bypassPermissions',
      '--allowedTools', allowedTools,
      '--model', model,
      '--output-format', 'text',
      // stdin 은 /dev/null(ignore)로 둬 즉시 EOF → "no stdin data received in 3s" 경고·3초 대기 제거.
    ], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { cp.kill('SIGKILL'); reject(new Error('헤드리스 타임아웃 (12분 초과)')); }, 12 * 60 * 1000);
    cp.stdout.on('data', d => { out += d; });
    cp.stderr.on('data', d => { err += d; });
    cp.on('error', e => { clearTimeout(timer); reject(e); });
    cp.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        // stdin 경고 같은 노이즈를 걸러내고, 실제 에러는 끝부분에 오므로 꼬리 300자를 노출.
        const clean = err.split('\n').filter(l => !/no stdin data received/i.test(l)).join('\n').trim();
        const detail = ((clean || out).trim().slice(-300)) || '(stderr/stdout 비어있음)';
        const e = new Error(`claude 종료코드 ${code}: ${detail}`);
        // 사용량 한도 → 전역 쿨다운 설정 + isLimit 태그(호출 잡이 남은 작업 중단).
        if (LIMIT_RE.test(detail)) {
          e.isLimit = true;
          setCooldown(parseResetTime(detail) ?? Date.now() + 3600_000, detail);
        }
        return reject(e);
      }
      if (!out.trim()) return reject(new Error('claude 빈 출력'));
      resolve(out);
    });
  });
}

// ── JSON 블록 파싱 ─────────────────────────────────────
export function parseJsonBlock(text) {
  const fence = text.match(/```json\s*([\s\S]*?)\s*```/i) || text.match(/```\s*([\s\S]*?)\s*```/);
  let candidate = fence ? fence[1] : text;
  const first = candidate.search(/[[{]/);
  if (first < 0) throw new Error('JSON 블록을 찾지 못했습니다.');
  // 객체/배열 중 먼저 등장하는 것 기준으로 끝 괄호 탐색
  const openCh = candidate[first];
  const closeCh = openCh === '[' ? ']' : '}';
  const last = candidate.lastIndexOf(closeCh);
  if (last < 0) throw new Error('JSON 닫는 괄호를 찾지 못했습니다.');
  return JSON.parse(candidate.slice(first, last + 1));
}

export function nowKST() {
  return new Date(Date.now() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
}
export function todayKST() {
  return nowKST().slice(0, 10);
}

// ── 텔레그램 푸시 (telegram 채널 설정 재사용) ─────────────
// 🔴 경보 등 즉시 알림용. 봇 토큰은 채널 .env, 수신 chat_id 는 access.json allowFrom 에서 로드.
const TG_ENV = `${process.env.HOME}/.claude/channels/telegram/.env`;
const TG_ACCESS = `${process.env.HOME}/.claude/channels/telegram/access.json`;

export function loadTelegramConfig() {
  const env = readFileSync(TG_ENV, 'utf8');
  const m = env.match(/TELEGRAM_BOT_TOKEN\s*=\s*(\S+)/);
  if (!m) throw new Error('TELEGRAM_BOT_TOKEN 누락 (channels/telegram/.env)');
  const access = JSON.parse(readFileSync(TG_ACCESS, 'utf8'));
  const chatId = (access.allowFrom || [])[0];
  if (!chatId) throw new Error('수신 chat_id 누락 (access.json allowFrom)');
  return { botToken: m[1], chatId };
}

export async function sendTelegram(text, chatId) {
  const cfg = loadTelegramConfig();
  const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId || cfg.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) throw new Error(`텔레그램 전송 실패: ${await res.text()}`);
  return res.json();
}
