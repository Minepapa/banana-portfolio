// irp-balance-delta.mjs 테스트 — 가짜 종목·수량·금액만 쓴다(공개 저장소).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  observeIrpBalance, planIrpBalanceDeltaExecutions, readIrpBalanceDeltaState, writeIrpBalanceDeltaState,
  IRP_BALANCE_DELTA_SOURCE, parseReconcileIrpLog, settlesFromObservations, findOverlappingIrpEstimates, ledgerDatesForSettle,
} from './irp-balance-delta.mjs';

const FUND = { code: '900199', name: '가상 TDF2099' };
const kis = (qty, invest, extra = {}) => ({ ...FUND, qty, invest, avgPrice: invest / qty, curPrice: 10100, ...extra });

// 하루를 거쳐 정산 대상을 만든다: day1 기준(openQty) → day1 중 관측들 → day2 첫 관측.
function runDays(observations, { vaultQty = observations[0].qty, vaultInvest = observations[0].invest } = {}) {
  let state = null;
  let settle = null;
  const vault = [{ name: FUND.name, ticker: FUND.code, qty: vaultQty, invest: vaultInvest }];
  for (const { day, at, qty, invest } of observations) {
    const result = observeIrpBalance(state, { today: day, observedAt: `${day} ${at}`, kisHoldings: [kis(qty, invest)], vaultIrpHoldings: vault });
    state = result.state;
    if (result.settle) settle = result.settle;
  }
  return { state, settle };
}

test('observeIrpBalance: 상태가 없으면 덮어쓰기 전 Vault 보유를 그날 기준으로 삼는다', () => {
  const { state, settle, bootstrapped } = observeIrpBalance(null, {
    today: '2099-01-05', observedAt: '2099-01-05 11:10:00',
    kisHoldings: [kis(110, 1110000)], vaultIrpHoldings: [{ name: FUND.name, ticker: FUND.code, qty: 100, invest: 1000000 }],
  });
  assert.equal(bootstrapped, true);
  assert.equal(settle, null);
  assert.equal(state.open[FUND.code].qty, 100);
  assert.equal(state.last[FUND.code].qty, 110);
  assert.equal(state.last[FUND.code].firstChangeAt, '2099-01-05 11:10:00');
});

test('observeIrpBalance: 같은 날에는 정산하지 않고, 처음 증가를 본 시각을 이어 준다', () => {
  const { state, settle } = runDays([
    { day: '2099-01-05', at: '09:00:00', qty: 100, invest: 1000000 },
    { day: '2099-01-05', at: '11:10:00', qty: 110, invest: 1110000 },
    { day: '2099-01-05', at: '16:07:00', qty: 110, invest: 1110000 },
  ]);
  assert.equal(settle, null);
  assert.equal(state.last[FUND.code].firstChangeAt, '2099-01-05 11:10:00');
});

test('observeIrpBalance: 날짜가 바뀐 첫 실행에서 지난 날을 정산하고 지난 날 마지막 값이 새 기준이 된다', () => {
  const { state, settle } = runDays([
    { day: '2099-01-05', at: '09:00:00', qty: 100, invest: 1000000 },
    { day: '2099-01-05', at: '11:10:00', qty: 110, invest: 1110000 },
    { day: '2099-01-06', at: '09:00:00', qty: 110, invest: 1110000 },
  ]);
  assert.equal(settle.day, '2099-01-05');
  assert.equal(settle.open[FUND.code].qty, 100);
  assert.equal(settle.last[FUND.code].qty, 110);
  assert.equal(state.day, '2099-01-06');
  assert.equal(state.open[FUND.code].qty, 110);
  assert.equal(state.last[FUND.code].firstChangeAt, null);
});

