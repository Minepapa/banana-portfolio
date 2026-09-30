#!/usr/bin/env node
// 원장에 기록된 장중 거시 조회 실패만 30분 뒤 단일 읽기 재조회한다.
// 기본 모드는 dry-run이다. 운영 플리스트가 --live를 넘겨야만 실제 GET이 가능하다.
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { rebuildWarningIncidents } from '../lib/warning-event-journal.mjs';
import { hasMacroRetryClaimInCurrentEpisode, runMacroReadRetry } from '../lib/warning-action-executor.mjs';

const JOURNAL_ROOT = join(VAULT_PATHS.root, 'Log', 'WarningEvents');
const MAX_PER_RUN = 10;

export function selectMacroRetryIncidents(rebuilt, maxPerRun = MAX_PER_RUN) {
  if (rebuilt.invalidRows.length) throw new Error('경고 원장 무결성 오류 — 자동 재조회 중단');
  return rebuilt.incidents
    .filter((incident) => incident.warningCode === 'MACRO_YFINANCE_QUERY_FAILED'
      && incident.jobName === 'intraday-market-move-monitor'
      && incident.subjectKey === 'macro:yfinance'
      && incident.kind === 'operational'
      && ['open', 'reopened'].includes(incident.status)
      && incident.detectedCount > 0
      && !hasMacroRetryClaimInCurrentEpisode(rebuilt.acceptedEvents, incident.incidentId))
    .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen))
    .slice(0, maxPerRun).map((incident) => incident.incidentId);
}

export async function processWarningActions({
  rootDir = JOURNAL_ROOT, mode = 'dry-run', now = () => new Date(),
  execute = runMacroReadRetry,
} = {}) {
  if (!['dry-run', 'shadow', 'live'].includes(mode)) throw new Error('허용되지 않은 조치 모드');
  const ids = selectMacroRetryIncidents(rebuildWarningIncidents({ rootDir }));
  const results = [];
  for (const id of ids) results.push(await execute(id, { rootDir, mode, now }));
  return {
    mode, candidates: ids.length,
    executed: results.filter((result) => result.executed).length,
    eligible: results.filter((result) => result.wouldRun).length,
    deferred: results.filter((result) => !result.executed && !result.wouldRun).length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2] ?? '--dry-run';
  const modes = { '--dry-run': 'dry-run', '--shadow': 'shadow', '--live': 'live' };
  if (!(arg in modes) || process.argv.length > 3) {
    console.error('사용법: process-warning-actions.mjs [--dry-run|--shadow|--live]');
    process.exitCode = 2;
  } else {
    processWarningActions({ mode: modes[arg] }).then((result) => {
      console.log(`경고 읽기 재조회: 모드=${result.mode}, 후보=${result.candidates}, 실행=${result.executed}, 대기=${result.deferred}`);
    }).catch(() => {
      // 원본 오류·원장 내용은 오너에게 노출하지 않는다. 하트비트는 실패로 기록된다.
      console.error('경고 읽기 재조회 중단 — 원장·실행 로그 점검 필요');
      process.exitCode = 1;
    });
  }
}
