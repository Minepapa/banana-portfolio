import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createGateDaemon, gateSelfCheck, installExitCleanup, POLL_STALL_MS, RECOVERY_CONFIRM_MS, STALE_COMMAND_MS } from './telegram-gate.mjs';
import { createGateInbox } from '../lib/telegram-gate-inbox.mjs';

// 데몬 조립을 가짜 Bot API·가짜 발송·가짜 도구로 시험한다. 네트워크·실제 도구·볼트를 쓰지 않는다.
// mode는 기본 'live'(처리기가 실제로 도구를 부르는 경로) — 도구·발송·하트비트가 모두 가짜라 운영 상태는 바뀌지 않는다.
const OWNER = '31337';
const T0 = Date.parse('2026-10-30T05:00:00Z');

function setup({ mode = 'live', getUpdates = null, runTool = null, conversation = null, confirmStore = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-daemon-'));
  const clock = { ms: T0 };
  const inbox = createGateInbox({ dir, now: () => new Date(clock.ms) });
  const sent = [];
  const warned = [];
  const tools = [];
  const beats = [];
  let daemon;
  daemon = createGateDaemon({
    gate: { mode, config: { botToken: 'FAKE:x', chatId: OWNER }, allowFrom: new Set([OWNER]), stateDir: dir, heartbeatJob: null },
    inbox,
    api: {
      getUpdates: getUpdates ? (...a) => getUpdates(daemon, clock, ...a) : async () => [],
      react: async () => {},
      getFile: async () => ({ file_path: 'a', file_unique_id: 'u' }),
      download: async () => Buffer.from(''),
    },
    send: async (message, chatId) => { sent.push({ ...message, chatId }); },
    warn: async (message) => { warned.push(message); },
    now: () => new Date(clock.ms),
    sleep: async (ms) => { clock.ms += ms; },
    exit: () => { throw new Error('exit 호출'); },
    selfCheck: () => ({ ok: true, problems: [] }),
    runTool: runTool ?? (async (tool, args) => { tools.push({ tool, args }); return '완료'; }),
    wiki: { resolve: async () => ({ action: 'clarify' }), apply: async () => ({}) },
    writeHeartbeat: async (beat) => { beats.push(beat); },
    log: () => {},
    listPollers: () => ['123 bun run <server>.ts'],
    conversation,
    confirmStore,
  });
  return { dir, inbox, daemon, sent, warned, tools, beats, clock, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const msg = (id, fields, { from = OWNER, date = T0 / 1000 } = {}) => ({
  update_id: id,
  message: { message_id: id, date, chat: { id: Number(from), type: 'private' }, from: { id: Number(from) }, ...(typeof fields === 'string' ? { text: fields } : fields) },
});

test('처리: 허용 사용자 스위치는 도구 실행 후 완료, 남의 메시지는 버림', async () => {
  const s = setup();
  try {
    s.inbox.appendUpdates([msg(1, '킬스위치 온'), msg(2, '킬스위치 오프', { from: '999' })]);
    for (const item of s.inbox.pending()) await s.daemon.processItem(item);
    assert.deepEqual(s.tools, [{ tool: 'kill-switch-cli.mjs', args: ['--text=킬스위치 온'] }]);
    assert.equal(s.inbox.get(1).status, '완료');
    assert.equal(s.inbox.get(2).status, '버림');
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0].chatId, OWNER);
  } finally { s.cleanup(); }
});

test('밀린 스위치: 위험해지는 방향(킬스위치 오프·체결모드 온·제안모드 온)만 다시 묻고, 브레이크 쪽은 늦어도 실행한다', async () => {
  const s = setup();
  try {
    const old = (T0 - STALE_COMMAND_MS - 60_000) / 1000;
    s.inbox.appendUpdates(['킬스위치 오프', '체결모드 온', '제안모드 온', '킬스위치 온', '체결모드 오프', '제안모드 오프']
      .map((text, i) => msg(i + 1, text, { date: old })));
    for (const item of s.inbox.pending()) await s.daemon.processItem(item);
    assert.deepEqual(s.tools.map((t) => t.args[0]), ['--text=킬스위치 온', '--text=체결모드 오프', '--text=제안모드 오프']);
    for (const id of [1, 2, 3]) assert.equal(s.inbox.get(id).detail, '오래된 스위치 명령 — 실행 안 함');
    assert.match(s.sent[0].body, /실행하지 않았습니다/);
  } finally { s.cleanup(); }
});

test('줄 나누기: 음성 전사가 오래 걸려도 그 뒤의 킬스위치는 main 줄에서 바로 처리된다', async () => {
  let releaseVoice;
  const voiceGate = new Promise((r) => { releaseVoice = r; });
  const order = [];
  const s = setup({
    runTool: async (tool, args) => {
      if (tool === 'inbox-memo.mjs' && args.includes('--json-out')) { order.push('음성 시작'); await voiceGate; order.push('음성 끝'); return '{"note":"n","text":"t"}'; }
      order.push(`${tool} ${args[0]}`);
      return '완료';
    },
  });
  try {
    s.inbox.appendUpdates([msg(1, { voice: { file_id: 'v' } }), msg(2, '킬스위치 온')]);
    const media = s.daemon.workerLoop('media');
    const main = s.daemon.workerLoop('main');
    for (let i = 0; i < 50 && s.inbox.get(2).status !== '완료'; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(s.inbox.get(2).status, '완료', '킬스위치가 음성 뒤에 묶이지 않음');
    assert.equal(s.inbox.get(1).status, '처리중');
    releaseVoice();
    for (let i = 0; i < 50 && s.inbox.get(1).status !== '완료'; i += 1) await new Promise((r) => setImmediate(r));
    s.daemon.stop();
    await Promise.all([media, main]);
    assert.equal(order.at(-1), '음성 끝');
    assert.ok(order.indexOf('kill-switch-cli.mjs --text=킬스위치 온') < order.indexOf('음성 끝'));
  } finally { s.cleanup(); }
});

test('시험 모드: 체결확인(외부 기록)은 실행하지 않고 스위치는 도구로 간다(볼트는 프로세스 단위로 시험 볼트)', async () => {
  const s = setup({ mode: 'test' });
  try {
    s.inbox.appendUpdates([msg(1, '체결확인 EC-20260929-ABC123 ISA'), msg(2, '킬스위치 온')]);
    for (const item of s.inbox.pending()) await s.daemon.processItem(item);
    assert.deepEqual(s.tools, [{ tool: 'kill-switch-cli.mjs', args: ['--text=킬스위치 온'] }]);
    assert.match(s.sent[0].body, /시험 모드라 실행하지 않았습니다/);
  } finally { s.cleanup(); }
});

test('시작: 처리 중 끊긴 건은 확인필요로 돌려 알린다(원문은 HTML 이스케이프)', async () => {
  const s = setup();
  try {
    s.inbox.appendUpdates([msg(1, '📜 <b>끊긴</b> 메모')]);
    s.inbox.markStatus(1, '처리중', 'memo');
    await s.daemon.announceRecovered();
    assert.equal(s.inbox.get(1).status, '확인필요');
    assert.equal(s.sent[0].topic, '확인 필요');
    assert.match(s.sent[0].body, /&lt;b&gt;끊긴/);
    assert.match(s.sent[0].body, /기록이 이미 남았을 수 있으니/);
  } finally { s.cleanup(); }
});

test('밀린 메시지 안내는 첫 수신 성공 직후 한 번(다운 중 서버에 쌓인 것 포함)', async () => {
  const old = (T0 - 60 * 60_000) / 1000;
  let calls = 0;
  const s = setup({
    getUpdates: async (daemon) => {
      calls += 1;
      if (calls === 1) return [msg(10, '상태', { date: old }), msg(11, '안녕', { date: old })];
      daemon.stop();
      return [];
    },
  });
  try {
    await s.daemon.pollLoop();
    const notices = s.sent.filter((m) => m.topic === '밀린 메시지');
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /2건/);
  } finally { s.cleanup(); }
});

test('수신 루프: 409 경보 1회(경고 원장 경로) 후 5분 연속 정상이어야 복구를 알린다', async () => {
  let calls = 0;
  const conflict = Object.assign(new Error('Conflict'), { conflict: true, errorCode: 409 });
  const s = setup({
    getUpdates: async (daemon, clock) => {
      calls += 1;
      if (calls <= 2) throw conflict;
      clock.ms += 60_000;
      if (calls === 3) return [msg(5, '상태')];
      if (calls >= 10) daemon.stop();
      return [];
    },
  });
  try {
    await s.daemon.pollLoop();
    assert.equal(s.warned.length, 1);
    assert.match(s.warned[0].body, /409/);
    assert.match(s.warned[0].body, /&lt;server&gt;/, 'pgrep 줄도 이스케이프');
    assert.deepEqual(s.sent.map((m) => m.topic), ['복구']);
    assert.equal(s.inbox.readOffset(), 6);
  } finally { s.cleanup(); }
});

test('수신 루프: 409와 성공이 번갈아 오면(가로채기) 경고·복구를 반복하지 않는다', async () => {
  let calls = 0;
  const conflict = Object.assign(new Error('Conflict'), { conflict: true, errorCode: 409 });
  const s = setup({
    getUpdates: async (daemon, clock) => {
      calls += 1;
      clock.ms += 30_000;
      if (calls >= 40) daemon.stop();
      if (calls % 2 === 1) throw conflict;
      return [];
    },
  });
  try {
    await s.daemon.pollLoop();
    assert.ok(s.warned.length <= 2, `경고 ${s.warned.length}회(30분 1회 이내여야 함)`);
    assert.equal(s.sent.filter((m) => m.topic === '복구').length, 0);
  } finally { s.cleanup(); }
});

test('수신 루프: 관문 내부 오류(저장 실패)는 Bot API 오류로 표기하지 않는다', async () => {
  let calls = 0;
  const s = setup({
    getUpdates: async (daemon) => {
      calls += 1;
      if (calls === 1) return [{ update_id: 1, message: null }];
      daemon.stop();
      return [];
    },
  });
  try {
    s.inbox.appendUpdates = () => { throw new Error('ENOSPC'); };
    await s.daemon.pollLoop();
    assert.match(s.warned[0].body, /관문 내부 오류/);
    assert.doesNotMatch(s.warned[0].body, /ENOSPC/, '오류 원문은 로그에만');
  } finally { s.cleanup(); }
});

test('허용 밖 발신자 원문은 대기열에 남기지 않는다', async () => {
  let calls = 0;
  const s = setup({
    getUpdates: async (daemon) => {
      calls += 1;
      if (calls === 1) return [msg(1, '비밀 내용', { from: '999' })];
      daemon.stop();
      return [];
    },
  });
  try {
    await s.daemon.pollLoop();
    assert.equal(JSON.stringify(s.inbox.get(1).update).includes('비밀 내용'), false);
    assert.equal(s.inbox.readOffset(), 2);
  } finally { s.cleanup(); }
});

test('감시견: 수신 진척이 한도를 넘거나 이벤트 루프가 2분 넘게 멈추면 이유를 돌려준다', () => {
  const s = setup();
  try {
    s.daemon.state.lastPollProgressAt = T0;
    s.daemon.state.lastTickAt = T0;
    assert.equal(s.daemon.watchdogCheck(T0 + 15_000), null);
    assert.match(s.daemon.watchdogCheck(T0 + POLL_STALL_MS + 30_000), /이벤트 루프 지연|수신 루프 진척 없음/);
    s.daemon.state.lastTickAt = T0 + POLL_STALL_MS + 40_000;
    assert.match(s.daemon.watchdogCheck(T0 + POLL_STALL_MS + 50_000), /수신 루프 진척 없음/);
  } finally { s.cleanup(); }
});

test('하트비트: 최근 3분 안에 수신 성공이면 healthy, 아니면 오류 사유', async () => {
  const s = setup();
  try {
    await s.daemon.heartbeat();
    assert.equal(s.beats[0].healthy, false);
    s.daemon.state.lastPollOkAt = new Date(T0 - 60_000).toISOString();
    await s.daemon.heartbeat();
    assert.equal(s.beats[1].healthy, true);
    assert.match(s.beats[1].detail, /수신 정상/);
  } finally { s.cleanup(); }
});

test('복구 확인 시간 상수는 5분', () => { assert.equal(RECOVERY_CONFIRM_MS, 5 * 60_000); });

test('gateSelfCheck: 수신 성공·claude 실행 파일·쿨다운을 본다', () => {
  const now = new Date(T0);
  const ok = gateSelfCheck({ state: { lastPollOkAt: new Date(T0 - 30_000).toISOString() }, now, claudeBin: '/x/claude', exists: () => true, cooldown: null });
  assert.deepEqual(ok, { ok: true, problems: [] });
  const bad = gateSelfCheck({ state: { lastPollOkAt: null }, now, claudeBin: '/x/claude', exists: () => false, cooldown: { resetAt: T0 + 3600_000 } });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 3);
});

