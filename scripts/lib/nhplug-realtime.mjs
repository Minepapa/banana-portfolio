// NH PLUG 실시간(WebSocket) 클라이언트 — 2026-09-02 신설. REST(callNh, nhplug.mjs)와
// 완전히 다른 프로토콜이라 별도 파일로 분리(지속 연결·구독/해제 메시지·서버 푸시,
// 요청/응답 1:1 아님). krstock·gbstock·krgold 3개 자산군 실시간 채널을 전부 이
// 한 모듈이 담당(프로토콜 자체는 자산군 무관 — 채널코드·tr_key 형식만 다름).
//
// 프로토콜 정본: 각 자산군 openapi.json의 `x-realtime-channels` 블록(2026-09-02
// curl로 확인) + 공식 SDK(nhplug-sdk) `nhplug/realtime.py`·`docs/realtime_channels.md`
// (Python 전용이라 코드는 재사용 못 하지만 서버 실측 한도·프로토콜 세부사항의
// 근거로 참고 — 이 프로젝트가 krstock REST를 만들 때와 동일한 이유로 SDK 자체는
// 못 쓰되 문서·실측치는 정본으로 씀).
//
// ⚠️ gbstock tr_key는 GIC 코드가 아니라 그냥 티커(2026-09-02 오너가 API 가이드
// 포털의 실제 예시를 지적해 확인·정정) — openapi.json의 x-realtime-channels가
// tr_key.name을 "gicz15"(길이 15)라고 적어놔서 처음엔 "구독하려면 별도 GIC 코드를
// 어디선가 조회해야 한다"고 오판했다. 실제 포털 예시(해외_주식_실시간_호가)를
// 보면 요청 body는 `tr_key: "AAPL"`(티커 그대로)이고, "gicz15"는 응답 header·body에
// 되돌아오는 필드명일 뿐이었다(예: 응답 tr_key·gicz15 둘 다 "USAAAPL" — 국가prefix+
// 티커 조합, REST 조회 응답의 iem_cd와 동일 값). 별도 코드 획득 경로 자체가
// 필요 없었다 — 이 오판으로 gbstock 실시간을 한 차례 보류했던 것을 정정.
//
// ⚠️ TLS 주의사항(SDK 문서에 기록됐지만 이 프로젝트는 문제 없음, 2026-09-02 확인):
// 공식 SDK는 "실거래 WebSocket이 중간 CA를 안 보내 Python OpenSSL 기본 검증이
// 실패한다(curl은 자동 보완돼 성공)"고 truststore 패키지로 우회한다. Node의 TLS
// 스택은 curl과 동일하게 이 서버에 문제없이 접속됨을 직접 확인(2026-09-02,
// `tls.connect(7070, 'api.nhplug.com')` → `authorized: true`) — Node에선 별도
// 우회가 필요 없다.
//
// 접속 주소: `wss://api.nhplug.com:{포트}/websocket` — 경로 `/websocket`이 필수
// (호스트:포트만으로는 핸드셰이크만 되고 구독이 무시됨, SDK 주석 근거).
// 포트는 자산군이 아니라 "시세냐 통보냐"로 갈린다: 국내 시세=7070, 해외 **시세**만
// 7080, 통보(체결·주문내역)는 국내·해외 모두 7070. 이 프로젝트는 실전 도메인만
// 쓰므로(nhplug.mjs NHPLUG_BASE_URL과 동일 호스트, 모의투자 미사용 원칙) 모의투자
// 포트(17070)는 다루지 않는다.
//
// ⚠️ 연결 종료 시 명시적 구독해제 불필요(2026-09-02 라이브 실측) — 해제 메시지
// 없이 소켓을 바로 닫아도 서버 세션카운트가 즉시 반납됨을 직접 확인(세션1을 해제
// 메시지 없이 close 후 세션2를 곧바로 열어 정상 등록 성공). 그래서 이 모듈의
// close()는 구독해제 메시지를 보내지 않고 바로 소켓을 닫는다 — 공식 SDK(Python)는
// 그래도 해제를 보내지만, 이 프로젝트가 실측한 바로는 불필요한 지연(초당 전송제한
// 때문에 최대 1초)만 늘린다.

const WS_HOST = 'api.nhplug.com';
const WS_PATH = '/websocket';
const PORT_DOMESTIC = '7070';
const PORT_OVERSEAS = '7080';

