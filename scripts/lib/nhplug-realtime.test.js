import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wsUrl, isAck, isAckSuccess, subscribeRealtime,
  setNhWsRateLimitForTests, resetNhWsThrottleForTests,
  KRSTOCK_REALTIME_CHANNELS, WS_SERVER_LIMITS,
} from './nhplug-realtime.mjs';

// nhplug.mjs REST 속도제한 테스트와 동일 이유(전송제한이 테스트를 실제로 늦추는 걸
// 방지) — 이 파일 대부분에서 끈다. 실제 throttle 동작을 검증하는 테스트만
// 파일 하단에서 유한값으로 되돌려 쓴다.
setNhWsRateLimitForTests(Infinity);

// 실제 WebSocket을 흉내내는 테스트 더블 — EventTarget 기반. 2026-09-02 코드리뷰
// 지적으로 실제 WebSocket 시맨틱에 맞춰 강화:
// - readyState를 추적(CONNECTING/OPEN/CLOSING/CLOSED), send()는 CONNECTING일 때만
//   throw(실측: 실제 WebSocket은 CLOSED에서 send해도 안 던지고 조용히 버림).
// - close()는 CloseEvent({code,reason})를 던지고, 이미 닫힌 소켓에 또 close()해도
//   이벤트를 중복 발사하지 않는다(실제 소켓은 close 한 번만 낸다).
const READY = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
class FakeWebSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.readyState = READY.CONNECTING;
  }

  send(data) {
    if (this.readyState === READY.CONNECTING) throw new DOMException('Sent before connected.', 'InvalidStateError');
    if (this.readyState !== READY.OPEN) return; // 실제 WebSocket: CLOSED여도 조용히 버림(안 던짐)
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = '') {
    if (this.readyState === READY.CLOSED) return; // 중복 close는 무시(실제 소켓과 동일)
    this.readyState = READY.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }

  emitOpen() { this.readyState = READY.OPEN; this.dispatchEvent(new Event('open')); }

  emitMessage(obj) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(obj) })); }

  // 서버가 먼저 끊는 경우(예: 10건 초과 시 code 1000 "Bye") 흉내
  emitServerClose(code = 1000, reason = 'Bye') {
    this.readyState = READY.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }
}

const ackOk = (trCd, trKey) => ({
  header: { tr_type: '1', tr_cd: trCd, rsp_cd: '00000', rsp_msg: '정상처리되었습니다' },
  body: { tr_key: [trKey] },
});

test('wsUrl: 국내 시세/통보 채널은 7070, 해외 시세 채널(RH·RC)은 7080', () => {
  assert.equal(wsUrl('mc'), 'wss://api.nhplug.com:7070/websocket');
  assert.equal(wsUrl('d2'), 'wss://api.nhplug.com:7070/websocket');
  assert.equal(wsUrl('RH'), 'wss://api.nhplug.com:7080/websocket');
});

test('isAck: header에 tr_type 또는 rsp_cd가 있으면 ACK, 데이터 푸시(tr_cd·tr_key만)는 아님', () => {
  assert.equal(isAck({ header: { tr_type: '1', tr_cd: 'mc', rsp_cd: '00000' }, body: {} }), true);
  assert.equal(isAck({ header: { tr_cd: 'mc', tr_key: '005930' }, body: { price: '253000' } }), false);
});

test('isAck: tr_type이 명시적으로 null이고 rsp_cd도 없으면 ACK 아님(in 연산자 오판 방지)', () => {
  assert.equal(isAck({ header: { tr_cd: 'mc', tr_type: null }, body: {} }), false);
});

test('isAckSuccess: rsp_cd가 00000이면 true, 그 외(WSS10015 등)나 ACK 아니면 false', () => {
  assert.equal(isAckSuccess(ackOk('mc', '005930')), true);
  assert.equal(isAckSuccess({ header: { tr_type: '1', rsp_cd: 'WSS10015', rsp_msg: '세션초과' }, body: {} }), false);
  assert.equal(isAckSuccess({ header: { tr_cd: 'mc', tr_key: '005930' }, body: {} }), false);
});

test('isAckSuccess: rsp_cd 자체가 없는 ACK(tr_type만 있음)은 실패로 오판하지 않고 성공 취급', () => {
  assert.equal(isAckSuccess({ header: { tr_type: '2' }, body: {} }), true);
});

test('subscribeRealtime: subscriptions가 비어있으면 즉시 throw', () => {
  assert.throws(() => subscribeRealtime({ subscriptions: [], token: 't', WebSocketImpl: FakeWebSocket }));
});

test('subscribeRealtime: 알 수 없는 채널코드면 즉시 throw(네트워크 연결 자체를 안 함)', () => {
  assert.throws(() => subscribeRealtime({
    subscriptions: [{ trCd: 'zz', trKeys: ['005930'] }], token: 't', WebSocketImpl: FakeWebSocket,
  }));
});

