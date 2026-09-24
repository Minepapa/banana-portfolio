import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isKrxPreMarketWindow } from './reconcile-breakout-protection.mjs';

test('isKrxPreMarketWindow: 평일 08:35 KST KRX 시가단일가 안', () => {
  assert.equal(isKrxPreMarketWindow(new Date('2026-09-24T23:35:00Z')), true); // 9/25 금 08:35 KST
});
test('isKrxPreMarketWindow: 08:30 시작 전은 false', () => {
  assert.equal(isKrxPreMarketWindow(new Date('2026-09-24T23:29:00Z')), false);
});
test('isKrxPreMarketWindow: 09:00 정규장 개시부터는 false', () => {
  assert.equal(isKrxPreMarketWindow(new Date('2026-09-25T00:00:00Z')), false);
});
test('isKrxPreMarketWindow: 토요일 08:35는 false', () => {
  assert.equal(isKrxPreMarketWindow(new Date('2026-09-25T23:35:00Z')), false);
});
