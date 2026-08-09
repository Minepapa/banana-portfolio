import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseKisExpiry, parseQuoteResponse, parseUsQuoteResponse, buildRealtimeRows, getKrQuote,
  getUsQuote, isKrMarketOpen, isUsMarketOpen, parseBalanceResponse, getAccountBalance,
  loadIrpAccount, parseInvestorFlowResponse, getKrInvestorFlow,
  parseInvestOpinionResponse, summarizeInvestOpinion, getKrInvestOpinion,
  ORDER_TR_ID, parseOrderResponse, placeKrOrder,
} from './kis.mjs';

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
  const holdings = [{ name: '삼성전자', code: '005930', market: 'KR' }, { name: '현대차', code: '005380', market: 'KR' }];
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
  const holdings = [{ name: '신규종목', code: '000001', market: 'KR' }];
  const rows = buildRealtimeRows(holdings, new Map(), [], '2026-07-23 09:31');
  assert.equal(rows.length, 0);
});

test('buildRealtimeRows: 등락률 없으면 빈 문자열(0과 구분)', () => {
  const holdings = [{ name: '삼성전자', code: '005930', market: 'KR' }];
  const quotes = new Map([['삼성전자', { price: 75000, changePct: null }]]);
  const rows = buildRealtimeRows(holdings, quotes, [], '2026-07-23 09:31');
  assert.equal(rows[0][4], '');
});

test('buildRealtimeRows: 국내·해외 혼합 — market 컬럼이 각 종목대로 기록됨', () => {
  const holdings = [
    { name: '삼성전자', code: '005930', market: 'KR' },
    { name: '테슬라', code: 'TSLA', market: 'US' },
  ];
  const quotes = new Map([
    ['삼성전자', { price: 75000, changePct: 1.2 }],
    ['테슬라', { price: 250.5, changePct: -0.8 }],
  ]);
  const rows = buildRealtimeRows(holdings, quotes, [], '2026-07-23 09:31');
  assert.deepEqual(rows[0], ['삼성전자', 'KR', "'005930", 75000, 1.2, '2026-07-23 09:31']);
  assert.deepEqual(rows[1], ['테슬라', 'US', "'TSLA", 250.5, -0.8, '2026-07-23 09:31']);
});

