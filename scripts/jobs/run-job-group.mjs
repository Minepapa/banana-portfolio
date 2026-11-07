#!/usr/bin/env node
/**
 * 무인잡 묶음 래퍼 — 묶음(scripts/lib/job-groups.mjs)의 단계를 순서대로 `bash run.sh <단계>`로 부른다(2026-11-07).
 *
 * 왜: 같은 목적의 잡이 분 단위로 쪼개져(예: 장후 장부 마감 9개가 15:50~16:11) 카탈로그·감시·로그를 따라가기
 * 어려웠다(오너 "시간별, 기능별로 묶을 수 있는 것 묶고"). 시각 간격으로 흉내 내던 순서를 한 잡의 순서로 바꾼다.
 *
 * 기존 스크립트는 고치지 않는다 — 단계마다 run.sh를 그대로 거치므로 PATH·NODE_OPTIONS·작업 디렉터리·하트비트
 * (JobHealth/<단계>.md)·연속 실패 알림이 예전 단독 잡과 같다. 로그도 단계 이름의 옛 파일에 이어 쓴다
 * (run.sh가 그 파일 줄 수로 하트비트 detail을 자르므로 같은 파일이어야 한다).
 *
 * 실패 격리(intraday-portfolio-sync와 같은 원칙): 한 단계가 실패하거나 상한을 넘겨도 다음 단계는 계속한다.
 * 예외는 requiresPrevious 단계뿐이다(바로 앞 단계가 실패하면 건너뜀). 종료 코드는 래퍼 자체 오류(단계를 띄우지 못함·
 * 상한 초과 강제 종료·내부 예외)일 때만 1이다 — 단계 실패는 단계 JobHealth가 드러낸다(이중 경보 방지). 마지막 줄의
 * "단계 n/m 성공, 실패: …"가 묶음 하트비트 detail(로그 끝 3줄)에 실린다.
 *
 * 인자를 받지 않는다 — 단계 스크립트마다 받는 인자가 달라 --dry-run을 그대로 넘기면 모르는 인자를 무시하고
 * 실제로 도는 스크립트가 있다(2026-10-31 관문 사고). 계획만 보려면 --plan(아무것도 실행하지 않음).
 *
 * 사용법:
 *   node scripts/jobs/run-job-group.mjs <묶음>          # launchd가 run.sh <묶음>으로 부른다
 *   node scripts/jobs/run-job-group.mjs <묶음> --plan   # 단계·상한만 출력
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOB_GROUPS } from '../lib/job-groups.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_SH = join(REPO, 'scripts', 'launchd', 'run.sh');
const LOG_DIR = join(homedir(), 'Library', 'Logs', 'banana-portfolio-v2'); // run.sh LOG_DIR과 같은 곳
const KILL_GRACE_MS = 10_000;

const sleepMs = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 상한 초과로 끝낸 단계는 run.sh가 하트비트를 못 남겼으므로 여기서 FAIL로 남긴다(연속 실패 알림도 그 경로 그대로).
function recordTimeoutHeartbeat(job, { group, timeoutMs, durationSec }) {
  spawnSync(process.execPath, [join(REPO, 'scripts', 'jobs', 'record-heartbeat-vault.mjs'), job, 'FAIL', String(durationSec)], {
    cwd: REPO, stdio: 'inherit',
    env: { ...process.env, HB_DETAIL: `묶음 ${group}: 단계 상한 ${Math.round(timeoutMs / 60000)}분 초과로 중단` },
  });
}

// 지금 도는 단계 프로세스 묶음(detached라 launchd의 묶음 정리 밖) — 래퍼가 SIGTERM·SIGINT를 받으면 같이 끝낸다(리뷰 MEDIUM).
const activeChildPids = new Set();
export function forwardTermination(signal, { pids = activeChildPids, kill = process.kill.bind(process) } = {}) {
  for (const pid of pids) { try { kill(-pid, 'SIGTERM'); } catch { /* 이미 끝남 */ } }
  return signal;
}

// 단계 하나를 실제로 돌린다: bash run.sh <단계>, 출력은 그 단계의 옛 로그 파일에 이어 쓴다.
// 상한을 넘기면 프로세스 묶음(bash + node 자식)을 SIGTERM → 10초 뒤 SIGKILL로 끝낸다.
export function spawnStep(job, { group, timeoutMs, runSh = RUN_SH, logDir = LOG_DIR, cwd = REPO,
  killGraceMs = KILL_GRACE_MS, recordTimeout = recordTimeoutHeartbeat } = {}) {
  mkdirSync(logDir, { recursive: true });
  const fd = openSync(join(logDir, `${job}.log`), 'a');
  const started = Date.now();
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    let child;
    try {
      child = spawn('/bin/bash', [runSh, job], {
        cwd, stdio: ['ignore', fd, fd], detached: true, env: { ...process.env, JOB_GROUP: group },
      });
    } catch {
      closeSync(fd);
      resolve({ code: 127, signal: null, timedOut: false, durationSec: 0, launchError: true });
      return;
    }
    activeChildPids.add(child.pid);
    const limitTimer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 이미 끝남 */ }
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 이미 끝남 */ } }, killGraceMs);
    }, timeoutMs) : null;
    const finish = (code, signal, launchError = false) => {
      if (settled) return;
      settled = true;
      activeChildPids.delete(child.pid);
      clearTimeout(limitTimer); clearTimeout(killTimer);
      closeSync(fd);
      const durationSec = Math.round((Date.now() - started) / 1000);
      if (timedOut) recordTimeout(job, { group, timeoutMs, durationSec });
      resolve({ code, signal, timedOut, durationSec, ...(launchError ? { launchError } : {}) });
    };
    child.on('error', () => finish(127, null, true));
    child.on('exit', (code, signal) => finish(code, signal));
  });
}

