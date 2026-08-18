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
  'new-cash-allocation': '신규 현금 배분 판단(2026-08-17 잠정중단 — 예수금 계산 정확도 문제)',
  'reconcile-irp': 'IRP 계좌 KIS API 종목·예수금 대사(예수금은 CashEvent로도 기록)',
  'update-cash-from-ledger': '계좌별(위탁·ISA·CMA·금현물·연금저축·IRP) 예수금 실잔고 계산',
  'telegram-session': '텔레그램 상시 응답 세션(launchd 무인 잡 아님, 상시 프로세스)',
};

// 라벨 있으면 "잡이름(한글설명)", 없으면(등록 안 된 새 잡) 이름만 — 조용히 빈 문자열로
// 안 떨어지게 원래 이름은 항상 보존한다.
export function describeJob(jobName) {
  const label = JOB_LABELS[jobName];
  return label ? `${jobName}(${label})` : jobName;
}
