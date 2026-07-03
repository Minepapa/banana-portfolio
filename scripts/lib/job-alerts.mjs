// 무인 잡 경고 집계·발송 헬퍼 — "조용한 실패" 방지 (2026-07 사고: 평가 매핑실패·배당
// 귀속실패가 console.log에만 남아 사용자가 시트를 열기 전엔 몰랐음).
//
// 사용: 잡 본문에서 collectWarning(msg) 누적 → 종료 직전 flushWarnings(jobName).
// flush 동작:
//   1) stdout에 "⚠ 경고 N건: …" 요약 1줄 — run.sh가 로그 꼬리(tail -3)를 HB_DETAIL로
//      잡상태 detail(D열)에 넣으므로, 마지막 줄 출력만으로 앱(KPI 탭)에 노출된다.
//      (잡이 직접 잡상태를 쓰면 직후 record-heartbeat가 A:F를 덮어 레이스 — stdout 경유가 정답)
//   2) 텔레그램 1건(집계 목록). 동일 시그니처(정렬 경고 해시)가 24h 내 재발이면 발송 억제
//      — 매시간 잡이 같은 경고를 반복 푸시하는 스팸 방지. 상태: scripts/.cache/job-alerts.json
// 텔레그램 실패는 console.error 후 무시(record-heartbeat와 동일 정책 — 알림이 잡을 죽이지 않음).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sendTelegram } from './telegram.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(HERE, '..', '.cache', 'job-alerts.json');
const SUPPRESS_MS = 24 * 3600 * 1000;

const warnings = [];

export function collectWarning(msg) {
  const m = String(msg ?? '').trim();
  if (m) warnings.push(m);
}

export function warningCount() { return warnings.length; }

// 테스트용 — 모듈 상태 초기화
export function resetWarnings() { warnings.length = 0; }

// 순수 판단 함수(테스트 가능): 이번 경고 세트를 발송해야 하나?
export function shouldNotify(state, jobName, sig, now = Date.now()) {
  const prev = state?.[jobName];
  return !(prev && prev.sig === sig && now - prev.ts < SUPPRESS_MS);
}

export function warningsSignature(list) {
  return createHash('sha1').update([...list].sort().join('\n')).digest('hex');
}

export async function flushWarnings(jobName, { dryRun = false } = {}) {
  if (!warnings.length) return;
  // 1) 잡상태 detail 노출 경로 — 반드시 로그 "마지막" 줄들에 위치해야 tail -3에 잡힌다.
  console.log(`⚠ 경고 ${warnings.length}건: ${warnings.join(' | ').slice(0, 180)}`);
  if (dryRun) return;

  // 2) 텔레그램 (24h 동일 시그니처 억제)
  const sig = warningsSignature(warnings);
  let state = {};
  try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { state = {}; }
  if (!shouldNotify(state, jobName, sig)) return;
  try {
    const list = warnings.slice(0, 8).map(w => `• ${w}`).join('\n');
    const more = warnings.length > 8 ? `\n… 외 ${warnings.length - 8}건` : '';
    await sendTelegram(`⚠️ <b>banana ${jobName} 경고 ${warnings.length}건</b>\n${list}${more}`);
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    state[jobName] = { sig, ts: Date.now() };
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.error('경고 텔레그램 발송 실패(무시):', e.message);
  }
}
