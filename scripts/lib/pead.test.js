import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standaloneQuarterlySeries, computeSueSeries, sueAtOrBefore } from './pead.mjs';

test('standaloneQuarterlySeries: 1분기는 그대로, 그 외는 같은 해 직전 리포트 누적치를 빼서 환산', () => {
  const history = [
    { bsnsYear: '2020', reprtCode: '11013', disclosureDate: '2020-05-14', netIncome: 100 }, // Q1
    { bsnsYear: '2020', reprtCode: '11012', disclosureDate: '2020-08-14', netIncome: 250 }, // 반기누적
    { bsnsYear: '2020', reprtCode: '11014', disclosureDate: '2020-11-14', netIncome: 420 }, // 3Q누적
    { bsnsYear: '2020', reprtCode: '11011', disclosureDate: '2021-03-14', netIncome: 600 }, // 연간누적
  ];
  const s = standaloneQuarterlySeries(history);
  const byCode = Object.fromEntries(s.map((e) => [e.reprtCode, e.standalone]));
  assert.equal(byCode['11013'], 100);
  assert.equal(byCode['11012'], 150); // 250-100
  assert.equal(byCode['11014'], 170); // 420-250
  assert.equal(byCode['11011'], 180); // 600-420
});

test('standaloneQuarterlySeries: 같은 해 직전 리포트가 이력에 없으면 null(추정 안 함)', () => {
  const history = [{ bsnsYear: '2020', reprtCode: '11012', disclosureDate: '2020-08-14', netIncome: 250 }]; // 1분기 누락
  const s = standaloneQuarterlySeries(history);
  assert.equal(s[0].standalone, null);
});

test('standaloneQuarterlySeries: 연도·분기 순서가 뒤섞여 들어와도 quarterIndex 오름차순 정렬', () => {
  const history = [
    { bsnsYear: '2021', reprtCode: '11013', disclosureDate: '2021-05-14', netIncome: 10 },
    { bsnsYear: '2020', reprtCode: '11013', disclosureDate: '2020-05-14', netIncome: 5 },
  ];
  const s = standaloneQuarterlySeries(history);
  assert.deepEqual(s.map((e) => e.bsnsYear), ['2020', '2021']);
  assert.ok(s[0].quarterIndex < s[1].quarterIndex);
});

// computeSueSeries — Foster·Olsen·Shevlin(1984) 계절성 랜덤워크 SUE. 손계산 검증:
// 과거 8분기 전년동기차분 = [8,12,6,10,14,8,12,10](평균10, 표본표준편차 σ=√(48/7)),
// 이번 분기 전년동기차분(target) = 50 → SUE = 50/σ.
test('computeSueSeries: 13분기(현재+과거12) 모두 있으면 손계산과 일치하는 SUE 산출', () => {
  const standalone = [100, 100, 100, 100, 110, 112, 108, 114, 120, 118, 120, 122, 170];
  const series = standalone.map((v, i) => ({
    bsnsYear: '2020', reprtCode: '11013', disclosureDate: `2020-01-${String(i + 1).padStart(2, '0')}`,
    quarterIndex: i, standalone: v,
  }));
  const out = computeSueSeries(series);
  const sigma = Math.sqrt(48 / 7);
  const expected = 50 / sigma;
  assert.ok(Math.abs(out[12].sue - expected) < 1e-9, `${out[12].sue} !== ${expected}`);
  // 12분기 미만(과거 데이터 부족)인 앞쪽 분기들은 전부 null(추정 안 함).
  for (let i = 0; i < 12; i++) assert.equal(out[i].sue, null);
});

test('computeSueSeries: 필요한 분기 중 하나라도 결측이면(공시 누락 등) 그 지점 SUE는 null', () => {
  const standalone = [100, 100, 100, 100, 110, 112, 108, 114, 120, 118, 120, 122, 170];
  const series = standalone.map((v, i) => ({
    bsnsYear: '2020', reprtCode: '11013', disclosureDate: `2020-01-${String(i + 1).padStart(2, '0')}`,
    quarterIndex: i, standalone: v,
  })).filter((e) => e.quarterIndex !== 0); // 가장 오래된 분기(0번, target=12의 prior 체인에 필요) 제거
  const out = computeSueSeries(series);
  const target = out.find((e) => e.quarterIndex === 12);
  assert.equal(target.sue, null);
});

test('computeSueSeries: standalone이 null인 분기 자체는 sue도 null', () => {
  const series = [{ bsnsYear: '2020', reprtCode: '11012', disclosureDate: '2020-08-14', quarterIndex: 1, standalone: null }];
  const out = computeSueSeries(series);
  assert.equal(out[0].sue, null);
});

test('sueAtOrBefore: targetDate 이하 공시일 중 가장 최근 SUE만 선택(룩어헤드 방지)', () => {
  const sueSeries = [
    { disclosureDate: '2020-05-14', sue: 1.0 },
    { disclosureDate: '2020-08-14', sue: 2.0 },
    { disclosureDate: '2020-11-14', sue: 3.0 },
  ];
  assert.equal(sueAtOrBefore(sueSeries, '2020-09-01').sue, 2.0);
  assert.equal(sueAtOrBefore(sueSeries, '2020-05-14').sue, 1.0); // 경계값(같은 날) 포함
  assert.equal(sueAtOrBefore(sueSeries, '2020-01-01'), null); // 그 이전엔 공시 자체가 없음
});

test('sueAtOrBefore: sue가 null인 항목은 후보에서 제외', () => {
  const sueSeries = [{ disclosureDate: '2020-05-14', sue: null }, { disclosureDate: '2020-03-01', sue: 5.0 }];
  assert.equal(sueAtOrBefore(sueSeries, '2020-12-31').sue, 5.0);
});
