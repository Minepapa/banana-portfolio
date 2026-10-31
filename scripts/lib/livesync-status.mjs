// 볼트 동기화(LiveSync) 상태 — livesync-watch 잡이 쓰는 볼트 밖 상태 파일을 아르고스 앱 카드용으로 요약한다
// (2026-11-01 오너 승인 "아르고스 앱에서 동기화 확인"). 수신부 `/status/livesync`가 읽기만 한다.
// 돌려주는 값에 파일 이름·볼트 내용·자격증명은 없다: 시각·횟수·상태 코드와 LiveSync 경고의 분류 문구뿐이다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const LIVESYNC_STATE_FILE = join(homedir(), '.cache', 'banana-portfolio-v2', 'livesync-watch.json');
const DAY_MS = 24 * 60 * 60_000;
// 감시 잡은 15분마다 돈다. 45분 넘게 확인 기록이 없으면 감시 자체가 멈춘 것으로 본다.
export const CHECK_STALE_MS = 45 * 60_000;
export const STATUS_CODES = ['ok', 'stalled', 'tailscale', 'server-error'];

// LiveSync 상태 표시줄 문구에서 경고(⚠️ 뒤)만 뽑는다. URL·이모지를 지우고 120자로 자른다.
// 이 원문은 로그와 볼트 밖 상태 파일에만 둔다. 오너에게 가는 문장(텔레그램·카드)은 describeLiveSyncWarning의
// 분류만 쓴다(리뷰 M4 — 호스트 이름 같은 원문을 내보내지 않는다).
export function parseLiveSyncStatusText(text) {
  if (typeof text !== 'string' || !text.includes('Sync:')) return null;
  const at = text.indexOf('⚠️');
  if (at < 0) return { warning: null };
  const warning = text.slice(at + 2).replace(/[​-‍﻿]/g, '').replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '(주소)').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
  return { warning };
}

// 경고 원문 → 오너에게 보일 분류 문구.
export function describeLiveSyncWarning(warning) {
  if (!warning) return null;
  if (/ERR_NAME_NOT_RESOLVED/.test(warning)) return '서버 이름을 찾지 못함(Tailscale·DNS)';
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(warning)) return '서버 인증 실패';
  if (/ERR_[A-Z_]+|Failed to fetch|Network Error|timed? ?out/i.test(warning)) return '서버 연결 실패';
  return '기타 경고(맥 로그 참고)';
}

// 상태 파일(없거나 깨졌으면 null) → 카드 요약. now는 주입(테스트).
export function summarizeLiveSyncState(state, now = new Date()) {
  if (!state || typeof state !== 'object') return { status: 'unknown', reason: '감시 기록 없음' };
  const nowMs = now.getTime();
  const checkedMs = Date.parse(state.lastCheckAt);
  const restarts = (Array.isArray(state.restarts) ? state.restarts : []).filter((t) => nowMs - Date.parse(t) < DAY_MS);
  const base = {
    checkedAt: Number.isFinite(checkedMs) ? state.lastCheckAt : null,
    serverChangedAt: Number.isFinite(Date.parse(state.seqChangedAt)) ? state.seqChangedAt : null,
    restarts24h: restarts.length,
    lastRestartAt: restarts.at(-1) ?? null, // 쓰는 쪽이 항상 끝에 덧붙인다(시간순)
    tailscale: typeof state.tailscale === 'string' ? state.tailscale : null,
    warning: describeLiveSyncWarning(typeof state.liveSyncWarning === 'string' ? state.liveSyncWarning : null),
  };
  if (!Number.isFinite(checkedMs)) return { status: 'unknown', reason: '감시 기록 없음', ...base };
  if (nowMs - checkedMs > CHECK_STALE_MS) return { status: 'unknown', reason: '감시 잡이 45분 넘게 확인하지 않음', ...base };
  const status = STATUS_CODES.includes(state.status) ? state.status : 'unknown';
  return { status, ...base };
}

export function readLiveSyncSummary({ file = LIVESYNC_STATE_FILE, now = new Date() } = {}) {
  let state = null;
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 없음·깨짐 → unknown */ }
  return summarizeLiveSyncState(state, now);
}
