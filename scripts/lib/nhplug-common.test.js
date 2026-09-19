import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setNhRateLimitForTests } from './nhplug.mjs';
import {
  getTotalTransaction, getDepositWithdrawal, filterDividendRows, reconstructForeignRpLots,
} from './nhplug-common.mjs';

setNhRateLimitForTests(Infinity);

const mockFetchWithHeaders = (responses) => {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    const headerMap = r.responseHeaders || {};
    return {
      ok: r.ok !== false,
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.body),
      headers: { get: (name) => headerMap[name] ?? null },
    };
  };
};

test('getTotalTransaction: 단일 페이지(연속조회 없음)면 그대로 rows 반환, truncated:false', async () => {
  const fetchImpl = mockFetchWithHeaders([
    { body: { rsp_cd: '00166', Output_0: [{ trd_dt: '20260901', trd_amt: 1000 }] }, responseHeaders: {} },
  ]);
  const { rows, truncated } = await getTotalTransaction({ token: 't', actNo: '1', iqrStaDt: '20260901', iqrEndDt: '20260901', fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(truncated, false);
});

test('getTotalTransaction: 연속조회(00218) → cts로 이어받아 두 페이지 rows를 합쳐 반환', async () => {
  const fetchImpl = mockFetchWithHeaders([
    { body: { rsp_cd: '00218', Output_0: [{ trd_dt: '20260901' }] }, responseHeaders: { cts: 'C1', cts_flag: 'Y' } },
    { body: { rsp_cd: '00166', Output_0: [{ trd_dt: '20260902' }] }, responseHeaders: {} },
  ]);
  const { rows, truncated } = await getTotalTransaction({ token: 't', actNo: '1', iqrStaDt: '20260901', iqrEndDt: '20260930', fetchImpl });
  assert.deepEqual(rows.map((r) => r.trd_dt), ['20260901', '20260902']);
  assert.equal(truncated, false);
});

test('getTotalTransaction: maxPages 도달하면 truncated:true(무한루프 방지, 조용한 누락 방지)', async () => {
  // 매 페이지가 계속 연속조회를 요구하는 상황을 흉내 — 응답이 하나뿐이면 mockFetchWithHeaders가
  // 마지막 응답을 계속 재사용하므로 자연히 "항상 00218"이 된다.
  const fetchImpl = mockFetchWithHeaders([
    { body: { rsp_cd: '00218', Output_0: [{ trd_dt: '20260901' }] }, responseHeaders: { cts: 'ALWAYS', cts_flag: 'Y' } },
  ]);
  const { rows, truncated } = await getTotalTransaction({ token: 't', actNo: '1', iqrStaDt: '20260901', iqrEndDt: '20260930', fetchImpl, maxPages: 3 });
  assert.equal(rows.length, 3);
  assert.equal(truncated, true);
});

test('[막아야 함] getTotalTransaction: 연속조회 신호는 왔는데 cts 헤더가 없으면 더 못 가지만, 이건 데이터가 더 있는데 못 받은 것과 같으므로 truncated:true(2026-09-19 코드리뷰 HIGH — 예전엔 false로 반환해 "완전한 데이터"로 오판시켰음)', async () => {
  const fetchImpl = mockFetchWithHeaders([
    { body: { rsp_cd: '00218', Output_0: [{ trd_dt: '20260901' }] }, responseHeaders: {} },
  ]);
  const { rows, truncated } = await getTotalTransaction({ token: 't', actNo: '1', iqrStaDt: '20260901', iqrEndDt: '20260930', fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(truncated, true);
});

test('getDepositWithdrawal: 기본 동작(단일 페이지)', async () => {
  const fetchImpl = mockFetchWithHeaders([
    { body: { rsp_cd: '00166', Output_0: [{ trd_dt: '20260901', trd_amt: 500 }] }, responseHeaders: {} },
  ]);
  const { rows } = await getDepositWithdrawal({ token: 't', actNo: '1', iqrStaDt: '20260901', iqrEndDt: '20260901', fetchImpl });
  assert.equal(rows.length, 1);
});

test('filterDividendRows: "배당"·"분배" 키워드가 적요코드에 있는 항목만 통과', () => {
  const rows = [
    { sps_cd_krl_anm: '배당금' },
    { sps_cd_krl_anm: '외화배당금입금' },
    { sps_cd_krl_anm: 'ETF분배금입금' },
    { sps_cd_krl_anm: '코스피매도' },
    { sps_cd_krl_anm: '대체출금' },
  ];
  const dividends = filterDividendRows(rows);
  assert.equal(dividends.length, 3);
});

test('filterDividendRows: 빈 입력·필드 없는 행도 안전하게 처리', () => {
  assert.deepEqual(filterDividendRows(null), []);
  assert.deepEqual(filterDividendRows([{}]), []);
});

test('[막아야 함] filterDividendRows: "배당소득세"·"배당금출금"은 입금이 아니라 세금/출금이라 제외(2026-09-19 코드리뷰 LOW — Vault엔 입금 레코드만 있어 그대로 두면 오탐 경고가 됨)', () => {
  const rows = [{ sps_cd_krl_anm: '배당소득세' }, { sps_cd_krl_anm: '배당금출금' }, { sps_cd_krl_anm: '배당금' }];
  const dividends = filterDividendRows(rows);
  assert.deepEqual(dividends.map((r) => r.sps_cd_krl_anm), ['배당금']);
});

// 2026-09-19 실계좌 재현 — 오너가 NH 앱 스크린샷으로 직접 반증한 실제 사례:
// 8/26에 이전 로트(652.47)가 만기로 롤오버(매도+동액 매수)되고, 9/4에 별개의
// 신규 로트(5353.15)가 열려, 현재 총 보유수량은 두 로트 합계(6005.62)다.
test('reconstructForeignRpLots: 실계좌 재현 — 롤오버(매도+동액 매수)와 별개 신규 로트를 합쳐 정확한 총액 산출', () => {
  const rows = [
    { trd_dt: '20260826', sps_cd_krl_anm: '외화RP매도', trd_amt: 652.47, trd_af_bnc_qty: 0, cur_cd: 'USD', iem_nm: '자유약정형' },
    { trd_dt: '20260826', sps_cd_krl_anm: '외화RP매수', trd_amt: 652.47, trd_af_bnc_qty: 652.47, cur_cd: 'USD', iem_nm: '자유약정형' },
    { trd_dt: '20260904', sps_cd_krl_anm: '외화RP매수', trd_amt: 5353.15, trd_af_bnc_qty: 5353.15, cur_cd: 'USD', iem_nm: '자유약정형' },
  ];
  const { lots, total, currency } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 2);
  assert.equal(total, 6005.62);
  assert.equal(currency, 'USD');
});

// 2026-09-19 실계좌 400일 전수 조회로 발견 — 매도금액이 매수원금과 정확히 다르다
// (RP 이자가 붙기 때문, 스크린샷의 "손익 -60원"·"120,455원"이 증거). 이전 버전
// (금액매칭)은 이 케이스에서 18개 매수 중 단 하나도 못 닫아 총액이 5배 넘게
// 부풀려졌다 — FIFO는 금액이 달라도 선입선출로 정확히 닫는다.
test('[막아야 함] reconstructForeignRpLots: 매도금액이 매수원금과 달라도(이자 반영) FIFO로 가장 먼저 열린 로트를 정확히 닫음', () => {
  const rows = [
    { trd_dt: '20260101', sps_cd_krl_anm: '외화RP매수', trd_amt: 1000, cur_cd: 'USD' },
    { trd_dt: '20260201', sps_cd_krl_anm: '외화RP매수', trd_amt: 2000, cur_cd: 'USD' },
    // 첫 로트(1000)의 만기 상환액은 이자가 붙어 1003.02 — 금액매칭이면 못 닫힘
    { trd_dt: '20260301', sps_cd_krl_anm: '외화RP매도', trd_amt: 1003.02, cur_cd: 'USD' },
  ];
  const { lots, total } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].amount, 2000); // 1000짜리(먼저 연 것)가 닫히고 2000짜리만 남아야 함
  assert.equal(total, 2000);
});

test('reconstructForeignRpLots: 조회기간 시작 이전에 열린 로트의 매도는 매칭할 열린 로트가 없어 조용히 무시(원금을 더한 적 없으니 뺄 것도 없음)', () => {
  const rows = [
    { trd_dt: '20260101', sps_cd_krl_anm: '외화RP매도', trd_amt: 999, trd_af_bnc_qty: 0, cur_cd: 'USD' },
  ];
  const { lots, total } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 0);
  assert.equal(total, 0);
});

