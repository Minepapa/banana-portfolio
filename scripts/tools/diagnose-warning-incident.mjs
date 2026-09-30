#!/usr/bin/env node
// 수동 읽기 전용 진단. 허용 Runbook 1개만 실행하며 원장·Telegram·주문 상태를 바꾸지 않는다.
import { queryWarningIncidents } from '../lib/warning-incident-query.mjs';
import { diagnoseWarningIncident } from '../lib/warning-runbook.mjs';

export function parseDiagnosisArgs(argv) {
  const args = { json: false };
  for (const arg of argv) {
    if (arg === '--json') { args.json = true; continue; }
    const match = /^--(incident|journal-root)=(.+)$/.exec(arg);
    if (!match) throw new Error(`알 수 없는 진단 옵션: ${arg}`);
    args[match[1] === 'journal-root' ? 'rootDir' : 'incidentId'] = match[2];
  }
  if (!args.incidentId) throw new Error('--incident=<사건 ID> 필수');
  return args;
}

export function formatDiagnosis(diagnosis) {
  return [
    `진단 ${diagnosis.runbookId}: ${diagnosis.outcome} (확신도 ${diagnosis.confidence})`,
    `근거 ${diagnosis.evidence.join(', ')}`,
    `한계: ${diagnosis.limitation}`,
    '읽기 조회만 수행. 원장·주문·장부·Telegram 변경 없음.',
  ].join('\n');
}

function main() {
  const { incidentId, rootDir, json } = parseDiagnosisArgs(process.argv.slice(2));
  const query = queryWarningIncidents({ rootDir, filters: { incident: incidentId } });
  if (query.total !== 1 || query.invalidRows.length) {
    throw new Error('사건을 유일하게 확인할 수 없거나 원장에 손상/충돌 행이 있음');
  }
  const diagnosis = diagnoseWarningIncident(query.incidents[0]);
  console.log(json ? JSON.stringify(diagnosis, null, 2) : formatDiagnosis(diagnosis));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) {
    console.error(`경고 진단 보류: ${error.message}`);
    process.exitCode = 2;
  }
}
