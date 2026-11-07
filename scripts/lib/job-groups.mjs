// 무인잡 묶음 정본 — import 없는 순수 상수(2026-11-07, 오너 "시간별·기능별로 묶을 수 있는 것 묶고").
// 볼트 근거: 40_Projects/banana-portfolio/Requests/2026-11-07 무인잡 정리안(묶음 A~J).
//
// 묶음 = launchd 잡 1개(com.banana2.<묶음>.plist → run.sh <묶음> → scripts/jobs/run-job-group.mjs).
// 래퍼는 단계마다 `bash run.sh <단계>`를 순서대로 부른다 — 기존 스크립트는 고치지 않는다(실거래·장부 최소 diff).
// 그래서 단계마다 예전과 같은 것이 그대로 남는다:
//   - 로그: ~/Library/Logs/banana-portfolio-v2/<단계>.log(래퍼가 그 파일에 이어 쓴다)
//   - 하트비트: 95_Etna/Jobs/JobHealth/<단계>.md(run.sh가 남긴다) — health-watcher·올림푸스가 옛 이름 그대로 본다
//   - 쿨다운 가드·잠금·인자: 각 스크립트 안에 있으므로 그대로
// 묶음 자신의 하트비트(<묶음>.md)는 "단계 중 하나라도 실패면 FAIL"이고 detail에 실패 단계 이름이 실린다.
//
// 불변식(테스트로 고정, scripts/jobs/run-job-group.test.js):
//   - 단계는 run.sh가 디스패치하는 잡이고, 묶음 이름과 겹치지 않는다(묶음 안에 묶음 없음).
//   - 한 단계는 한 묶음에만 있다.
//   - 단계의 옛 plist는 scripts/launchd/retired/에만 있다(운영 plist가 남아 있으면 같은 스크립트가 두 번 돈다).
//   - 증권사 API를 부르는 고정 분 묶음은 10분 주기 슬롯(시세 :x0·급변 :x3·동기화 :x5)을 피한다.
//
// 단계 옵션:
//   requiresPrevious — 바로 앞 단계가 실패하면 이 단계는 돌리지 않는다(예전 run.sh media-moments 특례와 같은 의미).
// 묶음 옵션:
//   stepTimeoutMs — 단계 하나의 상한(null이면 상한 없음 = 옛 plist와 같음). 넘기면 그 단계 프로세스 묶음을 끝내고
//                   그 단계 하트비트를 FAIL로 남긴 뒤 다음 단계로 간다(예전엔 잡마다 따로 돌아 한 잡이 멎어도 다른 잡이
//                   돌았다 — 순차 실행에서 같은 격리를 지키려는 상한).
//   deadlineKst — 'HH:MM'(KST). 이 시각을 넘기면 남은 단계는 시작하지 않고 FAIL로 남긴다.
//   gapMs — 단계 사이 쉼(같은 증권사 API를 잇달아 부르는 묶음의 초당 한도 여유).
const MIN = 60 * 1000;

export const JOB_GROUPS = {
  // A 장후 장부 마감(안전망) — 평일 16:01. intraday-portfolio-sync와 독립(그 잡을 부르지 않고 스크립트를 직접).
  // 순서는 옛 고정 시각 순서(15:50 IRP 체결·만료 → 15:55 NH 체결 → 16:05 보유 → 16:07 IRP → 16:08 NH 예수금
  // → 16:09 외화RP → 16:10 예수금 원장 → 16:11 펀드 적립) 그대로.
  'ledger-close': {
    steps: [
      'reconcile-irp-executions',
      'expire-stale-nh-orders',
      'reconcile-nh-executions',
      'update-holdings-from-executions',
      'reconcile-irp',
      'reconcile-nh-cash',
      'reconcile-nh-fx-rp',
      'update-cash-from-ledger',
      'update-fund-holdings-from-purchases',
    ],
    // 단계는 실측 0~3초. 상한 2분·마감 16:12(그 뒤 단계는 시작 안 함)라 최악에도 16:14:10 전에 끝나 isSafetyNetWindow
    // (~16:14) 안에 머문다 — 16:15 동기화 회차가 같은 스크립트(update-holdings-from-executions, 잠금 없음)를 겹쳐 돌리지 않는다.
    stepTimeoutMs: 2 * MIN,
    deadlineKst: '16:12',
    gapMs: 2000,
  },
  // B 장후 보고·정기 제안 — 평일 16:16(A 뒤). 뒤 둘은 스크립트 안의 날짜 판정(shouldRunToday·shouldRunThisMonth)이
  // 해당일이 아니면 LLM 호출 전에 바로 끝낸다. LLM 단계의 쿨다운·한도 처리는 각 스크립트 안 그대로.
  'post-close-reports': {
    steps: [
      'new-cash-allocation',
      'daily-execution-report',
      'daily-asset-allocation-check',
      'rebalance-proposal',
      'monthly-macro-tilt-proposal',
    ],
    stepTimeoutMs: 60 * MIN,
    gapMs: 0,
  },
  // C 야간 마감 — 매일 23:51(시세 :x0 슬롯 밖). 스냅샷 → 볼트 git 백업 → 볼트 외부 백업 → 음성 외부 백업(회당 용량 상한, 가장 길어 맨 뒤).
  'nightly-close': {
    steps: [
      'update-monthly-balance-snapshot',
      'backup-vault',
      'vault-offsite-backup',
      'media-audio-offsite-backup',
    ],
    stepTimeoutMs: 90 * MIN,
    gapMs: 0,
  },
  // D 미디어 매시 — 보관 → 순간 노트. 보관이 실패하면 순간 노트는 돌리지 않는다(예전 run.sh media-moments 특례와 같음).
  // 잠금(withLock)이 있는 긴 작업이라 상한을 두지 않는다(옛 plist와 같음).
  'media-hourly': {
    steps: [
      'media-archive',
      { job: 'media-moments', requiresPrevious: true },
    ],
    stepTimeoutMs: null,
    gapMs: 0,
  },
  // F 장전 데이터 갱신 — 평일 07:06. 거시지표 캐시(07:05) → KRX 휴장일 캐시(08:15에서 당김, 소비자는 09:03 이후).
  'premarket-cache': {
    steps: [
      'update-macro-indicators-cache',
      'update-krx-trading-calendar',
    ],
    stepTimeoutMs: 15 * MIN,
    gapMs: 0,
  },
  // I 헤르메스 15분 갱신 — 일정 → 동선(route-today가 일정 활동을 계산에 쓴다).
  'hermes-refresh': {
    steps: [
      'calendar-days',
      'route-today',
    ],
    stepTimeoutMs: 10 * MIN,
    gapMs: 0,
  },
  // J 시세 후속 — 매시 :07·:17…(시세 :x0·동기화 :x5 뒤). 배분 → 미러(미러가 방금 쓴 배분을 읽는다).
  'price-followups': {
    steps: [
      'update-allocation-from-holdings',
      'sync-firestore-mirror',
    ],
    stepTimeoutMs: 5 * MIN,
    gapMs: 0,
  },
};

export function groupSteps(group) {
  return (JOB_GROUPS[group]?.steps ?? []).map((step) => (typeof step === 'string' ? { job: step } : step));
}

// 단계 잡 → 묶음 이름(없으면 null). 올림푸스 등이 "이 잡은 어느 묶음 안에서 도나"를 볼 때 쓴다.
export function groupOfStep(job) {
  for (const group of Object.keys(JOB_GROUPS)) {
    if (groupSteps(group).some((step) => step.job === job)) return group;
  }
  return null;
}
