import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPENSE_RATIO_TABLE } from './etf-expense-ratios.mjs';
import { ASSET_CLASS_ETF_UNIVERSE } from './asset-class-etf-universe.mjs';
import {
  SCORING_WEIGHTS, THRESHOLDS, scoreExpenseRatio, scoreLiquidity, scoreNavPremium,
  scoreTrackingError, scoreAbsoluteReturn, scoreExcessReturn,
  computeInstrumentScore, rankInstruments, rankAssetClassUniverse, fetchInstrumentSeries,
} from './instrument-scoring.mjs';

test('SCORING_WEIGHTS: 6축 합이 1', () => {
  const sum = Object.values(SCORING_WEIGHTS).reduce((s, v) => s + v, 0);
  assert.equal(sum, 1);
});

test('scoreExpenseRatio: 테이블에 없으면 null(0점 추정 안 함)', () => {
  assert.equal(scoreExpenseRatio('없는ETF'), null);
});

test('scoreExpenseRatio: good 경계값은 100점, bad 경계값은 0점', () => {
  EXPENSE_RATIO_TABLE['테스트-good'] = THRESHOLDS.expenseRatioPct.good;
  EXPENSE_RATIO_TABLE['테스트-bad'] = THRESHOLDS.expenseRatioPct.bad;
  assert.equal(scoreExpenseRatio('테스트-good'), 100);
  assert.equal(scoreExpenseRatio('테스트-bad'), 0);
  delete EXPENSE_RATIO_TABLE['테스트-good'];
  delete EXPENSE_RATIO_TABLE['테스트-bad'];
});

test('scoreExpenseRatio: bad보다 더 나쁘면 0점으로 클램프(음수 아님)', () => {
  EXPENSE_RATIO_TABLE['테스트-worse'] = 5.0;
  assert.equal(scoreExpenseRatio('테스트-worse'), 0);
  delete EXPENSE_RATIO_TABLE['테스트-worse'];
});

test('scoreLiquidity: null/undefined는 null', () => {
  assert.equal(scoreLiquidity(null), null);
  assert.equal(scoreLiquidity(undefined), null);
});

test('scoreLiquidity: good 이상이면 100점(클램프), bad 이하면 0점(클램프)', () => {
  assert.equal(scoreLiquidity(THRESHOLDS.liquidityWon.good * 2), 100);
  assert.equal(scoreLiquidity(THRESHOLDS.liquidityWon.bad / 2), 0);
});

test('scoreLiquidity: 중간값은 선형 보간', () => {
  const { good, bad } = THRESHOLDS.liquidityWon;
  const mid = (good + bad) / 2;
  assert.ok(Math.abs(scoreLiquidity(mid) - 50) < 1e-9);
});

test('scoreNavPremium: 괴리 0이면 100점, 프리미엄·디스카운트 모두 부호 무시(절대값)', () => {
  assert.equal(scoreNavPremium(10000, 10000), 100);
  const premium = scoreNavPremium(10300, 10000); // +3% 프리미엄
  const discount = scoreNavPremium(9700, 10000); // -3% 디스카운트
  assert.ok(Math.abs(premium - discount) < 1e-6);
  assert.ok(Math.abs(premium - 0) < 1e-6); // bad 경계(3%)라 0점
});

test('scoreNavPremium: nav가 0 이하거나 비숫자면 null', () => {
  assert.equal(scoreNavPremium(10000, 0), null);
  assert.equal(scoreNavPremium(10000, null), null);
  assert.equal(scoreNavPremium(null, 10000), null);
});

test('scoreTrackingError: 유효 구간 3일 미만이면 null', () => {
  assert.equal(scoreTrackingError([{ close: 100, idxClose: 10 }, { close: 101, idxClose: 10.1 }]), null);
  assert.equal(scoreTrackingError([]), null);
  assert.equal(scoreTrackingError(undefined), null);
});

