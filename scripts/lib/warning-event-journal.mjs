// 운영 경고의 append-only 이벤트 원장. 이 모듈은 텔레그램 발송이나 자가조치를 하지 않는다.
// 월별 JSONL은 Vault 안에 있어 야간 backup-vault 스냅샷 대상이 된다. 원본 오류 필드는
// 받지 않고 코드/상태만 저장한다. 식별자의 민감정보 여부는 호출부에서도 검증해야 한다.
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, statSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { VAULT_REL, vaultAbs } from './vault-paths.mjs';
import { withLock } from './state-writer.mjs';

export const WARNING_JOURNAL_ROOT = vaultAbs(VAULT_REL.logWarningEvents);
const DEFAULT_ROOT = WARNING_JOURNAL_ROOT;
const SCHEMA_VERSION = 1;
const EVENT_TYPES = new Set(['detected', 'delivery', 'status', 'action']);
const KINDS = new Set(['operational', 'data-quality', 'trade-safety', 'market-signal', 'owner-decision', 'informational', 'legacy-unstructured']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'info', 'unclassified']);
const DELIVERY_STATUSES = new Set(['reserved', 'sending', 'sent', 'rejected', 'unknown', 'suppressed']);
const SUPPRESSION_REASONS = new Set(['recent-send', 'active-reservation', 'unknown-delivery']);
const INCIDENT_STATUSES = new Set(['open', 'diagnosing', 'awaiting-owner', 'mitigating', 'verifying', 'resolved', 'reopened']);
const ACTION_STATUSES = new Set(['proposed', 'dry-run', 'approved', 'running', 'succeeded', 'failed', 'rolled-back']);
const ACTION_OUTCOMES = new Set([
  'source-script-missing', 'python-missing', 'probe-timeout', 'dependency-missing',
  'probe-failed', 'response-invalid', 'data-empty', 'source-available-now',
]);
const INPUT_FIELDS = new Set([
  'eventId', 'occurredAt', 'incidentId', 'jobName', 'warningCode', 'subjectKey', 'kind', 'severity', 'eventType',
  'deliveryStatus', 'incidentStatus', 'actionStatus', 'legacyFingerprint',
  'deliveryAttemptId', 'telegramMessageId', 'suppressedBy',
  'actionId', 'actionOutcome',
  'targetJob', 'detail',
]);
const SAFE_KEY = /^[\p{L}\p{N}:_.-]{1,128}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validKey(value) {
  return typeof value === 'string' && SAFE_KEY.test(value);
}

