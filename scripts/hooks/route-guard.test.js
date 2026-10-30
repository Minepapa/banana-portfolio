import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReminder } from './route-guard.mjs';

const hookPath = fileURLToPath(new URL('./route-guard.mjs', import.meta.url));
const scriptsDir = dirname(dirname(hookPath));
const env = { ...process.env };
delete env.CLAUDE_TELEGRAM_SESSION;
delete env.CLAUDE_TELEGRAM_GATE;

function runHook(path, prompt) {
  return execFileSync(process.execPath, [path], {
    input: JSON.stringify({ prompt }), encoding: 'utf8', timeout: 3000, env,
  });
}

const catalog = (agent) => agent === 'hermes' ? { always: [], onRequest: [] } : { always: [{ command: 'rebalance-facts.mjs' }], onRequest: [{ command: 'stock-facts.mjs', summary: '종목 평가' }] };
const result = { onRequestText: 'node scripts/tools/stock-facts.mjs — 종목 평가', factsText: '### rebalance-facts.mjs\n비중 20%', timedOut: false };

test('텔레그램 담당 요청과 이름을 명시한 개발 세션에 사실을 붙인다', async () => {
  const calls = [];
  const factsForAgent = async (agent) => { calls.push(agent); return result; };
  const telegram = await routeReminder('리밸런싱 밴드 괜찮아?', { telegram: true, catalog, factsForAgent });
  assert.match(telegram, /\[판테온 라우팅\]/);
  assert.match(telegram, /\[자동 연결된 기본 사실 — 스폰 시 factsText로 그대로 전달\]/);
  assert.match(telegram, /비중 20%/);
  const named = await routeReminder('플루토스 리밸런싱 밴드 괜찮아?', { telegram: false, catalog, factsForAgent });
  assert.match(named, /비중 20%/);
  const english = await routeReminder('Plutus 리밸런싱 밴드 괜찮아?', { telegram: false, catalog, factsForAgent });
  assert.match(english, /비중 20%/);
  const alias = await routeReminder('카이로스 리밸런싱 밴드 괜찮아?', {
    telegram: false, catalog, factsForAgent,
  });
  assert.match(alias, /비중 20%/);
  assert.deepEqual(calls, ['plutus', 'plutus', 'plutus', 'plutus']);
});

test('텔레그램 channel 본문에서 담당을 부르면 기본 사실을 주입한다', async () => {
  const original = process.env.CLAUDE_TELEGRAM_SESSION;
  process.env.CLAUDE_TELEGRAM_SESSION = '1';
  try {
    const calls = [];
    const output = await routeReminder(
      '<channel source="plugin:telegram:telegram" user="클리오">플루토스 밴드 괜찮아?</channel>',
      { catalog, factsForAgent: async (agent) => { calls.push(agent); return result; } },
    );
    assert.match(output, /\[자동 연결된 기본 사실 — 스폰 시 factsText로 그대로 전달\]/);
    assert.match(output, /비중 20%/);
    assert.deepEqual(calls, ['plutus']);
  } finally {
    if (original === undefined) delete process.env.CLAUDE_TELEGRAM_SESSION;
    else process.env.CLAUDE_TELEGRAM_SESSION = original;
  }
});

test('개발 세션에서 담당 이름이 없으면 기존 리마인드만 출력한다', async () => {
  const output = await routeReminder('리밸런싱 밴드 괜찮아?', {
    telegram: false, catalog,
    factsForAgent: () => { throw new Error('실행되면 안 됨'); },
  });
  assert.match(output, /\[판테온 라우팅\]/);
  assert.doesNotMatch(output, /담당 기본 사실|직접 조회하라/);
});

test('조회 실패는 사실 안에 남기고 전체 시간 초과는 직접 조회 안내로 바꾼다', async () => {
  const failed = await routeReminder('플루토스 리밸런싱', {
    catalog, factsForAgent: async () => ({ factsText: '[조회 실패: rebalance-facts.mjs — 오류]', timedOut: false }),
  });
  assert.match(failed, /\[조회 실패: rebalance-facts\.mjs — 오류\]/);
  const timedOut = await routeReminder('플루토스 리밸런싱', {
    catalog, factsForAgent: async () => ({ factsText: '', timedOut: true }),
  });
  assert.match(timedOut, /node scripts\/tools\/department-call-facts\.mjs plutus로 직접 조회하라\./);
  assert.doesNotMatch(timedOut, /담당 기본 사실/);
});

