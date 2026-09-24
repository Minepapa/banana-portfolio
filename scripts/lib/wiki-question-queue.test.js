import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const vaultRoot = mkdtempSync(join(tmpdir(), 'wiki-question-vault-'));
process.env.VAULT_PATH = vaultRoot;

const {
  applyWikiQuestion,
  completeManualWikiQuestion,
  createWikiQuestion,
  listPendingWikiQuestions,
  parseExplicitWikiAnswer,
  reconcileWikiQuestion,
  resolveWikiQuestion,
  resendWikiQuestion,
} = await import('./wiki-question-queue.mjs');

function putVaultNote(relativePath, content = '---\ntype: "knowledge"\naliases: []\nrelated: []\n---\n\n# Note\n') {
  const filepath = join(vaultRoot, `${relativePath}.md`);
  mkdirSync(join(filepath, '..'), { recursive: true });
  writeFileSync(filepath, content);
  return filepath;
}

function keywordInput() {
  return {
    kind: 'keyword-registration',
    question: "'예시 키워드'를 정본으로 등록할까요? 색인, 별칭, 근거 노트 링크를 추가합니다.",
    evidenceNotes: ['Knowledge/Meta/evidence'],
    changePlan: {
      type: 'register-keyword',
      standardTerm: '예시 키워드',
      aliases: ['예시어'],
      canonicalNote: 'Knowledge/Topics/예시-키워드',
      indexSection: '시스템과 기술',
      answerGuidance: '질문은 정본을 우선 확인합니다.',
      backlinkNotes: ['Knowledge/Meta/evidence'],
    },
  };
}

function createIndex() {
  putVaultNote('Knowledge/Index', [
    '# Index',
    '',
    '## 시스템과 기술',
    '| 표준 키워드 | 별칭·검색어 | 정본 또는 탐색 페이지 | 답변 시 확인 |',
    '| --- | --- | --- | --- |',
    '',
  ].join('\n'));
}

function backdateQuestion(questionId) {
  const filepath = join(vaultRoot, 'State', 'WikiQuestions', `${questionId}.md`);
  const content = readFileSync(filepath, 'utf8').replace(/expiresAt: "[^"]+"/, 'expiresAt: "2000-01-01T00:00:00.000Z"');
  writeFileSync(filepath, content);
  return filepath;
}

