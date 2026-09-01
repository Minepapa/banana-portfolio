import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isNhSuccess, classifyAcctType, callNh, listNhAccounts, setNhRateLimitForTests, getNhToken,
} from './nhplug.mjs';

// 실제 속도제한(초당 4회 슬라이딩 윈도우)을 끄지 않으면 이 파일이 callNh를 여러 번
// 부르는 테스트마다 최대 1초씩 실제로 기다린다(2026-09-01 실측) — 테스트는 무제한으로.
setNhRateLimitForTests(Infinity);

// fetch 모킹 헬퍼 — kis.test.js와 동일 패턴.
const mockFetch = (responses) => {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok !== false, status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
  };
};

test('isNhSuccess: 기본 성공코드(00000·00166·00221·13578) 전부 성공으로 판정', () => {
  for (const code of ['00000', '00166', '00221', '13578']) {
    assert.equal(isNhSuccess(code, '아무 메시지'), true);
  }
});

test('isNhSuccess: rsp_cd가 없으면(null/undefined) 성공으로 판정(rsp_cd 자체가 없는 API도 있음)', () => {
  assert.equal(isNhSuccess(null, undefined), true);
  assert.equal(isNhSuccess(undefined, undefined), true);
});

test('isNhSuccess: 알려진 코드가 아니어도 rsp_msg에 "완료"가 있으면 성공(공식 SDK와 동일 판정)', () => {
  assert.equal(isNhSuccess('99999', '주문이 정상 완료되었습니다.'), true);
});

test('[막아야 함] isNhSuccess: 알려진 코드가 아니고 rsp_msg에 "완료"도 없으면 실패(단일 rt_cd 비교로 옮기면 이 케이스가 성공으로 오판됨)', () => {
  assert.equal(isNhSuccess('10006', '종목코드 항목을 입력하세요.'), false);
  assert.equal(isNhSuccess('99999', undefined), false);
});

test('classifyAcctType: 01=운영(일반)·02=운영(주문대리인)·03=모의투자', () => {
  assert.equal(classifyAcctType('01'), '운영(일반)');
  assert.equal(classifyAcctType('02'), '운영(주문대리인)');
  assert.equal(classifyAcctType('03'), '모의투자(이 클라이언트 미사용 도메인)');
});

test('classifyAcctType: 미정의 코드는 안전하게 "미정의"로(추정 안 함)', () => {
  assert.match(classifyAcctType('09'), /미정의\(09\)/);
  assert.match(classifyAcctType(''), /미정의\(없음\)/);
  assert.match(classifyAcctType(undefined), /미정의\(없음\)/);
});

test('callNh: 정상 응답(rsp_cd 없음)이면 body 그대로 반환', async () => {
  const fetchImpl = mockFetch([{ body: { Output_0: { foo: 'bar' } } }]);
  const body = await callNh({ token: 't', uri: '/n2/acctinfo', input0: {}, fetchImpl });
  assert.deepEqual(body.Output_0, { foo: 'bar' });
});

