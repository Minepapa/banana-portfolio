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

// [MEDIUM 재발방지] 2026-09-19 코드리뷰 — position.stopLossPct를 이 함수가 실제로
// 쓰는지 고정(예전엔 저장만 하고 안 씀 — breakout-position-vault.mjs가 "트레일링이
// 원래 확정값을 다시 쓸 수 있어야 한다"고 필드 신설 이유를 적어뒀는데 정작 이
// 함수는 무시하고 있었음). 4% 포지션의 R단계는 8% 포지션과 다르다 — stopPrice가
// entry×0.96(4% 손절 시작값)인 상태에서 고가가 entry×1.04(4% 포지션 기준 1R)에
// 도달하면 손절선이 본전(entry)으로 올라가야 한다. stopLossPct를 무시하고 8%
// 기준으로 계산하면 아직 1R(entry×1.08) 미도달로 오판해 트레일링이 무력화된다.
test('computeTrailingRevision: stopLossPct=4% 포지션은 그 손절폭 기준 R단계로 계산됨(8% 기준과 다른 결과)', () => {
  const position = { entryPrice: 10000, highSinceEntry: 10000, stopPrice: 9600, stopLossPct: 0.04 };
  const revision = computeTrailingRevision(position, 10400); // 4% 기준 1R(entry×1.04) 도달
  assert.notEqual(revision, null, '4% 포지션은 이 고가에서 1R 도달로 트레일링이 걸려야 함');
  assert.equal(revision.newStopPrice, 10000); // 1R 도달 시 손절선=본전
});

test('computeTrailingRevision: stopLossPct 생략 시 기존 STOP_LOSS_PCT(8%) 기준(회귀 없음)', () => {
  const position = { entryPrice: 10000, highSinceEntry: 10000, stopPrice: 9200 };
  const revision = computeTrailingRevision(position, 10400); // 8% 기준으로는 아직 1R(10800) 미도달
  assert.equal(revision, null);
});
