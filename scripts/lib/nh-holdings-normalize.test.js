import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKrHoldings, normalizeGbHoldings, normalizeGoldHoldings } from './nh-holdings-normalize.mjs';

// 실측 응답 형태(2026-09-05 라이브 조회) 그대로 재현.
test('normalizeKrHoldings: iem_cd/rsdl_qty를 code/qty로', () => {
  const output1 = [{ iem_cd: '000660', itg_bnc_qty: 9, rsdl_qty: 9 }];
  assert.deepEqual(normalizeKrHoldings(output1), [{ code: '000660', qty: 9 }]);
});

test('normalizeGbHoldings: iem_cd/sll_pbl_qty1을 code/qty로(cns_bse_bnc_qty 아님)', () => {
  const output1 = [{ iem_cd: 'GOOGL', cns_bse_bnc_qty: 18, sll_pbl_qty1: 18 }];
  assert.deepEqual(normalizeGbHoldings(output1), [{ code: 'GOOGL', qty: 18 }]);
});

test('normalizeGoldHoldings: iem_cd/rsdl_qty를 code/qty로', () => {
  const output1 = [{ iem_cd: 'M04020000', itg_bnc_qty: 31, rsdl_qty: 31 }];
  assert.deepEqual(normalizeGoldHoldings(output1), [{ code: 'M04020000', qty: 31 }]);
});

test('빈 입력(undefined/null)이면 빈 배열', () => {
  assert.deepEqual(normalizeKrHoldings(undefined), []);
  assert.deepEqual(normalizeGbHoldings(null), []);
  assert.deepEqual(normalizeGoldHoldings(), []);
});

test('수량 필드가 숫자로 안 읽히면 0으로(NaN을 그대로 흘려보내지 않음)', () => {
  const output1 = [{ iem_cd: '000660', rsdl_qty: 'abc' }];
  assert.deepEqual(normalizeKrHoldings(output1), [{ code: '000660', qty: 0 }]);
});
