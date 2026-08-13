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
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

// 잡별 기대 실행 주기 — 새 v2 잡이 생길 때마다 여기 추가한다(구현계획서 Phase 5+).
// 값이 없는 잡은 기본값(EXPECTED_INTERVAL_DEFAULT_MS)을 쓴다.
const EXPECTED_INTERVALS_MS = {
  // "카카오 알림 → Vault" 절: Mac 로컬 자동화가 매시간 알람 시트를 폴링(기존 v1 주기 계승)
  'parse-notifications-to-vault': 60 * 60 * 1000,
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
      await sendTelegram(`🚨 <b>banana v2 장애감지</b>\n${issues.join('\n')}`);
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