test('subscribeRealtime: 프로토타입 체인 프로퍼티(constructor 등)를 채널코드로 주면 통과 안 됨(2026-09-02 코드리뷰 지적)', () => {
  for (const bad of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.throws(() => subscribeRealtime({
      subscriptions: [{ trCd: bad, trKeys: ['005930'] }], token: 't', WebSocketImpl: FakeWebSocket,
    }), `${bad}가 통과됨`);
  }
});

test('subscribeRealtime: 시세 채널(통보 아님)에 trKeys를 비우면 즉시 throw(빈 tr_key로 등록슬롯 낭비 방지)', () => {
  assert.throws(() => subscribeRealtime({
    subscriptions: [{ trCd: 'mc', trKeys: [] }], token: 't', WebSocketImpl: FakeWebSocket,
  }));
});

test('subscribeRealtime: 통보 채널(d2)은 trKeys를 비우면 빈 문자열 하나로 구독', async () => {
  let ws;
  const Impl = class extends FakeWebSocket { constructor(url) { super(url); ws = this; } };
  subscribeRealtime({ subscriptions: [{ trCd: 'd2', trKeys: [] }], token: 'TOK', WebSocketImpl: Impl });
  ws.emitOpen();
  await new Promise((r) => { setTimeout(r, 10); });
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].body.tr_key, '');
});

test('subscribeRealtime: code 채널의 tr_key가 6자리 숫자가 아니면 즉시 throw(형식 검증)', () => {
  for (const bad of ['abc123', '12345', '1234567', null, undefined, {}]) {
    assert.throws(() => subscribeRealtime({
      subscriptions: [{ trCd: 'mc', trKeys: [bad] }], token: 't', WebSocketImpl: FakeWebSocket,
    }), `${JSON.stringify(bad)}가 통과됨`);
  }
});

test('subscribeRealtime: 중복 tr_key는 중복 제거 후 전송(등록슬롯 낭비 방지)', async () => {
  let ws;
  const Impl = class extends FakeWebSocket { constructor(url) { super(url); ws = this; } };
  subscribeRealtime({
    subscriptions: [{ trCd: 'mc', trKeys: ['005930', '005930', '000660'] }], token: 'TOK', WebSocketImpl: Impl,
  });
  ws.emitOpen();
  await new Promise((r) => { setTimeout(r, 10); });
  assert.equal(ws.sent.length, 2);
});

test('subscribeRealtime: 여러 tr_cd를 합산해 세션당 10건(maxKeysPerSession) 초과면 즉시 throw', () => {
  const keysA = Array.from({ length: 6 }, (_, i) => String(100000 + i));
  const keysB = Array.from({ length: 5 }, (_, i) => String(200000 + i));
  assert.throws(() => subscribeRealtime({
    subscriptions: [{ trCd: 'mc', trKeys: keysA }, { trCd: 'oc', trKeys: keysB }],
    token: 't', WebSocketImpl: FakeWebSocket,
  }));
});

test('subscribeRealtime: 서로 다른 포트로 귀결되는 채널(국내 mc + 해외 RH)을 한 세션에 섞으면 throw', () => {
  assert.throws(() => subscribeRealtime({
    subscriptions: [{ trCd: 'mc', trKeys: ['005930'] }, { trCd: 'RH', trKeys: ['x'] }],
    token: 't', WebSocketImpl: FakeWebSocket,
  }));
});

test('subscribeRealtime: 한 소켓에 시세(mc)+통보(d2)를 함께 구독 가능(둘 다 7070 — 2026-09-02 코드리뷰 지적으로 신설된 다중구독)', async () => {
  let ws;
  const Impl = class extends FakeWebSocket { constructor(url) { super(url); ws = this; } };
  subscribeRealtime({
    subscriptions: [{ trCd: 'mc', trKeys: ['005930'] }, { trCd: 'd2', trKeys: [] }],
    token: 'TOK', WebSocketImpl: Impl,
  });
  ws.emitOpen();
  await new Promise((r) => { setTimeout(r, 10); });
  assert.equal(ws.sent.length, 2);
  assert.equal(ws.sent[0].body.tr_cd, 'mc');
  assert.equal(ws.sent[1].body.tr_cd, 'd2');
});

test('subscribeRealtime: open 시점에 각 trKey마다 구독(tr_type:1) 메시지를 보낸다', async () => {
  let ws;
  const Impl = class extends FakeWebSocket { constructor(url) { super(url); ws = this; } };
  subscribeRealtime({ subscriptions: [{ trCd: 'mc', trKeys: ['005930', '000660'] }], token: 'TOK', WebSocketImpl: Impl });
  ws.emitOpen();
  await new Promise((r) => { setTimeout(r, 10); });
  assert.equal(ws.sent.length, 2);
  assert.deepEqual(ws.sent[0], { header: { token: 'TOK', tr_type: '1' }, body: { tr_cd: 'mc', tr_key: '005930' } });
  assert.deepEqual(ws.sent[1], { header: { token: 'TOK', tr_type: '1' }, body: { tr_cd: 'mc', tr_key: '000660' } });
});

