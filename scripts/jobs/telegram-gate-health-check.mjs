#!/usr/bin/env node
/**
 * 텔레그램 관문 바깥 감시(10분, 2026-10-30 관문 1단계) — 관문 데몬이 프로세스는 살아 있는데 멈춘 경우를 잡는다.
 * 데몬 안의 감시견(수신 루프 진척·이벤트 루프 지연 → exit)과 launchd KeepAlive(프로세스 종료 → 재시작)가 1차 방어이고,
 * 이 잡은 그 둘이 못 보는 경우(감시견 타이머까지 멈춘 교착, 재시작 루프)를 본다.
 *
 * 신호(결정론):
 *   1) 관문 상태 폴더 heartbeat.json이 15분 넘게 갱신되지 않음(하트비트 5분 주기의 3배)
 *   2) getWebhookInfo(읽기 전용, getUpdates와 충돌 없음)의 pending_update_count가 두 번 연속 0보다 큼 — 수신이 멎었다는 뜻
 * 조치: `launchctl kickstart -k gui/<uid>/com.banana2.telegram-gate` + 제우스 경고(경고 원장 경유).
 *   plist 인자가 바뀌지 않으므로 옛 상시 세션처럼 bootout+bootstrap이 필요 없다.
 * 실전 가드 거부(관문 상태 폴더 refusal.json이 마지막 하트비트보다 새것): 관문이 스스로 실전 시작을 거부하고 끝난 상태다.
 *   다시 띄워도 또 거부하니 재시작하지 않고, 거부마다 한 번만 "사람 확인 필요"를 알린다(2026-10-31 실전 가드 재리뷰 2차 M1).
 * 차단기: 연속 3회 재시작해도 회복하지 않으면 재시작을 멈추고 "사람 확인 필요"만 알린다(옛 health-check와 같은 원칙 —
 *   반복 재시작이 정상 동작이 되면 안 된다). 한 번이라도 정상이면 카운터를 0으로 되돌린다.
 *
 * 사용법: node scripts/jobs/telegram-gate-health-check.mjs [--dry-run]   (--dry-run: 판정만 출력, 재시작·발송 없음)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultGatePaths } from '../lib/telegram-gate-config.mjs';
import { getTelegramWebhookInfo } from '../lib/telegram.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { createDirectWarningSender } from '../lib/direct-warning-delivery.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';

const SENDER_AGENT = 'zeus';
export const HEARTBEAT_STALE_MS = 15 * 60 * 1000;
export const MAX_CONSECUTIVE_RESTARTS = 3;
const GATE_LABEL = 'com.banana2.telegram-gate';

// 순수 함수: 이번 점검 결과 → { healthy, reasons[], pendingStreak, refused }
// refusal: refusal.json. 마지막 하트비트보다 새것이면 실전 가드 거부로 꺼져 있는 상태(refused)다.
export function assessGate({ heartbeat, nowMs, pendingCount, priorPendingStreak = 0, refusal = null }) {
  const reasons = [];
  const beatAt = heartbeat?.at ? Date.parse(heartbeat.at) : NaN;
  const refusedAt = refusal?.at ? Date.parse(refusal.at) : NaN;
  if (Number.isFinite(refusedAt) && !(Number.isFinite(beatAt) && beatAt > refusedAt)) {
    const codes = Array.isArray(refusal.codes) ? refusal.codes.filter((c) => /^[A-Z_]{2,40}$/.test(String(c))) : [];
    return { healthy: false, refused: true, refusedAt: refusal.at, reasons: [`관문이 실전 시작을 거부하고 꺼져 있음(${codes.join(', ') || '사유 코드 없음'})`], pendingStreak: 0 };
  }
  if (!Number.isFinite(beatAt)) reasons.push('관문 하트비트 없음');
  else if (nowMs - beatAt > HEARTBEAT_STALE_MS) reasons.push(`관문 하트비트 ${Math.round((nowMs - beatAt) / 60000)}분 전`);
  const pendingStreak = Number.isFinite(pendingCount) && pendingCount > 0 ? priorPendingStreak + 1 : 0;
  if (pendingStreak >= 2) reasons.push(`가져가지 않은 메시지 ${pendingCount}건이 두 번 연속 남음`);
  return { healthy: reasons.length === 0, refused: false, reasons, pendingStreak };
}

// 순수 함수: 판정 + 이전 재시작 횟수 → 할 일. 거부는 재시작하지 않는다(카운터도 그대로).
export function decideAction({ healthy, consecutiveRestarts, refused = false }) {
  if (refused) return { action: 'refused', consecutiveRestarts };
  if (healthy) return { action: 'none', consecutiveRestarts: 0 };
  if (consecutiveRestarts >= MAX_CONSECUTIVE_RESTARTS) return { action: 'escalate', consecutiveRestarts };
  return { action: 'restart', consecutiveRestarts: consecutiveRestarts + 1 };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export async function runHealthCheck({ stateDir = defaultGatePaths().liveStateDir, nowMs = Date.now(), dryRun = false,
  webhookInfo = () => getTelegramWebhookInfo(), restart = () => execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${GATE_LABEL}`], { timeout: 30_000 }),
  warn = createDirectWarningSender(sendAgentMessage, { jobName: 'telegram-gate-health-check', warningCode: 'TELEGRAM_GATE_UNHEALTHY', subjectKey: 'telegram-gate', kind: 'operational', severity: 'high' }),
  log = console.log } = {}) {
  const statePath = join(stateDir, 'health-check.json');
  const prior = readJson(statePath) ?? {};
  let pendingCount = null;
  try { pendingCount = (await webhookInfo())?.pending_update_count ?? null; } catch (error) { log(`getWebhookInfo 실패(이번엔 하트비트만 본다): ${error.message}`); }
  const assessment = assessGate({ heartbeat: readJson(join(stateDir, 'heartbeat.json')), nowMs, pendingCount, priorPendingStreak: prior.pendingStreak ?? 0,
    refusal: readJson(join(stateDir, 'refusal.json')) });
  const decision = decideAction({ healthy: assessment.healthy, consecutiveRestarts: prior.consecutiveRestarts ?? 0, refused: assessment.refused });
  log(`관문 점검: ${assessment.healthy ? '정상' : assessment.reasons.join(' · ')} → ${decision.action}`);
  if (dryRun) return { assessment, decision };

  if (decision.action === 'restart') {
    try {
      restart();
      await warn({ agent: SENDER_AGENT, kind: '정보', topic: '경고', body: [`관문이 멈춘 것 같아 다시 띄웠습니다(연속 ${decision.consecutiveRestarts}회째).`, ...assessment.reasons.map((r) => `· ${r}`)].join('\n') });
    } catch (error) {
      // 오류 원문은 오너 메시지에 넣지 않고 로그에만 남긴다(2026-09-20 오너 DevRequest, telegram-format-compliance 가드).
      log(`관문 재시작 실패: ${error.message}`);
      await warn({ agent: SENDER_AGENT, kind: '정보', topic: '경고', body: '관문 재시작 실패 — 사람 확인 필요.\n· 자세한 원인은 telegram-gate-health-check.log' });
    }
  } else if (decision.action === 'refused' && prior.refusalAlertedAt !== assessment.refusedAt) {
    await warn({ agent: SENDER_AGENT, kind: '정보', topic: '경고', body: [
      '관문이 실전 시작을 스스로 거부하고 꺼져 있습니다. 다시 띄워도 같은 이유로 거부하므로 자동 재시작하지 않습니다. 사람 확인이 필요합니다.',
      ...assessment.reasons.map((r) => `· ${r}`), '· 자세한 사유는 telegram-gate.log의 LIVE_REFUSED 줄'].join('\n') });
  } else if (decision.action === 'escalate' && !prior.escalated) {
    await warn({ agent: SENDER_AGENT, kind: '정보', topic: '경고', body: [`관문이 ${MAX_CONSECUTIVE_RESTARTS}번 다시 띄워도 회복하지 않아 자동 재시작을 멈췄습니다. 사람 확인이 필요합니다.`, ...assessment.reasons.map((r) => `· ${r}`)].join('\n') });
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeAtomic(statePath, `${JSON.stringify({
    at: new Date(nowMs).toISOString(), healthy: assessment.healthy, reasons: assessment.reasons, pendingStreak: assessment.pendingStreak,
    consecutiveRestarts: decision.consecutiveRestarts, escalated: decision.action === 'escalate',
    refusalAlertedAt: decision.action === 'refused' ? assessment.refusedAt : (prior.refusalAlertedAt ?? null),
  })}\n`);
  return { assessment, decision };
}

const invokedPath = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return null; } })();
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const stateDir = defaultGatePaths().liveStateDir;
  if (!existsSync(stateDir)) {
    console.log('관문 상태 폴더가 없음 — 관문이 아직 설치되지 않았다(점검 건너뜀)');
  } else {
    runHealthCheck({ dryRun: process.argv.includes('--dry-run') }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
