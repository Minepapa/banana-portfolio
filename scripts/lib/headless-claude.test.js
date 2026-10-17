// buildArgs(argv 조립) 테스트 — spawn 없이 순수 검증.
// 계약: appendSystemPrompt 가 있으면 --append-system-prompt 로 추가(시스템 프롬프트 '추가',
// 교체 아님), 없으면 argv 는 종전과 완전 동일(하위호환 — 기존 호출부 동작 불변).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { buildArgs, headlessExitFailure, headlessJsonFailure, headlessResult, runHeadlessClaude } from './headless-claude.mjs';

const BASE = ['-p', 'P', '--permission-mode', 'bypassPermissions', '--allowedTools', 'Read', '--model', 'sonnet', '--output-format', 'text'];

test('buildArgs: opts 없으면 종전 argv 그대로(하위호환)', () => {
  assert.deepEqual(buildArgs('P', 'sonnet', 'Read'), BASE);
  assert.deepEqual(buildArgs('P', 'sonnet', 'Read', {}), BASE);
});

test('buildArgs: appendSystemPrompt 있으면 --append-system-prompt 추가', () => {
  const args = buildArgs('P', 'sonnet', 'Read', { appendSystemPrompt: '# Athena 원칙' });
  assert.deepEqual(args, [...BASE, '--append-system-prompt', '# Athena 원칙']);
});

test('buildArgs: appendSystemPrompt 빈 문자열이면 추가 안 함(폴백 시 systemPrompt="")', () => {
  assert.deepEqual(buildArgs('P', 'sonnet', 'Read', { appendSystemPrompt: '' }), BASE);
});

test('buildArgs: tools 옵션은 --tools로 넘기고(빈 문자열 = 도구 전부 끔), 생략하면 붙이지 않는다', () => {
  const off = buildArgs('p', 'sonnet', 'Read', { tools: '' });
  assert.deepEqual(off.slice(-2), ['--tools', '']);
  assert.ok(!buildArgs('p', 'sonnet', 'Read').includes('--tools'));
});

test('buildArgs: 제한된 읽기와 턴 상한을 CLI 인자로 전달한다', () => {
  const args = buildArgs('P', 'sonnet', 'Read(//tmp/copies/**)', { maxTurns: 2 });
  assert.deepEqual(args.slice(2, 6), ['--permission-mode', 'bypassPermissions', '--allowedTools', 'Read(//tmp/copies/**)']);
  assert.deepEqual(args.slice(-2), ['--max-turns', '2']);
});

test('JSON 성공 종료에 담긴 quota 오류도 한도 오류로 분류한다', () => {
  const usage = { input_tokens: 12, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 5 };
  const error = headlessJsonFailure(JSON.stringify({ is_error: true, result: 'hit your session limit; resets 10:50am',
    usage, num_turns: 2, total_cost_usd: .004 }));
  assert.equal(error.isLimit, true);
  assert.deepEqual(error.usage, usage);
  assert.equal(error.num_turns, 2);
  assert.equal(error.total_cost_usd, .004);
  assert.equal(headlessJsonFailure('{"is_error":false,"result":"ok"}'), null);
});

test('비정상 종료 JSON stdout의 과금·한도 정보를 stderr보다 우선 보존한다', () => {
  const usage = { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 };
  const result = `hit your session limit; resets 10:50am ${'x'.repeat(350)}`;
  const error = headlessExitFailure(1, JSON.stringify({ is_error: true, result,
    usage, num_turns: 2, total_cost_usd: .012 }), 'unrelated stderr', true);
  assert.equal(error.isLimit, true);
  assert.deepEqual(error.usage, usage);
  assert.equal(error.num_turns, 2);
  assert.equal(error.total_cost_usd, .012);
  assert.match(error.limitDetail, /resets 10:50am/);
  assert.doesNotMatch(error.message, /session limit/);
  const fallback = headlessExitFailure(2, 'not json', 'no stdin data received\nreal stderr', true);
  assert.match(fallback.message, /claude 종료코드 2: real stderr/);
  assert.match(headlessExitFailure(3, 'stdout fallback', 'no stdin data received').message, /stdout fallback/);
});

test('lean 프리셋은 도구·MCP·권한·JSON 옵션을 CLI 인자로 고정한다', () => {
  const args = buildArgs('P', 'sonnet', 'Read(/tmp/copies/**),WebSearch', { lean: true, maxTurns: 2 });
  const value = flag => args[args.indexOf(flag) + 1];
  assert.equal(value('--permission-mode'), 'dontAsk');
  assert.equal(value('--allowedTools'), 'Read(/tmp/copies/**),WebSearch');
  assert.equal(value('--tools'), 'Read,WebSearch');
  assert.equal(value('--disallowedTools'), 'mcp__*');
  assert.equal(value('--mcp-config'), '{"mcpServers":{}}');
  assert.equal(value('--output-format'), 'json');
  assert.equal(value('--max-turns'), '2');
  assert.equal(value('--effort'), 'high');
  const mediumArgs = buildArgs('P', 'sonnet', '', { lean: true, effort: 'medium' });
  assert.equal(mediumArgs[mediumArgs.indexOf('--effort') + 1], 'medium');
  assert.ok(args.includes('--restricted'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(buildArgs('P', 'sonnet', '', { lean: true })[10], '--tools');
  assert.equal(buildArgs('P', 'sonnet', undefined, { lean: true })[5], '');
});

test('JSON envelope의 result를 기존 텍스트 파서 입력으로 복원한다', () => {
  assert.equal(headlessResult(JSON.stringify({ result: '```json\n{"ok":true}\n```', usage: { input_tokens: 2 } })),
    '```json\n{"ok":true}\n```');
  assert.throws(() => headlessResult('{"result":null}'), /claude 빈 출력/);
  assert.throws(() => headlessResult('null'), /claude 빈 출력/);
  assert.throws(() => headlessResult(JSON.stringify({ result: '  \n' })), /claude 빈 출력/);
});

test('result 없는 JSON 오류는 subtype과 errors를 전달한다', () => {
  const error = headlessJsonFailure(JSON.stringify({ is_error: true, subtype: 'error_max_turns', errors: ['WebSearch 초과'] }));
  assert.equal(error.subtype, 'error_max_turns');
  assert.match(error.message, /error_max_turns.*WebSearch 초과/);
});

test('lean 실행은 빈 임시 cwd를 쓰고 성공·오류 때 지우며 usage를 기록한다', async () => {
  const seen = [];
  const logs = [];
  const spawnImpl = (_command, _args, options) => {
    seen.push(options.cwd);
    assert.equal(existsSync(options.cwd), true);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ is_error: seen.length === 2, result: seen.length === 2 ? 'failure' : 'ok',
        usage: { input_tokens: 4, output_tokens: 2 } }));
      child.emit('close', 0);
    });
    return child;
  };
  const opts = { lean: true, maxTurns: 1, spawnImpl, usageLogger: message => logs.push(message) };
  assert.equal(headlessResult(await runHeadlessClaude('P', 'sonnet', '', opts)), 'ok');
  assert.equal(existsSync(seen[0]), false);
  await assert.rejects(runHeadlessClaude('P', 'sonnet', '', opts), /failure/);
  assert.equal(existsSync(seen[1]), false);
  assert.match(logs[0], /input_tokens/);
});