test('실제 훅 프로세스는 코드 요청에 조용히 종료하고 담당 요청에는 기존 리마인드만 낸다', () => {
  assert.equal(runHook(hookPath, '코드 리팩터링 해줘'), '');
  const output = runHook(hookPath, '리밸런싱안 줘');
  assert.match(output, /^<system-reminder>\[판테온 라우팅\]/);
  assert.match(output, /<\/system-reminder>\n$/);
  assert.doesNotMatch(output, /담당 기본 사실|직접 조회하라/);
  assert.equal((output.match(/<system-reminder>/g) ?? []).length, 1);
});

test('공백·한글이 있는 임시 경로에 복사한 훅도 실제 프로세스에서 실행된다', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'route guard 한글 '));
  try {
    const copiedScriptsDir = join(temporaryRoot, 'scripts');
    const copiedHooksDir = join(copiedScriptsDir, 'hooks');
    mkdirSync(copiedHooksDir, { recursive: true });
    copyFileSync(hookPath, join(copiedHooksDir, 'route-guard.mjs'));
    symlinkSync(join(scriptsDir, 'lib'), join(copiedScriptsDir, 'lib'));
    symlinkSync(join(scriptsDir, 'tools'), join(copiedScriptsDir, 'tools'));
    assert.match(runHook(join(copiedHooksDir, 'route-guard.mjs'), '리밸런싱안 줘'), /\[판테온 라우팅\]/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('훅 입력 JSON 파싱 실패는 조용히 exit 0', () => {
  const output = execFileSync(process.execPath, [hookPath], {
    input: '{broken', encoding: 'utf8', timeout: 3000,
  });
  assert.equal(output, '');
});

test('중간 언급은 리마인드만, 앞 기호 뒤 호출은 사실을 붙인다', async () => {
  const runner = async () => result;
  const middle = await routeReminder('오늘 개발 세션에서 플루토스로 부르면?', { telegram: false, catalog, factsForAgent: runner });
  assert.doesNotMatch(middle, /자동 연결된 기본 사실/);
  const direct = await routeReminder('  · 플루토스 밴드 괜찮아?', { telegram: false, catalog, factsForAgent: runner });
  assert.match(direct, /자동 연결된 기본 사실/);
  assert.match(direct, /필요 시 추가 실행 목록/);
  const empty = await routeReminder('헤르메스 일정 조회', { telegram: true, catalog, factsForAgent: runner });
  assert.doesNotMatch(empty, /자동 연결된 기본 사실|필요 시 추가 실행 목록/);
});

test('telegram 인자를 생략하면 환경변수로 판정한다 — 관문 헤드리스(CLAUDE_TELEGRAM_GATE)도 텔레그램(2026-10-30)', async () => {
  const saved = { session: process.env.CLAUDE_TELEGRAM_SESSION, gate: process.env.CLAUDE_TELEGRAM_GATE };
  const factsForAgent = async () => result;
  try {
    delete process.env.CLAUDE_TELEGRAM_SESSION;
    delete process.env.CLAUDE_TELEGRAM_GATE;
    const plain = await routeReminder('리밸런싱 밴드 괜찮아?', { catalog, factsForAgent });
    assert.doesNotMatch(plain, /비중 20%/, '오너 대화형 세션은 담당 이름 없이 사실을 붙이지 않음');
    process.env.CLAUDE_TELEGRAM_GATE = '1';
    assert.match(await routeReminder('리밸런싱 밴드 괜찮아?', { catalog, factsForAgent }), /비중 20%/);
    delete process.env.CLAUDE_TELEGRAM_GATE;
    process.env.CLAUDE_TELEGRAM_SESSION = '1';
    assert.match(await routeReminder('리밸런싱 밴드 괜찮아?', { catalog, factsForAgent }), /비중 20%/);
  } finally {
    for (const [key, value] of [['CLAUDE_TELEGRAM_SESSION', saved.session], ['CLAUDE_TELEGRAM_GATE', saved.gate]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
