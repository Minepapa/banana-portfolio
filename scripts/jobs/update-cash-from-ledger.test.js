import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlows } from './update-cash-from-ledger.mjs';

const exec = (overrides = {}) => ({
  tradeDate: '2026-08-04 09:12:33', tradeType: '매수', stockName: '삼성전자',
  quantity: 10, price: 71000, account: '위탁',
  ...overrides,
});

const div = (overrides = {}) => ({
  date: '2026-08-04', receivedTime: '10:00:00', afterTaxAmount: 5000, account: '위탁',
  ...overrides,
});

const fundBuy = (overrides = {}) => ({
  date: '2026-08-04', fundName: 'VIP한국형가치투자증권투자신탁', amount: 500000, account: '연금저축',
  ...overrides,
});

const exchange = (overrides = {}) => ({
  date: '2026-08-04', kind: '외화매수', usd: 1000, won: 1350000, account: '위탁',
  ...overrides,
});

test('buildFlows: 체결·배당은 기존과 동일 — 매수(-)/매도(+)/배당(+)', () => {
  const flows = buildFlows('위탁', [exec({ tradeType: '매수' }), exec({ tradeType: '매도' })], [div()], [], []);
  assert.deepEqual(flows.map((f) => f.amount), [-710000, 710000, 5000]);
});

test('buildFlows: 펀드적립은 항상 현금유출(-), 시각 없어 00:00:00으로 채움', () => {
  const flows = buildFlows('연금저축', [], [], [fundBuy({ amount: 500000 })], []);
  assert.deepEqual(flows, [{ ts: '2026-08-04 00:00:00', amount: -500000 }]);
});

test('buildFlows: 펀드적립 — 다른 계좌 필터링(연금저축 전용, account-resolver.mjs FUND_PURCHASE_ACCOUNT)', () => {
  const flows = buildFlows('위탁', [], [], [fundBuy({ account: '연금저축' })], []);
  assert.deepEqual(flows, []);
});

test('buildFlows: 펀드적립 — amount가 0/비정상이면 제외', () => {
  const flows = buildFlows('연금저축', [], [], [fundBuy({ amount: 0 }), fundBuy({ amount: null })], []);
  assert.deepEqual(flows, []);
});

test('buildFlows: 환전 — 외화매수는 현금유출(-), 외화매도는 현금유입(+)', () => {
  const flows = buildFlows('위탁', [], [], [], [
    exchange({ kind: '외화매수', won: 1350000 }),
    exchange({ kind: '외화매도', won: 700000 }),
  ]);
  assert.deepEqual(flows.map((f) => f.amount), [-1350000, 700000]);
});

test('buildFlows: 환전 — 다른 계좌 필터링(위탁 전용, account-resolver.mjs EXCHANGE_ACCOUNT)', () => {
  const flows = buildFlows('ISA', [], [], [], [exchange({ account: '위탁' })]);
  assert.deepEqual(flows, []);
});

test('buildFlows: 환전 — won이 파싱 실패로 null이면 임의 환율 추정 없이 건너뜀', () => {
  const flows = buildFlows('위탁', [], [], [], [exchange({ won: null })]);
  assert.deepEqual(flows, []);
});

test('buildFlows: legacy(마이그레이션 스냅샷) 펀드적립·환전도 체결·배당과 동일하게 제외(이중계상 방지)', () => {
  const flows = buildFlows('연금저축', [], [], [fundBuy({ legacy: true })], []);
  assert.deepEqual(flows, []);
  const flows2 = buildFlows('위탁', [], [], [], [exchange({ legacy: true })]);
  assert.deepEqual(flows2, []);
});

test('buildFlows: 체결·배당·펀드적립·환전이 같은 계좌에서 함께 합산됨', () => {
  const flows = buildFlows(
    '위탁',
    [exec({ tradeType: '매도', account: '위탁' })],
    [div({ account: '위탁' })],
    [],
    [exchange({ kind: '외화매수', account: '위탁' })],
  );
  assert.deepEqual(flows.map((f) => f.amount), [710000, 5000, -1350000]);
});
