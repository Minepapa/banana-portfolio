// 므네모시네 위키 승인 질문의 영속 큐. getUpdates 수신은 하지 않는다.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { VAULT_PATHS, VAULT_REL, vaultAbs } from './vault-paths.mjs';
import { buildFrontmatter, parseFrontmatter } from './vault-frontmatter.mjs';
import { patchFrontmatterFileSafely, withLock, writeAtomic } from './state-writer.mjs';
import { escapeHtml } from './telegram.mjs';
import { stripEmDash } from './telegram-messages.mjs';
import { AGENT_HEADERS, sendAgentMessage } from './pantheon-send.mjs';

const QUEUE_DIR = vaultAbs(VAULT_REL.stateWikiQuestions);
const QUEUE_LOCK = join(QUEUE_DIR, '.queue');
const INDEX_PATH = vaultAbs(VAULT_REL.knowledgeIndexFile);
const QUESTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// 묶음대기: 비긴급(urgent:false) 질문이 하루 두 번 묶음 발송(sendQuestionDigest)을 기다리는 상태(2026-10-09, D68).
const ACTIVE_STATUSES = new Set(['묶음대기', '발송중', '발송결과불명', '재발송허용', '답변대기', '승인', '반영대기']);
const DIGEST_MAX_CHARS = 3500; // 텔레그램 4096자 한도 안에서 헤더·여유를 둔다
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
    const canonical = validateVaultNote(changePlan.canonicalNote, [VAULT_REL.knowledge]);
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
  // 질문 큐 일반화(이관 4-5, D68): 어느 담당이든 자기 이름으로 오너에게 묻는다. 기본은 클리오.
  // 키워드 등록은 위키 변경이라 클리오만 할 수 있다(공통 헌장: Wiki는 클리오만 쓴다).
  const asker = input.asker === undefined ? 'clio' : String(input.asker);
  if (!Object.hasOwn(AGENT_HEADERS, asker)) throw new Error(`asker는 등록된 담당이어야 합니다: ${asker}`);
  if (input.kind === 'keyword-registration' && asker !== 'clio') throw new Error('keyword-registration은 클리오만 질문할 수 있습니다.');
  // urgent:false는 즉시 보내지 않고 묶음대기로 두었다가 question-digest 잡이 하루 두 번 담당별로 묶어 보낸다(D68). 기본은 즉시.
  if (input.urgent !== undefined && typeof input.urgent !== 'boolean') throw new Error('urgent는 true/false여야 합니다.');
  const urgent = input.urgent ?? true;
  return { ...input, question, evidenceNotes, changePlan, asker, urgent };
}
// 질문 하나의 본문(ID·질문·근거·반영 예정·답변 방법) — 단건 발송과 묶음 발송이 같이 쓴다.
function questionItemText(fields, questionText = '') {
  const id = fields.questionId;
  const evidence = fields.evidenceNotes.length
    ? `\n\n근거 노트: ${fields.evidenceNotes.map((x) => `\`${escapeHtml(x)}\``).join(', ')}`
    : '';
  let plan = '';
  if (fields.changePlan) {
    try {
      const parsed = typeof fields.changePlan === 'string' ? JSON.parse(fields.changePlan) : fields.changePlan;
      plan = `\n\n반영 예정: 표준어 <code>${escapeHtml(parsed.standardTerm)}</code> · 정본 <code>${escapeHtml(parsed.canonicalNote)}</code> · 색인 <code>${escapeHtml(parsed.indexSection)}</code>`;
      if (parsed.aliases?.length) plan += ` · 별칭 <code>${parsed.aliases.map(escapeHtml).join(', ')}</code>`;
      if (parsed.backlinkNotes?.length) plan += `\n역링크 추가: ${parsed.backlinkNotes.map((x) => `<code>${escapeHtml(x)}</code>`).join(', ')}`;
    } catch { plan = '\n\n반영 예정안을 읽을 수 없습니다. 질문 노트를 확인해주세요.'; }
  }
  const choices = `\n\n답변 방법: 아래 중 한 줄로 답해주세요.\n<code>${id} 등록</code>\n<code>${id} 보류</code>\n<code>${id} 제외</code>`;
  return `${stripEmDash(escapeHtml(questionText))}${evidence}${plan}${choices}`;
}
function questionMessage(fields, questionText = '') {
  const id = fields.questionId;
  const body = `<b>질문 ID: ${id}</b>\n\n${questionItemText(fields, questionText)}`;
  const asker = fields.asker ?? 'clio';
  return { agent: asker, kind: '정보', topic: asker === 'clio' ? '확인요청' : `질문 ${id}`, body };
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

// 한 메시지에 여러 질문 ID가 있으면 줄마다 하나씩 답한 것으로 본다(묶음 발송 뒤 "WQ-A 등록\nWQ-B 보류" 답변).
// ID가 하나뿐이면 기존 parseExplicitWikiAnswer와 같다.
export function parseExplicitWikiAnswers(prompt) {
  const rawText = String(prompt ?? '').trim();
  const ids = rawText.match(/WQ-\d{8}-[0-9a-f]{8}/giu) ?? [];
  if (new Set(ids.map((x) => x.toUpperCase())).size <= 1) {
    const single = parseExplicitWikiAnswer(prompt);
    return single ? [single] : [];
  }
  const answers = [];
  for (const line of rawText.split(/\r?\n/)) {
    const m = line.match(/(WQ-\d{8}-[0-9a-f]{8})\s+(.+?)\s*(?:<\/channel>)?\s*$/iu);
    if (!m) continue;
    const answer = m[2].trim().replace(/[.!。！?？]+$/u, '').trim();
    if (answer) answers.push({ questionId: m[1].toUpperCase(), answer, rawText: line.trim() });
  }
  return answers;
}

export async function createWikiQuestion(rawInput, { sender = sendAgentMessage } = {}) {
  const input = validateInput(rawInput);
  // 메시지가 텔레그램 한도를 넘으면 맨 끝 답변 방법 줄이 잘린다(리뷰 M2) — 등록 단계에서 거부한다.
  const previewLength = questionItemText({ questionId: 'WQ-00000000-00000000', evidenceNotes: input.evidenceNotes, changePlan: input.changePlan }, input.question).length;
  if (previewLength > DIGEST_MAX_CHARS) throw new Error(`질문 메시지가 너무 깁니다(${previewLength}자 > ${DIGEST_MAX_CHARS}자). 질문·근거·별칭·역링크를 줄이세요.`);
  ensureQueue();
  const dedupeKey = hashQuestion(input);
  const created = await withLock(QUEUE_LOCK, async () => {
    const existing = listRecords().find((r) => r.fields.dedupeKey === dedupeKey && r.fields.status !== '만료');
    if (existing) return { record: existing, duplicate: true };
    const now = new Date();
    let questionId;
    do { questionId = `WQ-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`.toUpperCase(); } while (existsSync(recordPath(questionId)));
    const fields = {
      type: 'wiki-question', questionId, kind: input.kind, status: input.urgent === false ? '묶음대기' : '발송중',
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + QUESTION_TTL_MS).toISOString(),
      updatedAt: now.toISOString(), dedupeKey,
      evidenceNotes: input.evidenceNotes, asker: input.asker, urgent: input.urgent,
      changePlan: input.changePlan ? JSON.stringify(input.changePlan) : null,
    };
    const path = recordPath(questionId);
    const body = `# 위키 확인 질문 ${questionId}\n\n${input.question}\n`;
    writeAtomic(path, renderNote(fields, body));
    return { record: { path, fields, body }, duplicate: false };
  });
  if (created.duplicate) return { questionId: created.record.fields.questionId, status: created.record.fields.status, duplicate: true, sent: false };
  if (input.urgent === false) return { questionId: created.record.fields.questionId, status: '묶음대기', duplicate: false, sent: false, queued: true };

  try {
    const response = await sender(questionMessage(created.record.fields, input.question));
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
    // 묶음대기: 아직 묶음으로 안 보냈지만 세션이 먼저 언급해 오너가 답한 경우 — 답으로 인정한다(리뷰 M4).
    if (!['묶음대기', '답변대기', '발송중', '발송결과불명'].includes(fields.status)) {
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
  if (!existsSync(INDEX_PATH)) throw new Error('현재 지식 색인이 없어 키워드를 등록할 수 없습니다.');
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
  const canonical = validateVaultNote(plan.canonicalNote, [VAULT_REL.knowledge]);
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
  return { index: VAULT_REL.knowledgeIndexFile, canonical: plan.canonicalNote, backlinks: backlinkNotes };
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

export async function resendWikiQuestion(questionId, { sender = sendAgentMessage } = {}) {
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
    const response = await sender(questionMessage(latest, record.body.replace(/^# 위키 확인 질문 [^\n]+\n\n/, '').trim()));
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

function questionTextOf(record) {
  return record.body.replace(/^# 위키 확인 질문 [^\n]+\n\n/, '').trim();
}

// 묶음 계획(순수) — 묶음대기 레코드를 담당별로, 만든 순서대로, 메시지 길이 한도 안에서 나눈다.
export function planQuestionDigest(records, { maxChars = DIGEST_MAX_CHARS } = {}) {
  const byAsker = new Map();
  const byCreated = (a, b) => String(a.fields.createdAt).localeCompare(String(b.fields.createdAt))
    || String(a.fields.questionId).localeCompare(String(b.fields.questionId)); // 같은 밀리초면 ID로 고정
  for (const record of [...records].sort(byCreated)) {
    const asker = record.fields.asker ?? 'clio';
    if (!byAsker.has(asker)) byAsker.set(asker, []);
    byAsker.get(asker).push({ id: record.fields.questionId, text: `■ 질문 ID: ${record.fields.questionId}\n${questionItemText(record.fields, questionTextOf(record))}` });
  }
  const chunks = [];
  for (const [asker, items] of byAsker) {
    let current = [];
    let size = 0;
    for (const item of items) {
      if (current.length && size + item.text.length > maxChars) { chunks.push({ asker, items: current }); current = []; size = 0; }
      current.push(item);
      size += item.text.length + 2;
    }
    if (current.length) chunks.push({ asker, items: current });
  }
  return chunks.map(({ asker, items }) => ({
    asker,
    questionIds: items.map((x) => x.id),
    message: { agent: asker, kind: '정보', topic: '질문 묶음', body: [`<b>답이 필요한 질문 ${items.length}개</b>`, ...items.map((x) => x.text)].join('\n\n') },
  }));
}

const ORPHAN_SENDING_MS = 30 * 60 * 1000;

// 청크의 질문들을 갱신하되, 아직 '발송중'인 것만 바꾼다 — 그 사이 오너가 답해 상태가 바뀐 질문은 덮어쓰지 않는다(리뷰 L1).
// 한 질문 기록이 실패해도 나머지는 계속한다(리뷰 L3).
async function markChunk(questionIds, updates) {
  await withLock(QUEUE_LOCK, async () => {
    for (const id of questionIds) {
      try {
        const record = readRecord(id);
        if (record.fields.status === '발송중') writeRecord(record, updates);
      } catch (error) { console.error(`질문 ${id} 상태 기록 실패: ${error.message}`); }
    }
  });
}

// 비긴급 질문 묶음 발송(D68, question-digest 잡이 하루 두 번 호출). 보내기 전에 발송중으로 먼저 기록하고,
// 결과를 확인하지 못하면 발송결과불명으로 남긴다(자동 재발송 없음 — 단건 발송과 같은 원칙).
export async function sendQuestionDigest({ sender = sendAgentMessage, maxChars = DIGEST_MAX_CHARS } = {}) {
  ensureQueue();
  const orphans = [];
  const chunks = await withLock(QUEUE_LOCK, async () => {
    const now = Date.now();
    const waiting = [];
    for (const record of listRecords()) {
      // 이전 묶음 발송이 '발송중'을 기록한 뒤 중단된 경우(전원·강제 종료) — 30분이 지나면 결과 불명으로 드러낸다(리뷰 M1).
      if (record.fields.status === '발송중' && record.fields.digestStartedAt && now - Date.parse(record.fields.digestStartedAt) > ORPHAN_SENDING_MS) {
        writeRecord(record, { status: '발송결과불명', sendError: '묶음 발송 중 중단(발송중으로 30분 넘게 남음)' });
        orphans.push(record.fields.questionId);
        continue;
      }
      if (record.fields.status !== '묶음대기') continue;
      if (Date.parse(record.fields.expiresAt) <= now) { writeRecord(record, { status: '만료', expiredAt: new Date(now).toISOString() }); continue; }
      waiting.push(record);
    }
    const planned = planQuestionDigest(waiting, { maxChars });
    const startedAt = new Date(now).toISOString();
    for (const chunk of planned) for (const id of chunk.questionIds) writeRecord(readRecord(id), { status: '발송중', digestStartedAt: startedAt });
    return planned;
  });
  const results = [];
  for (const chunk of chunks) {
    try {
      const response = await sender(chunk.message);
      const messageId = response?.result?.message_id ?? response?.message_id ?? null;
      if (!Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0) throw new Error('Telegram 성공 응답에 message_id가 없습니다.');
      await markChunk(chunk.questionIds, { status: '답변대기', sentAt: new Date().toISOString(), telegramMessageId: messageId, sentVia: 'digest' });
      results.push({ asker: chunk.asker, questionIds: chunk.questionIds, sent: true, telegramMessageId: messageId });
    } catch (error) {
      const sendError = String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 500);
      // 확실히 안 나간 경우(렌더 실패·텔레그램 명시 거부)는 재발송허용, 그 밖은 결과 불명(자동 재발송 없음).
      const notSent = error?.confirmedNotSent === true || error?.telegramExplicitRejection === true;
      await markChunk(chunk.questionIds, { status: notSent ? '재발송허용' : '발송결과불명', sendError });
      results.push({ asker: chunk.asker, questionIds: chunk.questionIds, sent: false, error: sendError });
    }
  }
  return { chunks: results.length, sent: results.filter((x) => x.sent).length, failed: results.filter((x) => !x.sent).length + (orphans.length ? 1 : 0), orphans, results };
}