test('[불변식] 하루 안에서 줄었다가 다시 늘어난 흔들림은 순증가 0 — 매수로 보지 않는다', () => {
  const { settle } = runDays([
    { day: '2099-01-05', at: '09:00:00', qty: 100, invest: 1000000 },
    { day: '2099-01-05', at: '10:00:00', qty: 90, invest: 900000 },
    { day: '2099-01-05', at: '10:10:00', qty: 100, invest: 1000000 },
    { day: '2099-01-06', at: '09:00:00', qty: 100, invest: 1000000 },
  ]);
  const { records, warnings } = planIrpBalanceDeltaExecutions({ ...settle, ledgerExecutions: [] });
  assert.deepEqual(records, []);
  assert.deepEqual(warnings, []);
});

test('observeIrpBalance: 시계가 거꾸로 가면 상태를 바꾸지 않는다', () => {
  const state = { day: '2099-01-06', open: {}, last: {} };
  const result = observeIrpBalance(state, { today: '2099-01-05', observedAt: '2099-01-05 09:00:00', kisHoldings: [kis(1, 1)] });
  assert.equal(result.state, state);
  assert.equal(result.settle, null);
});

const settleFixture = () => ({
  day: '2099-01-05',
  // 2099-01-02(금) 16:07 기준 → 2099-01-05(월) 16:07 마지막 관측 — 주말을 낀 인접 거래일.
  open: { [FUND.code]: { ...FUND, qty: 100, invest: 1000000, observedAt: '2099-01-02 16:07:00' } },
  last: { [FUND.code]: { ...FUND, qty: 110, invest: 1110000, curPrice: 10100, observedAt: '2099-01-05 16:07:00', firstChangeAt: '2099-01-05 11:10:00' } },
});
const ledgerRow = (overrides = {}) => ({
  tradeDate: '2099-01-05 11:03:00', tradeType: '매수', stockCode: FUND.code, stockName: FUND.name,
  quantity: 10, account: 'IRP', source: 'KAKAO', ...overrides,
});

test('planIrpBalanceDeltaExecutions: 원장에 없는 순증가는 추정 체결 하나로 — 출처·추정 표기·단가·시각', () => {
  const { records, recognized, warnings } = planIrpBalanceDeltaExecutions({ ...settleFixture(), ledgerExecutions: [] });
  assert.deepEqual(recognized, []);
  assert.deepEqual(warnings, []);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.source, IRP_BALANCE_DELTA_SOURCE);
  assert.equal(record.estimated, true);
  assert.match(record.estimateNote, /실제 체결 시각 아님/);
  assert.match(record.estimateNote, /매입금액 변화/);
  assert.equal(record.tradeType, '매수');
  assert.equal(record.account, 'IRP');
  assert.equal(record.quantity, 10);
  assert.equal(record.price, 11000);
  assert.equal(record.tradeDate, '2099-01-05 11:10:00');
  assert.equal(record.sourceEventId, `${IRP_BALANCE_DELTA_SOURCE}-2099-01-05-${FUND.code}`);
  assert.equal(record.estimateWindowFrom, '2099-01-02 16:07:00');
  assert.equal(record.estimateWindowTo, '2099-01-05 16:07:00');
});

// 리뷰 HIGH(2026-11-07): 잡이 하루 한 번(16:07)이면 정산 구간은 "그날"이 아니라 (기준 관측, 마지막 관측]이다.
test('[불변식 1] 원장 대조는 날짜가 아니라 (기준 관측 시각, 마지막 관측 시각] 구간 — 앞날 시간외 카카오도 인정', () => {
  const afterHours = ledgerRow({ tradeDate: '2099-01-02 17:00:00' });
  const { records, recognized } = planIrpBalanceDeltaExecutions({ ...settleFixture(), ledgerExecutions: [afterHours] });
  assert.deepEqual(records, []);
  assert.equal(recognized.length, 1);
});

test('[불변식 1] 기준 관측 이전 체결(앞 구간 몫)은 이번 구간 인정 근거가 아니다', () => {
  const before = ledgerRow({ tradeDate: '2099-01-02 11:00:00' });
  const { records } = planIrpBalanceDeltaExecutions({ ...settleFixture(), ledgerExecutions: [before] });
  assert.equal(records.length, 1);
});