test('buildRealtimeRows: 이번 폴링에서 시장이 닫혀 조회 자체를 안 한 종목도 carry-forward(quotes 맵에 없음)', () => {
  // 국내장만 열려 해외 종목은 아예 fetch 안 한 상황을 재현 — quotes 맵에 그 이름이 없는 것으로 표현됨.
  const holdings = [
    { name: '삼성전자', code: '005930', market: 'KR' },
    { name: '테슬라', code: 'TSLA', market: 'US' },
  ];
  const quotes = new Map([['삼성전자', { price: 75000, changePct: 1.2 }]]);
  const prevRows = [
    ['삼성전자', 'KR', '005930', 74000, 0.5, '2026-07-23 09:30'],
    ['테슬라', 'US', 'TSLA', 250, -0.5, '2026-07-23 05:59'],
  ];
  const rows = buildRealtimeRows(holdings, quotes, prevRows, '2026-07-23 09:31');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ['테슬라', 'US', 'TSLA', 250, -0.5, '2026-07-23 05:59']);
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

test('getKrQuote: 레이트리밋이 HTTP 500(!res.ok)으로 와도 몸통의 msg_cd로 재시도 후 성공(2026-07 실측 — "항상 HTTP 200" 가정이 틀렸던 버그 수정)', async () => {
  const fetchImpl = mockFetch([
    { ok: false, status: 500, body: { rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수를 초과하였습니다.' } },
    { body: { rt_cd: '0', output: { stck_prpr: '75000', prdy_ctrt: '1.2' } } },
  ]);
  const q = await getKrQuote({ token: 't', appkey: 'k', appsecret: 's', code: '005930', fetchImpl, retryDelayMs: 1 });
  assert.equal(q.price, 75000);
});

test('getKrQuote: HTTP 500 레이트리밋이 재시도 소진 후에도 지속되면 throw(code=EGW00201)', async () => {
  const fetchImpl = mockFetch([{ ok: false, status: 500, body: { rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수를 초과하였습니다.' } }]);
  try {
    await getKrQuote({ token: 't', appkey: 'k', appsecret: 's', code: '005930', fetchImpl, retries: 1, retryDelayMs: 1 });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.code, 'EGW00201');
    assert.match(e.message, /초당 거래건수/);
  }
});

test('getKrQuote: 몸통이 JSON도 아닌 진짜 알 수 없는 HTTP 실패는 즉시 throw(원문 그대로 인용)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); }, text: async () => 'Bad Gateway' });
  await assert.rejects(
    () => getKrQuote({ token: 't', appkey: 'k', appsecret: 's', code: '005930', fetchImpl, retryDelayMs: 1 }),
    /Bad Gateway/
  );
});

test('getKrQuote: 재시도 소진 후 throw된 에러의 code가 msg_cd(EGW00201) — msg1 문구가 아니라 이 값으로 호출측이 레이트리밋을 판별한다(realtime-quotes.mjs가 소비)', async () => {
  const fetchImpl = mockFetch([{ body: { rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수를 초과하였습니다.' } }]);
  try {
    await getKrQuote({ token: 't', appkey: 'k', appsecret: 's', code: '005930', fetchImpl, retries: 1, retryDelayMs: 1 });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.code, 'EGW00201');
  }
});

test('getKrQuote: 레이트리밋 아닌 오류는 code가 그 msg_cd 그대로(EGW00201 아님)', async () => {
  const fetchImpl = mockFetch([{ body: { rt_cd: '1', msg_cd: 'OTHER', msg1: '모의투자 미지원 종목' } }]);
  try {
    await getKrQuote({ token: 't', appkey: 'k', appsecret: 's', code: '005930', fetchImpl, retryDelayMs: 1 });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.code, 'OTHER');
  }
});

test('buildRealtimeRows: 보유종목이 매도돼 사라지면(더 이상 holdings에 없음) 그 행도 자연히 빠짐', () => {
  const holdings = [{ name: '삼성전자', code: '005930', market: 'KR' }]; // 현대차는 이제 holdings에 없음
  const quotes = new Map([['삼성전자', { price: 75000, changePct: 1.2 }]]);
  const prevRows = [
    ['삼성전자', 'KR', '005930', 74000, 0.5, '2026-07-23 09:30'],
    ['현대차', 'KR', '005380', 250000, -0.8, '2026-07-23 09:29'],
  ];
  const rows = buildRealtimeRows(holdings, quotes, prevRows, '2026-07-23 09:31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], '삼성전자');
});

test('parseUsQuoteResponse: 정상 응답에서 현재가·등락률 추출(output.last/output.rate)', () => {
  const q = parseUsQuoteResponse({ rt_cd: '0', output: { last: '250.5', rate: '-0.8' } });
  assert.equal(q.price, 250.5);
  assert.equal(q.changePct, -0.8);
});

test('parseUsQuoteResponse: 등락률 없으면 null', () => {
  const q = parseUsQuoteResponse({ rt_cd: '0', output: { last: '250.5', rate: '' } });
  assert.equal(q.changePct, null);
});

test('parseUsQuoteResponse: rt_cd 실패 코드면 throw(msg1 인용)', () => {
  assert.throws(
    () => parseUsQuoteResponse({ rt_cd: '1', msg1: '존재하지 않는 종목' }),
    /존재하지 않는 종목/
  );
});

test('parseUsQuoteResponse: 현재가 파싱 불가면 throw', () => {
  assert.throws(() => parseUsQuoteResponse({ rt_cd: '0', output: { last: '' } }));
});

test('getUsQuote: 레이트리밋(EGW00201)이면 재시도 후 성공', async () => {
  const fetchImpl = mockFetch([
    { body: { rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수를 초과하였습니다.' } },
    { body: { rt_cd: '0', output: { last: '250.5', rate: '-0.8' } } },
  ]);
  const q = await getUsQuote({ token: 't', appkey: 'k', appsecret: 's', excd: 'NAS', symb: 'TSLA', fetchImpl, retryDelayMs: 1 });
  assert.equal(q.price, 250.5);
});

test('getUsQuote: 레이트리밋 아닌 다른 오류는 즉시 throw', async () => {
  const fetchImpl = mockFetch([{ body: { rt_cd: '1', msg_cd: 'OTHER', msg1: '존재하지 않는 종목' } }]);
  await assert.rejects(
    () => getUsQuote({ token: 't', appkey: 'k', appsecret: 's', excd: 'NAS', symb: 'TSLA', fetchImpl, retryDelayMs: 1 }),
    /존재하지 않는 종목/
  );
});

test('getUsQuote: 재시도 소진 후 throw된 에러의 code가 msg_cd(EGW00201)', async () => {
  const fetchImpl = mockFetch([{ body: { rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수를 초과하였습니다.' } }]);
  try {
    await getUsQuote({ token: 't', appkey: 'k', appsecret: 's', excd: 'NAS', symb: 'TSLA', fetchImpl, retries: 1, retryDelayMs: 1 });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.code, 'EGW00201');
  }
});

test('isKrMarketOpen: 평일 정규장 시각이면 true', () => {
  // 2026-07-23(목) 10:00 KST = 2026-07-23T01:00:00Z
  assert.equal(isKrMarketOpen(new Date('2026-07-23T01:00:00Z')), true);
});

test('isKrMarketOpen: 평일 장 마감 후면 false', () => {
  // 2026-07-23(목) 16:00 KST = 2026-07-23T07:00:00Z
  assert.equal(isKrMarketOpen(new Date('2026-07-23T07:00:00Z')), false);
});

test('isKrMarketOpen: 토요일이면 false', () => {
  // 2026-07-25(토) 10:00 KST
  assert.equal(isKrMarketOpen(new Date('2026-07-25T01:00:00Z')), false);
});

test('isUsMarketOpen: 서머타임(EDT) 정규장 시각이면 true', () => {
  // 2026-07-15(수) 09:35 EDT = 13:35 UTC
  assert.equal(isUsMarketOpen(new Date('2026-07-15T13:35:00Z')), true);
});

test('isUsMarketOpen: 표준시(EST) 정규장 시각이면 true(서머타임 자동 반영 확인)', () => {
  // 2026-01-15(목) 09:35 EST = 14:35 UTC
  assert.equal(isUsMarketOpen(new Date('2026-01-15T14:35:00Z')), true);
});

test('isUsMarketOpen: 미국장이 KST 기준 다음날 새벽까지 이어지는 경우도 정확히 판단(자정 넘김 케이스)', () => {
  // 2026-07-17(금) 15:00 EDT(장 마감 직전) = KST로는 2026-07-18(토) 새벽 4시.
  // KST 요일만 보면 토요일이라 걸러질 수 있으나, 실제 미국 로컬 요일은 금요일 정규장 시간대.
  assert.equal(isUsMarketOpen(new Date('2026-07-17T19:00:00Z')), true);
});

test('isUsMarketOpen: 장외 시각이면 false', () => {
  // 2026-07-15(수) 20:00 EDT
  assert.equal(isUsMarketOpen(new Date('2026-07-16T00:00:00Z')), false);
});

test('parseBalanceResponse: output1에서 보유종목 추출, 수량 0은 제외', () => {
  const { holdings } = parseBalanceResponse({
    rt_cd: '0',
    output1: [
      { pdno: '0025N0', prdt_name: 'TIGER TDF2045 적격', hldg_qty: '120' },
      { pdno: '005930', prdt_name: '삼성전자', hldg_qty: '0' }, // 전량 매도된 잔존 행 — 제외돼야 함
    ],
  });
  assert.deepEqual(holdings, [{ code: '0025N0', name: 'TIGER TDF2045 적격', qty: 120 }]);
});

test('parseBalanceResponse: output1 비어있으면 빈 배열', () => {
  assert.deepEqual(parseBalanceResponse({ rt_cd: '0', output1: [] }).holdings, []);
});

test('parseBalanceResponse: rt_cd 실패 코드면 throw(msg1 인용)', () => {
  assert.throws(
    () => parseBalanceResponse({ rt_cd: '1', msg1: '계좌번호 오류' }),
    /계좌번호 오류/
  );
});

test('parseBalanceResponse: output2.dnca_tot_amt에서 예수금 추출(콤마 포함 문자열도 처리)', () => {
  const { cash } = parseBalanceResponse({ rt_cd: '0', output1: [], output2: [{ dnca_tot_amt: '335,446' }] });
  assert.equal(cash, 335446);
});

test('parseBalanceResponse: output2 없거나 dnca_tot_amt 파싱 불가면 cash=null(0으로 추정 안 함)', () => {
  assert.equal(parseBalanceResponse({ rt_cd: '0', output1: [] }).cash, null);
  assert.equal(parseBalanceResponse({ rt_cd: '0', output1: [], output2: [] }).cash, null);
  assert.equal(parseBalanceResponse({ rt_cd: '0', output1: [], output2: [{}] }).cash, null);
  // 필드는 있지만 숫자로 해석 불가한 값(공백 아닌 쓰레기 문자열)도 null — Number('N/A')는
  // NaN이라 별도 분기 없이도 이미 걸러지지만, 코드리뷰 지적으로 명시적으로 고정해둔다.
  assert.equal(parseBalanceResponse({ rt_cd: '0', output1: [], output2: [{ dnca_tot_amt: 'N/A' }] }).cash, null);
});

test('parseBalanceResponse: dnca_tot_amt가 "0"이면 진짜 0원(null 아님)', () => {
  assert.equal(parseBalanceResponse({ rt_cd: '0', output1: [], output2: [{ dnca_tot_amt: '0' }] }).cash, 0);
});

test('getAccountBalance: 레이트리밋이면 재시도 후 성공', async () => {
  const fetchImpl = mockFetch([
    { body: { rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수를 초과하였습니다.' } },
    { body: { rt_cd: '0', output1: [{ pdno: '0025N0', prdt_name: 'TIGER TDF2045 적격', hldg_qty: '120' }], output2: [{ dnca_tot_amt: '0' }] } },
  ]);
  const { holdings, cash } = await getAccountBalance({
    token: 't', appkey: 'k', appsecret: 's', cano: '12345678', acntPrdtCd: '29', fetchImpl, retryDelayMs: 1,
  });
  assert.equal(holdings[0].name, 'TIGER TDF2045 적격');
  assert.equal(cash, 0);
});

test('loadIrpAccount: cano·acntPrdtCd·appkey·appsecret 넷 다 있으면 반환(cano/acntPrdtCd는 문자열 강제 변환)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kis-test-'));
  const file = join(dir, 'kis-key.json');
  writeFileSync(file, JSON.stringify({
    appkey: 'k', appsecret: 's',
    irpAccount: { cano: 12345678, acntPrdtCd: 29, appkey: 'irp-k', appsecret: 'irp-s' },
  }));
  assert.deepEqual(loadIrpAccount(file), { cano: '12345678', acntPrdtCd: '29', appkey: 'irp-k', appsecret: 'irp-s' });
});

test('loadIrpAccount: irpAccount 필드 자체가 없으면 null(미설정 — 오류 아님)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kis-test-'));
  const file = join(dir, 'kis-key.json');
  writeFileSync(file, JSON.stringify({ appkey: 'k', appsecret: 's' }));
  assert.equal(loadIrpAccount(file), null);
});

test('loadIrpAccount: cano만 있고 acntPrdtCd 누락이면 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kis-test-'));
  const file = join(dir, 'kis-key.json');
  writeFileSync(file, JSON.stringify({ appkey: 'k', appsecret: 's', irpAccount: { cano: '12345678' } }));
  assert.equal(loadIrpAccount(file), null);
});

test('loadIrpAccount: cano·acntPrdtCd는 있는데 IRP 전용 appkey/appsecret이 없으면 null(최상위 크리덴셜로 대체 안 함)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kis-test-'));
  const file = join(dir, 'kis-key.json');
  // KIS는 앱키를 계좌 단위로 등록시켜(2026-07 실측) 최상위 appkey로는 IRP 계좌 조회가
  // INVALID_CHECK_ACNO로 거부된다 — irpAccount 자체에 전용 appkey/appsecret이 없으면
  // 최상위 값으로 조용히 대체하지 말고 null(미설정 취급)이어야 한다.
  writeFileSync(file, JSON.stringify({ appkey: 'k', appsecret: 's', irpAccount: { cano: '12345678', acntPrdtCd: '29' } }));
  assert.equal(loadIrpAccount(file), null);
});

test('loadIrpAccount: 파일 자체가 없으면 null(throw 안 함)', () => {
  assert.equal(loadIrpAccount('/nonexistent/path/kis-key.json'), null);
});

test('parseInvestorFlowResponse: output[0](최근 거래일)에서 외국인·기관 순매수 수량 추출', () => {
  const flow = parseInvestorFlowResponse({
    rt_cd: '0',
    output: [
      { stck_bsop_date: '20260724', frgn_ntby_qty: '-3428259', orgn_ntby_qty: '-3378638' },
      { stck_bsop_date: '20260723', frgn_ntby_qty: '1299490', orgn_ntby_qty: '-120579' },
    ],
  });
  assert.deepEqual(flow, { date: '20260724', frgnNetQty: -3428259, orgnNetQty: -3378638 });
});

test('parseInvestorFlowResponse: 순매수 수량 필드 누락이면 frgnNetQty/orgnNetQty는 null(0으로 추정 안 함)', () => {
  const flow = parseInvestorFlowResponse({ rt_cd: '0', output: [{ stck_bsop_date: '20260724' }] });
  assert.deepEqual(flow, { date: '20260724', frgnNetQty: null, orgnNetQty: null });
});

test('parseInvestorFlowResponse: output 비어있으면 null', () => {
  assert.equal(parseInvestorFlowResponse({ rt_cd: '0', output: [] }), null);
  assert.equal(parseInvestorFlowResponse({ rt_cd: '0' }), null);
});

test('parseInvestorFlowResponse: rt_cd 실패 코드면 throw(msg1 인용)', () => {
  assert.throws(
    () => parseInvestorFlowResponse({ rt_cd: '1', msg1: '조회할 자료가 없습니다' }),
    /조회할 자료가 없습니다/
  );
});

test('getKrInvestorFlow: 레이트리밋(EGW00201)이면 재시도 후 성공', async () => {
  const fetchImpl = mockFetch([
    { body: { rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수를 초과하였습니다.' } },
    { body: { rt_cd: '0', output: [{ stck_bsop_date: '20260724', frgn_ntby_qty: '100', orgn_ntby_qty: '-50' }] } },
  ]);
  const flow = await getKrInvestorFlow({ token: 't', appkey: 'k', appsecret: 's', code: '005930', fetchImpl, retryDelayMs: 1 });
  assert.deepEqual(flow, { date: '20260724', frgnNetQty: 100, orgnNetQty: -50 });
});

test('parseInvestOpinionResponse: 정상 응답에서 브로커별 리포트 추출(발행일·회사명·의견·직전의견·목표가)', () => {
  const rows = parseInvestOpinionResponse({
    rt_cd: '0',
    output: [
      { stck_bsop_date: '20260708', mbcr_name: 'IBK투자', invt_opnn: '매수', rgbf_invt_opnn: '매수', hts_goal_prc: '460000' },
      { stck_bsop_date: '20260708', mbcr_name: '키움', invt_opnn: 'BUY', rgbf_invt_opnn: 'BUY', hts_goal_prc: '390000' },
    ],
  });
  assert.deepEqual(rows, [
    { date: '20260708', firm: 'IBK투자', opinion: '매수', prevOpinion: '매수', targetPrice: 460000 },
    { date: '20260708', firm: '키움', opinion: 'BUY', prevOpinion: 'BUY', targetPrice: 390000 },
  ]);
});

test('parseInvestOpinionResponse: rgbf_invt_opnn 필드가 없으면 prevOpinion 빈 문자열(throw 안 함)', () => {
  const rows = parseInvestOpinionResponse({
    rt_cd: '0',
    output: [{ stck_bsop_date: '20260708', mbcr_name: 'KB', invt_opnn: 'BUY', hts_goal_prc: '600000' }],
  });
  assert.equal(rows[0].prevOpinion, '');
});

test('parseInvestOpinionResponse: 발행일·회사명 누락 행은 스킵(전체 throw 안 함)', () => {
  const rows = parseInvestOpinionResponse({
    rt_cd: '0',
    output: [
      { stck_bsop_date: '', mbcr_name: '키움', invt_opnn: 'BUY', hts_goal_prc: '390000' },
      { stck_bsop_date: '20260708', mbcr_name: '', invt_opnn: 'BUY', hts_goal_prc: '390000' },
      { stck_bsop_date: '20260708', mbcr_name: 'KB', invt_opnn: 'BUY', hts_goal_prc: '600000' },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].firm, 'KB');
});

test('parseInvestOpinionResponse: output 없으면 빈 배열, rt_cd 실패면 throw', () => {
  assert.deepEqual(parseInvestOpinionResponse({ rt_cd: '0' }), []);
  assert.throws(
    () => parseInvestOpinionResponse({ rt_cd: '1', msg1: '조회할 자료가 없습니다' }),
    /조회할 자료가 없습니다/
  );
});

test('summarizeInvestOpinion: 브로커당 최신 1건만 반영(재수정 리포트 중복제거)', () => {
  const rows = [
    { date: '20260601', firm: 'KB', opinion: 'BUY', targetPrice: 500000 },
    { date: '20260708', firm: 'KB', opinion: 'BUY', targetPrice: 600000 }, // KB 재수정 — 이게 최신
  ];
  const s = summarizeInvestOpinion(rows, 300000);
  assert.equal(s.reportCount, 1);
  assert.equal(s.avgTargetPrice, 600000);
  assert.equal(s.latestDate, '20260708');
});

test('summarizeInvestOpinion: 의견 분류(매수/BUY→buy, 중립/HOLD→hold, 매도/SELL→sell, 그 외→other) 집계', () => {
  const rows = [
    { date: '20260708', firm: 'A', opinion: '매수', targetPrice: 100 },
    { date: '20260708', firm: 'B', opinion: 'BUY', targetPrice: 100 },
    { date: '20260708', firm: 'C', opinion: '중립', targetPrice: 100 },
    { date: '20260708', firm: 'D', opinion: 'SELL', targetPrice: 100 },
    { date: '20260708', firm: 'E', opinion: '알수없음', targetPrice: 100 },
  ];
  const s = summarizeInvestOpinion(rows, 90);
  assert.deepEqual(s.opinionCounts, { buy: 2, hold: 1, sell: 1, other: 1 });
});

test('summarizeInvestOpinion: 목표가 평균·현재가 대비 괴리율(%) 계산', () => {
  const rows = [
    { date: '20260708', firm: 'A', opinion: 'BUY', targetPrice: 400000 },
    { date: '20260708', firm: 'B', opinion: 'BUY', targetPrice: 500000 },
  ];
  // 평균 목표가 450000, 현재가 300000 → (450000-300000)/300000*100 = 50%
  const s = summarizeInvestOpinion(rows, 300000);
  assert.equal(s.avgTargetPrice, 450000);
  assert.equal(s.targetGapPct, 50);
});

test('summarizeInvestOpinion: 목표가 결측 리포트만 있으면 avgTargetPrice·targetGapPct null(0 아님)', () => {
  const rows = [{ date: '20260708', firm: 'A', opinion: 'BUY', targetPrice: null }];
  const s = summarizeInvestOpinion(rows, 300000);
  assert.equal(s.reportCount, 1);
  assert.equal(s.avgTargetPrice, null);
  assert.equal(s.targetGapPct, null);
});

test('summarizeInvestOpinion: 리포트 0건이면 null', () => {
  assert.equal(summarizeInvestOpinion([], 300000), null);
});

test('summarizeInvestOpinion: currentPrice가 없으면(undefined/null) targetGapPct는 null(평균목표가는 여전히 계산)', () => {
  const rows = [{ date: '20260708', firm: 'A', opinion: 'BUY', targetPrice: 400000 }];
  assert.equal(summarizeInvestOpinion(rows, undefined).targetGapPct, null);
  assert.equal(summarizeInvestOpinion(rows, undefined).avgTargetPrice, 400000);
  assert.equal(summarizeInvestOpinion(rows, null).targetGapPct, null);
});

test('summarizeInvestOpinion: targetPrice가 0 이하인 리포트는 평균 계산에서 제외', () => {
  const rows = [
    { date: '20260708', firm: 'A', opinion: 'BUY', targetPrice: 0 },
    { date: '20260708', firm: 'B', opinion: 'BUY', targetPrice: -100 },
    { date: '20260708', firm: 'C', opinion: 'BUY', targetPrice: 500000 },
  ];
  const s = summarizeInvestOpinion(rows, 300000);
  assert.equal(s.reportCount, 3);
  assert.equal(s.avgTargetPrice, 500000); // 0·음수 제외, 유효값 1개만 평균
});

test('summarizeInvestOpinion: 브로커 자신의 직전의견 대비 하향/상향 카운트(가이던스 하향 대리신호)', () => {
  const rows = [
    { date: '20260708', firm: 'A', opinion: '중립', prevOpinion: '매수', targetPrice: 100 }, // 하향
    { date: '20260708', firm: 'B', opinion: '매도', prevOpinion: '매수', targetPrice: 100 }, // 하향
    { date: '20260708', firm: 'C', opinion: '매수', prevOpinion: '중립', targetPrice: 100 }, // 상향
    { date: '20260708', firm: 'D', opinion: '매수', prevOpinion: '매수', targetPrice: 100 }, // 유지
  ];
  const s = summarizeInvestOpinion(rows, 90);
  assert.equal(s.downgrades, 2);
  assert.equal(s.upgrades, 1);
});

test('summarizeInvestOpinion: prevOpinion 없거나(신규 커버리지) 서열 불가(other)면 하향/상향 집계에서 제외', () => {
  const rows = [
    { date: '20260708', firm: 'A', opinion: 'BUY', prevOpinion: '', targetPrice: 100 }, // 신규 커버리지
    { date: '20260708', firm: 'B', opinion: '알수없음', prevOpinion: '매수', targetPrice: 100 }, // 현재의견 서열불가
    { date: '20260708', firm: 'C', opinion: '매수', prevOpinion: '알수없음', targetPrice: 100 }, // 직전의견 서열불가
  ];
  const s = summarizeInvestOpinion(rows, 90);
  assert.equal(s.downgrades, 0);
  assert.equal(s.upgrades, 0);
});

test('summarizeInvestOpinion: 재수정 리포트는 브로커당 최신 1건 기준으로만 하향/상향 판정(중복집계 안 함)', () => {
  const rows = [
    { date: '20260601', firm: 'KB', opinion: '매도', prevOpinion: '매수', targetPrice: 100 }, // 옛 리포트 — 무시돼야 함
    { date: '20260708', firm: 'KB', opinion: '매수', prevOpinion: '매수', targetPrice: 100 }, // 최신 — 하향 아님
  ];
  const s = summarizeInvestOpinion(rows, 90);
  assert.equal(s.downgrades, 0);
});

test('classifyOpinion(비export, summarizeInvestOpinion 경유 검증): 비중확대/축소류 국내 관행 표현도 buy/sell로 분류', () => {
  const rows = [
    { date: '20260708', firm: 'A', opinion: '비중확대', targetPrice: 100 },
    { date: '20260708', firm: 'B', opinion: 'Overweight', targetPrice: 100 },
    { date: '20260708', firm: 'C', opinion: '비중축소', targetPrice: 100 },
  ];
  const s = summarizeInvestOpinion(rows, 90);
  assert.deepEqual(s.opinionCounts, { buy: 2, hold: 0, sell: 1, other: 0 });
});

test('getKrInvestOpinion: 레이트리밋(EGW00201)이면 재시도 후 성공', async () => {
  const fetchImpl = mockFetch([
    { body: { rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수를 초과하였습니다.' } },
    { body: { rt_cd: '0', output: [{ stck_bsop_date: '20260708', mbcr_name: 'KB', invt_opnn: 'BUY', hts_goal_prc: '500000' }] } },
  ]);
  const rows = await getKrInvestOpinion({ token: 't', appkey: 'k', appsecret: 's', code: '005930', fetchImpl, retryDelayMs: 1 });
  assert.equal(rows[0].firm, 'KB');
});

test('getKrInvestOpinion: 종목코드·날짜범위(dayWindow 기준)를 요청 파라미터에 포함', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    const body = { rt_cd: '0', output: [] };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  // new Date(y, m, d) — 로컬 캘린더 생성자. 프로덕션 ymd()도 getFullYear/getMonth/getDate로
  // 같은 로컬 캘린더를 읽으므로, ISO UTC 문자열(예: '2026-07-26T00:00:00Z')로 넘기면 호스트
  // 타임존에 따라 로컬 날짜가 하루 밀릴 수 있어 CI에서 취약(코드리뷰 지적) — 로컬 생성자로 고정.
  await getKrInvestOpinion({
    token: 't', appkey: 'k', appsecret: 's', code: '005930', fetchImpl,
    now: new Date(2026, 6, 26),
  });
  assert.match(capturedUrl, /FID_INPUT_ISCD=005930/);
  assert.match(capturedUrl, /FID_INPUT_DATE_2=20260726/);
  assert.match(capturedUrl, /FID_INPUT_DATE_1=20260427/); // 90일 전
});

// ── 국내주식 현금 매수/매도 주문 — Phase 11(2026-08-09) ────────────────────
// 매수/매도 tr_id가 뒤바뀌면 실제 금전 사고이므로 하드코딩 값을 직접 대조한다
// (연구 조사 권고사항 — document-specialist가 github.com/koreainvestment/open-trading-api
// order_cash.py 원문에서 확인한 값과 정확히 일치해야 함).
test('[핵심 안전장치] ORDER_TR_ID: 매수/매도 tr_id가 정확히 실측값과 일치(뒤바뀌면 금전 사고)', () => {
  assert.equal(ORDER_TR_ID['매수'], 'TTTC0012U');
  assert.equal(ORDER_TR_ID['매도'], 'TTTC0011U');
});

test('parseOrderResponse: 정상 응답에서 주문번호·주문시각·거래소전송조직번호 추출', () => {
  const r = parseOrderResponse({ rt_cd: '0', output: { ODNO: '0000012345', ORD_TMD: '090501', KRX_FWDG_ORD_ORGNO: '06010' } });
  assert.equal(r.orderNo, '0000012345');
  assert.equal(r.orderTime, '090501');
  assert.equal(r.orgNo, '06010');
});

test('parseOrderResponse: rt_cd 실패면 throw(msg1 인용) + confirmedNotSent=true(명시적 거부, 롤백 안전)', () => {
  try {
    parseOrderResponse({ rt_cd: '1', msg1: '주문가능금액을 초과하였습니다.' });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.match(e.message, /주문가능금액을 초과하였습니다/);
    assert.equal(e.confirmedNotSent, true);
  }
});

// [핵심 안전장치] ODNO 누락은 rt_cd='0'(KIS가 "성공"이라고 답함)인데 확인 번호만 없는
// 상태라, 가장 위험한 "불명" 케이스다 — confirmedNotSent를 절대 true로 붙이면 안 된다
// (코드리뷰 HIGH 지적, 2026-08-09 — 여기 붙이면 호출측이 안전하다고 믿고 롤백+재시도해서
// 이중 실주문이 날 수 있음).
test('[핵심 안전장치] parseOrderResponse: rt_cd는 성공인데 주문번호(ODNO)가 없으면 throw하되 confirmedNotSent는 안 붙음(불명 — 롤백 금지)', () => {
  try {
    parseOrderResponse({ rt_cd: '0', output: {} });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.match(e.message, /주문번호.*없음/);
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('[핵심] placeKrOrder: 매수는 TTTC0012U tr_id + ORD_DVSN=00(지정가)로 요청', async () => {
  let capturedHeaders = null, capturedBody = null;
  const fetchImpl = async (url, init) => {
    capturedHeaders = init.headers; capturedBody = JSON.parse(init.body);
    const body = { rt_cd: '0', output: { ODNO: '1', ORD_TMD: '1', KRX_FWDG_ORD_ORGNO: '1' } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  await placeKrOrder({
    token: 't', appkey: 'k', appsecret: 's', cano: '12345678', acntPrdtCd: '01',
    code: '005930', side: '매수', quantity: 10, price: 71000, fetchImpl,
  });
  assert.equal(capturedHeaders.tr_id, 'TTTC0012U');
  assert.equal(capturedBody.ORD_DVSN, '00');
  assert.equal(capturedBody.ORD_QTY, '10');
  assert.equal(capturedBody.ORD_UNPR, '71000');
  assert.equal(capturedBody.PDNO, '005930');
  assert.equal(capturedBody.SLL_TYPE, undefined); // 매수엔 SLL_TYPE 없음
});

test('[핵심] placeKrOrder: 매도는 TTTC0011U tr_id + SLL_TYPE=01(일반매도)로 요청', async () => {
  let capturedHeaders = null, capturedBody = null;
  const fetchImpl = async (url, init) => {
    capturedHeaders = init.headers; capturedBody = JSON.parse(init.body);
    const body = { rt_cd: '0', output: { ODNO: '1', ORD_TMD: '1', KRX_FWDG_ORD_ORGNO: '1' } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  await placeKrOrder({
    token: 't', appkey: 'k', appsecret: 's', cano: '12345678', acntPrdtCd: '01',
    code: '005930', side: '매도', quantity: 5, price: 72000, fetchImpl,
  });
  assert.equal(capturedHeaders.tr_id, 'TTTC0011U');
  assert.equal(capturedBody.SLL_TYPE, '01');
});

test('placeKrOrder: 알 수 없는 side는 네트워크 호출 전에 즉시 throw + confirmedNotSent=true(네트워크 자체를 안 탐 — 롤백 안전)', async () => {
  try {
    await placeKrOrder({ token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: 'p', code: '005930', side: '보유', quantity: 1, price: 1000 });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.match(e.message, /알 수 없는 side/);
    assert.equal(e.confirmedNotSent, true);
  }
});

test('placeKrOrder: 수량 0 이하·소수는 즉시 throw(네트워크 호출 안 함) + confirmedNotSent=true', async () => {
  try {
    await placeKrOrder({ token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: 'p', code: '005930', side: '매수', quantity: 0, price: 1000 });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.match(e.message, /주문수량/);
    assert.equal(e.confirmedNotSent, true);
  }
  await assert.rejects(
    () => placeKrOrder({ token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: 'p', code: '005930', side: '매수', quantity: 1.5, price: 1000 }),
    /주문수량/,
  );
});

test('placeKrOrder: 가격 0 이하는 즉시 throw(네트워크 호출 안 함) + confirmedNotSent=true', async () => {
  try {
    await placeKrOrder({ token: 't', appkey: 'k', appsecret: 's', cano: 'c', acntPrdtCd: 'p', code: '005930', side: '매수', quantity: 1, price: 0 });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.match(e.message, /주문단가/);
    assert.equal(e.confirmedNotSent, true);
  }
});

// [핵심 안전장치] KIS가 명시적으로 업무거부(rt_cd!='0')하면 확정 미체결 — 롤백 안전.
test('placeKrOrder: KIS 업무거부(rt_cd!=0)면 throw + confirmedNotSent=true', async () => {
  const fetchImpl = mockFetch([{ body: { rt_cd: '1', msg_cd: 'APBK0919', msg1: '주문가능금액을 초과하였습니다.' } }]);
  try {
    await placeKrOrder({
      token: 't', appkey: 'k', appsecret: 's', cano: '12345678', acntPrdtCd: '01',
      code: '005930', side: '매수', quantity: 1, price: 71000, fetchImpl,
    });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.match(e.message, /주문가능금액을 초과하였습니다/);
    assert.equal(e.confirmedNotSent, true);
  }
});

// [핵심 안전장치] 네트워크 예외(fetchImpl 자체가 throw)는 KIS 응답을 아예 못 받은 것 —
// 주문이 실제로는 이미 접수됐을 수 있어 confirmedNotSent를 절대 붙이면 안 된다(코드리뷰
// HIGH 지적, 2026-08-09 — 이게 무조건 롤백되면 재시도가 진짜 이중 실주문이 될 위험).
test('[핵심 안전장치] placeKrOrder: 네트워크 예외(fetchImpl throw)는 confirmedNotSent 안 붙음(불명 — 롤백 금지)', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  try {
    await placeKrOrder({
      token: 't', appkey: 'k', appsecret: 's', cano: '12345678', acntPrdtCd: '01',
      code: '005930', side: '매수', quantity: 1, price: 71000, fetchImpl,
    });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.match(e.message, /ECONNRESET/);
    assert.equal(e.confirmedNotSent, undefined);
  }
});

// [핵심 안전장치] 몸통이 JSON도 아닌 응답(진짜 알 수 없는 실패)도 KIS의 명시적 답을 못 받은
// 것과 같다 — confirmedNotSent 안 붙음.
test('[핵심 안전장치] placeKrOrder: JSON 아닌 응답(진짜 알 수 없는 실패)도 confirmedNotSent 안 붙음(불명 — 롤백 금지)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); }, text: async () => 'Bad Gateway' });
  try {
    await placeKrOrder({
      token: 't', appkey: 'k', appsecret: 's', cano: '12345678', acntPrdtCd: '01',
      code: '005930', side: '매수', quantity: 1, price: 71000, fetchImpl,
    });
    assert.fail('throw 됐어야 함');
  } catch (e) {
    assert.equal(e.confirmedNotSent, undefined);
  }
});

test('placeKrOrder: 레이트리밋(EGW00201)이면 재시도 후 성공(GET 조회와 동일한 재시도 로직 공유)', async () => {
  const fetchImpl = mockFetch([
    { body: { rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수를 초과하였습니다.' } },
    { body: { rt_cd: '0', output: { ODNO: '999', ORD_TMD: '1', KRX_FWDG_ORD_ORGNO: '1' } } },
  ]);
  const r = await placeKrOrder({
    token: 't', appkey: 'k', appsecret: 's', cano: '12345678', acntPrdtCd: '01',
    code: '005930', side: '매수', quantity: 1, price: 71000, fetchImpl, retryDelayMs: 1,
  });
  assert.equal(r.orderNo, '999');
});
