// 한국투자증권(KIS) Open API 클라이언트 — 보유종목 실시간 시세 조회 전용(주문 API 미사용).
// 크리덴셜은 sa-key.json과 동일 컨벤션(scripts/lib/auth.mjs SA_KEY_FILE 미러링):
// ~/.config/banana-portfolio/kis-key.json, {appkey, appsecret}.
//
// 토큰(POST /oauth2/tokenP) 유효기간 1일, 공식 예제(kis_auth.py) 주석: "6시간 이내 발급시
// 기존 token값 유지" — 그래도 30초 주기 폴링마다 재발급하면 낭비이므로 파일 캐시로 만료
// 임박 전까지 재사용한다(job-alerts.mjs STATE_FILE과 동일 위치 관례: scripts/.cache/, gitignore됨).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export const KIS_KEY_FILE = process.env.KIS_KEY_FILE
  || `${process.env.HOME}/.config/banana-portfolio/kis-key.json`;
const TOKEN_CACHE_FILE = join(HERE, '..', '.cache', 'kis-token.json');
const BASE_URL = 'https://openapi.koreainvestment.com:9443';
const TOKEN_MARGIN_MS = 30 * 60 * 1000; // 만료 30분 전까지만 캐시 재사용

export function hasKisCredentials() {
  try { readFileSync(KIS_KEY_FILE); return true; } catch { return false; }
}

export function loadKisCredentials(keyFile = KIS_KEY_FILE) {
  const { appkey, appsecret } = JSON.parse(readFileSync(keyFile, 'utf8'));
  if (!appkey || !appsecret) throw new Error(`${keyFile}에 appkey/appsecret 없음`);
  return { appkey, appsecret };
}

// KIS access_token_token_expired 형식("YYYY-MM-DD HH:MM:SS", KST 벽시계) → epoch ms.
// 순수함수 — 테스트 가능. 형식이 안 맞으면 0(즉시 만료 취급 — 안전한 쪽으로 폴백).
export function parseKisExpiry(expiredStr) {
  const m = String(expiredStr ?? '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return Date.UTC(y, mo - 1, d, h - 9, mi, s); // KST(UTC+9) 벽시계 → UTC epoch
}

function readTokenCache() {
  try { return JSON.parse(readFileSync(TOKEN_CACHE_FILE, 'utf8')); } catch { return null; }
}
function writeTokenCache(data) {
  mkdirSync(dirname(TOKEN_CACHE_FILE), { recursive: true });
  writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(data));
}

