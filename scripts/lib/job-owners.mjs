// 잡 → 담당 자기 선언 — import 없는 순수 상수(2026-10-30, 올림푸스 '신들 현황'이 담당별로 잡 상태를 묶어 보이도록).
// 근거는 헌장(볼트 90_Delphi/Agents) §5 책임이다. 발신자(SENDER_AGENT)와 다를 수 있다 — 여기는 "그 일의 주인"이다
// (예: themis-risk-review는 거시 위험 감시가 플루토스 소관이라 plutus, media-night-check는 미네 기록 파이프라인이라 athena).
// 새 잡을 run.sh·plist·job-schedule.mjs에 넣으면 여기에도 한 줄 넣는다. job-owners.test.js가 빠짐과 6인 밖 값을 막는다.
export const JOB_OWNERS = {
  // 제우스: 시스템 운영 경보·발신 관문·텔레그램·세션 간 인프라(D83)
  'health-watcher': 'zeus',
  'zeus-headline': 'zeus', // 올림푸스 홈 헤드라인(제우스 종합)
  'weekly-schedule-summary': 'zeus',
  'weekly-warning-review': 'zeus',
  'process-warning-actions': 'zeus',
  'question-digest': 'zeus',
  'olympus-server': 'zeus',
  'media-archive': 'zeus', // 오너 통화 포함 폰 미디어 전체 보존 — 여러 담당에 걸친 공용 인프라(2026-10-31 제우스)
  'media-audio-offsite-backup': 'zeus', // 통화·녹음 원본 오프사이트 백업 — media-archive와 같은 보존 인프라(2026-10-31 제우스)
  'telegram-session': 'zeus',
  'telegram-session-restart': 'zeus',
  'telegram-session-handoff': 'zeus',
  'telegram-session-health-check': 'zeus',
  'telegram-gate': 'zeus',
  'telegram-gate-health-check': 'zeus',
  // 클리오: 볼트 ingest·Periodic·구조 정합성·볼트 백업
  'daily-note': 'clio',
  'clio-inbox-ingest': 'clio',
  'weekly-vault-health-check': 'clio',
  'backup-vault': 'clio',
  'vault-offsite-backup': 'clio',
  // 테미스: 비가역 행동(미디어 삭제) 검증
  'media-delete-report-weekly': 'themis',
  // 헤르메스: 일정·위치·동선·소비
  'hermes-briefing': 'hermes',
  'calendar-days': 'hermes',
  'owntracks-receiver': 'hermes',
  'argos-ingest': 'hermes',
  'ingest-spending-inbox': 'hermes',
  // 아테나: 미네 기록 수집·기억 구슬
  'media-moments': 'athena',
  'media-audio': 'athena',
  'media-photo': 'athena',
  'media-video': 'athena',
  'media-night-check': 'athena',
  'media-faces-hold-monthly': 'athena',
  'media-memory-orb': 'athena',
  'mine-athena-fields': 'athena',
  // 플루토스: 자산분배·돌파매매·위험 감시·장부·투자 보고
  'execute-quant': 'plutus',
  'execute-asset-allocation': 'plutus',
  'daily-asset-allocation-check': 'plutus',
  'parse-notifications-to-vault': 'plutus',
  'update-holdings-from-executions': 'plutus',
  'daily-execution-report': 'plutus',
  'update-holdings-prices': 'plutus',
  'new-cash-allocation': 'plutus',
  'reconcile-irp': 'plutus',
  'reconcile-nh-cash': 'plutus',
  'reconcile-nh-fx-rp': 'plutus',
  'reconcile-irp-executions': 'plutus',
  'reconcile-nh-executions': 'plutus',
  'expire-stale-nh-orders': 'plutus',
  'intraday-portfolio-sync': 'plutus',
  'update-cash-from-ledger': 'plutus',
  'weekly-report': 'plutus',
  'update-allocation-from-holdings': 'plutus',
  'update-monthly-balance-snapshot': 'plutus',
  'morning-briefing': 'plutus',
  'themis-risk-review': 'plutus',
  'quarterly-allocation-review': 'plutus',
  'rebalance-proposal': 'plutus',
  'proposal-execution-reminder': 'plutus',
  'isa-maturity-check': 'plutus',
  'intraday-market-move-monitor': 'plutus',
  'pension-balance-reminder': 'plutus',
  'update-fund-holdings-from-purchases': 'plutus',
  'annual-instrument-rescore': 'plutus',
  'monthly-macro-tilt-proposal': 'plutus',
  'update-breakout-price-cache': 'plutus',
  'daily-breakout-signal-scan': 'plutus',
  'place-breakout-fallback-entry': 'plutus',
  'reconcile-breakout-protection': 'plutus',
  'update-macro-indicators-cache': 'plutus',
  'update-krx-trading-calendar': 'plutus',
  'sync-firestore-mirror': 'plutus', // 같은 10분 주기 투자 데이터 잡들과 맞춤(2026-10-31 제우스)
};
