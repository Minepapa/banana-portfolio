// 전략 가동 스위치(결정 `전략-가동`) 불변식 테스트.
//   1) 스위치는 strategies 칸의 정확한 'on'에서만 켜지고, 나머지는 전부 꺼짐(fail-closed)이다.
//   2) 이름에 전략 표식이 붙은 잡·도구는 STRATEGY_ENTRYPOINTS에 들어 있거나, 면제 사유가 적혀 있다.
//   3) 꺼진 상태에서 모든 전략 진입점은 네트워크·자식 프로세스를 한 번도 부르지 않고 exit 0으로 끝난다.
//   4) 자산분배 주문 경로는 스위치를 import하지 않는다 — 스위치 값과 무관하게 동작이 같다.
//   5) health-watcher·주간 스케줄은 꺼진 전략 항목을 거르고, 다시 켜면 되돌아온다.
// 실제 볼트는 읽거나 쓰지 않는다 — 결정 문서는 임시 볼트에 만들고 resolve를 주입한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDecision } from './decision-resolver.mjs';
import { VAULT_PATHS, VAULT_REL, VAULT_ROOT } from './vault-paths.mjs';
import { listDispatchedJobs, listPlistJobs } from './launchd-jobs.mjs';
import { buildJobHealthRecord } from './job-health.mjs';
import {
  STRATEGIES, STRATEGY_DECISION_KEY, STRATEGY_ENTRYPOINTS, STRATEGY_JOBS, STRATEGY_LABELS,
  describeStrategySwitches, isStrategyOn, stopIfStrategyOff, strategySwitchStatus, strategySwitches, switchedOffJobs,
  switchedOffScripts,
} from './strategy-switch.mjs';
import { findStaleJobs, processHealthIssues } from '../jobs/health-watcher.mjs';
import { SCHEDULE, describeSwitchStatus, scheduleForSwitches } from '../jobs/weekly-schedule-summary.mjs';

const REPO = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');

// 이름에 전략 표식이 있지만 스위치 대상이 아닌 파일과 그 사유. 새 파일이 여기도 STRATEGY_ENTRYPOINTS에도
// 없으면 테스트가 실패한다 — 새 전략 도구가 스위치 없이 들어오는 것을 막는다.
const EXEMPT = {
  // 이미 낸 진입 주문의 체결을 기록하고 손절 보호주문을 거는 후속 도구. 꺼진 상태에서는 진입 주문을 내는
  // 진입점이 모두 막혀 있어 불릴 일이 없고, 켜져 있던 중에 낸 주문이 체결됐는데 스위치 때문에 기록·보호가
  // 끊기면 보호주문 없는 보유가 생긴다. 그래서 일부러 스위치를 걸지 않는다.
  'scripts/tools/watch-breakout-entry-fill.mjs': '이미 낸 주문의 체결 기록·보호주문 후속',
  // 과거 데이터로만 도는 연구용 분석. 주문·발송·운영 상태 쓰기가 없다.
  'scripts/jobs/run-breakout-backtest.mjs': '백테스트(연구용)',
  'scripts/jobs/run-quant-backtest.mjs': '폐기된 팩터 전략 백테스트(연구용)',
  'scripts/tools/count-breakout-signals.mjs': '과거 신호 횟수 집계(연구용)',
  'scripts/tools/quant-factor-facts.mjs': '폐기된 팩터 전략 사실 조회(대화형, 주문 없음)',
  'scripts/tools/quant-reconstitution-facts.mjs': '폐기된 팩터 전략 사실 조회(대화형, 주문 없음)',
  // 전략 계좌를 다루지만 전략 전용이 아닌 공용 도구.
  'scripts/jobs/update-holdings-from-executions.mjs': '전 계좌 공용 보유 갱신(이미 난 체결의 장부 반영)',
  'scripts/tools/watch-order-fill.mjs': '범용 체결감시(이미 낸 주문의 체결 후속)',
};
const STRATEGY_NAME_PATTERN = /breakout|quant/;
// 이름에 표식이 없어도 전략 계좌·트랙을 다루는 파일을 내용으로 찾는다(watch-price-and-propose 누락 재발 방지).
const STRATEGY_CONTENT_PATTERN = /loadQuantAccount|track: '퀀트'|QUANT_TRACK_LABEL/;
const BREAKOUT_POSITIONS_REL = relative(VAULT_ROOT, VAULT_PATHS.state.breakoutPositions);

