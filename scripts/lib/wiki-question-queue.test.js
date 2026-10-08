import { test } from 'node:test';
import { renderAgentMessage } from './pantheon-send.mjs';
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
  sendQuestionDigest,
  planQuestionDigest,
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
    evidenceNotes: ['90_Delphi/evidence'],
    changePlan: {
      type: 'register-keyword',
      standardTerm: '예시 키워드',
      aliases: ['예시어'],
      canonicalNote: '30_Wiki/34_Topics/예시-키워드',
      indexSection: '시스템과 기술',
      answerGuidance: '질문은 정본을 우선 확인합니다.',
      backlinkNotes: ['90_Delphi/evidence'],
    },
  };
}

function createIndex() {
  putVaultNote('90_Delphi/index', [
    '# Index',
    '',
    '## 시스템과 기술',
    '| 표준 키워드 | 별칭·검색어 | 정본 또는 탐색 페이지 | 답변 시 확인 |',
    '| --- | --- | --- | --- |',
    '',
  ].join('\n'));
}

function backdateQuestion(questionId) {
  const filepath = join(vaultRoot, '95_Etna', 'Questions', `${questionId}.md`);
  const content = readFileSync(filepath, 'utf8').replace(/expiresAt: "[^"]+"/, 'expiresAt: "2000-01-01T00:00:00.000Z"');
  writeFileSync(filepath, content);
  return filepath;
}

