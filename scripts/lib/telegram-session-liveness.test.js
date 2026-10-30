import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProcessAlive, isSessionLogStale, parseEtime, parseProcessTable, classifyPluginOwnership, summarizeStaleClaudeSessions, TELEGRAM_SESSION_PROCESS_PATTERN, TELEGRAM_MCP_SUBPROCESS_PATTERN } from './telegram-session-liveness.mjs';

// 2026-08-31 신설 — health-watcher.mjs·telegram-session-health-check.mjs가 공유하는
// 프로세스 생존 확인. isPollingStuck 자체는 health-watcher.test.js가 이미 커버(이
// 모듈에서 재수출됨).

test('isProcessAlive: 절대 존재할 수 없는 패턴이면 false(안 터짐)', () => {
  assert.equal(isProcessAlive('절대로존재하지않을프로세스이름_xyz123'), false);
});

test('isProcessAlive: 지금 이 테스트 프로세스 자체를 찾는 패턴이면 true', () => {
  // node --test로 도는 이 프로세스 자체가 "node"를 포함하므로 자기 자신을 찾는다.
  assert.equal(isProcessAlive('node'), true);
});

test('패턴 상수가 의도한 대로 정의돼 있음(세션 프로세스와 MCP 서브프로세스 구분)', () => {
  assert.match(TELEGRAM_SESSION_PROCESS_PATTERN, /channels/);
  assert.match(TELEGRAM_MCP_SUBPROCESS_PATTERN, /telegram/);
  assert.notEqual(TELEGRAM_SESSION_PROCESS_PATTERN, TELEGRAM_MCP_SUBPROCESS_PATTERN);
});

test('isSessionLogStale: 임계값을 넘은 로그만 정체로 판정(경계값은 정상)', () => {
  const nowMs = 1_000_000;
  const thresholdMs = 30 * 60_000;
  assert.equal(isSessionLogStale({ lastModifiedMs: nowMs - thresholdMs, nowMs, thresholdMs }), false);
  assert.equal(isSessionLogStale({ lastModifiedMs: nowMs - thresholdMs - 1, nowMs, thresholdMs }), true);
});

test('isSessionLogStale: mtime 또는 임계값이 유효하지 않으면 장애로 단정하지 않음', () => {
  assert.equal(isSessionLogStale({ lastModifiedMs: undefined, nowMs: 1_000, thresholdMs: 1 }), false);
  assert.equal(isSessionLogStale({ lastModifiedMs: 1_000, nowMs: 2_000, thresholdMs: 0 }), false);
});

const SESSION_ARGS = 'claude --channels plugin:telegram@claude-plugins-official --name 판테온 텔레그램 가상세션';
const PLUGIN_ARGS = 'bun run --cwd /Users/x/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7 --shell=bun --silent start';
const DESKTOP_ARGS = '/Users/x/Library/Application Support/Claude/claude-code/2.1.309/claude.app/Contents/MacOS/claude --output-format stream-json';

test('parseEtime: ps etime 형식을 초로', () => {
  assert.equal(parseEtime('05:07'), 307);
  assert.equal(parseEtime('03:42:14'), 3 * 3600 + 42 * 60 + 14);
  assert.equal(parseEtime('17-12:07:35'), ((17 * 24 + 12) * 60 + 7) * 60 + 35);
  assert.ok(Number.isNaN(parseEtime('abc')));
});

test('parseProcessTable: pid·ppid·etime·rss·args를 읽고 형식이 다른 줄은 버림', () => {
  const rows = parseProcessTable(`  100     1  02-00:00:00  204800 claude\nbroken line\n  200   100     01:00   1024 ${PLUGIN_ARGS}`);
  assert.deepEqual(rows.map((r) => [r.pid, r.ppid, r.etimeSec, r.rssKb]), [[100, 1, 172800, 204800], [200, 100, 60, 1024]]);
  assert.equal(rows[1].args, PLUGIN_ARGS);
});

test('[실사고 재현] classifyPluginOwnership: 상시 세션 아래 플러그인만 소유로 세고, 데스크톱 세션 아래 플러그인은 가로챈 세션으로 보고', () => {
  const table = [
    { pid: 10, ppid: 1, args: '/usr/bin/script -q /dev/null /bin/bash -lc claude --channels plugin:telegram@x' },
    { pid: 11, ppid: 10, args: SESSION_ARGS },
    { pid: 12, ppid: 11, args: PLUGIN_ARGS },
    { pid: 20, ppid: 1, args: '/Applications/Claude.app/Contents/MacOS/Claude' },
    { pid: 21, ppid: 20, args: DESKTOP_ARGS },
    { pid: 22, ppid: 21, args: PLUGIN_ARGS },
  ];
  assert.deepEqual(classifyPluginOwnership(table), { ownedPluginPids: [12], foreignPlugins: [{ pid: 22, ownerPid: 21 }] });
  assert.deepEqual(classifyPluginOwnership(table.filter((p) => p.pid !== 12)), { ownedPluginPids: [], foreignPlugins: [{ pid: 22, ownerPid: 21 }] });
});

test('summarizeStaleClaudeSessions: 2일 넘은 claude 세션만 세고 상시 세션은 뺌', () => {
  const day = 86_400;
  const table = [
    { pid: 1, args: 'claude', etimeSec: 17 * day, rssKb: 1024 * 800 },
    { pid: 2, args: DESKTOP_ARGS, etimeSec: 3 * day, rssKb: 1024 * 200 },
    { pid: 3, args: 'claude', etimeSec: day, rssKb: 1024 * 500 },
    { pid: 4, args: SESSION_ARGS, etimeSec: 9 * day, rssKb: 1024 * 300 },
    { pid: 5, args: 'node /x/claude-helper.js', etimeSec: 9 * day, rssKb: 1024 * 300 },
  ];
  assert.deepEqual(summarizeStaleClaudeSessions(table), { count: 2, totalRssMb: 1000 });
});

test('summarizeStaleClaudeSessions: 데스크톱 disclaimer 래퍼 줄은 세지 않음', () => {
  const table = [
    { pid: 1, args: `/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- ${DESKTOP_ARGS}`, etimeSec: 5 * 86_400, rssKb: 0 },
    { pid: 2, args: DESKTOP_ARGS, etimeSec: 5 * 86_400, rssKb: 1024 * 100 },
  ];
  assert.deepEqual(summarizeStaleClaudeSessions(table), { count: 1, totalRssMb: 100 });
});
