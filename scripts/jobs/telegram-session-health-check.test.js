import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, shouldEscalateInsteadOfRestart } from './telegram-session-health-check.mjs';

// 2026-08-31 신설 — Log/DevRequests/2026-08-31-텔레그램세션-MCP연결끊김.md 대응.
// launchd KeepAlive는 프로세스 생존만 보고, "프로세스는 살아있지만 MCP만 죽은"
// 상태를 감지할 방법이 없다는 게 실측 확인됐다 — 이 잡이 그 구조적 사각을 메운다.
//
// ⚠️ 설계가 로그 grep에서 프로세스/API 기반 확인으로 바뀌었다(코드리뷰 지적 — TUI
// 차등 리페인트 때문에 로그 문자열 매칭이 실제로 새는 사례를 확인). diagnose는 이미
// 조회된 세 신호(세션 프로세스 생존·MCP 서브프로세스 생존·폴링정체)를 받아 판정만
// 하는 순수함수라 실제 pgrep/API 호출 없이 모든 조합을 테스트할 수 있다.

test('diagnose: 세 신호 다 정상이면 건강함', () => {
  const r = diagnose({ sessionAlive: true, mcpSubprocessAlive: true, pollingStuck: false });
  assert.equal(r.unhealthy, false);
});

test('[막아야 함] diagnose: 세션 프로세스 자체가 죽으면 최우선으로 그 사실을 보고(다른 신호 조회 여부 무관)', () => {
  const r = diagnose({ sessionAlive: false, mcpSubprocessAlive: false, pollingStuck: false });
  assert.equal(r.unhealthy, true);
  assert.match(r.reason, /세션 프로세스 자체/);
});

test('[막아야 함] diagnose: 세션은 살아있는데 MCP 서브프로세스만 사라짐 — 2026-08-31 실제 재현 시나리오', () => {
  const r = diagnose({ sessionAlive: true, mcpSubprocessAlive: false, pollingStuck: false });
  assert.equal(r.unhealthy, true);
  assert.match(r.reason, /MCP 서버.*소실|소실.*MCP/);
});

test('diagnose: 프로세스는 다 살아있는데 폴링만 정체(좀비 상태)', () => {
  const r = diagnose({ sessionAlive: true, mcpSubprocessAlive: true, pollingStuck: true });
  assert.equal(r.unhealthy, true);
  assert.match(r.reason, /폴링 정체/);
});

// 서킷브레이커 — 연속 재시작이 MAX를 넘으면 재시작을 멈추고 에스컬레이션(2026-08-31
// 코드리뷰 HIGH 지적 — 지속적 장애에서 10분마다 무한 재시작하면 오히려 방해가 됨).

test('shouldEscalateInsteadOfRestart: 기본 한도(3회) 이내면 계속 재시작', () => {
  assert.equal(shouldEscalateInsteadOfRestart(1), false);
  assert.equal(shouldEscalateInsteadOfRestart(2), false);
  assert.equal(shouldEscalateInsteadOfRestart(3), false);
});

test('[막아야 함] shouldEscalateInsteadOfRestart: 한도를 넘으면(4회째) 재시작 대신 에스컬레이션', () => {
  assert.equal(shouldEscalateInsteadOfRestart(4), true);
  assert.equal(shouldEscalateInsteadOfRestart(5), true);
});

test('shouldEscalateInsteadOfRestart: 커스텀 한도 지정 가능', () => {
  assert.equal(shouldEscalateInsteadOfRestart(2, 1), true);
  assert.equal(shouldEscalateInsteadOfRestart(1, 1), false);
});