test('scoreTrackingError: ETF·지수가 완전히 같은 수익률로 움직이면 추적오차 0 → 100점', () => {
  const series = [
    { close: 100, idxClose: 100 },
    { close: 101, idxClose: 101 },
    { close: 102.01, idxClose: 102.01 },
    { close: 100.99, idxClose: 100.99 },
  ];
  assert.equal(scoreTrackingError(series), 100);
});

test('scoreTrackingError: 유효하지 않은 행(close·idxClose 0 이하 또는 결측)은 걸러내고 계산', () => {
  const series = [
    { close: 100, idxClose: 100 },
    { close: null, idxClose: 101 }, // 결측 — 제외
    { close: 101, idxClose: 101 },
    { close: 102, idxClose: 102 },
    { close: 103, idxClose: 103 },
  ];
  // 결측 행 제외 후 4개 유효행 남아 3쌍의 수익률 계산 가능
  assert.equal(scoreTrackingError(series), 100);
});

test('computeInstrumentScore: 6축 전부 데이터 있으면 가중평균, dataGaps 빈 배열', () => {
  EXPENSE_RATIO_TABLE['풀데이터ETF'] = THRESHOLDS.expenseRatioPct.good; // 100점
  const series = [{ close: 100, idxClose: 100 }, { close: 101, idxClose: 100.5 }, { close: 103, idxClose: 101 }];
  const candidate = { name: '풀데이터ETF', accTrdVal: THRESHOLDS.liquidityWon.good, close: 10000, nav: 10000, series };
  const r = computeInstrumentScore(candidate);
  assert.deepEqual(r.dataGaps, []);
  // 6축 전부 계산 가능한 값으로 직접 재계산해 가중평균이 일치하는지 확인(억지로
  // "전부 100점" 픽스처를 만들지 않음 — absoluteReturn·excessReturn 임계값까지
  // 동시에 맞추기보다 실제 계산 로직을 그대로 재현하는 쪽이 더 신뢰도 높은 테스트).
  const expected = SCORING_WEIGHTS.expenseRatio * scoreExpenseRatio(candidate.name)
    + SCORING_WEIGHTS.liquidity * scoreLiquidity(candidate.accTrdVal)
    + SCORING_WEIGHTS.navPremium * scoreNavPremium(candidate.close, candidate.nav)
    + SCORING_WEIGHTS.trackingError * scoreTrackingError(candidate.series)
    + SCORING_WEIGHTS.absoluteReturn * scoreAbsoluteReturn(candidate.series)
    + SCORING_WEIGHTS.excessReturn * scoreExcessReturn(candidate.series);
  assert.ok(Math.abs(r.composite - expected) < 1e-6);
  delete EXPENSE_RATIO_TABLE['풀데이터ETF'];
});

test('computeInstrumentScore: 일부 축 데이터 없으면 dataGaps에 노출 + 남은 축만으로 가중평균 재분배', () => {
  const r = computeInstrumentScore({ name: '보수율없는ETF', accTrdVal: THRESHOLDS.liquidityWon.good, close: 10000, nav: 10000, series: [] });
  // series가 비어있으면 trackingError·absoluteReturn·excessReturn 전부 데이터 부족.
  assert.deepEqual(r.dataGaps.sort(), ['absoluteReturn', 'excessReturn', 'expenseRatio', 'trackingError']);
  // liquidity=100, navPremium=100 두 축만 남아 가중평균도 100
  assert.ok(Math.abs(r.composite - 100) < 1e-6);
});

test('computeInstrumentScore: 모든 축 데이터 없으면 composite null(0으로 추정 안 함)', () => {
  const r = computeInstrumentScore({ name: '데이터전무ETF', accTrdVal: null, close: null, nav: null, series: [] });
  assert.equal(r.composite, null);
  assert.equal(r.dataGaps.length, 6);
});

test('scoreAbsoluteReturn: 유효 close가 2일 미만이면 null', () => {
  assert.equal(scoreAbsoluteReturn([{ close: 100 }]), null);
  assert.equal(scoreAbsoluteReturn([]), null);
  assert.equal(scoreAbsoluteReturn(undefined), null);
});

