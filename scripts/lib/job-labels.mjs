// 무인 잡 이름(영어 파일명) → 한글 설명 매핑 — 순수 데이터/함수.
//
// 텔레그램 알림(특히 health-watcher의 장애감지)에 잡 이름이 영어 파일명만 나와서
// 어떤 잡이 왜 문제인지 못 알아보겠다는 오너 지적(2026-08-17) 반영. 잡이 새로
// 생기거나 폐기될 때마다 여기도 같이 갱신할 것 — health-watcher.mjs의
// EXPECTED_INTERVALS_MS와 등록 대상이 어긋나면(한쪽만 갱신) 새 잡이 라벨 없이
// 뜨거나, 폐기된 잡 라벨이 죽지 않고 남는다.
export const JOB_LABELS = {
  'backup-vault': '매일 밤 Vault 전체 스냅샷 git 백업',
  'health-watcher': '무인 잡 장애·텔레그램 세션 감시(이 알림을 보내는 잡 자신)',
  'execute-quant': '퀀트 트랙 승인된 제안 KIS 실주문 집행',
  'execute-asset-allocation': '자산분배 트랙(위탁·금현물) 승인된 제안 NH PLUG 실주문 집행(연금저축은 리마인더 전용 유지, 2026-09-05 신설)',
  'daily-asset-allocation-check': '자산분배 트랙 일일 리밸런싱·거시오버레이 점검',
  'parse-notifications-to-vault': '카카오 체결·배당 알림 → Vault 기록',
  'update-holdings-from-executions': '체결 반영 → 보유종목 잔고 갱신',
  'new-cash-allocation': '신규 현금 배분 판단(2026-08-18 실잔고 기반 재작성 후 재활성화)',
  // ⚠️ 개명(2026-09-03, 마이그레이션 3단계 "통일 루프 깸") — reconcile-irp는 원래
  // 예수금을 CashEvent로 기록해 update-cash-from-ledger가 재구성했지만, 이제
  // State/Holdings를 직접 덮어쓴다(CashEvent 미경유). update-cash-from-ledger는
  // API 없는 ISA·연금저축 2계좌만 처리(6계좌→2계좌로 범위 축소).
  'reconcile-irp': 'IRP 계좌 KIS API 종목 대사 + 예수금 State/Holdings 직접기록',
  'reconcile-nh-cash': '위탁·CMA·금현물 예수금 NH PLUG API 직접조회(State/Holdings 직접기록, 2026-09-03 신설)',
  'reconcile-irp-executions': 'IRP 체결을 KIS 퇴직연금 체결조회 API로 직접 폴링해 Facts/Ledger/Executions 기록(2026-09-03 신설)',
  'reconcile-nh-executions': '위탁·금현물 체결을 NH REST 체결조회 API로 직접 폴링해 Facts/Ledger/Executions 기록(2026-09-03 신설)',
  'intraday-portfolio-sync': '체결·예수금·펀드적립 감지→반영 7단계(reconcile-nh-executions 등 + update-cash-from-ledger + update-fund-holdings-from-purchases)를 10분마다 순서대로 실행해 장마감까지 안 기다리고 빠르게 반영(2026-09-03 신설, 2026-09-04 7단계로 확장, 고정시각 잡은 안전망으로 그대로 유지)',
  'update-fund-holdings-from-purchases': '연금저축 VIP펀드 정기적립 매수를 State/Holdings 보유수량·원금에 누적 반영(2026-09-04 신설 — 카카오 펀드적립 알림은 정확히 기록되고 있었는데 반영하는 잡 자체가 없었던 갭 해소)',
  'update-cash-from-ledger': '계좌별(ISA·연금저축, API 없는 2계좌만) 예수금 실잔고 계산',
  'telegram-session': '텔레그램 상시 응답 세션(launchd 무인 잡 아님, 상시 프로세스)',
  'update-monthly-balance-snapshot': '월별 잔고 스냅샷(대시보드 막대그래프용) + 일별 불변 스냅샷(TWR·Sharpe·MDD 재계산용, 2026-09-04 신설) 매일 자동 기록',
  'weekly-report': '주간 리포트 자동 생성·발행(성향학습 파이프라인 동반)',
  // 2026-08-23 전수 재점검(오너 지시)에서 발견 — 아래 셋은 실제 launchd에 등록돼
  // 30분마다 도는데(health-watcher.mjs EXPECTED_INTERVALS_MS 참고) 여기 라벨이 없어
  // 지금까지 알림에 영어 이름만 뜨고 있었다.
  'sync-firestore-mirror': 'Vault → Firestore 미러 동기화(대시보드가 읽는 데이터)',
  'update-allocation-from-holdings': '보유종목 기준 자산분배 탭 목표·현재비중 재계산',
  'update-holdings-prices': '보유종목 실시간 시세 갱신(KRX·해외·환율)',
  'telegram-session-health-check': '상시 텔레그램 세션 MCP 연결 끊김 감지·자동복구',
  'intraday-market-move-monitor': '장중 시장 급변 실시간 감시(코스피·S&P500·VIX·DXY·USD/KRW·미국10Y, 리스크관리실 Themis 소관)',
  'weekly-vault-health-check': '므네모시네 주간 건강검진(구조 정합성·데이터 정합성·미완료 작업, 비서실 Apollo "관리 총괄" 소관, 2026-09-04 신설)',
  'pension-balance-reminder': '연금저축 잔고 확인 요청(매월 22일, 카카오 알림·API 둘 다 없는 계좌라 수동 확인만 가능, 2026-09-04 신설)',
};

