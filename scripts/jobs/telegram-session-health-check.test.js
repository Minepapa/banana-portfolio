import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, shouldEscalateInsteadOfRestart, checkWithRecheck, buildMcpLossSnapshotLine, filterPendingTranscriptLines, markRestartSucceeded, nextRestartState, sortTimestampedTranscriptLines } from './telegram-session-health-check.mjs';

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

test('[실사고 재현] diagnose: 로그 정체와 미답변 오너 메시지가 함께 지속되면 대화 중간 멈춤으로 판정', () => {
  const r = diagnose({
    sessionAlive: true, mcpSubprocessAlive: true, pollingStuck: false,
    sessionLogStale: true, ownerMessageAwaitingReply: true,
  });
  assert.equal(r.unhealthy, true);
  assert.match(r.reason, /로그 정체.*대화형 확인창|대화형 확인창.*로그 정체/);
});

test('diagnose: 정상적으로 조용할 뿐 미답변 오너 메시지가 없으면 로그 정체만으로 재시작하지 않음', () => {
  const r = diagnose({
    sessionAlive: true, mcpSubprocessAlive: true, pollingStuck: false,
    sessionLogStale: true, ownerMessageAwaitingReply: false,
  });
  assert.equal(r.unhealthy, false);
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

test('[공통 재확인 계약] checkWithRecheck: 로그 정체 결합값도 두 번째 조회값이 정상이면 조치하지 않음', async () => {
  let calls = 0;
  const checkSignals = async () => ({ sessionAlive: true, mcpSubprocessAlive: true, sessionLogStale: ++calls === 1, ownerMessageAwaitingReply: true });
  const isUnhealthy = (signals) => signals.sessionLogStale && signals.ownerMessageAwaitingReply;
  const r = await checkWithRecheck(checkSignals, { sleep: async () => {}, isUnhealthy });
  assert.equal(calls, 2);
  assert.equal(r.recheckedAndRecovered, true);
  assert.equal(r.firstCheckUnhealthy, true);
});

test('[실사고 재현] sortTimestampedTranscriptLines: timestamp 없는 메타 레코드가 섞인 파일 병합도 실제 시간순으로 정렬', () => {
  const lines = [
    { type: 'last-prompt' },
    { type: 'user', timestamp: '2026-09-25T07:10:00.000Z' },
    { type: 'cost-state' },
    { type: 'assistant', timestamp: '2026-09-25T07:00:00.000Z' },
    { type: 'attachment' },
  ];
  assert.deepEqual(sortTimestampedTranscriptLines(lines).map((d) => d.timestamp), [
    '2026-09-25T07:00:00.000Z', '2026-09-25T07:10:00.000Z',
  ]);
});

test('[실사고 재현] filterPendingTranscriptLines: 재시작 전 orphan pending은 mtime과 무관하게 판정에서 제외', () => {
  const lines = [
    { type: 'user', timestamp: '2026-09-25T07:00:00.000Z' },
    { type: 'user', timestamp: '2026-09-25T08:00:00.000Z' },
  ];
  assert.deepEqual(filterPendingTranscriptLines(lines, {
    nowMs: new Date('2026-09-25T09:00:00.000Z').getTime(),
    lastRestartAtMs: new Date('2026-09-25T07:30:00.000Z').getTime(),
  }).map((d) => d.timestamp), ['2026-09-25T08:00:00.000Z']);
});

test('[막아야 함] nextRestartState: 같은 hang으로 3회 재시작 뒤 잠시 정상이어도 카운트를 리셋하지 않아 다음 감지에서 에스컬레이션', () => {
  const options = { reasonKey: 'session-log-stale-owner-message', windowMs: 6 * 60 * 60_000 };
  let state = { consecutiveRestarts: 0, lastRestartAtMs: null, lastRestartReasonKey: null };
  state = nextRestartState(state, { unhealthy: true, nowMs: 1_000, ...options });
  state = markRestartSucceeded(state, { nowMs: 1_100, reasonKey: options.reasonKey });
  state = nextRestartState(state, { unhealthy: false, nowMs: 2_000, ...options });
  state = nextRestartState(state, { unhealthy: true, nowMs: 3_000, ...options });
  state = markRestartSucceeded(state, { nowMs: 3_100, reasonKey: options.reasonKey });
  state = nextRestartState(state, { unhealthy: false, nowMs: 4_000, ...options });
  state = nextRestartState(state, { unhealthy: true, nowMs: 5_000, ...options });
  state = markRestartSucceeded(state, { nowMs: 5_100, reasonKey: options.reasonKey });
  assert.equal(state.consecutiveRestarts, 3);
  state = nextRestartState(state, { unhealthy: false, nowMs: 6_000, ...options });
  state = nextRestartState(state, { unhealthy: true, nowMs: 7_000, ...options });
  assert.equal(shouldEscalateInsteadOfRestart(state.consecutiveRestarts), true);
});

test('[막아야 함] nextRestartState: 기존 MCP 소실 신호도 정상 판정 전까지 계속 누적해 서킷브레이커를 보존', () => {
  let state = { consecutiveRestarts: 0, lastRestartAtMs: null, lastRestartReasonKey: null };
  for (let i = 0; i < 4; i++) {
    state = nextRestartState(state, { unhealthy: true, reasonKey: 'mcp-subprocess-missing', nowMs: 1_000 + i });
  }
  assert.equal(state.consecutiveRestarts, 4);
  assert.equal(shouldEscalateInsteadOfRestart(state.consecutiveRestarts), true);
});

test('[막아야 함] nextRestartState: 최근 창 안에서 hang과 polling-stuck 사유가 교대해도 서킷브레이커까지 누적', () => {
  const reasonKeys = ['session-log-stale-owner-message', 'polling-stuck'];
  let state = { consecutiveRestarts: 0, lastUnhealthyAtMs: null, lastRestartAtMs: null, lastRestartReasonKey: null };
  for (let i = 0; i < 8; i++) {
    state = nextRestartState(state, {
      unhealthy: true,
      reasonKey: reasonKeys[i % reasonKeys.length],
      nowMs: 1_000 + i * 10 * 60_000,
    });
    assert.equal(shouldEscalateInsteadOfRestart(state.consecutiveRestarts), i >= 3);
  }
});

test('nextRestartState: 오래 지난 chronic 카운트는 다른 일회성 신호의 에스컬레이션에 재사용하지 않음', () => {
  const state = {
    consecutiveRestarts: 3,
    lastUnhealthyAtMs: 1_000,
    lastRestartAtMs: 1_000,
    lastRestartReasonKey: 'session-log-stale-owner-message',
  };
  const next = nextRestartState(state, {
    unhealthy: true,
    reasonKey: 'mcp-subprocess-missing',
    nowMs: 6 * 60 * 60_000 + 1_001,
  });
  assert.equal(next.consecutiveRestarts, 1);
  assert.equal(shouldEscalateInsteadOfRestart(next.consecutiveRestarts), false);
});

test('nextRestartState: 비-hang 재시작 뒤 짧은 정상 판정이어도 최근 창 동안 카운트와 orphan 차단 경계를 유지', () => {
  const restarted = nextRestartState(
    { consecutiveRestarts: 0, lastRestartAtMs: null, lastRestartReasonKey: null },
    { unhealthy: true, reasonKey: 'mcp-subprocess-missing', nowMs: 1_000 },
  );
  const restartedSuccessfully = markRestartSucceeded(restarted, { nowMs: 1_500, reasonKey: 'mcp-subprocess-missing' });
  const recovered = nextRestartState(restartedSuccessfully, { unhealthy: false, nowMs: 2_000 });
  assert.equal(recovered.consecutiveRestarts, 1);
  assert.equal(recovered.lastRestartAtMs, 1_500);
});

test('nextRestartState: 실패한 재시도는 orphan 차단 경계를 앞당기지 않고, 성공한 재시도만 경계를 기록', () => {
  const attempted = nextRestartState(
    { consecutiveRestarts: 0, consecutiveRestartReasonKey: null, lastRestartAtMs: 100, lastRestartReasonKey: 'mcp-subprocess-missing' },
    { unhealthy: true, reasonKey: 'session-log-stale-owner-message', nowMs: 1_000 },
  );
  assert.equal(attempted.lastRestartAtMs, 100);
  const succeeded = markRestartSucceeded(attempted, { nowMs: 1_100, reasonKey: 'session-log-stale-owner-message' });
  assert.equal(succeeded.lastRestartAtMs, 1_100);
});

test('nextRestartState: 실패한 hang 재시도도 감지 시각을 별도로 누적해 서킷브레이커를 유지', () => {
  let state = nextRestartState(
    { consecutiveRestarts: 0, consecutiveRestartReasonKey: null, lastUnhealthyAtMs: null, lastRestartAtMs: null, lastRestartReasonKey: null },
    { unhealthy: true, reasonKey: 'session-log-stale-owner-message', nowMs: 1_000 },
  );
  state = nextRestartState(state, { unhealthy: true, reasonKey: 'session-log-stale-owner-message', nowMs: 2_000 });
  assert.equal(state.consecutiveRestarts, 2);
  assert.equal(state.lastRestartAtMs, null);
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
