// 한국투자증권(KIS) Open API 클라이언트 — 시세 조회·계좌 잔고조회 전용(주문 API 미사용,
// 자동매매는 이 모듈의 범위 밖). 크리덴셜은 sa-key.json과 동일 컨벤션(scripts/lib/auth.mjs
// SA_KEY_FILE 미러링): ~/.config/banana-portfolio/kis-key.json, {appkey, appsecret,
// irpAccount?: {cano, acntPrdtCd, appkey, appsecret}}.
//
// irpAccount에 appkey/appsecret이 별도로 있는 이유: KIS 개발자센터가 앱키를 계좌 단위로
// 등록시킨다(2026-07 실측 — 최상위 appkey로 IRP 잔고조회를 했더니 INVALID_CHECK_ACNO로
// 거부됐고, IRP 계좌를 별도로 신청해 발급받은 앱키로 바꾸니 그제서야 계좌 검증을 통과함).
// 즉 최상위 appkey(시세 조회용, 모든 종목 공용)와 irpAccount.appkey(그 IRP 계좌 전용)는
// 서로 다른 KIS 앱이다 — 토큰도 앱키별로 별도 발급·캐시해야 한다(아래 getKisToken 참고).
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

// IRP 계좌번호+전용 앱키 — kis-key.json에 {..., irpAccount: {cano, acntPrdtCd, appkey, appsecret}}
// 로 로컬 등록(직접 편집, 채팅에 붙여넣지 않음 — 최상위 appkey/appsecret과 동일 취급).
// appkey/appsecret이 최상위와 별도로 필요한 이유는 파일 상단 주석 참고(계좌별 앱키 등록).
// 넷 중 하나라도 없으면 null(hasKisCredentials 없을 때와 동일하게 "아직 설정 안 함"을
// 오류로 취급하지 않기 위함 — 호출측이 이 값으로 IRP 대사 기능 자체를 조용히 skip).
export function loadIrpAccount(keyFile = KIS_KEY_FILE) {
  try {
    const { irpAccount } = JSON.parse(readFileSync(keyFile, 'utf8'));
    if (!irpAccount?.cano || !irpAccount?.acntPrdtCd || !irpAccount?.appkey || !irpAccount?.appsecret) return null;
    return {
      cano: String(irpAccount.cano), acntPrdtCd: String(irpAccount.acntPrdtCd),
      appkey: String(irpAccount.appkey), appsecret: String(irpAccount.appsecret),
    };
  } catch { return null; }
}

// KIS access_token_token_expired 형식("YYYY-MM-DD HH:MM:SS", KST 벽시계) → epoch ms.
// 순수함수 — 테스트 가능. 형식이 안 맞으면 0(즉시 만료 취급 — 안전한 쪽으로 폴백).
export function parseKisExpiry(expiredStr) {
  const m = String(expiredStr ?? '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return Date.UTC(y, mo - 1, d, h - 9, mi, s); // KST(UTC+9) 벽시계 → UTC epoch
}

// 캐시는 appkey별로 분리 보관한다(맵: {[appkey]: {token, expiresAt}}) — 이제 KIS 앱이
// 최상위(시세용)·irpAccount(계좌 전용) 최소 2개라, 단일 슬롯 캐시였다면 한쪽 앱의 토큰을
// 다른 앱의 appkey/appsecret 헤더와 섞어 보내는 사고가 난다(앱키 등록 단위와 불일치 → 인증
// 실패, 심하면 계좌A 자격증명으로 계좌B를 조회하려는 요청처럼 보일 위험).
function readTokenCache() {
  try { return JSON.parse(readFileSync(TOKEN_CACHE_FILE, 'utf8')); } catch { return {}; }
}
function writeTokenCache(map) {
  mkdirSync(dirname(TOKEN_CACHE_FILE), { recursive: true });
  writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(map));
}