export function sanitizeWarningDetail(value) {
  const redacted = String(value ?? '')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/["']?(?:app[_-]?key|app[_-]?secret(?:key)?|access[_-]?token|token)["']?\s*[:=]\s*["']?[^"'\s,;}]+["']?/gi, '[REDACTED]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED]')
    .replace(/\d[\d-]{7,}\d|\b\d{8,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9]{32,}\b/g, '[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ');
  const detail = redacted.slice(0, 200);
  const lastMarker = redacted.lastIndexOf('[REDACTED]', 199);
  // 가림 표식의 중간을 자르면 재검증 시 표식이 다시 늘어나 원장 기록이 거부된다.
  return lastMarker >= 0 && lastMarker + '[REDACTED]'.length > 200
    ? detail.slice(0, lastMarker) : detail;
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('경고 이벤트는 객체여야 함');
  for (const key of Object.keys(input)) {
    if (!INPUT_FIELDS.has(key)) throw new Error('허용되지 않은 경고 이벤트 필드');
  }
  if (typeof input.eventId !== 'string' || !UUID_RE.test(input.eventId)) {
    throw new Error('경고 이벤트 ID 형식 오류');
  }
  if (typeof input.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.occurredAt)
    || Number.isNaN(Date.parse(input.occurredAt))
    || new Date(input.occurredAt).toISOString() !== input.occurredAt) throw new Error('경고 발생시각 오류');
  if (!validKey(input.incidentId) || !validKey(input.jobName) || !validKey(input.subjectKey)
    || (input.subjectKey.match(/\d/g) ?? []).length >= 7) {
    throw new Error('경고 이벤트 식별자 형식 오류');
  }
  if ('targetJob' in input && !validKey(input.targetJob)) throw new Error('대상 잡 이름 형식 오류');
  if ('detail' in input && (typeof input.detail !== 'string' || input.detail.length > 200
    || input.detail !== sanitizeWarningDetail(input.detail))) throw new Error('경고 상세 형식 오류');
  if (typeof input.warningCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,79}$/.test(input.warningCode)) {
    throw new Error('warningCode 형식 오류');
  }
  if (!KINDS.has(input.kind) || !SEVERITIES.has(input.severity) || !EVENT_TYPES.has(input.eventType)) {
    throw new Error('경고 이벤트 분류/심각도/종류 오류');
  }
  const statusFields = ['deliveryStatus', 'incidentStatus', 'actionStatus'];
  const matchingField = { delivery: 'deliveryStatus', status: 'incidentStatus', action: 'actionStatus' }[input.eventType];
  for (const field of statusFields) {
    if (field in input && field !== matchingField) throw new Error(`이벤트 종류와 상태 필드 불일치: ${field}`);
  }
  if (matchingField && !({ deliveryStatus: DELIVERY_STATUSES, incidentStatus: INCIDENT_STATUSES, actionStatus: ACTION_STATUSES }[matchingField]).has(input[matchingField])) {
    throw new Error(`경고 이벤트 상태 오류: ${matchingField}`);
  }
  if ('legacyFingerprint' in input && (typeof input.legacyFingerprint !== 'string'
    || !/^[0-9a-f]{40}$/.test(input.legacyFingerprint))) throw new Error('레거시 경고 지문 형식 오류');
  if (input.eventType === 'delivery') {
    if (input.deliveryStatus === 'suppressed') {
      if (!SUPPRESSION_REASONS.has(input.suppressedBy) || 'deliveryAttemptId' in input) {
        throw new Error('억제 사유/시도 ID 형식 오류');
      }
    } else if (typeof input.deliveryAttemptId !== 'string' || !UUID_RE.test(input.deliveryAttemptId)
      || 'suppressedBy' in input) {
      throw new Error('전달 시도 ID 형식 오류');
    }
    if (input.deliveryStatus === 'sent') {
      if (!Number.isSafeInteger(input.telegramMessageId) || input.telegramMessageId <= 0) {
        throw new Error('Telegram 메시지 ID 형식 오류');
      }
    } else if ('telegramMessageId' in input) throw new Error('전달 상태와 Telegram 메시지 ID 불일치');
  } else if (['deliveryAttemptId', 'telegramMessageId', 'suppressedBy'].some((key) => key in input)) {
    throw new Error('전달 필드는 전달 이벤트에만 허용');
  }
  if (input.eventType === 'action') {
    if (input.actionId !== 'MACRO_SINGLE_READ_RETRY'
      || (input.actionStatus === 'running' && 'actionOutcome' in input)
      || (input.actionStatus !== 'running' && !ACTION_OUTCOMES.has(input.actionOutcome))) {
      throw new Error('허용되지 않은 경고 조치 또는 결과');
    }
  } else if ('actionId' in input || 'actionOutcome' in input) {
    throw new Error('조치 필드는 조치 이벤트에만 허용');
  }
}

function monthInKst(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year').value;
  const month = parts.find((part) => part.type === 'month').value;
  return `${year}-${month}`;
}

