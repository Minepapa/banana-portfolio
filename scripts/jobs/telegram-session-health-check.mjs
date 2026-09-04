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
 * ⚠️ 순간포착 재확인(2026-09-01, 오너 신고 — "어제 오늘부터 가상세션이 자주
 * 끊어지고 재시작 알람도 자주 온다") — 원인 조사 결과 이 잡이 신설된 직후부터
 * (2026-08-31 이전엔 하루 1회 예방적 재시작뿐이었는데, 이 잡 신설 이후 하루 여러
 * 차례 추가 재시작이 발생) 사실이 아닌 장애를 잡고 있었다는 정황이 강하다: bun
 * 크래시 리포트 없음(`~/Library/Logs/DiagnosticReports`), OOM/jetsam 로그 없음,
 * 절전·잠자기 이벤트 없음, 실시간으로 몇 분간 촘촘히(2초 간격) 관찰해도 서브프로세스
 * 소실이 재현 안 됨 — 반면 세션 로그엔 "Claude.ai login expired → Remote Control
 * 재연결(/rc)" 사이클이 관찰돼, 이 재인증 순간 MCP 서브프로세스가 아주 짧게(수 초)
 * 흔들렸다 스스로 복구되는 경우를 이 잡의 단발성 pgrep 스냅샷이 "영구 소실"로
 * 오판했을 가능성이 높다고 결론지었다. **재시작은 최후의 수단이어야지, 매 순간
 * 포착에 반응해 활성 세션을 통째로 끊는 게 정상 동작이 되면 안 된다**(오너 지시) —
 * 그래서 이상 감지 시 즉시 조치하지 않고, 짧게 대기한 뒤 한 번 더 확인해서(아래
 * `checkWithRecheck`) 그때도 여전히 죽어있어야만 실제 조치(재시작/에스컬레이션)
 * 대상으로 삼는다. 진짜 장애(세션 프로세스 자체 사망 등)는 재확인에서도 당연히
 * 그대로 걸리므로 이 방어에 놓치는 손실은 재확인 지연시간(수십 초)뿐이다.
 *
 * 조치: 실패 감지 시 기존 `restart-telegram-session.sh`(예방적 일일 04:00 재시작과
 * 동일 스크립트)를 그대로 재사용 — 재시작 로직을 여기서 새로 만들지 않는다. 알림은
 * sendTelegram()으로 발송(MCP를 안 거치고 Bot API를 직접 호출해서 세션 MCP가
 * 죽어있어도 정상 작동함).
 *
 * ⚠️ 근본원인 진단 계측(2026-09-04, 오너 재요청 — "근본 원인을 다시 파악해보자") —
 * 2026-09-01·2026-09-04 두 번 다 크래시 리포트·OOM/jetsam·절전이벤트·네트워크단절
 * 전부 확인했지만 원인을 못 찾았다(Wi-Fi "Deauth" 로그도 재조사해보니 20초마다
 * 반복되는 무관한 배경 노이즈였을 뿐, 재시작 시각과 무상관으로 확인됨 — 오탐). 과거
 * 로그를 더 뒤져서는 못 찾을 가능성이 높다고 판단 — 대신 **다음에 감지되는 순간**
 * 시스템 상태(여유메모리·loadavg·가동시간) 스냅샷을 별도로 계속 기록해 며칠 치
 * 패턴이 쌓이면 그때 다시 분석한다(하루 1~3회 발생하는 걸로 실측됨 — 며칠이면
 * 표본이 쌓임). recordMcpLossSnapshot 참고. 재확인에서 회복되는 경우도 포함해서
 * 전부 기록한다(회복되는 "일시적" 경우도 나중에 패턴 비교에 필요한 데이터).
 *
 * 사용법: node scripts/jobs/telegram-session-health-check.mjs [--dry-run]
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { sendTelegram, getTelegramWebhookInfo } from '../lib/telegram.mjs';
import { formatFactsMessage } from '../lib/telegram-messages.mjs';
import { isProcessAlive, isPollingStuck, TELEGRAM_SESSION_PROCESS_PATTERN, TELEGRAM_MCP_SUBPROCESS_PATTERN } from '../lib/telegram-session-liveness.mjs';

const MCP_LOSS_LOG_FILE = join(VAULT_PATHS.log.telegramSession, 'mcp-loss-diagnostics.md');
const MCP_LOSS_LOG_HEADER = '# 텔레그램 MCP 소실 진단 로그\n\n' +
  '감지될 때마다(재확인 후 회복된 경우 포함) 그 순간의 시스템 상태를 누적 기록 —\n' +
  '근본원인 패턴 분석용(2026-09-04 신설, `Log/Implementation/2026-09-04-텔레그램MCP소실-진단계측.md` 참고).\n\n';

const DRY_RUN = process.argv.includes('--dry-run');
const HERE = dirname(fileURLToPath(import.meta.url));
const DEPARTMENT_LABEL = '운영실 Hermes';
const RESTART_SCRIPT = join(HERE, '..', 'launchd', 'restart-telegram-session.sh');
const STATE_DIR = join(VAULT_PATHS.root, 'State', 'TelegramSessionHealth');
const STATE_FILE = join(STATE_DIR, 'status.md');
const MAX_CONSECUTIVE_RESTARTS = 3;
const RESTART_TIMEOUT_MS = 120_000; // bootout+bootstrap는 보통 수 초, 넉넉히 2분
const RECHECK_DELAY_MS = 15_000; // 순간포착 재확인 대기(위 헤더 주석 참고)
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// checkSignals(주입 가능한 async 함수, 실제 IO는 main()의 기본 구현이 담당)를 즉시
// 신뢰하지 않고, 이상이 잡히면 sleep 후 한 번 더 불러 재확인한다 — 1차 확인에서
// 순간적으로만 이상했다가 재확인에서 회복되면 "일시적 현상"으로 보고 조치하지 않는다
// (위 헤더 주석의 "순간포착 재확인" 근거). sleep을 주입받아 테스트에서 실제 대기
// 없이 검증 가능(state-writer.mjs withLock의 sleep 주입과 동일 패턴).
export async function checkWithRecheck(checkSignals, { sleep = defaultSleep, recheckDelayMs = RECHECK_DELAY_MS } = {}) {
  const first = await checkSignals();
  if (first.sessionAlive && first.mcpSubprocessAlive) return { ...first, recheckedAndRecovered: false, firstCheckUnhealthy: false };
  await sleep(recheckDelayMs);
  const second = await checkSignals();
  const recovered = second.sessionAlive && second.mcpSubprocessAlive;
  // firstCheckUnhealthy(2026-09-04 신설, 근본원인 진단 계측용) — 1차 확인에서 이상이
  // 감지됐다는 사실 자체는 최종 recheckedAndRecovered 결과와 별개로 항상 알려준다.
  // main()이 이 값을 보고 "재확인 후 회복됐든 안 됐든 일단 감지는 됐다"는 매 순간을
  // 놓치지 않고 시스템 스냅샷을 남길 수 있게(위 파일 헤더 주석 참고).
  return { ...second, recheckedAndRecovered: recovered, firstCheckUnhealthy: true };
}

// 순수함수(테스트 가능) — 시스템 스냅샷 하나를 사람이 읽는 마크다운 한 줄로.
export function buildMcpLossSnapshotLine({ timestampIso, recheckedAndRecovered, freeMemBytes, totalMemBytes, loadavg, uptimeSec }) {
  const freeMB = Math.round(freeMemBytes / 1024 / 1024);
  const totalMB = Math.round(totalMemBytes / 1024 / 1024);
  const freePct = totalMemBytes > 0 ? ((freeMemBytes / totalMemBytes) * 100).toFixed(1) : 'N/A';
  const uptimeHours = (uptimeSec / 3600).toFixed(1);
  const status = recheckedAndRecovered ? '일시적(재확인 후 회복)' : '지속(조치 대상)';
  const loadStr = (loadavg || []).map((l) => l.toFixed(2)).join('/');
  return `- ${timestampIso} — ${status} · 여유메모리 ${freeMB.toLocaleString()}MB/${totalMB.toLocaleString()}MB(${freePct}%) · loadavg ${loadStr} · 시스템가동 ${uptimeHours}시간`;
}

// IO — os 모듈 값만 그대로 모아 반환(부작용 없음, 순수 조회). 별도 함수로 분리해
// buildMcpLossSnapshotLine 자체는 순수 유지.
function captureSystemSnapshot() {
  return { freeMemBytes: os.freemem(), totalMemBytes: os.totalmem(), loadavg: os.loadavg(), uptimeSec: os.uptime() };
}

function appendMcpLossLine(line) {
  mkdirSync(VAULT_PATHS.log.telegramSession, { recursive: true });
  const existing = existsSync(MCP_LOSS_LOG_FILE) ? readFileSync(MCP_LOSS_LOG_FILE, 'utf8') : MCP_LOSS_LOG_HEADER;
  writeAtomic(MCP_LOSS_LOG_FILE, existing.trimEnd() + '\n' + line + '\n');
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

function checkSignalsOnce() {
  const sessionAlive = isProcessAlive(TELEGRAM_SESSION_PROCESS_PATTERN);
  const mcpSubprocessAlive = sessionAlive ? isProcessAlive(TELEGRAM_MCP_SUBPROCESS_PATTERN) : false;
  return { sessionAlive, mcpSubprocessAlive };
}

async function main() {
  const { sessionAlive, mcpSubprocessAlive, recheckedAndRecovered, firstCheckUnhealthy } = await checkWithRecheck(checkSignalsOnce);
  if (recheckedAndRecovered) {
    console.log(`⏳ 1차 확인에서 이상 감지됐으나 ${RECHECK_DELAY_MS / 1000}초 후 재확인에서 정상 회복 — 일시적 현상으로 판단, 조치 없음`);
  }

  // 근본원인 진단 계측(2026-09-04, 파일 헤더 주석 참고) — 재확인 후 회복됐든 안
  // 됐든 1차 감지가 있었으면 그 순간의 시스템 스냅샷을 남긴다.
  if (firstCheckUnhealthy) {
    const line = buildMcpLossSnapshotLine({ timestampIso: new Date().toISOString(), recheckedAndRecovered, ...captureSystemSnapshot() });
    console.log(`📊 진단 스냅샷: ${line}`);
    if (!DRY_RUN) appendMcpLossLine(line);
  }

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
