import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findStatusRow } from './job-status.mjs';

test('findStatusRow: 기존 잡은 1-based 시트행(A2=2) 반환', () => {
  const rows = [['drain', '2026-06-04 06:00', 'OK', '', '5'],
                ['risk-d', '2026-06-04 07:00', 'FAIL', 'limit', '12']];
  assert.equal(findStatusRow(rows, 'drain'), 2);
  assert.equal(findStatusRow(rows, 'risk-d'), 3);
});

test('findStatusRow: 없는 잡은 null(=append)', () => {
  assert.equal(findStatusRow([['drain', '', 'OK', '', '']], 'risk-b'), null);
  assert.equal(findStatusRow([], 'drain'), null);
  assert.equal(findStatusRow(null, 'drain'), null);
});

test('findStatusRow: 앞뒤 공백 무시', () => {
  assert.equal(findStatusRow([[' drain ', '', 'OK', '', '']], 'drain'), 2);
});
