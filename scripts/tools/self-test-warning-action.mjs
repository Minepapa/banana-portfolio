#!/usr/bin/env node
// 분리된 자가테스트: 고정된 격리 테스트 파일만 실행한다. 실계좌·Telegram·실조회 없음.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_FILES = [
  fileURLToPath(new URL('../lib/warning-runbook.test.js', import.meta.url)),
  fileURLToPath(new URL('../lib/warning-action-plan.test.js', import.meta.url)),
  fileURLToPath(new URL('../lib/warning-action-executor.test.js', import.meta.url)),
  fileURLToPath(new URL('../jobs/process-warning-actions.test.js', import.meta.url)),
];

export function runWarningActionSelfTest({ exec = execFileSync } = {}) {
  try {
    exec(process.execPath, ['--test', ...TEST_FILES], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { passed: true, checks: TEST_FILES.length, realNetwork: false, actionTaken: false };
  } catch {
    return { passed: false, checks: TEST_FILES.length, realNetwork: false, actionTaken: false };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outcome = runWarningActionSelfTest();
  console.log(outcome.passed
    ? '경고 조치안 격리 자가테스트 통과 — 실조회·실조치 없음'
    : '경고 조치안 격리 자가테스트 실패 — 조치안 사용 보류');
  if (!outcome.passed) process.exitCode = 1;
}
