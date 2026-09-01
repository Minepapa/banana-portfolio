// NH투자증권 Open API("나무 Namuh PLUG") 클라이언트 — 2026-09-01 신설.
//
// 배경: 오너 대부분의 계좌(위탁·CMA·금현물)가 NH투자증권에 있는데 그동안 KIS만
// 연동돼 있었다. 2026-09-01 NH가 이 오너에게 API 이용을 열어줘, 앞으로 위탁·CMA·
// 금현물(ISA는 NH가 아직 미지원)을 이 클라이언트로 조회·주문한다. KIS는 IRP 계좌
// 조회 등 최소한만 남기고(scripts/lib/kis.mjs 그대로 유지), 해외주식·장내채권 등
// KIS/KRX에서 안 되던 것들도 NH로 대체할 예정(오너 확정, 2026-09-01).
//
// 크리덴셜: ~/.config/banana-portfolio/nhplug-key.json({appkey, appsecret}) —
// scripts/setup/nhplug-credential-setup.mjs(로컬 웹폼)로 발급. KIS와 달리 계좌별
// 앱키 등록이 아니라 앱키 하나로 오너 명의 전 계좌를 조회(2026-09-01 라이브 확인 —
// /n2/acctinfo가 계좌목록 전체를 한 번에 반환).
//
// 실전/모의 — KIS와 다른 결정적 차이(nhplug-sdk 공식 SDK 소스 확인, 2026-09-01):
// 같은 appkey/appsecret이 실전(api.nhplug.com)·모의(moapi.nhplug.com) 둘 다에서
// 통한다(base URL만 다름, KIS처럼 계좌 단위 별도 앱 등록이 아님). 이 코드베이스는
// KIS 실전/모의를 분리한 적이 없고 대신 State/ExecutionMode(섀도우|실전)로 "실제
// 주문을 낼지" 자체를 Node 레벨에서 게이트한다(shadow-mode.mjs) — 같은 원칙을
// 유지해 이 클라이언트도 항상 실전 도메인(api.nhplug.com)만 호출한다. 모의투자
// 도메인(moapi.nhplug.com)은 이 코드베이스에서 안 씀(섀도우 모드가 그 역할 대체).
//
// 인증(POST /oauth2/token): KIS(JSON body)와 다르게 폼인코딩 쿼리파라미터
// (appkey·appsecretkey·grant_type=client_credentials·scope=oob), 토큰 24시간
// 유효. 발급은 항상 실전(api) 도메인으로만 가능(모의 전용 토큰 엔드포인트 없음 —
// nhplug.com/llms.txt 명시).
//
// 성공판정: KIS는 rt_cd==='0' 단일 코드지만 NH는 API마다 성공코드가 다르다
// (00000·00166·00221·13578 등, nhplug-sdk client.py 실측) — rsp_cd가 알려진
// 성공코드 집합에 있거나, rsp_msg에 "완료"가 포함되면 성공으로 판정한다(SDK와
// 동일 로직 이식). rt_cd 단일비교로 잘못 옮기면 정상 응답을 실패로 오판한다.
//
// 속도제한: KIS는 레이트리밋(EGW00201)을 재시도로 흡수하지만 NH는 초당 4~5회
// 슬라이딩 윈도우 + 429는 자동재시도 안 함(nhplug-sdk client.py 실측, 캐릭터가
// 다름) — 이 모듈은 호출 전 슬라이딩 윈도우로 스스로 속도를 늦추고, 429가 실제로
// 오면 즉시 throw(호출측이 백오프 여부 결정, KIS처럼 자동 재시도하지 않음).
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export const NHPLUG_KEY_FILE = process.env.NHPLUG_KEY_FILE
  || `${process.env.HOME}/.config/banana-portfolio/nhplug-key.json`;
const TOKEN_CACHE_FILE = join(HERE, '..', '.cache', 'nhplug-token.json');
export const NHPLUG_BASE_URL = 'https://api.nhplug.com:8443';
const TOKEN_MARGIN_MS = 30 * 60 * 1000; // 만료 30분 전까지만 캐시 재사용(kis.mjs와 동일 관례)

export function hasNhplugCredentials() {
  try { readFileSync(NHPLUG_KEY_FILE); return true; } catch { return false; }
}

export function loadNhplugCredentials(keyFile = NHPLUG_KEY_FILE) {
  const { appkey, appsecret } = JSON.parse(readFileSync(keyFile, 'utf8'));
  if (!appkey || !appsecret) throw new Error(`${keyFile}에 appkey/appsecret 없음`);
  return { appkey, appsecret };
}