test('scoreAbsoluteReturn: good 임계값(15%) 그대로면 100점, bad(-10%) 그대로면 0점', () => {
  assert.ok(Math.abs(scoreAbsoluteReturn([{ close: 100 }, { close: 115 }]) - 100) < 1e-6);
  assert.ok(Math.abs(scoreAbsoluteReturn([{ close: 100 }, { close: 90 }]) - 0) < 1e-6);
});

test('scoreAbsoluteReturn: 중간 구간 종가는 무시하고 첫날→마지막날만 본다', () => {
  const series = [{ close: 100 }, { close: 9999 }, { close: 110 }]; // 중간값이 이상해도 영향 없음
  assert.equal(scoreAbsoluteReturn(series), scoreAbsoluteReturn([{ close: 100 }, { close: 110 }]));
});

test('scoreExcessReturn: 유효 구간이 2일 미만이거나 idxClose 결측이면 null', () => {
  assert.equal(scoreExcessReturn([{ close: 100, idxClose: 100 }]), null);
  assert.equal(scoreExcessReturn([{ close: 100 }, { close: 110 }]), null); // idxClose 자체가 없음
});

test('scoreExcessReturn: 종목·지수 수익률이 완전히 같으면(패시브가 잘 추종) 0%p → 중간점(50점)', () => {
  const r = scoreExcessReturn([{ close: 100, idxClose: 100 }, { close: 110, idxClose: 110 }]);
  assert.ok(Math.abs(r - 50) < 1e-6); // THRESHOLDS.excessReturnPct는 good=+2%p·bad=-2%p라 0%p는 정확히 중간
});

test('scoreExcessReturn: 종목이 지수를 초과(good 임계값 +2%p)하면 100점, 그 반대는 0점', () => {
  // 지수는 100→110(10%), 종목은 100→112.2(12.2%) → 초과 +2.2%p로 good(+2%p) 이상
  const outperform = scoreExcessReturn([{ close: 100, idxClose: 100 }, { close: 112.2, idxClose: 110 }]);
  assert.equal(outperform, 100);
  // 지수는 100→110(10%), 종목은 100→107.8(7.8%) → 초과 -2.2%p로 bad(-2%p) 이하
  const underperform = scoreExcessReturn([{ close: 100, idxClose: 100 }, { close: 107.8, idxClose: 110 }]);
  assert.equal(underperform, 0);
});

test('rankAssetClassUniverse: 유니버스가 비어있으면(오너 미확인 자산군) 빈 배열', async () => {
  // 2026-09-06 오너가 실제 5개 자산군을 보유종목으로 채운 뒤로는 그 키들이 더 이상
  // 비어있지 않다 — 존재하지 않는 자산군 키로 "비어있음"을 검증한다.
  const r = await rankAssetClassUniverse('존재하지않는자산군', { fetchSeriesForNames: async () => { throw new Error('호출되면 안 됨'); } });
  assert.deepEqual(r, []);
});

test('rankAssetClassUniverse: 자산군의 KRX 이름 전체를 한 번에 배치 조회해 최신일자 기준 스코어링·순위화(2026-09-07 배치화)', async () => {
  ASSET_CLASS_ETF_UNIVERSE['테스트자산군'] = ['좋은ETF', '나쁜ETF'];
  const fetchSeriesForNames = async (names, days) => {
    assert.deepEqual(names.sort(), ['나쁜ETF', '좋은ETF']); // 개별 호출이 아니라 배치로 한 번에 옴
    assert.equal(days, 252);
    return {
      좋은ETF: [
        { basDd: '1', close: 100, nav: 100, accTrdVal: THRESHOLDS.liquidityWon.good, idxClose: 100 },
        { basDd: '2', close: 101, nav: 101, accTrdVal: THRESHOLDS.liquidityWon.good, idxClose: 101 },
        { basDd: '3', close: 102, nav: 102, accTrdVal: THRESHOLDS.liquidityWon.good, idxClose: 102 },
      ],
      나쁜ETF: [
        { basDd: '1', close: 100, nav: 90, accTrdVal: THRESHOLDS.liquidityWon.bad, idxClose: 100 },
      ],
    };
  };
  const ranked = await rankAssetClassUniverse('테스트자산군', { fetchSeriesForNames });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].name, '좋은ETF'); // 유동성 높고·괴리 0·추적오차 0 → 1위
  delete ASSET_CLASS_ETF_UNIVERSE['테스트자산군'];
});

