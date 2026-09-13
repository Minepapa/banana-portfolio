import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPriceSeries, loadPriceSeriesBatch, findIndexAtOrBefore } from './breakout-price-series.mjs';

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'breakout-price-series-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadPriceSeries: 정상 CSV 파싱(Open 포함)', () => {
  withFixtureDir((dir) => {
    writeFileSync(join(dir, '000880.csv'), 'Date,Open,Close,High,Low,Volume\n2020-01-02,99,100,105,98,1000\n2020-01-03,101,102,106,101,1200\n');
    const series = loadPriceSeries('000880', { cacheDir: dir });
    assert.deepEqual(series.dates, ['2020-01-02', '2020-01-03']);
    assert.deepEqual(series.opens, [99, 101]);
    assert.deepEqual(series.closes, [100, 102]);
    assert.deepEqual(series.highs, [105, 106]);
    assert.deepEqual(series.lows, [98, 101]);
    assert.deepEqual(series.volumes, [1000, 1200]);
  });
});

test('loadPriceSeries: 구버전 캐시(Open 컬럼 없음)는 opens가 전부 null(추정 안 함)', () => {
  withFixtureDir((dir) => {
    writeFileSync(join(dir, '000880.csv'), 'Date,Close,High,Low,Volume\n2020-01-02,100,105,98,1000\n');
    const series = loadPriceSeries('000880', { cacheDir: dir });
    assert.deepEqual(series.opens, [null]);
    assert.deepEqual(series.closes, [100]);
  });
});

test('loadPriceSeries: 파일 없으면 null(추정 안 함)', () => {
  withFixtureDir((dir) => {
    assert.equal(loadPriceSeries('999999', { cacheDir: dir }), null);
  });
});

test('loadPriceSeries: 헤더만 있는 빈 캐시(조회했지만 없음으로 확정된 종목)는 null', () => {
  withFixtureDir((dir) => {
    writeFileSync(join(dir, '000010.csv'), 'Date,Close,High,Low,Volume\n');
    assert.equal(loadPriceSeries('000010', { cacheDir: dir }), null);
  });
});

test('loadPriceSeriesBatch: 여러 종목 한 번에', () => {
  withFixtureDir((dir) => {
    writeFileSync(join(dir, 'A.csv'), 'Date,Close,High,Low,Volume\n2020-01-02,100,101,99,10\n');
    const batch = loadPriceSeriesBatch(['A', 'B'], { cacheDir: dir });
    assert.notEqual(batch.A, null);
    assert.equal(batch.B, null);
  });
});

test('findIndexAtOrBefore: 정확히 일치하는 날짜', () => {
  const dates = ['2020-01-02', '2020-01-03', '2020-01-06'];
  assert.equal(findIndexAtOrBefore(dates, '2020-01-03'), 1);
});

test('findIndexAtOrBefore: 주말/공휴일(정확히 없는 날짜)은 그 이하 최근 거래일', () => {
  const dates = ['2020-01-02', '2020-01-03', '2020-01-06'];
  assert.equal(findIndexAtOrBefore(dates, '2020-01-05'), 1); // 일요일 → 직전 거래일(01-03)
});

test('findIndexAtOrBefore: 범위 밖(그 이전 데이터 없음)은 -1', () => {
  const dates = ['2020-01-02', '2020-01-03'];
  assert.equal(findIndexAtOrBefore(dates, '2019-12-31'), -1);
});

test('findIndexAtOrBefore: 범위 뒤(가장 최근보다 미래)는 마지막 인덱스', () => {
  const dates = ['2020-01-02', '2020-01-03'];
  assert.equal(findIndexAtOrBefore(dates, '2020-06-01'), 1);
});