test('종료 중 끊긴 도구: 답장하지 않고 처리중으로 남겨 재시작 때 확인필요 안내로 간다', async () => {
  let s;
  s = setup({ runTool: async () => { s.daemon.state.stopping = true; throw new Error('종료코드 null'); } });
  try {
    s.inbox.appendUpdates([msg(1, '📜 메모')]);
    await s.daemon.processItem(s.inbox.pending()[0]);
    assert.equal(s.inbox.get(1).status, '처리중');
    assert.equal(s.sent.length, 0, '종료 중 실패 답장 없음');
    const restarted = setup();
    try {
      const reopened = createGateInbox({ dir: s.dir });
      assert.deepEqual(reopened.recoverInterrupted().map((i) => i.updateId), [1]);
    } finally { restarted.cleanup(); }
  } finally { s.cleanup(); }
});

test('installExitCleanup: exit·처리 안 된 예외 때 도구 그룹을 SIGKILL로 정리한다', () => {
  const proc = new EventEmitter();
  const exits = [];
  proc.exit = (code) => exits.push(code);
  const kills = [];
  installExitCleanup({ proc, kill: (signal) => kills.push(signal), log: () => {} });
  proc.emit('exit', 1);
  assert.deepEqual(kills, ['SIGKILL']);
  proc.emit('uncaughtException', new Error('boom'));
  assert.deepEqual(kills, ['SIGKILL', 'SIGKILL']);
  assert.deepEqual(exits, [1]);
});

