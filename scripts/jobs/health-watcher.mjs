#!/usr/bin/env node
/**
 * 독립 장애감지 워처 (v2) — docs/ARCHITECTURE-V2.md "장애감지 — 독립 워처 + 하트비트" 절.
 *
 * 다른 잡들의 성공 여부와 무관하게 **이 잡 스스로** 30분마다 launchd로 실행돼(다른
 * 잡·상시 세션과 완전히 독립) 두 가지를 확인한다:
 *   1) 각 잡의 하트비트(State/JobHealth/*.md)가 기대 주기의 2배 이상 조용한지
 *   2) 상시 텔레그램 세션(claude --channels ...) 프로세스가 살아있는지 — Phase 5에서
 *      그 세션이 실제로 생기기 전까지는 WATCH_TELEGRAM_SESSION=1 환경변수가 없으면
 *      건너뛴다(아직 없는 프로세스를 "죽었다"고 오탐하지 않기 위함)
 * 이상 감지 시 텔레그램으로 직접 알림을 보낸다(sendTelegram — 상시 세션과 무관하게
 * 독립 동작 가능, telegram.mjs 참고).
 *
 * 사용법: node scripts/jobs/health-watcher.mjs [--dry-run]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { parseFrontmatter, isStale } from '../lib/job-health.mjs';
import { sendTelegram, getTelegramWebhookInfo } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

// 이 잡(health-watcher) 자체가 보내는 텔레그램 알림의 부서 라벨 — 판테온 조직에서
// "장부·데이터·인프라 배관"을 담당하는 운영실(Hermes) 소관(v1 JOB_DEPARTMENT 매핑의
// 'backup'·'parse-notifications'·'realtime-quotes' 등이 전부 hermes였던 것과 동일 원칙).
// 2026-08-14 오너 지적 — 알림에 어느 잡을 감시하는 건지·어느 부서 소관인지 표기 안 돼
// 있어 헷갈렸음, formatDepartmentMessage(기존 부서 메시지 포맷)로 통일.
const DEPARTMENT_LABEL = '운영실 Hermes';

// 잡별 기대 실행 주기 — 새 v2 잡이 생길 때마다 여기 추가한다(구현계획서 Phase 5+).
// 값이 없는 잡은 기본값(EXPECTED_INTERVAL_DEFAULT_MS)을 쓴다.
const EXPECTED_INTERVALS_MS = {
  // ⚠️ 빈도 수정(2026-08-14, 오너 확인) — 기존엔 v1 주기(매시간)를 그대로 계승했지만,
  // 자산분배 트랙엔 이 기록을 당일 즉시 소비하는 자동화가 없어(퀀트 트랙과 달리 같은
  // 날 바로 사고파는 파이프라인이 없음) 하루 1회(평일 16:00 KST)로 충분하다 —
  // com.banana2.parse-notifications-to-vault.plist 참고.
  'parse-notifications-to-vault': 24 * 60 * 60 * 1000,
  // ⚠️ 버그 수정(2026-08-14, 오너 신고 — 30분마다 알람 반복) — backup-vault는 밤 23:50
  // 하루 1회만 도는 잡인데(scripts/launchd/com.banana2.backup-vault.plist,
  // StartCalendarInterval) 여기 항목이 없어 기본값(1시간)이 적용됐다. 그 결과 정상
  // 실행 후 2시간(기대주기×2)만 지나면 매일 "조용하다"고 오판해 다음날 23:50까지
  // 22시간 동안 30분마다 계속 알림이 나갔다 — 이 잡을 처음 활성화할 때(2026-08-13)
  // backup-vault의 실제(하루 1회) 주기를 안 넣은 설정 누락.
  'backup-vault': 24 * 60 * 60 * 1000,
  // daily-asset-allocation-check도 backup-vault와 같은 이유로 하루 1회 잡 — 처음부터
  // 여기 넣어 같은 오탐이 재발하지 않게 한다(2026-08-14).
  'daily-asset-allocation-check': 24 * 60 * 60 * 1000,
  // update-holdings-from-executions(2026-08-15 신설 스케줄) — 로직 자체는 이미 있었지만
  // (퀀트 체결은 KIS API가 정본이라 skip, 그 외 자산분배 트랙 체결만 반영) 무인 스케줄이
  // 없어 watch-order-fill.mjs의 퀀트 트리거에만 의존하던 잡. 평일 16:05 KST 하루 1회
  // (parse-notifications-to-vault 16:00 직후).
  'update-holdings-from-executions': 24 * 60 * 60 * 1000,
  // ⚠️ new-cash-allocation은 2026-08-16 신설 다음날(08-17) 실제로 첫 자동 실행됐다가
  // 즉시 잠정 중단됐다(오너 지적) — 누적 로직이 "배당·매도로 들어온 돈"만 더하고
  // "그 돈으로 오너가 이미 직접 재투자한 것"은 빼지 않아, 실제 예수금(위탁 1,164,516원,
  // State/Holdings/위탁-예수금.md)보다 약 10배 부풀려진 금액(11,598,305원)으로 실제
  // 매수 제안이 나갔다. 근본 원인은 v2에 예수금앵커(카카오 입출금 알림) → Vault 배선이
  // 아직 없어 진짜 현금 잔고를 실시간 추적할 방법 자체가 없다는 것(Facts/Ledger/
  // CashEvents 계속 비어있음, 기존에 이미 알려진 공백). launchd 잡 자체를 언로드했으므로
  // 여기 등록하면 영원히 "조용하다"고 오판해 알림 스팸만 낸다 — 예수금 추적이 제대로
  // 자리잡으면(예수금앵커 배선 완료 후) 이 항목을 되살릴 것. 다른 4개 자산분배 잡
  // (parse-notifications-to-vault·update-holdings-from-executions·
  // daily-asset-allocation-check·backup-vault)은 이 문제와 무관해 그대로 둔다.
};
const EXPECTED_INTERVAL_DEFAULT_MS = 60 * 60 * 1000;

// 텔레그램 상시세션 프로세스 감시 — 그 세션 자체가 Phase 5 산출물이라 아직 없다.
// 환경변수로 명시적으로 켜지 않으면 이 체크는 건너뛴다(오탐 방지).
const WATCH_TELEGRAM_SESSION = process.env.WATCH_TELEGRAM_SESSION === '1';
const TELEGRAM_SESSION_PATTERN = 'claude.*--channels.*telegram';

export function findStaleJobs(jobHealthDir, { now = new Date(), expectedIntervals = EXPECTED_INTERVALS_MS, defaultIntervalMs = EXPECTED_INTERVAL_DEFAULT_MS } = {}) {
  if (!existsSync(jobHealthDir)) return [];
  const stale = [];
  for (const file of readdirSync(jobHealthDir)) {
    if (!file.endsWith('.md')) continue;
    const job = file.replace(/\.md$/, '');
    const record = parseFrontmatter(readFileSync(join(jobHealthDir, file), 'utf8'));
    const expectedIntervalMs = expectedIntervals[job] ?? defaultIntervalMs;
    if (isStale({ lastRun: record.lastRun, expectedIntervalMs, now })) {
      stale.push({ job, lastRun: record.lastRun ?? null, expectedIntervalMs });
    }
  }
  return stale;
}

function isProcessAlive(pattern) {
  try {
    execSync(`pgrep -f "${pattern}"`, { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false; // pgrep이 못 찾으면 비영(exit 1) — 프로세스 없음
  }
}

// 좀비 감지(2026-08-13, task #34) — pgrep은 "프로세스가 존재하는가"만 보고 "실제로
// 메시지를 소비하고 있는가"는 못 본다. pending_update_count가 0보다 크면 텔레그램이
// 배달을 시도했는데 상시세션이 아직 안 가져간 업데이트가 큐에 남아있다는 뜻 —
// getUpdates 롱폴링이 정상이면 보통 즉시 소비되므로, 이 시점 스냅샷에서 잡힌다는 것
// 자체가 폴링이 멈췄다는 강한 신호다(오탐 여지: 체크 순간과 다음 폴링 사이의 아주 좁은
// 타이밍 경합 — 실무적으로 무시 가능한 수준으로 판단, 순수함수라 임계값 조정은 쉬움).
export function isPollingStuck({ pendingUpdateCount }) {
  return Number.isFinite(pendingUpdateCount) && pendingUpdateCount > 0;
}

async function main() {
  const issues = [];

  for (const s of findStaleJobs(VAULT_PATHS.state.jobHealth)) {
    const lastRunDesc = s.lastRun ? `마지막 실행 ${s.lastRun}` : '실행 기록 없음';
    issues.push(`⚠️ 잡 <code>${s.job}</code>이(가) 조용합니다 — ${lastRunDesc}(기대주기 ${Math.round(s.expectedIntervalMs / 60000)}분의 2배 초과)`);
  }

  if (WATCH_TELEGRAM_SESSION) {
    if (!isProcessAlive(TELEGRAM_SESSION_PATTERN)) {
      issues.push('⚠️ 텔레그램 상시 세션이 응답하지 않습니다(프로세스 없음).');
    } else {
      // 프로세스는 살아있어도 폴링이 멈췄을 수 있다(좀비 상태, 위 isPollingStuck 주석
      // 참고) — 이 체크는 실패해도(네트워크 오류 등) 다른 잡의 stale 판정을 막지 않게
      // 별도로 감싼다.
      try {
        const info = await getTelegramWebhookInfo();
        if (isPollingStuck({ pendingUpdateCount: info.pending_update_count })) {
          issues.push(
            `⚠️ 텔레그램 상시 세션이 좀비 상태로 보입니다 — 프로세스는 살아있지만 ` +
            `미수신 메시지 ${info.pending_update_count}건이 큐에 쌓여있습니다(폴링 중단 의심). 세션 재시작 필요.`,
          );
        }
      } catch (e) {
        issues.push(`⚠️ 텔레그램 폴링 상태 확인 실패(getWebhookInfo): ${e.message}`);
      }
    }
  }

  if (!issues.length) {
    console.log('✅ health-watcher: 이상 없음');
    return;
  }

  console.log(`🚨 health-watcher: 이상 ${issues.length}건 감지`);
  issues.forEach((i) => console.log(`  ${i}`));
  if (!DRY_RUN) {
    try {
      await sendTelegram(formatDepartmentMessage({
        departmentLabel: DEPARTMENT_LABEL,
        body: `🚨 <b>banana v2 장애감지</b>\n${issues.join('\n')}`,
      }));
    } catch (e) {
      console.error('텔레그램 알림 실패:', e.message);
    }
  }
}

// 직접 실행될 때만 main()을 돈다 — findStaleJobs를 테스트에서 import할 때 전체 잡이
// 실행되고 텔레그램까지 시도되는 사고를 막는다(drain-eval-queue.mjs와 동일 관례).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ health-watcher 오류:', e.message); process.exit(1); });
}
