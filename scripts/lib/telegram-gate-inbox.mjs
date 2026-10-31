// 텔레그램 관문 수신 대기열 — 받은 업데이트를 잃지도, 두 번 처리하지도 않게 하는 저장소(2026-10-30, 관문 1단계).
//
// 순서 불변식(설계 9-2):
//   1) getUpdates로 받은 업데이트를 inbox.jsonl에 append하고 fsync한다.
//   2) 그다음에만 offset.json(마지막 update_id + 1)을 원자적으로 기록한다.
//   3) 다음 getUpdates에 그 offset을 넘긴다 — 이때 Telegram 서버가 이전 업데이트를 지운다.
//   1과 2 사이에서 죽으면 같은 업데이트가 다시 오는데, update_id로 걸러 한 번만 저장한다.
//
// 처리 상태는 같은 파일에 상태 줄을 덧붙여 남긴다(기존 줄을 고치지 않아 부분 쓰기로 깨질 일이 적다).
// - 받음(업데이트 줄 자체) → 처리중 → 완료 | 실패 | 버림 | 확인필요
// - 재시작 때 "처리중"으로 남은 건은 다시 실행하지 않고 "확인필요"로 돌린다. 기록·스위치 같은 부수 효과가 두 번
//   일어나는 것보다 오너에게 "끊겼으니 다시 보내 달라"고 알리는 쪽이 안전하다(at-most-once).
// 마지막 줄이 쓰다 만 상태(전원 차단 등)로 남아 JSON이 아니면 그 줄만 건너뛴다.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const TERMINAL_STATUSES = new Set(['완료', '실패', '버림', '확인필요']);
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function fsyncDir(dir) {
  // 디렉터리 fsync는 rename을 디스크에 고정한다. 지원하지 않는 파일시스템이면 조용히 넘어간다.
  let fd;
  try { fd = openSync(dir, 'r'); fsyncSync(fd); } catch { /* noop */ } finally { if (fd !== undefined) closeSync(fd); }
}

function appendDurable(path, text) {
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeDurable(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function parseInboxLines(raw) {
  const records = [];
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* 쓰다 만 마지막 줄 */ }
  }
  return records;
}

// 순수 함수: 줄 목록 → update_id별 { update, receivedAt, status, detail, statusAt }.
export function foldInbox(records) {
  const items = new Map();
  for (const r of records) {
    if (r?.type === 'update' && Number.isInteger(r.updateId) && !items.has(r.updateId)) {
      items.set(r.updateId, { updateId: r.updateId, update: r.update, receivedAt: r.receivedAt, status: '받음', detail: '', statusAt: r.receivedAt });
    } else if (r?.type === 'status' && items.has(r.updateId)) {
      Object.assign(items.get(r.updateId), { status: r.status, detail: r.detail ?? '', statusAt: r.at });
    }
  }
  return items;
}

export function createGateInbox({ dir, now = () => new Date() }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const inboxPath = join(dir, 'inbox.jsonl');
  const offsetPath = join(dir, 'offset.json');
  let items = foldInbox(existsSync(inboxPath) ? parseInboxLines(readFileSync(inboxPath, 'utf8')) : []);

  function appendRecords(records) {
    if (!records.length) return;
    appendDurable(inboxPath, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  }

  return {
    paths: { inboxPath, offsetPath },

    readOffset() {
      if (!existsSync(offsetPath)) return null;
      try {
        const value = JSON.parse(readFileSync(offsetPath, 'utf8')).offset;
        return Number.isInteger(value) ? value : null;
      } catch {
        return null;
      }
    },

    // 새 업데이트만 저장(fsync)하고 돌려준다. 이미 있는 update_id는 버린다.
    appendUpdates(updates) {
      const at = now().toISOString();
      const fresh = [];
      for (const update of updates ?? []) {
        const id = update?.update_id;
        if (!Number.isInteger(id) || items.has(id) || fresh.some((u) => u.update_id === id)) continue;
        fresh.push(update);
      }
      appendRecords(fresh.map((update) => ({ type: 'update', updateId: update.update_id, receivedAt: at, update })));
      for (const update of fresh) {
        items.set(update.update_id, { updateId: update.update_id, update, receivedAt: at, status: '받음', detail: '', statusAt: at });
      }
      return fresh;
    },

    // appendUpdates가 끝난 뒤에만 부른다(순서 불변식 2). 뒤로 가는 offset은 무시한다.
    commitOffset(nextOffset) {
      if (!Number.isInteger(nextOffset)) throw new Error('offset은 정수여야 합니다');
      const current = this.readOffset();
      if (current !== null && nextOffset <= current) return current;
      writeDurable(offsetPath, `${JSON.stringify({ offset: nextOffset, at: now().toISOString() })}\n`);
      fsyncDir(dir);
      return nextOffset;
    },

    markStatus(updateId, status, detail = '') {
      const item = items.get(updateId);
      if (!item) throw new Error(`대기열에 없는 update_id: ${updateId}`);
      const at = now().toISOString();
      appendRecords([{ type: 'status', updateId, status, detail: String(detail).slice(0, 300), at }]);
      Object.assign(item, { status, detail: String(detail).slice(0, 300), statusAt: at });
    },

    get(updateId) { return items.get(updateId) ?? null; },

    // 지금 처리 중인 것(처리중), update_id 순.
    inFlight() {
      return [...items.values()].filter((i) => i.status === '처리중').sort((a, b) => a.updateId - b.updateId);
    },

    // 아직 처리하지 않은 것(받음), update_id 순.
    pending() {
      return [...items.values()].filter((i) => i.status === '받음').sort((a, b) => a.updateId - b.updateId);
    },

    // 재시작 직후 한 번: 처리중으로 끊긴 건을 확인필요로 돌리고 돌려준다.
    recoverInterrupted() {
      const interrupted = [...items.values()].filter((i) => i.status === '처리중');
      for (const item of interrupted) this.markStatus(item.updateId, '확인필요', '처리 중 창구가 멈춤 — 다시 실행하지 않음');
      return interrupted;
    },

    counts() {
      const out = {};
      for (const item of items.values()) out[item.status] = (out[item.status] ?? 0) + 1;
      return out;
    },

    // 끝난 지 7일 넘은 건을 지운 새 파일로 바꾼다(시작 때 한 번). 끝나지 않은 건은 나이와 상관없이 남긴다.
    compact() {
      const cutoff = now().getTime() - RETENTION_MS;
      const keep = [...items.values()].filter((i) => !TERMINAL_STATUSES.has(i.status) || Date.parse(i.statusAt) >= cutoff);
      if (keep.length === items.size) return 0;
      const lines = [];
      for (const i of keep.sort((a, b) => a.updateId - b.updateId)) {
        lines.push(JSON.stringify({ type: 'update', updateId: i.updateId, receivedAt: i.receivedAt, update: i.update }));
        if (i.status !== '받음') lines.push(JSON.stringify({ type: 'status', updateId: i.updateId, status: i.status, detail: i.detail, at: i.statusAt }));
      }
      writeDurable(inboxPath, lines.map((l) => `${l}\n`).join(''));
      fsyncDir(dir);
      const removed = items.size - keep.length;
      items = new Map(keep.map((i) => [i.updateId, i]));
      return removed;
    },
  };
}
