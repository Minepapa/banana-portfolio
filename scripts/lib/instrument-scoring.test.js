import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPENSE_RATIO_TABLE } from './etf-expense-ratios.mjs';
import { ASSET_CLASS_ETF_UNIVERSE } from './asset-class-etf-universe.mjs';
import {
  SCORING_WEIGHTS, THRESHOLDS, scoreExpenseRatio, scoreLiquidity, scoreNavPremium,
  scoreTrackingError, computeInstrumentScore, rankInstruments, rankAssetClassUniverse,
} from './instrument-scoring.mjs';

test('SCORING_WEIGHTS: 4축 합이 1', () => {
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

test('computeInstrumentScore: 4축 전부 데이터 있으면 가중평균, dataGaps 빈 배열', () => {
  EXPENSE_RATIO_TABLE['풀데이터ETF'] = THRESHOLDS.expenseRatioPct.good; // 100점
  const series = [{ close: 100, idxClose: 100 }, { close: 101, idxClose: 101 }, { close: 102, idxClose: 102 }];
  const r = computeInstrumentScore({
    name: '풀데이터ETF', accTrdVal: THRESHOLDS.liquidityWon.good, close: 10000, nav: 10000, series,
  });
  assert.deepEqual(r.dataGaps, []);
  assert.ok(Math.abs(r.composite - 100) < 1e-6); // 4축 전부 100점
  delete EXPENSE_RATIO_TABLE['풀데이터ETF'];
});

test('computeInstrumentScore: 일부 축 데이터 없으면 dataGaps에 노출 + 남은 축만으로 가중평균 재분배', () => {
  const r = computeInstrumentScore({ name: '보수율없는ETF', accTrdVal: THRESHOLDS.liquidityWon.good, close: 10000, nav: 10000, series: [] });
  assert.deepEqual(r.dataGaps.sort(), ['expenseRatio', 'trackingError']);
  // liquidity=100, navPremium=100 두 축만 남아 가중평균도 100
  assert.ok(Math.abs(r.composite - 100) < 1e-6);
});

test('computeInstrumentScore: 모든 축 데이터 없으면 composite null(0으로 추정 안 함)', () => {
  const r = computeInstrumentScore({ name: '데이터전무ETF', accTrdVal: null, close: null, nav: null, series: [] });
  assert.equal(r.composite, null);
  assert.equal(r.dataGaps.length, 4);
});

test('rankAssetClassUniverse: 유니버스가 비어있으면(오너 미확인 자산군) 빈 배열', async () => {
  const r = await rankAssetClassUniverse('채권', { fetchSeries: async () => { throw new Error('호출되면 안 됨'); } });
  assert.deepEqual(r, []);
});

test('rankAssetClassUniverse: 각 이름을 fetchSeries로 조회해 최신일자 기준 스코어링·순위화', async () => {
  ASSET_CLASS_ETF_UNIVERSE['테스트자산군'] = ['좋은ETF', '나쁜ETF'];
  const fetchSeries = async (name) => {
    if (name === '좋은ETF') {
      return [
        { basDd: '1', close: 100, nav: 100, accTrdVal: THRESHOLDS.liquidityWon.good, idxClose: 100 },
        { basDd: '2', close: 101, nav: 101, accTrdVal: THRESHOLDS.liquidityWon.good, idxClose: 101 },
        { basDd: '3', close: 102, nav: 102, accTrdVal: THRESHOLDS.liquidityWon.good, idxClose: 102 },
      ];
    }
    return [
      { basDd: '1', close: 100, nav: 90, accTrdVal: THRESHOLDS.liquidityWon.bad, idxClose: 100 },
    ];
  };
  const ranked = await rankAssetClassUniverse('테스트자산군', { fetchSeries });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].name, '좋은ETF'); // 유동성 높고·괴리 0·추적오차 0 → 1위
  delete ASSET_CLASS_ETF_UNIVERSE['테스트자산군'];
});

test('rankAssetClassUniverse: 조회 실패(빈 시리즈)인 이름은 스코어링 대상에서 제외', async () => {
  ASSET_CLASS_ETF_UNIVERSE['테스트자산군2'] = ['상장전ETF', '정상ETF'];
  const fetchSeries = async (name) => (name === '상장전ETF' ? [] : [{ basDd: '1', close: 100, nav: 100, accTrdVal: 1_000_000, idxClose: 100 }]);
  const ranked = await rankAssetClassUniverse('테스트자산군2', { fetchSeries });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].name, '정상ETF');
  delete ASSET_CLASS_ETF_UNIVERSE['테스트자산군2'];
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
