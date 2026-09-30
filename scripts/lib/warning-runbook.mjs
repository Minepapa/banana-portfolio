// 경고 진단 Runbook. 허용된 경고 코드만 읽기 전용으로 검사하며 원장·주문·상태를 쓰지 않는다.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MACRO_SCRIPT = fileURLToPath(new URL('./yf-macro.py', import.meta.url));
const MACRO_TICKER = '^VIX';
const PROBE_TIMEOUT_MS = 15_000;

export const WARNING_RUNBOOKS = Object.freeze({
  MACRO_YFINANCE_QUERY_FAILED: Object.freeze({
    jobName: 'intraday-market-move-monitor', kind: 'operational',
    runbookId: 'macro-yfinance-readonly-v1',
    purpose: 'yfinance 실행 환경과 단일 지표의 읽기 응답 확인',
    limit: '단일 VIX 조회 성공은 원래 5개 지표의 데이터 신선도나 일시 장애 해소를 증명하지 않음',
  }),
});

function result(runbook, outcome, confidence, evidence) {
  return {
    runbookId: runbook.runbookId, warningCode: 'MACRO_YFINANCE_QUERY_FAILED',
    outcome, confidence, evidence,
    readOnly: true, actionTaken: false,
    limitation: runbook.limit,
  };
}

// probe와 파일 검사를 주입해 테스트가 실제 Python·네트워크에 접근하지 않게 한다.
export function diagnoseWarningIncident(incident, {
  scriptPath = MACRO_SCRIPT, fileExists = existsSync, probe = spawnSync,
} = {}) {
  const runbook = WARNING_RUNBOOKS[incident?.warningCode];
  if (!runbook || incident.jobName !== runbook.jobName || incident.kind !== runbook.kind
    || incident.classification !== 'cataloged' || incident.status === 'resolved') {
    throw new Error('등록된 미해결 운영 경고 사건에만 읽기 진단 허용');
  }
  if (!fileExists(scriptPath)) {
    return result(runbook, 'source-script-missing', 'high', ['macro-script-absent']);
  }
  const response = probe('python3', [scriptPath, MACRO_TICKER], {
    encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024,
  });
  if (response.error?.code === 'ENOENT') {
    return result(runbook, 'python-missing', 'high', ['python3-not-found']);
  }
  if (response.error?.code === 'ETIMEDOUT') {
    return result(runbook, 'probe-timeout', 'medium', ['single-get-timeout']);
  }
  if (response.error || response.status !== 0) {
    const missingModule = String(response.stderr ?? '').includes("No module named 'yfinance'");
    return result(runbook, missingModule ? 'dependency-missing' : 'probe-failed',
      missingModule ? 'high' : 'medium', [missingModule ? 'yfinance-module-absent' : 'single-get-failed']);
  }
  let parsed;
  try { parsed = JSON.parse(response.stdout); } catch {
    return result(runbook, 'response-invalid', 'medium', ['non-json-response']);
  }
  const closes = parsed?.[MACRO_TICKER];
  if (!Array.isArray(closes) || !closes.some((value) => typeof value === 'number' && Number.isFinite(value))) {
    return result(runbook, 'data-empty', 'medium', ['single-ticker-no-finite-close']);
  }
  return result(runbook, 'source-available-now', 'low', ['single-ticker-finite-close']);
}
