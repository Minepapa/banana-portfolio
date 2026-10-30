import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTelegramChannel } from './telegram-channel-env.mjs';

test('isTelegramChannel: 상시 세션·관문 실행 둘 중 하나가 1이면 텔레그램 채널이다', () => {
  assert.equal(isTelegramChannel({ CLAUDE_TELEGRAM_SESSION: '1' }), true);
  assert.equal(isTelegramChannel({ CLAUDE_TELEGRAM_GATE: '1' }), true);
  assert.equal(isTelegramChannel({ CLAUDE_TELEGRAM_SESSION: '1', CLAUDE_TELEGRAM_GATE: '1' }), true);
});

test('isTelegramChannel: 변수가 없거나 1이 아니면 텔레그램 채널이 아니다(오너 대화형 세션)', () => {
  assert.equal(isTelegramChannel({}), false);
  assert.equal(isTelegramChannel({ CLAUDE_TELEGRAM_SESSION: '0', CLAUDE_TELEGRAM_GATE: '' }), false);
  assert.equal(isTelegramChannel({ CLAUDE_TELEGRAM_GATE: 'true' }), false);
});