// 자산분배 주문·제안 경로. 이 파일들의 정적·동적 import 그래프 어디에도 strategy-switch가 없어야 한다.
const ASSET_ALLOCATION_ENTRYPOINTS = [
  'scripts/tools/place-nh-direct-order.mjs',
  'scripts/tools/modify-cancel-nh-order.mjs',
  'scripts/tools/watch-nh-order-fill.mjs',
  'scripts/tools/execute-asset-allocation-proposal.mjs',
  'scripts/jobs/new-cash-allocation.mjs',
  'scripts/jobs/rebalance-proposal.mjs',
  'scripts/jobs/daily-asset-allocation-check.mjs',
  'scripts/jobs/expire-stale-nh-orders.mjs',
];

function writeOpenPosition(vaultRoot, status = '보유') {
  const dir = join(vaultRoot, BREAKOUT_POSITIONS_REL);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '003490-2026-09-23.md'), `---\ncode: "003490"\nstatus: "${status}"\n---\n`);
  return dir;
}

function makeVault(t, strategiesLine) {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'strategy-switch-'));
  t.after(() => rmSync(vaultRoot, { recursive: true, force: true }));
  const decisionDir = join(vaultRoot, VAULT_REL.decisionsCanonical);
  mkdirSync(decisionDir, { recursive: true });
  if (strategiesLine !== undefined) {
    writeFileSync(join(decisionDir, '전략 가동 스위치.md'), [
      '---', 'type: "decision"', `decisionKey: "${STRATEGY_DECISION_KEY}"`, 'status: "결정됨"',
      ...(strategiesLine === null ? [] : [strategiesLine]), '---', '# 전략 가동 스위치', '', '본문',
    ].join('\n'));
  }
  return vaultRoot;
}

function resolverFor(vaultRoot) {
  return (key) => resolveDecision(key, { vaultRoot });
}

test('strategies 칸이 정확히 소문자 on일 때만 켜진다(홑따옴표 JSON·맨 JSON 둘 다 읽음)', (t) => {
  for (const line of [`strategies: '{"breakout": "on"}'`, 'strategies: {"breakout": "on"}']) {
    const resolve = resolverFor(makeVault(t, line));
    assert.equal(isStrategyOn('breakout', { resolve }), true, line);
    assert.deepEqual(strategySwitches({ resolve }), { breakout: true }, line);
  }
});

test('칸 없음·문서 없음·대소문자·true·불리언·깨진 JSON·배열·다른 키는 모두 꺼짐(fail-closed)', (t) => {
  const offLines = [
    null, // 칸 없음 — 지금 결정 문서 상태
    'strategies: ""',
    'strategies: {"breakout": "ON"}',
    'strategies: {"breakout": "On"}',
    'strategies: {"breakout": "true"}',
    'strategies: {"breakout": true}',
    'strategies: {"breakout": 1}',
    'strategies: {"breakout": " on"}',
    'strategies: {"breakout": "off"}',
    'strategies: {breakout: on}',
    'strategies: ["breakout"]',
    'strategies: {"other": "on"}',
    'strategies: on',
  ];
  for (const line of offLines) {
    const resolve = resolverFor(makeVault(t, line));
    assert.equal(isStrategyOn('breakout', { resolve }), false, String(line));
    assert.deepEqual(strategySwitches({ resolve }), { breakout: false }, String(line));
  }
  // 머리말 줄바꿈이 CRLF면 파서가 칸을 못 찾는다 — 꺼짐
  {
    const vaultRoot = makeVault(t, null);
    const decisionDir = join(vaultRoot, VAULT_REL.decisionsCanonical);
    writeFileSync(join(decisionDir, '전략 가동 스위치.md'), ['---', 'type: "decision"', `decisionKey: "${STRATEGY_DECISION_KEY}"`,
      'status: "결정됨"', 'strategies: {"breakout": "on"}', '---', '본문'].join('\r\n'));
    assert.equal(isStrategyOn('breakout', { resolve: resolverFor(vaultRoot) }), false, 'CRLF');
  }
  // 결정 문서 자체가 없음(resolveDecision이 0개라고 throw)
  assert.equal(isStrategyOn('breakout', { resolve: resolverFor(makeVault(t, undefined)) }), false);
  // resolve가 예외·이상한 값을 돌려줌
  assert.equal(isStrategyOn('breakout', { resolve: () => { throw new Error('읽기 실패'); } }), false);
  assert.equal(isStrategyOn('breakout', { resolve: () => ({}) }), false);
  assert.equal(isStrategyOn('breakout', { resolve: () => null }), false);
});