// 해외 **시세** 채널만 7080 — 통보 채널은 해외라도 7070(SDK 주석: "해외파생 통보
// dk·dj를 7080으로 보내면 WSS10006"). 대소문자 둘 다 공식 SDK
// `nhplug/realtime.py`의 `OVERSEAS_QUOTE_CHANNELS = frozenset({"RH","rh","RC","rc"})`
// 원문 그대로 옮김(추측 아님 — SDK 소스에 실제로 두 대소문자가 다 있음). krstock은
// 전부 국내라 이 Set에 걸릴 일이 없지만, gbstock 착수 시(오너 확정 다음 단계) 이
// 모듈을 그대로 재사용하도록 지금부터 채널코드 기준으로 분기해둔다.
const OVERSEAS_QUOTE_CHANNELS = new Set(['RH', 'rh', 'RC', 'rc']);

// krstock 실시간 채널 21개(시세/depth 19 + 통보 2) — openapi.json
// x-realtime-channels.channels를 그대로 옮김(2026-09-02). trKeyKind는 tr_key에
// 실제로 넣어야 하는 값의 종류이자 검증 방식을 정한다: 'code'/'ecnCode'는 6자리
// 숫자 종목코드, 'userId'는 통보 채널(비워도 동작, 서버 예시가 실제로 ""를 씀),
// 'jisuId'는 채권지수 ID(자릿수 스펙 없어 비어있지 않은지만 확인).
export const KRSTOCK_REALTIME_CHANNELS = {
  ob: { name: '국내주식 실시간호가KRX', trKeyKind: 'code' },
  oc: { name: '국내주식 실시간체결가KRX', trKeyKind: 'code' },
  oa: { name: '국내주식 실시간예상체결KRX', trKeyKind: 'code' },
  t1: { name: '국내주식 실시간회원사KRX', trKeyKind: 'code' },
  t8: { name: '국내주식 실시간프로그램매매KRX', trKeyKind: 'code' },
  e5: { name: '국내주식 시간외 실시간호가KRX', trKeyKind: 'ecnCode' },
  e2: { name: '국내주식 시간외 실시간체결가KRX', trKeyKind: 'ecnCode' },
  e4: { name: '국내주식 시간외 실시간예상체결KRX', trKeyKind: 'ecnCode' },
  mb: { name: '국내주식 실시간호가통합', trKeyKind: 'code' },
  mc: { name: '국내주식 실시간체결가통합', trKeyKind: 'code' },
  ma: { name: '국내주식 실시간예상체결통합', trKeyKind: 'code' },
  mg: { name: '국내주식 실시간회원사통합', trKeyKind: 'code' },
  mn: { name: '국내주식 실시간프로그램매매통합', trKeyKind: 'code' },
  nb: { name: '국내주식 실시간호가NXT', trKeyKind: 'code' },
  nc: { name: '국내주식 실시간체결가NXT', trKeyKind: 'code' },
  na: { name: '국내주식 실시간예상체결NXT', trKeyKind: 'code' },
  ng: { name: '국내주식 실시간회원사NXT', trKeyKind: 'code' },
  nn: { name: '국내주식 실시간프로그램매매NXT', trKeyKind: 'code' },
  uB: { name: '채권지수 실시간 체결가', trKeyKind: 'jisuId' },
  d2: { name: '국내주식 실시간체결통보', trKeyKind: 'userId', isNotification: true },
  d3: { name: '국내주식 실시간주문내역통보', trKeyKind: 'userId', isNotification: true },
};

