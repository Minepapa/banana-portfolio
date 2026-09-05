import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNhPrice, extractNhCashDeposit } from './nh-response-parse.mjs';

test('extractNhPrice: 문자열 현재가도 숫자로 변환(NH 실측 응답은 문자열)', () => {
  assert.equal(extractNhPrice({ stck_prpr: '75000' }, 'stck_prpr'), 75000);
});

test('extractNhPrice: null/빈문자열/0은 전부 유효하지 않음(throw)', () => {
  assert.throws(() => extractNhPrice({ stck_prpr: null }, 'stck_prpr'));
  assert.throws(() => extractNhPrice({ stck_prpr: '' }, 'stck_prpr'));
  assert.throws(() => extractNhPrice({ stck_prpr: '0' }, 'stck_prpr'));
});

test('extractNhPrice: 필드 자체가 없어도 throw', () => {
  assert.throws(() => extractNhPrice({}, 'trdprc'));
});

test('extractNhCashDeposit: drn_pbl_amt 우선', () => {
  assert.equal(extractNhCashDeposit({ drn_pbl_amt: 9589177, dca: 9598682 }), 9589177);
});

test('extractNhCashDeposit: drn_pbl_amt 없으면 dca로 폴백(금현물 실측)', () => {
  assert.equal(extractNhCashDeposit({ dca: 8455 }), 8455);
});

test('extractNhCashDeposit: 콤마 포함 문자열도 파싱', () => {
  assert.equal(extractNhCashDeposit({ dca: '1,234,567' }), 1234567);
});

test('extractNhCashDeposit: 0은 유효한 값으로 보존(전액 매수 등 실제로 가능한 상태)', () => {
  assert.equal(extractNhCashDeposit({ dca: 0 }), 0);
});

test('extractNhCashDeposit: 둘 다 없으면 throw(0으로 추정하지 않음)', () => {
  assert.throws(() => extractNhCashDeposit({}));
});

test('extractNhCashDeposit: 값이 숫자로 안 읽히면 throw', () => {
  assert.throws(() => extractNhCashDeposit({ dca: 'abc' }));
});