function fakeConversation() {
  const calls = { batches: [], confirms: [], closes: [], cancels: 0, queued: [] };
  let running = false;
  return {
    calls,
    state: { lastRun: null, lastRateLimit: null },
    isRunning: () => running,
    setRunning: (v) => { running = v; },
    cancel: () => { calls.cancels += 1; return running; },
    setQueued: (n) => calls.queued.push(n),
    processBatch: async (items) => { calls.batches.push(items.map((i) => i.args.text ?? i.args.caption)); return { status: '완료', detail: 'ok' }; },
    handleConfirm: async (args) => { calls.confirms.push(args.yes); return { status: '완료', detail: 'confirm' }; },
    closeConfirm: async (reason) => { calls.closes.push(reason); return false; },
    writeHandoffIfDue: async () => null,
    checkCooldownRelease: async () => { calls.cooldownChecks = (calls.cooldownChecks ?? 0) + 1; return false; },
  };
}

test('대화 줄: 쌓인 대화 입력을 합쳐 한 번에 처리하고(Q6), 결정론 입력은 섞지 않는다', async () => {
  const conv = fakeConversation();
  const s = setup({ conversation: conv });
  try {
    s.inbox.appendUpdates([msg(1, '내일 3시 치과'), msg(2, '킬스위치 온'), msg(3, '클리오 어제 뭐 했지'), msg(4, { photo: [{ file_id: 'p' }], caption: '이거 뭐야' })]);
    assert.equal(await s.daemon.processLlmBatch(), true);
    assert.deepEqual(conv.calls.batches, [['내일 3시 치과', '클리오 어제 뭐 했지', '이거 뭐야']]);
    assert.equal(s.inbox.get(2).status, '받음', '스위치는 main 줄 몫');
    for (const id of [1, 3, 4]) assert.equal(s.inbox.get(id).status, '완료');
    assert.equal(await s.daemon.processLlmBatch(), false);
  } finally { s.cleanup(); }
});