const normalizeSteps = (config) => (config.steps ?? []).map((step) => (typeof step === 'string' ? { job: step } : step));

function describeFailure(result) {
  if (result.launchError) return '띄우지 못함';
  if (result.deadline) return '마감 지남';
  if (result.timedOut) return '상한 초과';
  if (result.signal) return `signal ${result.signal}`;
  return `exit ${result.code}`;
}

// 묶음 실행 — runStep·sleep·log를 바꿔 끼워 단위 테스트한다(실제 단계는 부르지 않는다).
// KST 'HH:MM' — deadlineKst 판정용
const KST_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export async function runJobGroup(group, { groups = JOB_GROUPS, runStep = spawnStep, sleep = sleepMs, log = console.log,
  now = () => new Date() } = {}) {
  const config = groups[group];
  if (!config) throw new Error(`알 수 없는 묶음: ${group}`);
  const steps = normalizeSteps(config);
  const results = [];
  let previousOk = true;
  for (const [index, step] of steps.entries()) {
    if (index > 0 && config.gapMs) await sleep(config.gapMs);
    // 마감 시각(KST)을 넘기면 남은 단계는 시작하지 않는다 — 안전망 구간 밖에서 장중 동기화와 같은 스크립트가 겹치지 않게(리뷰 MEDIUM).
    if (config.deadlineKst && KST_HM.format(now()) >= config.deadlineKst) {
      log(`⏭ ${step.job} — 마감 ${config.deadlineKst} 지나 시작하지 않음(다음 동기화 회차가 이어받음)`);
      results.push({ job: step.job, status: 'FAIL', code: null, signal: null, timedOut: false, deadline: true });
      previousOk = false;
      continue;
    }
    if (step.requiresPrevious && !previousOk) {
      log(`⏭ ${step.job} — 앞 단계 실패로 건너뜀`);
      results.push({ job: step.job, status: 'SKIPPED' });
      previousOk = false;
      continue;
    }
    log(`▶ ${step.job}`);
    let result;
    try {
      result = await runStep(step.job, { group, timeoutMs: config.stepTimeoutMs ?? null });
    } catch (error) {
      result = { code: 1, signal: null, timedOut: false, durationSec: 0, launchError: true, error: error.message };
    }
    const ok = result.code === 0 && !result.timedOut;
    previousOk = ok;
    results.push({ job: step.job, status: ok ? 'OK' : 'FAIL', ...result });
    log(ok ? `  ✓ ${step.job} ${result.durationSec ?? '?'}s`
      : `  ⚠️ ${step.job} 실패(${describeFailure(result)}) — 다음 단계로 계속`);
  }
  // 묶음 하트비트는 래퍼 자체 오류(단계를 띄우지 못함·상한 초과 강제 종료·내부 예외)일 때만 실패다(제우스 2026-11-07).
  // 단계 실패는 단계 이름의 JobHealth·경보로만 드러난다 — 같은 원인 이중 경보, 회차마다 다른 단계 실패가 묶음 연속 실패로
  // 쌓이는 오경보를 막는다(독립 리뷰 MEDIUM). 마지막 줄(묶음 하트비트 detail)에는 단계 결과를 남긴다.
  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIPPED');
  const wrapperErrors = failed.filter((r) => r.launchError || r.timedOut);
  const okCount = results.length - failed.length - skipped.length;
  log(`${wrapperErrors.length ? '❌' : '✅'} 묶음 ${group} 단계 ${okCount}/${steps.length} 성공`
    + (failed.length ? `, 실패: ${failed.map((r) => `${r.job}(${describeFailure(r)})`).join(', ')}` : '')
    + (skipped.length ? `, 건너뜀: ${skipped.map((r) => r.job).join(', ')}` : ''));
  return { ok: wrapperErrors.length === 0, allStepsOk: failed.length === 0 && skipped.length === 0, results };
}

export function describePlan(group, groups = JOB_GROUPS) {
  const config = groups[group];
  if (!config) throw new Error(`알 수 없는 묶음: ${group}`);
  const limit = config.stepTimeoutMs ? `단계 상한 ${Math.round(config.stepTimeoutMs / 60000)}분` : '단계 상한 없음';
  return [`묶음 ${group} (${limit}${config.gapMs ? `, 단계 사이 ${config.gapMs / 1000}초` : ''})`,
    ...normalizeSteps(config).map((step, i) => `  ${i + 1}. ${step.job}${step.requiresPrevious ? ' (앞 단계 성공 시만)' : ''}`)];
}

async function main(argv) {
  const [group, ...rest] = argv;
  if (!group || !JOB_GROUPS[group]) {
    console.error(`사용법: run-job-group.mjs <${Object.keys(JOB_GROUPS).join('|')}> [--plan]`);
    process.exit(2);
  }
  if (rest.length === 1 && rest[0] === '--plan') { console.log(describePlan(group).join('\n')); return; }
  if (rest.length > 0) {
    console.error(`인자를 받지 않는다(단계로 넘기지 않음): ${rest.join(' ')} — 계획만 보려면 --plan`);
    process.exit(2);
  }
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => { forwardTermination(signal); process.exit(143); });
  }
  const { ok } = await runJobGroup(group);
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => { console.error(`❌ 묶음 오류: ${error.message}`); process.exit(1); });
}