test('[막아야 함] callNh: rsp_cd가 실패코드면 throw하고 err.code·err.businessRejection=true를 실어보낸다(호출측이 이 값으로 confirmedNotSent 승격 판단)', async () => {
  const fetchImpl = mockFetch([{ body: { rsp_cd: '10006', rsp_msg: '종목코드 항목을 입력하세요.' } }]);
  try {
    await callNh({ token: 't', uri: '/krstock/order/v1/cashBuy', input0: {}, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.code, '10006');
    assert.equal(e.businessRejection, true);
    assert.match(e.message, /종목코드 항목을 입력하세요/);
  }
});

test('callNh: HTTP 429는 즉시 throw(NH는 자동재시도 대상 아님, KIS의 EGW00201 재시도와 다름) + err.code="RATE_LIMIT"', async () => {
  const fetchImpl = mockFetch([{ status: 429, body: { rsp_msg: '초당 호출한도 초과' } }]);
  try {
    await callNh({ token: 't', uri: '/krstock/quote/v1/currentPrice', input0: {}, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.code, 'RATE_LIMIT');
  }
});

test('[막아야 함] callNh: 429는 businessRejection 안 붙음(게이트웨이 단 유량초과는 주문이 브로커까지 도달했는지 모름 — confirmedNotSent 승격 금지, 2026-09-01 코드리뷰 HIGH 재현 케이스)', async () => {
  const fetchImpl = mockFetch([{ status: 429, body: { rsp_msg: '초당 호출한도 초과' } }]);
  try {
    await callNh({ token: 't', uri: '/krstock/order/v1/cashBuy', input0: {}, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.businessRejection, undefined);
  }
});

test('callNh: 429 응답 몸통이 JSON이 아니어도(게이트웨이 HTML 등) RATE_LIMIT로 분류(원문 일부 인용)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => '<html>Too Many Requests</html>' });
  try {
    await callNh({ token: 't', uri: '/n2/acctinfo', input0: {}, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.code, 'RATE_LIMIT');
    assert.match(e.message, /Too Many Requests/);
  }
});

test('callNh: 몸통이 JSON이 아니면 즉시 throw(원문 일부 인용)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, text: async () => 'Bad Gateway' });
  await assert.rejects(
    () => callNh({ token: 't', uri: '/n2/acctinfo', input0: {}, fetchImpl }),
    /Bad Gateway/,
  );
});

// 2026-09-01 코드리뷰 HIGH 실측 재현 케이스 — HTTP 401(토큰 만료 등) 응답이 rsp_cd
// 없는 에러 봉투({"error":"invalid_token"})로 오면, isNhSuccess의 "rsp_cd 없으면
// 성공" 폴백이 이걸 그대로 삼켜 listNhAccounts 등이 빈 배열/빈 객체를 "정상 조회
// 결과"로 반환해버렸다(계좌 0건이 실제로는 인증 만료 때문인데 조용히 숨겨짐).
test('[막아야 함] callNh: HTTP 401(rsp_cd 없는 에러 봉투)은 성공으로 오판되지 않고 throw됨', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'invalid_token', error_description: 'expired' }) });
  await assert.rejects(
    () => callNh({ token: 'expired', uri: '/n2/acctinfo', input0: {}, fetchImpl }),
    /HTTP 401/,
  );
});

test('[막아야 함] callNh: HTTP 401이어도 businessRejection 안 붙음(전송계층 실패 — "브로커가 명시적으로 거부"와 다름)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'invalid_token' }) });
  try {
    await callNh({ token: 'expired', uri: '/krstock/order/v1/cashBuy', input0: {}, fetchImpl });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.businessRejection, undefined);
  }
});

test('callNh: HTTP 오류 상태여도 몸통에 알려진 성공코드(rsp_cd)가 실려오면 그대로 통과(KIS의 레이트리밋-500 실측 사례와 동일한 방어적 처리)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ rsp_cd: '00000', Output_0: { foo: 'bar' } }) });
  const body = await callNh({ token: 't', uri: '/n2/acctinfo', input0: {}, fetchImpl });
  assert.deepEqual(body.Output_0, { foo: 'bar' });
});

test('listNhAccounts: Output_0 배열을 acctNo·acctType·acctTypeLabel로 정리', async () => {
  const fetchImpl = mockFetch([{
    body: { Output_0: [{ acct_no: '20501596019', acct_type: '01' }, { acct_no: '50071234567', acct_type: '03' }] },
  }]);
  const accounts = await listNhAccounts({ token: 't', fetchImpl });
  assert.deepEqual(accounts, [
    { acctNo: '20501596019', acctType: '01', acctTypeLabel: '운영(일반)' },
    { acctNo: '50071234567', acctType: '03', acctTypeLabel: '모의투자(이 클라이언트 미사용 도메인)' },
  ]);
});

test('listNhAccounts: Output_0이 없으면(응답 형태가 예상과 다름) 빈 배열(추정 안 함)', async () => {
  const fetchImpl = mockFetch([{ body: {} }]);
  const accounts = await listNhAccounts({ token: 't', fetchImpl });
  assert.deepEqual(accounts, []);
});