test('확인 대기 중: 응은 confirm으로, 상태·안녕은 대기를 유지, 다른 입력은 다른 주제로 닫는다', async () => {
  const conv = fakeConversation();
  let pending = true;
  // 확인 질문을 T0-60초에 보냈다 — msg() 기본 시각(T0)은 그 뒤다.
  const confirmStore = { pending: () => (pending ? { id: 'CF', announced: true, announcedAt: new Date(T0 - 60_000).toISOString() } : null) };
  const s = setup({ conversation: conv, confirmStore });
  try {
    s.inbox.appendUpdates([msg(1, '응'), msg(2, '상태'), msg(3, '📜 메모')]);
    await s.daemon.processItem(s.inbox.get(1));
    assert.deepEqual(conv.calls.confirms, [true]);
    await s.daemon.processItem(s.inbox.get(2));
    assert.deepEqual(conv.calls.closes, []);
    await s.daemon.processItem(s.inbox.get(3));
    assert.deepEqual(conv.calls.closes, ['다른 주제']);
    pending = false;
    s.inbox.appendUpdates([msg(4, '응')]);
    await s.daemon.processLlmBatch();
    assert.deepEqual(conv.calls.batches, [['응']], '확인 대기가 없으면 응은 그냥 대화');
  } finally { s.cleanup(); }
});

test('취소: 실행 중 대화를 멈추고, 취소 전부는 대기 중 대화 입력까지 버린다', async () => {
  const conv = fakeConversation();
  const s = setup({ conversation: conv });
  try {
    conv.setRunning(true);
    s.inbox.appendUpdates([msg(1, '하나'), msg(2, '둘'), msg(3, '취소 전부')]);
    await s.daemon.processItem(s.inbox.get(3));
    assert.equal(conv.calls.cancels, 1);
    assert.equal(s.inbox.get(1).detail, '취소 전부로 취소됨');
    assert.equal(s.inbox.get(2).status, '완료');
    assert.match(s.sent.at(-1).body, /기다리던 메시지 2건/);
    conv.setRunning(false);
    s.inbox.appendUpdates([msg(4, '취소')]);
    await s.daemon.processItem(s.inbox.get(4));
    assert.match(s.sent.at(-1).body, /취소할 대화 작업이 없습니다/);
  } finally { s.cleanup(); }
});

