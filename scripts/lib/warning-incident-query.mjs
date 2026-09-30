// 경고 원장의 읽기 전용 조회. 원문 경고·예외·계좌번호 대신 검증된 사건 필드만 반환한다.
import { createHash } from 'node:crypto';
import { rebuildWarningIncidents } from './warning-event-journal.mjs';

const KST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
});
const SAFE_SUMMARIES = Object.freeze({
  BREAKOUT_FILL_PRICE_UNKNOWN: '돌파매매 매수 체결 평균단가 확인 불가',
  BREAKOUT_FILL_WATCH_TIMEOUT: '돌파매매 매수 체결 확인 시간 초과',
  BREAKOUT_INDEX_QUERY_FAILED: '돌파매매 신호 판정에 필요한 지수 조회 실패',
  BREAKOUT_PARTIAL_CANCELED_REVIEW: '돌파매매 부분체결 후 취소 상태 확인 필요',
  BREAKOUT_PARTIAL_FILL_PRICE_UNKNOWN: '돌파매매 장후 부분체결 평균가 확인 불가',
  BREAKOUT_PRICE_CACHE_LOW_COVERAGE: '돌파매매 시세 캐시 정합률 부족',
  BREAKOUT_PROTECTION_URGENT: '돌파매매 보호주문 또는 청산 관리 확인 필요',
  BREAKOUT_STOP_ORDER_FAILED: '돌파매매 체결 후 손절 보호주문 실패',
  DUPLICATE_APPROVED_PROPOSAL: '동일 안건의 승인 제안이 중복됨',
  EXECUTION_CONFIRMATION_NEEDED: '체결 기록에 오너 확인 필요',
  INSTRUMENT_REPLACEMENT_PARTIAL_SEND: '종목 교체 제안의 일부만 발송됨',
  JOB_HEALTH_ISSUES: '자동화 잡 상태 이상',
  JOB_HEARTBEAT_FAILED: '자동화 잡 실행 실패',
  KIS_FILL_WATCH_TIMEOUT: 'KIS 주문 체결 확인 시간 초과',
  MACRO_YFINANCE_QUERY_FAILED: '장중 거시 지표 조회 실패',
  MARKET_OVERLAY_SIGNAL: '자산분배 시장 신호',
  MARKET_THRESHOLD_BREACHED: '장중 시장 임계 신호',
  NH_FILL_LEDGER_WRITE_BLOCKED: 'NH 체결 확인 후 장부 기록 보류',
  NH_FILL_WATCH_START_FAILED: 'NH 체결 감시 시작 실패',
  NH_FILL_WATCH_TIMEOUT: 'NH 주문 체결 확인 시간 초과',
  PROPOSAL_APPROVAL_LINK_BROKEN: '제안 승인 연결정보 이상',
  PROPOSAL_GATE_BLOCKED: '제안 주문 검문소 차단',
  TELEGRAM_SESSION_UNHEALTHY: '텔레그램 세션 상태 이상',
  VAULT_HEALTH_FINDINGS: 'Vault 정합성 점검 결과 확인 필요',
});

