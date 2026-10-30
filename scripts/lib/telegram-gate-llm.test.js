import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildGateClaudeArgs, buildGateMcpConfig, GATE_DENY_RULES, GATE_TOOLS_SET, rateLimitBlockedUntil, runGateClaude, SECRET_PATTERNS } from './telegram-gate-llm.mjs';
import { defaultGatePaths } from './telegram-gate-config.mjs';

// claude 프로세스는 가짜 spawn으로 바꾼다. 실제 claude·사용량을 쓰지 않는다.
const flagValues = (args, flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j += 1) out.push(args[j]);
  return out;
};

test('인자: strict MCP·관문 MCP만, --restricted 없음, 도구는 Read·Grep·Glob·Agent, dontAsk, 구조화 출력', () => {
  const args = buildGateClaudeArgs({ prompt: 'p', sessionId: 'S', resume: false, appendSystemPrompt: 'sys', allowedTools: ['Read', 'mcp__gate__tasks_add'] });
  assert.equal(args.includes('--restricted'), false, '금고 가드 훅이 꺼지므로 금지');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(Object.keys(JSON.parse(flagValues(args, '--mcp-config')[0]).mcpServers), ['gate']);
  assert.deepEqual(flagValues(args, '--tools'), [GATE_TOOLS_SET.join(',')]);
  assert.deepEqual(flagValues(args, '--permission-mode'), ['dontAsk']);
  assert.deepEqual(flagValues(args, '--session-id'), ['S']);
  assert.equal(args.includes('--resume'), false);
  for (const t of ['Bash', 'Write', 'Edit']) assert.ok(flagValues(args, '--disallowedTools').includes(t));
  assert.ok(args.includes('--json-schema'));
  assert.deepEqual(flagValues(args, '--model'), ['opus']);
  assert.deepEqual(flagValues(args, '--effort'), ['medium']);
  const resumed = buildGateClaudeArgs({ prompt: 'p', sessionId: 'S', resume: true, allowedTools: ['Read'] });
  assert.deepEqual(flagValues(resumed, '--resume'), ['S']);
  assert.throws(() => buildGateClaudeArgs({ prompt: 'p', allowedTools: [] }), /sessionId/);
  assert.match(buildGateMcpConfig({ nodePath: '/n', serverPath: '/s.mjs' }), /"command":"\/n","args":\["\/s.mjs"\]/);
});

test('rateLimitBlockedUntil: allowed·allowed_warning은 null, 막히면 해제 시각', () => {
  assert.equal(rateLimitBlockedUntil({ rate_limit_info: { status: 'allowed', resetsAt: 1 } }), null);
  assert.equal(rateLimitBlockedUntil({ rate_limit_info: { status: 'allowed_warning', resetsAt: 1 } }), null);
  assert.equal(rateLimitBlockedUntil({ rate_limit_info: { status: 'rejected', resetsAt: 1793346000 } }), 1793346000000);
});

function fakeSpawn(script) {
  const record = { killed: [] };
  const spawnImpl = (bin, args, opts) => {
    record.bin = bin; record.args = args; record.opts = opts;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = undefined; // process.kill(-pid) 대신 child.kill 경로를 탄다
    child.kill = (signal) => { record.killed.push(signal); setImmediate(() => child.emit('close', null)); };
    setImmediate(() => script(child));
    return child;
  };
  return { spawnImpl, record };
}
const line = (obj) => `${JSON.stringify(obj)}\n`;

test('runGateClaude: 이벤트를 줄 단위로 넘기고(잘린 줄 이어 붙임) 결과·구조화 출력·세션을 돌려준다', async () => {
  const { spawnImpl, record } = fakeSpawn((child) => {
    const init = line({ type: 'system', subtype: 'init', session_id: 'S1' });
    child.stdout.emit('data', init.slice(0, 10));
    child.stdout.emit('data', init.slice(10));
    child.stdout.emit('data', line({ type: 'result', subtype: 'success', is_error: false, result: '{"messages":[]}', structured_output: { messages: [] }, permission_denials: [{ tool_name: 'Bash' }] }));
    child.emit('close', 0);
  });
  const events = [];
  const res = await runGateClaude({ args: ['-p', 'x'], env: { CLAUDE_TELEGRAM_GATE: '1' }, spawnImpl, claudeBin: '/c', onEvent: (e) => events.push(e.type), cooldownWriter: () => {} }).promise;
  assert.deepEqual(events, ['system', 'result']);
  assert.equal(res.sessionId, 'S1');
  assert.deepEqual(res.structured, { messages: [] });
  assert.equal(res.isError, false);
  assert.deepEqual(res.permissionDenials, [{ tool_name: 'Bash' }]);
  assert.equal(record.opts.detached, true);
  assert.equal(record.opts.env.CLAUDE_TELEGRAM_GATE, '1');
});

test('runGateClaude: 막힌 rate_limit_event와 한도 오류 문구는 쿨다운을 기록한다', async () => {
  const cooldowns = [];
  const { spawnImpl } = fakeSpawn((child) => {
    child.stdout.emit('data', line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793346000, rateLimitType: 'five_hour' } }));
    child.stderr.emit('data', "You've hit your limit · resets 10:50am (Asia/Seoul)");
    child.emit('close', 1);
  });
  const res = await runGateClaude({ args: [], env: {}, spawnImpl, claudeBin: '/c', cooldownWriter: (at, why) => cooldowns.push({ at, why }), now: () => Date.parse('2026-10-30T00:00:00Z') }).promise;
  assert.equal(cooldowns.length, 2);
  assert.equal(cooldowns[0].at, 1793346000000);
  assert.equal(res.isError, true);
});