test('1분 틱: 확인 대기 만료와 인수인계 노트를 대화 줄에 맡긴다', async () => {
  const conv = fakeConversation();
  let handoffChecked = 0;
  conv.writeHandoffIfDue = async () => { handoffChecked += 1; return null; };
  const s = setup({ conversation: conv });
  try {
    await s.daemon.minuteTick();
    assert.deepEqual(conv.calls.closes, ['만료']);
    assert.equal(handoffChecked, 1);
  } finally { s.cleanup(); }
});

test('확인 질문 뒤 응보다 먼저 보낸 다른 입력이 대기 중이면, 응을 실행하지 않고 다른 주제로 닫는다', async () => {
  const conv = fakeConversation();
  const confirmStore = { pending: () => ({ id: 'CF', announced: true, announcedAt: new Date(T0 - 60_000).toISOString() }) };
  const s = setup({ conversation: conv, confirmStore });
  try {
    s.inbox.appendUpdates([msg(1, '그런데 하이닉스는?', { date: T0 / 1000 }), msg(2, '응', { date: T0 / 1000 + 1 })]);
    await s.daemon.processItem(s.inbox.get(2));
    assert.deepEqual(conv.calls.confirms, [], '응을 확인으로 쓰지 않음');
    assert.deepEqual(conv.calls.closes, ['다른 주제']);
  } finally { s.cleanup(); }
});

test('확인 질문 전에 보낸 대화가 늦게 처리돼도 확인 대기를 닫지 않는다', async () => {
  const conv = fakeConversation();
  const confirmStore = { pending: () => ({ id: 'CF', announced: true, announcedAt: new Date(T0 + 60_000).toISOString() }) };
  const s = setup({ conversation: conv, confirmStore });
  try {
    s.inbox.appendUpdates([msg(1, '고마워', { date: T0 / 1000 })]);
    await s.daemon.processLlmBatch();
    assert.deepEqual(conv.calls.closes, []);
    s.inbox.appendUpdates([msg(2, '다른 질문', { date: T0 / 1000 + 120 })]);
    await s.daemon.processLlmBatch();
    assert.deepEqual(conv.calls.closes, ['다른 주제']);
  } finally { s.cleanup(); }
});

test('확인 대기가 만료됐거나 없으면 "응"은 자유 문장(대화 줄)이고 실행기를 부르지 않는다', async () => {
  const conv = fakeConversation();
  let confirm = null;
  const confirmStore = { pending: () => confirm };
  const s = setup({ conversation: conv, confirmStore });
  try {
    s.inbox.appendUpdates([msg(1, '응')]);
    await s.daemon.processLlmBatch();
    assert.deepEqual(conv.calls.batches, [['응']]);
    assert.deepEqual(conv.calls.confirms, []);
    // 발표 전(announced 없음) 대기만 있을 때도 confirm이 아니다.
    confirm = { id: 'CF', announced: false };
    s.inbox.appendUpdates([msg(2, '응')]);
    await s.daemon.processLlmBatch();
    assert.deepEqual(conv.calls.confirms, []);
  } finally { s.cleanup(); }
});

test('약속: 1분 틱이 이행기를 돌리고, 약속 LLM은 대화 줄이 바쁘면 null(다음 점검)', async () => {
  const conv = fakeConversation();
  let ticks = 0;
  const promiseRunner = { tick: async () => { ticks += 1; return {}; }, summary: () => ({ pending: 2, nextAt: '2026-10-30T09:00:00Z' }), pendingForHandoff: () => [] };
  const s = setup({ conversation: conv });
  // promiseRunner는 setup이 받지 않으므로 데몬을 직접 만든다.
  const { createGateDaemon: make } = await import('./telegram-gate.mjs');
  const d = make({ gate: { mode: 'test', config: { chatId: '31337' }, allowFrom: new Set(['31337']), stateDir: s.dir }, inbox: s.inbox, api: {}, send: async () => {},
    now: () => new Date(T0), conversation: conv, promiseRunner, log: () => {} });
  try {
    await d.minuteTick();
    assert.equal(ticks, 1);
    assert.equal(conv.calls.cooldownChecks, 1);
    conv.setRunning(true);
    assert.equal(d.runPromiseLlm({ text: 'x' }, () => '조건'), null, '대화 중이면 다음 점검');
    conv.setRunning(false);
    const r = await d.runPromiseLlm({ text: '전사 끝' }, () => '잡 성공');
    assert.equal(r.status, '완료');
    assert.match(conv.calls.batches.at(-1)[0], /약속 이행 시점이다: 전사 끝\n조건 충족: 잡 성공/);
  } finally { s.cleanup(); }
});

