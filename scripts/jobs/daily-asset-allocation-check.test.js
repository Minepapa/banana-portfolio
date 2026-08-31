import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAllocationCheckFacts, buildAllocationCheckPrompt } from './daily-asset-allocation-check.mjs';

// 2026-08-31 신설 — 오너 지적("숫자만 던지고 LLM 해석이 도움 안 됨")으로 이 잡에
// LLM 해석(context·considerations)을 추가하며 함께 생긴 순수함수 테스트.

test('buildAllocationCheckFacts: macroReport 원문 전체를 fact 1개로(멀티라인 블록 그대로)', () => {
  const report = '[거시 전술 오버레이 점검]\n\n  VIX: 32.1\n    → [경고] 볼린저 이탈';
  const facts = buildAllocationCheckFacts(report);
  assert.equal(facts.length, 1);
  assert.match(facts[0], /^\[거시 전술 오버레이\]\n/);
  assert.match(facts[0], /VIX: 32\.1/);
});

test('buildAllocationCheckFacts: 앞뒤 공백은 trim됨', () => {
  const facts = buildAllocationCheckFacts('  \n숫자\n  ');
  assert.equal(facts[0], '[거시 전술 오버레이]\n숫자');
});

test('buildAllocationCheckPrompt: macroReport 원문을 포함하고 [맥락]·[생각해볼 점] 형식을 지시', () => {
  const prompt = buildAllocationCheckPrompt('VIX: 32.1\n→ [경고] 볼린저 이탈');
  assert.match(prompt, /VIX: 32\.1/);
  assert.match(prompt, /\[맥락\]/);
  assert.match(prompt, /\[생각해볼 점\]/);
});
