#!/usr/bin/env node
/**
 * 상시 텔레그램 세션(com.banana2.telegram-session)의 MCP 연결 끊김 감지·자동복구 —
 * 오너 신고(2026-08-31, `Log/DevRequests/2026-08-31-텔레그램세션-MCP연결끊김.md`)로
 * 발견한 구조적 사각 대응.
 *
 * ⚠️ 왜 launchd KeepAlive로는 안 잡히나 — launchd는 `com.banana2.telegram-session`
 * 프로세스(claude CLI 자체)의 생존 여부만 본다. 실측 확인(2026-08-31): 그 프로세스는
 * 계속 살아있는데, 그 아래 자식으로 떠야 할 telegram MCP 서버(bun 서브프로세스)가
 * 조용히 죽어 사라진 상태였다(에러 로그도 없이). claude CLI 쪽은 이걸
 * `plugin:telegram:telegram CONNECTION_CLOSED`로만 표시하고 자동 재연결하지 않는다.
 *
 * ⚠️ 설계가 한 번 바뀌었다(2026-08-31, 독립 코드리뷰 지적) — 최초 버전은 세션의 raw
 * 터미널 로그(`/usr/bin/script` 캡처)에서 실패 문구를 grep하는 방식이었는데, 그 로그가
 * TUI **차등 리페인트**라 마커 문자열이 화면 갱신 경계에서 실제로 쪼개지는 걸 실측으로
 * 확인했다(예: "login expired"가 실제 로그에서 "login\x1b[49Gexpired"로, ANSI 커서이동
 * 코드가 단어 중간에 끼어들어 문자열 매칭이 새는 사례가 있었음 — 정확히 이 잡이
 * 잡아야 할 그 장애를 놓칠 수 있는 구조적 결함). 지금은 결정론적이고 ANSI 파싱이
 * 전혀 필요 없는 두 신호(scripts/lib/telegram-session-liveness.mjs)만 쓴다:
 *   1) TELEGRAM_MCP_SUBPROCESS_PATTERN — bun 서브프로세스가 실제로 떠있는지 직접 확인
 *      (2026-08-31 실제 장애 형태를 가장 직접적으로 잡는 1차 신호)
 *   2) isPollingStuck(getTelegramWebhookInfo) — health-watcher.mjs가 이미 쓰던 신호,
 *      pending_update_count>0이면 폴링이 멈췄다는 뜻(1번 신호의 사각을 메우는 보조
 *      신호 — 서브프로세스는 떠있는데 내부적으로 멎은 경우까지 잡음)
 *   3) TELEGRAM_SESSION_PROCESS_PATTERN — 세션 프로세스 자체가 죽은 경우(가장 드묾,
 *      launchd KeepAlive가 보통 먼저 잡지만 belt-and-suspenders)
 *
 * ⚠️ 서킷브레이커(2026-08-31, 코드리뷰 HIGH 지적) — MCP가 지속적으로 고장난 상태면
 * 10분마다 계속 재시작을 시도하게 되는데, 이러면 오너가 쓰고 있을 수도 있는 세션을
 * 반복적으로 끊어버린다. 연속 감지·재시작 횟수를 State에 기록해 MAX_CONSECUTIVE_
 * RESTARTS(3회)를 넘으면 재시작을 멈추고 "수동 개입 필요" 알림으로 전환한다(정상
 * 회복이 확인되면 — 즉 한 번이라도 "조용함"이 나오면 — 카운터를 0으로 리셋).
 *
 * 조치: 실패 감지 시 기존 `restart-telegram-session.sh`(예방적 일일 04:00 재시작과
 * 동일 스크립트)를 그대로 재사용 — 재시작 로직을 여기서 새로 만들지 않는다. 알림은
 * sendTelegram()으로 발송(MCP를 안 거치고 Bot API를 직접 호출해서 세션 MCP가
 * 죽어있어도 정상 작동함).
 *
 * 사용법: node scripts/jobs/telegram-session-health-check.mjs [--dry-run]
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { sendTelegram, getTelegramWebhookInfo } from '../lib/telegram.mjs';
import { formatFactsMessage } from '../lib/telegram-messages.mjs';
import { isProcessAlive, isPollingStuck, TELEGRAM_SESSION_PROCESS_PATTERN, TELEGRAM_MCP_SUBPROCESS_PATTERN } from '../lib/telegram-session-liveness.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const HERE = dirname(fileURLToPath(import.meta.url));
const DEPARTMENT_LABEL = '운영실 Hermes';
const RESTART_SCRIPT = join(HERE, '..', 'launchd', 'restart-telegram-session.sh');
const STATE_DIR = join(VAULT_PATHS.root, 'State', 'TelegramSessionHealth');
const STATE_FILE = join(STATE_DIR, 'status.md');
const MAX_CONSECUTIVE_RESTARTS = 3;
const RESTART_TIMEOUT_MS = 120_000; // bootout+bootstrap는 보통 수 초, 넉넉히 2분

// 순수함수 — 세 신호를 종합해 "재시작이 필요한가"와 그 이유를 판정. 인자는 이미
// 조회된 값(프로세스 생존 여부·폴링정체 여부)만 받는다 — I/O는 호출부(main)가 담당.
export function diagnose({ sessionAlive, mcpSubprocessAlive, pollingStuck }) {
  if (!sessionAlive) return { unhealthy: true, reason: '세션 프로세스 자체가 응답하지 않음(생존 확인 실패)' };
  if (!mcpSubprocessAlive) return { unhealthy: true, reason: 'telegram MCP 서버(bun 서브프로세스) 소실 — 세션 프로세스는 살아있지만 MCP 연결 끊김' };
  if (pollingStuck) return { unhealthy: true, reason: '폴링 정체 의심(미수신 메시지가 큐에 쌓여있음) — 서브프로세스는 떠있지만 내부적으로 멎었을 가능성' };
  return { unhealthy: false, reason: null };
}

// 순수함수 — 서킷브레이커 판단. consecutiveRestarts는 "이번이 몇 번째 연속 감지인가"
// (이번 감지를 포함해서 센 값)를 넘긴다. 한도 넘으면 재시작 대신 에스컬레이션.
export function shouldEscalateInsteadOfRestart(consecutiveRestarts, max = MAX_CONSECUTIVE_RESTARTS) {
  return consecutiveRestarts > max;
}

function readState() {
  if (!existsSync(STATE_FILE)) return { consecutiveRestarts: 0 };
  const fm = parseFrontmatter(readFileSync(STATE_FILE, 'utf8'));
  return { consecutiveRestarts: Number.isFinite(fm.consecutiveRestarts) ? fm.consecutiveRestarts : 0 };
}

function writeState({ consecutiveRestarts }) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeAtomic(STATE_FILE, buildFrontmatter({
    type: 'telegram-session-health-check-state', consecutiveRestarts, checkedAt: new Date().toISOString(),
  }));
}

async function main() {
  const sessionAlive = isProcessAlive(TELEGRAM_SESSION_PROCESS_PATTERN);
  const mcpSubprocessAlive = sessionAlive ? isProcessAlive(TELEGRAM_MCP_SUBPROCESS_PATTERN) : false;

  let pollingStuck = false;
  if (sessionAlive && mcpSubprocessAlive) {
    // 앞 두 신호가 정상일 때만 확인(불필요한 API 호출 절약) — 확인 자체가 실패해도
    // (네트워크 일시 오류 등) "고장"으로 단정하지 않는다(health-watcher.mjs와 동일
    // 원칙 — 이건 알림만 하지만 여긴 재시작까지 하므로 더 보수적으로 접근).
    try {
      const info = await getTelegramWebhookInfo();
      pollingStuck = isPollingStuck({ pendingUpdateCount: info.pending_update_count });
    } catch (e) {
      console.error(`⚠ getWebhookInfo 확인 실패(재시작 판단에서 제외, 다음 실행 재시도): ${e.message}`);
    }
  }

  const { unhealthy, reason } = diagnose({ sessionAlive, mcpSubprocessAlive, pollingStuck });

  if (!unhealthy) {
    if (!DRY_RUN) writeState({ consecutiveRestarts: 0 }); // 회복 확인 — 카운터 리셋
    console.log('✅ telegram-session-health-check: 이상 없음(조용함)');
    return;
  }

  const { consecutiveRestarts: prevCount } = readState();
  const consecutiveRestarts = prevCount + 1;
  const escalate = shouldEscalateInsteadOfRestart(consecutiveRestarts);

  console.log(`🔔 telegram-session-health-check: ${reason} (연속 ${consecutiveRestarts}회째)`);

  if (DRY_RUN) {
    console.log(`(드라이런 — ${escalate ? '에스컬레이션' : '재시작'}·상태갱신·알림 없음)`);
    return;
  }

  writeState({ consecutiveRestarts });

  if (escalate) {
    console.log(`🚨 연속 ${consecutiveRestarts}회 — 재시작 중단, 수동 개입 필요 알림만 발송`);
    try {
      await sendTelegram(formatFactsMessage({
        departmentLabel: DEPARTMENT_LABEL,
        tag: '경고',
        facts: [
          `<b>감지</b>: ${reason}`,
          `<b>연속 ${consecutiveRestarts}회째 감지</b> — 자동 재시작을 ${MAX_CONSECUTIVE_RESTARTS}회 넘어 중단함(반복 재시작이 오히려 방해가 될 수 있음)`,
          '<b>수동 확인 필요</b>: launchd 상태·MCP 플러그인 로그 직접 점검',
        ],
      }));
    } catch (e) {
      console.error('텔레그램 알림 실패:', e.message);
    }
    return;
  }

  let restartOk = true;
  try {
    execFileSync('bash', [RESTART_SCRIPT], { stdio: 'inherit', timeout: RESTART_TIMEOUT_MS, killSignal: 'SIGKILL' });
  } catch (e) {
    restartOk = false;
    console.error('재시작 스크립트 실행 실패(타임아웃 포함):', e.message);
  }

  try {
    await sendTelegram(formatFactsMessage({
      departmentLabel: DEPARTMENT_LABEL,
      tag: '경고',
      facts: [
        `<b>감지</b>: ${reason}`,
        `<b>조치</b>: com.banana2.telegram-session 자동 재시작 ${restartOk ? '완료' : '실패(수동 확인 필요)'}(연속 ${consecutiveRestarts}회째)`,
      ],
    }));
  } catch (e) {
    console.error('텔레그램 알림 실패:', e.message);
  }
}

// import.meta.url 가드 — 이 파일은 telegram-session-health-check.test.js가
// diagnose·shouldEscalateInsteadOfRestart(순수함수)만 가져다 쓰려고 직접 import한다.
// 가드 없이 최상위에서 main()을 그냥 부르면 테스트가 이 모듈을 import하는 순간 실제
// pgrep 조회·launchd 재시작·텔레그램 발송까지 실행돼버린다(다른 모든 잡과 동일 이유).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ telegram-session-health-check 오류:', e.message); process.exit(1); });
}
