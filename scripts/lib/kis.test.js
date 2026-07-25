import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKisExpiry, parseQuoteResponse, buildRealtimeRows, getKrQuote } from './kis.mjs';

// fetch 모킹 헬퍼 — 호출마다 큐에서 다음 응답을 꺼내 반환.
const mockFetch = (responses) => {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok !== false, status: r.status ?? 200, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
};

test('parseKisExpiry: KIS 만료 형식(YYYY-MM-DD HH:MM:SS, KST) → UTC epoch', () => {
  // 2026-07-23 15:00:00 KST = 2026-07-23 06:00:00 UTC
  const epoch = parseKisExpiry('2026-07-23 15:00:00');
  const d = new Date(epoch);
  assert.equal(d.toISOString(), '2026-07-23T06:00:00.000Z');
});

test('parseKisExpiry: 형식이 안 맞으면 0(즉시 만료 취급)', () => {
  assert.equal(parseKisExpiry('garbage'), 0);
  assert.equal(parseKisExpiry(''), 0);
  assert.equal(parseKisExpiry(undefined), 0);
});

test('parseQuoteResponse: 정상 응답에서 현재가·등락률 추출', () => {
  const q = parseQuoteResponse({ rt_cd: '0', output: { stck_prpr: '75000', prdy_ctrt: '1.35' } });
  assert.equal(q.price, 75000);
  assert.equal(q.changePct, 1.35);
});

test('parseQuoteResponse: 등락률 없으면 null(가격은 살아있으면 통과)', () => {
  const q = parseQuoteResponse({ rt_cd: '0', output: { stck_prpr: '75000', prdy_ctrt: '' } });
  assert.equal(q.price, 75000);
  assert.equal(q.changePct, null);
});

test('parseQuoteResponse: rt_cd 실패 코드면 throw(msg1 인용)', () => {
  assert.throws(
    () => parseQuoteResponse({ rt_cd: '1', msg1: '모의투자 미지원 종목' }),
    /모의투자 미지원 종목/
  );
});

test('parseQuoteResponse: 현재가 파싱 불가면 throw', () => {
  assert.throws(() => parseQuoteResponse({ rt_cd: '0', output: { stck_prpr: '' } }));
  assert.throws(() => parseQuoteResponse({ rt_cd: '0', output: {} }));
});

test('buildRealtimeRows: 성공 종목은 새 행, 실패 종목은 직전 행 carry-forward', () => {
  const holdings = [{ name: '삼성전자', code: '005930' }, { name: '현대차', code: '005380' }];
  const quotes = new Map([['삼성전자', { price: 75000, changePct: 1.2 }]]); // 현대차는 이번에 실패(맵에 없음)
  const prevRows = [
    ['삼성전자', 'KR', '005930', 74000, 0.5, '2026-07-23 09:30'],
    ['현대차', 'KR', '005380', 250000, -0.8, '2026-07-23 09:29'],
  ];
  const rows = buildRealtimeRows(holdings, quotes, prevRows, '2026-07-23 09:31');

  // 티커는 ' 접두(시트 숫자 변환으로 앞자리 0 손실 방지) — 새로 쓰는 행만 해당.
  assert.deepEqual(rows[0], ['삼성전자', 'KR', "'005930", 75000, 1.2, '2026-07-23 09:31']);
  // 현대차는 직전 행 그대로(갱신시각도 안 바뀜 — 이번엔 실제로 못 가져왔다는 신호)
  assert.deepEqual(rows[1], ['현대차', 'KR', '005380', 250000, -0.8, '2026-07-23 09:29']);
});

test('buildRealtimeRows: 직전 행이 없고 이번에도 실패한 종목은 행 자체를 생략', () => {
  const holdings = [{ name: '신규종목', code: '000001' }];
  const rows = buildRealtimeRows(holdings, new Map(), [], '2026-07-23 09:31');
  assert.equal(rows.length, 0);
});

test('buildRealtimeRows: 등락률 없으면 빈 문자열(0과 구분)', () => {
  const holdings = [{ name: '삼성전자', code: '005930' }];
  const quotes = new Map([['삼성전자', { price: 75000, changePct: null }]]);
  const rows = buildRealtimeRows(holdings, quotes, [], '2026-07-23 09:31');
  assert.equal(rows[0][4], '');
});

test('getKrQuote: 레이트리밋(EGW00201) 응답이면 재시도 후 성공', async () => {
  const fetchImpl = mockFetch([
    { body: { rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수를 초과하였습니다.' } },
    { body: { rt_cd: '0', output: { stck_prpr: '75000', prdy_ctrt: '1.2' } } },
  ]);
  const q = await getKrQuote({ token: 't', appkey: 'k', appsecret: 's', code: '005930', fetchImpl, retryDelayMs: 1 });
  assert.equal(q.price, 75000);
});

test('getKrQuote: 재시도 소진 후에도 레이트리밋이면 결국 throw', async () => {
  const fetchImpl = mockFetch([{ body: { rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수를 초과하였습니다.' } }]);
  await assert.rejects(
    () => getKrQuote({ token: 't', appkey: 'k', appsecret: 's', code: '005930', fetchImpl, retries: 1, retryDelayMs: 1 }),
    /초당 거래건수/
  );
});

test('getKrQuote: 레이트리밋 아닌 다른 오류(rt_cd 실패)는 즉시 throw(재시도 안 함)', async () => {
  const fetchImpl = mockFetch([{ body: { rt_cd: '1', msg_cd: 'OTHER', msg1: '모의투자 미지원 종목' } }]);
  await assert.rejects(
    () => getKrQuote({ token: 't', appkey: 'k', appsecret: 's', code: '005930', fetchImpl, retryDelayMs: 1 }),
    /모의투자 미지원 종목/
  );
});

test('buildRealtimeRows: 보유종목이 매도돼 사라지면(더 이상 holdings에 없음) 그 행도 자연히 빠짐', () => {
  const holdings = [{ name: '삼성전자', code: '005930' }]; // 현대차는 이제 holdings에 없음
  const quotes = new Map([['삼성전자', { price: 75000, changePct: 1.2 }]]);
  const prevRows = [
    ['삼성전자', 'KR', '005930', 74000, 0.5, '2026-07-23 09:30'],
    ['현대차', 'KR', '005380', 250000, -0.8, '2026-07-23 09:29'],
  ];
  const rows = buildRealtimeRows(holdings, quotes, prevRows, '2026-07-23 09:31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], '삼성전자');
});