// 코드리뷰 LOW 지적(2026-09-01) — 캐시파일이 "null"(유효한 JSON이지만 객체가 아님)
// 이면 JSON.parse는 성공하고 아래 cache[appkey] 접근에서 매번 TypeError가 나
// 사실상 캐시가 영구히 깨진다. 객체가 아니면 빈 맵으로 안전 폴백.
function readTokenCache() {
  try {
    const parsed = JSON.parse(readFileSync(TOKEN_CACHE_FILE, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch { return {}; }
}

// mode 0o600 — access_token 원문이 든 파일, kis.mjs 토큰캐시와 동일 이유로 소유자 외
// 읽기 차단(기존 파일엔 writeFileSync의 mode가 안 먹으므로 매번 chmodSync도 같이 호출).
function writeTokenCache(map) {
  mkdirSync(dirname(TOKEN_CACHE_FILE), { recursive: true });
  writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(map), { mode: 0o600 });
  chmodSync(TOKEN_CACHE_FILE, 0o600);
}

export async function getNhToken({ appkey, appsecret, fetchImpl = fetch }) {
  const cache = readTokenCache();
  const cached = cache[appkey];
  if (cached && cached.expiresAt - Date.now() > TOKEN_MARGIN_MS) return cached.token;

  const params = new URLSearchParams({
    appkey, appsecretkey: appsecret, grant_type: 'client_credentials', scope: 'oob',
  });
  const res = await fetchImpl(`${NHPLUG_BASE_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`NH PLUG 토큰 발급 실패(JSON 아님): ${text.slice(0, 200)}`); }
  if (!res.ok || !body.access_token) throw new Error(`NH PLUG 토큰 발급 실패: ${text.slice(0, 300)}`);

  const expiresAt = Date.now() + (Number(body.expires_in) || 86400) * 1000;
  cache[appkey] = { token: body.access_token, expiresAt };
  writeTokenCache(cache);
  return body.access_token;
}

// NH 응답의 성공/실패 판정 — rsp_cd 단일값 비교 금지(API마다 성공코드가 다름).
// 순수함수. nhplug-sdk의 DEFAULT_SUCCESS_CODES·"완료" 정규식 판정을 그대로 이식.
const DEFAULT_SUCCESS_CODES = new Set(['00000', '00166', '00221', '13578']);
export function isNhSuccess(rsp_cd, rsp_msg) {
  if (rsp_cd == null) return true;
  if (DEFAULT_SUCCESS_CODES.has(String(rsp_cd))) return true;
  return typeof rsp_msg === 'string' && rsp_msg.includes('완료');
}

// 초당 4회 슬라이딩 윈도우(nhplug-sdk 기본값과 동일) — 호출 전 스스로 속도를 늦춘다.
// 429가 실제로 오면 재시도하지 않고 즉시 throw(NH는 KIS와 달리 유량초과 자동재시도
// 대상이 아님 — 위 파일 헤더 주석 참고, 호출측이 백오프 여부를 결정).
//
// 테스트에서 이 지연을 꺼야 한다(2026-09-01 실측 — callNh를 여러 번 부르는 테스트가
// 슬라이딩 윈도우에 그대로 걸려 매번 실제로 최대 1초씩 기다렸다). krstock 등 도메인
// 함수마다 rateLimitPerSec을 일일이 통과시키게 하면(kis.mjs의 retries/retryDelayMs
// 방식) 앞으로 늘어날 도메인 파일마다 보일러플레이트가 커지므로, 대신 모듈 레벨
// 스위치 하나로 뺐다 — 테스트 파일 맨 위에서 setNhRateLimitForTests(Infinity) 한
// 번만 호출하면 그 파일의 모든 callNh 호출에 적용된다.
let _rateLimitPerSec = 4;
// 테스트 전용 — node --test가 설정하는 NODE_TEST_CONTEXT가 없으면(실제 운영 코드
// 경로) throw해서 프로덕션 코드가 실수로 속도제한을 꺼버리는 걸 막는다(2026-09-01
// 코드리뷰 LOW 지적 — "설계 자체는 안전하나, 프로덕션 코드가 이걸 부르는 걸 막는
// 장치는 없다"는 잔여 위험을 닫음).
export function setNhRateLimitForTests(perSec) {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('setNhRateLimitForTests는 테스트에서만 호출 가능');
  _rateLimitPerSec = perSec;
}
const _callTimestamps = [];
async function throttle() {
  if (!Number.isFinite(_rateLimitPerSec) || _rateLimitPerSec <= 0) return; // 테스트: 무제한
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    const now = Date.now();
    while (_callTimestamps.length && now - _callTimestamps[0] >= 1000) _callTimestamps.shift();
    if (_callTimestamps.length < _rateLimitPerSec) { _callTimestamps.push(now); return; }
    await sleep(1000 - (now - _callTimestamps[0]));
  }
}

// 공용 POST 호출 — 토큰 헤더·속도제한·성공판정까지 한 곳에서(kis.mjs fetchKis와 동일
// 원칙). uri: 도메인 이하 경로(예: '/n2/acctinfo'). input0: Input_0에 실릴 요청 바디.
//
// ⚠️ 에러 분류(2026-09-01 코드리뷰 HIGH 2건 반영, 이 함수가 던지는 에러의 계약) —
// 호출측(krstock 등 주문함수)이 "확실히 안 나감"(confirmedNotSent=true로 승격 가능)
// 과 "불명"(승격 금지)을 구분하려면 이 함수가 정확히 구분해서 표시해야 한다:
//   1) err.businessRejection=true — NH가 업무를 명시적으로 거부(isNhSuccess=false).
//      이때만 호출측이 confirmedNotSent로 승격해도 된다.
//   2) 그 외 전부(HTTP 4xx/5xx 전송오류·429 유량초과·JSON 파싱 실패) — businessRejection
//      안 붙임. 특히 429는 로드밸런서·게이트웨이 단에서 발생할 수 있어 "주문이 실제로
//      브로커까지 도달했는지"에 대해 아무것도 말해주지 않는다 — 예전엔 err.code가
//      있으면(RATE_LIMIT 포함) 무조건 confirmedNotSent를 붙이는 버그가 있었음(코드
//      리뷰 실측 재현 — 429 주문 응답이 confirmedNotSent=true로 잘못 승격돼, 실제로는
//      브로커에 접수됐을 수 있는 주문을 "안전하게 롤백 가능"으로 오판할 뻔했다).
export async function callNh({ token, uri, input0 = {}, fetchImpl = fetch }) {
  await throttle();
  const res = await fetchImpl(`${NHPLUG_BASE_URL}${uri}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ Input_0: input0 }),
  });
  const text = await res.text();

  // 429는 몸통이 JSON이 아닐 수 있다(게이트웨이가 HTML을 돌려주는 경우) — JSON 파싱
  // 전에 먼저 걸러야 그 케이스도 RATE_LIMIT로 정확히 분류된다(2026-09-01 코드리뷰 LOW).
  if (res.status === 429) {
    let parsedMsg;
    try { parsedMsg = JSON.parse(text)?.rsp_msg; } catch { /* 몸통이 JSON 아니면 원문 인용으로 폴백 */ }
    const err = new Error(`NH PLUG 유량초과(${uri}): ${parsedMsg || text.slice(0, 200)}`);
    err.code = 'RATE_LIMIT'; // businessRejection 아님 — 절대 confirmedNotSent 승격 금지
    throw err;
  }

  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`NH PLUG 조회 실패(${uri}, JSON 아님): ${text.slice(0, 200)}`); }

  // HTTP 전송 자체가 실패(4xx/5xx)면 rsp_cd가 없는 에러 봉투(예: {"error":"invalid_token"})
  // 일 수 있다 — isNhSuccess(rsp_cd==null)의 "rsp_cd 없으면 성공" 폴백이 이 경우까지
  // 성공으로 삼켜버리는 걸 막는다(2026-09-01 코드리뷰 HIGH 실측 재현 — 401 응답이
  // 그대로 "성공"으로 반환돼 listNhAccounts가 계좌 0건을 조용히 돌려주는 사고 확인).
  if (!res.ok && !DEFAULT_SUCCESS_CODES.has(String(body?.rsp_cd))) {
    const err = new Error(`NH PLUG HTTP ${res.status}(${uri}): ${body?.rsp_msg || text.slice(0, 200)}`);
    // businessRejection 안 붙임 — 전송계층 실패라 "브로커가 명시적으로 거부"와 다름.
    throw err;
  }
  if (!isNhSuccess(body?.rsp_cd, body?.rsp_msg)) {
    const err = new Error(`NH PLUG 업무오류(${uri}): ${body?.rsp_msg || body?.rsp_cd || '알 수 없음'}`);
    err.code = body?.rsp_cd;
    err.businessRejection = true; // 여기서만 승격 — isNhSuccess가 명시적으로 거부라고 판정한 경우
    throw err;
  }
  return body;
}

// 계좌목록 조회(POST /n2/acctinfo) — 모든 호출의 선행 단계. acct_type 01(운영 일반)·
// 02(운영 주문대리인)만 이 실전 도메인에서 유효(03=모의투자는 이 클라이언트가 애초에
// 안 쓰는 도메인이라 여기 안 옴, 위 파일 헤더 주석 참고).
export function classifyAcctType(acct_type) {
  const code = String(acct_type ?? '').trim();
  if (code === '01') return '운영(일반)';
  if (code === '02') return '운영(주문대리인)';
  if (code === '03') return '모의투자(이 클라이언트 미사용 도메인)';
  return `미정의(${code || '없음'})`;
}

export async function listNhAccounts({ token, fetchImpl = fetch }) {
  const body = await callNh({ token, uri: '/n2/acctinfo', input0: {}, fetchImpl });
  const rows = Array.isArray(body?.Output_0) ? body.Output_0 : [];
  return rows.map((r) => ({
    acctNo: r.acct_no, acctType: r.acct_type, acctTypeLabel: classifyAcctType(r.acct_type),
  }));
}