export async function getKisToken({ appkey, appsecret, fetchImpl = fetch }) {
  const cache = readTokenCache();
  const cached = cache[appkey];
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
  cache[appkey] = { token: body.access_token, expiresAt };
  writeTokenCache(cache);
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

// GET + 레이트리밋 재시도 공통 로직(시세·잔고조회 등 인증된 KIS GET 호출이 전부 공유).
// URL·tr_id·헤더만 다르므로 재시도 루프 자체를 여러 번 따로 유지하면 한쪽만 고치는 회귀
// 위험이 있어 여기로 뽑아둔다. label: 에러 메시지에 넣을 식별자(종목코드/티커/계좌번호 등) —
// 호출측이 이미 자기 맥락으로 감싸는 경우도 있지만, 라이브러리 함수 자체의 에러도 어떤
// 조회였는지 알 수 있어야 다른 호출측이 붙어도 맥락이 안 사라진다.
async function fetchKis(url, headers, label, { fetchImpl = fetch, retries = 2, retryDelayMs = 700 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`KIS 조회 실패(${label}): ${await res.text()}`);
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
  const json = await fetchKis(url, headers, code, { fetchImpl, retries, retryDelayMs });
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
  const json = await fetchKis(url, headers, `${excd}:${symb}`, { fetchImpl, retries, retryDelayMs });
  return parseUsQuoteResponse(json);
}

// 국내 계좌 잔고조회(퇴직연금/IRP 포함 — KIS는 계좌상품코드(ACNT_PRDT_CD)로 계좌 종류를
// 구분할 뿐 연금 전용 별도 API가 없다, 확인: github.com/koreainvestment/open-trading-api
// examples_llm/domestic_stock/inquire_balance). tr_id TTTC8434R. cano/acntPrdtCd는
// loadIrpAccount() 결과.
export async function getAccountBalance({ token, appkey, appsecret, cano, acntPrdtCd, fetchImpl, retries, retryDelayMs }) {
  const params = new URLSearchParams({
    CANO: cano, ACNT_PRDT_CD: acntPrdtCd,
    AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '01', UNPR_DVSN: '01',
    FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00',
    CTX_AREA_FK100: '', CTX_AREA_NK100: '',
  });
  const url = `${BASE_URL}/uapi/domestic-stock/v1/trading/inquire-balance?${params}`;
  const headers = {
    'Content-Type': 'application/json',
    authorization: `Bearer ${token}`,
    appkey, appsecret,
    tr_id: 'TTTC8434R',
    custtype: 'P',
  };
  // label엔 계좌번호(cano/acntPrdtCd)를 넣지 않는다 — fetchKis가 실패 시 이 label을 그대로
  // Error 메시지에 박아 넣고, 그 메시지가 reconcile-irp.mjs의 console.error를 거쳐 로그
  // 파일에 남는다. 계좌번호는 appkey/appsecret과 동일하게 민감정보로 취급(코드리뷰 지적).
  const json = await fetchKis(url, headers, 'IRP잔고', { fetchImpl, retries, retryDelayMs });
  return parseBalanceResponse(json);
}

// KIS 잔고조회 원본 응답 → {holdings: [{code, name, qty}, ...], cash}. 순수함수 — 테스트
// 가능. holdings: output1(종목별 보유내역)에서 수량 0(매도돼 사라진 종목이 잔존 행으로
// 남는 경우가 있음)은 제외 — "보유 중"만 대사 대상. cash: output2(계좌 요약)의
// dnca_tot_amt(예수금총금액) — output2 자체가 없거나 파싱 불가면 null(0으로 추정하지
// 않음 — 호출측이 "데이터 없음"과 "진짜 0원"을 구분해야 오탐 없이 대사 가능).
export function parseBalanceResponse(json) {
  if (json?.rt_cd !== '0') throw new Error(`KIS 잔고조회 오류: ${json?.msg1 || json?.rt_cd || '알 수 없음'}`);
  const output1 = Array.isArray(json?.output1) ? json.output1 : [];
  const holdings = output1
    .map(o => ({
      code: String(o?.pdno ?? '').trim(),
      name: String(o?.prdt_name ?? '').trim(),
      qty: Number(o?.hldg_qty) || 0,
    }))
    .filter(h => h.qty > 0);
  // Number('')===0이라 "필드 자체가 없음"과 "빈 문자열"을 구분 못 하는 함정이 있다(이 파일의
  // parseQuoteResponse changePct와 동일 문제) — undefined/빈문자열이면 애초에 Number()를
  // 안 부르고 바로 null 처리한다.
  const cashRaw = Array.isArray(json?.output2) ? json.output2[0]?.dnca_tot_amt : undefined;
  const cash = cashRaw !== undefined && String(cashRaw).trim() !== ''
    ? Number(String(cashRaw).replace(/,/g, ''))
    : NaN;
  return { holdings, cash: Number.isFinite(cash) ? cash : null };
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
