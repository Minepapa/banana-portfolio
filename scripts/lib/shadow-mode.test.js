import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExecutionModeState, getExecutionMode, isShadowMode, settleExecution, MODE_SHADOW, MODE_LIVE,
} from './shadow-mode.mjs';

test('[핵심 안전장치] content가 없으면(State 파일 미존재) 무조건 섀도우', () => {
  assert.equal(getExecutionMode(null), MODE_SHADOW);
  assert.equal(getExecutionMode(''), MODE_SHADOW);
  assert.equal(isShadowMode(null), true);
});

test('[핵심 안전장치] 알 수 없는/손상된 값이면 섀도우로 안전하게 떨어진다', () => {
  assert.equal(getExecutionMode('---\nmode: "???"\n---\n'), MODE_SHADOW);
  assert.equal(getExecutionMode('완전히 손상된 내용'), MODE_SHADOW);
});

test('buildExecutionModeState → getExecutionMode 왕복(섀도우)', () => {
  const content = buildExecutionModeState({ mode: MODE_SHADOW, now: new Date('2026-08-05T09:00:00.000Z') });
  assert.equal(getExecutionMode(content), MODE_SHADOW);
  assert.equal(isShadowMode(content), true);
});

test('buildExecutionModeState → getExecutionMode 왕복(실전) — 명시적 전환만 인정', () => {
  const content = buildExecutionModeState({ mode: MODE_LIVE, now: new Date() });
  assert.equal(getExecutionMode(content), MODE_LIVE);
  assert.equal(isShadowMode(content), false);
});

test('buildExecutionModeState: 허용 안 된 모드 값은 즉시 에러(오타 방지)', () => {
  assert.throws(() => buildExecutionModeState({ mode: 'shadow' }), /알 수 없는 모드/);
});

test('settleExecution: 섀도우 모드는 브로커를 안 부르고 로그만 만든다', () => {
  const proposal = { assetKey: '삼성전자', quantity: 10, side: '매수' };
  const r = settleExecution({ mode: MODE_SHADOW, proposal });
  assert.equal(r.status, '섀도우체결');
  assert.equal(r.writesToLedger, false);
  assert.match(r.log, /SHADOW.*삼성전자.*10매수/);
});

test('settleExecution: 실전 모드인데 liveExecutor 없으면 조용히 넘어가지 않고 에러', () => {
  const proposal = { assetKey: '삼성전자', quantity: 10, side: '매수' };
  assert.throws(() => settleExecution({ mode: MODE_LIVE, proposal }), /liveExecutor가 주입되지 않았습니다/);
});

test('settleExecution: 실전 모드 + liveExecutor 주입 시 그 결과를 그대로 반영', () => {
  const proposal = { assetKey: '삼성전자', quantity: 10, side: '매수' };
  const liveExecutor = (p) => ({ brokerOrderId: 'KIS-123', filledQty: p.quantity });
  const r = settleExecution({ mode: MODE_LIVE, proposal, liveExecutor });
  assert.equal(r.status, '체결');
  assert.equal(r.writesToLedger, true);
  assert.equal(r.brokerOrderId, 'KIS-123');
});
