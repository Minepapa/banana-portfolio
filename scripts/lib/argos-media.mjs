// 아르고스 미디어 수신(결정 `아르고스-올림푸스-도입` 8항, 2026-10-24) — Syncthing 대체.
// 폰이 사진·영상·통화·녹음을 이어받기 가능한 조각으로 올린다:
//   GET /media/status?kind&name&size&sha256[&mtime]          → {state: absent|partial|complete, received}
//   PUT /media/upload?kind&name&size&sha256&offset[&mtime]   (본문 = offset부터의 바이트)
// 병행 기간에는 Media/Inbox-Argos에만 둔다. 기존 미디어 잡은 Syncthing의 Media/Inbox만 읽으므로
// 이 모듈은 미네 기록 파이프라인에 아무 영향을 주지 않는다. 전환 때 dest만 'Inbox'로 바꾼다.
// 불변식:
// - 원본 바이트는 sha256이 맞을 때만 최종 위치에 생긴다. 기존 파일은 절대 덮어쓰지 않는다(link로 생성).
// - 같은 종류·같은 이름·같은 바이트는 한 번만 보관한다. 종류나 이름이 다르면 각각 둔다(Syncthing과 같게).
// - 폰이 보낸 원래 수정 시각(mtime)을 파일에 그대로 둔다: media-archive가 EXIF 없는 파일의 날짜를 mtime으로 정한다.
// 폰 쪽 원본은 지우지 않는다(폰 앱도 지우지 않는다).
import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, createReadStream, existsSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, utimesSync, writeSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { homedir } from 'node:os';

export const MEDIA_KINDS = Object.freeze(['Camera', 'Recordings', 'Calls', 'Screenshots', 'KakaoTalk', 'KakaoTalkMovie']);
/** 요청 한 번의 상한. 폰은 Wi-Fi 1MB·셀룰러 256KB 조각을 보낸다(수신부 요청 시간 15초 안에 끝나게). */
export const MAX_MEDIA_CHUNK = 4 * 1024 * 1024;
const MAX_MEDIA_FILE = 8 * 1024 ** 3;
const SHA_RE = /^[0-9a-f]{64}$/;
const DEFAULT_ROOT = join(homedir(), 'Pantheon', 'Media');
/** 폰에서 지우거나 고쳐서 끝나지 못한 조각은 이만큼 지나면 버린다(폰은 새 sha로 처음부터 보낸다). */
const PART_TTL_MS = 7 * 86_400_000;
const MTIME_MIN = Date.parse('2000-01-01T00:00:00Z');

/** 파일 이름은 폰 원본 이름 그대로 쓴다(기존 잡이 통화 상대·날짜를 이름에서 읽는다). 경로 조각만 막는다. */
function validName(name) {
  if (typeof name !== 'string') return null;
  const n = name.normalize('NFC');
  if (!n || n !== basename(n) || n.startsWith('.') || /[\\/\0]/.test(n)) return null;
  if (Buffer.byteLength(n) > 240) return null;
  return n;
}

function parseQuery(query, { needOffset, nowMs }) {
  const kind = query.get('kind');
  const name = validName(query.get('name'));
  const size = Number(query.get('size'));
  const sha256 = query.get('sha256');
  const offset = needOffset ? Number(query.get('offset')) : 0;
  const rawMtime = query.get('mtime');
  const mtime = rawMtime == null ? null : Number(rawMtime);
  if (!MEDIA_KINDS.includes(kind)) return { error: 'bad_kind' };
  if (!name) return { error: 'bad_name' };
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_MEDIA_FILE) return { error: 'bad_size' };
  if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) return { error: 'bad_sha256' };
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) return { error: 'bad_offset' };
  // 시각이 이상하면(카메라 시계 고장, 미래) 파일은 받고 시각만 버린다: 날짜 하나 때문에 원본을 잃지 않는다.
  // 미래 하루까지는 폰 시계 차이로 받아 준다.
  const goodMtime = mtime != null && Number.isSafeInteger(mtime) && mtime >= MTIME_MIN && mtime <= nowMs + 86_400_000;
  return { kind, name, size, sha256, offset, mtime: goodMtime ? mtime : null };
}