test('[불변식 1] 시각 미상(00:00:00) 기록은 구간 양 끝 날짜에 걸리면 넣어 대조한다(보수적)', () => {
  const manual = ledgerRow({ tradeDate: '2099-01-02 00:00:00', sourceEventId: 'manual-x' });
  const { records, recognized } = planIrpBalanceDeltaExecutions({ ...settleFixture(), ledgerExecutions: [manual] });
  assert.deepEqual(records, []);
  assert.equal(recognized.length, 1);
});

test('[불변식 6] 구간이 거래일 하나를 넘으면(중간 평일 관측 누락) 기록하지 않고 경고만', () => {
  const fixture = settleFixture();
  fixture.open[FUND.code].observedAt = '2099-01-01 16:07:00'; // 목 → 월: 금요일이 비었다
  const { records, warnings } = planIrpBalanceDeltaExecutions({ ...fixture, ledgerExecutions: [] });
  assert.deepEqual(records, []);
  assert.match(warnings[0], /거래일/);
});

test('[불변식 6] 기준 관측 시각을 모르면(상태 새로 시작) 증가가 있어도 기록하지 않고 경고만', () => {
  const fixture = settleFixture();
  delete fixture.open[FUND.code].observedAt;
  const { records, warnings } = planIrpBalanceDeltaExecutions({ ...fixture, ledgerExecutions: [] });
  assert.deepEqual(records, []);
  assert.match(warnings[0], /기준 관측 시각/);
});

test('observeIrpBalance: 날짜가 바뀌면 지난 마지막 관측 시각이 새 기준 관측 시각이 된다', () => {
  const state = { day: '2099-01-05', open: {}, last: { [FUND.code]: { ...FUND, qty: 110, invest: 1, observedAt: '2099-01-05 16:07:00' } } };
  const result = observeIrpBalance(state, { today: '2099-01-06', observedAt: '2099-01-06 16:07:00', kisHoldings: [kis(110, 1)] });
  assert.equal(result.state.open[FUND.code].observedAt, '2099-01-05 16:07:00');
});

// 리뷰 MEDIUM: 추정 10주 기록 뒤 카카오가 4주·6주로 나눠 늦게 오면 수량 일치 중복 판정이 못 잡는다.
test('findOverlappingIrpEstimates: 같은 종목 추정 기록의 구간 안에 든 IRP 카카오 매수를 찾는다', () => {
  const estimate = {
    ...ledgerRow({ tradeDate: '2099-01-05 11:10:00', source: IRP_BALANCE_DELTA_SOURCE, estimated: true }),
    estimateWindowFrom: '2099-01-02 16:07:00', estimateWindowTo: '2099-01-05 16:07:00', quantity: 10,
  };
  const kakao = ledgerRow({ quantity: 4 });
  assert.equal(findOverlappingIrpEstimates(kakao, [estimate, kakao]).length, 1);
  assert.equal(findOverlappingIrpEstimates(ledgerRow({ tradeDate: '2099-01-06 11:00:00' }), [estimate]).length, 0);
  assert.equal(findOverlappingIrpEstimates(ledgerRow({ stockCode: '900198', stockName: '가상 다른 펀드' }), [estimate]).length, 0);
  assert.equal(findOverlappingIrpEstimates(ledgerRow({ tradeType: '매도' }), [estimate]).length, 0);
  assert.equal(findOverlappingIrpEstimates(estimate, [estimate]).length, 0);
  assert.equal(findOverlappingIrpEstimates(ledgerRow({ account: 'ISA' }), [estimate]).length, 0);
});

test('planIrpBalanceDeltaExecutions: 매입금액이 없으면 현재가로 단가를 추정하고 근거를 남긴다', () => {
  const fixture = settleFixture();
  fixture.open[FUND.code].invest = null;
  const { records } = planIrpBalanceDeltaExecutions({ ...fixture, ledgerExecutions: [] });
  assert.equal(records[0].price, 10100);
  assert.match(records[0].estimateNote, /현재가/);
});