test('질문 생성은 발송 전에 영속화하고 중복 질문은 재발송하지 않으며 ID 답변을 회수한다', async () => {
  try {
    putVaultNote('Knowledge/Meta/evidence');
    createIndex();
    putVaultNote('Knowledge/Topics/예시-키워드');
    let sendCount = 0;
    const sender = async () => ({ result: { message_id: ++sendCount } });

    const first = await createWikiQuestion(keywordInput(), { sender });
    const duplicate = await createWikiQuestion(keywordInput(), { sender });
    assert.match(first.questionId, /^WQ-\d{8}-[0-9A-F]{8}$/);
    assert.equal(first.status, '답변대기');
    assert.equal(first.sent, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(sendCount, 1);
    assert.ok(readFileSync(join(vaultRoot, 'State', 'WikiQuestions', `${first.questionId}.md`), 'utf8').includes('예시 키워드'));

    const cli = fileURLToPath(new URL('../tools/wiki-question-cli.mjs', import.meta.url));
    const restartedPending = execFileSync(process.execPath, [cli, 'pending'], {
      encoding: 'utf8', env: { ...process.env, VAULT_PATH: vaultRoot },
    });
    assert.equal(JSON.parse(restartedPending)[0].questionId, first.questionId, '별도 CLI 프로세스에서도 디스크 대기열을 복원해야 함');
    const hook = fileURLToPath(new URL('../hooks/wiki-question-intake.mjs', import.meta.url));
    const ambiguousContext = execFileSync(process.execPath, [hook], {
      input: JSON.stringify({ prompt: '등록' }), encoding: 'utf8',
      env: { ...process.env, VAULT_PATH: vaultRoot, CLAUDE_TELEGRAM_SESSION: '1' },
    });
    assert.match(ambiguousContext, new RegExp(first.questionId));
    assert.match(ambiguousContext, /정확한 ID|정확한 질문 ID/);
    assert.equal((await resolveWikiQuestion(first.questionId, '그렇게 해주세요')).action, 'clarify', '자유응답은 승인으로 추정하지 않아야 함');
    assert.match(readFileSync(join(vaultRoot, 'State', 'WikiQuestions', `${first.questionId}.md`), 'utf8'), /clarifications: \[.*그렇게 해주세요/);
    assert.equal((await listPendingWikiQuestions()).some((q) => q.questionId === first.questionId), true, '모호한 답은 대기 상태를 유지해야 함');

    const explicitClarification = `${first.questionId} 이번엔 보류할게요, 자료를 더 보고 싶어요`;
    assert.deepEqual(parseExplicitWikiAnswer(explicitClarification), {
      questionId: first.questionId, answer: '이번엔 보류할게요, 자료를 더 보고 싶어요', rawText: explicitClarification,
    });
    const clarificationContext = execFileSync(process.execPath, [hook], {
      input: JSON.stringify({ prompt: explicitClarification }), encoding: 'utf8',
      env: { ...process.env, VAULT_PATH: vaultRoot, CLAUDE_TELEGRAM_SESSION: '1' },
    });
    assert.match(clarificationContext, /답변 선택이 명확하지 않아 상태를 바꾸지 않았다/);
    const clarifiedRecord = readFileSync(join(vaultRoot, 'State', 'WikiQuestions', `${first.questionId}.md`), 'utf8');
    assert.match(clarifiedRecord, /clarifications: \[.*자료를 더 보고 싶어요/);
    assert.match(clarifiedRecord, /status: "답변대기"/);

    const explicitText = `${first.questionId} 등록`;
    assert.deepEqual(parseExplicitWikiAnswer(explicitText), {
      questionId: first.questionId, answer: '등록', rawText: explicitText,
    });
    const resolved = await resolveWikiQuestion(first.questionId, '등록', { rawText: explicitText });
    assert.equal(resolved.status, '승인');
    assert.equal(readFileSync(join(vaultRoot, 'State', 'WikiQuestions', `${first.questionId}.md`), 'utf8').includes(`answerRaw: "${explicitText}"`), true);
    const applied = await applyWikiQuestion(first.questionId);
    assert.equal(applied.status, '처리완료');
    assert.match(readFileSync(join(vaultRoot, 'Knowledge', 'Index.md'), 'utf8'), /예시 키워드 \| 예시어 \| \[\[Knowledge\/Topics\/예시-키워드\]\]/);
    assert.match(readFileSync(join(vaultRoot, 'Knowledge', 'Topics', '예시-키워드.md'), 'utf8'), /aliases: \["예시어"\]/);
    assert.match(readFileSync(join(vaultRoot, 'Knowledge', 'Meta', 'evidence.md'), 'utf8'), /\[\[Knowledge\/Topics\/예시-키워드\]\]/);
  } finally {
    rmSync(vaultRoot, { recursive: true, force: true });
  }
});

test('발송 실패는 결과 불명으로 보존하고 자동 중복 발송하지 않는다', async () => {
  mkdirSync(vaultRoot, { recursive: true });
  try {
    putVaultNote('Knowledge/Meta/evidence');
    const input = {
      kind: 'manual-change', question: '이 수정안을 반영할까요?', evidenceNotes: ['Knowledge/Meta/evidence'],
    };
    let sendCount = 0;
    const sender = async () => { sendCount += 1; throw new Error('network timeout'); };
    await assert.rejects(createWikiQuestion(input, { sender }), /자동 재시도하지 않았습니다/);
    const pending = await listPendingWikiQuestions();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, '발송결과불명');
    const duplicate = await createWikiQuestion(input, { sender });
    assert.equal(duplicate.duplicate, true);
    assert.equal(sendCount, 1, '전송 결과가 모호한 요청은 자동 재발송하지 않아야 함');
    const questionId = pending[0].questionId;
    const resendSender = async () => ({ result: { message_id: 99 } });
    await assert.rejects(resendWikiQuestion(questionId, { sender: resendSender }), /수동 확인한 질문만/);
    await reconcileWikiQuestion(questionId, { delivered: false });
    const resent = await resendWikiQuestion(questionId, { sender: resendSender });
    assert.equal(resent.status, '답변대기');
    assert.equal(resent.telegramMessageId, 99);
    await assert.rejects(resendWikiQuestion(questionId, { sender: resendSender }), /수동 확인한 질문만/);
  } finally {
    rmSync(vaultRoot, { recursive: true, force: true });
  }
});

test('만료된 승인 질문은 반영되지 않고 manual-change 완료도 거부된다', async () => {
  // Each node:test case uses the same isolated Vault; reconstruct it after the preceding cleanup.
  mkdirSync(vaultRoot, { recursive: true });
  try {
    putVaultNote('Knowledge/Meta/evidence');
    createIndex();
    putVaultNote('Knowledge/Topics/예시-키워드');
    const sent = async () => ({ result: { message_id: 72 } });
    const keyword = await createWikiQuestion(keywordInput(), { sender: sent });
    putVaultNote('Knowledge/Topics/두번째-키워드');
    const secondKeyword = await createWikiQuestion({
      ...keywordInput(),
      question: "'두번째 키워드'를 정본으로 등록할까요?",
      changePlan: { ...keywordInput().changePlan, standardTerm: '두번째 키워드', canonicalNote: 'Knowledge/Topics/두번째-키워드' },
    }, { sender: sent });
    const hook = fileURLToPath(new URL('../hooks/wiki-question-intake.mjs', import.meta.url));
    const context = execFileSync(process.execPath, [hook], {
      input: JSON.stringify({ prompt: '등록' }), encoding: 'utf8',
      env: { ...process.env, VAULT_PATH: vaultRoot, CLAUDE_TELEGRAM_SESSION: '1' },
    });
    assert.match(context, new RegExp(keyword.questionId));
    assert.match(context, new RegExp(secondKeyword.questionId));
    const active = await listPendingWikiQuestions();
    assert.deepEqual(new Set(active.map((item) => item.questionId)), new Set([keyword.questionId, secondKeyword.questionId]));
    assert.ok(active.every((item) => item.status === '답변대기'), 'ID 없는 답은 복수 대기 질문 중 어느 것도 변경하지 않아야 함');

    await resolveWikiQuestion(keyword.questionId, '등록');
    backdateQuestion(keyword.questionId);
    await assert.rejects(applyWikiQuestion(keyword.questionId), /질문이 만료됐습니다/);
    assert.equal((await listPendingWikiQuestions()).some((q) => q.questionId === keyword.questionId), false);
    assert.equal(readFileSync(join(vaultRoot, 'Knowledge', 'Index.md'), 'utf8').includes('예시 키워드'), false);

    const manual = await createWikiQuestion({
      kind: 'manual-change', question: '이 문서 변경을 반영할까요?', evidenceNotes: ['Knowledge/Meta/evidence'],
    }, { sender: sent });
    await resolveWikiQuestion(manual.questionId, '등록');
    backdateQuestion(manual.questionId);
    await assert.rejects(completeManualWikiQuestion(manual.questionId, '변경 완료'), /질문이 만료됐습니다/);
  } finally {
    rmSync(vaultRoot, { recursive: true, force: true });
  }
});
