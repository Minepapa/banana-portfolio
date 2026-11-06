import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLiveClaude, createLivePool, interruptLine, userMessageLine } from './telegram-gate-live.mjs';
import { buildGateClaudeArgs } from './telegram-gate-llm.mjs';

// claude는 가짜 프로세스다. stdin에 들어온 줄을 보고 script(child, msg)가 stdout 이벤트를 낸다. 실제 claude·사용량을 쓰지 않는다.
const line = (obj) => `${JSON.stringify(obj)}\n`;
function fakeSpawn(script = () => {}) {
  const record = { spawns: [], writes: [], killed: [] };
  const spawnImpl = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = undefined; // process.kill(-pid) 대신 child.kill 경로
    child.kill = (signal) => { record.killed.push(signal); setImmediate(() => child.emit('close', null)); };
    child.stdin = {
      write: (text) => { record.writes.push(JSON.parse(text)); setImmediate(() => script(child, JSON.parse(text))); return true; },
      end: () => { record.ended = true; },
    };
    record.spawns.push({ bin, args, opts });
    return child;
  };
  return { spawnImpl, record };
}
const answer = (child, structured) => {
  child.stdout.emit('data', line({ type: 'system', subtype: 'init', session_id: 'S1' }));
  child.stdout.emit('data', line({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(structured), structured_output: structured, permission_denials: [] }));
};
// 가짜 타이머: 걸어 둔 것을 손으로 실행한다.
function fakeTimers() {
  const timers = [];
  return { timers, setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.cleared = true; },
    fire: (ms) => { for (const t of timers.filter((x) => x.ms === ms && !x.cleared)) { t.cleared = true; t.fn(); } } };
}

test('상시 인자: 프롬프트 없이 -p --input-format stream-json, 나머지 보장(도구·MCP·스키마·dontAsk)은 그대로', () => {
  const args = buildGateClaudeArgs({ streamInput: true, sessionId: 'S', resume: false, allowedTools: ['Read'] });
  assert.deepEqual(args.slice(0, 3), ['-p', '--input-format', 'stream-json']);
  for (const f of ['--json-schema', '--strict-mcp-config', '--settings', '--session-id']) assert.ok(args.includes(f), f);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.throws(() => buildGateClaudeArgs({ sessionId: 'S', allowedTools: [] }), /prompt/);
  assert.match(userMessageLine('안녕'), /"type":"user".*"text":"안녕"/);
  assert.match(interruptLine('r1'), /"subtype":"interrupt"/);
});

test('한 프로세스로 여러 턴: 메시지는 stdin 한 줄, 턴마다 result로 끝나고 구조화 출력·세션을 돌려준다', async () => {
  const { spawnImpl, record } = fakeSpawn((child, msg) => { if (msg.type === 'user') answer(child, { messages: [{ text: msg.message.content[0].text }] }); });
  const live = createLiveClaude({ args: ['-p'], env: { CLAUDE_TELEGRAM_GATE: '1' }, spawnImpl, claudeBin: '/c', cooldownWriter: () => {} });
  const events = [];
  const r1 = await live.turn({ text: '첫째', onEvent: (e) => events.push(e.type) }).promise;
  const r2 = await live.turn({ text: '둘째' }).promise;
  assert.equal(record.spawns.length, 1, '한 번만 띄운다');
  assert.equal(record.spawns[0].opts.detached, true);
  assert.equal(record.spawns[0].opts.env.CLAUDE_TELEGRAM_GATE, '1');
  assert.deepEqual(r1.structured, { messages: [{ text: '첫째' }] });
  assert.deepEqual(r2.structured, { messages: [{ text: '둘째' }] });
  assert.equal(r1.sessionId, 'S1');
  assert.equal(r1.isError, false);
  assert.deepEqual(events, ['system', 'result']);
  assert.equal(live.busy(), false);
  assert.equal(live.alive(), true);
});

test('턴 중에 다른 턴은 거절한다(직렬)', () => {
  const { spawnImpl } = fakeSpawn();
  const live = createLiveClaude({ args: [], env: {}, spawnImpl, claudeBin: '/c', cooldownWriter: () => {} });
  live.turn({ text: 'a' });
  assert.throws(() => live.turn({ text: 'b' }), /진행 중인 턴/);
});

