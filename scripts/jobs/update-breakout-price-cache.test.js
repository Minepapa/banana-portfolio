import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCodesToUpdate, summarizeUpdateResult } from './update-breakout-price-cache.mjs';

test('selectCodesToUpdate: 상장폐지 종목(delistingDate 있음)은 제외', () => {
  const pool = [
    { code: 'A', delistingDate: null },
    { code: 'B', delistingDate: '2020-01-01' },
    { code: 'C', delistingDate: null },
  ];
  assert.deepEqual(selectCodesToUpdate(pool), ['A', 'C']);
});

test('selectCodesToUpdate: 빈 pool은 빈 배열', () => {
  assert.deepEqual(selectCodesToUpdate([]), []);
});

test('summarizeUpdateResult: 각 상태별 건수 집계(2026-09-14 코드리뷰 반영 — no-cache-file/empty-confirmed/corporate-action-refetched 추가)', () => {
  const result = {
    A: 'updated+3',
    B: 'already-current',
    C: 'no-cache-file',
    D: 'no-new-rows',
    E: 'error:timeout',
    F: 'updated+1',
    G: 'empty-confirmed',
    H: 'corporate-action-refetched+120',
  };
  const { summary, errors, noCacheFileCodes, total } = summarizeUpdateResult(result);
  assert.equal(total, 8);
  assert.equal(summary.updated, 2);
  assert.equal(summary['already-current'], 1);
  assert.equal(summary['no-cache-file'], 1);
  assert.equal(summary['no-new-rows'], 1);
  assert.equal(summary['empty-confirmed'], 1);
  assert.equal(summary['corporate-action-refetched'], 1);
  assert.equal(summary.error, 1);
  assert.deepEqual(errors, ['E: error:timeout']);
  assert.deepEqual(noCacheFileCodes, ['C']);
});

test('summarizeUpdateResult: 빈 결과는 전부 0, noCacheFileCodes도 빈 배열', () => {
  const { summary, errors, noCacheFileCodes, total } = summarizeUpdateResult({});
  assert.equal(total, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(noCacheFileCodes, []);
  assert.equal(Object.values(summary).every((v) => v === 0), true);
});

test('summarizeUpdateResult: updated+N/corporate-action-refetched+N에서 "+" 뒤 숫자와 무관하게 각 버킷으로만 집계(status.startsWith 오분류 방지)', () => {
  const { summary } = summarizeUpdateResult({ A: 'updated+123', B: 'corporate-action-refetched+4021' });
  assert.equal(summary.updated, 1);
  assert.equal(summary['corporate-action-refetched'], 1);
});

test('summarizeUpdateResult: no-cache-file 여러 건이면 noCacheFileCodes가 전부 담김(순서 보존)', () => {
  const { noCacheFileCodes } = summarizeUpdateResult({ X: 'no-cache-file', Y: 'already-current', Z: 'no-cache-file' });
  assert.deepEqual(noCacheFileCodes, ['X', 'Z']);
});