test('reconstructForeignRpLots: 매수한 뒤 완전히 매도되면 열린 로트 없음(정상 청산)', () => {
  const rows = [
    { trd_dt: '20260101', sps_cd_krl_anm: '외화RP매수', trd_amt: 1000, cur_cd: 'USD' },
    { trd_dt: '20260201', sps_cd_krl_anm: '외화RP매도', trd_amt: 1000, cur_cd: 'USD' },
  ];
  const { lots, total } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 0);
  assert.equal(total, 0);
});

test('[막아야 함] reconstructForeignRpLots: cur_cd가 없는(원화) 행은 로트 구성에서 제외(함수명이 "Foreign"인데 원화 RP가 섞이면 무의미한 합계가 됨)', () => {
  const rows = [
    { trd_dt: '20260101', sps_cd_krl_anm: '원화RP매수', trd_amt: 999999, cur_cd: '' },
    { trd_dt: '20260201', sps_cd_krl_anm: '외화RP매수', trd_amt: 100, cur_cd: 'USD' },
  ];
  const { lots, total, currency } = reconstructForeignRpLots(rows);
  assert.equal(lots.length, 1);
  assert.equal(total, 100);
  assert.equal(currency, 'USD');
});

test('reconstructForeignRpLots: 빈 입력이면 로트 없음·총액 0', () => {
  assert.deepEqual(reconstructForeignRpLots([]), { lots: [], total: 0, currency: null });
  assert.deepEqual(reconstructForeignRpLots(null), { lots: [], total: 0, currency: null });
});
