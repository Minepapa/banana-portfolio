import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrailingRevision } from './breakout-trailing.mjs';

test('computeTrailingRevision: 1R(+8%) 신규 도달 시 손절선을 본전으로 올리도록 판정', () => {
  const position = { entryPrice: 10000, highSinceEntry: 10000, stopPrice: 9200 };
  const revision = computeTrailingRevision(position, 10800);
  assert.notEqual(revision, null);
  assert.equal(revision.newHighSinceEntry, 10800);
  assert.equal(revision.newStopPrice, 10000);
});

test('computeTrailingRevision: 이미 반영된 고점 이하로만 움직이면 갱신 불필요(null)', () => {
  const position = { entryPrice: 10000, highSinceEntry: 10800, stopPrice: 10000 };
  const revision = computeTrailingRevision(position, 10500); // 기존 고점(10800)보다 낮음
  assert.equal(revision, null);
});

test('computeTrailingRevision: 새 R단계까지는 안 갔지만 고점만 갱신된 경우도 손절선 변화 없으면 null', () => {
  const position = { entryPrice: 10000, highSinceEntry: 10000, stopPrice: 9200 };
  const revision = computeTrailingRevision(position, 10300); // 아직 1R(10800) 미도달
  assert.equal(revision, null);
});

test('computeTrailingRevision: 2R 도달 시 손절선을 1R가로 상향', () => {
  const position = { entryPrice: 10000, highSinceEntry: 10800, stopPrice: 10000 };
  const revision = computeTrailingRevision(position, 11600);
  assert.notEqual(revision, null);
  assert.equal(revision.newStopPrice, 10800);
});

test('computeTrailingRevision: 손절선은 절대 하향되지 않음(래칫) — 이미 더 높은 값이 기록돼 있으면 null', () => {
  // position.stopPrice가 이미 10000(1R 도달분)인데 latestHigh가 아주 낮게 들어온 경우
  const position = { entryPrice: 10000, highSinceEntry: 10800, stopPrice: 10000 };
  const revision = computeTrailingRevision(position, 9500);
  assert.equal(revision, null);
});
