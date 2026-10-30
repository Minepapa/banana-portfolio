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

test('keyword-registration·close-work-doc 자동 반영과 clarify 안내 경로를 유지한다', () => {
  const source = readFileSync(new URL('./wiki-question-intake.mjs', import.meta.url), 'utf8');
  assert.match(source, /result\.action === 'approve' && \['keyword-registration', 'close-work-doc'\]\.includes\(result\.kind\)/);
  assert.match(source, /await applyWikiQuestion\(explicit\.questionId\)/);
  assert.match(source, /result\.action === 'clarify'/);
});

test('텔레그램 채널 변수가 없으면 main은 입력을 읽지 않고 즉시 반환한다', async () => {
  let reads = 0;
  const readInput = () => { reads += 1; return '{"prompt":""}'; };
  assert.equal(await main({ env: {}, readInput }), undefined);
  assert.equal(await main({ env: { CLAUDE_TELEGRAM_SESSION: '', CLAUDE_TELEGRAM_GATE: '' }, readInput }), undefined);
  assert.equal(reads, 0);
});

test('상시 세션만 입력을 읽는다 — 관문 헤드리스(GATE)는 WQ를 결정론으로 처리하므로 훅이 자동 적용하지 않는다(2026-10-30 2단계)', async () => {
  let reads = 0;
  // 빈 prompt라 질문 큐를 건드리지 않고 끝난다 — 입력을 읽었는지만 본다.
  await main({ env: { CLAUDE_TELEGRAM_SESSION: '1' }, readInput: () => { reads += 1; return '{"prompt":""}'; } });
  assert.equal(reads, 1);
  await main({ env: { CLAUDE_TELEGRAM_GATE: '1' }, readInput: () => { reads += 1; return '{"prompt":"WQ-20261030-abcd1234 등록"}'; } });
  assert.equal(reads, 1, '관문 실행에서는 읽지 않음');
});
