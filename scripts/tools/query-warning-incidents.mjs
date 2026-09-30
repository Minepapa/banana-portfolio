#!/usr/bin/env node
// 경고 사건의 읽기 전용 조회. 원장·잡 상태·실계좌 API·Telegram을 변경/호출하지 않는다.
// --from/--to는 마지막 detected 이벤트를 KST 날짜로 비교한다(전달·해결 시각 제외).
import { queryWarningIncidents } from '../lib/warning-incident-query.mjs';

const KINDS = new Set(['operational', 'data-quality', 'trade-safety', 'market-signal', 'owner-decision', 'informational', 'legacy-unstructured']);
const DELIVERY = new Set(['reserved', 'sending', 'sent', 'rejected', 'unknown', 'suppressed']);

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

export function parseWarningQueryArgs(argv) {
  const filters = {};
  let rootDir;
  let json = false;
  for (const arg of argv) {
    if (arg === '--unresolved') { filters.unresolved = true; continue; }
    if (arg === '--json') { json = true; continue; }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) throw new Error(`알 수 없거나 값이 없는 조회 옵션: ${arg}`);
    const [, option, value] = match;
    if (option === 'journal-root') rootDir = value;
    else if (option === 'warning-code') filters.warningCode = value;
    else if (option === 'limit') {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('--limit은 1~500 정수');
      filters.limit = limit;
    } else if (['from', 'to', 'job', 'kind', 'incident', 'delivery'].includes(option)) filters[option] = value;
    else throw new Error(`알 수 없는 조회 옵션: --${option}`);
  }
  for (const key of ['from', 'to']) {
    if (filters[key] && !validDate(filters[key])) throw new Error(`--${key}는 YYYY-MM-DD KST 날짜`);
  }
  if (filters.from && filters.to && filters.from > filters.to) throw new Error('--from이 --to보다 늦음');
  if (filters.kind && !KINDS.has(filters.kind)) throw new Error('--kind 분류값 오류');
  if (filters.delivery && !DELIVERY.has(filters.delivery)) throw new Error('--delivery 전달상태 오류');
  return { filters, rootDir, json };
}

export function formatWarningQuery(result) {
  const lines = [`경고 사건 ${result.incidents.length}/${result.total}건 · 손상/충돌 행 ${result.invalidRows.length}건`];
  for (const incident of result.incidents) {
    lines.push(`${incident.lastDetectedAt ?? '발생시각 없음'} · ${incident.jobName} · ${incident.warningCode}`);
    lines.push(`  ${incident.safeSummary} · ${incident.kind}/${incident.severity} · 사건 ${incident.incidentId}`);
    lines.push(`  상태 ${incident.status} · 감지 ${incident.detectedCount}회 · 억제 ${incident.suppressedCount}회 · 마지막 전달 ${incident.lastDeliveryStatus ?? '없음'}`);
    if (incident.lastActionStatus) {
      lines.push(`  읽기 재조회 ${incident.actionAttemptCount}회 · 결과 ${incident.lastActionStatus}/${incident.lastActionOutcome ?? '확인 중'} · 사건 해결 여부와 별개`);
    }
    if (incident.unknownDeliveryCount) lines.push(`  전달 불명 ${incident.unknownDeliveryCount}건 · 가장 오래된 건 ${incident.oldestUnknownAgeMinutes}분 경과 — 수신 여부 확인 전 재발송 금지`);
    if (incident.incompleteDeliveryCount) lines.push(`  전송 중 기록 미완결 ${incident.incompleteDeliveryCount}건 · 가장 오래된 건 ${incident.oldestIncompleteAgeMinutes}분 경과 — 수신 여부 확인 전 재발송 금지`);
    if (incident.classification === 'legacy' || incident.classification === 'uncataloged') lines.push('  원인 미분류 — 자동 진단·조치 대상 아님');
    if (['market-signal', 'owner-decision'].includes(incident.classification)) lines.push('  시장 신호/오너 판단 — 자동 원인 제거 대상 아님');
  }
  return lines.join('\n');
}

function main() {
  const { filters, rootDir, json } = parseWarningQueryArgs(process.argv.slice(2));
  const result = queryWarningIncidents({ rootDir, filters });
  console.log(json ? JSON.stringify(result, null, 2) : formatWarningQuery(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) {
    console.error(`경고 원장 조회 실패: ${error.message}`);
    process.exitCode = 2;
  }
}
