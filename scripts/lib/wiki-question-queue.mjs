// 므네모시네 위키 승인 질문의 영속 큐. getUpdates 수신은 하지 않는다.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { VAULT_PATHS } from './vault-paths.mjs';
import { buildFrontmatter, parseFrontmatter } from './vault-frontmatter.mjs';
import { patchFrontmatterFileSafely, withLock, writeAtomic } from './state-writer.mjs';
import { escapeHtml, sendTelegram } from './telegram.mjs';
import { formatDepartmentMessage, stripEmDash } from './telegram-messages.mjs';

const QUEUE_DIR = join(VAULT_PATHS.root, 'State', 'WikiQuestions');
const QUEUE_LOCK = join(QUEUE_DIR, '.queue');
const INDEX_PATH = join(VAULT_PATHS.root, 'Knowledge', 'Index.md');
const QUESTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = new Set(['발송중', '발송결과불명', '답변대기', '승인', '반영대기']);
const ACTIONS = new Map([
  ['등록', 'approve'], ['승인', 'approve'], ['예', 'approve'],
  ['보류', 'hold'], ['나중에', 'hold'],
  ['제외', 'reject'], ['거절', 'reject'], ['아니오', 'reject'],
]);
const QUESTION_ID_RE = /^WQ-\d{8}-[0-9a-f]{8}$/i;