test('subscribeRealtime: ACK 메시지는 onAck로, 데이터 푸시는 onMessage로 각각 라우팅', async () => {
  let ws;
  const Impl = class extends FakeWebSocket { constructor(url) { super(url); ws = this; } };
  const acks = []; const pushes = [];
  subscribeRealtime({
    subscriptions: [{ trCd: 'mc', trKeys: ['005930'] }], token: 'TOK', WebSocketImpl: Impl,
    onAck: (m) => acks.push(m), onMessage: (m) => pushes.push(m),
  });
  ws.emitOpen();
  await new Promise((r) => { setTimeout(r, 10); });
  ws.emitMessage(ackOk('mc', '005930'));
  ws.emitMessage({ header: { tr_cd: 'mc', tr_key: '005930' }, body: { price: '253000' } });
  assert.equal(acks.length, 1);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].body.price, '253000');
});

test('subscribeRealtime: 구독 실패 ACK(WSS10015 등)는 onAck뿐 아니라 onError로도 알림(2026-09-02 코드리뷰 HIGH 지적)', async () => {
  let ws;
  const Impl = class extends FakeWebSocket { constructor(url) { super(url); ws = this; } };
  const errors = []; const acks = [];
  subscribeRealtime({
    subscriptions: [{ trCd: 'mc', trKeys: ['005930'] }], token: 'TOK', WebSocketImpl: Impl,
    onAck: (m) => acks.push(m), onError: (e) => errors.push(e),
  });
  ws.emitOpen();
  await new Promise((r) => { setTimeout(r, 10); });
  ws.emitMessage({ header: { tr_type: '1', tr_cd: 'mc', rsp_cd: 'WSS10015', rsp_msg: '세션초과' }, body: {} });
  assert.equal(acks.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /WSS10015/);
});

test('subscribeRealtime: 성공 ACK은 onError를 안 부름', async () => {
  let ws;
  const Impl = class extends FakeWebSocket { constructor(url) { super(url); ws = this; } };
  const errors = [];
  subscribeRealtime({
    subscriptions: [{ trCd: 'mc', trKeys: ['005930'] }], token: 'TOK', WebSocketImpl: Impl, onError: (e) => errors.push(e),
  });
  ws.emitOpen();
  await new Promise((r) => { setTimeout(r, 10); });
  ws.emitMessage(ackOk('mc', '005930'));
  assert.equal(errors.length, 0);
});

test('subscribeRealtime: JSON이 아닌 메시지는 조용히 무시(공식 SDK와 동일 — throw하거나 죽지 않음)', async () => {
  let ws;
  const Impl = class extends FakeWebSocket { constructor(url) { super(url); ws = this; } };
  const pushes = [];
  subscribeRealtime({
    subscriptions: [{ trCd: 'mc', trKeys: ['005930'] }], token: 'TOK', WebSocketImpl: Impl, onMessage: (m) => pushes.push(m),
  });
  ws.emitOpen();
  await new Promise((r) => { setTimeout(r, 10); });
  assert.doesNotThrow(() => ws.dispatchEvent(new MessageEvent('message', { data: '이건 JSON이 아님' })));
  assert.equal(pushes.length, 0);
});

test('subscribeRealtime: header 없는 메시지는 onMessage로 안 넘기고 onError로 보냄(2026-09-02 코드리뷰 LOW 지적)', async () => {
  let ws;
  const Impl = class extends FakeWebSocket { constructor(url) { super(url); ws = this; } };
  const pushes = []; const errors = [];
  subscribeRealtime({
    subscriptions: [{ trCd: 'mc', trKeys: ['005930'] }], token: 'TOK', WebSocketImpl: Impl,
    onMessage: (m) => pushes.push(m), onError: (e) => errors.push(e),
  });
  ws.emitOpen();
  await new Promise((r) => { setTimeout(r, 10); });
  ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ foo: 'bar' }) }));
  assert.equal(pushes.length, 0);
  assert.equal(errors.length, 1);
});

