import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKillSwitchState, parseKillSwitchState, isKillSwitchActive } from './kill-switch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

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

// 구조적 가드(2026-09-18 코드리뷰 지적) — 카이로스 돌파매매(승인 없는 완전자동
// 실거래) 경로에서 킬스위치가 실제 브로커 호출보다 먼저 오는지 소스 문자열로
// 고정한다. vault-job-catalog-audit.test.js와 동일한 정신 — "기억해서 챙기기"는
// 이 프로젝트에서 이미 여러 번 실패가 증명된 방식이라, 향후 리팩터가 이 순서를
// 깨도(킬스위치 체크를 실수로 지우거나 뒤로 옮겨도) npm test가 초록으로 남는 걸
// 막는다. I/O·모킹 없이 소스 위치만 비교하는 정적 검사.
test('킬스위치 가드가 카이로스 발주 경로(placeKrOrder)보다 먼저 온다 — 순서가 뒤집히면 승인 없는 실주문이 킬스위치를 우회함', () => {
  const targets = [
    '../tools/place-breakout-entry-order.mjs',
    '../jobs/place-breakout-fallback-entry.mjs',
  ];
  for (const rel of targets) {
    const src = readFileSync(join(HERE, rel), 'utf8');
    const gateIdx = src.indexOf('isKillSwitchActive(');
    const orderIdx = src.indexOf('placeKrOrder({');
    assert.ok(gateIdx > -1, `${rel}: isKillSwitchActive 호출이 없음`);
    assert.ok(orderIdx > -1, `${rel}: placeKrOrder 호출이 없음`);
    assert.ok(gateIdx < orderIdx, `${rel}: 킬스위치 가드(${gateIdx})가 placeKrOrder(${orderIdx})보다 뒤에 있음`);
  }
});
