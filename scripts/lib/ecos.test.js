import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchEcosSeries, fetchRateSpreadCloses,
  GOV_BOND_10Y_ITEM_CODE, CD_91D_ITEM_CODE, MARKET_RATE_STAT_CODE,
} from './ecos.mjs';

test('fetchEcosSeries: apiKey 없으면 즉시 실패(추정 안 함)', async () => {
  await assert.rejects(
    () => fetchEcosSeries(CD_91D_ITEM_CODE, { apiKey: '' }),
    /ECOS_API_KEY 미설정/,
  );
});

test('fetchEcosSeries: 정상 응답 — URL 구성(통계표코드·날짜범위·항목코드) 확인 + {time,value} 배열 반환(과거→현재)', () => {
  return (async () => {
    let capturedUrl;
    const fetchImpl = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        text: async () => JSON.stringify({
          StatisticSearch: {
            list_total_count: 2,
            row: [
              { TIME: '20260901', DATA_VALUE: '3.878' },
              { TIME: '20260902', DATA_VALUE: '3.93' },
            ],
          },
        }),
      };
    };
    const closes = await fetchEcosSeries(CD_91D_ITEM_CODE, {
      apiKey: 'K', fetchImpl, endDate: new Date('2026-09-11'), daysBack: 400,
    });
    assert.deepEqual(closes, [{ time: '20260901', value: 3.878 }, { time: '20260902', value: 3.93 }]);
    assert.equal(
      capturedUrl,
      `https://ecos.bok.or.kr/api/StatisticSearch/K/json/kr/1/1000/${MARKET_RATE_STAT_CODE}/D/20250807/20260911/${CD_91D_ITEM_CODE}`,
    );
  })();
});

test('fetchEcosSeries: HTTP 비정상 응답이면 에러', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => fetchEcosSeries('x', { apiKey: 'K', fetchImpl }), /HTTP 500/);
});

test('fetchEcosSeries: ECOS RESULT 에러 응답(잘못된 코드·데이터없음 등)은 메시지 그대로 노출', async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({ RESULT: { CODE: 'INFO-200', MESSAGE: '해당하는 데이터가 없습니다.' } }),
  });
  await assert.rejects(
    () => fetchEcosSeries('999999999', { apiKey: 'K', fetchImpl }),
    /INFO-200.*해당하는 데이터가 없습니다/s,
  );
});

test('fetchEcosSeries: 응답이 JSON이 아니면 에러(파싱 실패)', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => '<html>Error</html>' });
  await assert.rejects(() => fetchEcosSeries('x', { apiKey: 'K', fetchImpl }), /파싱 실패/);
});

test('fetchEcosSeries: StatisticSearch.row가 배열이 아니면 에러(응답 이상)', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ StatisticSearch: {} }) });
  await assert.rejects(() => fetchEcosSeries('x', { apiKey: 'K', fetchImpl }), /응답 이상/);
});

test('[신설/2026-09-12] fetchEcosSeries: row가 빈 배열이면 에러(400일 조회에서 0건은 비정상 — 조용히 통과 안 시킴)', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ StatisticSearch: { list_total_count: 0, row: [] } }) });
  await assert.rejects(() => fetchEcosSeries('x', { apiKey: 'K', fetchImpl }), /데이터 없음/);
});

test('[신설/2026-09-12] fetchEcosSeries: list_total_count가 MAX_ROWS(1000) 초과면 페이지네이션 잘림 에러(조용한 데이터 노후화 방지)', async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({ StatisticSearch: { list_total_count: 1400, row: [{ TIME: '20260901', DATA_VALUE: '3.9' }] } }),
  });
  await assert.rejects(() => fetchEcosSeries('x', { apiKey: 'K', fetchImpl }), /페이지네이션 초과/);
});

test('fetchEcosSeries: DATA_VALUE가 숫자로 안 읽히는 행은 걸러냄(추정 안 함)', async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      StatisticSearch: { list_total_count: 3, row: [{ TIME: '20260901', DATA_VALUE: '3.9' }, { TIME: '20260902', DATA_VALUE: 'N/A' }, { TIME: '20260903', DATA_VALUE: '4.0' }] },
    }),
  });
  const closes = await fetchEcosSeries('x', { apiKey: 'K', fetchImpl });
  assert.deepEqual(closes, [{ time: '20260901', value: 3.9 }, { time: '20260903', value: 4.0 }]);
});

test('fetchRateSpreadCloses: 국고채10년·CD91일을 병렬로 가져와 같은 날짜끼리만 짝지어 반환', async () => {
  const fetchImpl = async (url) => {
    const is10y = url.includes(`/${GOV_BOND_10Y_ITEM_CODE}`);
    return {
      ok: true,
      text: async () => JSON.stringify({
        StatisticSearch: {
          list_total_count: 2,
          row: is10y
            ? [{ TIME: '20260901', DATA_VALUE: '4.5' }, { TIME: '20260902', DATA_VALUE: '4.55' }]
            : [{ TIME: '20260901', DATA_VALUE: '3.9' }, { TIME: '20260902', DATA_VALUE: '3.95' }],
        },
      }),
    };
  };
  const { longTerm, shortTerm } = await fetchRateSpreadCloses({ apiKey: 'K', fetchImpl });
  assert.deepEqual(longTerm, [4.5, 4.55]);
  assert.deepEqual(shortTerm, [3.9, 3.95]);
});

test('[신설/2026-09-12] fetchRateSpreadCloses: 날짜 정합 — 한쪽에만 있는 날짜(서로 다른 결측)는 짝짓기에서 제외되고, 같은 날짜끼리만 인덱스가 맞음', () => {
  return (async () => {
    const fetchImpl = async (url) => {
      const is10y = url.includes(`/${GOV_BOND_10Y_ITEM_CODE}`);
      return {
        ok: true,
        text: async () => JSON.stringify({
          StatisticSearch: {
            list_total_count: 3,
            // 국고채10년은 09-01·09-02·09-03 세 날짜, CD91일은 09-01·09-03만(09-02
            // 결측) — 필터링 전 길이는 다르지만("우연히 같아지는" 케이스가 아니라
            // 명백히 다른 경우), 짝짓기 결과는 반드시 공통 날짜(09-01·09-03)만 남아야 한다.
            row: is10y
              ? [{ TIME: '20260901', DATA_VALUE: '4.5' }, { TIME: '20260902', DATA_VALUE: '4.6' }, { TIME: '20260903', DATA_VALUE: '4.7' }]
              : [{ TIME: '20260901', DATA_VALUE: '3.9' }, { TIME: '20260903', DATA_VALUE: '4.0' }],
          },
        }),
      };
    };
    const { longTerm, shortTerm } = await fetchRateSpreadCloses({ apiKey: 'K', fetchImpl });
    assert.deepEqual(longTerm, [4.5, 4.7]); // 09-02(4.6) 제외
    assert.deepEqual(shortTerm, [3.9, 4.0]);
  })();
});