test('모르는 전략 이름은 문서에 on이 있어도 꺼짐이다', (t) => {
  const resolve = resolverFor(makeVault(t, 'strategies: {"breakout": "on", "momentum": "on"}'));
  assert.equal(isStrategyOn('momentum', { resolve }), false);
  assert.equal(isStrategyOn('Breakout', { resolve }), false);
  assert.equal(isStrategyOn('breakout', { resolve }), true);
});

test('stopIfStrategyOff: 꺼지면 사유가 붙은 한 줄을 남기고 true, 켜지면 아무것도 안 남기고 false', (t) => {
  const logs = [];
  const log = (line) => logs.push(line);
  assert.equal(stopIfStrategyOff('breakout', { resolve: resolverFor(makeVault(t, null)), log }), true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[건너뜀\] 돌파매매 전략 꺼짐\(결정 전략-가동\)/);
  assert.match(logs[0], /strategies 칸이 없습니다/);
  logs.length = 0;
  assert.equal(stopIfStrategyOff('breakout', { resolve: resolverFor(makeVault(t, 'strategies: {"breakout": "on"}')), log }), false);
  assert.deepEqual(logs, []);
});

test('strategySwitchStatus: 칸 없음은 끈 상태(고장 아님), 문서 없음·깨진 JSON·결정됨 2개는 고장', (t) => {
  assert.equal(strategySwitchStatus({ resolve: resolverFor(makeVault(t, null)) }).fault, false);
  assert.equal(strategySwitchStatus({ resolve: resolverFor(makeVault(t, 'strategies: {"breakout": "on"}')) }).fault, false);
  assert.equal(strategySwitchStatus({ resolve: resolverFor(makeVault(t, undefined)) }).fault, true);
  assert.equal(strategySwitchStatus({ resolve: resolverFor(makeVault(t, 'strategies: {breakout')) }).fault, true);
  const twoDocs = makeVault(t, 'strategies: {"breakout": "on"}');
  writeFileSync(join(twoDocs, VAULT_REL.decisionsCanonical, '새 문서.md'),
    `---\ndecisionKey: "${STRATEGY_DECISION_KEY}"\nstatus: "결정됨"\n---\n본문`);
  const status = strategySwitchStatus({ resolve: resolverFor(twoDocs) });
  assert.equal(status.fault, true);
  assert.deepEqual(status.switches, { breakout: false });
});