test('runGateClaude: 취소는 프로세스(그룹)에 SIGTERM을 보내고 interrupted=cancel', async () => {
  const { spawnImpl, record } = fakeSpawn(() => {});
  const handle = runGateClaude({ args: [], env: {}, spawnImpl, claudeBin: '/c', cooldownWriter: () => {} });
  await new Promise((r) => setImmediate(r));
  handle.cancel();
  const res = await handle.promise;
  assert.equal(res.interrupted, 'cancel');
  assert.deepEqual(record.killed, ['SIGTERM']);
  assert.equal(res.isError, false, '취소는 오류로 보지 않는다');
});

test('runGateClaude: 시간 초과면 interrupted=timeout', async () => {
  const { spawnImpl } = fakeSpawn(() => {});
  const res = await runGateClaude({ args: [], env: {}, spawnImpl, claudeBin: '/c', hardTimeoutMs: 5, cooldownWriter: () => {} }).promise;
  assert.equal(res.interrupted, 'timeout');
});

test('runGateClaude: 비정상 종료는 stderr 마지막 줄로 오류를 남긴다', async () => {
  const { spawnImpl } = fakeSpawn((child) => { child.stderr.emit('data', 'a\nb\nNo conversation found with session ID: S'); child.emit('close', 1); });
  const res = await runGateClaude({ args: [], env: {}, spawnImpl, claudeBin: '/c', cooldownWriter: () => {} }).promise;
  assert.equal(res.isError, true);
  assert.match(res.errorText, /No conversation found/);
});

test('자격증명 경로 거부 규칙: Read·Grep·Glob 모두 ~/.config·~/.claude·.env를 막는다', () => {
  const args = buildGateClaudeArgs({ prompt: 'p', sessionId: 'S', allowedTools: ['Read'] });
  const denied = flagValues(args, '--disallowedTools');
  for (const rule of ['Read(~/.config/**)', 'Grep(~/.config/**)', 'Glob(~/.claude/**)', 'Read(**/.env)', 'Read(**/.env.*)']) assert.ok(denied.includes(rule), rule);
  assert.ok(GATE_DENY_RULES.length >= 30);
});

test('읽기 경로 제한 훅을 --settings로 이 실행에만 붙이고, 허용 뿌리는 env로 넘긴다', async () => {
  const { buildGateReadEnv, buildGateReadGuardSettings } = await import('./telegram-gate-llm.mjs');
  const args = buildGateClaudeArgs({ prompt: 'p', sessionId: 'S', allowedTools: ['Read'] });
  const settings = JSON.parse(flagValues(args, '--settings')[0]);
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Read|Grep|Glob');
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /gate-read-guard\.mjs"$/);
  assert.match(buildGateReadGuardSettings({ nodePath: '/n', hookPath: '/h.mjs' }), /"\\"\/n\\" \\"\/h.mjs\\""/);
  assert.deepEqual(buildGateReadEnv({ vaultRoot: '/v', mediaDir: '/m', adytonDir: '/v/secret', repoRoot: '/r' }), { GATE_READ_ROOTS: '/v:/r:/m', GATE_READ_DENIED: '/v/secret:/r/scripts/.cache' });
});

// 거부 패턴을 glob처럼 해석하는 작은 판정기(~ = 홈, **/ = 아무 깊이의 폴더, ** = 아무 문자, * = 한 단계). 실제 파일은 열지 않는다.
function globToRegExp(pattern, home) {
  let src = '';
  const p = pattern.replace(/^~/, home);
  for (let i = 0; i < p.length; i += 1) {
    if (p.startsWith('**/', i)) { src += '(?:.*/)?'; i += 2; }
    else if (p.startsWith('**', i)) { src += '.*'; i += 1; }
    else if (p[i] === '*') src += '[^/]*';
    else src += p[i].replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${p.startsWith('/') ? '' : '/?'}${src}$`);
}
function matchesSecret(path, home) {
  return SECRET_PATTERNS.some((pattern) => globToRegExp(pattern, home).test(path));
}

test('관문 사진 폴더(실전·시험)는 어떤 거부 패턴에도 걸리지 않는다 — 사진 판독 Read가 막히면 안 됨', () => {
  const home = '/Users/x';
  const paths = defaultGatePaths({ home });
  for (const dir of [paths.liveLlmMediaDir, paths.testLlmMediaDir]) {
    assert.equal(matchesSecret(`${dir}/1793336400000-AgAD.jpg`, home), false, dir);
  }
  assert.ok(!paths.liveLlmMediaDir.includes('/.config/') && !paths.liveLlmMediaDir.includes('/Library/'));
});

test('거부 패턴은 실제 토큰·자격증명 경로 형태를 막는다(내용은 읽지 않음)', () => {
  const home = '/Users/x';
  for (const path of [
    `${home}/Pantheon/Repos/banana-portfolio-v2/scripts/.cache/kis-token.json`,
    `${home}/Pantheon/Repos/banana-portfolio-v2/scripts/.cache/nhplug-token.json.invalid-1`,
    `${home}/.config/banana-portfolio-v2/google-token.json`,
    `${home}/.claude/channels/telegram/.env`,
    `${home}/Pantheon/Repos/banana-portfolio-v2/.env`,
    `${home}/Pantheon/Repos/x/credentials.json`,
    `${home}/Pantheon/Repos/x/client_secret.json`,
  ]) assert.equal(matchesSecret(path, home), true, path);
  assert.equal(matchesSecret(`${home}/Pantheon/Mouseion/90_Delphi/Schema/상태표준.md`, home), false);
});
