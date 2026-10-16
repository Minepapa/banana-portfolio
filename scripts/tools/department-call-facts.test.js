import { test } from 'node:test';
import assert from 'node:assert/strict';
import { departmentCallFacts } from './department-call-facts.mjs';

const commands = ['rebalance-facts.mjs', 'macro-overlay-facts.mjs --dry-run', 'ledger-facts.mjs'];

test('기본 사실을 등록 순서로 하나의 factsText로 묶는다', async () => {
  const calls = [];
  const result = await departmentCallFacts('plutus', {
    commands,
    runner: async (command, timeoutMs) => {
      calls.push({ command, timeoutMs });
      return `결과 ${command}\n`;
    },
  });
  assert.deepEqual(calls, commands.map((command) => ({ command, timeoutMs: 6800 })));
  assert.match(result.factsText, /### rebalance-facts\.mjs\n결과 rebalance-facts\.mjs/);
  assert.ok(result.factsText.indexOf('rebalance-facts.mjs') < result.factsText.indexOf('macro-overlay-facts.mjs'));
  assert.equal(result.timedOut, false);
});

test('한 명령의 실패만 표시하고 다른 명령의 결과를 유지한다', async () => {
  const result = await departmentCallFacts('plutus', {
    commands,
    runner: async (command) => {
      if (command.startsWith('macro-')) throw new Error('network unavailable');
      return '조회값';
    },
  });
  assert.match(result.factsText, /\[조회 실패: macro-overlay-facts\.mjs --dry-run — network unavailable\]/);
  assert.match(result.factsText, /### ledger-facts\.mjs\n조회값/);
});

test('한 명령의 시간 초과는 해당 항목에만 표시한다', async () => {
  const result = await departmentCallFacts('plutus', {
    commands,
    runner: async (command) => {
      if (command.startsWith('macro-')) throw Object.assign(new Error('timed out'), { killed: true });
      return '조회값';
    },
  });
  assert.equal(result.timedOut, false);
  assert.match(result.factsText, /### rebalance-facts\.mjs\n조회값/);
  assert.match(result.factsText, /\[조회 실패: macro-overlay-facts\.mjs --dry-run — 시간 초과\]/);
  assert.match(result.factsText, /### ledger-facts\.mjs\n조회값/);
});

test('느린 명령이 다른 명령의 실행과 결과를 막지 않는다', async () => {
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  const completed = [];
  const resultPromise = departmentCallFacts('plutus', {
    commands,
    runner: async (command) => {
      if (command.startsWith('macro-')) await slow;
      completed.push(command);
      return `결과 ${command}`;
    },
  });
  try {
    await Promise.resolve();
    assert.deepEqual(completed, [commands[0], commands[2]]);
  } finally {
    releaseSlow();
  }
  const result = await resultPromise;
  assert.ok(result.factsText.indexOf(commands[1]) < result.factsText.indexOf(commands[2]));
  assert.equal(result.timedOut, false);
});

test('전체 제한을 넘으면 부분 사실을 버리고 시간 초과를 알린다', async () => {
  let elapsed = 0;
  const result = await departmentCallFacts('plutus', {
    commands,
    now: () => elapsed,
    totalMs: 7,
    runner: async () => { elapsed += 8; return '늦은 값'; },
  });
  assert.deepEqual(result, { factsText: '', timedOut: true });
});

test('전체 제한 시간이 지나면 끝나지 않는 명령을 중단하고 조회를 종료한다', { timeout: 1000 }, async () => {
  let aborted = false;
  const result = await departmentCallFacts('plutus', {
    commands,
    totalMs: 20,
    runner: async (command, _timeoutMs, signal) => {
      if (command.startsWith('macro-')) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          }, { once: true });
        });
      }
      return '조회값';
    },
  });
  assert.deepEqual(result, { factsText: '', timedOut: true });
  assert.equal(aborted, true);
});