test('stopIfStrategyOff(openPositionsDir): 꺼졌는데 보유 포지션이 남아 있으면 조용히 끝내지 않고 throw', (t) => {
  const log = () => {};
  const offVault = makeVault(t, null);
  const dir = join(offVault, BREAKOUT_POSITIONS_REL);
  const resolve = resolverFor(offVault);
  // 폴더 없음 → 보유 없음, 정상 꺼짐
  assert.equal(stopIfStrategyOff('breakout', { resolve, log, openPositionsDir: dir }), true);
  writeOpenPosition(offVault, '종료');
  assert.equal(stopIfStrategyOff('breakout', { resolve, log, openPositionsDir: dir }), true);
  writeOpenPosition(offVault, '보유');
  assert.throws(() => stopIfStrategyOff('breakout', { resolve, log, openPositionsDir: dir }),
    (e) => /열린 포지션 1건\(003490-2026-09-23\.md\)/.test(e.message) && e.code === 'STRATEGY_OFF_OPEN_POSITIONS');
  // 폴더 자리에 파일이 있어 목록을 못 읽으면 보유 여부를 모르므로 throw
  const broken = join(offVault, 'not-a-dir');
  writeFileSync(broken, '');
  assert.throws(() => stopIfStrategyOff('breakout', { resolve, log, openPositionsDir: broken }), /열린 포지션 여부를 읽지 못함/);
  // 켜져 있으면 포지션과 무관하게 false(평소 경로로 진행)
  const onVault = makeVault(t, 'strategies: {"breakout": "on"}');
  writeOpenPosition(onVault);
  assert.equal(stopIfStrategyOff('breakout', { resolve: resolverFor(onVault), log, openPositionsDir: join(onVault, BREAKOUT_POSITIONS_REL) }), false);
});

test('꺼진 전략의 잡·스크립트 집합과 상태 줄', () => {
  assert.deepEqual([...switchedOffJobs({ breakout: false })].sort(), [...STRATEGY_JOBS.breakout].sort());
  assert.deepEqual([...switchedOffJobs({ breakout: true })], []);
  assert.deepEqual([...switchedOffJobs(null)].sort(), [...STRATEGY_JOBS.breakout].sort());
  assert.ok(switchedOffScripts({ breakout: false }).has('daily-breakout-signal-scan.mjs'));
  assert.deepEqual([...switchedOffScripts({ breakout: true })], []);
  assert.deepEqual(describeStrategySwitches({ breakout: false }), ['· 돌파매매: 꺼짐(결정 전략-가동)']);
  assert.deepEqual(describeStrategySwitches({ breakout: true }), ['· 돌파매매: 켜짐']);
});

test('전략 목록 정합성: 라벨·잡·진입점이 모든 전략에 있고, 잡은 run.sh·plist에 실제로 등록돼 있다', () => {
  const dispatched = new Set(listDispatchedJobs());
  const plists = new Set(listPlistJobs());
  const runSh = readFileSync(join(REPO, 'scripts/launchd/run.sh'), 'utf8');
  for (const key of STRATEGIES) {
    assert.ok(STRATEGY_LABELS[key], `${key} 라벨 없음`);
    assert.ok(STRATEGY_JOBS[key]?.length, `${key} 잡 목록 없음`);
    assert.ok(STRATEGY_ENTRYPOINTS[key]?.length, `${key} 진입점 목록 없음`);
    for (const job of STRATEGY_JOBS[key]) {
      assert.ok(dispatched.has(job), `run.sh에 ${job} 없음`);
      assert.ok(plists.has(job), `plist에 ${job} 없음`);
      // launchd 라벨이 실제로 부르는 스크립트도 스위치 진입점이어야 한다(예: execute-quant → execute-quant-proposal).
      const script = runSh.match(new RegExp(`^\\s*${job}\\)\\s+CMD=\\(([^\\s)]+)`, 'm'))?.[1];
      assert.ok(STRATEGY_ENTRYPOINTS[key].includes(script), `${job}의 스크립트 ${script}가 진입점 목록에 없음`);
    }
  }
});

