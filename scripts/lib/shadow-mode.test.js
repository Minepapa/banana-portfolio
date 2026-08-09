import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExecutionModeState, getExecutionMode, isShadowMode, settleExecution, MODE_SHADOW, MODE_LIVE,
} from './shadow-mode.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';

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

// reason(감사기록) — 코드리뷰 지적(2026-08-09, Phase 12): 실제 자금 발주를 켜는 스위치라
// "언제·무슨 명령으로 전환됐는지" 킬스위치(buildKillSwitchState)와 동일하게 남겨야 한다.
test('buildExecutionModeState: reason이 프론트매터에 그대로 남는다(감사기록)', () => {
  const content = buildExecutionModeState({ mode: MODE_LIVE, reason: 'Frank 명령: "실전전환"', now: new Date() });
  assert.equal(parseFrontmatter(content).reason, 'Frank 명령: "실전전환"');
});

test('buildExecutionModeState: reason 생략하면 빈 문자열(하위호환)', () => {
  const content = buildExecutionModeState({ mode: MODE_SHADOW, now: new Date() });
  assert.equal(parseFrontmatter(content).reason, '');
});

test('settleExecution: 섀도우 모드는 브로커를 안 부르고 로그만 만든다', async () => {
  const proposal = { assetKey: '삼성전자', quantity: 10, side: '매수' };
  const r = await settleExecution({ mode: MODE_SHADOW, proposal });
  assert.equal(r.status, '섀도우체결');
  assert.equal(r.writesToLedger, false);
  assert.match(r.log, /SHADOW.*삼성전자.*10매수/);
});

test('settleExecution: 실전 모드인데 liveExecutor 없으면 조용히 넘어가지 않고 에러', async () => {
  const proposal = { assetKey: '삼성전자', quantity: 10, side: '매수' };
  await assert.rejects(() => settleExecution({ mode: MODE_LIVE, proposal }), /liveExecutor가 주입되지 않았습니다/);
});

test('settleExecution: 실전 모드 + liveExecutor 주입 시 그 결과를 그대로 반영(liveExecutor가 비동기여도 await됨)', async () => {
  const proposal = { assetKey: '삼성전자', quantity: 10, side: '매수' };
  const liveExecutor = async (p) => ({ brokerOrderId: 'KIS-123', filledQty: p.quantity });
  const r = await settleExecution({ mode: MODE_LIVE, proposal, liveExecutor });
  assert.equal(r.status, '체결');
  assert.equal(r.writesToLedger, true);
  assert.equal(r.brokerOrderId, 'KIS-123');
});

// liveExecutor가 실패(거부)하면 settlement 자체가 throw돼야 한다 — "실주문이 실패했는데
// 조용히 체결로 처리"되는 게 이 프로젝트에서 가장 위험한 실패모드(Phase 11 회귀방지).
test('settleExecution: liveExecutor가 실패(reject)하면 그대로 전파(체결로 위장 안 함)', async () => {
  const proposal = { assetKey: '삼성전자', quantity: 10, side: '매수' };
  const liveExecutor = async () => { throw new Error('KIS 주문 오류: 주문가능금액 초과'); };
  await assert.rejects(() => settleExecution({ mode: MODE_LIVE, proposal, liveExecutor }), /주문가능금액 초과/);
});