// 라벨 있으면 "잡이름(한글설명)", 없으면(등록 안 된 새 잡) 이름만 — 조용히 빈 문자열로
// 안 떨어지게 원래 이름은 항상 보존한다.
export function describeJob(jobName) {
  const label = JOB_LABELS[jobName];
  return label ? `${jobName}(${label})` : jobName;
}

// 잡이 조용해졌을 때(stale) 바로 확인해볼 만한 구체적 조치 — 코드에 이미 문서화된
// 알려진 의존성(크리덴셜 파일 경로 등)이 있는 잡만 등록한다(2026-08-23, 오너 지시
// "조치사항이 필요하면 등록"). 근거 없는 일반론("로그 확인해보세요")은 안 채운다 —
// 등록 안 된 잡은 remediation 없이 잡 이름·마지막 실행시각만으로 충분히 단서가 된다.
export const JOB_REMEDIATION = {
  // reconcile-irp.mjs·execute-quant-proposal.mjs 둘 다 이 파일이 없으면 "미설정 —
  // 스킵"으로 조용히 넘어간다(정상, 에러 아님) — 하지만 예전엔 잘 돌던 잡이 갑자기
  // stale해졌다면 이 파일 경로·내용이 깨졌을 가능성이 1순위 확인 대상.
  'execute-quant': '~/.config/banana-portfolio/kis-key.json(KIS 크리덴셜·퀀트계좌 설정) 확인',
  'execute-asset-allocation': '~/.config/banana-portfolio/nhplug-key.json(NH PLUG 크리덴셜) 확인',
  'reconcile-irp': '~/.config/banana-portfolio/kis-key.json(KIS 크리덴셜·IRP계좌 설정) 확인',
  'reconcile-nh-cash': '~/.config/banana-portfolio/nhplug-key.json(NH PLUG 크리덴셜) 확인',
  'reconcile-irp-executions': '~/.config/banana-portfolio/kis-key.json(KIS 크리덴셜·IRP계좌 설정) 확인',
  'reconcile-nh-executions': '~/.config/banana-portfolio/nhplug-key.json(NH PLUG 크리덴셜) 확인',
  // sync-firestore-mirror.mjs·parse-notifications-to-vault.mjs(2026-08-22 Firestore
  // 전환 이후) 둘 다 이 서비스계정 키가 없으면 즉시 throw로 죽는다.
  'sync-firestore-mirror': '~/.config/banana-portfolio-v2/firebase-adminsdk-key.json(Firebase Admin 키) 확인',
  'parse-notifications-to-vault': '~/.config/banana-portfolio-v2/firebase-adminsdk-key.json(Firebase Admin 키) 확인',
  // backup-vault-snapshot.mjs — Vault 루트 경로가 없으면 즉시 에러. Google Drive
  // for desktop 마운트가 풀렸을 때 실제로 겪었던 실패 양상(ADR 0002 Drive 동기화 구조).
  'backup-vault': 'Vault 경로(~/banana-vault) 존재 여부 — Google Drive for desktop 마운트 확인',
};
