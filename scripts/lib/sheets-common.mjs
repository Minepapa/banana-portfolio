/**
 * 공통 헬퍼 — AI 리스크 엔진 스크립트들이 공유.
 * (drain-eval-queue.mjs 의 검증된 로직을 모듈화. backfill-baselines / risk-monitor 가 import)
 *
 * 제공: loadEnv, getTokenViaBrowser, getRange, appendValues, updateCell,
 *       ensureSheet, runHeadlessClaude, readHoldings, HEADLESS_NOTE, 상수
 */

import { createServer } from 'http';
import { exec, spawn } from 'child_process';
import { readFileSync } from 'fs';

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

// ── Sheets REST ────────────────────────────────────────
export async function getRange(token, range) {
  const res = await fetch(`${API}/values/${encodeURIComponent(range)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`범위 조회 실패 (${range}): ${await res.text()}`);
  return (await res.json()).values || [];
}

export async function appendValues(token, range, values) {
  const res = await fetch(
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
  const res = await fetch(
    `${API}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[value]] }),
    }
  );
  if (!res.ok) throw new Error(`셀 업데이트 실패 (${range}): ${await res.text()}`);
}

async function listSheetTitles(token) {
  const res = await fetch(`${API}?fields=sheets.properties.title`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`시트 목록 조회 실패: ${await res.text()}`);
  return ((await res.json()).sheets || []).map(s => s.properties.title);
}

// 탭이 없으면 생성하고 헤더 적재. 반환: 새로 만들었으면 true
export async function ensureSheet(token, title, header) {
  const titles = await listSheetTitles(token);
  if (titles.includes(title)) return false;
  const res = await fetch(`${API}:batchUpdate`, {
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

export function runHeadlessClaude(prompt, model = 'sonnet') {
  return new Promise((resolve, reject) => {
    const cp = spawn('claude', [
      '-p', prompt,
      '--permission-mode', 'bypassPermissions',
      '--allowedTools', 'Bash,Read,Glob,Grep,WebFetch',
      '--model', model,
      '--output-format', 'text',
    ], { env: { ...process.env } });
    let out = '', err = '';
    const timer = setTimeout(() => { cp.kill('SIGKILL'); reject(new Error('헤드리스 타임아웃 (12분 초과)')); }, 12 * 60 * 1000);
    cp.stdout.on('data', d => { out += d; });
    cp.stderr.on('data', d => { err += d; });
    cp.on('error', e => { clearTimeout(timer); reject(e); });
    cp.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude 종료코드 ${code}: ${err.slice(0, 200)}`));
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