// gbstock 실시간 채널 6개(시세 4 + 통보 2) — openapi.json x-realtime-channels
// 그대로(2026-09-02). trKeyKind 'ticker': 티커 그대로(예: "AAPL") — 위 파일 헤더
// 주석 참고, GIC 코드 별도 조회 불필요.
//
// ⚠️ 대문자(RH·RC, 진짜 실시간)는 유료 시세 등록이 안 돼 있으면 구독 자체가
// 거부된다(2026-09-02 라이브 실측 — ACK `WSS10013 유료 실시간 시세 등록이
// 필요합니다`, 포털 Description에도 "유료시세 사용 약정 고객만 이용 가능"으로
// 명시돼 있었음). **소문자(rh·rc, 지연호가/체결가 — "아시아 지연" 표기가 있지만
// 실측상 미국 종목도 정상 동작)는 유료 등록 없이도 바로 구독·수신 확인됨** —
// 이 계정은 유료 실시간 시세 약정이 없으므로 지금은 rh·rc만 실사용 가능. 통보
// 채널(d0·d1)은 시세가 아니라 계좌 알림이라 유료 등록과 무관하게 정상 동작
// 확인(둘 다 ACK 00000).
// requiresPaidQuote: true(2026-09-02 코드리뷰 MEDIUM 지적) — 유료 게이트를
// name 문자열(프로즈)에만 적어두면 호출측이 기계적으로 걸러낼 방법이 없다.
// 캐치를 원하면 문자열 부분일치("유료")로 파싱해야 하는데, 이 프로젝트가
// 프로즈 규칙보다 구조적 가드를 선호하는 것과 반대 방향이라 플래그로 승격.
export const GBSTOCK_REALTIME_CHANNELS = {
  rh: { name: '해외주식 지연호가(무료, 실사용 채널)', trKeyKind: 'ticker' },
  rc: { name: '해외주식 지연체결가(무료, 실사용 채널)', trKeyKind: 'ticker' },
  RH: { name: '해외주식 실시간호가', trKeyKind: 'ticker', requiresPaidQuote: true },
  RC: { name: '해외주식 실시간체결가', trKeyKind: 'ticker', requiresPaidQuote: true },
  d0: { name: '해외주식 실시간체결통보', trKeyKind: 'userId', isNotification: true },
  d1: { name: '해외주식 실시간주문내역통보', trKeyKind: 'userId', isNotification: true },
};

// krgold 실시간 채널 5개(시세 3 + 통보 2) — openapi.json x-realtime-channels
// 그대로(2026-09-02). trKeyKind 'goldCode': shcode(종목코드) 9자리 — krgold
// REST의 GOLD_ITEM_CODE(M04020000·M04020100)와 동일 값 체계(nhplug-krgold.mjs
// 참고, 여기선 도메인 결합을 피해 형식만 느슨히 검증). ⚠️ d3(주문내역통보)는
// krstock의 d3와 tr_cd가 동일 — 공식 문서상 이 채널이 자산군 구분 없이 계좌
// 단위로 전체 주문내역을 통보하는 것으로 추정(userid 키만 있고 종목 키가 없음).
// 실제로는 같은 물리 채널이라 krstock·krgold 어느 쪽 카탈로그로 구독해도 동일.
export const KRGOLD_REALTIME_CHANNELS = {
  g5: { name: '금현물 실시간 호가', trKeyKind: 'goldCode' },
  g4: { name: '금현물 실시간 체결가', trKeyKind: 'goldCode' },
  gE: { name: '금현물 실시간 예상체결가', trKeyKind: 'goldCode' },
  de: { name: '금현물 실시간 체결내역 통보', trKeyKind: 'userId', isNotification: true },
  d3: { name: '금현물 실시간 주문내역 통보(krstock과 동일 채널)', trKeyKind: 'userId', isNotification: true },
};

// 세 자산군 채널을 합쳐 구독 시점 검증에 쓴다 — subscribeRealtime은 자산군을
// 몰라도 되게(호출측이 trCd만 넘기면 알아서 어느 카탈로그 소속인지 찾음) 설계.
// d3(krstock·krgold 공유)처럼 겹치는 코드는 메타데이터(trKeyKind·isNotification)가
// 동일해 병합 시 문제 없음(둘 다 userId·통보).
const ALL_REALTIME_CHANNELS = {
  ...KRSTOCK_REALTIME_CHANNELS, ...GBSTOCK_REALTIME_CHANNELS, ...KRGOLD_REALTIME_CHANNELS,
};

// 서버 실측 한도(공식 SDK realtime.py 문서화 + 2026-09-02 이 프로젝트가 라이브로
// 직접 재현 확인 — 구독/해제 전송을 초당 10건 넘게 보내자 실제로 WSS10010이 옴).
// 서버가 강제하는 값이라 클라이언트가 올릴 수 없다("미만"이 아니라 "이 값까지
// 허용" — 실측은 10건까지 성공, 11번째부터 거부).
export const WS_SERVER_LIMITS = {
  maxSessionsPerAppkey: 2, // 초과 시 WSS10015(이 모듈은 세션 카운팅을 안 하므로 호출측이 직접 관리)
  maxKeysPerSession: 10, // 초과 시 서버가 조용히 close(code 1000 "Bye", 에러 메시지 없음)
  maxSubscribePerSec: 10, // 초과 시 WSS10010(서버가 실제로 허용하는 값)
};

