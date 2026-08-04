import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKillSwitchState, parseKillSwitchState, isKillSwitchActive } from './kill-switch.mjs';

test('파일이 없으면(content=null) 안전 기본값 — 꺼짐', () => {
  assert.equal(isKillSwitchActive(null), false);
  assert.deepEqual(parseKillSwitchState(null).active, false);
});

test('buildKillSwitchState: 켜짐 상태 왕복', () => {
  const content = buildKillSwitchState({ active: true, reason: 'Frank STOP 명령', now: new Date('2026-08-05T09:00:00.000Z') });
  const parsed = parseKillSwitchState(content);
  assert.equal(parsed.active, true);
  assert.equal(parsed.reason, 'Frank STOP 명령');
  assert.equal(parsed.changedAt, '2026-08-05T09:00:00.000Z');
  assert.equal(isKillSwitchActive(content), true);
});

test('buildKillSwitchState: 꺼짐 상태(해제) 왕복', () => {
  const content = buildKillSwitchState({ active: false, reason: '오너 해제 명령', now: new Date() });
  assert.equal(isKillSwitchActive(content), false);
});
