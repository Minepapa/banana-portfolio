#!/usr/bin/env node
// 담당 호출 전에 헌장에 등록된 읽기 전용 facts CLI를 실행한다.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentDefaultFacts } from '../lib/agent-registry.mjs';
import { validateDefaultFacts } from './build-agent-defs.mjs';

const execFileAsync = promisify(execFile);
const toolsDir = dirname(fileURLToPath(import.meta.url));
const TOTAL_MS = 6800;

async function runCommand(command, timeoutMs, signal) {
  const [filename, ...args] = command.split(' ');
  const { stdout } = await execFileAsync(process.execPath, [join(toolsDir, filename), ...args], {
    timeout: timeoutMs,
    signal,
    maxBuffer: 256 * 1024,
    cwd: join(toolsDir, '..', '..'),
  });
  return stdout;
}

function failureReason(error) {
  if (error?.killed || error?.code === 'ETIMEDOUT') return '시간 초과';
  return String(error?.stderr || error?.message || '알 수 없는 오류').trim().split('\n').at(-1).slice(0, 180);
}

export async function departmentCallFacts(agent, {
  commands = agentDefaultFacts(agent),
  runner = runCommand,
  now = Date.now,
  totalMs = TOTAL_MS,
} = {}) {
  // 생성물도 실행 전에 재검증한다. 쉘은 사용하지 않는다.
  const allowed = validateDefaultFacts(commands, agent);
  const deadline = now() + totalMs;
  const controller = new AbortController();
  const settled = Promise.allSettled(allowed.map(async (command) => runner(command, totalMs, controller.signal)));
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
      controller.abort();
    }, totalMs);
  });
  let outcomes;
  try {
    outcomes = await Promise.race([settled, timedOut]);
  } finally {
    clearTimeout(timer);
  }
  if (outcomes === null || now() > deadline) return { factsText: '', timedOut: true };
  const sections = outcomes.map((outcome, index) => {
    const command = allowed[index];
    if (outcome.status === 'fulfilled') {
      return `### ${command}\n${String(outcome.value).trim() || '(데이터 부족)'}`;
    }
    return `### ${command}\n[조회 실패: ${command} — ${failureReason(outcome.reason)}]`;
  });
  return { factsText: sections.join('\n\n'), timedOut: false };
}

let invokedPath;
if (process.argv[1]) {
  try {
    invokedPath = realpathSync(process.argv[1]);
  } catch {
    invokedPath = resolve(process.argv[1]);
  }
}
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  try {
    const agent = process.argv[2];
    if (!agent || process.argv.length !== 3) throw new Error('사용법: department-call-facts.mjs <agent>');
    const result = await departmentCallFacts(agent);
    if (result.timedOut) throw new Error('담당 기본 사실 조회 시간 초과');
    process.stdout.write(`${result.factsText}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
