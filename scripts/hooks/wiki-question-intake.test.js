import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildManualChangeResultMessage, main } from './wiki-question-intake.mjs';

const QUESTION_ID = 'WQ-20260927-ABCDEF12';

test('manual-change 세 결과 전부 질문 본문 지시를 따르라고 안내한다', () => {
  for (const [action, status] of [['approve', '반영대기'], ['hold', '보류'], ['reject', '제외']]) {
    const message = buildManualChangeResultMessage({ questionId: QUESTION_ID, action, status });
    assert.match(message, /질문 본문에 이 결과.*에 대한 문서 변경 지시가 있으면 정확히 그대로 수행하고, 없으면 아무 것도 바꾸지 마라/);
  }
});

test('manual-change: approve만 complete 호출을 안내하고, hold·reject는 이미 종결이라 안내하지 않는다 — 큐 계약(completeManualWikiQuestion은 반영대기만 허용) 위반 방지', () => {
  const approveMessage = buildManualChangeResultMessage({ questionId: QUESTION_ID, action: 'approve', status: '반영대기' });
  assert.match(approveMessage, new RegExp(`complete --id=${QUESTION_ID}`));

  for (const [action, status] of [['hold', '보류'], ['reject', '제외']]) {
    const message = buildManualChangeResultMessage({ questionId: QUESTION_ID, action, status });
    assert.doesNotMatch(message, /complete --id=/);
    assert.match(message, /별도 complete 호출은 필요 없다/);
  }
});

test('keyword-registration 자동 반영과 clarify 안내 경로를 유지한다', () => {
  const source = readFileSync(new URL('./wiki-question-intake.mjs', import.meta.url), 'utf8');
  assert.match(source, /result\.action === 'approve' && result\.kind === 'keyword-registration'/);
  assert.match(source, /await applyWikiQuestion\(explicit\.questionId\)/);
  assert.match(source, /result\.action === 'clarify'/);
});

test('CLAUDE_TELEGRAM_SESSION이 없으면 main은 즉시 반환한다', async () => {
  const original = process.env.CLAUDE_TELEGRAM_SESSION;
  delete process.env.CLAUDE_TELEGRAM_SESSION;
  try {
    assert.equal(await main(), undefined);
  } finally {
    if (original === undefined) delete process.env.CLAUDE_TELEGRAM_SESSION;
    else process.env.CLAUDE_TELEGRAM_SESSION = original;
  }
});
