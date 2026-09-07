import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchUsEtfSeries, US_ETF_BENCHMARK_TICKER } from './us-etf-scoring.mjs';

test('US_ETF_BENCHMARK_TICKER: VOO·QQQM이 등록돼 있음', () => {
  assert.equal(US_ETF_BENCHMARK_TICKER.VOO, '^GSPC');
  assert.equal(US_ETF_BENCHMARK_TICKER.QQQM, '^NDX');
});

test('fetchUsEtfSeries: close·volume·환율·벤치마크지수를 조합해 series로 변환', async () => {
  const fetchImpl = (tickers) => {
    assert.deepEqual(tickers, ['VOO', 'KRW=X', '^GSPC']);
    return {
      VOO: { close: [400, 404, 408], volume: [1000, 1100, 1200] },
      'KRW=X': { close: [1350, 1360, 1400] },
      '^GSPC': { close: [5000, 5050, 5100] },
    };
  };
  const series = await fetchUsEtfSeries('VOO', { fetchImpl });
  assert.equal(series.length, 3);
  assert.equal(series[0].close, 400);
  assert.equal(series[2].close, 408);
  assert.equal(series[2].idxClose, 5100);
  assert.equal(series[2].idxName, '^GSPC');
  // accTrdVal = close * volume * 최신 환율(1400, 배열의 마지막 값 — 날짜별 정확한
  // 환율이 아니라 조회 시점 최신값 하나를 전체 구간에 적용하는 근사)
  assert.equal(series[0].accTrdVal, 400 * 1000 * 1400);
  assert.equal(series[0].nav, null); // NAV는 항상 데이터 부족 처리
});

test('fetchUsEtfSeries: 벤치마크 등록 없는 티커는 idxClose 없이(null) 나머지는 정상', async () => {
  const fetchImpl = (tickers) => {
    assert.deepEqual(tickers, ['SPY', 'KRW=X']); // 벤치마크가 없으니 벤치마크 티커 요청도 안 함
    return { SPY: { close: [500, 505] }, 'KRW=X': { close: [1400] } };
  };
  const series = await fetchUsEtfSeries('SPY', { fetchImpl });
  assert.equal(series.length, 2);
  assert.equal(series[0].idxClose, null);
  assert.equal(series[0].idxName, null);
});

test('fetchUsEtfSeries: 종목·지수 배열 길이가 다르면 지수 다리를 버림(인덱스로 억지로 안 짝지음)', async () => {
  const fetchImpl = () => ({
    VOO: { close: [400, 404, 408], volume: [1, 1, 1] },
    'KRW=X': { close: [1400] },
    '^GSPC': { close: [5000, 5050] }, // 종목(3일)과 길이가 다름(2일)
  });
  const series = await fetchUsEtfSeries('VOO', { fetchImpl });
  assert.equal(series.length, 3);
  for (const s of series) assert.equal(s.idxClose, null);
});

test('fetchUsEtfSeries: 환율 조회 실패(빈 배열)면 accTrdVal도 null(추정 안 함)', async () => {
  const fetchImpl = () => ({ VOO: { close: [400], volume: [1000] }, 'KRW=X': { close: [] }, '^GSPC': { close: [5000] } });
  const series = await fetchUsEtfSeries('VOO', { fetchImpl });
  assert.equal(series[0].accTrdVal, null);
});

test('fetchUsEtfSeries: close가 0 이하이거나 결측인 날은 스킵', async () => {
  const fetchImpl = () => ({
    VOO: { close: [400, 0, null, 410], volume: [1, 1, 1, 1] },
    'KRW=X': { close: [1400] },
    '^GSPC': { close: [5000, 5010, 5020, 5030] },
  });
  const series = await fetchUsEtfSeries('VOO', { fetchImpl });
  assert.equal(series.length, 2);
  assert.deepEqual(series.map((s) => s.close), [400, 410]);
});
