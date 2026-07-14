// buildArgs(argv 조립) 테스트 — spawn 없이 순수 검증.
// 계약: appendSystemPrompt 가 있으면 --append-system-prompt 로 추가(시스템 프롬프트 '추가',
// 교체 아님), 없으면 argv 는 종전과 완전 동일(하위호환 — 기존 호출부 동작 불변).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs } from './headless-claude.mjs';

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