function ensureQueue() { mkdirSync(QUEUE_DIR, { recursive: true }); }
function recordPath(id) {
  if (!QUESTION_ID_RE.test(id)) throw new Error('질문 ID 형식이 올바르지 않습니다.');
  return join(QUEUE_DIR, `${id}.md`);
}
function splitNote(content) {
  const match = String(content).match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  if (!match) throw new Error('frontmatter가 없는 질문 노트입니다.');
  return { body: match[2], fields: parseFrontmatter(match[1]) };
}
function renderNote(fields, body) { return `${buildFrontmatter(fields)}${body}`; }
function readRecord(id) {
  const path = recordPath(id);
  if (!existsSync(path)) throw new Error(`질문을 찾을 수 없습니다: ${id}`);
  const content = readFileSync(path, 'utf8');
  return { path, content, ...splitNote(content) };
}
function writeRecord(record, updates) {
  const fields = { ...record.fields, ...updates, updatedAt: new Date().toISOString() };
  writeAtomic(record.path, renderNote(fields, record.body));
  return { ...record, fields };
}
function listRecords() {
  ensureQueue();
  return readdirSync(QUEUE_DIR)
    .filter((name) => /^WQ-\d{8}-[0-9a-f]{8}\.md$/i.test(name))
    .map((name) => {
      const path = join(QUEUE_DIR, name);
      const content = readFileSync(path, 'utf8');
      return { path, content, ...splitNote(content) };
    });
}
function hashQuestion(input) {
  const stable = JSON.stringify({
    kind: input.kind,
    question: String(input.question).trim(),
    changePlan: input.changePlan ?? null,
    evidenceNotes: input.evidenceNotes ?? [],
  });
  return createHash('sha256').update(stable).digest('hex');
}
function validateVaultNote(notePath, allowedRoots = null) {
  if (typeof notePath !== 'string' || !notePath || notePath.startsWith('/') || notePath.includes('..')) {
    throw new Error(`볼트 상대 노트 경로가 올바르지 않습니다: ${notePath}`);
  }
  const normalized = notePath.replace(/\.md$/i, '');
  const abs = resolve(VAULT_PATHS.root, `${normalized}.md`);
  if (!abs.startsWith(`${resolve(VAULT_PATHS.root)}${sep}`) || !existsSync(abs)) {
    throw new Error(`볼트 노트를 찾을 수 없습니다: ${notePath}`);
  }
  const realRoot = realpathSync(VAULT_PATHS.root);
  const realNote = realpathSync(abs);
  if (!realNote.startsWith(`${realRoot}${sep}`)) throw new Error(`볼트 밖을 가리키는 심볼릭 링크는 사용할 수 없습니다: ${notePath}`);
  if (allowedRoots && !allowedRoots.some((root) => normalized.startsWith(`${root}/`))) {
    throw new Error(`이 작업에서 수정할 수 없는 폴더입니다: ${notePath}`);
  }
  return { normalized, abs };
}
function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('JSON 객체 입력이 필요합니다.');
  if (!['keyword-registration', 'manual-change'].includes(input.kind)) throw new Error('kind는 keyword-registration 또는 manual-change여야 합니다.');
  const question = String(input.question ?? '').trim();
  if (!question || question.length > 1800) throw new Error('question은 1~1800자여야 합니다.');
  const rawEvidence = input.evidenceNotes ?? [];
  if (!Array.isArray(rawEvidence) || rawEvidence.length > 8) throw new Error('evidenceNotes는 최대 8개여야 합니다.');
  const evidenceNotes = rawEvidence.map((note) => {
    const validated = validateVaultNote(note).normalized;
    if (validated.length > 120) throw new Error(`근거 노트 경로가 너무 깁니다: ${validated}`);
    return validated;
  });
  let changePlan = input.changePlan ?? null;
  if (input.kind === 'keyword-registration') {
    if (!changePlan || changePlan.type !== 'register-keyword') throw new Error('keyword-registration은 register-keyword changePlan이 필요합니다.');
    const standardTerm = String(changePlan.standardTerm ?? '').trim();
    const canonical = validateVaultNote(changePlan.canonicalNote, ['Knowledge']);
    const section = String(changePlan.indexSection ?? '');
    if (!standardTerm || standardTerm.length > 80 || standardTerm.includes('|') || /[\r\n]/.test(standardTerm)) throw new Error('standardTerm은 표 구분자 없이 1~80자여야 합니다.');
    if (!['개인 원칙과 투자 결정', '시스템과 기술'].includes(section)) throw new Error('indexSection은 색인의 표준 키워드 표가 있는 허용된 절이어야 합니다.');
    const rawAliases = changePlan.aliases ?? [];
    const rawBacklinks = changePlan.backlinkNotes ?? [];
    if (!Array.isArray(rawAliases) || rawAliases.length > 20) throw new Error('aliases는 최대 20개여야 합니다.');
    if (!Array.isArray(rawBacklinks) || rawBacklinks.length > 25) throw new Error('backlinkNotes는 최대 25개여야 합니다.');
    const aliases = [...new Set(rawAliases.map((x) => String(x).replace(/[\r\n]+/g, ' ').trim()).filter(Boolean))];
    if (aliases.some((x) => x.length > 80)) throw new Error('별칭은 각각 80자 이하여야 합니다.');
    const backlinks = [...new Set(rawBacklinks.map((note) => validateVaultNote(note).normalized))];
    if (backlinks.includes(canonical.normalized)) throw new Error('정본을 자기 자신의 역링크 대상으로 지정할 수 없습니다.');
    changePlan = {
      type: 'register-keyword', standardTerm, canonicalNote: canonical.normalized,
      aliases, indexSection: section, answerGuidance: String(changePlan.answerGuidance ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300),
      backlinkNotes: backlinks,
    };
  } else if (changePlan !== null) {
    throw new Error('manual-change의 changePlan 자동 반영은 지원되지 않습니다. 승인 뒤 담당 세션이 변경하고 complete로 마감하세요.');
  }
  return { ...input, question, evidenceNotes, changePlan };
}
function formatQuestion(fields, questionText = '') {
  const id = fields.questionId;
  const evidence = fields.evidenceNotes.length
    ? `\n\n근거 노트: ${fields.evidenceNotes.map((x) => `\`${escapeHtml(x)}\``).join(', ')}`
    : '';
  const choices = `\n\n답변 방법: 아래 중 한 줄로 답해주세요.\n<code>${id} 등록</code>\n<code>${id} 보류</code>\n<code>${id} 제외</code>`;
  const body = `<b>질문 ID: ${id}</b>\n\n${stripEmDash(escapeHtml(questionText))}${evidence}${choices}`;
  return formatDepartmentMessage({ departmentLabel: '비서실 Apollo', tag: '확인요청', body });
}
function normalizeAnswer(text) {
  const normalized = String(text ?? '').trim().replace(/[.!。！?？]+$/u, '').trim();
  return ACTIONS.get(normalized) ?? null;
}

export function parseExplicitWikiAnswer(prompt) {
  const rawText = String(prompt ?? '').trim();
  const match = rawText.match(/(WQ-\d{8}-[0-9a-f]{8})\s+([\s\S]*?)(?:<\/channel>)?$/iu);
  if (!match) return null;
  const answer = match[2].trim().replace(/[.!。！?？]+$/u, '').trim();
  return answer ? { questionId: match[1].toUpperCase(), answer, rawText } : null;
}

export async function createWikiQuestion(rawInput, { sender = sendTelegram } = {}) {
  const input = validateInput(rawInput);
  ensureQueue();
  const dedupeKey = hashQuestion(input);
  const created = await withLock(QUEUE_LOCK, async () => {
    const existing = listRecords().find((r) => r.fields.dedupeKey === dedupeKey && r.fields.status !== '만료');
    if (existing) return { record: existing, duplicate: true };
    const now = new Date();
    let questionId;
    do { questionId = `WQ-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`.toUpperCase(); } while (existsSync(recordPath(questionId)));
    const fields = {
      type: 'wiki-question', questionId, kind: input.kind, status: '발송중',
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + QUESTION_TTL_MS).toISOString(),
      updatedAt: now.toISOString(), dedupeKey,
      evidenceNotes: input.evidenceNotes,
      changePlan: input.changePlan ? JSON.stringify(input.changePlan) : null,
    };
    const path = recordPath(questionId);
    const body = `# 위키 확인 질문 ${questionId}\n\n${input.question}\n`;
    writeAtomic(path, renderNote(fields, body));
    return { record: { path, fields, body }, duplicate: false };
  });
  if (created.duplicate) return { questionId: created.record.fields.questionId, status: created.record.fields.status, duplicate: true, sent: false };

  try {
    const response = await sender(formatQuestion(created.record.fields, input.question));
    const messageId = response?.result?.message_id ?? response?.message_id ?? null;
    if (!Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0) throw new Error('Telegram 성공 응답에 message_id가 없습니다.');
    await withLock(QUEUE_LOCK, async () => {
      const current = readRecord(created.record.fields.questionId);
      writeRecord(current, { status: '답변대기', sentAt: new Date().toISOString(), telegramMessageId: messageId });
    });
    return { questionId: created.record.fields.questionId, status: '답변대기', duplicate: false, sent: true, telegramMessageId: messageId };
  } catch (error) {
    await withLock(QUEUE_LOCK, async () => {
      const current = readRecord(created.record.fields.questionId);
      writeRecord(current, { status: '발송결과불명', sendError: String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 500) });
    });
    throw new Error(`텔레그램 전송 결과를 확인할 수 없습니다. 중복 발송 방지를 위해 자동 재시도하지 않았습니다. 질문 ID ${created.record.fields.questionId}: ${error.message}`);
  }
}