// 클라이언트 쪽 전송 예산 — 서버 한도(10)에 딱 맞춰 보내면 네트워크 지터·서버
// 카운터 경계조건에 취약하다(2026-09-02 코드리뷰 MEDIUM 지적 — REST 쪽 throttle도
// 실측 4~5 한도에 4로 여유를 둔 전례가 있음, nhplug.mjs 헤더 주석 참고). 서버가
// 실제로 허용하는 값(WS_SERVER_LIMITS.maxSubscribePerSec)과 이 클라이언트가 실제로
// 쓰는 예산을 분리해서 여유를 기록.
const CLIENT_SUBSCRIBE_BUDGET_PER_SEC = 8;

const WS_ACK_OK = '00000';

// 접속 URL — trCd로 시세(국내 7070/해외 7080)·통보(항상 7070) 포트를 자동 결정.
export function wsUrl(trCd) {
  const port = OVERSEAS_QUOTE_CHANNELS.has(trCd) ? PORT_OVERSEAS : PORT_DOMESTIC;
  return `wss://${WS_HOST}:${port}${WS_PATH}`;
}

// 구독 등록/해제 "응답"인가(시세 데이터가 아님) — header에 tr_type 또는 rsp_cd가
// 있으면 ACK. 데이터 푸시의 header엔 tr_cd·tr_key뿐(공식 SDK is_ack와 동일 판정).
// `!= null`로 확인 — `tr_type: null`처럼 값이 명시적으로 비어있는 경우까지
// ACK으로 오판하지 않는다(2026-09-02 코드리뷰 LOW 지적, `in` 연산자는 값과
// 무관하게 키 존재만 봄).
export function isAck(msg) {
  const h = msg && typeof msg === 'object' ? msg.header : null;
  if (!h || typeof h !== 'object') return false;
  return h.tr_type != null || h.rsp_cd != null;
}

// ACK이 성공(등록/해제 정상 처리)인지 — WSS10015(세션초과)·WSS10010(전송과다)·
// WSS10006(포트오류) 등은 여기서 false가 되어 호출측이 원인을 알 수 있게 한다.
// rsp_cd 자체가 없는 ACK(tr_type만 있는 경우)은 실패로 오판하지 않고 성공 취급
// (2026-09-02 코드리뷰 HIGH 지적 — isAck는 "tr_type 또는 rsp_cd"인데 이 함수는
// rsp_cd 부재를 실패로 잘못 판정하고 있었음).
export function isAckSuccess(msg) {
  if (!isAck(msg)) return false;
  const rsp = msg?.header?.rsp_cd;
  if (rsp == null) return true;
  return String(rsp) === WS_ACK_OK;
}

// 구독 전송 속도제한 — nhplug.mjs의 REST callNh 속도제한과 동일 패턴(모듈 레벨
// 스위치, 테스트에서 setNhWsRateLimitForTests(Infinity)로 무제한화). 이 프로젝트가
// 이미 검증한 원칙을 새 프로토콜에도 그대로 적용.
let _wsRateLimitPerSec = CLIENT_SUBSCRIBE_BUDGET_PER_SEC;
export function setNhWsRateLimitForTests(perSec) {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('setNhWsRateLimitForTests는 테스트에서만 호출 가능');
  _wsRateLimitPerSec = perSec;
}
let _sendTimestamps = [];
// 테스트 전용 리셋 — _sendTimestamps가 모듈 레벨 상태라 리셋 없이 여러 테스트가
// 돌면 앞 테스트의 전송기록이 다음 테스트로 새어들어간다(2026-09-02 코드리뷰
// MEDIUM 지적 — throttle 자체가 그동안 테스트에서 무제한화만 되고 실제로 검증된
// 적이 없었던 이유이기도 함).
export function resetNhWsThrottleForTests() {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('resetNhWsThrottleForTests는 테스트에서만 호출 가능');
  _sendTimestamps = [];
}
async function throttleSend() {
  if (!Number.isFinite(_wsRateLimitPerSec) || _wsRateLimitPerSec <= 0) return;
  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
  for (;;) {
    const now = Date.now();
    while (_sendTimestamps.length && now - _sendTimestamps[0] >= 1000) _sendTimestamps.shift();
    if (_sendTimestamps.length < _wsRateLimitPerSec) { _sendTimestamps.push(now); return; }
    await sleep(1000 - (now - _sendTimestamps[0]));
  }
}

