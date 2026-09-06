import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPENSE_RATIO_TABLE, getExpenseRatio } from './etf-expense-ratios.mjs';

test('getExpenseRatio: 테이블에 없는 종목은 null(0으로 추정 안 함)', () => {
  assert.equal(getExpenseRatio('존재하지않는ETF'), null);
});

test('getExpenseRatio: 테이블에 있으면 그 값 반환', () => {
  EXPENSE_RATIO_TABLE['테스트ETF'] = 0.15;
  assert.equal(getExpenseRatio('테스트ETF'), 0.15);
  delete EXPENSE_RATIO_TABLE['테스트ETF'];
});
