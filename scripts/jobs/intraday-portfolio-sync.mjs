#!/usr/bin/env node
/**
 * 장중 포트폴리오 동기화 — 위탁·금현물·IRP·ISA·연금저축 체결/예수금 감지→반영을
 * 하루 종일 10분 간격으로 돌려, 기존 "장마감 후 한 번" 배치의 반영 지연을 줄인다.
 *
 * 왜(2026-09-03, 오너 지시): "체결이나 금액 변경이 있어도 16시경 배치까지 확인이
 * 안 되는 게 불편하다"는 요청 — 그 사이엔 앱(대시보드)에서 최신 값을 볼 수 없었다.
 * 기존 고정시각 잡들(reconcile-nh-executions 평일 15:55·reconcile-irp-executions
 * 평일 15:50·update-holdings-from-executions 평일 16:05·reconcile-nh-cash 평일
 * 16:08·reconcile-irp 평일 16:07·update-cash-from-ledger 평일 16:10)은 **의도적으로
 * 그대로 둔다** — 오너 명시("지금 구조를 백업으로 가지고 있으면서") — 이
 * 오케스트레이터가 언젠가 조용히 실패해도 하루 최소 1회는 확실히 도는 안전망 역할.
 * 이 잡은 그 여섯 스크립트를 전혀 수정하지 않고 그대로 자식 프로세스로 순서대로
 * 실행한다 — update-holdings-prices.mjs(10분마다, 2026-08-25)가 이미 증명한 패턴을
 * 그대로 재사용.
 *
 * 순서가 중요하다(체결 감지 → 반영 → 예수금 대사):
 *   1. reconcile-nh-executions.mjs   — 위탁·금현물 체결 감지 → Facts/Ledger/Executions
 *   2. reconcile-irp-executions.mjs  — IRP 체결 감지(현재 KIS API 자체가 이 계좌에서
 *      작동 안 해 항상 0건이지만, 나중에 API가 복구되면 자동으로 살아나도록 그대로
 *      포함 — Log/Implementation/2026-09-03-NH마이그레이션-현황정리.md 참고)
 *   3. update-holdings-from-executions.mjs — 그날 새 체결을 State/Holdings에 반영
 *      (findMatchingKnownExecution의 크로스소스 dedup이 카카오 경로와의 중복 적용을
 *      계속 막아준다 — 2026-09-03 신설)
 *   4. reconcile-nh-cash.mjs   — 위탁·CMA·금현물 예수금 State/Holdings 직접기록
 *   5. reconcile-irp.mjs      — IRP 잔고 대사 + 예수금 State/Holdings 직접기록
 *   6. update-cash-from-ledger.mjs — ISA·연금저축(API 없는 2계좌) 예수금을 CashEvent
 *      원장에서 재계산. scripts/tools/record-cash-anchor.mjs로 텔레그램 세션이 기록한
 *      수동 앵커도 이 단계에서 반영된다 — 빠지면 그 두 계좌만 16:10 고정시각까지 못
 *      읽혀 "체결·금액 변경이 바로 안 보인다"는 원래 오너 불편이 그대로 남는다
 *      (2026-09-03 기존 5단계에서 누락된 걸 뒤늦게 발견해 추가).
 *
 * sync-firestore-mirror.mjs(대시보드가 읽는 데이터)는 이미 독립적으로 10분마다
 * 돌고 있어(2026-08-23) 여기서 다시 호출하지 않는다 — 최악의 경우 이 잡이 방금 쓴
 * 값을 다음 미러 동기화 주기(최대 10분 뒤)까지만 기다리면 된다. 기존 "장마감까지"
 * 지연에 비하면 충분한 개선 — 두 10분 주기를 억지로 동기화하려는 시도는 복잡성
 * 대비 이득이 작아 하지 않는다.
 *
 * 각 단계는 자식 프로세스로 독립 실행(60초 타임아웃) — 한 단계가 실패하거나 멎어도
 * 나머지 단계는 계속 진행한다(reconcile-nh-executions.mjs의 "계좌 하나 실패해도
 * 나머지는 계속"과 동일 원칙을 오케스트레이션 레벨로 확장). 6개 스크립트 각각이
 * 이미 자기 자신의 크리덴셜 확인·경고·dedup을 갖고 있으므로, 이 오케스트레이터는
 * 순서 보장과 장애 격리만 책임진다 — 판단 로직을 중복 구현하지 않는다.
 *
 * 사용법:
 *   node scripts/jobs/intraday-portfolio-sync.mjs            # 실제로 반영
 *   node scripts/jobs/intraday-portfolio-sync.mjs --dry-run  # 6개 전부 드라이런으로 전달
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const STEP_TIMEOUT_MS = 60_000;

const STEPS = [
  'reconcile-nh-executions.mjs',
  'reconcile-irp-executions.mjs',
  'update-holdings-from-executions.mjs',
  'reconcile-nh-cash.mjs',
  'reconcile-irp.mjs',
  'update-cash-from-ledger.mjs',
];

async function main() {
  let ok = 0, failed = 0;
  for (const step of STEPS) {
    const scriptPath = join(HERE, step);
    const args = DRY_RUN ? [scriptPath, '--dry-run'] : [scriptPath];
    console.log(`\n▶ ${step}`);
    try {
      execFileSync('node', args, { stdio: 'inherit', timeout: STEP_TIMEOUT_MS });
      ok++;
    } catch (e) {
      failed++;
      // execFileSync가 타임아웃으로 죽이면 e.signal='SIGTERM'·e.status=null, 정상
      // 실행 후 비정상 종료면 e.status가 실제 exit code — 둘 다 여기로 온다.
      console.error(`  ⚠️ ${step} 비정상 종료(exit ${e.status ?? '?'}${e.signal ? `, signal ${e.signal}` : ''}) — 다음 단계로 계속`);
    }
  }
  console.log(`\n✅ 장중 동기화 완료 — ${ok}/${STEPS.length}단계 정상` + (DRY_RUN ? ' (드라이런)' : ''));
  if (failed > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
}
