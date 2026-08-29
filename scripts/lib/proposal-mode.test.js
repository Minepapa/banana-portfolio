import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProposalModeState, getProposalMode, isProposalBlocked, MODE_ALLOWED, MODE_BLOCKED } from './proposal-mode.mjs';

test('getProposalMode: 파일 없으면(content null) 안전한 기본값(허용)', () => {
  assert.equal(getProposalMode(null), MODE_ALLOWED);
});

test('getProposalMode: 기대 밖 값이 파싱되면 허용으로 폴백', () => {
  assert.equal(getProposalMode('---\nmode: "이상한값"\n---\n'), MODE_ALLOWED);
});

test('buildProposalModeState → getProposalMode 왕복', () => {
  const content = buildProposalModeState({ mode: MODE_BLOCKED, reason: 'Frank 명령: "제안금지"' });
  assert.equal(getProposalMode(content), MODE_BLOCKED);
  assert.ok(content.includes('제안금지'));
});

test('buildProposalModeState: 허용되지 않은 mode 값은 throw', () => {
  assert.throws(() => buildProposalModeState({ mode: '금지됨' }));
});

test('isProposalBlocked: 금지 상태만 true', () => {
  assert.equal(isProposalBlocked(buildProposalModeState({ mode: MODE_BLOCKED })), true);
  assert.equal(isProposalBlocked(buildProposalModeState({ mode: MODE_ALLOWED })), false);
  assert.equal(isProposalBlocked(null), false);
});
