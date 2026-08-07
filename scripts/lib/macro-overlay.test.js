import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFaberSignal, computeRateSpreadSignal, computeSimpleBollingerSignal,
  detectFaberCrossover, computeMacroOverlaySignals,
} from './macro-overlay.mjs';

function series(n, fn) { return Array.from({ length: n }, (_, i) => fn(i)); }

test('computeFaberSignal: 데이터 200일 미만이면 null(판정 보류)', () => {
  assert.equal(computeFaberSignal(series(100, () => 100)), null);
});

test('computeFaberSignal: 현재가가 200일 평균 위면 aboveMA true', () => {
  const closes = [...series(200, () => 100), 150]; // 201개, 최근 200개 평균=(100*199+150)/200=100.25
  const r = computeFaberSignal(closes);
  assert.equal(r.aboveMA, true);
  assert.equal(r.current, 150);
});

test('computeFaberSignal: 현재가가 평균 아래면 aboveMA false', () => {
  const closes = [...series(200, () => 100), 50];
  const r = computeFaberSignal(closes);
  assert.equal(r.aboveMA, false);
});

test('detectFaberCrossover: 이전 상태 없으면(첫 확인) 크로스 아님', () => {
  assert.equal(detectFaberCrossover(null, true), false);
  assert.equal(detectFaberCrossover(undefined, false), false);
});

test('detectFaberCrossover: 위→아래 또는 아래→위로 바뀌면 크로스', () => {
  assert.equal(detectFaberCrossover(true, false), true);
  assert.equal(detectFaberCrossover(false, true), true);
});

test('detectFaberCrossover: 상태 그대로면 크로스 아님(매일 계산 가능한 것 자체는 변화가 아님)', () => {
  assert.equal(detectFaberCrossover(true, true), false);
  assert.equal(detectFaberCrossover(false, false), false);
});

test('computeRateSpreadSignal: 스프레드가 음수면 역전(inverted)', () => {
  const r = computeRateSpreadSignal([3.5], [4.0]);
  assert.equal(r.currentSpread, -0.5);
  assert.equal(r.inverted, true);
});

test('computeRateSpreadSignal: 정상(양수) 스프레드', () => {
  const r = computeRateSpreadSignal([4.5], [4.0]);
  assert.equal(r.currentSpread, 0.5);
  assert.equal(r.inverted, false);
});

test('computeRateSpreadSignal: 길이가 다르면 볼린저는 null이지만 현재값은 계산(추정 안 하되 포기도 안 함)', () => {
  const r = computeRateSpreadSignal([4.5, 4.6], [4.0]);
  assert.ok(Math.abs(r.currentSpread - 0.6) < 1e-9);
  assert.equal(r.bands, null);
});

test('computeRateSpreadSignal: 각자 독립적으로 결측을 제거하면 우연히 길이가 같아지는 경우도 쌍(같은 원본 인덱스) 기준으로 걸러 날짜 정합을 유지한다(코드리뷰 지적 회귀방지)', () => {
  // tnx는 인덱스 10·20이 NaN, irx는 인덱스 15·25가 NaN — 서로 다른 위치인데 둘 다
  // 2개씩 빠지므로 "각자 독립 필터 후 길이 비교"만 하면 150-2=148로 같아져 예전
  // 버그(길이만 같으면 그대로 인덱스로 짝짓기)가 걸리지 않고 통과해버린다. 올바른
  // 구현은 "원본 인덱스 기준 쌍" 중 하나라도 NaN인 4개 위치(10,15,20,25)를 전부
  // 제외해 150-4=146개 쌍만 남겨야 한다 — computeBollingerBands가 실제로 쓴 표본수
  // (window)로 어느 쪽이 적용됐는지 확인한다.
  const tnx = Array.from({ length: 150 }, (_, i) => (i === 10 || i === 20 ? NaN : 4.0));
  const irx = Array.from({ length: 150 }, (_, i) => (i === 15 || i === 25 ? NaN : 3.0));
  const r = computeRateSpreadSignal(tnx, irx);
  assert.ok(r.bands, '길이가 같아 밴드가 계산돼야 함');
  assert.equal(r.bands.window, 146); // 148(구버전 버그)이 아니라 146(수정판)이어야 함
});

test('computeRateSpreadSignal: 빈 배열이면 null', () => {
  assert.equal(computeRateSpreadSignal([], [4.0]), null);
  assert.equal(computeRateSpreadSignal([4.0], []), null);
});

test('computeSimpleBollingerSignal: 평범한 값은 breached false', () => {
  const closes = series(300, (i) => 100 + Math.sin(i) * 2);
  const r = computeSimpleBollingerSignal(closes);
  assert.equal(r.breached, false);
});

test('computeSimpleBollingerSignal: 극단값은 breached true', () => {
  const closes = [...series(300, () => 100), 1000];
  const r = computeSimpleBollingerSignal(closes);
  assert.equal(r.breached, true);
});

test('computeSimpleBollingerSignal: 빈 배열이면 null', () => {
  assert.equal(computeSimpleBollingerSignal([]), null);
});

test('computeMacroOverlaySignals: 전부 평범하면 anyMeaningfulChange false', () => {
  const flat = series(300, () => 100);
  const r = computeMacroOverlaySignals({
    kospiCloses: flat, sp500Closes: flat, tnxCloses: [4.5], irxCloses: [4.0],
    dxyCloses: flat, vixCloses: flat, wtiCloses: flat,
    previousFaberState: { domestic: true, foreign: true },
  });
  assert.equal(r.anyMeaningfulChange, false);
});

test('computeMacroOverlaySignals: Faber 크로스 하나만 있어도 anyMeaningfulChange true', () => {
  const closes = [...series(200, () => 100), 150]; // aboveMA=true
  const flat = series(300, () => 100);
  const r = computeMacroOverlaySignals({
    kospiCloses: closes, sp500Closes: flat, tnxCloses: [4.5], irxCloses: [4.0],
    dxyCloses: flat, vixCloses: flat, wtiCloses: flat,
    previousFaberState: { domestic: false, foreign: true }, // 국내: false→true 크로스
  });
  assert.equal(r.faberDomesticCrossed, true);
  assert.equal(r.anyMeaningfulChange, true);
});

test('computeMacroOverlaySignals: 매일 aboveMA=true로 계산 가능한 것 자체는 크로스 아님(회귀 테스트)', () => {
  const closes = [...series(200, () => 100), 150];
  const flat = series(300, () => 100);
  const r = computeMacroOverlaySignals({
    kospiCloses: closes, sp500Closes: flat, tnxCloses: [4.5], irxCloses: [4.0],
    dxyCloses: flat, vixCloses: flat, wtiCloses: flat,
    previousFaberState: { domestic: true, foreign: true }, // 이미 true였음 — 크로스 아님
  });
  assert.equal(r.faberDomesticCrossed, false);
  assert.equal(r.anyMeaningfulChange, false);
});

test('computeMacroOverlaySignals: 금리차 역전만 있어도 anyMeaningfulChange true', () => {
  const flat = series(300, () => 100);
  const r = computeMacroOverlaySignals({
    kospiCloses: flat, sp500Closes: flat, tnxCloses: [3.5], irxCloses: [4.0], // 역전
    dxyCloses: flat, vixCloses: flat, wtiCloses: flat,
    previousFaberState: { domestic: null, foreign: null },
  });
  assert.equal(r.rateSpreadBreached, true);
  assert.equal(r.anyMeaningfulChange, true);
});
