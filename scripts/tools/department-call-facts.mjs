#!/usr/bin/env node
// 담당 사실 도구의 자기 선언을 읽고 기본 사실만 병렬 실행한다.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { factsFor } from '../lib/facts-catalog.mjs';

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
  catalog = factsFor,
  all = false,
  runner = runCommand,
  now = Date.now,
  totalMs = TOTAL_MS,
} = {}) {
  const { always, onRequest } = catalog(agent);
  // 입력이 필요한 도구(input)는 --all에서도 실행하지 않고 목록에만 남긴다.
  const selected = all ? [...always, ...onRequest.filter((entry) => !entry.input)] : always;
  const deadline = now() + totalMs;
  const controller = new AbortController();
  const settled = Promise.allSettled(selected.map(async ({ command }) => runner(command, totalMs, controller.signal)));
  let timer;
  const timedOut = new Promise((resolveTimeout) => {
    timer = setTimeout(() => {
      resolveTimeout(null);
      controller.abort();
    }, totalMs);
  });
  let outcomes;
  try {
    outcomes = await Promise.race([settled, timedOut]);
  } finally {
    clearTimeout(timer);
  }
  if (outcomes === null || now() > deadline) return { factsText: '', timedOut: true, onRequestText: '' };
  const sections = outcomes.map((outcome, index) => {
    const { command } = selected[index];
    if (outcome.status === 'fulfilled') {
      return `### ${command}\n${String(outcome.value).trim() || '(데이터 부족)'}`;
    }
    return `### ${command}\n[조회 실패: ${command} — ${failureReason(outcome.reason)}]`;
  });
  const onRequestText = onRequest.length
    ? onRequest.map(({ command, summary, input }) => `node scripts/tools/${command}${input ? ` ${input}` : ''} — ${summary}`).join('\n') : '';
  return { factsText: sections.join('\n\n'), timedOut: false, onRequestText };
}

let invokedPath;
if (process.argv[1]) {
  try { invokedPath = realpathSync(process.argv[1]); }
  catch { invokedPath = resolve(process.argv[1]); }
}
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  try {
    const [agent, flag] = process.argv.slice(2);
    if (!agent || (flag && flag !== '--all') || process.argv.length > 4) throw new Error('사용법: department-call-facts.mjs <agent> [--all]');
    const result = await departmentCallFacts(agent, { all: flag === '--all' });
    if (result.timedOut) throw new Error('담당 기본 사실 조회 시간 초과');
    process.stdout.write(`${result.factsText}${result.onRequestText ? `\n\n### 필요 시 추가 실행 목록\n${result.onRequestText}` : ''}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
