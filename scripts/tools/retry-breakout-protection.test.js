import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectProtectionPosition } from './retry-breakout-protection.mjs';

const entry = (id, code, status = '보유') => ({ filepath: `${id}.md`, position: { id, code, status } });

test('보호주문 수동 재시도: code로 보유 포지션 하나를 선택한다', () => {
  const result = selectProtectionPosition([entry('003490-2026-09-23', '003490')], { code: '003490' });
  assert.equal(result.ok, true);
  assert.equal(result.entry.position.id, '003490-2026-09-23');
});

test('보호주문 수동 재시도: 둘 이상이면 추정하지 않고 중단한다', () => {
  const result = selectProtectionPosition([
    entry('003490-2026-09-23', '003490'), entry('003490-2026-09-24', '003490'),
  ], { code: '003490' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /2건/);
});

test('보호주문 수동 재시도: 청산 포지션은 선택하지 않는다', () => {
  const result = selectProtectionPosition([entry('003490-2026-09-23', '003490', '청산')], { code: '003490' });
  assert.equal(result.ok, false);
});

test('보호주문 수동 재시도: position-id는 code보다 좁은 선택을 허용한다', () => {
  const result = selectProtectionPosition([
    entry('003490-2026-09-23', '003490'), entry('003490-2026-09-24', '003490'),
  ], { positionId: '003490-2026-09-24' });
  assert.equal(result.ok, true);
  assert.equal(result.entry.position.id, '003490-2026-09-24');
});
