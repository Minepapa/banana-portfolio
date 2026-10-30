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

function setup({ mode = 'live', getUpdates = null, runTool = null } = {}) {
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
