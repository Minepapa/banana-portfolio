// 아르고스(폰 수집 앱) 수신 1단계 — 병행 기간에는 원본 보관만 한다(결정 `아르고스-올림푸스-도입`, 2026-10-23).
// owntracks-receiver(:8088)에 POST /ingest·GET /rules/*를 붙인다. 장부·위치·소비 파일에는 쓰지 않는다:
// 투자·소비 알림은 전환 전까지 카카오 알림 앱 → Firestore → 기존 잡이 계속 정본이다.
// 인계 패치(mac-patches/argos-ingest.mjs)는 참고만 했다 — 소비 ts 형식·투자 알림 경로·권한 관례가 우리와 달랐다.
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, readSync, realpathSync, writeSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { VAULT_PATHS, VAULT_REL } from './vault-paths.mjs';

export const ARGOS_CONFIG_PATH = process.env.ARGOS_CONFIG_PATH
  || join(homedir(), '.config', 'banana-portfolio-v2', 'argos.json');
export const MAX_INGEST_BODY = 1024 * 1024;
const MAX_EVENTS = 500;
// 이벤트 한 건 상한. 넘는 건은 배치 전체가 아니라 그 건만 거부한다(폰 outbox가 막히지 않게).
const MAX_EVENT_BYTES = 256 * 1024;
// 날짜 파일별 hash 캐시 개수. 폰 hash에는 occurred_at이 들어가므로 같은 hash는 늘 같은 날짜 파일에만 있다.
const SEEN_CACHE_FILES = 30;
const HASH_RE = /^[0-9a-f]{64}$/;
const TYPE_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const RULE_NAME_RE = /^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.yaml$/;
// 시계가 의심스러운 이벤트(폰 재부팅 직후 NTP 전, 맥 시계 이상)도 원본은 버리지 않는다.
// 거부하면 폰이 영구 격리하므로, 표시만 붙여 보관하고 ack한다(2026-10-23 리뷰).
const SUSPECT_PAST_MS = 400 * 86_400_000;
const SUSPECT_FUTURE_MS = 86_400_000;
const kstDate = (ms) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
const VALID_MS_MIN = Date.parse('2000-01-01T00:00:00Z');
const VALID_MS_MAX = Date.parse('2100-01-01T00:00:00Z');

/** 토큰 설정. 파일이 없으면 null(기능 꺼짐). 권한·소유자·링크는 owntracks 설정과 같은 기준. */
export function readArgosConfig(path = ARGOS_CONFIG_PATH) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('아르고스 설정 파일 소유자 또는 링크 오류');
  if (stat.mode & 0o077) throw new Error('아르고스 설정 파일 권한은 600이어야 합니다');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof config.token !== 'string' || config.token.length < 24) throw new Error('아르고스 토큰 값 오류');
  return config;
}

export const tokenMatches = (actual, expected) =>
  timingSafeEqual(createHash('sha256').update(String(actual ?? '')).digest(), createHash('sha256').update(expected).digest());

function validEvent(event) {
  if (!event || typeof event !== 'object') return 'malformed_event';
  if (typeof event.hash !== 'string' || !HASH_RE.test(event.hash)) return 'bad_hash';
  if (typeof event.id !== 'string' || !event.id || event.id.length > 64) return 'bad_id';
  if (typeof event.type !== 'string' || !TYPE_RE.test(event.type)) return 'bad_type';
  if (typeof event.source !== 'string' || !event.source || event.source.length > 64) return 'bad_source';
  // 날짜 파일을 정할 수 없을 만큼 망가진 시각만 거부한다. 그 밖의 이상한 시각은 표시만 붙여 보관.
  if (!Number.isSafeInteger(event.occurred_at) || event.occurred_at < VALID_MS_MIN || event.occurred_at > VALID_MS_MAX) {
    return 'bad_occurred_at';
  }
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return 'bad_payload';
  return null;
}

/** 파일 끝 1바이트가 줄바꿈인지(이전 기록이 잘렸으면 다음 줄이 붙지 않게 막는다). */
function endsWithNewline(fd, size) {
  if (size === 0) return true;
  const buffer = Buffer.alloc(1);
  readSync(fd, buffer, 0, 1, size - 1);
  return buffer[0] === 0x0a;
}

