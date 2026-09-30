// 진단 결과를 고정 조치안으로 바꾸는 순수 함수. 이 모듈은 어떤 조치도 실행하지 않는다.
const RETRYABLE = new Set(['probe-timeout', 'probe-failed', 'data-empty']);

// 자동 실행기는 원 경고를 첫 실패로 취급한다. 사전 진단 GET을 추가하면
// 사건당 1회 재조회 약속을 넘기므로, 여기서는 기록된 감지 사실만 사용한다.
export function planAutomaticMacroRetry(incident) {
  if (incident?.jobName !== 'intraday-market-move-monitor'
    || incident.warningCode !== 'MACRO_YFINANCE_QUERY_FAILED'
    || incident.subjectKey !== 'macro:yfinance'
    || incident.kind !== 'operational'
    || incident.classification !== 'cataloged'
    || !['open', 'reopened'].includes(incident.status)
    || !Number.isInteger(incident.detectedCount) || incident.detectedCount < 1
    || !Number.isFinite(Date.parse(incident.lastDetectedAt))) {
    throw new Error('등록된 미해결 거시 조회 경고만 자동 재조회 허용');
  }
  return {
    actionId: 'MACRO_SINGLE_READ_RETRY', incidentId: incident.incidentId,
    causeCandidate: '원래 다섯 지표 조회가 실패하거나 전부 결측',
    confidence: 'medium', evidence: ['coded-warning-detected'],
    maxAttempts: 1, timeoutMs: 15_000, cooldownMs: 30 * 60_000,
    ticker: '^VIX', readOnly: true, autoResolve: false,
  };
}

export function proposeWarningAction(diagnosis) {
  if (diagnosis?.runbookId !== 'macro-yfinance-readonly-v1'
    || diagnosis.warningCode !== 'MACRO_YFINANCE_QUERY_FAILED'
    || diagnosis.readOnly !== true || diagnosis.actionTaken !== false) {
    throw new Error('등록된 읽기 전용 진단 결과만 조치안 생성 허용');
  }
  const base = {
    warningCode: diagnosis.warningCode, runbookId: diagnosis.runbookId,
    causeCandidate: diagnosis.outcome, confidence: diagnosis.confidence,
    evidence: [...diagnosis.evidence],
    proposalOnly: true, executed: false,
  };
  if (RETRYABLE.has(diagnosis.outcome)) {
    return {
      ...base, actionId: 'MACRO_SINGLE_READ_RETRY',
      reason: '일시적인 읽기 장애인지 같은 단일 지표를 한 번 더 확인할 후보',
      preconditions: ['동일 사건이 미해결', '등록된 운영 경고 코드', '읽기 전용 단일 지표 조회'],
      dryRun: '고정된 ^VIX 단일 조회 1회만 예정; 이 단계에서는 실행하지 않음',
      maxAttempts: 1, timeoutMs: 15_000, cooldownMs: 30 * 60_000,
      postconditions: ['JSON 응답', '^VIX 유한 종가 1개 이상'],
      limit: '성공해도 원래 5개 지표의 신선도·정합성이나 사건 해결을 자동 확정하지 않음',
    };
  }
  return {
    ...base, actionId: null,
    reason: diagnosis.outcome === 'source-available-now'
      ? '현재 단일 조회가 되므로 원래 장애는 일시적일 수 있음; 재발 관찰 필요'
      : '실행환경 또는 응답 계약 확인이 필요해 자동 재시도 후보에서 제외',
    preconditions: [], dryRun: '자동 조치 없음', maxAttempts: 0,
    timeoutMs: 0, cooldownMs: 0, postconditions: [],
    limit: diagnosis.limitation,
  };
}
