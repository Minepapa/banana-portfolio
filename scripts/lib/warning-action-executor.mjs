// 등록된 거시 조회 경고 한 건당 단일 ^VIX 읽기 재조회만 실행한다.
// 감지 원장이 첫 실패의 근거다. 이 파일은 주문·장부·설정·Telegram을 변경하지 않는다.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { VAULT_PATHS } from './vault-paths.mjs';
import { withLock } from './state-writer.mjs';
import { appendWarningEvent, readWarningEvents, rebuildWarningIncidents } from './warning-event-journal.mjs';
import { planAutomaticMacroRetry } from './warning-action-plan.mjs';
import { diagnoseWarningIncident } from './warning-runbook.mjs';

const DEFAULT_ROOT = join(VAULT_PATHS.root, 'Log', 'WarningEvents');

function currentDate(now) {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error('경고 조치 기준시각 오류');
  }
  return date;
}

function loadCandidate(incidentId, rootDir, now) {
  const rebuilt = rebuildWarningIncidents({ rootDir });
  const matches = rebuilt.incidents.filter((incident) => incident.incidentId === incidentId);
  if (rebuilt.invalidRows.length || matches.length !== 1) {
    throw new Error('사건을 유일하게 확인할 수 없거나 원장에 손상·충돌 행이 있음');
  }
  const detected = rebuilt.acceptedEvents.filter((event) => event.incidentId === incidentId
    && event.eventType === 'detected').map((event) => event.occurredAt).sort();
  const incident = {
    ...matches[0], classification: 'cataloged', lastDetectedAt: detected.at(-1) ?? null,
  };
  const plan = planAutomaticMacroRetry(incident);
  const elapsedMs = now.getTime() - Date.parse(incident.lastDetectedAt);
  if (elapsedMs < plan.cooldownMs) {
    return { incident, plan, eligible: false, reason: '마지막 경고 감지 후 30분 대기 중' };
  }
  return { incident, plan, eligible: true, reason: '재조회 가능' };
}

function actionEvent(incident, actionStatus, occurredAt, actionOutcome) {
  return {
    eventId: randomUUID(), occurredAt, incidentId: incident.incidentId,
    jobName: incident.jobName, warningCode: incident.warningCode,
    subjectKey: incident.subjectKey, kind: incident.kind,
    severity: incident.severity, eventType: 'action',
    actionId: 'MACRO_SINGLE_READ_RETRY', actionStatus,
    ...(actionOutcome ? { actionOutcome } : {}),
  };
}

// 같은 incidentId를 원인 키로 재사용하므로, 검증된 5지표 회복 이후의 새 감지는
// 별도 장애 구간이다. 완료된 이전 구간의 재조회 claim은 새 구간을 막지 않는다.
export function hasMacroRetryClaimInCurrentEpisode(events, incidentId) {
  const lastResolvedIndex = events.findLastIndex((event) => event.incidentId === incidentId
    && event.eventType === 'status' && event.incidentStatus === 'resolved');
  return events.some((event, index) => index > lastResolvedIndex && event.incidentId === incidentId
    && event.eventType === 'action' && event.actionId === 'MACRO_SINGLE_READ_RETRY'
    // running은 네트워크 전에 반드시 기록된다. 뒤늦은 terminal이 회복 이벤트보다
    // 나중에 찍혀도 이전 장애 구간의 시도를 새 구간 claim으로 오인하지 않는다.
    && event.actionStatus === 'running');
}

