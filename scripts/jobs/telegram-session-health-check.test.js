import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, shouldEscalateInsteadOfRestart, checkWithRecheck, buildMcpLossSnapshotLine } from './telegram-session-health-check.mjs';

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

// 순간포착 재확인(2026-09-01, 오너 신고 대응) — 1차 확인이 정상이면 재확인 없이
// 즉시 반환(불필요한 지연 없음), 1차에서 이상이 잡히면 sleep 후 재확인해서 그때도
// 여전히 이상이어야만 조치 대상으로 본다. 실측 근거: bun 크래시·OOM·절전 이벤트
// 전부 없는데도 "MCP 서브프로세스 소실"이 반복 감지됐던 것 — 순간적인 흔들림을
// 영구 장애로 오판해 매번 launchd 레벨 재시작(활성 세션 강제종료 포함)을 트리거하고
// 있었다(Log/Implementation 참고). sleep을 주입해 실제 대기 없이 검증한다.

test('checkWithRecheck: 1차 확인이 정상이면 재확인 없이 즉시 반환(sleep 안 부름)', async () => {
  let calls = 0;
  const checkSignals = async () => { calls++; return { sessionAlive: true, mcpSubprocessAlive: true }; };
  let slept = false;
  const sleep = async () => { slept = true; };
  const r = await checkWithRecheck(checkSignals, { sleep });
  assert.equal(calls, 1);
  assert.equal(slept, false);
  assert.equal(r.recheckedAndRecovered, false);
  assert.equal(r.sessionAlive, true);
  assert.equal(r.firstCheckUnhealthy, false, '[코드리뷰 대비/2026-09-04 신설] 1차부터 정상이면 감지 자체가 없었다는 뜻');
});

test('[막아야 함] checkWithRecheck: 1차에서만 순간적으로 이상하고 재확인에서 회복되면 recheckedAndRecovered=true, 재확인 결과(정상)를 반환', async () => {
  let calls = 0;
  const checkSignals = async () => {
    calls++;
    if (calls === 1) return { sessionAlive: true, mcpSubprocessAlive: false }; // 1차: 순간적 흔들림
    return { sessionAlive: true, mcpSubprocessAlive: true }; // 재확인: 회복
  };
  let sleptMs = null;
  const sleep = async (ms) => { sleptMs = ms; };
  const r = await checkWithRecheck(checkSignals, { sleep, recheckDelayMs: 15000 });
  assert.equal(calls, 2);
  assert.equal(sleptMs, 15000);
  assert.equal(r.recheckedAndRecovered, true);
  assert.equal(r.mcpSubprocessAlive, true, '반환값은 재확인 시점의 최신 상태여야 함');
  assert.equal(r.firstCheckUnhealthy, true, '[2026-09-04 신설] 회복됐어도 1차 감지 자체는 있었다는 걸 알아야 진단 스냅샷을 남길 수 있음');
});

test('checkWithRecheck: 재확인에서도 여전히 이상이면 recheckedAndRecovered=false(진짜 장애로 취급)', async () => {
  const checkSignals = async () => ({ sessionAlive: true, mcpSubprocessAlive: false });
  const sleep = async () => {};
  const r = await checkWithRecheck(checkSignals, { sleep });
  assert.equal(r.recheckedAndRecovered, false);
  assert.equal(r.mcpSubprocessAlive, false);
});

test('checkWithRecheck: 세션 프로세스 자체가 죽은 경우도 동일하게 재확인 대상', async () => {
  let calls = 0;
  const checkSignals = async () => {
    calls++;
    return calls === 1 ? { sessionAlive: false, mcpSubprocessAlive: false } : { sessionAlive: true, mcpSubprocessAlive: true };
  };
  const sleep = async () => {};
  const r = await checkWithRecheck(checkSignals, { sleep });
  assert.equal(calls, 2);
  assert.equal(r.recheckedAndRecovered, true);
});

// ── buildMcpLossSnapshotLine(2026-09-04 신설, 근본원인 진단 계측) ──────────────
// 2026-09-01·2026-09-04 두 번 다 크래시 리포트·OOM·절전·네트워크단절 다 확인해도
// 원인을 못 찾았다 — 다음 발생 시 시스템 스냅샷을 남겨 패턴을 쌓기 위한 함수.

test('buildMcpLossSnapshotLine: 여유메모리·loadavg·가동시간을 사람이 읽는 한 줄로', () => {
  const line = buildMcpLossSnapshotLine({
    timestampIso: '2026-09-04T06:47:59.000Z',
    recheckedAndRecovered: false,
    freeMemBytes: 64 * 1024 * 1024,
    totalMemBytes: 16 * 1024 * 1024 * 1024,
    loadavg: [2.04, 1.88, 2.00],
    uptimeSec: 3600 * 5,
  });
  assert.match(line, /2026-09-04T06:47:59\.000Z/);
  assert.match(line, /지속\(조치 대상\)/);
  assert.match(line, /여유메모리 64MB\/16,384MB\(0\.4%\)/);
  assert.match(line, /loadavg 2\.04\/1\.88\/2\.00/);
  assert.match(line, /시스템가동 5\.0시간/);
});

test('buildMcpLossSnapshotLine: 재확인 후 회복된 경우는 "일시적"로 표시', () => {
  const line = buildMcpLossSnapshotLine({
    timestampIso: '2026-09-04T00:00:00.000Z', recheckedAndRecovered: true,
    freeMemBytes: 1024 * 1024 * 1024, totalMemBytes: 16 * 1024 * 1024 * 1024, loadavg: [1, 1, 1], uptimeSec: 0,
  });
  assert.match(line, /일시적\(재확인 후 회복\)/);
});
