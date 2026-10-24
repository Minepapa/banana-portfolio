// 아르고스 "폰에서 지우면 맥도 휴지통으로"(결정 `미디어-삭제-요청` 2판, 2026-10-24).
// 폰이 보낸 media.deleted_on_phone / media.restored_on_phone 이벤트(95_Etna/Events)를 읽어,
// 맥이 받은 지 7일 안의 사진·영상만 Media/Trash/{오늘}/로 옮기고 되살린다.
// 불변식:
// - 지우지 않고 옮긴다. 영구 삭제는 media-archive의 30일 휴지통 규칙만 한다.
// - 맥이 아르고스로 받은 기록(.manifest.jsonl, 종류·이름·sha256·크기 일치)이 있고, 받은 시각이 삭제 7일 안일 때만.
//   삭제 시각은 폰 시계와 맥 수신 시각 중 늦은 쪽(애매하면 원본을 남기는 쪽).
// - Archive 보관본은 같은 종류·같은 이름의 레코드일 때만, 그리고 같은 내용의 다른 파일을 받은 적이 없을 때만 옮긴다
//   (같은 바이트의 다른 사본이 폰에 남아 있으면 그 보관본을 지키려고).
// - 이동 전에 휴지통 manifest에 원래 색인 레코드와 경로를 남긴다(media-archive가 그 ID를 다시 보관하지 않는다).
// - 이벤트마다 따로 처리한다. 하나가 실패해도 앞의 결과(색인·상태)는 저장하고, 실패한 이벤트는 다음 회차에 다시 한다.
// - 복원은 대상마다 따로: 자리에 같은 내용이 이미 있으면 복원된 것으로 보고 마무리, 다른 내용과 부딪히면 경보하고 다시 시도.
// - 한 번에 삭제가 MAX_PER_RUN건을 넘으면 삭제는 옮기지 않고 경보한다(복원은 계속). --allow-bulk-trash로 푼다.
// - media-archive와 같은 색인 락 안에서 부른다(호출자 책임).
import { createReadStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join, relative } from 'node:path';
import { writeAtomic } from './state-writer.mjs';

export const FOLLOW_KINDS = new Set(['Camera', 'Screenshots', 'KakaoTalk', 'KakaoTalkMovie']);
export const FOLLOW_WINDOW_MS = 7 * 86_400_000;
export const MAX_PER_RUN = 30;
const LOOKBACK_DAYS = 8;
const STATE_KEEP_MS = 40 * 86_400_000;
/** 이보다 오래 미뤄진 삭제는 실행하지 않는다(STATE_KEEP_MS보다 짧게: 복원 기록이 남아 있는 동안만 따른다). */
const STALE_DELETE_MS = 30 * 86_400_000;
const SHA_RE = /^[0-9a-f]{64}$/;
/** 아르고스 사본은 Syncthing 몫과 섞이지 않게 따로 둔다(argos-media-compare가 Trash/{날짜}/{종류}를 Syncthing으로 센다). */
const ARGOS_TRASH = 'Argos';

const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const rel = (root, path) => relative(root, path).split('\\').join('/');
const itemKey = (kind, name, sha, size) => `${kind}\0${name}\0${sha}\0${Number(size)}`;

async function readJsonl(path) {
  let text;
  try { text = await fs.readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 끊긴 줄은 건너뛴다 */ }
  }
  return rows;
}

