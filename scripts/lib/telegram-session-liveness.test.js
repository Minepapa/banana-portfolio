import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProcessAlive, TELEGRAM_SESSION_PROCESS_PATTERN, TELEGRAM_MCP_SUBPROCESS_PATTERN } from './telegram-session-liveness.mjs';

// 2026-08-31 신설 — health-watcher.mjs·telegram-session-health-check.mjs가 공유하는
// 프로세스 생존 확인. isPollingStuck 자체는 health-watcher.test.js가 이미 커버(이
// 모듈에서 재수출됨).

test('isProcessAlive: 절대 존재할 수 없는 패턴이면 false(안 터짐)', () => {
  assert.equal(isProcessAlive('절대로존재하지않을프로세스이름_xyz123'), false);
});

test('isProcessAlive: 지금 이 테스트 프로세스 자체를 찾는 패턴이면 true', () => {
  // node --test로 도는 이 프로세스 자체가 "node"를 포함하므로 자기 자신을 찾는다.
  assert.equal(isProcessAlive('node'), true);
});

test('패턴 상수가 의도한 대로 정의돼 있음(세션 프로세스와 MCP 서브프로세스 구분)', () => {
  assert.match(TELEGRAM_SESSION_PROCESS_PATTERN, /channels/);
  assert.match(TELEGRAM_MCP_SUBPROCESS_PATTERN, /telegram/);
  assert.notEqual(TELEGRAM_SESSION_PROCESS_PATTERN, TELEGRAM_MCP_SUBPROCESS_PATTERN);
});