function validatePersistedEvent(event) {
  if (!event || event.schemaVersion !== SCHEMA_VERSION || typeof event.eventId !== 'string'
    || Number.isNaN(Date.parse(event.occurredAt)) || typeof event.incidentKey !== 'string') {
    throw new Error('지원하지 않는 원장 행');
  }
  const input = Object.fromEntries([...INPUT_FIELDS].filter((key) => key in event).map((key) => [key, event[key]]));
  validateInput(input);
  if (event.incidentKey !== `${event.jobName}|${event.warningCode}|${event.subjectKey}`) {
    throw new Error('사건 키 불일치');
  }
  if (Object.keys(event).some((key) => !INPUT_FIELDS.has(key) && !['schemaVersion', 'eventId', 'occurredAt', 'incidentKey'].includes(key))) {
    throw new Error('원장 행에 허용되지 않은 필드');
  }
}

// 호출자는 전송/기록 재시도에도 같은 eventId·occurredAt을 전달해야 한다.
export async function appendWarningEvent(input, { rootDir = DEFAULT_ROOT, lockOptions = {} } = {}) {
  validateInput(input);
  const occurredAt = new Date(input.occurredAt);
  const event = {
    schemaVersion: SCHEMA_VERSION, eventId: input.eventId, occurredAt: input.occurredAt,
    incidentId: input.incidentId,
    incidentKey: `${input.jobName}|${input.warningCode}|${input.subjectKey}`,
    jobName: input.jobName, warningCode: input.warningCode, subjectKey: input.subjectKey,
    kind: input.kind, severity: input.severity, eventType: input.eventType,
  };
  const statusField = { delivery: 'deliveryStatus', status: 'incidentStatus', action: 'actionStatus' }[input.eventType];
  if (statusField) event[statusField] = input[statusField];
  for (const field of ['legacyFingerprint', 'deliveryAttemptId', 'telegramMessageId', 'suppressedBy', 'actionId', 'actionOutcome', 'targetJob', 'detail']) {
    if (field in input) event[field] = input[field];
  }

  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  chmodSync(rootDir, 0o700);
  const path = join(rootDir, `${monthInKst(occurredAt)}.jsonl`);
  await withLock(join(rootDir, '.journal'), () => {
    const newMonthlyFile = !existsSync(path);
    const fd = openSync(path, 'a+', 0o600);
    try {
      chmodSync(path, 0o600);
      const size = statSync(path).size;
      if (size > 0) {
        const existing = readFileSync(path, 'utf8').split('\n').find((line) => {
          try { return JSON.parse(line).eventId === event.eventId; } catch { return false; }
        });
        if (existing) {
          if (existing !== JSON.stringify(event)) throw new Error('같은 이벤트 ID의 내용 불일치');
          return;
        }
      }
      if (size > 0) {
        const lastByte = Buffer.alloc(1);
        readSync(fd, lastByte, 0, 1, size - 1);
        if (lastByte[0] !== 10) writeSync(fd, Buffer.from('\n'));
      }
      const line = Buffer.from(`${JSON.stringify(event)}\n`);
      let offset = 0;
      while (offset < line.length) offset += writeSync(fd, line, offset, line.length - offset);
      fsyncSync(fd);
      // 새 달의 첫 running claim은 파일 데이터뿐 아니라 디렉터리 엔트리도
      // 확정해야 전원 장애 후 그 파일이 사라져 재조회가 반복되는 일을 막는다.
      if (newMonthlyFile) {
        const directoryFd = openSync(rootDir, 'r');
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      }
    } finally {
      closeSync(fd);
    }
  }, lockOptions);
  return event;
}

export function readWarningEvents({ rootDir = DEFAULT_ROOT } = {}) {
  if (!existsSync(rootDir)) return { events: [], invalidRows: [] };
  const events = [];
  const invalidRows = [];
  const files = readdirSync(rootDir).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
  for (const file of files) {
    const lines = readFileSync(join(rootDir, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!line) return;
      try {
        const event = JSON.parse(line);
        validatePersistedEvent(event);
        events.push(event);
      } catch {
        invalidRows.push({ file, line: index + 1, reason: '손상되거나 지원하지 않는 행' });
      }
    });
  }
  return { events, invalidRows };
}