test('[막아야 함] listNhAccounts: HTTP 401(토큰 만료)이면 빈 배열로 조용히 넘어가지 않고 throw(2026-09-01 코드리뷰 HIGH 실측 재현 — 예전엔 계좌 0건을 "정상"으로 반환했음)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'invalid_token' }) });
  await assert.rejects(() => listNhAccounts({ token: 'expired', fetchImpl }), /HTTP 401/);
});

// getNhToken — 파일 기반 캐시라 매 테스트마다 고유 appkey를 써서(실제 발급 이력이나
// 다른 테스트 실행분의 캐시와 절대 충돌 안 하게) "캐시 미스로 시작"을 보장한다
// (kis.mjs의 getKisToken은 이 부분 테스트가 아예 없음 — 이번에 처음 커버).
function uniqueAppkey(label) {
  return `test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test('getNhToken: 정상 응답이면 access_token 반환 + 캐시에 기록돼 재호출 시 네트워크 안 탐', async () => {
  const appkey = uniqueAppkey('fresh');
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'abc123', expires_in: 86400 }) };
  };
  const token1 = await getNhToken({ appkey, appsecret: 's', fetchImpl });
  assert.equal(token1, 'abc123');
  assert.equal(calls, 1);

  // 같은 appkey로 재호출 — fetchImpl이 또 불리면 캐시가 안 먹은 것(throw로 감지).
  const cachedOnlyFetch = async () => { throw new Error('캐시를 안 쓰고 네트워크를 또 탔음'); };
  const token2 = await getNhToken({ appkey, appsecret: 's', fetchImpl: cachedOnlyFetch });
  assert.equal(token2, 'abc123');
});

test('getNhToken: 응답 실패(!res.ok)면 throw', async () => {
  const appkey = uniqueAppkey('http-fail');
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'invalid_client' }) });
  await assert.rejects(() => getNhToken({ appkey, appsecret: 's', fetchImpl }), /토큰 발급 실패/);
});

test('getNhToken: HTTP 200인데 access_token이 없으면 throw', async () => {
  const appkey = uniqueAppkey('no-token');
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ scope: 'oob' }) });
  await assert.rejects(() => getNhToken({ appkey, appsecret: 's', fetchImpl }), /토큰 발급 실패/);
});

test('getNhToken: 몸통이 JSON이 아니면 throw', async () => {
  const appkey = uniqueAppkey('non-json');
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => 'not json' });
  await assert.rejects(() => getNhToken({ appkey, appsecret: 's', fetchImpl }), /JSON 아님/);
});

// 속도제한 자체는 실제로 동작해야 한다 — 위에서 테스트 편의를 위해 무제한으로 꺼뒀지만
// (setNhRateLimitForTests(Infinity)), 그 스위치가 진짜 동작을 대체하는 건 아니므로
// 이 테스트만 잠시 낮은 한도로 켰다가 되돌려 슬라이딩 윈도우가 실제로 지연시키는지
// 직접 확인한다(nhplug-sdk의 test_pagination_throttle.py와 동일 검증 철학).
test('callNh: 속도제한이 켜져 있으면(초당 2회) 3번째 호출부터 실제로 지연됨', async () => {
  setNhRateLimitForTests(2);
  try {
    const fetchImpl = mockFetch([{ body: { ok: true } }, { body: { ok: true } }, { body: { ok: true } }]);
    const start = Date.now();
    await callNh({ token: 't', uri: '/n2/acctinfo', input0: {}, fetchImpl });
    await callNh({ token: 't', uri: '/n2/acctinfo', input0: {}, fetchImpl });
    await callNh({ token: 't', uri: '/n2/acctinfo', input0: {}, fetchImpl });
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 900, `3번째 호출이 슬라이딩 윈도우에 걸려 최소 ~1초 지연돼야 함(실측 ${elapsed}ms)`);
  } finally {
    setNhRateLimitForTests(Infinity);
  }
});