/** append + fsync. 일부만 써지거나 실패하면 원래 크기로 되돌리고 던진다(ack한 줄이 잘리지 않게). */
function appendDurably(file, text) {
  const dir = dirname(file);
  const created = !existsSync(file);
  mkdirSync(dir, { recursive: true });
  const fd = openSync(file, 'a+', 0o600);
  let size = 0;
  try {
    size = fstatSync(fd).size;
    const data = Buffer.from(endsWithNewline(fd, size) ? text : `\n${text}`);
    const written = writeSync(fd, data, 0, data.length);
    if (written !== data.length) throw new Error('short_write');
    fsyncSync(fd);
  } catch (error) {
    try { ftruncateSync(fd, size); fsyncSync(fd); } catch { /* 되돌리기도 실패하면 다음 기록의 줄바꿈 방어에 맡긴다 */ }
    throw error;
  } finally {
    closeSync(fd);
  }
  if (created) {
    // 새 파일의 디렉터리 항목도 디스크에 남긴다(전원 차단 때 ack한 파일이 사라지지 않게).
    const dirFd = openSync(dir, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }
}

/**
 * 수신 처리기. 파일 쓰기만 하고 HTTP는 모른다(수신 서버가 감싼다).
 * - write-then-ack: 날짜 파일에 append + fsync가 끝난 이벤트만 acked에 넣는다.
 * - 중복: 폰이 보낸 hash가 키. 이미 보관한 hash는 다시 쓰지 않고 ack한다(재전송 멱등).
 *   확인은 그 이벤트의 날짜 파일만 읽어서 한다(최근 파일 몇 개만 캐시 — 보관량과 무관한 비용).
 */
export function createArgosIngest({ root = VAULT_PATHS.root, now = () => new Date() } = {}) {
  const eventsDir = join(root, VAULT_REL.argosEvents);
  const rulesDir = join(root, VAULT_REL.argosRules);
  const seenByFile = new Map(); // 날짜 파일 → hash Set (삽입 순서 = LRU)

  const fileFor = (occurredAt) => {
    const date = kstDate(occurredAt);
    return join(eventsDir, date.slice(0, 4), `${date}.jsonl`);
  };

  const seenIn = (file) => {
    if (seenByFile.has(file)) {
      const set = seenByFile.get(file);
      seenByFile.delete(file);
      seenByFile.set(file, set);
      return set;
    }
    const set = new Set();
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try { set.add(JSON.parse(line).hash); } catch { /* 깨진 줄은 건너뛴다 */ }
      }
    }
    seenByFile.set(file, set);
    while (seenByFile.size > SEEN_CACHE_FILES) seenByFile.delete(seenByFile.keys().next().value);
    return set;
  };

  function ingest(body) {
    if (!body || typeof body !== 'object' || body.protocol !== 1 || !Array.isArray(body.events)) {
      return { status: 400, json: { error: 'bad_request' } };
    }
    if (body.events.length > MAX_EVENTS) return { status: 413, json: { error: 'too_many_events' } };
    const device = typeof body.device === 'string' ? body.device.slice(0, 64) : null;
    const nowMs = now().getTime();
    const acked = new Set();
    const rejected = [];
    const pending = new Map(); // 날짜 파일 → [{hash, line}]
    const batchHashes = new Set();
    try {
      for (const event of body.events) {
        const reason = validEvent(event);
        if (reason) { rejected.push({ hash: typeof event?.hash === 'string' ? event.hash.slice(0, 64) : '?', reason }); continue; }
        const file = fileFor(event.occurred_at);
        if (batchHashes.has(event.hash) || seenIn(file).has(event.hash)) { acked.add(event.hash); continue; }
        const record = {
          received_at: nowMs, device, id: event.id, hash: event.hash, type: event.type,
          occurred_at: event.occurred_at, source: event.source, payload: event.payload,
        };
        if (event.occurred_at < nowMs - SUSPECT_PAST_MS || event.occurred_at > nowMs + SUSPECT_FUTURE_MS) {
          record.clock_suspect = true;
        }
        const line = `${JSON.stringify(record)}\n`;
        if (Buffer.byteLength(line) > MAX_EVENT_BYTES) { rejected.push({ hash: event.hash, reason: 'too_large' }); continue; }
        batchHashes.add(event.hash);
        if (!pending.has(file)) pending.set(file, []);
        pending.get(file).push({ hash: event.hash, line });
      }
    } catch {
      return { status: 500, json: { error: 'archive_unreadable' } };
    }
    // 파일 단위로 기록하고, 기록이 끝난 파일의 이벤트만 ack한다. 실패한 파일은 캐시를 버리고 폰이 다시 보낸다.
    let failed = false;
    for (const [file, items] of pending) {
      try {
        appendDurably(file, items.map((item) => item.line).join(''));
        const set = seenIn(file);
        for (const item of items) { set.add(item.hash); acked.add(item.hash); }
      } catch {
        seenByFile.delete(file);
        failed = true;
      }
    }
    if (failed && acked.size === 0 && rejected.length === 0) return { status: 500, json: { error: 'write_failed' } };
    return { status: 200, json: { acked: [...acked], rejected } };
  }

  /** 규칙 파일. text 대신 원본 바이트(buffer)를 돌려준다 — manifest hash와 같은 바이트여야 한다. */
  function rules(pathname) {
    if (pathname === '/rules/manifest') {
      const files = [];
      const walk = (dir, prefix) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(join(dir, entry.name), rel);
          else if (entry.isFile() && RULE_NAME_RE.test(rel)) {
            const content = readFileSync(join(dir, entry.name));
            files.push({ name: rel, sha256: createHash('sha256').update(content).digest('hex') });
          }
        }
      };
      walk(rulesDir, '');
      return { status: 200, json: files };
    }
    let name;
    try { name = decodeURIComponent(pathname.slice('/rules/'.length)); }
    catch { return { status: 400, json: { error: 'bad_name' } }; }
    if (!RULE_NAME_RE.test(name)) return { status: 400, json: { error: 'bad_name' } };
    const file = join(rulesDir, name);
    try {
      // 중간 폴더가 링크여도 규칙 폴더 밖으로 나가지 않게, 실제 경로로 확인한다.
      const real = realpathSync(file);
      if (!real.startsWith(realpathSync(rulesDir) + sep) || !lstatSync(real).isFile()) {
        return { status: 404, json: { error: 'not_found' } };
      }
      return { status: 200, buffer: readFileSync(real) };
    } catch {
      return { status: 404, json: { error: 'not_found' } };
    }
  }

  return { ingest, rules };
}