async function exists(path) {
  try { await fs.lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** A free name in [directory], also avoiding names already [taken] in this move (rename would overwrite). */
async function uniquePath(directory, filename, taken = new Set()) {
  const ext = extname(filename);
  const stem = basename(filename, ext);
  for (let n = 1; ; n += 1) {
    const target = join(directory, n === 1 ? filename : `${stem} (${n})${ext}`);
    if (taken.has(target)) continue;
    if (!(await exists(target))) { taken.add(target); return target; }
  }
}

/** 덮어쓰지 않는 이동: link가 EEXIST면 실패한다(수신부가 그 사이 같은 자리에 파일을 놓아도 안전). */
async function moveNoOverwrite(from, to) {
  await fs.mkdir(dirname(to), { recursive: true });
  await fs.link(from, to);
  await fs.unlink(from);
}

/** "a.jpg"가 저장 때 "a (2).jpg"가 됐을 수 있다. */
function sameStoredName(storedPath, name) {
  const stored = basename(storedPath ?? '');
  if (stored === name) return true;
  const ext = extname(name);
  return new RegExp(`^${basename(name, ext).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+\\)${ext.replace('.', '\\.')}$`).test(stored);
}

/** 최근 LOOKBACK_DAYS일 이벤트 파일에서 아직 처리하지 않은 삭제·복원·보류 이벤트(발생 순). */
export async function pendingPhoneEvents(eventsDir, nowMs, processed, retry = new Map()) {
  const events = [];
  const recent = new Set();
  for (let d = LOOKBACK_DAYS; d >= 0; d -= 1) recent.add(kstDate(nowMs - d * 86_400_000));
  const dates = new Set([...recent, ...retry.values()]);
  const seen = new Set();
  for (const date of [...dates].sort()) {
    for (const e of await readJsonl(join(eventsDir, date.slice(0, 4), `${date}.jsonl`))) {
      if (seen.has(e?.id)) continue;
      seen.add(e?.id);
      if (!['media.deleted_on_phone', 'media.restored_on_phone', 'media.deletions_held'].includes(e?.type)) continue;
      if (typeof e.id !== 'string' || processed.has(e.id)) continue;
      // 조회 범위 밖 날짜 파일은 다시 시도할 이벤트만 받는다(이미 처리하고 상태에서 지워진 형제 이벤트가 되살아나지 않게).
      if (!recent.has(date) && !retry.has(e.id)) continue;
      events.push({ ...e, fileDate: date });
    }
  }
  return events.sort((a, b) => (a.occurred_at ?? 0) - (b.occurred_at ?? 0));
}

/** 30일 안의 휴지통 manifest에서 같은 ID의 phone-deleted 항목 전부(부분 실패로 갈라진 항목도 함께). */
async function trashEntries(mediaRoot, id, nowMs) {
  const hits = [];
  for (let d = 0; d <= 30; d += 1) {
    const manifestPath = join(mediaRoot, 'Trash', kstDate(nowMs - d * 86_400_000), 'manifest.jsonl');
    let text;
    try { text = await fs.readFile(manifestPath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    text.split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const entry = JSON.parse(line);
        if (entry.reason === 'phone-deleted' && entry.record?.id === id) hits.push({ manifestPath, index, entry });
      } catch { /* 끊긴 줄 */ }
    });
  }
  return hits;
}

/**
 * 한 회차를 적용한다. 반환: { trashed, restored, skipped, failed, blocked, held, conflicts, notes[] }.
 * loadIndex(): Map(id → 색인 레코드)를 읽기 전용으로(이벤트가 있을 때만 부른다).
 * writeIndex(records): 색인 원자적 다시 쓰기.
 */
export async function followPhoneDeletions({
  mediaRoot, eventsDir, statePath, loadIndex, writeIndex, nowMs = Date.now(), dryRun = false,
  argosDest = 'Inbox-Argos', allowBulk = false,
}) {
  const result = { trashed: 0, restored: 0, skipped: 0, failed: 0, blocked: false, held: 0, conflicts: 0, notes: [] };
  // Media가 빠져 있으면 휴지통이 안 보여 복원을 '할 것 없음'으로 소비하게 된다: 아무것도 하지 않고 실패로 알린다.
  for (const dir of [mediaRoot, join(mediaRoot, 'Trash')]) {
    if (!(await fs.stat(dir)).isDirectory()) throw new Error(`미디어 경로가 폴더가 아님: ${dir}`);
  }
  let state = { processed: {} };
  try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') result.notes.push(`상태 파일을 읽지 못해 새로 시작: ${error.message}`); }
  const processed = new Map(Object.entries(state.processed ?? {}));
  // 실패·충돌한 이벤트는 날짜와 무관하게 다시 읽는다(8일 조회 범위를 벗어나도 버리지 않게).
  const retry = new Map(Object.entries(state.retry ?? {}));
  // 같은 사진의 마지막 복원 시각(폰 시계): 그보다 앞선 삭제는 나중에 풀려도 실행하지 않는다.
  const restoredAt = new Map(Object.entries(state.restored ?? {}));
  const events = await pendingPhoneEvents(eventsDir, nowMs, processed, retry);
  for (const e of events) {
    if (e.type !== 'media.restored_on_phone') continue;
    const id = String(e.payload?.sha256 ?? '').toLowerCase().slice(0, 16);
    if (id && (e.occurred_at ?? 0) > (restoredAt.get(id) ?? 0)) restoredAt.set(id, e.occurred_at ?? 0);
  }
  if (!events.length) return result;

  const deletes = events.filter((e) => e.type === 'media.deleted_on_phone').length;
  const bulk = deletes > MAX_PER_RUN && !allowBulk;
  if (bulk) {
    result.blocked = true;
    result.notes.push(`폰 삭제 따라가기 대량 차단: 삭제 ${deletes}건(한도 ${MAX_PER_RUN}). 확인 뒤 --allow-bulk-trash로 푼다`);
  }

  const indexRecords = await loadIndex();
  const argosBase = join(mediaRoot, argosDest);
  const received = new Map();
  const bySha = new Map();
  for (const row of await readJsonl(join(argosBase, '.manifest.jsonl'))) {
    received.set(itemKey(row.kind, row.name, row.sha256, row.size), row);
    bySha.set(row.sha256, (bySha.get(row.sha256) ?? 0) + 1);
  }
  const trashDay = join(mediaRoot, 'Trash', kstDate(nowMs));
  let indexChanged = false;

  try {
    for (const e of events) {
      const done = () => { processed.set(e.id, nowMs); retry.delete(e.id); };
      const again = () => retry.set(e.id, e.fileDate);
      try {
        if (e.type === 'media.deletions_held') { result.held += 1; done(); continue; }
        const p = e.payload ?? {};
        const sha = String(p.sha256 ?? '').toLowerCase();
        if (!FOLLOW_KINDS.has(p.kind) || !SHA_RE.test(sha)) { result.skipped += 1; done(); continue; }
        const id = sha.slice(0, 16);

        if (e.type === 'media.deleted_on_phone') {
          // 이 삭제 뒤에 폰에서 복원했다면(대량 차단·실패로 미뤄진 사이) 실행하지 않는다.
          if ((restoredAt.get(id) ?? 0) > (e.occurred_at ?? 0)) { result.skipped += 1; done(); continue; }
          // 오래 미뤄진 삭제(대량 차단을 한 달 넘게 두는 등)는 따르지 않는다: 그 사이 복원 기록이 정리됐을 수 있다.
          if (nowMs - (e.received_at ?? e.occurred_at ?? nowMs) > STALE_DELETE_MS) {
            result.skipped += 1; result.notes.push(`오래된 삭제는 따르지 않음(원본 유지): ${p.kind}`); done(); continue;
          }
          if (bulk) { again(); continue; } // 처리 완료로 두지 않는다: 풀리면 다음 회차에 한다
          const got = received.get(itemKey(p.kind, p.name, sha, p.size));
          const receivedAt = got ? Date.parse(got.at) : NaN;
          // 늦은 쪽(대개 맥 수신 시각)으로 잰다: 폰 시계가 늦거나 신호가 늦게 와도 7일을 넘기면 원본을 남긴다.
          const deletedAt = Math.max(e.occurred_at ?? nowMs, e.received_at ?? 0);
          if (!got || !Number.isFinite(receivedAt) || deletedAt - receivedAt > FOLLOW_WINDOW_MS) {
            result.skipped += 1; result.notes.push(`보관 유지(7일 지남 또는 받은 기록 없음): ${p.kind}`); done(); continue;
          }
          const record = indexRecords.get(id);
          // 같은 바이트를 다른 이름으로도 받았다면(카톡 두 번 저장, 복사) 보관본은 남은 사본의 것일 수 있다.
          const archiveIsThis = record && record.kind === p.kind && (bySha.get(sha) ?? 0) <= 1
            && sameStoredName(record.inboxPath ?? record.archivePath, p.name);
          const moves = [];
          if (archiveIsThis) moves.push({ from: join(mediaRoot, record.archivePath), field: 'trashPath', dir: join(trashDay, p.kind) });
          if (got.path) moves.push({ from: join(argosBase, got.path), field: 'argosTrashPath', dir: join(trashDay, ARGOS_TRASH, p.kind) });
          const present = [];
          for (const m of moves) {
            if (!(await exists(m.from))) continue;
            // 아르고스 사본 자리에 다른 내용이 들어와 있을 수 있다(" (n)" 복원 뒤 같은 이름의 새 파일): 내용이 같을 때만.
            if (m.field === 'argosTrashPath' && await sha256(m.from) !== sha) { result.notes.push(`아르고스 사본 내용 불일치, 그대로 둠: ${p.kind}`); continue; }
            present.push(m);
          }
          if (!present.length) {
            // 앞 회차가 옮긴 뒤 색인 쓰기 전에 끊겼다면 레코드만 남아 있다: 휴지통 기록이 있으면 정리한다.
            if (archiveIsThis && !dryRun && (await trashEntries(mediaRoot, id, nowMs)).some((h) => h.entry.trashPath)) {
              indexRecords.delete(id); indexChanged = true;
            }
            result.skipped += 1; done(); continue;
          }
          if (dryRun) { result.trashed += 1; continue; }
          const entry = { record: archiveIsThis ? record : { id, kind: p.kind }, reason: 'phone-deleted', event: e.id };
          const taken = new Set();
          for (const m of present) { m.to = await uniquePath(m.dir, basename(m.from), taken); entry[m.field] = rel(mediaRoot, m.to); }
          if (got.path) entry.argosPath = rel(mediaRoot, join(argosBase, got.path));
          await fs.mkdir(trashDay, { recursive: true });
          await fs.appendFile(join(trashDay, 'manifest.jsonl'), `${JSON.stringify(entry)}\n`); // 이동 전에 복구 경로
          for (const m of present) await moveNoOverwrite(m.from, m.to);
          if (archiveIsThis && record.inboxPath && entry.trashPath) {
            try {
              const [a, b] = await Promise.all([fs.stat(join(mediaRoot, record.inboxPath)), fs.stat(join(mediaRoot, entry.trashPath))]);
              if (a.ino === b.ino && a.dev === b.dev) await fs.unlink(join(mediaRoot, record.inboxPath));
            } catch { /* Inbox에 없음 */ }
          }
          if (archiveIsThis) { indexRecords.delete(id); indexChanged = true; }
          result.trashed += 1; done();
        } else {
          const hits = await trashEntries(mediaRoot, id, nowMs);
          if (!hits.length) { result.skipped += 1; done(); continue; }
          if (dryRun) { result.restored += 1; continue; }
          let conflict = false;
          let record = null;
          for (const { entry } of hits) {
            const pairs = [];
            if (entry.trashPath && entry.record?.archivePath) pairs.push([entry.trashPath, entry.record.archivePath, true]);
            if (entry.argosTrashPath && entry.argosPath) pairs.push([entry.argosTrashPath, entry.argosPath, false]);
            for (const [fromRel, toRel, isArchive] of pairs) {
              const from = join(mediaRoot, fromRel);
              const to = join(mediaRoot, toRel);
              if (await exists(to)) {
                // 자리에 같은 내용이 있으면(앞 회차가 이미 되돌렸거나 폰이 다시 보냄) 복원된 것으로 본다.
                if (await sha256(to) === sha) { if (await exists(from)) await fs.unlink(from); }
                else if (!isArchive && await exists(from)) {
                  // 아르고스 사본 자리는 의미가 약하다: 다른 파일이 있으면 " (n)" 이름으로 되돌린다.
                  await moveNoOverwrite(from, await uniquePath(dirname(to), basename(to)));
                } else if (isArchive) { conflict = true; continue; }
              } else if (await exists(from)) {
                await moveNoOverwrite(from, to);
              } else continue;
              if (isArchive) record = entry.record;
            }
          }
          if (record) { indexRecords.set(id, record); indexChanged = true; }
          if (conflict) {
            result.conflicts += 1;
            result.notes.push(`복원 충돌(원래 자리에 다른 내용): ${p.kind} — 휴지통에 그대로 두고 다음 회차에 다시 본다`);
            again(); continue; // manifest를 지우지 않고 처리 완료로 두지 않는다
          }
          // 복원한 항목을 manifest에서 뺀다(원자적으로 다시 쓴다).
          const byFile = new Map();
          for (const h of hits) byFile.set(h.manifestPath, [...(byFile.get(h.manifestPath) ?? []), h.index]);
          for (const [manifestPath, indexes] of byFile) {
            const lines = (await fs.readFile(manifestPath, 'utf8')).split('\n');
            const kept = lines.filter((line, i) => line.trim() && !indexes.includes(i));
            writeAtomic(manifestPath, kept.length ? `${kept.join('\n')}\n` : '');
          }
          result.restored += 1; done();
        }
      } catch (error) {
        again();
        result.failed += 1;
        result.notes.push(`폰 삭제 따라가기 이벤트 실패(다음 회차에 다시): ${error.code ?? error.message}`);
      }
    }
  } finally {
    if (!dryRun) {
      if (indexChanged) await writeIndex(indexRecords);
      for (const [k, at] of processed) if (nowMs - at > STATE_KEEP_MS) processed.delete(k);
      for (const [k, at] of restoredAt) if (nowMs - at > STATE_KEEP_MS) restoredAt.delete(k);
      await fs.mkdir(dirname(statePath), { recursive: true });
      writeAtomic(statePath, `${JSON.stringify({ processed: Object.fromEntries(processed),
        retry: Object.fromEntries(retry), restored: Object.fromEntries(restoredAt) }, null, 1)}\n`);
    }
  }
  return result;
}