test('[불변식 1] 같은 날·같은 종목·같은 수량이 카카오로 이미 있으면 기존 것을 인정하고 쓰지 않는다', () => {
  const { records, recognized } = planIrpBalanceDeltaExecutions({ ...settleFixture(), ledgerExecutions: [ledgerRow()] });
  assert.deepEqual(records, []);
  assert.equal(recognized.length, 1);
});

test('[불변식 1] 수동 보충(manual-)과 이전 추정 기록도 인정한다 — 재실행해도 두 번 쓰지 않는다', () => {
  const manual = ledgerRow({ sourceEventId: 'manual-20990105-irp', tradeDate: '2099-01-05 00:00:00' });
  assert.deepEqual(planIrpBalanceDeltaExecutions({ ...settleFixture(), ledgerExecutions: [manual] }).records, []);
  const estimated = ledgerRow({ source: IRP_BALANCE_DELTA_SOURCE, estimated: true });
  assert.deepEqual(planIrpBalanceDeltaExecutions({ ...settleFixture(), ledgerExecutions: [estimated] }).records, []);
});

test('[불변식 1] 원장 여러 건의 합이 순증가와 같아도 인정한다(분할 체결)', () => {
  const rows = [ledgerRow({ quantity: 4 }), ledgerRow({ quantity: 6, tradeDate: '2099-01-05 13:00:00' })];
  const { records, recognized } = planIrpBalanceDeltaExecutions({ ...settleFixture(), ledgerExecutions: rows });
  assert.deepEqual(records, []);
  assert.equal(recognized.length, 1);
});

test('[불변식 1] 원장 매수가 일부만 있으면 나머지를 짐작하지 않고 경고만 한다', () => {
  const { records, warnings } = planIrpBalanceDeltaExecutions({ ...settleFixture(), ledgerExecutions: [ledgerRow({ quantity: 4 })] });
  assert.deepEqual(records, []);
  assert.equal(warnings.length, 1);
});

test('planIrpBalanceDeltaExecutions: 구간 밖·다른 계좌·다른 종목·중복 표시 행은 인정 근거가 아니다', () => {
  const rows = [
    ledgerRow({ tradeDate: '2099-01-06 11:03:00' }), // 구간 뒤
    ledgerRow({ account: 'ISA' }),
    ledgerRow({ stockCode: '900198', stockName: '가상 다른 펀드' }),
    ledgerRow({ holdingsApplied: 'duplicate-skipped' }),
    ledgerRow({ duplicateOf: '2099-01-05-다른-기록' }),
    ledgerRow({ legacy: true }),
  ];
  const { records } = planIrpBalanceDeltaExecutions({ ...settleFixture(), ledgerExecutions: rows });
  assert.equal(records.length, 1);
});

test('[불변식 2] 감소·같은 날 원장 매도·처음 보는 종목은 기록하지 않고 경고만 한다', () => {
  const decrease = settleFixture();
  decrease.last[FUND.code].qty = 95;
  let result = planIrpBalanceDeltaExecutions({ ...decrease, ledgerExecutions: [] });
  assert.deepEqual(result.records, []);
  assert.match(result.warnings[0], /감소/);

  result = planIrpBalanceDeltaExecutions({ ...settleFixture(), ledgerExecutions: [ledgerRow({ tradeType: '매도', quantity: 5 })] });
  assert.deepEqual(result.records, []);
  assert.match(result.warnings[0], /매도/);

  const fresh = settleFixture();
  fresh.open = {};
  result = planIrpBalanceDeltaExecutions({ ...fresh, ledgerExecutions: [] });
  assert.deepEqual(result.records, []);
  assert.match(result.warnings[0], /처음 보는 종목/);

  const gone = settleFixture();
  gone.last = {};
  result = planIrpBalanceDeltaExecutions({ ...gone, ledgerExecutions: [] });
  assert.deepEqual(result.records, []);
  assert.match(result.warnings[0], /마지막 잔고에 없음/);
});

