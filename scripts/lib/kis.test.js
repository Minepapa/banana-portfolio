import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseKisExpiry, parseQuoteResponse, parseUsQuoteResponse, buildRealtimeRows, getKrQuote,
  getUsQuote, isKrMarketOpen, isUsMarketOpen, parseBalanceResponse, getAccountBalance,
  loadIrpAccount, parseInvestorFlowResponse, getKrInvestorFlow,
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
