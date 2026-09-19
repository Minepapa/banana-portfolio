import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFxRpWrite, num, ymdKst } from './reconcile-nh-fx-rp.mjs';

test('num: 콤마 포함 문자열도 파싱', () => {
  assert.equal(num('5,353.15'), 5353.15);
});

test('num: 파싱 불가면 null', () => {
  assert.equal(num('abc'), null);
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
});

test('ymdKst: Date를 KST YYYYMMDD 문자열로', () => {
  // UTC 2026-09-18 20:00 = KST 2026-09-19 05:00
  assert.equal(ymdKst(new Date('2026-09-18T20:00:00Z')), '20260919');
});

// [핵심 안전장치] 2026-09-19 코드리뷰 CRITICAL — 리팩터링 중 이 가드가 실수로
// rows.length===0 체크로 바뀌어 빠졌었다. rows는 있는데(RP 거래이력 존재) lots가
// 0개(적요·통화필드 변경 등으로 파싱만 실패)인 경우, "진짜 전량상환"과 구분 못 해
// qty=0을 조용히 쓰면 실보유 830만원어치가 사라진 것처럼 기록될 뻔했다.
test('[핵심 안전장치] decideFxRpWrite: 거래이력은 있는데 열린 로트가 0개면 쓰지 않음(진짜 전량상환과 데이터 이상을 구분 못 함)', () => {
  const result = decideFxRpWrite({
    rows: [{ trd_dt: '20260101', sps_cd_krl_anm: '외화RP매도', trd_amt: 1000, cur_cd: 'USD' }],
    truncated: false, lots: [], total: 0, currency: null, currentQty: 6005.62,
  });
  assert.equal(result.write, false);
  assert.equal(result.reason, 'no-open-lots');
});

test('[핵심 안전장치] decideFxRpWrite: 조회기간 내 RP 거래 자체가 없으면 쓰지 않음', () => {
  const result = decideFxRpWrite({ rows: [], truncated: false, lots: [], total: 0, currency: null, currentQty: 6005.62 });
  assert.equal(result.write, false);
  assert.equal(result.reason, 'no-rp-transactions');
});

test('decideFxRpWrite: 페이지네이션이 잘렸으면(truncated) 쓰지 않음', () => {
  const result = decideFxRpWrite({
    rows: [{ trd_dt: '20260101' }], truncated: true,
    lots: [{ amount: 100, currency: 'USD' }], total: 100, currency: 'USD', currentQty: 100,
  });
  assert.equal(result.write, false);
  assert.equal(result.reason, 'truncated');
});

// [핵심 안전장치] 2026-09-19 코드리뷰 HIGH — FIFO 매칭 실패는 과대계상 쪽으로도
// 실패한 전례가 있다(2차 구현이 총액을 5배로 부풀림, nhplug-common.mjs 주석 참고).
test('[핵심 안전장치] decideFxRpWrite: 기존값 대비 50% 넘게 변하면 쓰지 않고 확인 요청', () => {
  const result = decideFxRpWrite({
    rows: [{ trd_dt: '20260101' }], truncated: false,
    lots: [{ amount: 31138, currency: 'USD' }], total: 31138, currency: 'USD', currentQty: 6005.62,
  });
  assert.equal(result.write, false);
  assert.equal(result.reason, 'large-change');
});

test('decideFxRpWrite: 50% 이내 변동은 정상적으로 씀', () => {
  const result = decideFxRpWrite({
    rows: [{ trd_dt: '20260101' }], truncated: false,
    lots: [{ amount: 7000, currency: 'USD' }], total: 7000, currency: 'USD', currentQty: 6005.62,
  });
  assert.equal(result.write, true);
  assert.equal(result.derivedQty, 7000);
});

test('decideFxRpWrite: 로트 통화가 혼재하면 쓰지 않음', () => {
  const result = decideFxRpWrite({
    rows: [{ trd_dt: '20260101' }], truncated: false,
    lots: [{ amount: 100, currency: 'USD' }, { amount: 200, currency: 'JPY' }],
    total: 300, currency: 'USD', currentQty: 100,
  });
  assert.equal(result.write, false);
  assert.equal(result.reason, 'mixed-currency');
});

test('decideFxRpWrite: 오차 0.01 미만이면 변경 없음으로 쓰지 않음', () => {
  const result = decideFxRpWrite({
    rows: [{ trd_dt: '20260101' }], truncated: false,
    lots: [{ amount: 6005.62, currency: 'USD' }], total: 6005.62, currency: 'USD', currentQty: 6005.62,
  });
  assert.equal(result.write, false);
  assert.equal(result.reason, 'unchanged');
});

test('decideFxRpWrite: 기존 기록이 없으면(첫 기록, currentQty null) 변동폭 검사 없이 씀', () => {
  const result = decideFxRpWrite({
    rows: [{ trd_dt: '20260101' }], truncated: false,
    lots: [{ amount: 6005.62, currency: 'USD' }], total: 6005.62, currency: 'USD', currentQty: null,
  });
  assert.equal(result.write, true);
  assert.equal(result.derivedQty, 6005.62);
});