// ── 실전 가드(2026-10-31 사고: `--help`가 무시되고 기본값 live로 떠 실제 봇을 2분 가져감) ──
// launch(실제 수신 시작 = getUpdates)가 몇 번 불렸는지로 "수신 0회"를 확인한다. 실제 봇·네트워크·launchctl·ps는 쓰지 않는다.
const LAUNCHD_PRINT = (pid) => `gui/501/com.banana2.telegram-gate = {\n\tactive count = 1\n\tstate = running\n\n\tprogram = /bin/bash\n${pid ? `\tpid = ${pid}\n` : ''}\tendpoints = {\n\t\tpid = 999\n\t}\n}`;

test('실전 가드: --help·모르는 인자·--mode 없음·live 가드 불통과면 수신을 시작하지 않는다', async () => {
  const { main, parseGateArgs, decideLiveStart } = await import('./telegram-gate.mjs');
  const self = { pid: process.pid, args: 'node scripts/jobs/telegram-gate.mjs --mode=live' };
  const parent = { pid: process.ppid, args: '/bin/bash /x/scripts/launchd/run.sh telegram-gate' };
  const session = { pid: 72497, args: '/Users/x/.local/bin/claude --channels plugin:telegram@claude-plugins-official' };
  const plugin = { pid: 72500, args: 'bun run --cwd /x/telegram --silent start' };
  const otherLive = { pid: 72600, args: '/opt/node/bin/node scripts/jobs/telegram-gate.mjs --mode=live' };
  const accidentHelp = { pid: 72601, args: 'node scripts/jobs/telegram-gate.mjs --help' }; // 이번 사고 형태(옛 코드면 실전)
  const accidentBare = { pid: 72602, args: 'node /x/scripts/jobs/telegram-gate.mjs' };
  const watchers = [
    { pid: 72700, args: 'pgrep -f claude.*--channels.*telegram' },
    { pid: 72701, args: '/bin/sh -c pgrep -f "claude.*--channels.*telegram"' },
    { pid: 72702, args: '/bin/zsh -c ps -axo pid,args | grep telegram-gate.mjs' },
    // Claude 세션 Bash 도구 래퍼가 명령 문자열에 관문·세션 이름을 담은 경우(실측 오탐)
    { pid: 72703, args: '/bin/zsh -c source /x/snapshot.sh && eval \'node scripts/jobs/telegram-gate.mjs --mode=live\'' },
    { pid: 72704, args: '/bin/bash -lc export CLAUDE_TELEGRAM_SESSION=1; claude --channels plugin:telegram' },
  ];
  const launchdOk = { loaded: true, pid: process.ppid };
  const run = async (argv, { env = {}, launchd = launchdOk, processes = [self, parent], second } = {}) => {
    const launched = [];
    const lines = [];
    const refusals = [];
    let selfTests = 0;
    let reads = 0;
    let waited = 0;
    const code = await main({ argv, env, out: { log: (l) => lines.push(l), error: (l) => lines.push(l) },
      liveChecks: () => { reads += 1; return { launchd, processes: reads > 1 && second ? second : processes }; },
      launch: async (mode) => { launched.push(mode); }, runSelfTest: () => { selfTests += 1; },
      wait: async (ms) => { waited += ms; }, recordRefusal: (d) => refusals.push(d.reasons.map((r) => r.code)) });
    return { code, launched, text: lines.join('\n'), selfTests, refusals, waited };
  };
  const cutover = { TELEGRAM_GATE_LIVE_CUTOVER: '1' };

  for (const argv of [['--help'], ['-h'], ['--mode=test', '--help']]) {
    const r = await run(argv);
    assert.deepEqual([r.code, r.launched], [0, []], argv.join(' '));
    assert.match(r.text, /사용법/);
  }
  for (const argv of [[], ['--verbose'], ['--mode'], ['--mode=prod'], ['--mode=test', '--mode=live'], ['--mode=test', 'extra'], ['--self-test', '--mode=live']]) {
    const r = await run(argv, { env: cutover });
    assert.deepEqual([r.code, r.launched], [2, []], JSON.stringify(argv));
    assert.match(r.text, /사용법/);
  }
  // live: 하나라도 어긋나면 거부 — exit 0(launchd가 다시 띄우지 않게), 수신 0회, 사유는 'LIVE_REFUSED 코드'로 시작하는 한 줄
  for (const [label, opts, code] of [
    ['환경변수 없음', {}, 'NO_CUTOVER_FLAG'],
    ['plist 미등록', { env: cutover, launchd: { loaded: false, pid: null } }, 'NOT_LOADED'],
    ['터미널에서 띄움(launchd pid가 다른 프로세스)', { env: cutover, launchd: { loaded: true, pid: 4242 } }, 'NOT_LAUNCHD'],
    ['등록만 되고 안 도는 상태에서 터미널 실행', { env: cutover, launchd: { loaded: true, pid: null } }, 'NOT_LAUNCHD'],
    ['상시 세션 살아 있음', { env: cutover, processes: [self, parent, session] }, 'RIVAL'],
    ['플러그인 폴러 살아 있음', { env: cutover, processes: [self, parent, plugin] }, 'RIVAL'],
    ['다른 실전 관문 살아 있음', { env: cutover, processes: [self, parent, otherLive] }, 'RIVAL'],
    ['사고 형태: --help로 뜬 옛 관문', { env: cutover, processes: [self, parent, accidentHelp] }, 'RIVAL'],
    ['사고 형태: 인자 없이 뜬 옛 관문', { env: cutover, processes: [self, parent, accidentBare] }, 'RIVAL'],
    ['프로세스 표 비어 있음', { env: cutover, processes: [] }, 'PS_UNREADABLE'],
    ['프로세스 표에 자기 자신이 없음', { env: cutover, processes: [{ pid: 1, args: '/sbin/launchd' }] }, 'PS_UNREADABLE'],
  ]) {
    const r = await run(['--mode=live'], opts);
    assert.deepEqual([r.code, r.launched], [0, []], label);
    assert.match(r.text, new RegExp(`^LIVE_REFUSED .*${code}`), label);
    assert.equal(r.text.split('\n').length, 1, `${label}: 사유는 한 줄(run.sh가 끝 줄을 JobHealth detail로)`);
    // 상태 파일은 launchd가 띄운 관문의 거부만 남긴다(터미널 실행이 실전 관문 하트비트를 덮지 않게)
    assert.equal(r.refusals.length, ['NOT_LOADED', 'NOT_LAUNCHD'].includes(code) ? 0 : 1, label);
  }
  // 경쟁자만 걸리면 1초 뒤 다시 읽어, 두 번 다 걸릴 때만 거부(잠깐 스친 프로세스로 재시작 없는 정지 방지)
  const transient = await run(['--mode=live'], { env: cutover, processes: [self, parent, session], second: [self, parent] });
  assert.deepEqual([transient.launched, transient.waited], [['live'], 1000]);
  const persistent = await run(['--mode=live'], { env: cutover, processes: [self, parent, session] });
  assert.deepEqual([persistent.launched, persistent.waited], [[], 1000]);
  assert.equal((await run(['--mode=live'])).waited, 0, '경쟁자 아닌 사유는 다시 읽지 않는다');
  // 통과: 감시 명령 줄(맨 앞이든 sh -c·zsh -c 래퍼 안이든)은 경쟁자가 아니다. launchd pid가 자기 자신이어도 통과.
  assert.deepEqual((await run(['--mode=live'], { env: cutover, processes: [self, parent, ...watchers] })).launched, ['live']);
  assert.deepEqual((await run(['--mode=live'], { env: cutover, launchd: { loaded: true, pid: process.pid } })).launched, ['live']);
  assert.deepEqual((await run(['--mode=test'])).launched, ['test'], '시험 모드는 실전 가드와 무관');
  const selfTest = await run(['--self-test']);
  assert.deepEqual([selfTest.code, selfTest.launched, selfTest.selfTests], [0, [], 1]);

  // 실행 파일 기준: 버전 경로 claude·node 플러그인·bun 관문도 경쟁자, 인자에 grep 단어가 있는 진짜 세션도 경쟁자(재리뷰 2차 L1~L3)
  for (const rival of [
    { pid: 72800, args: '/Users/x/.local/share/claude/versions/2.1.314 --channels plugin:telegram@claude-plugins-official' },
    { pid: 72801, args: 'node /Users/x/.claude/plugins/cache/claude-plugins-official/telegram/0.0.9/server.ts' },
    { pid: 72802, args: 'bun scripts/jobs/telegram-gate.mjs' },
    { pid: 72803, args: 'node22 scripts/jobs/telegram-gate.mjs --mode=live' },
    { pid: 72804, args: 'claude --channels plugin:telegram --name "ps grep 메모"' },
  ]) {
    const r = await run(['--mode=live'], { env: cutover, processes: [self, parent, rival] });
    assert.deepEqual(r.launched, [], rival.args);
    assert.match(r.text, /RIVAL/, rival.args);
  }

  assert.deepEqual(parseGateArgs(['--mode=live']), { action: 'run', mode: 'live' });
  assert.equal(decideLiveStart({ env: cutover, launchd: { loaded: true, pid: 4 }, selfPid: 5, parentPid: 4,
    processes: [{ pid: 5, args: 'node scripts/jobs/telegram-gate.mjs --mode=live' }, { pid: 6, args: 'node scripts/jobs/telegram-gate.mjs --mode=test' },
      { pid: 7, args: 'node scripts/jobs/telegram-gate.mjs --self-test' }] }).ok, true,
  '관문 자신·시험 관문(다른 봇)·자가 점검은 경쟁자가 아니다');
});

