import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCashEvents, resetAccumulator, NEW_CASH_THRESHOLD_WON } from './cash-accumulator.mjs';

test('applyCashEvents: 최초 실행(existing null)에서 이벤트 합산', () => {
  const r = applyCashEvents(null, [{ dedupKey: 'a', amount: 100_000 }, { dedupKey: 'b', amount: 50_000 }]);
  assert.equal(r.accumulatedAmount, 150_000);
  assert.equal(r.addedCount, 2);
  assert.deepEqual(new Set(r.appliedDedupKeys), new Set(['a', 'b']));
  assert.equal(r.crossed, false);
});

test('applyCashEvents: 이미 반영된 dedupKey는 중복 합산 안 됨(멱등)', () => {
  const existing = { accumulatedAmount: 100_000, appliedDedupKeys: ['a'] };
  const r = applyCashEvents(existing, [{ dedupKey: 'a', amount: 100_000 }, { dedupKey: 'b', amount: 30_000 }]);
  assert.equal(r.accumulatedAmount, 130_000);
  assert.equal(r.addedCount, 1);
});

test('[막아야 함] applyCashEvents: 처음으로 50만원 문턱을 넘으면 crossed=true', () => {
  const existing = { accumulatedAmount: 480_000, appliedDedupKeys: ['a'] };
  const r = applyCashEvents(existing, [{ dedupKey: 'b', amount: 30_000 }]);
  assert.equal(r.accumulatedAmount, 510_000);
  assert.ok(r.accumulatedAmount >= NEW_CASH_THRESHOLD_WON);
  assert.equal(r.crossed, true);
});

test('applyCashEvents: 이미 문턱을 넘어있던 상태로 또 들어오면 crossed=false(중복 트리거 방지)', () => {
  const existing = { accumulatedAmount: 600_000, appliedDedupKeys: ['a'] };
  const r = applyCashEvents(existing, [{ dedupKey: 'b', amount: 10_000 }]);
  assert.equal(r.crossed, false);
});

test('applyCashEvents: dedupKey 없거나 금액이 0 이하인 이벤트는 무시', () => {
  const r = applyCashEvents(null, [{ dedupKey: '', amount: 100 }, { dedupKey: 'x', amount: 0 }, { dedupKey: 'y', amount: -5 }]);
  assert.equal(r.accumulatedAmount, 0);
  assert.equal(r.addedCount, 0);
});

test('applyCashEvents: 이벤트 없으면 상태 그대로', () => {
  const existing = { accumulatedAmount: 200_000, appliedDedupKeys: ['a'] };
  const r = applyCashEvents(existing, []);
  assert.equal(r.accumulatedAmount, 200_000);
  assert.equal(r.addedCount, 0);
  assert.equal(r.crossed, false);
});

test('resetAccumulator: 0과 빈 dedup 목록으로 초기화', () => {
  assert.deepEqual(resetAccumulator(), { accumulatedAmount: 0, appliedDedupKeys: [] });
});
