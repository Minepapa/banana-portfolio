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
  'daily-asset-allocation-check': '자산분배 트랙 일일 리밸런싱·거시오버레이 점검',
  'parse-notifications-to-vault': '카카오 체결·배당 알림 → Vault 기록',
  'update-holdings-from-executions': '체결 반영 → 보유종목 잔고 갱신',
  'new-cash-allocation': '신규 현금 배분 판단(2026-08-18 실잔고 기반 재작성 후 재활성화)',
  'reconcile-irp': 'IRP 계좌 KIS API 종목·예수금 대사(예수금은 CashEvent로도 기록)',
  'update-cash-from-ledger': '계좌별(위탁·ISA·CMA·금현물·연금저축·IRP) 예수금 실잔고 계산',
  'telegram-session': '텔레그램 상시 응답 세션(launchd 무인 잡 아님, 상시 프로세스)',
  'update-monthly-balance-snapshot': '월별 잔고 스냅샷 매일 자동 기록(대시보드 막대그래프용)',
  'weekly-report': '주간 리포트 자동 생성·발행(성향학습 파이프라인 동반)',
  // 2026-08-23 전수 재점검(오너 지시)에서 발견 — 아래 셋은 실제 launchd에 등록돼
  // 30분마다 도는데(health-watcher.mjs EXPECTED_INTERVALS_MS 참고) 여기 라벨이 없어
  // 지금까지 알림에 영어 이름만 뜨고 있었다.
  'sync-firestore-mirror': 'Vault → Firestore 미러 동기화(대시보드가 읽는 데이터)',
  'update-allocation-from-holdings': '보유종목 기준 자산분배 탭 목표·현재비중 재계산',
  'update-holdings-prices': '보유종목 실시간 시세 갱신(KRX·해외·환율)',
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
  'reconcile-irp': '~/.config/banana-portfolio/kis-key.json(KIS 크리덴셜·IRP계좌 설정) 확인',
  // sync-firestore-mirror.mjs·parse-notifications-to-vault.mjs(2026-08-22 Firestore
  // 전환 이후) 둘 다 이 서비스계정 키가 없으면 즉시 throw로 죽는다.
  'sync-firestore-mirror': '~/.config/banana-portfolio-v2/firebase-adminsdk-key.json(Firebase Admin 키) 확인',
  'parse-notifications-to-vault': '~/.config/banana-portfolio-v2/firebase-adminsdk-key.json(Firebase Admin 키) 확인',
  // backup-vault-snapshot.mjs — Vault 루트 경로가 없으면 즉시 에러. Google Drive
  // for desktop 마운트가 풀렸을 때 실제로 겪었던 실패 양상(ADR 0002 Drive 동기화 구조).
  'backup-vault': 'Vault 경로(~/banana-vault) 존재 여부 — Google Drive for desktop 마운트 확인',
};