test('실전 가드: launchctl print의 최상위 pid만 읽고, 확인 함수는 실패하면 막는 쪽', async () => {
  const { parseLaunchdPid, readLaunchdGate, readProcessTableSafe, decideLiveStart } = await import('./telegram-gate.mjs');
  assert.equal(parseLaunchdPid(LAUNCHD_PRINT(439)), 439);
  assert.equal(parseLaunchdPid(LAUNCHD_PRINT(null)), null, '중첩된 pid 줄(탭 둘)은 읽지 않는다');
  assert.deepEqual(readLaunchdGate({ uid: 501, run: () => ({ status: 0, stdout: LAUNCHD_PRINT(439) }) }), { loaded: true, pid: 439 });
  assert.deepEqual(readLaunchdGate({ uid: 501, run: () => ({ status: 113, stdout: '' }) }), { loaded: false, pid: null }, '미등록');
  assert.deepEqual(readLaunchdGate({ uid: 501, run: () => ({ status: null, error: new Error('ETIMEDOUT') }) }), { loaded: false, pid: null }, '시간 초과');
  assert.deepEqual(readLaunchdGate({ uid: 501, run: () => { throw new Error('spawn 실패'); } }), { loaded: false, pid: null });
  assert.deepEqual(readLaunchdGate({ uid: null }), { loaded: false, pid: null });
  const table = readProcessTableSafe({ read: () => { throw new Error('ps 실패'); } });
  assert.deepEqual(table, []);
  assert.deepEqual(decideLiveStart({ env: { TELEGRAM_GATE_LIVE_CUTOVER: '1' }, launchd: { loaded: true, pid: 1 }, processes: table, selfPid: 1 })
    .reasons.map((r) => r.code), ['PS_UNREADABLE']);
});