function kstDate(iso) {
  const parts = Object.fromEntries(KST_DAY.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function safeIdentifier(value) {
  if (!/(?:\d[ ._-]?){7,}\d/.test(value)) return value;
  return `redacted-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

export function queryWarningIncidents({ rootDir, filters = {}, now = new Date() } = {}) {
  const rebuilt = rebuildWarningIncidents(rootDir ? { rootDir } : undefined);
  const lastDetectedAt = new Map();
  const latestAttempt = new Map();
  const latestAction = new Map();
  const actionAttempts = new Map();
  for (const event of rebuilt.acceptedEvents) {
    if (event.eventType === 'detected') {
      const previous = lastDetectedAt.get(event.incidentId);
      if (!previous || event.occurredAt > previous) lastDetectedAt.set(event.incidentId, event.occurredAt);
    }
    if (event.eventType === 'action' && event.actionId === 'MACRO_SINGLE_READ_RETRY') {
      if (event.actionStatus === 'running') {
        actionAttempts.set(event.incidentId, (actionAttempts.get(event.incidentId) ?? 0) + 1);
      }
      const previous = latestAction.get(event.incidentId);
      if (!previous || event.occurredAt >= previous.occurredAt) latestAction.set(event.incidentId, event);
    }
    if (event.eventType !== 'delivery' || !event.deliveryAttemptId) continue;
    const attemptKey = `${event.incidentId}|${event.deliveryAttemptId}`;
    const previous = latestAttempt.get(attemptKey);
    if (!previous || event.occurredAt >= previous.occurredAt) latestAttempt.set(attemptKey, event);
  }
  const asOf = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(asOf.getTime())) throw new Error('조회 기준시각 형식 오류');
  const unknownByIncident = new Map();
  const incompleteByIncident = new Map();
  for (const event of latestAttempt.values()) {
    const target = event.deliveryStatus === 'unknown' ? unknownByIncident
      : ['sending', 'reserved'].includes(event.deliveryStatus)
        && asOf.getTime() - Date.parse(event.occurredAt) >= 5 * 60_000 ? incompleteByIncident : null;
    if (!target) continue;
    const entry = target.get(event.incidentId) ?? { count: 0, oldestAt: event.occurredAt };
    entry.count++;
    if (event.occurredAt < entry.oldestAt) entry.oldestAt = event.occurredAt;
    target.set(event.incidentId, entry);
  }
  const incidents = rebuilt.incidents
    .filter((incident) => {
      const detectedAt = lastDetectedAt.get(incident.incidentId);
      const day = detectedAt ? kstDate(detectedAt) : null;
      return (!filters.from || (day && day >= filters.from))
        && (!filters.to || (day && day <= filters.to))
        && (!filters.job || incident.jobName === filters.job)
        && (!filters.kind || incident.kind === filters.kind)
        && (!filters.incident || incident.incidentId === filters.incident
          || safeIdentifier(incident.incidentId) === filters.incident)
        && (!filters.warningCode || incident.warningCode === filters.warningCode)
        && (!filters.delivery || incident.lastDeliveryStatus === filters.delivery
          || (filters.delivery === 'unknown' && unknownByIncident.has(incident.incidentId)))
        && (!filters.unresolved || incident.status !== 'resolved');
    })
    .map((incident) => {
      const unknown = unknownByIncident.get(incident.incidentId);
      const incomplete = incompleteByIncident.get(incident.incidentId);
      const cataloged = Object.hasOwn(SAFE_SUMMARIES, incident.warningCode);
      return {
        incidentId: safeIdentifier(incident.incidentId),
        jobName: safeIdentifier(incident.jobName),
        warningCode: incident.warningCode,
        kind: incident.kind,
        severity: incident.severity,
        firstSeen: incident.firstSeen,
        lastSeen: incident.lastSeen,
        lastDetectedAt: lastDetectedAt.get(incident.incidentId) ?? null,
        detectedCount: incident.detectedCount,
        suppressedCount: incident.suppressedCount,
        lastDeliveryStatus: incident.lastDeliveryStatus,
        status: incident.status,
        actionAttemptCount: actionAttempts.get(incident.incidentId) ?? 0,
        lastActionStatus: latestAction.get(incident.incidentId)?.actionStatus ?? null,
        lastActionOutcome: latestAction.get(incident.incidentId)?.actionOutcome ?? null,
        safeSummary: SAFE_SUMMARIES[incident.warningCode] ?? '분류되지 않은 경고 — 원문은 잡 로그에서 확인',
        classification: incident.kind === 'legacy-unstructured' ? 'legacy'
          : incident.kind === 'market-signal' ? 'market-signal'
            : incident.kind === 'owner-decision' ? 'owner-decision'
              : cataloged ? 'cataloged' : 'uncataloged',
        unknownDeliveryCount: unknown?.count ?? 0,
        oldestUnknownAgeMinutes: unknown
          ? Math.max(0, Math.floor((asOf.getTime() - Date.parse(unknown.oldestAt)) / 60_000)) : null,
        incompleteDeliveryCount: incomplete?.count ?? 0,
        oldestIncompleteAgeMinutes: incomplete
          ? Math.floor((asOf.getTime() - Date.parse(incomplete.oldestAt)) / 60_000) : null,
      };
    })
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.incidentId.localeCompare(b.incidentId));
  return {
    incidents: incidents.slice(0, filters.limit ?? 50),
    total: incidents.length,
    invalidRows: rebuilt.invalidRows,
  };
}
