import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMirrorStale } from './mirrorFreshness.js';

const NOW = new Date('2026-08-05T12:00:00.000Z');

test('updatedAt 없으면 stale(동기화 이력 없음)', () => {
  assert.equal(isMirrorStale(null, NOW), true);
  assert.equal(isMirrorStale(undefined, NOW), true);
});

test('파싱 불가한 값이면 stale', () => {
  assert.equal(isMirrorStale('not-a-date', NOW), true);
});

test('2시간 이내면 신선', () => {
  assert.equal(isMirrorStale('2026-08-05T10:30:00.000Z', NOW), false);
});

test('정확히 임계치 초과면 stale', () => {
  assert.equal(isMirrorStale('2026-08-05T09:59:59.000Z', NOW), true);
});

test('임계치 커스텀 가능', () => {
  assert.equal(isMirrorStale('2026-08-05T11:00:00.000Z', NOW, 30 * 60 * 1000), true);
  assert.equal(isMirrorStale('2026-08-05T11:45:00.000Z', NOW, 30 * 60 * 1000), false);
});