export async function getKisToken({ appkey, appsecret, fetchImpl = fetch }) {
  const cached = readTokenCache();
  if (cached && cached.expiresAt - Date.now() > TOKEN_MARGIN_MS) return cached.token;

  const res = await fetchImpl(`${BASE_URL}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey, appsecret }),
  });
  if (!res.ok) throw new Error(`KIS 토큰 발급 실패: ${await res.text()}`);
  const body = await res.json();
  if (!body.access_token) throw new Error('KIS 토큰 응답에 access_token 없음');
  const expiresAt = parseKisExpiry(body.access_token_token_expired);
  writeTokenCache({ token: body.access_token, expiresAt });
  return body.access_token;
}

// KIS 국내주식 현재가(inquire-price) 원본 응답 → {price, changePct}. 네트워크와 분리된
// 순수함수 — 테스트 가능. rt_cd!=='0'(KIS 성공 코드) 또는 현재가 파싱 실패면 throw.
export function parseQuoteResponse(json) {
  if (json?.rt_cd !== '0') throw new Error(`KIS 시세 오류: ${json?.msg1 || json?.rt_cd || '알 수 없음'}`);
  const price = Number(json?.output?.stck_prpr);
  if (!(price > 0)) throw new Error('KIS 응답에 유효한 현재가 없음');
  const changePctRaw = json?.output?.prdy_ctrt;
  const changePct = changePctRaw !== undefined && changePctRaw !== '' ? Number(changePctRaw) : NaN;
  return { price, changePct: Number.isFinite(changePct) ? changePct : null };
}

// KIS 해외주식 현재체결가(overseas-price/quotations/price) 원본 응답 → {price, changePct}.
// 응답 envelope(rt_cd/msg_cd/msg1)은 국내와 동일, output 필드명만 다름(last/rate — 확인:
// examples_llm/overseas_stock/price/chk_price.py COLUMN_MAPPING). 순수함수 — 테스트 가능.
export function parseUsQuoteResponse(json) {
  if (json?.rt_cd !== '0') throw new Error(`KIS 해외 시세 오류: ${json?.msg1 || json?.rt_cd || '알 수 없음'}`);
  const price = Number(json?.output?.last);
  if (!(price > 0)) throw new Error('KIS 해외 응답에 유효한 현재가 없음');
  const changePctRaw = json?.output?.rate;
  const changePct = changePctRaw !== undefined && changePctRaw !== '' ? Number(changePctRaw) : NaN;
  return { price, changePct: Number.isFinite(changePct) ? changePct : null };
}

// 국내·해외 정규장 개장 여부. Intl 타임존 변환이 DST를 자동 반영하므로(America/New_York이
// EST/EDT 전환을 tzdata로 처리) 수동 서머타임 계산이 필요 없다 — 각 시간대의 "그 지역
// 로컬 요일"을 직접 물어보므로 자정을 넘나드는 케이스(예: 미국장이 KST 기준 토요일 새벽까지
// 이어지는 경우)도 별도 분기 없이 올바르게 처리된다. 공휴일은 반영하지 않음(기존
// parse-notifications 평일 게이트와 동일한 한계 — 알려진 제약).
function localDowAndHHMM(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const dowMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { dow: dowMap[parts.weekday], hhmm: Number(parts.hour) * 100 + Number(parts.minute) };
}

export function isKrMarketOpen(date = new Date()) {
  const { dow, hhmm } = localDowAndHHMM(date, 'Asia/Seoul');
  return dow <= 5 && hhmm >= 900 && hhmm <= 1530;
}

export function isUsMarketOpen(date = new Date()) {
  const { dow, hhmm } = localDowAndHHMM(date, 'America/New_York');
  return dow <= 5 && hhmm >= 930 && hhmm <= 1600;
}

// KIS는 레이트리밋을 HTTP 200 + 바디 안 msg_cd로 알린다(HTTP status로는 못 잡음).
// 실측(2026-07): 종목 14개를 200ms 간격으로 순차 호출해도 무작위로 걸림 — 공식 문서에
// 정확한 초당 한도가 안 나와 있어("초당 거래건수 초과 EGW00201"만 언급) 재시도로 흡수한다.
const KIS_RATE_LIMIT_CODE = 'EGW00201';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// GET + 레이트리밋 재시도 공통 로직(국내·해외 시세 조회가 공유). URL·tr_id·헤더만 다르므로
// 재시도 루프 자체를 두 번 따로 유지하면 한쪽만 고치는 회귀 위험이 있어 여기로 뽑아둔다.
// label: 에러 메시지에 넣을 종목 식별자(코드/티커) — 호출측(realtime-quotes.mjs)이 이미
// h.name으로 감싸긴 하지만, 라이브러리 함수 자체의 에러도 어떤 조회였는지 알 수 있어야
// 다른 호출측이 붙어도(예: 향후 order-proposals.mjs 등) 맥락이 안 사라진다.
async function fetchKisQuote(url, headers, label, { fetchImpl = fetch, retries = 2, retryDelayMs = 700 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`KIS 시세 조회 실패(${label}): ${await res.text()}`);
    const json = await res.json();
    if (json?.msg_cd === KIS_RATE_LIMIT_CODE && attempt < retries) {
      await sleep(retryDelayMs * (attempt + 1));
      continue;
    }
    return json;
  }
}

// 국내주식 현재가 조회. code: 6자리 종목코드(scripts/lib/instruments.mjs krStockCode 결과).
// tr_id FHKST01010100 확인: github.com/koreainvestment/open-trading-api
// examples_user/domestic_stock/domestic_stock_functions.py inquire_price().
export async function getKrQuote({ token, appkey, appsecret, code, fetchImpl, retries, retryDelayMs }) {
  const url = `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price`
    + `?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${encodeURIComponent(code)}`;
  const headers = {
    'Content-Type': 'application/json',
    authorization: `Bearer ${token}`,
    appkey, appsecret,
    tr_id: 'FHKST01010100',
    custtype: 'P',
  };
  const json = await fetchKisQuote(url, headers, code, { fetchImpl, retries, retryDelayMs });
  return parseQuoteResponse(json);
}

// 해외주식 현재체결가 조회. excd: 거래소코드(NAS/NYS/AMS 등, scripts/lib/instruments.mjs
// usExchange 결과), symb: 티커(usTicker 결과). tr_id HHDFS00000300, 파라미터 AUTH/EXCD/SYMB
// 확인: github.com/koreainvestment/open-trading-api examples_llm/overseas_stock/price/price.py.
export async function getUsQuote({ token, appkey, appsecret, excd, symb, fetchImpl, retries, retryDelayMs }) {
  const url = `${BASE_URL}/uapi/overseas-price/v1/quotations/price`
    + `?AUTH=&EXCD=${encodeURIComponent(excd)}&SYMB=${encodeURIComponent(symb)}`;
  const headers = {
    'Content-Type': 'application/json',
    authorization: `Bearer ${token}`,
    appkey, appsecret,
    tr_id: 'HHDFS00000300',
    custtype: 'P',
  };
  const json = await fetchKisQuote(url, headers, `${excd}:${symb}`, { fetchImpl, retries, retryDelayMs });
  return parseUsQuoteResponse(json);
}

// 보유종목 + 이번 폴링 시세결과 + 직전 실시간시세 행 → 시트에 쓸 행 배열.
// 이번에 실패한 종목은 직전 행을 그대로 carry-forward(사라지지 않음, 갱신시각도 안 바뀜 —
// 프론트 "N초 전" 표시가 그 종목만 자연히 stale로 읽히게). holdings 항목은 {name, code,
// market}(market: 'KR'|'US', 프론트가 ₩/$ 표시를 가르는 데 씀). 순수함수 — 테스트 가능
// (네트워크 결과·현재시각을 전부 인자로 받음, 내부에서 직접 조회하지 않음).
export function buildRealtimeRows(holdings, quotes, prevRows, nowStr) {
  const prevByName = new Map((prevRows || []).map(r => [String(r[0] ?? '').trim(), r]));
  const rows = [];
  for (const h of holdings) {
    const q = quotes.get(h.name);
    if (q) {
      // 종목코드 앞에 ' 접두 — setValues가 USER_ENTERED라 그냥 쓰면 "005930"이 숫자 5930으로
      // 해석돼 앞자리 0이 사라진다(이 컬럼을 다시 읽는 코드는 없어 기능상 무해하지만 표시는 고쳐둠).
      // US 티커(알파벳)엔 불필요하지만 접두해도 무해 — 분기 없이 통일.
      rows.push([h.name, h.market, `'${h.code}`, q.price, q.changePct ?? '', nowStr]);
    } else {
      const prev = prevByName.get(h.name);
      if (prev) rows.push(prev);
    }
  }
  return rows;
}
