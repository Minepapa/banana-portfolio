import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideEntryOutcome, decideCanceledEntryOutcome } from './watch-breakout-entry-fill.mjs';

// [핵심 안전장치] 코드리뷰 CRITICAL 지적(2026-09-13) 재발방지 테스트 — "체결상태를
// 모름"(마지막 조회 실패)과 "0주 체결 확정"을 반드시 구분해야 한다. 뭉개면 실제로는
// 체결됐는데 확인만 실패한 경우에도 다음날시가 폴백이 걸려 중복매수+무방비포지션 사고.
test('decideEntryOutcome: 조회 자체가 실패(resultKnown=false)면 fallbackEnabled여도 절대 폴백 안 함 — manualReview', () => {
  const d = decideEntryOutcome({ fallbackEnabled: true, resultKnown: false, filledQty: 0 });
  assert.equal(d.action, 'manualReview');
  assert.match(d.reason, /확인 자체가 실패/);
});

test('decideEntryOutcome: 정상 조회로 filledQty=0이 확정되고 fallbackEnabled=true면 폴백 큐잉', () => {
  const d = decideEntryOutcome({ fallbackEnabled: true, resultKnown: true, filledQty: 0 });
  assert.equal(d.action, 'queueFallback');
});

test('decideEntryOutcome: filledQty=0 확정이어도 fallbackEnabled=false면(마지막 다리) manualReview', () => {
  const d = decideEntryOutcome({ fallbackEnabled: false, resultKnown: true, filledQty: 0 });
  assert.equal(d.action, 'manualReview');
  assert.match(d.reason, /전량체결 미확인/);
});

test('decideEntryOutcome: 부분체결은 일반/풀백 경로에서 manualReview(중복매수 위험)', () => {
  const withFallback = decideEntryOutcome({ fallbackEnabled: true, resultKnown: true, filledQty: 5 });
  const withoutFallback = decideEntryOutcome({ fallbackEnabled: false, resultKnown: true, filledQty: 5 });
  assert.equal(withFallback.action, 'manualReview');
  assert.equal(withoutFallback.action, 'manualReview');
  assert.match(withFallback.reason, /5주/);
});

test('decideEntryOutcome: 장후 부분체결이어도 잔여주문 취소 미확인이면 자동 이관하지 않고 수동 확인', () => {
  const d = decideEntryOutcome({ fallbackEnabled: true, deferProtection: true, resultKnown: true, filledQty: 5 });
  assert.equal(d.action, 'manualReview');
  assert.match(d.reason, /취소\/실효가 확인되지 않아/);
});

test('decideCanceledEntryOutcome: 장후 주문이 부분체결 후 취소되면 체결분 보호 대상으로 이관', () => {
  assert.deepEqual(decideCanceledEntryOutcome({ deferProtection: true, filledQty: 5 }), { action: 'protectPartialAfterHours' });
});
test('decideCanceledEntryOutcome: 부분체결 없는 취소는 포지션을 만들지 않음', () => {
  assert.deepEqual(decideCanceledEntryOutcome({ deferProtection: true, filledQty: 0 }), { action: 'canceled' });
});
test('decideCanceledEntryOutcome: 일반 경로의 일부체결 취소는 자동 추정 대신 수동 확인', () => {
  assert.deepEqual(decideCanceledEntryOutcome({ deferProtection: false, filledQty: 5 }), { action: 'manualReview' });
});