export async function listPendingWikiQuestions({ expire = true } = {}) {
  ensureQueue();
  const now = Date.now();
  if (expire) {
    await withLock(QUEUE_LOCK, async () => {
      for (const record of listRecords()) {
        if (!ACTIVE_STATUSES.has(record.fields.status)) continue;
        if (Date.parse(record.fields.expiresAt) <= now) writeRecord(record, { status: '만료', expiredAt: new Date(now).toISOString() });
      }
    });
  }
  return listRecords()
    .filter((r) => ACTIVE_STATUSES.has(r.fields.status))
    .map((r) => ({
      questionId: r.fields.questionId, status: r.fields.status, kind: r.fields.kind,
      question: r.body.replace(/^# 위키 확인 질문 [^\n]+\n\n/, '').trim().slice(0, 700), createdAt: r.fields.createdAt, expiresAt: r.fields.expiresAt,
      evidenceNotes: r.fields.evidenceNotes ?? [],
    }));
}

export async function resolveWikiQuestion(questionId, answerText, { rawText = answerText } = {}) {
  ensureQueue();
  return withLock(QUEUE_LOCK, async () => {
    const record = readRecord(questionId);
    const { fields } = record;
    if (Date.parse(fields.expiresAt) <= Date.now() && ACTIVE_STATUSES.has(fields.status)) {
      writeRecord(record, { status: '만료', expiredAt: new Date().toISOString() });
      return { action: 'expired', questionId, message: '질문이 만료됐습니다. 새 질문으로 확인해야 합니다.' };
    }
    if (!['답변대기', '발송중', '발송결과불명'].includes(fields.status)) {
      return { action: 'already-processed', questionId, status: fields.status };
    }
    const action = normalizeAnswer(answerText);
    if (!action) {
      const rawClarification = String(answerText ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 1000);
      const clarifications = [...(Array.isArray(fields.clarifications) ? fields.clarifications : []),
        `${new Date().toISOString()} — ${rawClarification}`].slice(-10);
      writeRecord(record, { clarifications });
      return { action: 'clarify', questionId, reason: '등록/승인, 보류, 제외/거절 중 하나로 답변을 확인할 수 없습니다.' };
    }
    const status = action === 'approve' ? (fields.kind === 'keyword-registration' ? '승인' : '반영대기')
      : action === 'hold' ? '보류' : '제외';
    writeRecord(record, {
      status, answer: action === 'approve' ? '등록' : action === 'hold' ? '보류' : '제외', decision: action,
      answerRaw: String(rawText ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 1000),
      answeredAt: new Date().toISOString(),
    });
    return { action, questionId, status, kind: fields.kind, requiresApply: action === 'approve', changePlan: fields.changePlan ?? null };
  });
}

function splitTableCell(value) { return String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ').trim(); }
async function addKeywordIndexRow(plan) {
  await withLock(INDEX_PATH, async () => {
    const content = readFileSync(INDEX_PATH, 'utf8');
    const link = `[[${plan.canonicalNote}]]`;
    const rows = content.split('\n').filter((line) => line.startsWith('|'));
    const standardTerm = splitTableCell(plan.standardTerm);
    const aliasesCell = plan.aliases.map(splitTableCell).join(', ');
    const answerGuidance = splitTableCell(plan.answerGuidance);
    const existing = rows.find((line) => line.split('|')[1]?.trim() === standardTerm);
    const expected = `| ${standardTerm} | ${aliasesCell} | ${link} | ${answerGuidance} |`;
    if (existing) {
      if (existing === expected) return;
      throw new Error(`색인에 같은 표준 키워드가 이미 다른 내용으로 있습니다: ${standardTerm}`);
    }
    const heading = `## ${plan.indexSection}`;
    const sectionStart = content.indexOf(heading);
    if (sectionStart < 0) throw new Error(`색인 절을 찾을 수 없습니다: ${plan.indexSection}`);
    const nextHeading = content.indexOf('\n## ', sectionStart + heading.length);
    const sectionEnd = nextHeading < 0 ? content.length : nextHeading;
    const section = content.slice(sectionStart, sectionEnd);
    if (!section.includes('| 표준 키워드 | 별칭·검색어 | 정본 또는 탐색 페이지 | 답변 시 확인 |')) {
      throw new Error(`표준 키워드 표 형식이 바뀌었습니다: ${plan.indexSection}`);
    }
    const row = `\n${expected}`;
    const updated = content.slice(0, sectionEnd).replace(/\n*$/, '\n') + row + content.slice(sectionEnd);
    writeAtomic(INDEX_PATH, updated);
  });
}

async function applyKeywordPlan(plan) {
  const canonical = validateVaultNote(plan.canonicalNote, ['Knowledge']);
  const canonicalContent = readFileSync(canonical.abs, 'utf8');
  const canonicalFields = parseFrontmatter(canonicalContent);
  const aliases = [...new Set([...(canonicalFields.aliases ?? []), ...plan.aliases])];
  const backlinkNotes = [...new Set(plan.backlinkNotes ?? [])];
  const targets = backlinkNotes.map((note) => ({ note, ...validateVaultNote(note) }));
  const canonicalRelated = [...new Set([...(canonicalFields.related ?? []), ...backlinkNotes.map((x) => `[[${x}]]`)])];
  // 먼저 색인 충돌과 표 구조를 확인·기록한다. 후속 frontmatter 갱신이 실패해도 재실행은 멱등이다.
  await addKeywordIndexRow(plan);
  await patchFrontmatterFileSafely(canonical.abs, { aliases, related: canonicalRelated });
  for (const target of targets) {
    await patchFrontmatterFileSafely(target.abs, { related: [`[[${plan.canonicalNote}]]`] });
  }
  return { index: 'Knowledge/Index.md', canonical: plan.canonicalNote, backlinks: backlinkNotes };
}

export async function applyWikiQuestion(questionId) {
  ensureQueue();
  return withLock(QUEUE_LOCK, async () => {
    const record = readRecord(questionId);
    if (Date.parse(record.fields.expiresAt) <= Date.now() && ACTIVE_STATUSES.has(record.fields.status)) {
      writeRecord(record, { status: '만료', expiredAt: new Date().toISOString() });
      throw new Error('질문이 만료됐습니다. 새 질문으로 다시 확인해야 합니다.');
    }
    if (record.fields.status !== '승인') throw new Error(`승인 상태인 질문만 반영할 수 있습니다(현재: ${record.fields.status}).`);
    if (record.fields.kind !== 'keyword-registration') throw new Error('자동 반영은 keyword-registration 질문만 지원합니다.');
    let plan;
    try { plan = JSON.parse(record.fields.changePlan); } catch { throw new Error('승인된 질문에 유효한 변경 계획이 없습니다.'); }
    const applied = await applyKeywordPlan(plan);
    const current = readRecord(questionId);
    writeRecord(current, { status: '처리완료', appliedAt: new Date().toISOString(), appliedSummary: JSON.stringify(applied) });
    return { questionId, status: '처리완료', applied };
  });
}

export async function completeManualWikiQuestion(questionId, summary) {
  ensureQueue();
  return withLock(QUEUE_LOCK, async () => {
    const record = readRecord(questionId);
    if (record.fields.kind !== 'manual-change' || record.fields.status !== '반영대기') throw new Error('반영대기 manual-change 질문만 마감할 수 있습니다.');
    if (Date.parse(record.fields.expiresAt) <= Date.now()) {
      writeRecord(record, { status: '만료', expiredAt: new Date().toISOString() });
      throw new Error('질문이 만료됐습니다. 새 질문으로 다시 확인해야 합니다.');
    }
    const appliedSummary = String(summary ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 1000);
    if (!appliedSummary) throw new Error('반영 결과 요약이 필요합니다.');
    writeRecord(record, { status: '처리완료', appliedAt: new Date().toISOString(), appliedSummary });
    return { questionId, status: '처리완료' };
  });
}

export async function reconcileWikiQuestion(questionId, { delivered, messageId = null }) {
  ensureQueue();
  return withLock(QUEUE_LOCK, async () => {
    const record = readRecord(questionId);
    if (record.fields.status !== '발송결과불명' && record.fields.status !== '발송중') throw new Error('발송 상태가 불명확한 질문만 조정할 수 있습니다.');
    const numericMessageId = Number(messageId);
    if (delivered && (!/^\d+$/.test(String(messageId)) || !Number.isSafeInteger(numericMessageId) || numericMessageId <= 0)) throw new Error('전달 확인에는 양의 안전 정수 Telegram message_id가 필요합니다.');
    writeRecord(record, delivered
      ? { status: '답변대기', telegramMessageId: numericMessageId, sentAt: record.fields.sentAt ?? new Date().toISOString(), sendError: null }
      : { status: '재발송허용', reconciledAt: new Date().toISOString(), sendError: null });
    return { questionId, status: delivered ? '답변대기' : '재발송허용' };
  });
}

export async function resendWikiQuestion(questionId, { sender = sendTelegram } = {}) {
  ensureQueue();
  const record = await withLock(QUEUE_LOCK, async () => {
    const current = readRecord(questionId);
    if (current.fields.status !== '재발송허용') throw new Error('전달되지 않았다고 수동 확인한 질문만 재발송할 수 있습니다.');
    if (Date.parse(current.fields.expiresAt) <= Date.now()) {
      writeRecord(current, { status: '만료', expiredAt: new Date().toISOString() });
      throw new Error('질문이 만료됐습니다. 새 질문으로 확인해야 합니다.');
    }
    return writeRecord(current, { status: '발송중', retryAt: new Date().toISOString() });
  });
  const latest = { ...record.fields };
  try {
    const response = await sender(formatQuestion(latest, record.body.replace(/^# 위키 확인 질문 [^\n]+\n\n/, '').trim()));
    const messageId = response?.result?.message_id ?? response?.message_id ?? null;
    if (!Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0) throw new Error('Telegram 성공 응답에 message_id가 없습니다.');
    return await withLock(QUEUE_LOCK, async () => {
      const current = readRecord(questionId);
      writeRecord(current, { status: '답변대기', sentAt: new Date().toISOString(), telegramMessageId: messageId });
      return { questionId, status: '답변대기', telegramMessageId: messageId };
    });
  } catch (error) {
    await withLock(QUEUE_LOCK, async () => {
      const current = readRecord(questionId);
      writeRecord(current, { status: '발송결과불명', sendError: String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 500) });
    });
    throw new Error(`재발송 결과 불명: ${error.message}`);
  }
}