// 요약은 원장의 파생값이다. 재시작·인덱스 손상 때 이 함수로 다시 계산한다.
export function rebuildWarningIncidents({ rootDir = DEFAULT_ROOT } = {}) {
  const { events, invalidRows } = readWarningEvents({ rootDir });
  const byId = new Map();
  const acceptedEvents = [];
  const seenEventIds = new Map();
  const latestStatusAt = new Map();
  const latestDetectedAt = new Map();
  const latestStatusIndex = new Map();
  const latestDetectedIndex = new Map();
  const latestDeliveryAt = new Map();
  const severityRank = { unclassified: -1, info: 0, medium: 1, high: 2, critical: 3 };
  for (const [index, event] of events.entries()) {
    if (seenEventIds.has(event.eventId)) {
      if (seenEventIds.get(event.eventId) !== JSON.stringify(event)) {
        invalidRows.push({ file: null, line: null, reason: '이벤트 ID 내용 충돌' });
      }
      continue;
    }
    seenEventIds.set(event.eventId, JSON.stringify(event));
    let incident = byId.get(event.incidentId);
    if (incident && incident.incidentKey !== event.incidentKey) {
      invalidRows.push({ file: null, line: null, reason: '사건 ID 키 충돌' });
      continue;
    }
    acceptedEvents.push(event);
    if (!incident) {
      incident = {
        incidentId: event.incidentId, incidentKey: event.incidentKey,
        jobName: event.jobName, warningCode: event.warningCode,
        subjectKey: event.subjectKey, kind: event.kind, severity: event.severity,
        firstSeen: event.occurredAt, lastSeen: event.occurredAt,
        detectedCount: 0, suppressedCount: 0, lastDeliveryStatus: null, status: 'open',
      };
      byId.set(event.incidentId, incident);
    }
    if (event.occurredAt < incident.firstSeen) incident.firstSeen = event.occurredAt;
    if (event.occurredAt > incident.lastSeen) incident.lastSeen = event.occurredAt;
    if (severityRank[event.severity] > severityRank[incident.severity]) incident.severity = event.severity;
    if (event.eventType === 'detected') {
      incident.detectedCount++;
      const prior = latestDetectedAt.get(event.incidentId);
      if (!prior || event.occurredAt >= prior) {
        latestDetectedAt.set(event.incidentId, event.occurredAt);
        latestDetectedIndex.set(event.incidentId, index);
      }
    }
    if (event.eventType === 'delivery') {
      if ((event.deliveryStatus !== 'suppressed' || !latestDeliveryAt.has(event.incidentId))
        && (!latestDeliveryAt.has(event.incidentId) || event.occurredAt >= latestDeliveryAt.get(event.incidentId))) {
        incident.lastDeliveryStatus = event.deliveryStatus;
        latestDeliveryAt.set(event.incidentId, event.occurredAt);
      }
      if (event.deliveryStatus === 'suppressed') incident.suppressedCount++;
    }
    if (event.eventType === 'status'
      && (!latestStatusAt.has(event.incidentId) || event.occurredAt >= latestStatusAt.get(event.incidentId))) {
      incident.status = event.incidentStatus;
      latestStatusAt.set(event.incidentId, event.occurredAt);
      latestStatusIndex.set(event.incidentId, index);
    }
  }
  for (const incident of byId.values()) {
    if (incident.status === 'resolved'
      && (latestDetectedAt.get(incident.incidentId) > latestStatusAt.get(incident.incidentId)
        || (latestDetectedAt.get(incident.incidentId) === latestStatusAt.get(incident.incidentId)
          && latestDetectedIndex.get(incident.incidentId) > latestStatusIndex.get(incident.incidentId)))) {
      incident.status = 'reopened';
    }
  }
  return { incidents: [...byId.values()], invalidRows, acceptedEvents };
}