test('이름에 전략 표식이 붙은 잡·도구는 전부 스위치 진입점이거나 사유가 적힌 면제다', () => {
  const covered = new Set(Object.values(STRATEGY_ENTRYPOINTS).flat());
  const found = ['scripts/jobs', 'scripts/tools'].flatMap((dir) => readdirSync(join(REPO, dir))
    .filter((name) => name.endsWith('.mjs') && STRATEGY_NAME_PATTERN.test(name)).map((name) => `${dir}/${name}`));
  const missing = found.filter((path) => !covered.has(path) && !Object.hasOwn(EXEMPT, path));
  assert.deepEqual(missing, [], '스위치도 면제 사유도 없는 전략 파일');
  const byContent = ['scripts/jobs', 'scripts/tools'].flatMap((dir) => readdirSync(join(REPO, dir))
    .filter((name) => name.endsWith('.mjs')).map((name) => `${dir}/${name}`))
    .filter((path) => STRATEGY_CONTENT_PATTERN.test(readFileSync(join(REPO, path), 'utf8')));
  assert.ok(byContent.includes('scripts/tools/watch-price-and-propose.mjs'), '내용 기준 탐지가 동작하지 않음');
  const missingByContent = byContent.filter((path) => !covered.has(path) && !Object.hasOwn(EXEMPT, path));
  assert.deepEqual(missingByContent, [], '전략 계좌·트랙을 다루는데 스위치도 면제 사유도 없는 파일');
  for (const path of [...covered, ...Object.keys(EXEMPT)]) assert.ok(existsSync(join(REPO, path)), `${path} 없음`);
  for (const path of Object.keys(EXEMPT)) assert.ok(!covered.has(path), `${path}가 진입점과 면제에 함께 있음`);
});

test('모든 전략 진입점은 main() 첫 문장에서 자기 전략 스위치를 검사한다', () => {
  for (const [key, paths] of Object.entries(STRATEGY_ENTRYPOINTS)) {
    for (const path of paths) {
      const source = readFileSync(join(REPO, path), 'utf8');
      const body = source.match(/\nasync function main\(\) \{\n((?:\s*\/\/[^\n]*\n)*)\s*([^\n]+)/);
      assert.ok(body, `${path}: main()을 찾지 못함`);
      const first = body[2].trim();
      const allowed = [`if (stopIfStrategyOff('${key}')) return;`,
        `if (stopIfStrategyOff('${key}', { openPositionsDir: VAULT_PATHS.state.breakoutPositions })) return;`];
      assert.ok(allowed.includes(first), `${path}: main() 첫 문장이 스위치 검사가 아님: ${first}`);
    }
  }
});

// 꺼진 상태로 진입점을 실제 프로세스로 띄워, 네트워크·자식 프로세스 호출이 하나도 없는지 확인한다.
// 미리 불러오는 모듈이 fetch·http(s)·net·tls·child_process를 전부 기록 후 예외로 바꾼다 — 검사가
// 빠진 진입점이 끝까지 돌더라도 바깥으로 아무것도 나가지 않는다. 볼트·HOME도 임시 폴더다.
const SANDBOX_PRELOAD = `
const fs = require('node:fs');
const record = (kind, target) => fs.appendFileSync(process.env.STRATEGY_SANDBOX_LOG, kind + ' ' + String(target).slice(0, 120) + '\\n');
const blocked = (kind) => function (...args) { record(kind, args[0]); throw new Error('sandbox: ' + kind + ' 차단'); };
globalThis.fetch = async (url) => { record('fetch', url); throw new Error('sandbox: fetch 차단'); };
const dns = require('node:dns');
for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns[fn] = blocked('dns.' + fn);
dns.promises.lookup = blocked('dns.promises.lookup');
require('node:dgram').createSocket = blocked('dgram.createSocket');
for (const name of ['http', 'https', 'net', 'tls', 'http2']) {
  const mod = require('node:' + name);
  for (const fn of ['request', 'get', 'connect', 'createConnection']) if (typeof mod[fn] === 'function') mod[fn] = blocked(name + '.' + fn);
}
const cp = require('node:child_process');
for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[fn] = blocked('child_process.' + fn);
require('node:module').syncBuiltinESMExports();
`;

function runSandboxed(t, scriptPath, vaultRoot, args = []) {
  const sandbox = mkdtempSync(join(tmpdir(), 'strategy-sandbox-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const preload = join(sandbox, 'no-network.cjs');
  const callLog = join(sandbox, 'calls.log');
  writeFileSync(preload, SANDBOX_PRELOAD);
  writeFileSync(callLog, '');
  const home = join(sandbox, 'home');
  mkdirSync(home);
  const result = spawnSync(process.execPath, ['--require', preload, resolvePath(REPO, scriptPath), ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: home, VAULT_PATH: vaultRoot, STRATEGY_SANDBOX_LOG: callLog },
  });
  return { ...result, calls: readFileSync(callLog, 'utf8'), output: `${result.stdout}${result.stderr}` };
}

function listFilesDeep(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? e.path, e.name)).sort();
}