test('실전 가드: run.sh는 --mode=live로 부르고 detail을 문자 단위로 자른다, plist는 비정상 종료만 다시 띄운다', { skip: process.platform !== 'darwin' && 'plutil은 macOS 전용' }, async () => {
  const { readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const runSh = readFileSync(new URL('../launchd/run.sh', import.meta.url), 'utf8');
  assert.match(runSh, /telegram-gate\) CMD=\(scripts\/jobs\/telegram-gate\.mjs --mode=live\)/);
  assert.match(runSh, /LC_ALL=en_US\.UTF-8 cut -c1-200/);
  const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', new URL('../launchd/com.banana2.telegram-gate.plist', import.meta.url).pathname], { encoding: 'utf8' }));
  assert.deepEqual(plist.KeepAlive, { SuccessfulExit: false });
  assert.equal(plist.EnvironmentVariables?.TELEGRAM_GATE_LIVE_CUTOVER, undefined, '전환 플래그는 4단계에서만 넣는다');
});

test('실전 가드: 거부 기록은 heartbeat.json이 아니라 refusal.json, 상태 폴더가 없으면 만들지 않는다', async (t) => {
  const { writeRefusalRecord } = await import('./telegram-gate.mjs');
  const { mkdtempSync, rmSync, existsSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'gate-refusal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const decision = { reasons: [{ code: 'RIVAL', text: 'x' }] };
  const missing = join(root, 'none');
  assert.equal(writeRefusalRecord(decision, { env: { TELEGRAM_GATE_STATE_DIR: missing } }), false);
  assert.equal(existsSync(missing), false, '없는 상태 폴더를 만들지 않는다(바깥 감시의 폴더 없음 보호)');
  assert.equal(writeRefusalRecord(decision, { env: { TELEGRAM_GATE_STATE_DIR: root }, now: () => new Date('2026-11-07T01:00:00Z'), pid: 7 }), true);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'refusal.json'), 'utf8')), { at: '2026-11-07T01:00:00.000Z', codes: ['RIVAL'], detail: 'LIVE_REFUSED RIVAL', pid: 7, mode: 'live' });
  assert.equal(existsSync(join(root, 'heartbeat.json')), false, '하트비트는 건드리지 않는다');
});
