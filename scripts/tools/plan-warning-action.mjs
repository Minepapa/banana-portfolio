#!/usr/bin/env node
// 사건 진단 뒤 조치 후보를 출력한다. dry-run 계획만 만들고 실행·원장 변경은 하지 않는다.
import { queryWarningIncidents } from '../lib/warning-incident-query.mjs';
import { diagnoseWarningIncident } from '../lib/warning-runbook.mjs';
import { proposeWarningAction } from '../lib/warning-action-plan.mjs';
import { parseDiagnosisArgs } from './diagnose-warning-incident.mjs';

export function formatWarningActionPlan(plan) {
  return [
    `원인 후보 ${plan.causeCandidate} · 확신도 ${plan.confidence}`,
    `근거 ${plan.evidence.join(', ')}`,
    `조치 후보 ${plan.actionId ?? '없음'} · ${plan.reason}`,
    `dry-run 계획: ${plan.dryRun}`,
    plan.actionId ? `제한: 최대 ${plan.maxAttempts}회, ${plan.timeoutMs}ms, 재시도 간격 ${plan.cooldownMs}ms` : '',
    plan.actionId ? `사후검증: ${plan.postconditions.join(', ')}` : '',
    `판정 한계: ${plan.limit}`,
    '실행 여부: 미실행. 주문·장부·설정·텔레그램 변경 없음.',
  ].filter(Boolean).join('\n');
}

function main() {
  const { incidentId, rootDir, json } = parseDiagnosisArgs(process.argv.slice(2));
  const query = queryWarningIncidents({ rootDir, filters: { incident: incidentId } });
  if (query.total !== 1 || query.invalidRows.length) throw new Error('사건이 유일하지 않거나 원장 무결성 오류');
  const diagnosis = diagnoseWarningIncident(query.incidents[0]);
  const plan = proposeWarningAction(diagnosis);
  console.log(json ? JSON.stringify(plan, null, 2) : formatWarningActionPlan(plan));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) {
    console.error(`경고 조치안 보류: ${error.message}`);
    process.exitCode = 2;
  }
}