test('subscribeRealtime: 서버가 먼저 연결을 끊으면(예: 등록초과로 code 1000 "Bye") onClose가 불리고 이후 open 루프의 잔여 전송은 중단됨', async () => {
  let ws;
  const Impl = class extends FakeWebSocket { constructor(url) { super(url); ws = this; } };
  const closes = [];
  subscribeRealtime({
    subscriptions: [{ trCd: 'mc', trKeys: ['005930', '000660', '005380'] }],
    token: 'TOK', WebSocketImpl: Impl, onClose: (ev) => closes.push(ev),
  });
  ws.emitOpen();
  // 첫 전송 직후 서버가 바로 끊는 상황을 흉내(등록초과 시나리오)
  await new Promise((r) => { setTimeout(r, 1); });
  ws.emitServerClose(1000, 'Bye');
  await new Promise((r) => { setTimeout(r, 20); });
  assert.equal(closes.length, 1);
  assert.equal(closes[0].code, 1000);
  assert.equal(closes[0].reason, 'Bye');
});

test('subscribeRealtime: open 핸들러 내부에서 send가 throw해도 프로세스가 안 죽고 onError로 전달됨(2026-09-02 코드리뷰 HIGH 지적 — 예전엔 unhandled rejection)', async () => {
  let ws;
  const Impl = class extends FakeWebSocket {
    constructor(url) { super(url); ws = this; }

    send() { throw new Error('전송 실패'); }
  };
  const errors = [];
  subscribeRealtime({
    subscriptions: [{ trCd: 'mc', trKeys: ['005930'] }], token: 'TOK', WebSocketImpl: Impl, onError: (e) => errors.push(e),
  });
  ws.emitOpen();
  await new Promise((r) => { setTimeout(r, 10); });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /전송 실패/);
});

test('subscribeRealtime: close()는 구독해제 메시지 없이 바로 소켓을 닫는다(2026-09-02 라이브 실측 — 해제 불필요 확인)', async () => {
  let ws;
  const Impl = class extends FakeWebSocket { constructor(url) { super(url); ws = this; } };
  const session = subscribeRealtime({ subscriptions: [{ trCd: 'mc', trKeys: ['005930'] }] , token: 'TOK', WebSocketImpl: Impl });
  ws.emitOpen();
  await new Promise((r) => { setTimeout(r, 10); });
  session.close();
  assert.equal(ws.sent.length, 1); // 구독 1건만, 해제 메시지 없음
  assert.equal(ws.readyState, READY.CLOSED);
});

test('subscribeRealtime: close()를 두 번 불러도 안전(idempotent, 2026-09-02 코드리뷰 MEDIUM 지적)', async () => {
  let ws;
  const Impl = class extends FakeWebSocket { constructor(url) { super(url); ws = this; } };
  const session = subscribeRealtime({ subscriptions: [{ trCd: 'mc', trKeys: ['005930'] }], token: 'TOK', WebSocketImpl: Impl });
  ws.emitOpen();
  await new Promise((r) => { setTimeout(r, 10); });
  session.close();
  assert.doesNotThrow(() => session.close());
});

test('KRSTOCK_REALTIME_CHANNELS: 21개 채널(시세/depth 19 + 통보 2) 등록 확인', () => {
  const all = Object.keys(KRSTOCK_REALTIME_CHANNELS);
  assert.equal(all.length, 21);
  const notifications = all.filter((k) => KRSTOCK_REALTIME_CHANNELS[k].isNotification);
  assert.deepEqual(notifications.sort(), ['d2', 'd3']);
});

test('WS_SERVER_LIMITS: 서버 실측 한도(2026-09-02 라이브 재현 확인값) 노출', () => {
  assert.equal(WS_SERVER_LIMITS.maxSessionsPerAppkey, 2);
  assert.equal(WS_SERVER_LIMITS.maxKeysPerSession, 10);
  assert.equal(WS_SERVER_LIMITS.maxSubscribePerSec, 10);
});

// ============================================================================
// throttleSend 실동작 검증(2026-09-02 코드리뷰 MEDIUM 지적 — 이전엔 파일 전체가
// 무제한화돼 있어 이 로직이 한 번도 실제로 실행된 적이 없었다). 이 테스트만
// 유한한 rate로 되돌리고, 끝나면 다시 무제한화 + 타임스탬프 리셋.
test('throttleSend: rate를 2/sec로 설정하면 3번째 전송부터 실제로 지연됨', async () => {
  setNhWsRateLimitForTests(2);
  resetNhWsThrottleForTests();
  try {
    let ws;
  const Impl = class extends FakeWebSocket { constructor(url) { super(url); ws = this; } };
    subscribeRealtime({
      subscriptions: [{ trCd: 'mc', trKeys: ['005930', '000660', '005380'] }], token: 'TOK', WebSocketImpl: Impl,
    });
    const start = Date.now();
    ws.emitOpen();
    await new Promise((r) => { setTimeout(r, 1100); });
    const elapsed = Date.now() - start;
    assert.equal(ws.sent.length, 3);
    assert.ok(elapsed >= 950, `3건 전송에 최소 1초 지연이 있어야 함(실측 ${elapsed}ms)`);
  } finally {
    setNhWsRateLimitForTests(Infinity);
    resetNhWsThrottleForTests();
  }
});