test('샌드박스 자체 확인: 미리 불러온 모듈이 fetch·자식 프로세스 호출을 기록하고 막는다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'strategy-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, [
    "import { spawn } from 'node:child_process';",
    "try { spawn('true'); } catch {}",
    "try { await fetch('https://example.invalid/'); } catch {}",
  ].join('\n'));
  const result = runSandboxed(t, probe, makeVault(t, null));
  assert.equal(result.status, 0, result.output);
  assert.match(result.calls, /^child_process\.spawn true$/m);
  assert.match(result.calls, /^fetch https:\/\/example\.invalid\/$/m);
});

test('돌파매매가 꺼져 있으면(지금 결정 문서처럼 칸 없음) 모든 진입점이 아무 호출 없이 exit 0으로 끝난다', (t) => {
  const vaultRoot = makeVault(t, null);
  const before = listFilesDeep(vaultRoot);
  for (const path of STRATEGY_ENTRYPOINTS.breakout) {
    // 실주문 도구가 인자 검사까지 가지 않는다는 것도 함께 본다 — 정상 인자를 줘도 검사에서 끝나야 한다.
    const result = runSandboxed(t, path, vaultRoot, ['--code=005930', '--name=삼성전자', '--entry-date=2026-11-02', '--invested-won=1000000']);
    assert.equal(result.status, 0, `${path}: exit ${result.status}\n${result.output}`);
    assert.match(result.output, /돌파매매 전략 꺼짐\(결정 전략-가동\)/, path);
    assert.equal(result.calls, '', `${path}: 네트워크·자식 프로세스 호출 발생\n${result.calls}`);
  }
  assert.deepEqual(listFilesDeep(vaultRoot), before, '꺼진 진입점이 볼트에 무언가를 썼다');
});

test('꺼졌는데 보유 포지션이 남아 있으면 보호 진입점은 증권사 호출 없이 실패(exit≠0)로 드러낸다', (t) => {
  for (const path of ['scripts/jobs/reconcile-breakout-protection.mjs', 'scripts/tools/retry-breakout-protection.mjs']) {
    const vaultRoot = makeVault(t, null);
    writeOpenPosition(vaultRoot);
    const result = runSandboxed(t, path, vaultRoot, ['--code=003490']);
    assert.notEqual(result.status, 0, `${path}: 조용히 exit 0으로 끝남\n${result.output}`);
    assert.match(result.output, /전략 꺼짐\(결정 전략-가동\)인데 열린 포지션 1건/, path);
    // 실패 경보(텔레그램 발송 시도)만 허용한다 — 증권사·자식 프로세스 호출은 없어야 한다.
    const nonAlert = result.calls.split('\n').filter(Boolean).filter((line) => !/^fetch https:\/\/api\.telegram\.org\//.test(line));
    assert.deepEqual(nonAlert, [], `${path}: 경보 외 호출 발생`);
  }
});

test('결정 문서를 아예 못 읽어도 진입점은 꺼짐으로 끝난다(사유를 남김)', (t) => {
  const vaultRoot = makeVault(t, undefined);
  const result = runSandboxed(t, 'scripts/tools/execute-quant-proposal.mjs', vaultRoot);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /돌파매매 전략 꺼짐\(결정 전략-가동\).*결정 문서 strategies 칸을 읽지 못함/);
  assert.equal(result.calls, '');
});

