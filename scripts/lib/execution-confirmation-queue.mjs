import { createHash, randomBytes } from 'node:crypto';
import { buildFrontmatter, parseFrontmatter } from './vault-frontmatter.mjs';

const PENDING_STATUS = '대기';
const LEDGER_WRITTEN_STATUS = '기록됨';
const TERMINAL_STATUSES = new Set(['확인됨', '기각', '만료', '처리실패']);

function kstCompactDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}${value('month')}${value('day')}`;
}

function parseAllowedAccounts(raw) {
  try {
    const value = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(value) && value.every((account) => typeof account === 'string') ? value : [];
  } catch {
    return [];
  }
}

export function buildExecutionFingerprint({ firestoreDocId, event }) {
  const immutable = [
    firestoreDocId, event?.broker, event?.tradeDate, event?.tradeType, event?.stockCode,
    event?.stockName, event?.quantity, event?.price, event?.currency, event?.orderNo,
  ].map((value) => String(value ?? '')).join('\u001f');
  return createHash('sha256').update(immutable).digest('hex');
}

export function buildSourceBodyHash(body) {
  return createHash('sha256').update(String(body ?? '')).digest('hex');
}

export function executionConfirmationLockKey(firestoreDocId) {
  const safeId = String(firestoreDocId ?? '').replace(/[^A-Za-z0-9_.-]+/g, '_');
  return `.source-${safeId || 'unknown'}`;
}

export function buildExecutionConfirmation({
  firestoreDocId, event, sourceBody, allowedAccounts, reason, receivedAt = event?.tradeDate ?? '', now = new Date(), random = () => randomBytes(4).toString('hex').toUpperCase(),
}) {
  const id = `EC-${kstCompactDate(now)}-${random()}`;
  const record = {
    id,
    type: 'execution-confirmation',
    status: PENDING_STATUS,
    kind: 'account-assignment',
    firestoreDocId: String(firestoreDocId ?? ''),
    eventFingerprint: buildExecutionFingerprint({ firestoreDocId, event }),
    sourceBodyHash: buildSourceBodyHash(sourceBody),
    broker: String(event?.broker ?? ''),
    receivedAt: String(receivedAt ?? ''),
    tradeDate: String(event?.tradeDate ?? ''),
    tradeType: String(event?.tradeType ?? ''),
    stockCode: String(event?.stockCode ?? ''),
    stockName: String(event?.stockName ?? ''),
    quantity: event?.quantity ?? null,
    price: event?.price ?? null,
    currency: String(event?.currency ?? ''),
    orderNo: String(event?.orderNo ?? ''),
    acctNo: String(event?.acctNo ?? ''),
    allowedAccounts: [...new Set(allowedAccounts ?? [])],
    reason: String(reason ?? ''),
    decision: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    notifiedAt: null,
    decidedAt: null,
    ledgerFile: null,
    archiveFile: null,
  };
  return { record, filename: `${id}.md`, content: serializeExecutionConfirmation(record) };
}

export function serializeExecutionConfirmation(record) {
  const { allowedAccounts: _allowedAccounts, ...flatRecord } = record;
  return `${buildFrontmatter({
    ...flatRecord,
    allowedAccountsJson: JSON.stringify(record.allowedAccounts),
  })}# 체결 기록 확인 대기\n\n${record.stockName} ${record.tradeType} ${record.quantity}주 @${record.price}\n`;
}

export function parseExecutionConfirmation(content) {
  const { allowedAccountsJson, ...record } = parseFrontmatter(content);
  return { ...record, allowedAccounts: parseAllowedAccounts(allowedAccountsJson) };
}

export function findPendingConfirmation(records, { firestoreDocId, event, sourceBody }) {
  const match = findExactExecutionConfirmation(records, { firestoreDocId, event, sourceBody });
  return match?.status === PENDING_STATUS ? match : null;
}

export function findExactExecutionConfirmation(records, { firestoreDocId, event, sourceBody }) {
  const fingerprint = buildExecutionFingerprint({ firestoreDocId, event });
  const matches = (records ?? []).filter((record) => (
    record.firestoreDocId === String(firestoreDocId ?? '')
    && record.eventFingerprint === fingerprint
    && record.sourceBodyHash === buildSourceBodyHash(sourceBody)
  ));
  return matches.length === 1 ? matches[0] : null;
}

export function findPendingConfirmationByFirestoreDoc(records, firestoreDocId) {
  const matches = (records ?? []).filter((record) => (
    record.status === PENDING_STATUS && record.firestoreDocId === String(firestoreDocId ?? '')
  ));
  return matches.length === 1 ? matches[0] : null;
}