// 원 잡이 다섯 지표를 모두 유한 종가로 조회한 경우에만 가용성 장애를 닫는다.
// 단일 VIX 재조회 성공은 이 함수를 호출하지 않는다.
export async function markMacroWarningRecovered({
  rootDir = DEFAULT_ROOT, observedAt = new Date(), recordedAt = () => new Date(),
} = {}) {
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
    throw new Error('거시 조회 회복시각 오류');
  }
  if (!existsSync(rootDir)) return false;
  return withLock(join(rootDir, '.macro-read-retry'), async () => {
    const rebuilt = rebuildWarningIncidents({ rootDir });
    if (rebuilt.invalidRows.length) throw new Error('손상된 경고 원장에서는 회복 판정 보류');
    const matches = rebuilt.incidents.filter((incident) => incident.jobName === 'intraday-market-move-monitor'
      && incident.warningCode === 'MACRO_YFINANCE_QUERY_FAILED'
      && incident.subjectKey === 'macro:yfinance' && incident.kind === 'operational');
    if (matches.length > 1) throw new Error('거시 경고 사건 중복 — 회복 판정 보류');
    const incident = matches[0];
    if (!incident || !['open', 'reopened'].includes(incident.status)) return false;
    // 정상 조회 뒤 새 실패가 감지됐다면 그 정상 조회로 최신 장애를 닫지 않는다.
    const latestDetection = rebuilt.acceptedEvents.filter((event) => event.incidentId === incident.incidentId
      && event.eventType === 'detected').map((event) => event.occurredAt).sort().at(-1);
    if (latestDetection >= observedAt.toISOString()) return false;
    const recorded = recordedAt();
    if (!(recorded instanceof Date) || !Number.isFinite(recorded.getTime()) || recorded < observedAt) {
      throw new Error('거시 경고 회복 기록시각 오류');
    }
    await appendWarningEvent({
      eventId: randomUUID(), occurredAt: recorded.toISOString(),
      incidentId: incident.incidentId, jobName: incident.jobName,
      warningCode: incident.warningCode, subjectKey: incident.subjectKey,
      kind: incident.kind, severity: incident.severity,
      eventType: 'status', incidentStatus: 'resolved',
    }, { rootDir });
    return true;
  });
}

// dry-run/shadow는 네트워크·원장 쓰기 없이 같은 사전조건만 판정한다.
// live는 원장에 running을 먼저 영속화한다. 이후 종료·결과기록 실패가 나도
// 재시도하지 않아 사건당 한 번의 읽기 조회 상한을 지킨다.
export async function runMacroReadRetry(incidentId, {
  rootDir = DEFAULT_ROOT, mode = 'dry-run', now = () => new Date(),
  probe = spawnSync, fileExists = existsSync,
} = {}) {
  if (!['dry-run', 'shadow', 'live'].includes(mode)) throw new Error('허용되지 않은 조치 모드');
  const asOf = currentDate(now);
  const candidate = loadCandidate(incidentId, rootDir, asOf);
  const { events, invalidRows } = readWarningEvents({ rootDir });
  if (invalidRows.length) throw new Error('손상된 경고 원장에서는 자동조치 보류');
  const alreadyClaimed = hasMacroRetryClaimInCurrentEpisode(events, incidentId);
  if (!candidate.eligible || alreadyClaimed) {
    return {
      incidentId, mode, actionId: candidate.plan.actionId, executed: false,
      reason: alreadyClaimed ? '이 사건의 재조회 시도가 이미 기록됨' : candidate.reason,
    };
  }
  if (mode !== 'live') {
    return {
      incidentId, mode, actionId: candidate.plan.actionId,
      executed: false, wouldRun: true, reason: '고정 ^VIX 읽기 1회 가능; 이 모드에서는 실행 안 함',
    };
  }

  // 별도 조치 잠금 아래 재조회 가능성 및 기존 claim을 다시 읽어 동시 실행을 막는다.
  const claim = await withLock(join(rootDir, '.macro-read-retry'), async () => {
    const fresh = loadCandidate(incidentId, rootDir, currentDate(now));
    const history = readWarningEvents({ rootDir });
    if (history.invalidRows.length) throw new Error('손상된 경고 원장에서는 자동조치 보류');
    if (!fresh.eligible || hasMacroRetryClaimInCurrentEpisode(history.events, incidentId)) return null;
    await appendWarningEvent(actionEvent(fresh.incident, 'running', currentDate(now).toISOString()), { rootDir });
    return fresh.incident;
  });
  if (!claim) {
    return { incidentId, mode, actionId: candidate.plan.actionId, executed: false,
      reason: '동시 실행 또는 상태 변경으로 재조회 보류' };
  }

  const diagnosis = diagnoseWarningIncident(claim, { probe, fileExists });
  const actionStatus = diagnosis.outcome === 'source-available-now' ? 'succeeded' : 'failed';
  await appendWarningEvent(actionEvent(claim, actionStatus, currentDate(now).toISOString(), diagnosis.outcome), { rootDir });
  return {
    incidentId, mode, actionId: candidate.plan.actionId, executed: true,
    outcome: diagnosis.outcome, actionStatus,
    incidentResolved: false,
  };
}