// 정적 import·export from·동적 import('...')의 상대 경로를 따라가며 닫힌 집합을 만든다.
function importClosure(entryPath) {
  const seen = new Set();
  const stack = [resolvePath(REPO, entryPath)];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      stack.push(resolvePath(dirname(file), match[1]));
    }
  }
  return seen;
}

test('자산분배 주문 경로는 전략 스위치를 import하지도, 결정 키를 읽지도 않는다(스위치 값과 무관하게 같은 동작)', () => {
  const switchModule = resolvePath(REPO, 'scripts/lib/strategy-switch.mjs');
  for (const entry of ASSET_ALLOCATION_ENTRYPOINTS) {
    assert.ok(existsSync(join(REPO, entry)), `${entry} 없음`);
    const closure = importClosure(entry);
    assert.ok(closure.size > 1, `${entry}: import 그래프를 읽지 못함`);
    assert.ok(!closure.has(switchModule), `${entry}가 strategy-switch.mjs에 의존한다`);
    for (const file of closure) {
      assert.ok(!readFileSync(file, 'utf8').includes(STRATEGY_DECISION_KEY), `${entry} → ${basename(file)}가 결정 ${STRATEGY_DECISION_KEY}를 읽는다`);
    }
  }
});

test('health-watcher: 꺼진 전략 잡은 실행 없음 경보에서 빠지고, 켜면 다시 잡힌다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'strategy-health-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const longAgo = new Date('2026-10-01T00:00:00.000Z');
  for (const job of ['daily-breakout-signal-scan', 'execute-quant', 'media-archive']) {
    writeFileSync(join(dir, `${job}.md`), buildJobHealthRecord({ job, status: 'OK', now: longAgo }).content);
  }
  const now = new Date('2026-11-02T00:00:00.000Z');
  const off = findStaleJobs(dir, { now, switchedOff: switchedOffJobs({ breakout: false }) }).map((s) => s.job);
  assert.deepEqual(off, ['media-archive']);
  const on = findStaleJobs(dir, { now, switchedOff: switchedOffJobs({ breakout: true }) }).map((s) => s.job).sort();
  assert.deepEqual(on, ['daily-breakout-signal-scan', 'execute-quant', 'media-archive']);
});

test('health-watcher: 끄기 전에 보낸 전략 잡 경고는 복구 알림 없이 지운다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'strategy-health-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'watcher.json');
  const queueFile = join(dir, 'deferred.json');
  writeFileSync(stateFile, JSON.stringify({
    'job:daily-breakout-signal-scan:silent': { firstSeenAt: 1, lastSentAt: 1, sentCount: 1 },
  }));
  const messages = [];
  await processHealthIssues([], { stateFile, queueFile, now: 2, switchedOff: switchedOffJobs({ breakout: false }),
    send: async (message) => { messages.push(message); return { ok: true, result: { message_id: 1 } }; } });
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), {});
  assert.deepEqual(messages, []);
});

test('주간 보고 스케줄: 꺼진 전략 일정은 빠지고 스위치 상태에 꺼짐 한 줄이 남는다', () => {
  const offSchedule = scheduleForSwitches(SCHEDULE, { breakout: false });
  assert.ok(SCHEDULE.some((s) => s.script === 'daily-breakout-signal-scan.mjs'));
  assert.ok(!offSchedule.some((s) => /breakout|quant/.test(s.script)));
  assert.equal(offSchedule.length, SCHEDULE.filter((s) => !/breakout|quant/.test(s.script)).length);
  assert.deepEqual(scheduleForSwitches(SCHEDULE, { breakout: true }), SCHEDULE);
  const status = describeSwitchStatus({ killSwitchContent: null, executionModeContent: null, proposalModeContent: null,
    strategySwitches: { breakout: false } });
  assert.match(status, /· 돌파매매: 꺼짐\(결정 전략-가동\)/);
  assert.doesNotMatch(describeSwitchStatus({ killSwitchContent: null, executionModeContent: null, proposalModeContent: null }), /돌파매매: /);
});