test('질문 생성은 발송 전에 영속화하고 중복 질문은 재발송하지 않으며 ID 답변을 회수한다', async () => {
  try {
    putVaultNote('90_Delphi/evidence');
    createIndex();
    putVaultNote('30_Wiki/34_Topics/예시-키워드');
    let sendCount = 0;
    let sentText = '';
    const sender = async (text) => { sentText = text; return { result: { message_id: ++sendCount } }; };

    const first = await createWikiQuestion(keywordInput(), { sender });
    const duplicate = await createWikiQuestion(keywordInput(), { sender });
    assert.match(first.questionId, /^WQ-\d{8}-[0-9A-F]{8}$/);
    assert.equal(first.status, '답변대기');
    assert.equal(first.sent, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(sendCount, 1);
    assert.match(renderAgentMessage(sentText), /30_Wiki\/34_Topics\/예시-키워드/);
    assert.match(renderAgentMessage(sentText), /90_Delphi\/evidence/);
    assert.ok(readFileSync(join(vaultRoot, '95_Etna', 'Questions', `${first.questionId}.md`), 'utf8').includes('예시 키워드'));

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
    assert.match(readFileSync(join(vaultRoot, '95_Etna', 'Questions', `${first.questionId}.md`), 'utf8'), /clarifications: \[.*그렇게 해주세요/);
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
    const clarifiedRecord = readFileSync(join(vaultRoot, '95_Etna', 'Questions', `${first.questionId}.md`), 'utf8');
    assert.match(clarifiedRecord, /clarifications: \[.*자료를 더 보고 싶어요/);
    assert.match(clarifiedRecord, /status: "답변대기"/);

    const explicitText = `${first.questionId} 등록`;
    assert.deepEqual(parseExplicitWikiAnswer(explicitText), {
      questionId: first.questionId, answer: '등록', rawText: explicitText,
    });
    const resolved = await resolveWikiQuestion(first.questionId, '등록', { rawText: explicitText });
    assert.equal(resolved.status, '승인');
    assert.equal(readFileSync(join(vaultRoot, '95_Etna', 'Questions', `${first.questionId}.md`), 'utf8').includes(`answerRaw: "${explicitText}"`), true);
    const applied = await applyWikiQuestion(first.questionId);
    assert.equal(applied.status, '처리완료');
    assert.match(readFileSync(join(vaultRoot, '90_Delphi', 'index.md'), 'utf8'), /예시 키워드 \| 예시어 \| \[\[30_Wiki\/34_Topics\/예시-키워드\]\]/);
    assert.match(readFileSync(join(vaultRoot, '30_Wiki', '34_Topics', '예시-키워드.md'), 'utf8'), /aliases: \["예시어"\]/);
    assert.match(readFileSync(join(vaultRoot, '90_Delphi', 'evidence.md'), 'utf8'), /\[\[30_Wiki\/34_Topics\/예시-키워드\]\]/);
  } finally {
    rmSync(vaultRoot, { recursive: true, force: true });
  }
});

test('라이브 색인이 없으면 승인 적용을 멈추고 보관용 Meta 색인을 수정하지 않는다', async () => {
  mkdirSync(vaultRoot, { recursive: true });
  try {
    putVaultNote('90_Delphi/evidence');
    putVaultNote('30_Wiki/34_Topics/예시-키워드');
    const archived = putVaultNote('80_Archive/Knowledge/Meta/Index', '보관용 색인');
    const question = await createWikiQuestion(keywordInput(), {
      sender: async () => ({ result: { message_id: 1 } }),
    });
    await resolveWikiQuestion(question.questionId, '등록');
    await assert.rejects(applyWikiQuestion(question.questionId), /현재 지식 색인이 없어/);
    assert.equal(readFileSync(archived, 'utf8'), '보관용 색인');
  } finally {
    rmSync(vaultRoot, { recursive: true, force: true });
  }
});

test('발송 실패는 결과 불명으로 보존하고 자동 중복 발송하지 않는다', async () => {
  mkdirSync(vaultRoot, { recursive: true });
  try {
    putVaultNote('90_Delphi/evidence');
    const input = {
      kind: 'manual-change', question: '이 수정안을 반영할까요?', evidenceNotes: ['90_Delphi/evidence'],
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
    assert.equal((await listPendingWikiQuestions()).some((q) => q.questionId === questionId && q.status === '재발송허용'), true);
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
    putVaultNote('90_Delphi/evidence');
    createIndex();
    putVaultNote('30_Wiki/34_Topics/예시-키워드');
    const sent = async () => ({ result: { message_id: 72 } });
    const keyword = await createWikiQuestion(keywordInput(), { sender: sent });
    putVaultNote('30_Wiki/34_Topics/두번째-키워드');
    const secondKeyword = await createWikiQuestion({
      ...keywordInput(),
      question: "'두번째 키워드'를 정본으로 등록할까요?",
      changePlan: { ...keywordInput().changePlan, standardTerm: '두번째 키워드', canonicalNote: '30_Wiki/34_Topics/두번째-키워드' },
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
    assert.equal(readFileSync(join(vaultRoot, '90_Delphi', 'index.md'), 'utf8').includes('예시 키워드'), false);

    const manual = await createWikiQuestion({
      kind: 'manual-change', question: '이 문서 변경을 반영할까요?', evidenceNotes: ['90_Delphi/evidence'],
    }, { sender: sent });
    await resolveWikiQuestion(manual.questionId, '등록');
    backdateQuestion(manual.questionId);
    await assert.rejects(completeManualWikiQuestion(manual.questionId, '변경 완료'), /질문이 만료됐습니다/);
  } finally {
    rmSync(vaultRoot, { recursive: true, force: true });
  }
});

// 이관 4-5: 질문 큐 일반화 — 어느 담당이든 자기 이름으로 묻고, 키워드 등록은 클리오만.
test('질문은 asker 담당 이름으로 나가고, 미등록 담당·클리오 외 키워드 등록은 거부한다', async () => {
  const sent = [];
  const sender = async (message) => { sent.push(message); return { result: { message_id: 900 + sent.length } }; };
  const manual = (extra = {}) => ({ kind: 'manual-change', question: `분기 리밸런싱 밴드를 바꿀까요? ${Math.random()}`, ...extra });
  const plutus = await createWikiQuestion(manual({ asker: 'plutus', urgent: true }), { sender }); // urgent:false는 묶음 발송(아래 테스트)
  assert.equal(plutus.sent, true);
  assert.equal(sent.at(-1).agent, 'plutus');
  assert.match(renderAgentMessage(sent.at(-1)), new RegExp(`^\\[플루토스 Plutus\\] 질문 ${plutus.questionId}`));
  const note = readFileSync(join(vaultRoot, '95_Etna', 'Questions', `${plutus.questionId}.md`), 'utf8');
  assert.match(note, /asker: "plutus"/);
  assert.match(note, /urgent: true/);
  await createWikiQuestion(manual(), { sender });
  assert.equal(sent.at(-1).agent, 'clio');
  await assert.rejects(createWikiQuestion(manual({ asker: 'apollo' }), { sender }), /등록된 담당/);
  putVaultNote('90_Delphi/evidence');
  putVaultNote('30_Wiki/34_Topics/예시-키워드');
  await assert.rejects(createWikiQuestion({ ...keywordInput(), asker: 'plutus' }, { sender }), /클리오만/);
  await assert.rejects(createWikiQuestion(manual({ urgent: 'yes' }), { sender }), /urgent/);
});

// 비긴급 질문 묶음 발송(2026-10-09, D68)
test('urgent:false 질문은 즉시 보내지 않고 묶음대기, 묶음 발송은 담당별 한 메시지로 보내고 답변대기로 바꾼다', async () => {
  const neverSend = async () => { throw new Error('즉시 발송되면 안 됨'); };
  const a = await createWikiQuestion({ kind: 'manual-change', question: '묶음 질문 A', asker: 'plutus', urgent: false }, { sender: neverSend });
  await new Promise((r) => setTimeout(r, 5)); // 만든 순서 단언을 위해 createdAt을 다르게
  const b = await createWikiQuestion({ kind: 'manual-change', question: '묶음 질문 B', asker: 'plutus', urgent: false }, { sender: neverSend });
  const c = await createWikiQuestion({ kind: 'manual-change', question: '묶음 질문 C', asker: 'clio', urgent: false }, { sender: neverSend });
  assert.deepEqual([a.status, a.sent, a.queued], ['묶음대기', false, true]);
  const sent = [];
  const sender = async (message) => { sent.push(message); return { result: { message_id: 100 + sent.length } }; };
  const result = await sendQuestionDigest({ sender });
  assert.equal(result.sent, 2);
  const plutusMsg = sent.find((m) => m.agent === 'plutus');
  assert.match(plutusMsg.body, /질문 2개/);
  assert.match(plutusMsg.body, new RegExp(`${a.questionId}[\\s\\S]*${b.questionId}`), '만든 순서대로');
  assert.match(plutusMsg.body, new RegExp(`${a.questionId} 등록`));
  assert.equal(sent.find((m) => m.agent === 'clio').topic, '질문 묶음');
  const pending = await listPendingWikiQuestions();
  for (const id of [a.questionId, b.questionId, c.questionId]) assert.equal(pending.find((q) => q.questionId === id).status, '답변대기');
  assert.equal((await sendQuestionDigest({ sender })).chunks, 0, '두 번째 실행은 보낼 것 없음');
  for (const q of [a, b, c]) await resolveWikiQuestion(q.questionId, '제외');
});

test('묶음 발송 실패는 발송결과불명으로 남기고 다시 묶음에 넣지 않는다, 만료된 묶음대기는 보내지 않는다', async () => {
  const neverSend = async () => { throw new Error('x'); };
  const d = await createWikiQuestion({ kind: 'manual-change', question: '실패할 묶음 질문 D', asker: 'clio', urgent: false }, { sender: neverSend });
  const e = await createWikiQuestion({ kind: 'manual-change', question: '만료될 묶음 질문 E', asker: 'clio', urgent: false }, { sender: neverSend });
  backdateQuestion(e.questionId);
  const failing = async () => { throw new Error('network down'); };
  const result = await sendQuestionDigest({ sender: failing });
  assert.equal(result.failed, 1);
  assert.deepEqual(result.results[0].questionIds, [d.questionId]);
  const text = readFileSync(join(vaultRoot, '95_Etna', 'Questions', `${d.questionId}.md`), 'utf8');
  assert.match(text, /status: "발송결과불명"/);
  assert.match(readFileSync(join(vaultRoot, '95_Etna', 'Questions', `${e.questionId}.md`), 'utf8'), /status: "만료"/);
  assert.equal((await sendQuestionDigest({ sender: async () => ({ result: { message_id: 1 } }) })).chunks, 0, '불명은 자동 재발송 안 함');
  await reconcileWikiQuestion(d.questionId, { delivered: false });
});

test('planQuestionDigest: 길이 한도를 넘으면 같은 담당도 여러 메시지로 나눈다', () => {
  const rec = (n) => ({ fields: { questionId: `WQ-20261009-0000000${n}`, asker: 'clio', createdAt: `2026-10-09T0${n}:00:00Z`, evidenceNotes: [] }, body: `# 위키 확인 질문 x\n\n${'긴 질문 '.repeat(60)}${n}\n` });
  const chunks = planQuestionDigest([rec(1), rec(2), rec(3)], { maxChars: 700 });
  assert.ok(chunks.length >= 2);
  assert.deepEqual(chunks.flatMap((c) => c.questionIds), ['WQ-20261009-00000001', 'WQ-20261009-00000002', 'WQ-20261009-00000003']);
});

test('리뷰 반영: 여러 답 파싱, 묶음대기에 대한 답 인정, 너무 긴 질문 거부, 확실한 미발송은 재발송허용, 중단된 발송중 정리', async () => {
  const { parseExplicitWikiAnswers } = await import('./wiki-question-queue.mjs');
  const multi = parseExplicitWikiAnswers('WQ-20261009-0000000A 등록\nWQ-20261009-0000000B 보류.</channel>');
  assert.deepEqual(multi.map((x) => [x.questionId, x.answer]), [['WQ-20261009-0000000A', '등록'], ['WQ-20261009-0000000B', '보류']]);
  assert.equal(parseExplicitWikiAnswers('WQ-20261009-0000000A 등록').length, 1);
  assert.equal(parseExplicitWikiAnswers('안녕').length, 0);

  const neverSend = async () => { throw new Error('즉시 발송 금지'); };
  const q = await createWikiQuestion({ kind: 'manual-change', question: '먼저 답한 묶음 질문', asker: 'clio', urgent: false }, { sender: neverSend });
  assert.equal((await resolveWikiQuestion(q.questionId, '보류')).action, 'hold', '묶음대기에 대한 답도 인정');
  await assert.rejects(createWikiQuestion({ kind: 'manual-change', question: `${'&'.repeat(1000)}`, urgent: false }, { sender: neverSend }), /너무 깁니다/);

  const r = await createWikiQuestion({ kind: 'manual-change', question: '렌더 실패할 묶음 질문', asker: 'clio', urgent: false }, { sender: neverSend });
  const res = await sendQuestionDigest({ sender: async () => { const e = new Error('render'); e.confirmedNotSent = true; throw e; } });
  assert.equal(res.failed, 1);
  assert.match(readFileSync(join(vaultRoot, '95_Etna', 'Questions', `${r.questionId}.md`), 'utf8'), /status: "재발송허용"/);

  const o = await createWikiQuestion({ kind: 'manual-change', question: '중단될 묶음 질문', asker: 'clio', urgent: false }, { sender: neverSend });
  const path = join(vaultRoot, '95_Etna', 'Questions', `${o.questionId}.md`);
  writeFileSync(path, readFileSync(path, 'utf8').replace('status: "묶음대기"', 'status: "발송중"\ndigestStartedAt: "2000-01-01T00:00:00.000Z"'));
  const orphanRun = await sendQuestionDigest({ sender: async () => ({ result: { message_id: 1 } }) });
  assert.deepEqual(orphanRun.orphans, [o.questionId]);
  assert.equal(orphanRun.failed, 1);
  assert.match(readFileSync(path, 'utf8'), /status: "발송결과불명"/);
  await reconcileWikiQuestion(o.questionId, { delivered: false });
});