// tr_key 형식 검증(2026-09-02 코드리뷰 MEDIUM 지적 — 검증 없이 `.map(String)`만
// 하면 null·undefined·객체가 각각 'null'·'undefined'·'[object Object]' 문자열로
// 그대로 서버에 나갈 수 있었다). code·ecnCode는 6자리 숫자 종목코드로 형식이
// 고정돼 있어 정규식 검증. ticker(gbstock)는 알파벳·숫자·점(BRK.B류) 1~10자,
// goldCode(krgold)는 9자 영숫자(정확한 2개 값 화이트리스트는 nhplug-krgold.mjs
// 쪽 책임 — 이 모듈은 프로토콜 형식만 봄, 도메인 결합 안 함). userId·jisuId는
// 서버 스펙에 고정 형식이 없어 문자열 여부만 확인.
function validateTrKey(trKeyKind, key) {
  if (typeof key !== 'string') throw new Error(`tr_key는 문자열이어야 함(${trKeyKind}): ${key}`);
  if ((trKeyKind === 'code' || trKeyKind === 'ecnCode') && !/^\d{6}$/.test(key)) {
    throw new Error(`tr_key(${trKeyKind})는 6자리 숫자 종목코드여야 함: ${key}`);
  }
  if (trKeyKind === 'ticker' && !/^[A-Za-z0-9.]{1,10}$/.test(key)) {
    throw new Error(`tr_key(ticker)는 영숫자·점 1~10자 티커여야 함: ${key}`);
  }
  if (trKeyKind === 'goldCode' && !/^[A-Za-z0-9]{9}$/.test(key)) {
    throw new Error(`tr_key(goldCode)는 9자 영숫자 종목코드여야 함: ${key}`);
  }
}

// 구독 그룹 하나(하나의 tr_cd + 그 tr_key 목록)를 검증·정규화한다. 통보 채널
// (isNotification)만 trKeys를 비워도 되고(빈 문자열 하나로 구독), 그 외 채널은
// 최소 1개 필요(2026-09-02 코드리뷰 MEDIUM 지적 — 예전엔 아무 채널에나 빈
// trKeys를 주면 조용히 tr_key:""로 구독돼 등록 슬롯만 낭비했다).
function normalizeSubscription({ trCd, trKeys }) {
  if (!Object.hasOwn(ALL_REALTIME_CHANNELS, trCd)) throw new Error(`알 수 없는 실시간 채널코드: ${trCd}`);
  const channel = ALL_REALTIME_CHANNELS[trCd];
  if (!trKeys || trKeys.length === 0) {
    if (!channel.isNotification) throw new Error(`tr_key가 필요한 채널(${trCd})에 빈 trKeys는 허용 안 됨`);
    return { trCd, keys: [''] };
  }
  const keys = [...new Set(trKeys.map(String))];
  for (const key of keys) validateTrKey(channel.trKeyKind, key);
  return { trCd, keys };
}

