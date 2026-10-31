import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStatusBody, createGateHandlers, describeWikiResult, runGateTool, GATE_TOOLS } from './telegram-gate-handlers.mjs';

// 도구 실행·발송·Bot API는 전부 가짜다. 실제 도구·볼트·텔레그램을 건드리지 않는다.
function setup(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-handlers-'));
  const replies = [];
  const reactions = [];
  const toolCalls = [];
  const deps = {
    reply: async (agent, topic, body) => { replies.push({ agent, topic, body }); },
    react: async (emoji) => { reactions.push(emoji); },
    runTool: async (tool, args, opts = {}) => { toolCalls.push({ tool, args, input: opts.input ?? null }); return overrides.toolOut ?? '기록함: 00_Inbox/x'; },
    telegram: {
      getFile: async (fileId) => ({ file_id: fileId, file_unique_id: 'uniq/../1', file_path: 'photos/a.jpg' }),
      download: async () => Buffer.from('img'),
    },
    wiki: overrides.wiki ?? { resolve: async () => ({ action: 'approve', kind: 'note', status: '승인' }), apply: async () => ({ status: '반영' }) },
    selfCheck: overrides.selfCheck ?? (async () => ({ ok: true, problems: [] })),
    status: async () => ({ startedAt: 0, now: 3_600_000, lastPollOkAt: '2026-10-30T05:00:00Z', counts: { 받음: 1 }, cooldown: null, freeMemPct: 13, mode: 'test' }),
    mediaDir: join(dir, 'media'),
    now: () => new Date('2026-10-30T05:00:00Z'),
    ...overrides.deps,
  };
  return { handle: createGateHandlers(deps), replies, reactions, toolCalls, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('안녕: 😎 → 점검 통과면 😘, 텍스트 답 없음', async () => {
  const s = setup();
  try {
    assert.equal((await s.handle('greeting')).status, '완료');
    assert.deepEqual(s.reactions, ['😎', '😘']);
    assert.equal(s.replies.length, 0);
  } finally { s.cleanup(); }
});

test('안녕: 점검 실패면 😘 대신 무엇이 안 되는지 짧게 답한다', async () => {
  const s = setup({ selfCheck: async () => ({ ok: false, problems: ['사용량 한도 쿨다운 중'] }) });
  try {
    await s.handle('greeting');
    assert.deepEqual(s.reactions, ['😎']);
    assert.equal(s.replies[0].agent, 'zeus');
    assert.match(s.replies[0].body, /사용량 한도 쿨다운 중/);
  } finally { s.cleanup(); }
});

test('스위치: 원문을 --text로 넘기고, 체결모드 온은 실제 주문 경고를 붙인다', async () => {
  const s = setup({ toolOut: '체결모드: 실전' });
  try {
    await s.handle('switch', { tool: 'execution-mode-cli.mjs', text: '체결모드 온', live: true });
    assert.deepEqual(s.toolCalls[0], { tool: 'execution-mode-cli.mjs', args: ['--text=체결모드 온'], input: null });
    assert.match(s.replies[0].body, /실제 KIS 주문/);
    await s.handle('switch', { tool: 'kill-switch-cli.mjs', text: '킬스위치 온' });
    assert.doesNotMatch(s.replies[1].body, /실제 KIS 주문/);
  } finally { s.cleanup(); }
});

test('📜·🪶·장소·체결확인: 기존 도구에 원문 JSON/인자를 그대로 넘기고 담당 헤더로 답한다', async () => {
  const s = setup();
  try {
    await s.handle('memo', { text: '따옴표 " 와 $(rm) 그대로' });
    await s.handle('oneLine', { text: '좋은 하루' });
    await s.handle('place', { here: true, name: '회사' });
    await s.handle('execConfirm', { id: 'EC-20260929-ABC123', account: 'ISA' });
    assert.deepEqual(s.toolCalls.map((c) => c.tool), ['inbox-memo.mjs', 'daily-owner-input.mjs', 'place-register.mjs', 'resolve-execution-confirmation.mjs']);
    assert.deepEqual(JSON.parse(s.toolCalls[0].input), { text: '따옴표 " 와 $(rm) 그대로' });
    assert.deepEqual(JSON.parse(s.toolCalls[1].input), { kind: '한줄', text: '좋은 하루' });
    assert.deepEqual(JSON.parse(s.toolCalls[2].input), { here: true, name: '회사' });
    assert.deepEqual(s.toolCalls[3].args, ['--id=EC-20260929-ABC123', '--account=ISA']);
    assert.deepEqual(s.replies.map((r) => `${r.agent}/${r.topic}`), ['clio/기록', 'clio/데일리', 'hermes/장소 등록', 'plutus/체결 확인']);
  } finally { s.cleanup(); }
});

test('🪶: 도구 출력(진행 로그·파일 경로)을 그대로 보내지 않고 고정 문구로 답한다(2026-10-31 시험 봇 실측)', async () => {
  const s = setup({ toolOut: '[daily-note] prepare 2026-10-31 — 기록 1개\n  💾 10_Periodic/Daily/2026/2026-10-31.md (초안)\n오늘 한 줄 저장(2026-10-31)' });
  try {
    const result = await s.handle('oneLine', { text: '좋은 하루' });
    assert.equal(s.replies[0].body, '🪶 오늘 한 줄을 저장했습니다(2026-10-31).');
    assert.doesNotMatch(s.replies[0].body, /daily-note|💾|10_Periodic/);
    assert.match(result.detail, /오늘 한 줄 저장/, '원문은 기록 detail에만');
  } finally { s.cleanup(); }
  const t = setup({ toolOut: '예상과 다른 출력' });
  try {
    await t.handle('oneLine', { text: 'x' });
    assert.equal(t.replies[0].body, '🪶 오늘 한 줄을 저장했습니다.');
  } finally { t.cleanup(); }
  // 같은 날 두 번째 🪶: 도구가 붙이는 덮어쓰기 알림을 살린다(리뷰 M1).
  const u = setup({ toolOut: '[daily-note] prepare 2026-10-31\n오늘 한 줄 저장(2026-10-31) — 이전 한 줄을 바꿈' });
  try {
    await u.handle('oneLine', { text: '다시' });
    assert.equal(u.replies[0].body, '🪶 오늘 한 줄을 저장했습니다(2026-10-31). (이전 한 줄을 바꿨습니다)');
  } finally { u.cleanup(); }
});

test('📎 사진 메모: 사진을 관문 media 폴더에 받아 photoPath로 넘긴다(파일명은 안전한 문자만)', async () => {
  const s = setup();
  try {
    await s.handle('photoMemo', { fileId: 'big', text: '공원' });
    const input = JSON.parse(s.toolCalls[0].input);
    assert.equal(input.kind, '사진메모');
    assert.equal(input.text, '공원');
    assert.ok(input.photoPath.startsWith(join(s.dir, 'media')));
    const [file] = readdirSync(join(s.dir, 'media'));
    assert.match(file, /^\d+-uniq____1\.jpg$/);
    assert.equal(readFileSync(input.photoPath, 'utf8'), 'img');
  } finally { s.cleanup(); }
});

test('음성: 전사 결과 JSON을 읽어 전사 원문을 보여 준다', async () => {
  const s = setup({ toolOut: '{"note":"00_Inbox/음성.md","text":"내일 우유 사기","durationSec":4}' });
  try {
    await s.handle('voice', { fileId: 'v', caption: '' });
    const input = JSON.parse(s.toolCalls[0].input);
    assert.equal(input.kind, '음성');
    assert.deepEqual(s.toolCalls[0].args, ['--json=-', '--json-out']);
    assert.match(s.replies[0].body, /이렇게 들었습니다:\n내일 우유 사기/);
  } finally { s.cleanup(); }
});

test('도구 실패: 원인을 그대로 알리고 실패로 끝낸다(다시 시도 없음)', async () => {
  const s = setup({ deps: { runTool: async () => { throw new Error('처리하지 않음: 대기 건 없음'); } } });
  try {
    const result = await s.handle('execConfirm', { id: 'EC-20260929-ABC123', account: 'ISA' });
    assert.equal(result.status, '실패');
    assert.equal(s.replies.length, 1);
    assert.equal(s.replies[0].agent, 'plutus');
    assert.match(s.replies[0].body, /대기 건 없음/);
  } finally { s.cleanup(); }
});

test('위키 답: 결과마다 한 줄, 키워드 등록 승인은 반영까지', async () => {
  const applied = [];
  const s = setup({
    wiki: {
      resolve: async (id) => (id.endsWith('1') ? { action: 'approve', kind: 'keyword-registration', status: '승인' } : { action: 'clarify' }),
      apply: async (id) => { applied.push(id); return { status: '반영완료' }; },
    },
  });
  try {
    await s.handle('wiki', { answers: [{ questionId: 'WQ-20261030-00000001', answer: '등록', rawText: 'x' }, { questionId: 'WQ-20261030-00000002', answer: '음', rawText: 'y' }] });
    assert.deepEqual(applied, ['WQ-20261030-00000001']);
    const lines = s.replies[0].body.split('\n');
    assert.match(lines[0], /반영했습니다\(상태 반영완료\)/);
    assert.match(lines[1], /선택이 분명하지 않아/);
  } finally { s.cleanup(); }
});

test('describeWikiResult: 이미 처리·만료·수동 변경 승인·반영 실패', () => {
  assert.match(describeWikiResult('Q', { action: 'expired' }), /기록하지 않았습니다/);
  assert.match(describeWikiResult('Q', { action: 'approve', kind: 'manual-change', status: '반영대기' }), /반영대기/);
  assert.match(describeWikiResult('Q', { action: 'approve' }, null, new Error('잠금')), /자동 반영이 실패.*잠금/);
});

test('llm route(1단계): 고정 안내만 하고 도구를 부르지 않는다', async () => {
  const s = setup();
  try {
    await s.handle('llm', { kind: 'text', text: '아무 말' });
    assert.equal(s.toolCalls.length, 0);
    assert.match(s.replies[0].body, /2단계/);
  } finally { s.cleanup(); }
});

test('상태 표: <pre> 안 한 줄 44칸(한글 2칸) 이내, HTML 이스케이프', () => {
  const body = buildStatusBody({ startedAt: 0, now: 3 * 86_400_000 + 7_200_000, lastPollOkAt: '2026-10-30T05:02:00Z', counts: { 받음: 2, 처리중: 1, 확인필요: 1 }, cooldown: null, freeMemPct: 13, mode: 'test' });
  assert.match(body, /^<pre>[\s\S]*<\/pre>$/);
  const width = (line) => [...line].reduce((w, ch) => w + (/[ᄀ-ￜ]/.test(ch) ? 2 : 1), 0);
  for (const line of body.replace(/<\/?pre>/g, '').split('\n')) assert.ok(width(line) <= 44, `${line} (${width(line)}칸)`);
  assert.match(body, /가동 3일 2시간 · 시험/);
  assert.match(body, /14:02 · 밀린 것 3/);
});

test('runGateTool: 허용 목록 밖 도구는 실행하지 않는다', async () => {
  await assert.rejects(runGateTool('place-nh-direct-order.mjs', []), /허용 목록에 없는 도구/);
  assert.equal(GATE_TOOLS.some((t) => /order|breakout|execute/.test(t)), false, '돈 도구는 1단계 관문 결정론 목록에 없다');
});

test('runGateTool: 관문 env(GATE=1)로 node 도구를 띄우고 표준입력에 JSON을 쓴다', async () => {
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let written = '';
    child.stdin = { on() {}, end(data) { written = data; setImmediate(() => { child.stdout.emit('data', 'ok\n'); child.emit('close', 0); }); } };
    child.kill = () => {};
    spawned.push({ cmd, args, opts, get written() { return written; } });
    return child;
  };
  const out = await runGateTool('inbox-memo.mjs', ['--json=-'], { input: '{"text":"a"}', env: { CLAUDE_TELEGRAM_GATE: '1' }, spawnImpl });
  assert.equal(out, 'ok');
  assert.equal(spawned[0].cmd, process.execPath);
  assert.match(spawned[0].args[0], /scripts\/tools\/inbox-memo\.mjs$/);
  assert.equal(spawned[0].opts.env.CLAUDE_TELEGRAM_GATE, '1');
  assert.equal(spawned[0].written, '{"text":"a"}');
});

test('runGateTool: 기본 env는 buildGateSpawnEnv(상시 세션 변수·봇 토큰 없음)', async () => {
  let seenEnv = null;
  const saved = { s: process.env.CLAUDE_TELEGRAM_SESSION, t: process.env.TELEGRAM_BOT_TOKEN };
  process.env.CLAUDE_TELEGRAM_SESSION = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'FAKE:leak';
  try {
    const spawnImpl = (cmd, args, opts) => {
      seenEnv = opts.env;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { on() {}, end() { setImmediate(() => child.emit('close', 0)); } };
      child.kill = () => {};
      return child;
    };
    await runGateTool('kill-switch-cli.mjs', ['--text=x'], { spawnImpl });
  } finally {
    for (const [k, v] of [['CLAUDE_TELEGRAM_SESSION', saved.s], ['TELEGRAM_BOT_TOKEN', saved.t]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  assert.equal(seenEnv.CLAUDE_TELEGRAM_GATE, '1');
  assert.equal('CLAUDE_TELEGRAM_SESSION' in seenEnv, false);
  assert.equal('TELEGRAM_BOT_TOKEN' in seenEnv, false);
});

test('pruneGateMedia: 7일 지난 파일만 지운다', async () => {
  const { pruneGateMedia } = await import('./telegram-gate-handlers.mjs');
  const { mkdirSync, utimesSync, writeFileSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'gate-media-'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.oga'), 'a');
    writeFileSync(join(dir, 'new.jpg'), 'b');
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    utimesSync(join(dir, 'old.oga'), eightDaysAgo, eightDaysAgo);
    assert.equal(pruneGateMedia(dir), 1);
    assert.equal(existsSync(join(dir, 'old.oga')), false);
    assert.equal(existsSync(join(dir, 'new.jpg')), true);
    assert.equal(pruneGateMedia(join(dir, 'none')), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runGateTool: 도구를 자기 프로세스 그룹(detached)으로 띄워 멈출 때 손자까지 끝낼 수 있게 한다', async () => {
  let opts = null;
  const spawnImpl = (cmd, args, o) => {
    opts = o;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { on() {}, end() { setImmediate(() => child.emit('close', 0)); } };
    child.kill = () => {};
    return child;
  };
  await runGateTool('inbox-memo.mjs', ['--json=-'], { env: {}, spawnImpl });
  assert.equal(opts.detached, true);
});

test('시험 모드 처리기: 외부 기록(체결확인)만 실행하지 않고, 볼트 쓰기는 그대로(데몬이 시험 볼트로 격리)', async () => {
  const replies = [];
  const calls = [];
  const resolved = [];
  const handle = createGateHandlers({
    reply: async (agent, topic, body) => replies.push({ agent, body }),
    react: async () => {},
    runTool: async (tool, args, opts) => { calls.push({ tool, args, group: opts.group }); return '완료'; },
    telegram: {},
    wiki: { resolve: async (id) => { resolved.push(id); return { action: 'clarify' }; }, apply: async () => ({}) },
    selfCheck: async () => ({ ok: true, problems: [] }),
    status: async () => ({}),
    mediaDir: '/nonexistent',
    testMode: true,
    lane: 'main',
    now: () => new Date(),
  });
  await handle('execConfirm', { id: 'EC-20260929-ABC123', account: 'ISA' });
  await handle('wiki', { answers: [{ questionId: 'WQ-20261030-00000001', answer: '등록', rawText: 'x' }] });
  await handle('switch', { tool: 'kill-switch-cli.mjs', text: '킬스위치 온' });
  assert.deepEqual(calls, [{ tool: 'kill-switch-cli.mjs', args: ['--text=킬스위치 온'], group: 'main' }]);
  assert.deepEqual(resolved, ['WQ-20261030-00000001']);
  assert.match(replies[0].body, /시험 모드라 실행하지 않았습니다\(체결확인은 볼트 밖 외부 기록/);
});

test('처리기 lane: media 줄 도구는 media 그룹으로 띄운다(종료 때 그 줄만 끝냄)', async () => {
  const groups = [];
  const s = setup({ deps: { lane: 'media', runTool: async (tool, args, opts) => { groups.push(opts.group); return '{"note":"n","text":"t"}'; } } });
  try {
    await s.handle('voice', { fileId: 'v' });
    assert.deepEqual(groups, ['media']);
  } finally { s.cleanup(); }
});

test('상태 표: 대화 줄(처리 중·대기·최근 실패)과 사용량(5시간·7일)을 보인다', () => {
  const body = buildStatusBody({ startedAt: 0, now: 60_000, lastPollOkAt: null, counts: {}, cooldown: null, freeMemPct: 20, mode: 'live',
    llm: { running: true, queued: 2, lastRun: { status: '시간 초과' }, rateLimit: { unifiedWindows: { five_hour: { utilization: 0.05 }, seven_day: { utilization: 0.31 } } } } });
  assert.match(body, /처리 중 · 대기 2 · 최근 시간 초과/);
  assert.match(body, /5시간 5% · 7일 31%/);
});

test('isGateToolAllowed: 결정론·LLM 도구와 선언된 사실 도구만, 돈 도구는 어디에도 없다', async () => {
  const { isGateToolAllowed, LLM_GATE_TOOLS } = await import('./telegram-gate-handlers.mjs');
  for (const t of ['kill-switch-cli.mjs', 'calendar-add-event.mjs', 'rebalance-facts.mjs']) assert.equal(isGateToolAllowed(t), true, t);
  for (const t of ['place-nh-direct-order.mjs', 'modify-cancel-nh-order.mjs', 'retry-breakout-protection.mjs', 'execute-proposal.mjs', 'quant-factor-facts.mjs', '../x-facts.mjs'])
    assert.equal(isGateToolAllowed(t), false, t);
  assert.equal([...GATE_TOOLS, ...LLM_GATE_TOOLS].some((t) => /order|breakout|execute/.test(t)), false);
});

test('상태 표: 약속 대기 수와 다음 시각', () => {
  const body = buildStatusBody({ startedAt: 0, now: 60_000, lastPollOkAt: null, counts: {}, cooldown: null, freeMemPct: 20, mode: 'live', promises: { pending: 2, nextAt: '2026-10-30T09:00:00Z' } });
  assert.match(body, /약속 +대기 2 · 다음 18:00/);
});
