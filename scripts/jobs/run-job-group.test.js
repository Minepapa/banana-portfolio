// 무인잡 묶음 래퍼·묶음 정본 테스트(2026-11-07). 실제 단계 잡은 부르지 않는다 — 순서·격리는 가짜 runStep으로,
// 프로세스 상한은 임시 폴더의 가짜 run.sh로 본다(볼트·증권사·텔레그램 접근 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOB_GROUPS, groupOfStep, groupSteps } from '../lib/job-groups.mjs';
import { listDispatchedJobs, listPlistJobs, listRetiredPlistJobs } from '../lib/launchd-jobs.mjs';
import { EXPECTED_INTERVALS_MS } from '../lib/job-schedule.mjs';
import { isSafetyNetWindow } from '../lib/poll-schedule.mjs';
import { describePlan, runJobGroup, spawnStep } from './run-job-group.mjs';

const fakeGroups = {
  g: { steps: ['a', 'b', { job: 'c', requiresPrevious: true }, 'd'], stepTimeoutMs: 1000, gapMs: 5 },
};

function fakeRunner(outcomes) {
  const calls = [];
  const runStep = async (job, options) => { calls.push({ job, ...options }); return { code: 0, signal: null, timedOut: false, durationSec: 1, ...outcomes[job] }; };
  return { calls, runStep };
}

test('runJobGroup: 단계를 정의 순서대로 하나씩, 묶음 이름·상한을 넘겨 부른다', async () => {
  const { calls, runStep } = fakeRunner({});
  const sleeps = [];
  const { ok, results } = await runJobGroup('g', { groups: fakeGroups, runStep, sleep: async (ms) => { sleeps.push(ms); }, log: () => {} });
  assert.equal(ok, true);
  assert.deepEqual(calls.map((c) => c.job), ['a', 'b', 'c', 'd']);
  assert.ok(calls.every((c) => c.group === 'g' && c.timeoutMs === 1000));
  assert.deepEqual(results.map((r) => r.status), ['OK', 'OK', 'OK', 'OK']);
  assert.deepEqual(sleeps, [5, 5, 5]); // 단계 사이에만 쉰다
});

test('runJobGroup: 한 단계가 실패해도 다음 단계는 돌고, 전체는 실패, 마지막 줄에 실패 단계 이름', async () => {
  const { calls, runStep } = fakeRunner({ a: { code: 1 } });
  const lines = [];
  const { ok, results } = await runJobGroup('g', { groups: { g: { steps: ['a', 'b'] } }, runStep, sleep: async () => {}, log: (l) => lines.push(l) });
  assert.equal(ok, false);
  assert.deepEqual(calls.map((c) => c.job), ['a', 'b']);
  assert.deepEqual(results.map((r) => r.status), ['FAIL', 'OK']);
  assert.match(lines.at(-1), /❌ 묶음 g 1\/2단계 정상 — 실패: a\(exit 1\)/);
});

test('runJobGroup: requiresPrevious 단계는 바로 앞 단계가 실패하면 건너뛰고, 그 뒤 단계는 계속', async () => {
  const { calls, runStep } = fakeRunner({ b: { code: 2 } });
  const lines = [];
  const { ok, results } = await runJobGroup('g', { groups: fakeGroups, runStep, sleep: async () => {}, log: (l) => lines.push(l) });
  assert.equal(ok, false);
  assert.deepEqual(calls.map((c) => c.job), ['a', 'b', 'd']);
  assert.deepEqual(results.map((r) => r.status), ['OK', 'FAIL', 'SKIPPED', 'OK']);
  assert.match(lines.at(-1), /실패: b\(exit 2\) · 건너뜀: c/);
});