test('rankAssetClassUniverse: 조회 실패(빈 시리즈)인 이름은 스코어링 대상에서 제외', async () => {
  ASSET_CLASS_ETF_UNIVERSE['테스트자산군2'] = ['상장전ETF', '정상ETF'];
  const fetchSeriesForNames = async () => ({
    상장전ETF: [],
    정상ETF: [{ basDd: '1', close: 100, nav: 100, accTrdVal: 1_000_000, idxClose: 100 }],
  });
  const ranked = await rankAssetClassUniverse('테스트자산군2', { fetchSeriesForNames });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].name, '정상ETF');
  delete ASSET_CLASS_ETF_UNIVERSE['테스트자산군2'];
});

test('fetchInstrumentSeries: US_ETF_BENCHMARK_TICKER에 등록된 이름은 yfinance 경로로 라우팅', async () => {
  const fetchSeries = async () => { throw new Error('KRX 경로가 호출되면 안 됨'); };
  const fetchUsSeries = async (name) => { assert.equal(name, 'VOO'); return [{ close: 400 }]; };
  const series = await fetchInstrumentSeries('VOO', 252, { fetchSeries, fetchUsSeries });
  assert.deepEqual(series, [{ close: 400 }]);
});

test('fetchInstrumentSeries: 등록 안 된 이름은 KRX 경로로 라우팅(days 그대로 전달)', async () => {
  const fetchSeries = async (name, days) => { assert.equal(name, 'KODEX 200'); assert.equal(days, 252); return [{ close: 40000 }]; };
  const fetchUsSeries = async () => { throw new Error('yfinance 경로가 호출되면 안 됨'); };
  const series = await fetchInstrumentSeries('KODEX 200', 252, { fetchSeries, fetchUsSeries });
  assert.deepEqual(series, [{ close: 40000 }]);
});

test('rankAssetClassUniverse: 유니버스에 미국 티커(VOO 등)가 섞여 있으면 KRX 배치 조회 대상에서 빠지고 yfinance 경로로 따로 조회', async () => {
  ASSET_CLASS_ETF_UNIVERSE['테스트자산군3'] = ['KODEX 200', 'VOO'];
  const fetchSeriesForNames = async (names) => {
    assert.deepEqual(names, ['KODEX 200']); // VOO는 이 배치에 안 섞여 들어옴
    return { 'KODEX 200': [{ basDd: '1', close: 40000, nav: 40000, accTrdVal: THRESHOLDS.liquidityWon.good, idxClose: 40000 }] };
  };
  const fetchUsSeries = async (name) => {
    assert.equal(name, 'VOO'); // KODEX 200은 이 경로로 오면 안 됨
    return [{ close: 400, nav: null, accTrdVal: THRESHOLDS.liquidityWon.good, idxClose: 5000 }];
  };
  const ranked = await rankAssetClassUniverse('테스트자산군3', { fetchSeriesForNames, fetchUsSeries });
  assert.equal(ranked.length, 2);
  delete ASSET_CLASS_ETF_UNIVERSE['테스트자산군3'];
});

test('rankInstruments: composite 내림차순 정렬, null은 맨 뒤', () => {
  const candidates = [
    { name: 'A', accTrdVal: THRESHOLDS.liquidityWon.bad, close: 10000, nav: 10000, series: [] }, // 낮은 유동성
    { name: 'B', accTrdVal: THRESHOLDS.liquidityWon.good, close: 10000, nav: 10000, series: [] }, // 높은 유동성
    { name: 'C', accTrdVal: null, close: null, nav: null, series: [] }, // 전무
  ];
  const ranked = rankInstruments(candidates);
  assert.deepEqual(ranked.map((r) => r.name), ['B', 'A', 'C']);
});