export function countPendingConfirmationsForFirestoreDoc(records, firestoreDocId) {
  return (records ?? []).filter((record) => (
    record.status === PENDING_STATUS && record.firestoreDocId === String(firestoreDocId ?? '')
  )).length;
}

// 같은 Firestore 원문에 확인 이력이 하나라도 있으면 자동 파서가 Ledger·보관 파일을
// 쓰거나 원문을 지우면 안 된다. 특히 "무시"·"기록됨"은 대기가 아니어도 자동 처리의
// 근거가 될 수 없으며, 변경 원문은 prepareExecutionConfirmation이 새 확인으로 갱신한다.
export function hasExecutionConfirmationForFirestoreDoc(records, firestoreDocId) {
  return (records ?? []).some((record) => record.firestoreDocId === String(firestoreDocId ?? ''));
}

// 같은 Firestore 문서가 처리 전 수정됐을 때는 새 확인 ID를 만들지 않는다. 기존 ID의
// 스냅샷을 현재 원문으로 교체하고 다시 알림을 보내, 오너가 바뀐 수량·가격을 확인하게 한다.
export function refreshExecutionConfirmation({ record, event, sourceBody, allowedAccounts, reason, receivedAt, now = new Date() }) {
  if (record?.status !== PENDING_STATUS) throw new Error('대기 상태인 체결 확인 건만 갱신할 수 있습니다');
  return {
    ...record,
    eventFingerprint: buildExecutionFingerprint({ firestoreDocId: record.firestoreDocId, event }),
    sourceBodyHash: buildSourceBodyHash(sourceBody),
    broker: String(event?.broker ?? ''),
    receivedAt: String(receivedAt ?? event?.tradeDate ?? ''),
    tradeDate: String(event?.tradeDate ?? ''),
    tradeType: String(event?.tradeType ?? ''),
    stockCode: String(event?.stockCode ?? ''),
    stockName: String(event?.stockName ?? ''),
    quantity: event?.quantity ?? null,
    price: event?.price ?? null,
    currency: String(event?.currency ?? ''),
    orderNo: String(event?.orderNo ?? ''),
    acctNo: String(event?.acctNo ?? ''),
    allowedAccounts: [...new Set(allowedAccounts ?? [])],
    reason: String(reason ?? ''),
    notifiedAt: null,
    updatedAt: now.toISOString(),
  };
}

export function resolveExecutionConfirmation(record, account, now = new Date()) {
  if (record?.status !== PENDING_STATUS && record?.status !== LEDGER_WRITTEN_STATUS) {
    throw new Error('확인 대기 상태가 아닌 체결 확인 건입니다');
  }
  if (record.kind !== 'account-assignment') throw new Error(`지원하지 않는 확인 종류입니다: ${record.kind}`);
  if (!record.allowedAccounts?.includes(account)) throw new Error('허용 계좌 중 하나를 지정해야 합니다');
  if (record.status === LEDGER_WRITTEN_STATUS && record.decision !== account) {
    throw new Error('Ledger 기록 중인 계좌와 다른 계좌로 바꿀 수 없습니다');
  }
  return {
    ...record,
    status: '확인됨',
    decision: account,
    decidedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function markExecutionConfirmationArtifactWritten(record, account, artifact, now = new Date()) {
  if (record?.status !== PENDING_STATUS && record?.status !== LEDGER_WRITTEN_STATUS) {
    throw new Error('대기 상태인 체결 확인 건만 Ledger 기록 상태로 전이할 수 있습니다');
  }
  if (!record.allowedAccounts?.includes(account)) throw new Error('허용 계좌 중 하나를 지정해야 합니다');
  if (record.status === LEDGER_WRITTEN_STATUS && record.decision !== account) {
    throw new Error('Ledger 기록 중인 계좌와 다른 계좌로 바꿀 수 없습니다');
  }
  return {
    ...record,
    status: LEDGER_WRITTEN_STATUS,
    decision: account,
    ledgerFile: artifact.ledgerFile ?? null,
    archiveFile: artifact.archiveFile ?? null,
    updatedAt: now.toISOString(),
  };
}

export function markExecutionConfirmationLedgerWritten(record, account, ledgerFile, now = new Date()) {
  return markExecutionConfirmationArtifactWritten(record, account, { ledgerFile }, now);
}

export function rejectExecutionConfirmation(record, now = new Date()) {
  if (record?.status !== PENDING_STATUS) throw new Error('대기 상태인 체결 확인 건만 무시할 수 있습니다');
  return {
    ...record,
    status: '기각',
    decision: '무시',
    decidedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function isTerminalExecutionConfirmation(record) {
  return TERMINAL_STATUSES.has(record?.status);
}
