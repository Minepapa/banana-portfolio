import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReminderBody } from './pension-balance-reminder.mjs';

test('buildReminderBody: 연금저축·삼성증권 앱 확인 안내가 포함된다', () => {
  const body = buildReminderBody();
  assert.match(body, /연금저축/);
  assert.match(body, /삼성증권/);
  assert.match(body, /개인연금잔고/);
});

test('buildReminderBody: 왜 수동 확인이 필요한지(자동알림 없음) 근거를 담는다', () => {
  const body = buildReminderBody();
  assert.match(body, /카카오 자동알림도 API도 없어/);
});

test('buildReminderBody: 매번 결정론적으로 같은 문자열(데이터 조회 없는 순수 상수)', () => {
  assert.equal(buildReminderBody(), buildReminderBody());
});