test('취소: 중단 요청을 넣고, 중단 결과(error_during_execution)는 오류가 아니라 취소다. 프로세스는 살아 다음 턴을 받는다', async () => {
  const { spawnImpl, record } = fakeSpawn((child, msg) => {
    if (msg.type === 'control_request') {
      child.stdout.emit('data', line({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } }));
      child.stdout.emit('data', line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' }));
    }
  });
  const t = fakeTimers();
  const live = createLiveClaude({ args: [], env: {}, spawnImpl, claudeBin: '/c', cooldownWriter: () => {}, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const handle = live.turn({ text: '긴 일' });
  handle.cancel();
  const res = await handle.promise;
  assert.equal(res.interrupted, 'cancel');
  assert.equal(res.isError, false);
  assert.deepEqual(record.killed, [], '중단 요청이 통하면 죽이지 않는다');
  assert.equal(record.writes[1].request.subtype, 'interrupt');
  assert.equal(live.alive(), true);
});

test('중단 요청이 유예 안에 안 통하면 프로세스 그룹을 죽이고, 시간 초과도 같은 길(interrupted=timeout)', async () => {
  const { spawnImpl, record } = fakeSpawn(() => {});
  const t = fakeTimers();
  const live = createLiveClaude({ args: [], env: {}, spawnImpl, claudeBin: '/c', cooldownWriter: () => {}, setTimer: t.setTimer, clearTimer: t.clearTimer, interruptGraceMs: 7 });
  const handle = live.turn({ text: '멈추지 않는 일', hardTimeoutMs: 99 });
  t.fire(99); // 하드 타임아웃 → 중단 요청
  assert.equal(record.writes.at(-1).request.subtype, 'interrupt');
  t.fire(7); // 유예 끝 → SIGTERM
  const res = await handle.promise;
  assert.equal(res.interrupted, 'timeout');
  assert.deepEqual(record.killed, ['SIGTERM']);
  assert.equal(live.alive(), false);
});

test('턴 중에 프로세스가 죽으면 그 턴은 오류(stderr 끝줄)로 끝나고, 한도 문구면 쿨다운을 남긴다', async () => {
  const cooldowns = [];
  const { spawnImpl } = fakeSpawn((child) => { child.stderr.emit('data', "a\nYou've hit your limit · resets 10:50am (Asia/Seoul)"); child.emit('close', 1); });
  const live = createLiveClaude({ args: [], env: {}, spawnImpl, claudeBin: '/c', cooldownWriter: (at) => cooldowns.push(at), now: () => Date.parse('2026-11-06T00:00:00Z') });
  const res = await live.turn({ text: 'x' }).promise;
  assert.equal(res.isError, true);
  assert.equal(res.processDied, true);
  assert.match(res.errorText, /hit your limit/);
  assert.equal(cooldowns.length, 1);
  const again = await live.turn({ text: 'y' }).promise;
  assert.equal(again.isError, true, '죽은 프로세스에 다시 넣지 않는다');
});

test('막힌 rate_limit_event는 쿨다운을 기록한다', async () => {
  const cooldowns = [];
  const { spawnImpl } = fakeSpawn((child) => {
    child.stdout.emit('data', line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793346000, rateLimitType: 'five_hour' } }));
    child.stdout.emit('data', line({ type: 'result', subtype: 'success', is_error: true, result: 'limit' }));
  });
  const live = createLiveClaude({ args: [], env: {}, spawnImpl, claudeBin: '/c', cooldownWriter: (at) => cooldowns.push(at) });
  const res = await live.turn({ text: 'x' }).promise;
  assert.deepEqual(cooldowns, [1793346000000]);
  assert.equal(res.isError, true);
});

// 풀: 가짜 상시 프로세스.
function fakeLive(meta, log) {
  let alive = true;
  let busy = false;
  let last = 0;
  const p = {
    meta, closed: null,
    alive: () => alive, busy: () => busy, lastActivityAt: () => last, pid: () => 1,
    turn: () => { busy = true; return { promise: Promise.resolve({}).then(() => { busy = false; }), cancel: () => {} }; },
    close: (reason) => { alive = false; p.closed = reason; log.push(`${meta.key}:${reason}`); },
    setLast: (v) => { last = v; }, kill: () => { alive = false; },
  };
  return p;
}

test('풀: 같은 날·같은 세션은 재사용, 세션·날짜가 바뀌거나 죽었으면 새로 띄운다', async () => {
  const log = [];
  const spawned = [];
  const pool = createLivePool({ spawnLive: ({ meta }) => { const p = fakeLive(meta, log); spawned.push(p); return p; } });
  const base = { key: 'zeus', day: '2026-11-06', sessionId: 'S1', args: [], env: {}, text: 'x' };
  assert.equal(pool.turn(base).spawned, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(pool.turn(base).spawned, false);
  await new Promise((r) => setImmediate(r));
  assert.equal(pool.turn({ ...base, sessionId: 'S2' }).spawned, true, '세션이 바뀌면 새로');
  await new Promise((r) => setImmediate(r));
  spawned.at(-1).kill();
  assert.equal(pool.turn({ ...base, sessionId: 'S2' }).spawned, true, '죽었으면 새로(--resume 인자는 호출부가 만든다)');
  assert.deepEqual(log, ['zeus:세션·날짜 바뀜', 'zeus:죽은 프로세스 정리']);
  assert.throws(() => pool.turn({ ...base, sessionId: 'S2' }), /진행 중인 턴/, '턴 중에는 같은 키에 넣지 않는다');
});

test('풀: 동시에 최대 3개(제우스 포함), 넘으면 가장 오래 쉰 것을 닫고, 30분 무활동·업무일 바뀜은 1분 점검에서 닫는다', async () => {
  const log = [];
  const procs = {};
  let clock = 0;
  const pool = createLivePool({ spawnLive: ({ meta }) => { const p = fakeLive(meta, log); procs[meta.key] = p; return p; }, now: () => clock, maxProcesses: 3, idleMs: 30 * 60_000 });
  const t = (key, day = '2026-11-06') => pool.turn({ key, day, sessionId: `S-${key}`, args: [], env: {}, text: 'x' });
  t('zeus'); procs.zeus.setLast(30);
  t('hermes'); procs.hermes.setLast(10);
  t('plutus'); procs.plutus.setLast(20);
  await new Promise((r) => setImmediate(r));
  t('athena');
  assert.deepEqual(log, ['hermes:동시 실행 한도'], '가장 오래 쉰 헤르메스를 닫는다');
  await new Promise((r) => setImmediate(r));
  assert.equal(pool.list().length, 3);
  clock = 30 * 60_000 + 30;
  procs.athena.setLast(clock);
  pool.sweep({ day: '2026-11-06' });
  assert.deepEqual(log.slice(1).sort(), ['plutus:30분 무활동', 'zeus:30분 무활동']);
  pool.sweep({ day: '2026-11-07' });
  assert.equal(log.at(-1), 'athena:업무일 바뀜');
  assert.equal(pool.list().length, 0);
});
