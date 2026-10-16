// buildArgs(argv 조립) 테스트 — spawn 없이 순수 검증.
// 계약: appendSystemPrompt 가 있으면 --append-system-prompt 로 추가(시스템 프롬프트 '추가',
// 교체 아님), 없으면 argv 는 종전과 완전 동일(하위호환 — 기존 호출부 동작 불변).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, headlessExitFailure, headlessJsonFailure } from './headless-claude.mjs';

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