// 실시간 세션 하나를 연다 — 소켓 하나에 여러 tr_cd를 동시에 등록할 수 있다(예:
// 시세(mc)+체결통보(d2)를 한 소켓으로 — 2026-09-02 코드리뷰 MEDIUM 지적: 앱키당
// 동시 세션이 2개뿐이라 채널마다 소켓을 하나씩 열면 시세+통보만으로 한도를 다
// 쓴다). `subscriptions`의 모든 tr_cd는 같은 포트로 귀결돼야 한다 — krstock·krgold는
// 시세+통보가 전부 7070이라 항상 섞을 수 있지만, **gbstock은 시세(rh·rc·RH·RC)가
// 7080·통보(d0·d1)가 7070이라 같은 소켓에 못 섞는다**(2026-09-02 라이브로 직접
// 재현·확인 — gbstock을 붙이기 전엔 이 조합 자체가 없어서 몰랐던 제약). gbstock
// 시세+통보를 동시에 받으려면 세션 2개(앱키당 한도와 정확히 같음)를 각각 열어야
// 함, 캐치가 필요하면 이 부분 설계 재검토 대상.
//
// ⚠️ v1 범위: 한 세션당 최대 10건(maxKeysPerSession, 모든 tr_cd 합산)까지만
// 지원 — 그 이상은 여러 세션으로 나눠야 하는데(공식 SDK가 하는 방식) 이 프로젝트의
// 첫 실사용처엔 필요 없어 지금은 구현 안 함(10건 초과 시 명시적으로 throw, 조용히
// 잘라서 보내지 않음 — 필요해지면 SDK의 청크 분할·동시세션 2개 캡 로직을 이식할
// 것). 동시 세션 2개 캡(WSS10015)도 이 모듈은 카운팅하지 않는다 — 호출측이 여러
// 세션을 동시에 열 계획이면 직접 관리해야 함.
export function subscribeRealtime({
  subscriptions, token, onMessage, onAck, onError, onClose, WebSocketImpl = WebSocket,
}) {
  if (!subscriptions?.length) throw new Error('subscriptions는 최소 1개 이상이어야 함');
  const groups = subscriptions.map(normalizeSubscription);
  const totalKeys = groups.reduce((sum, g) => sum + g.keys.length, 0);
  if (totalKeys > WS_SERVER_LIMITS.maxKeysPerSession) {
    throw new Error(`한 세션당 최대 ${WS_SERVER_LIMITS.maxKeysPerSession}건까지만 구독 가능(요청 ${totalKeys}건 합산) — 여러 세션 분할은 아직 미구현`);
  }
  const ports = new Set(groups.map((g) => wsUrl(g.trCd)));
  if (ports.size > 1) throw new Error('한 소켓에서 서로 다른 포트(국내/해외 시세)로 귀결되는 채널을 섞을 수 없음');

  const url = [...ports][0];
  const ws = new WebSocketImpl(url);
  let closed = false;

  // close·error는 항상 내부에서 먼저 받아 closed를 갱신한다(2026-09-02 코드리뷰
  // HIGH 지적 — 예전엔 onClose·onError 콜백을 준 경우에만 리스너를 달아서, 콜백을
  // 안 준 기본 사용에선 서버가 먼저 끊어도(예: 10건 초과 시 code 1000 "Bye") 이
  // 모듈이 그 사실을 전혀 모른 채 죽은 소켓에 계속 send를 시도했다).
  ws.addEventListener('close', (ev) => { closed = true; onClose?.(ev); });
  ws.addEventListener('error', (ev) => { closed = true; onError?.(ev); });

  ws.addEventListener('open', async () => {
    try {
      for (const g of groups) {
        for (const key of g.keys) {
          await throttleSend();
          if (closed) return;
          ws.send(JSON.stringify({ header: { token, tr_type: '1' }, body: { tr_cd: g.trCd, tr_key: key } }));
        }
      }
    } catch (e) {
      // 2026-09-02 코드리뷰 HIGH 지적 — open 핸들러는 async라 여기서 던지면 이벤트
      // 루프 바깥에서 unhandled rejection이 돼 process가 죽는다(catch 불가능한
      // 경로). onError로 넘겨 호출측이 처리하게 한다(close()의 기존 방어 패턴과 통일).
      onError?.(e);
    }
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; } // 프로토콜 외 메시지는 무시(공식 SDK와 동일)
    // header 자체가 없는 프레임은 시세로 오인하지 않는다(2026-09-02 코드리뷰 LOW
    // 지적 — 그대로 onMessage에 넘기면 호출측이 진짜 시세로 착각할 수 있음).
    if (!msg || typeof msg !== 'object' || !msg.header || typeof msg.header !== 'object') {
      onError?.(new Error(`실시간 메시지에 header 없음(형식 불명): ${ev.data?.slice?.(0, 200) ?? ''}`));
      return;
    }
    if (isAck(msg)) {
      if (!isAckSuccess(msg)) {
        // 2026-09-02 코드리뷰 HIGH 지적 — 구독 실패 ACK(WSS10015 세션초과·WSS10010
        // 전송과다·WSS10006 포트오류 등)를 예전엔 onAck에만 넘기고 onAck을 안 준
        // 기본 사용에선 그대로 버려졌다. 세션이 "살아있는데 아무것도 안 오는" 가장
        // 위험한 불명 상태라 onError로도 반드시 알린다.
        onError?.(new Error(`실시간 구독 실패(${msg.header?.tr_cd}): ${msg.header?.rsp_cd ?? ''} ${msg.header?.rsp_msg ?? ''}`.trim()));
      }
      onAck?.(msg);
      return;
    }
    onMessage?.(msg);
  });

  return {
    // 연결을 바로 닫는다 — 구독해제 메시지를 보내지 않는다(위 파일 헤더 주석 —
    // 2026-09-02 라이브 실측으로 해제 메시지 없이 소켓만 닫아도 서버 세션카운트가
    // 즉시 반납됨을 확인, 명시적 해제는 최대 1초 지연만 늘릴 뿐 불필요했다).
    // 이미 닫힌 세션에 또 close()를 불러도 안전(idempotent, 2026-09-02 코드리뷰
    // MEDIUM 지적).
    close: () => {
      if (closed) return;
      closed = true;
      ws.close();
    },
  };
}
