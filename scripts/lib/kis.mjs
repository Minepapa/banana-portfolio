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

// rt_cd!=='0'(KIS 실패) 응답 → Error, msg_cd(안정적 코드값, 예: "EGW00201" 레이트리밋)를
// err.code에 붙여준다. msg1(사람이 읽는 문구)로 에러 종류를 판별하면 KIS가 문구를 바꿀 때
// 조용히 깨진다(코드리뷰 지적 — realtime-quotes.mjs가 레이트리밋 여부를 err.message 정규식
// 매칭으로 판별하다 kis.test.js 픽스처와도 안 맞았던 문제). 호출측은 이제 err.code로 판별.
function kisRtError(prefix, json) {
  const err = new Error(`${prefix}: ${json?.msg1 || json?.rt_cd || '알 수 없음'}`);
  err.code = json?.msg_cd;
  return err;
}

// KIS 국내주식 현재가(inquire-price) 원본 응답 → {price, changePct}. 네트워크와 분리된
// 순수함수 — 테스트 가능. rt_cd!=='0'(KIS 성공 코드) 또는 현재가 파싱 실패면 throw.
export function parseQuoteResponse(json) {
  if (json?.rt_cd !== '0') throw kisRtError('KIS 시세 오류', json);
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
  if (json?.rt_cd !== '0') throw kisRtError('KIS 해외 시세 오류', json);
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

// KIS 레이트리밋(msg_cd=EGW00201)의 HTTP status는 일정하지 않다 — 기존엔 "HTTP 200 + 바디
// 안 msg_cd로만 온다"고 가정했으나 2026-07 재조사(Frank의 텔레그램 스팸 신고로 raw 응답을
// 직접 떠서 확인)에서 **HTTP 500 + 같은 msg_cd 바디**로도 옴을 실측 확인했다(res.ok===false인데
// 몸통은 정상적인 KIS JSON envelope). 그동안 `!res.ok`면 몸통을 아예 안 보고 즉시 throw했기
// 때문에, 실제로 발생하는 레이트리밋의 상당수가 재시도 기회 자체를 못 받고 바로 실패 처리되고
// 있었다(realtime-quotes.mjs의 잔여 텔레그램 스팸 원인 — 스태거·재시도 횟수를 올려도 이 경로엔
// 적용이 안 됐던 것). 그래서 res.ok 여부와 무관하게 항상 몸통을 먼저 파싱해 msg_cd로 재시도
// 여부를 판단한다. 공식 문서엔 정확한 초당 한도가 안 나와 있어("초당 거래건수 초과 EGW00201"
// 문구만 언급) 재시도로 흡수하는 전략 자체는 유지.
export const KIS_RATE_LIMIT_CODE = 'EGW00201';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// GET + 레이트리밋 재시도 공통 로직(시세·잔고조회 등 인증된 KIS GET 호출이 전부 공유).
// URL·tr_id·헤더만 다르므로 재시도 루프 자체를 여러 번 따로 유지하면 한쪽만 고치는 회귀
// 위험이 있어 여기로 뽑아둔다. label: 에러 메시지에 넣을 식별자(종목코드/티커/계좌번호 등) —
// 호출측이 이미 자기 맥락으로 감싸는 경우도 있지만, 라이브러리 함수 자체의 에러도 어떤
// 조회였는지 알 수 있어야 다른 호출측이 붙어도 맥락이 안 사라진다.
async function fetchKis(url, headers, label, { fetchImpl = fetch, retries = 2, retryDelayMs = 700 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 아래에서 처리 — 몸통이 JSON이 아닌 진짜 알 수 없는 실패 */ }
    if (json?.msg_cd === KIS_RATE_LIMIT_CODE && attempt < retries) {
      await sleep(retryDelayMs * (attempt + 1));
      continue;
    }
    if (!json) throw new Error(`KIS 조회 실패(${label}): ${text}`);
    if (!res.ok) {
      const err = new Error(`KIS 조회 실패(${label}): ${json?.msg1 || text}`);
      err.code = json?.msg_cd;
      throw err;
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

// 국내주식 투자자별 매매동향(외국인/기관 순매수) 조회. tr_id FHKST01010900. output은 최근 30
// 영업일이 최신순으로 정렬돼 온다(실측 2026-07-26 확인: output[0].stck_bsop_date=20260724,
// 조회 시점 기준 가장 최근 거래일) — output[0]만 사용. 확인:
// github.com/koreainvestment/open-trading-api examples_llm/domestic_stock/inquire_investor.
// code: 6자리 종목코드(scripts/lib/instruments.mjs krStockCode 결과).
export async function getKrInvestorFlow({ token, appkey, appsecret, code, fetchImpl, retries, retryDelayMs }) {
  const url = `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-investor`
    + `?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${encodeURIComponent(code)}`;
  const headers = {
    'Content-Type': 'application/json',
    authorization: `Bearer ${token}`,
    appkey, appsecret,
    tr_id: 'FHKST01010900',
    custtype: 'P',
  };
  const json = await fetchKis(url, headers, code, { fetchImpl, retries, retryDelayMs });
  return parseInvestorFlowResponse(json);
}

// KIS 투자자별 매매동향 원본 응답 → {date, frgnNetQty, orgnNetQty}(가장 최근 거래일만). 순수함수
// — 테스트 가능. output이 비어있으면 null(당일 데이터는 장 종료 후 제공 — 유의사항 참고).
export function parseInvestorFlowResponse(json) {
  if (json?.rt_cd !== '0') throw kisRtError('KIS 투자자매매동향 오류', json);
  const latest = Array.isArray(json?.output) ? json.output[0] : null;
  if (!latest) return null;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  return {
    date: String(latest.stck_bsop_date ?? '').trim(),
    frgnNetQty: num(latest.frgn_ntby_qty),
    orgnNetQty: num(latest.orgn_ntby_qty),
  };
}

// 국내주식 종목투자의견(증권사별 투자의견+목표주가) 조회. tr_id FHKST663300C0. 날짜범위 필수
// (KIS 스펙) — 기본 최근 90일. output은 발행일 역순(최신 먼저)이며 같은 브로커가 재수정
// 리포트를 여러 건 낼 수 있어 원본 그대로 반환(중복제거는 summarizeInvestOpinion 담당).
// mbcr_name(회원사명) 필드는 공식 예제 chk_invest_opinion.py의 COLUMN_MAPPING엔 없지만 실제
// 응답엔 존재(2026-07 라이브 확인) — 문서보다 실측을 신뢰. 확인:
// github.com/koreainvestment/open-trading-api examples_llm/domestic_stock/invest_opinion.
// code: 6자리 종목코드. 페이지네이션(tr_cont='M') 미구현 — dayWindow 기본값(90일)에서는
// 관측된 데이터량(삼성전자 53건)이 KIS 1페이지 한도 내라 지금은 불필요(다른 KIS 래퍼도 동일 한계).
export async function getKrInvestOpinion({ token, appkey, appsecret, code, dayWindow = 90, fetchImpl, retries, retryDelayMs, now = new Date() }) {
  const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const from = new Date(now.getTime() - dayWindow * 86400000);
  const params = new URLSearchParams({
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_COND_SCR_DIV_CODE: '16633',
    FID_INPUT_ISCD: code,
    FID_INPUT_DATE_1: ymd(from),
    FID_INPUT_DATE_2: ymd(now),
  });
  const url = `${BASE_URL}/uapi/domestic-stock/v1/quotations/invest-opinion?${params}`;
  const headers = {
    'Content-Type': 'application/json',
    authorization: `Bearer ${token}`,
    appkey, appsecret,
    tr_id: 'FHKST663300C0',
    custtype: 'P',
  };
  const json = await fetchKis(url, headers, code, { fetchImpl, retries, retryDelayMs });
  return parseInvestOpinionResponse(json);
}

// KIS 종목투자의견 원본 응답 → [{date, firm, opinion, prevOpinion, targetPrice}, ...](발행일
// 역순 원본 그대로). prevOpinion(직전투자의견, rgbf_invt_opnn)은 그 브로커의 "이 리포트 직전"
// 자기 의견 — KIS가 리포트마다 동봉해줘서 별도 조회 없이 하향/상향 판정이 가능하다(실측
// 확인: 2026-07 라이브 호출, 공식 예제 chk_invest_opinion.py의 COLUMN_MAPPING엔 명시 안 됐지만
// 실제 응답에 존재 — mbcr_name과 동일하게 문서보다 실측 신뢰). 순수함수 — 테스트 가능.
// date·firm 중 하나라도 없는 행은 집계에 쓸 수 없어 스킵(전체 throw 안 함).
export function parseInvestOpinionResponse(json) {
  if (json?.rt_cd !== '0') throw kisRtError('KIS 투자의견 오류', json);
  const rows = Array.isArray(json?.output) ? json.output : [];
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  return rows
    .map(r => ({
      date: String(r?.stck_bsop_date ?? '').trim(),
      firm: String(r?.mbcr_name ?? '').trim(),
      opinion: String(r?.invt_opnn ?? '').trim(),
      prevOpinion: String(r?.rgbf_invt_opnn ?? '').trim(),
      targetPrice: num(r?.hts_goal_prc),
    }))
    .filter(r => r.date && r.firm);
}

// 투자의견 텍스트(한글/영문 혼용 — 실측: "매수"/"BUY"/"중립"/"HOLD" 등, 비중확대·Overweight류
// 국내 증권사 관행 표현도 포함) → buy|hold|sell|other. KIS가 invt_opnn_cls_code 코드값 의미를
// 공식 문서에 안 밝혀 텍스트 매칭으로 분류한다.
function classifyOpinion(text) {
  if (/매수|BUY|비중\s*확대|OVERWEIGHT|OUTPERFORM/i.test(text)) return 'buy';
  if (/매도|SELL|비중\s*축소|UNDERWEIGHT|UNDERPERFORM/i.test(text)) return 'sell';
  if (/중립|보유|HOLD|NEUTRAL/i.test(text)) return 'hold';
  return 'other';
}

// buy>hold>sell 서열 — 하향/상향 판정용. classifyOpinion이 'other'로 분류한 표현(리포트
// 특유 문구 등)은 서열을 매길 수 없어 null(그 리포트는 하향/상향 집계에서 제외 — 억지로
// 끼워맞추지 않음).
const OPINION_RANK = { buy: 2, hold: 1, sell: 0 };
function opinionRank(text) { return OPINION_RANK[classifyOpinion(text)] ?? null; }

// 브로커별 투자의견 리스트 → 컨센서스 요약(브로커당 최신 1건으로 중복제거). currentPrice는 KIS
// 자체 괴리율 필드(dprt/nday_dprt — 산출 기준이 공식 문서에 없어 신뢰 불가) 대신 이미 검증된
// 자체 시세(fundamentals.mjs fetchMarketData currentPrice)로 직접 계산 — 가격의 단일 진실
// 소스를 유지(리포트마다 발행일의 전일종가가 달라 시점이 제각각인 stck_prdy_clpr도 배제).
// downgrades/upgrades: 브로커별 최신 리포트의 opinion vs 그 리포트 자체의 prevOpinion(그
// 브로커 직전 의견) 비교 — "여러 브로커의 최신 성향"이 아니라 "그 브로커가 스스로 의견을
// 낮췄는가"라 노이즈가 적다(risk-monitor.mjs checkGuardrails 가이던스 하향 대리신호로 소비).
// 순수함수 — 테스트 가능. 리포트 0건이면 null(데이터 없음, 0으로 추정 안 함).
export function summarizeInvestOpinion(rows, currentPrice) {
  const latestByFirm = new Map();
  for (const r of (rows || [])) {
    const prev = latestByFirm.get(r.firm);
    if (!prev || r.date > prev.date) latestByFirm.set(r.firm, r);
  }
  const uniq = [...latestByFirm.values()];
  if (!uniq.length) return null;
  const counts = { buy: 0, hold: 0, sell: 0, other: 0 };
  const targets = [];
  let latestDate = '', downgrades = 0, upgrades = 0;
  for (const r of uniq) {
    counts[classifyOpinion(r.opinion)]++;
    if (r.targetPrice != null && r.targetPrice > 0) targets.push(r.targetPrice);
    if (r.date > latestDate) latestDate = r.date;
    if (r.prevOpinion) {
      const cur = opinionRank(r.opinion), prev = opinionRank(r.prevOpinion);
      if (cur != null && prev != null) {
        if (cur < prev) downgrades++;
        else if (cur > prev) upgrades++;
      }
    }
  }
  const avgTargetPrice = targets.length ? Math.round(targets.reduce((s, v) => s + v, 0) / targets.length) : null;
  const targetGapPct = (avgTargetPrice != null && Number.isFinite(currentPrice) && currentPrice > 0)
    ? Math.round((avgTargetPrice - currentPrice) / currentPrice * 1000) / 10
    : null;
  return { reportCount: uniq.length, opinionCounts: counts, avgTargetPrice, targetGapPct, latestDate, downgrades, upgrades };
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
  if (json?.rt_cd !== '0') throw kisRtError('KIS 잔고조회 오류', json);
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
