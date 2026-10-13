import test from 'node:test';
import assert from 'node:assert/strict';
import { compareHoldingsReplay } from './verify-holdings-replay.mjs';

test('replays eligible records with opening balance and reports key differences', () => {
  const base = { account: 'ISA', stockName: '테스트', tradeDate: '2026-09-01 09:00:00',
    tradeType: '매수', quantity: 2, dedupKey: 'buy', holdingsApplied: true };
  const executions = [base,
    { ...base, name: 'duplicate.md', quantity: 2, duplicateOf: 'first' },
    { ...base, name: 'skipped.md', quantity: 2, dedupKey: 'other-source', holdingsApplied: 'duplicate-skipped' },
    { ...base, name: 'legacy.md', quantity: 20, legacy: true }];
  const holdings = [{ account: 'ISA', name: '테스트', qty: 5, appliedDedupKeys: '["buy"]' }];
  const result = compareHoldingsReplay(executions, holdings, { 'ISA|테스트': 3 });
  assert.equal(result.eligibleCount, 1);
  assert.equal(result.rows[0].difference, 0);
  assert.deepEqual(result.rows[0].missingKeys, []);
  assert.deepEqual(result.rows[0].extraKeys, []);
});

test('closed position has no holding file and no historical key mismatch', () => {
  const result = compareHoldingsReplay([
    { account: 'ISA', stockName: '청산종목', tradeDate: '2026-09-01 09:00:00',
      tradeType: '매수', quantity: 2, dedupKey: 'buy', holdingsApplied: true },
    { account: 'ISA', stockName: '청산종목', tradeDate: '2026-09-02 09:00:00',
      tradeType: '매도', quantity: 2, dedupKey: 'sell', holdingsApplied: true },
  ], []);
  assert.equal(result.rows[0].difference, 0);
  assert.deepEqual(result.rows[0].missingKeys, []);
});

test('pending execution is reported separately and cannot create a State quantity gap', () => {
  const result = compareHoldingsReplay([{ account: 'ISA', stockName: '미처리종목',
    tradeDate: '2026-09-03 09:00:00', tradeType: '매수', quantity: 2,
    holdingsApplied: false }], []);
  assert.equal(result.pending.length, 1);
  assert.equal(result.eligibleCount, 0);
  assert.equal(result.rows.length, 0);
});

test('applied key proves crash-retry duplicate-skipped was already reflected in Holding', () => {
  const execution = { account: 'ISA', stockName: '재시도종목', tradeDate: '2026-09-03 09:00:00',
    tradeType: '매수', quantity: 2, dedupKey: 'already-written', holdingsApplied: 'duplicate-skipped' };
  const holding = { account: 'ISA', name: '재시도종목', qty: 2,
    appliedDedupKeys: '["already-written"]' };
  const result = compareHoldingsReplay([execution], [holding]);
  assert.equal(result.eligibleCount, 1);
  assert.equal(result.rows[0].difference, 0);
  assert.deepEqual(result.rows[0].missingKeys, []);
});