async function sha256Of(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function fsyncDir(dir) {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** 이전 실행이 줄 중간에 끊겼으면 다음 줄이 붙지 않게 개행부터 넣는다. */
function appendLine(path, line) {
  let needsNewline = false;
  try {
    const st = statSync(path);
    if (st.size > 0) {
      const fd = openSync(path, 'r');
      try {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, st.size - 1);
        needsNewline = last[0] !== 0x0a;
      } finally { closeSync(fd); }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  appendFileSync(path, `${needsNewline ? '\n' : ''}${line}\n`, { mode: 0o600 });
}

export function createArgosMedia({ root = DEFAULT_ROOT, dest = 'Inbox-Argos', now = () => new Date() } = {}) {
  const base = join(root, dest);
  const partsDir = join(base, '.parts');
  const manifestPath = join(base, '.manifest.jsonl');
  const itemKey = (q) => `${q.kind}\0${q.name}\0${q.sha256}\0${q.size}`;
  // 종류·이름·바이트가 같으면 완료. 이름이 겹쳐 " (2)"로 저장됐어도 그 경로로 완료를 답한다.
  const stored = new Map();
  if (existsSync(manifestPath)) {
    for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        stored.set(itemKey(row), row.path);
      } catch { /* 깨진 줄은 건너뛴다: 다음 업로드가 다시 채운다 */ }
    }
  }
  const busy = new Set();
  const partPath = (q) => join(partsDir, `${q.sha256}-${q.size}.part`);
  let lastPrune = 0;

  function pruneParts() {
    const nowMs = now().getTime();
    if (nowMs - lastPrune < 86_400_000) return;
    lastPrune = nowMs;
    let names;
    try { names = readdirSync(partsDir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of names) {
      const full = join(partsDir, name);
      try {
        if (nowMs - lstatSync(full).mtimeMs > PART_TTL_MS && !busy.has(name)) unlinkSync(full);
      } catch { /* 동시에 끝난 조각: 무시 */ }
    }
  }
  pruneParts();

  function completedPath(q) {
    const rel = stored.get(itemKey(q));
    if (!rel) return null;
    try { return statSync(join(base, rel)).size === q.size ? rel : null; } catch { return null; }
  }

  function received(q) {
    try { return Math.min(lstatSync(partPath(q)).size, q.size); } catch { return 0; }
  }

  /** A part that holds every byte but was never placed (crash between link and unlink, a failed
   *  link) is finished here instead of leaving the phone with nothing left to send. */
  async function recoverComplete(q) {
    const key = `${q.sha256}-${q.size}.part`;
    if (busy.has(key)) return null;
    busy.add(key);
    try { return await finish(q); } finally { busy.delete(key); }
  }

  async function status(query) {
    const q = parseQuery(query, { needOffset: false, nowMs: now().getTime() });
    if (q.error) return { status: 400, json: { error: q.error } };
    if (completedPath(q)) return { status: 200, json: { state: 'complete', received: q.size } };
    const got = received(q);
    if (got === q.size) {
      const done = await recoverComplete(q);
      if (done) return done;
    }
    return { status: 200, json: { state: got > 0 ? 'partial' : 'absent', received: got } };
  }

  /**
   * 덮어쓰지 않는 생성: link는 대상이 있으면 EEXIST로 실패한다(rename은 조용히 덮어쓴다).
   * 같은 이름에 같은 바이트가 이미 있으면 그 파일을 쓴다. 다른 바이트면 "이름 (2).확장자".
   */
  async function placeWithoutOverwrite(part, kindDir, q) {
    const ext = extname(q.name);
    const stem = q.name.slice(0, q.name.length - ext.length);
    for (let n = 1; n < 1000; n += 1) {
      const candidate = n === 1 ? q.name : `${stem} (${n})${ext}`;
      const full = join(kindDir, candidate);
      try {
        linkSync(part, full);
        return candidate;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (statSync(full).size === q.size && await sha256Of(full) === q.sha256) return candidate;
      }
    }
    throw new Error('이름 충돌이 너무 많음');
  }

  async function finish(q) {
    const part = partPath(q);
    if (await sha256Of(part) !== q.sha256) {
      unlinkSync(part);
      return { status: 422, json: { state: 'absent', received: 0, error: 'hash_mismatch' } };
    }
    if (q.mtime != null) utimesSync(part, new Date(q.mtime), new Date(q.mtime));
    const kindDir = join(base, q.kind);
    mkdirSync(kindDir, { recursive: true, mode: 0o700 });
    const candidate = await placeWithoutOverwrite(part, kindDir, q);
    unlinkSync(part);
    fsyncDir(kindDir);
    const rel = join(q.kind, candidate);
    appendLine(manifestPath, JSON.stringify({
      kind: q.kind, name: q.name, path: rel, size: q.size, sha256: q.sha256, mtime: q.mtime, at: now().toISOString(),
    }));
    stored.set(itemKey(q), rel);
    pruneParts();
    return { status: 200, json: { state: 'complete', received: q.size, stored: rel } };
  }

  /**
   * body: async iterable of Buffer (the request). contentLength: header value.
   * The part file only ever grows by whole verified appends: a short or failed write is truncated back.
   */
  async function upload(query, body, contentLength) {
    const q = parseQuery(query, { needOffset: true, nowMs: now().getTime() });
    if (q.error) return { status: 400, json: { error: q.error } };
    if (completedPath(q)) return { status: 200, json: { state: 'complete', received: q.size } };
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length <= 0) return { status: 411, json: { error: 'length_required' } };
    if (length > MAX_MEDIA_CHUNK) return { status: 413, json: { error: 'chunk_too_large' } };
    if (q.offset + length > q.size) return { status: 400, json: { error: 'past_end' } };
    const key = `${q.sha256}-${q.size}.part`;
    if (busy.has(key)) return { status: 409, json: { state: 'partial', received: received(q), error: 'busy' } };
    busy.add(key);
    try {
      const have = received(q);
      if (q.offset !== have) return { status: 409, json: { state: have ? 'partial' : 'absent', received: have } };
      mkdirSync(partsDir, { recursive: true, mode: 0o700 });
      const fd = openSync(partPath(q), 'a', 0o600);
      let written = 0;
      try {
        for await (const chunk of body) {
          if (written + chunk.length > length) throw Object.assign(new Error('본문이 Content-Length보다 김'), { code: 'BODY_OVERFLOW' });
          let off = 0;
          while (off < chunk.length) off += writeSync(fd, chunk, off, chunk.length - off);
          written += chunk.length;
        }
        if (written !== length) throw Object.assign(new Error('본문이 짧음'), { code: 'BODY_SHORT' });
        fsyncSync(fd);
      } catch (error) {
        ftruncateSync(fd, have);
        fsyncSync(fd);
        // 끊긴 본문은 다시 보내면 되는 일이다: 409로 받은 만큼을 알려 준다(400이면 폰이 영구 보류한다).
        if (error.code === 'BODY_OVERFLOW' || error.code === 'BODY_SHORT') {
          return { status: 409, json: { state: have ? 'partial' : 'absent', received: have, error: error.code.toLowerCase() } };
        }
        throw error;
      } finally {
        if (fstatSync(fd).size === 0) { closeSync(fd); try { unlinkSync(partPath(q)); } catch { /* 없음 */ } }
        else closeSync(fd);
      }
      const total = have + written;
      if (total < q.size) return { status: 200, json: { state: 'partial', received: total } };
      return await finish(q);
    } finally {
      busy.delete(key);
    }
  }

  return { status, upload, base };
}
