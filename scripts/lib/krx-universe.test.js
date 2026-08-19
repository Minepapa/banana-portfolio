import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCommonShare, topByMarketCap, averageTradingValue, fetchKrxUniverse,
} from './krx-universe.mjs';

test('isCommonShare: 코드 끝자리 0 + 이름이 우/우B로 안 끝나야 보통주', () => {
  assert.equal(isCommonShare('005930', '삼성전자'), true);
  assert.equal(isCommonShare('005935', '삼성전자우'), false); // 코드도 5로 끝나 이중으로 걸림
  assert.equal(isCommonShare('005930', '삼성전자우'), false); // 이름만으로도 배제
  assert.equal(isCommonShare('00680K', '미래에셋증권2우B'), false);
});

test('topByMarketCap: 보통주만·시총 내림차순·상위 n개', () => {
  const rows = [
    { ISU_CD: '000010', ISU_NM: 'A', MKTCAP: '100' },
    { ISU_CD: '000015', ISU_NM: 'A우', MKTCAP: '99999' }, // 우선주 — 시총 커도 배제
    { ISU_CD: '000020', ISU_NM: 'B', MKTCAP: '300' },
    { ISU_CD: '000030', ISU_NM: 'C', MKTCAP: '200' },
  ];
  const top = topByMarketCap(rows, 2, 'KOSPI');
  assert.deepEqual(top, [
    { Code: '000020', Name: 'B', Marcap: 300 },
    { Code: '000030', Name: 'C', Marcap: 200 },
  ]);
});

test('topByMarketCap: 확보량이 n*0.9 미만이면 장애 의심으로 실패', () => {
  const rows = [{ ISU_CD: '000010', ISU_NM: 'A', MKTCAP: '100' }];
  assert.throws(() => topByMarketCap(rows, 10, 'KOSPI'), /확보 부족/);
});

test('averageTradingValue: 정상 — 매일 관측된 값의 평균', () => {
  const days = [
    { basDd: '1', rows: [{ ISU_CD: 'X', ACC_TRDVAL: '100' }] },
    { basDd: '2', rows: [{ ISU_CD: 'X', ACC_TRDVAL: '300' }] },
  ];
  assert.equal(averageTradingValue(days, 'X'), 200);
});

test('averageTradingValue: 관측일수가 window*0.9 미만이면 null(짧은 창을 평균으로 위장 안 함)', () => {
  const days = Array.from({ length: 20 }, (_, i) => ({
    basDd: String(i),
    rows: i < 5 ? [{ ISU_CD: 'X', ACC_TRDVAL: '100' }] : [], // 5/20일치만 관측
  }));
  assert.equal(averageTradingValue(days, 'X'), null);
});

test('fetchKrxUniverse: KOSPI+KOSDAQ 병합, 시총랭킹·유동성평균 정상 산출(mock)', async () => {
  // 코드는 KRX 관행(보통주=끝자리 '0')을 지켜야 isCommonShare 필터를 통과한다.
  const daysMemo = {};
  const fetchImpl = async (url) => {
    const m = url.match(/\/sto\/(stk|ksq)_bydd_trd\?basDd=(\d+)/);
    const [, kind] = m;
    const market = kind === 'stk' ? 'KOSPI' : 'KOSDAQ';
    daysMemo[market] = (daysMemo[market] || 0) + 1;
    const [codeA, codeB] = kind === 'stk' ? ['100010', '100020'] : ['200010', '200020'];
    const rows = [
      { ISU_CD: codeA, ISU_NM: 'Alpha', MKTCAP: '1000', ACC_TRDVAL: String(100 + daysMemo[market]) },
      { ISU_CD: codeB, ISU_NM: 'Beta', MKTCAP: '500', ACC_TRDVAL: String(50 + daysMemo[market]) },
    ];
    return { ok: true, status: 200, text: async () => JSON.stringify({ OutBlock_1: rows }) };
  };
  const out = await fetchKrxUniverse({ nKospi: 2, nKosdaq: 2, liquidityDays: 3, apiKey: 'K', fetchImpl, delayMs: 0 });
  assert.equal(out.length, 4);
  const kospiA = out.find((c) => c.Code === '100010');
  assert.equal(kospiA.Marcap, 1000);
  assert.ok(kospiA.avgTradingValue > 100); // 3일 평균, null 아님
  const kosdaqB = out.find((c) => c.Code === '200020');
  assert.equal(kosdaqB.Marcap, 500);
});

test('fetchKrxUniverse: 유동성 조회 실패율(null 비율)이 20% 넘으면 실패', async () => {
  let kospiCall = 0;
  const fetchImpl = async (url) => {
    if (/\/sto\/ksq_bydd_trd/.test(url)) {
      // 코스닥은 nKosdaq:0이라 랭킹엔 안 쓰이지만, 거래일 자체가 하나도 없으면
      // fetchTradingDaySeries가 "데이터 전혀 없음"으로 먼저 실패해버려 이 테스트가
      // 검증하려는 코스피 쪽 유동성실패 오류를 가린다 — 그래서 최소한의 유효 데이터는 준다.
      return { ok: true, status: 200, text: async () => JSON.stringify({ OutBlock_1: [{ ISU_CD: 'Q0', ISU_NM: 'Q', MKTCAP: '1', ACC_TRDVAL: '1' }] }) };
    }
    kospiCall++;
    // fetchTradingDaySeries는 오늘부터 과거로 걸어가며 호출하므로 1번째 호출 = 가장
    // 최근일(=반환 배열의 마지막 원소, 랭킹 기준일). 최신일엔 5종목 다 등장, 그 이전
    // 날들(2·3번째 호출)엔 1종목만 등장 → 나머지 4종목은 window*0.9 미달로 전부 null
    // (80% null, MAX_NULL_RATIO=0.2 초과).
    const rows = kospiCall === 1
      ? Array.from({ length: 5 }, (_, i) => ({ ISU_CD: `10000${i}0`, ISU_NM: `N${i}`, MKTCAP: String(1000 - i), ACC_TRDVAL: '100' }))
      : [{ ISU_CD: '1000000', ISU_NM: 'N0', MKTCAP: '1000', ACC_TRDVAL: '100' }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ OutBlock_1: rows }) };
  };
  await assert.rejects(
    () => fetchKrxUniverse({ nKospi: 5, nKosdaq: 0, liquidityDays: 3, apiKey: 'K', fetchImpl, delayMs: 0 }),
    /유동성 조회 실패율 과다/,
  );
});