test('runJobGroup: 상한 초과·신호 종료·runStep 예외도 실패로 세고 계속한다', async () => {
  const runStep = async (job) => {
    if (job === 'a') return { code: null, signal: 'SIGTERM', timedOut: true, durationSec: 1 };
    if (job === 'b') return { code: null, signal: 'SIGKILL', timedOut: false, durationSec: 1 };
    throw new Error('spawn 실패');
  };
  const lines = [];
  const { ok, results } = await runJobGroup('g', { groups: { g: { steps: ['a', 'b', 'x'] } }, runStep, sleep: async () => {}, log: (l) => lines.push(l) });
  assert.equal(ok, false);
  assert.deepEqual(results.map((r) => r.status), ['FAIL', 'FAIL', 'FAIL']);
  assert.match(lines.at(-1), /a\(상한 초과\), b\(signal SIGKILL\), x\(exit 1\)/);
});

test('runJobGroup: 모르는 묶음은 예외, describePlan은 단계·상한을 보여 준다', async () => {
  await assert.rejects(runJobGroup('없는-묶음', { groups: fakeGroups }), /알 수 없는 묶음/);
  const plan = describePlan('g', fakeGroups);
  assert.match(plan[0], /묶음 g \(단계 상한/);
  assert.match(plan[3], /c \(앞 단계 성공 시만\)/);
});

// 실제 프로세스: 가짜 run.sh가 단계 이름의 로그 파일에 쓰고, 상한을 넘기면 자식까지 함께 끝나며 하트비트 기록 함수가 불린다.
test('spawnStep: 단계 로그 파일에 이어 쓰고 종료 코드·JOB_GROUP을 넘긴다, 상한 초과는 프로세스 묶음째 끝낸다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'run-job-group-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runSh = join(dir, 'run.sh');
  writeFileSync(runSh, [
    '#!/bin/bash',
    'echo "step=$1 group=$JOB_GROUP"',
    'if [ "$1" = slow ]; then sleep 30 & wait; fi',
    'if [ "$1" = bad ]; then exit 3; fi',
    'exit 0',
  ].join('\n'));
  chmodSync(runSh, 0o755);
  const recorded = [];
  const recordTimeout = (job, info) => recorded.push({ job, ...info });
  const common = { group: 'gg', runSh, logDir: dir, cwd: dir, killGraceMs: 200, recordTimeout };
  writeFileSync(join(dir, 'ok.log'), 'old line\n');
  assert.deepEqual((await spawnStep('ok', { ...common, timeoutMs: 5000 })).code, 0);
  assert.equal(readFileSync(join(dir, 'ok.log'), 'utf8'), 'old line\nstep=ok group=gg\n');
  assert.equal((await spawnStep('bad', { ...common, timeoutMs: null })).code, 3);
  const started = Date.now();
  const slow = await spawnStep('slow', { ...common, timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - started < 5000, '상한을 넘기면 바로 끝나야 함');
  assert.deepEqual(recorded.map((r) => [r.job, r.group, r.timeoutMs]), [['slow', 'gg', 300]]);
});

// ── 묶음 정본 불변식(scripts/lib/job-groups.mjs 머리 주석) ──
const LAUNCHD = new URL('../launchd/', import.meta.url);
const plistText = (job) => readFileSync(new URL(`com.banana2.${job}.plist`, LAUNCHD), 'utf8');
const plistMinutes = (job) => [...plistText(job).matchAll(/<key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((m) => Number(m[1]));
const plistHourMinutes = (job) => [...plistText(job).matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/g)]
  .map((m) => [Number(m[1]), Number(m[2])]);

test('묶음: 단계는 run.sh가 디스패치하는 잡이고, 한 묶음에만 있고, 묶음 이름과 겹치지 않는다', () => {
  const dispatched = new Set(listDispatchedJobs());
  const seen = new Map();
  for (const group of Object.keys(JOB_GROUPS)) {
    for (const { job } of groupSteps(group)) {
      assert.ok(dispatched.has(job), `${group}: run.sh에 없는 단계 ${job}`);
      assert.ok(!(job in JOB_GROUPS), `${group}: 묶음 안에 묶음 ${job}`);
      assert.ok(!seen.has(job), `${job}: ${seen.get(job)}와 ${group} 두 묶음에 있음`);
      seen.set(job, group);
      assert.equal(groupOfStep(job), group);
    }
  }
  assert.equal(groupOfStep('health-watcher'), null);
});

test('묶음: run.sh가 래퍼로 디스패치하고, 묶음 plist가 run.sh <묶음>·<묶음>.log로 등록돼 있다', () => {
  const runSh = readFileSync(new URL('run.sh', LAUNCHD), 'utf8');
  const plists = new Set(listPlistJobs());
  for (const group of Object.keys(JOB_GROUPS)) {
    assert.match(runSh, new RegExp(`^\\s*${group}\\) CMD=\\(scripts/jobs/run-job-group\\.mjs ${group}\\) ;;`, 'm'));
    assert.ok(plists.has(group), `${group}: 운영 plist 없음`);
    const xml = plistText(group);
    assert.match(xml, new RegExp(`<string>com\\.banana2\\.${group}</string>`));
    assert.match(xml, new RegExp(`<string>/Users/huinique/Pantheon/Repos/banana-portfolio-v2/scripts/launchd/run\\.sh</string>\\s*<string>${group}</string>\\s*</array>`));
    assert.match(xml, new RegExp(`<key>StandardOutPath</key>\\s*<string>[^<]*/banana-portfolio-v2/${group}\\.log</string>`));
    assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/huinique\/Pantheon\/Repos\/banana-portfolio-v2<\/string>/);
    assert.ok(Number.isFinite(EXPECTED_INTERVALS_MS[group]), `${group}: 기대 주기 없음`);
  }
});

test('묶음: 단계의 옛 plist는 retired/에만 있다(운영 plist가 남으면 같은 스크립트가 두 번 돈다)', () => {
  const active = new Set(listPlistJobs());
  const retired = new Set(listRetiredPlistJobs());
  for (const group of Object.keys(JOB_GROUPS)) {
    for (const { job } of groupSteps(group)) {
      assert.ok(!active.has(job), `${job}: 운영 plist가 남아 있음(묶음 ${group}과 중복 실행)`);
      assert.ok(retired.has(job), `${job}: retired/에 옛 plist가 없음(되돌리기 불가)`);
    }
  }
});

test('묶음: 고정 분 묶음은 10분 주기 슬롯(시세 :x0·급변 :x3·동기화 :x5)을 피한다', () => {
  for (const group of Object.keys(JOB_GROUPS)) {
    if (!existsSync(new URL(`com.banana2.${group}.plist`, LAUNCHD))) continue;
    for (const minute of plistMinutes(group)) {
      assert.ok(![0, 3, 5].includes(minute % 10), `${group}: ${minute}분은 10분 주기 슬롯`);
    }
  }
});

test('묶음 A(ledger-close): 평일 1회, 시작 분이 안전망 구간 안이라 동기화 회차와 겹치지 않는다', () => {
  const runs = plistHourMinutes('ledger-close');
  assert.equal(runs.length, 5);
  assert.deepEqual([...plistText('ledger-close').matchAll(/<key>Weekday<\/key><integer>(\d)<\/integer>/g)].map((m) => Number(m[1])), [1, 2, 3, 4, 5]);
  for (const [hour, minute] of runs) {
    const at = new Date(`2026-11-09T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`); // 월요일
    assert.equal(isSafetyNetWindow(at), true);
    // 묶음은 실측 10초 안팎 — 4분 뒤에도 구간 안이어야 동기화(:x5)가 같은 스크립트를 동시에 돌리지 않는다.
    assert.equal(isSafetyNetWindow(new Date(at.getTime() + 4 * 60_000)), true);
  }
  // 장부 순서: 체결 감지 → 보유 반영 → 예수금, 펀드 적립 맨 뒤(옛 시각 순서)
  const order = groupSteps('ledger-close').map((s) => s.job);
  assert.ok(order.indexOf('reconcile-nh-executions') < order.indexOf('update-holdings-from-executions'));
  assert.ok(order.indexOf('reconcile-irp-executions') < order.indexOf('update-holdings-from-executions'));
  assert.ok(order.indexOf('update-holdings-from-executions') < order.indexOf('update-cash-from-ledger'));
  assert.equal(order.at(-1), 'update-fund-holdings-from-purchases');
  assert.ok(!order.includes('intraday-portfolio-sync'), '안전망은 장중 동기화와 독립이어야 함');
});

test('묶음 B(post-close-reports): 평일 A 뒤, 분기·월 단계는 스크립트 안 날짜 판정이 LLM 호출 전에 막는다', () => {
  const [[aHour, aMinute]] = plistHourMinutes('ledger-close');
  const runs = plistHourMinutes('post-close-reports');
  assert.equal(runs.length, 5);
  for (const [hour, minute] of runs) assert.ok(hour * 60 + minute > aHour * 60 + aMinute + 5, 'A가 끝난 뒤여야 함');
  assert.deepEqual(groupSteps('post-close-reports').map((s) => s.job),
    ['new-cash-allocation', 'daily-execution-report', 'daily-asset-allocation-check', 'rebalance-proposal', 'monthly-macro-tilt-proposal']);
  // 매 평일 불려도 해당일에만 판단하는 근거 — 날짜 판정이 main 맨 앞(loadEnv·LLM 전)에 있어야 한다.
  for (const [file, gate] of [['rebalance-proposal.mjs', 'shouldRunToday'], ['monthly-macro-tilt-proposal.mjs', 'shouldRunThisMonth']]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const main = source.slice(source.indexOf('async function main()'));
    assert.ok(main.indexOf(`!FORCE && !${gate}(`) > 0, `${file}: 날짜 판정 없음`);
    assert.ok(main.indexOf(`!FORCE && !${gate}(`) < main.indexOf('runHeadlessClaude'), `${file}: 날짜 판정이 LLM 호출보다 뒤`);
  }
});

test('묶음 C(nightly-close): 매일 자정 전 시작, 스냅샷 → 볼트 백업 → 외부 백업 → 음성 백업', () => {
  assert.deepEqual(plistHourMinutes('nightly-close'), [[23, 51]]);
  assert.doesNotMatch(plistText('nightly-close'), /<key>Weekday<\/key>/);
  assert.deepEqual(groupSteps('nightly-close').map((s) => s.job),
    ['update-monthly-balance-snapshot', 'backup-vault', 'vault-offsite-backup', 'media-audio-offsite-backup']);
});

test('묶음 D(media-hourly): 매시간 보관 → 순간 노트(보관 실패 시 건너뜀), 묶음 안에서는 run.sh의 보관 선행 특례가 꺼진다', () => {
  assert.match(plistText('media-hourly'), /<key>StartInterval<\/key>\s*<integer>3600<\/integer>/);
  assert.deepEqual(groupSteps('media-hourly'), [{ job: 'media-archive' }, { job: 'media-moments', requiresPrevious: true }]);
  assert.equal(JOB_GROUPS['media-hourly'].stepTimeoutMs, null); // 잠금 있는 긴 작업 — 옛 plist처럼 상한 없음
  const runSh = readFileSync(new URL('run.sh', LAUNCHD), 'utf8');
  assert.match(runSh, /if \[ "\$JOB" = media-moments \] && \[ "\$#" -eq 0 \] && \[ -z "\$\{JOB_GROUP:-\}" \]; then/);
});

test('묶음 F(premarket-cache): 평일 07:06, 거시지표 → 휴장일 캐시, 휴장일 소비자(09:03 이후)보다 앞', () => {
  const runs = plistHourMinutes('premarket-cache');
  assert.deepEqual(runs, Array(5).fill([7, 6]));
  assert.deepEqual(groupSteps('premarket-cache').map((s) => s.job), ['update-macro-indicators-cache', 'update-krx-trading-calendar']);
});