test('observeIrpBalance: 지난 날 마지막 응답에 없던 종목은 다음 날 기준에서 빠진다(같은 경고 반복 방지)', () => {
  const state = { day: '2099-01-05', open: { [FUND.code]: { ...FUND, qty: 100, invest: 1 } }, last: {} };
  const result = observeIrpBalance(state, { today: '2099-01-06', observedAt: '2099-01-06 09:00:00', kisHoldings: [] });
  assert.ok(result.settle);
  assert.deepEqual(result.state.open, {});
});

test('상태 파일: 없거나 깨지면 null, 쓰고 읽으면 그대로', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irp-delta-'));
  try {
    const path = join(dir, 'sub', 'state.json');
    assert.equal(readIrpBalanceDeltaState(path), null);
    writeIrpBalanceDeltaState({ day: '2099-01-05', open: {}, last: {} }, path);
    assert.deepEqual(readIrpBalanceDeltaState(path), { day: '2099-01-05', open: {}, last: {} });
    writeIrpBalanceDeltaState('{', path);
    assert.equal(readIrpBalanceDeltaState(join(dir, 'none.json')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseReconcileIrpLog + settlesFromObservations: 로그에서 날짜별 순증가를 되살린다(예수금 줄 없는 블록은 버림)', () => {
  const log = [
    '  + [예수금] IRP 2099-01-04 16:07:05 잔고 1,000원',
    '  = [종목] IRP 가상 TDF2099 100주 @10000원(KIS 직접조회)',
    '✅ IRP 종목 KIS 직접조회 반영 완료(변경 없음)',
    '🫀 reconcile-irp OK 1s',
    '  ⚠️ IRP 예수금이 0으로 응답 — 기록 건너뜀',
    '  = [종목] IRP 가상 TDF2099 999주 @1원(KIS 직접조회)',
    '🫀 reconcile-irp OK 1s',
    '  + [예수금(예정)] IRP 2099-01-05 11:10:00 잔고 1,000원',
    '  ↻ [종목(예정)] IRP 가상 TDF2099 110주 @10100원(KIS 직접조회)',
    '🫀 reconcile-irp OK 1s',
    '  + [예수금] IRP 2099-01-06 16:07:05 잔고 1,000원',
    '  = [종목] IRP 가상 TDF2099 110주 @10100원(KIS 직접조회)',
  ].join('\n');
  const observations = parseReconcileIrpLog(log);
  assert.equal(observations.length, 3);
  const settles = settlesFromObservations(observations);
  assert.deepEqual(settles.map((s) => s.day), ['2099-01-04', '2099-01-05']);
  const { records } = planIrpBalanceDeltaExecutions({ ...settles[1], ledgerExecutions: [] });
  assert.equal(records.length, 1);
  assert.equal(records[0].quantity, 10);
  assert.equal(records[0].tradeDate, '2099-01-05 11:10:00');
  assert.equal(records[0].price, 11100); // (110×10100 − 100×10000) / 10
  // 로그에는 종목코드가 없어 원장과는 종목명으로 맞춘다.
  const kakao = { tradeDate: '2099-01-05 11:03:00', tradeType: '매수', stockCode: '900199', stockName: '가상 TDF2099', quantity: 10, account: 'IRP' };
  assert.deepEqual(planIrpBalanceDeltaExecutions({ ...settles[1], ledgerExecutions: [kakao] }).records, []);
  // 마지막 관측일은 through(오늘)보다 이전일 때만 정산한다.
  assert.deepEqual(settlesFromObservations(observations, { through: '2099-01-06' }).map((s) => s.day), ['2099-01-04', '2099-01-05']);
  assert.deepEqual(settlesFromObservations(observations, { through: '2099-01-07' }).map((s) => s.day), ['2099-01-04', '2099-01-05', '2099-01-06']);
});

test('ledgerDatesForSettle: 기준 관측일부터 정산일까지, 기준 시각이 없으면 정산일만', () => {
  assert.deepEqual(ledgerDatesForSettle(settleFixture()), ['2099-01-02', '2099-01-03', '2099-01-04', '2099-01-05']);
  assert.deepEqual(ledgerDatesForSettle({ day: '2099-01-05', open: { x: { qty: 1 } } }), ['2099-01-05']);
});
