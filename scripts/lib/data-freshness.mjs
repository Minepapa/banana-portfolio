// 데이터 출처 신선도 판정(2026-11-03, 데이터 체계 개선 ④). 표는 data-sources.mjs, 호출은 health-watcher.
// 판정(findStaleSources)은 순수 함수다 — 파일 읽기는 readers로 주입한다. 실제 볼트 읽기는 createVaultReaders.
// ⚠️ 이 모듈은 vault-paths를 import하지 않는다(테스트가 정적 import해도 실제 볼트 경로를 잡지 않게, 10-31 사고).
// 경로는 호출부가 VAULT_REL과 볼트 루트를 넘긴다.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_EVENT_LOOKBACK_DAYS = 7;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
export const FRESHNESS_SCHEMA_VERSION = 1;

export function kstDateOf(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(ms));
}

export function kstDayStartMs(label) {
  return Date.parse(`${label}T00:00:00+09:00`);
}

export function addDays(label, days) {
  return new Date(Date.parse(`${label}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(label) {
  return new Date(Date.parse(`${label}T00:00:00Z`)).getUTCDay(); // 0=일 6=토
}

// 휴장일 캐시가 없으면(null) 주말만 쉬는 날로 본다 — 평일 휴장일엔 오탐이 날 수 있다(남은 위험으로 보고).
function isTradingDayOr(label, isTradingDay) {
  const cached = isTradingDay ? isTradingDay(label) : null;
  if (cached === true || cached === false) return cached;
  const weekday = weekdayOf(label);
  return weekday !== 0 && weekday !== 6;
}

// "YYYY-MM-DD HH:mm:ss"(KST 표기)·ISO 문자열·ms 숫자를 ms로. 못 읽으면 null.
export function parseTimeValue(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const kstLocal = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(text);
  const ms = kstLocal ? Date.parse(`${kstLocal[1]}T${kstLocal[2]}+09:00`) : Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

// 머리말에서 한 칸만 읽는다(따옴표 문자열·true/false). 중첩 구조는 다루지 않는다.
export function readFrontmatterField(text, field) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text ?? '');
  if (!match) return null;
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0 || line.slice(0, idx).trim() !== field) continue;
    const raw = line.slice(idx + 1).trim();
    if (raw.startsWith('"')) {
      try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
    }
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null' || raw === '') return null;
    return raw;
  }
  return null;
}

function datedFileNames(readers, probe) {
  const names = [];
  if (probe.layout === 'year') {
    for (const year of readers.listDir(probe.pathKey) ?? []) {
      if (!/^\d{4}$/.test(year)) continue;
      for (const name of readers.listDir(probe.pathKey, year) ?? []) names.push({ name, sub: [year, name] });
    }
  } else {
    for (const name of readers.listDir(probe.pathKey) ?? []) names.push({ name, sub: [name] });
  }
  return names.filter(({ name }) => DATE_RE.test(name) && (!probe.ext || name.endsWith(probe.ext)));
}

// 아르고스 날짜 파일은 한 번만 읽어 같은 실행 안의 여러 출처가 나눠 쓴다(memo).
function readEventDay(readers, memo, pathKey, label) {
  const key = `${pathKey}|${label}`;
  if (memo.has(key)) return memo.get(key);
  const text = readers.readText(pathKey, label.slice(0, 4), `${label}.jsonl`);
  const events = [];
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      events.push({ type: event.type, kind: event.payload?.kind ?? null, receivedAt: parseTimeValue(event.received_at) });
    } catch { /* 깨진 줄은 건너뛴다(수신 쪽 줄바꿈 방어와 같은 원칙) */ }
  }
  memo.set(key, events);
  return events;
}

// 관측값: { lastAt(ms|null), dayCounts?(날짜 → 건수), dates?(있는 날짜 Set) }
function observe(source, { now, readers, memo }) {
  const { probe } = source;
  const today = kstDateOf(now);
  switch (probe.type) {
    case 'events-type': {
      const lookback = probe.lookbackDays ?? DEFAULT_EVENT_LOOKBACK_DAYS;
      let lastAt = null;
      const dayCounts = {};
      for (let i = 0; i <= lookback; i += 1) {
        const label = addDays(today, -i);
        let count = 0;
        for (const event of readEventDay(readers, memo, probe.pathKey, label)) {
          if (event.type !== probe.eventType) continue;
          if (probe.payloadKind && event.kind !== probe.payloadKind) continue;
          count += 1;
          if (event.receivedAt !== null && (lastAt === null || event.receivedAt > lastAt)) lastAt = event.receivedAt;
        }
        dayCounts[label] = count;
      }
      return { lastAt, dayCounts };
    }
    case 'dated-jsonl': {
      const lookback = probe.lookbackDays ?? DEFAULT_EVENT_LOOKBACK_DAYS;
      let lastAt = null;
      const dayCounts = {};
      for (let i = 0; i <= lookback; i += 1) {
        const label = addDays(today, -i);
        const text = probe.layout === 'year'
          ? readers.readText(probe.pathKey, label.slice(0, 4), `${label}.jsonl`)
          : readers.readText(probe.pathKey, `${label}.jsonl`);
        let count = 0;
        for (const line of (text ?? '').split('\n')) {
          if (!line.trim()) continue;
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          count += 1;
          const at = probe.timeField ? parseTimeValue(row[probe.timeField]) : null;
          if (at !== null && (lastAt === null || at > lastAt)) lastAt = at;
        }
        dayCounts[label] = count;
        if (count && lastAt === null) lastAt = kstDayStartMs(label);
      }
      return { lastAt, dayCounts };
    }
    case 'dated-files': {
      const dates = new Set(datedFileNames(readers, probe).map(({ name }) => DATE_RE.exec(name)[1]));
      const latest = [...dates].sort().pop();
      return { lastAt: latest ? kstDayStartMs(latest) : null, dates };
    }
    case 'frontmatter-field': {
      const names = readers.listDir(probe.pathKey);
      const files = names === null ? [[]] : names.filter((name) => name.endsWith('.md')).map((name) => [name]);
      let lastAt = null;
      for (const sub of files) {
        const text = readers.readText(probe.pathKey, ...sub);
        if (text === null) continue;
        if (probe.skipIfTrue && readFrontmatterField(text, probe.skipIfTrue) === true) continue;
        const at = parseTimeValue(readFrontmatterField(text, probe.field));
        if (at !== null && (lastAt === null || at > lastAt)) lastAt = at;
      }
      return { lastAt };
    }
    case 'file-mtime':
      return { lastAt: readers.mtime(probe.pathKey) };
    case 'not-collected':
      return { lastAt: null };
    default:
      throw new Error(`알 수 없는 probe 종류: ${probe.type}`);
  }
}

function judge(source, obs, { now, isTradingDay }) {
  const { kind, threshold } = source;
  const today = kstDateOf(now);
  if (source.probe.type === 'not-collected') return { status: 'not-collected', detail: '아직 수집하지 않음' };
  if (kind === 'bursty' || kind === 'display-only') return { status: 'display', detail: '' };
  if (kind === 'continuous') {
    if (obs.lastAt === null) return { status: 'stale', detail: '최근 기록 없음' };
    const ageHours = (now - obs.lastAt) / HOUR_MS;
    return now - obs.lastAt > threshold.maxAgeMs
      ? { status: 'stale', detail: `${ageHours.toFixed(1)}시간째 없음(기준 ${threshold.maxAgeMs / HOUR_MS}시간)` }
      : { status: 'ok', detail: '' };
  }
  if (kind === 'daily-rhythm' && threshold.zeroDays) {
    // 오늘은 아직 안 끝났으니 빼고, 마지막으로 1건 이상 있던 날 다음부터 어제까지 비어 있던 날 수를 센다.
    const lastDay = Object.keys(obs.dayCounts).filter((label) => obs.dayCounts[label] > 0).sort().pop();
    const lookbackStart = Object.keys(obs.dayCounts).sort()[0];
    const from = lastDay ? addDays(lastDay, 1) : lookbackStart;
    let emptyDays = 0;
    for (let label = from; label < today; label = addDays(label, 1)) emptyDays += 1;
    return emptyDays >= threshold.zeroDays
      ? { status: 'stale', detail: `${emptyDays}일째 0건(기준 ${threshold.zeroDays}일)` }
      : { status: 'ok', detail: '' };
  }
  if (kind === 'daily-rhythm' && threshold.dueHourNextDayKst !== undefined) {
    // 날짜 파일은 다음날 dueHour KST까지 있어야 한다. 기록이 시작되기 전 날짜는 빈칸으로 치지 않는다.
    const first = [...obs.dates].sort()[0];
    const missing = [];
    for (let i = threshold.lookbackDays; i >= 1; i -= 1) {
      const label = addDays(today, -i);
      if (first && label < first) continue;
      if (kstDayStartMs(addDays(label, 1)) + threshold.dueHourNextDayKst * HOUR_MS > now) continue;
      if (!obs.dates.has(label)) missing.push(label);
    }
    return missing.length
      ? { status: 'stale', detail: `빈 날짜 ${missing.join(', ')}` }
      : { status: 'ok', detail: '' };
  }
  if (kind === 'market-day') {
    // 여유 시각(graceHoursKst)이 지난 가장 최근 거래일 D에, D 00:00 KST 이후 갱신이 있어야 한다.
    let due = null;
    for (let i = 0; i <= 14 && !due; i += 1) {
      const label = addDays(today, -i);
      if (kstDayStartMs(label) + threshold.graceHoursKst * HOUR_MS > now) continue;
      if (isTradingDayOr(label, isTradingDay)) due = label;
    }
    if (!due) return { status: 'ok', detail: '' };
    if (obs.lastAt === null) return { status: 'stale', detail: '기록 없음' };
    return obs.lastAt < kstDayStartMs(due)
      ? { status: 'stale', detail: `거래일 ${due} 갱신 없음` }
      : { status: 'ok', detail: '' };
  }
  throw new Error(`알 수 없는 kind: ${kind}`);
}

/**
 * 출처별 신선도 판정. 순수 함수 — 읽기는 readers로만 한다.
 * readers: { listDir(pathKey, ...sub) → 이름[]|null, readText(pathKey, ...sub) → 문자열|null, mtime(pathKey) → ms|null,
 *            isTradingDay(label) → true|false|null }
 * silentJobs: 지금 '조용함' 경보 중인 잡 이름. producer가 여기 있으면 이 출처는 경보하지 않는다(잡 경보로 갈음).
 * 상위 채널(liveness)이 끊겼거나 그 때문에 묶인 출처의 하위는 'suppressed'로 묶는다.
 * 반환: { results: [{ id, label, owner, kind, urgent, status, lastAt, detail }], stale: status==='stale'만 }
 * status: ok | stale | suppressed | display | not-collected | error
 */
export function findStaleSources({ now, sources, readers, silentJobs = new Set() }) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const memo = new Map();
  const byId = new Map();
  for (const source of sources) {
    let result;
    try {
      const obs = observe(source, { now: nowMs, readers, memo });
      result = { ...judge(source, obs, { now: nowMs, isTradingDay: readers.isTradingDay }), lastAt: obs.lastAt };
    } catch (error) {
      result = { status: 'error', detail: `읽기 실패: ${error.message}`, lastAt: null };
    }
    if (result.status === 'stale' && silentJobs.has(source.producer)) {
      result = { ...result, status: 'suppressed', detail: `만드는 잡 ${source.producer}이(가) 조용함 — 잡 경보로 갈음` };
    }
    byId.set(source.id, { source, result });
  }
  const isDown = (id, seen = new Set()) => {
    const entry = byId.get(id);
    if (!entry || seen.has(id)) return false;
    seen.add(id);
    if (entry.result.status === 'stale' || entry.result.status === 'suppressed') return true;
    return entry.source.liveness ? isDown(entry.source.liveness, seen) : false;
  };
  const results = [];
  for (const { source, result } of byId.values()) {
    let final = result;
    if (source.liveness && result.status === 'stale' && isDown(source.liveness)) {
      final = { ...result, status: 'suppressed', detail: `상위 채널 ${source.liveness} 끊김 — 상위 경보로 묶음` };
    }
    results.push({ id: source.id, label: source.label, owner: source.owner, kind: source.kind,
      urgent: source.urgent, status: final.status, lastAt: final.lastAt ?? null, detail: final.detail ?? '' });
  }
  return { results, stale: results.filter((r) => r.status === 'stale') };
}

export function sourceIssueKey(id) {
  return `source:${id}:stale`;
}

function formatKst(ms) {
  if (ms === null || ms === undefined) return '기록 없음';
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

export function formatSourceIssue(result) {
  return `데이터 <code>${result.label}</code>(${result.id}) 끊김 — 마지막 수신 ${formatKst(result.lastAt)}, ${result.detail}`;
}

// 실제 볼트 읽기. root·rel(VAULT_REL)은 호출부가 넘긴다. 없는 파일·폴더는 null.
export function createVaultReaders({ root, rel, isTradingDay = () => null }) {
  const abs = (pathKey, ...sub) => {
    if (!rel[pathKey]) throw new Error(`VAULT_REL에 없는 경로 키: ${pathKey}`);
    return join(root, ...rel[pathKey].split('/'), ...sub);
  };
  return {
    listDir: (pathKey, ...sub) => {
      const path = abs(pathKey, ...sub);
      if (!existsSync(path) || !statSync(path).isDirectory()) return null;
      return readdirSync(path).filter((name) => !name.startsWith('.'));
    },
    readText: (pathKey, ...sub) => {
      const path = abs(pathKey, ...sub);
      return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null;
    },
    mtime: (pathKey) => {
      const path = abs(pathKey);
      return existsSync(path) ? statSync(path).mtimeMs : null;
    },
    isTradingDay,
  };
}

// DataFreshness.json 본문. lastReceivedAt은 ISO, 없으면 null.
export function buildFreshnessDocument(results, now) {
  return {
    schemaVersion: FRESHNESS_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    sources: results.map((r) => ({ id: r.id, label: r.label, owner: r.owner, kind: r.kind, urgent: r.urgent,
      status: r.status, lastReceivedAt: r.lastAt === null ? null : new Date(r.lastAt).toISOString(), detail: r.detail })),
  };
}

// 내용이 바뀔 때만 쓴다. generatedAt만 다른 것은 바뀐 게 아니다. 쓰면 true.
export function writeIfChanged(file, doc) {
  let prev = null;
  try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 없거나 깨졌으면 새로 쓴다 */ }
  const strip = (value) => {
    if (!value || typeof value !== 'object') return value;
    const { generatedAt, ...rest } = value;
    return rest;
  };
  if (prev && JSON.stringify(strip(prev)) === JSON.stringify(strip(doc))) return false;
  mkdirSync(dirname(file), { recursive: true });
  // 임시 파일에 다 쓴 뒤 이름을 바꾼다(LiveSync가 반쯤 쓴 파일을 옮기지 않게). 임시 이름은 점 파일이라 LiveSync가 건너뛴다.
  const temp = join(dirname(file), `.${process.pid}.${Date.now()}.data-freshness.tmp`);
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(temp, file);
  return true;
}

// ── 비긴급 묶음(09:00·19:00 KST) 상태 계획 — 순수 함수 ──
// 상태: { lastSlot, sources: { [id]: { firstSeenAt, lastBadAt, lastSentAt|null } } }
// - stale이면 기록을 만들거나 lastBadAt을 갱신한다. suppressed·error는 판단 보류라 lastBadAt만 이어 붙인다.
// - 복구: 6시간 연속으로 문제없을 때만(30분 단위 깜빡임으로 가짜 "복구됨"이 나가지 않게).
// - 재알림: 마지막 발송 뒤 20시간이 지나야(하루 한 번 — processHealthIssues의 24시간 뒤 하루 한 번과 같은 정신).
export const DIGEST_SLOT_HOURS_KST = [9, 19];
export const DIGEST_SLOT_WINDOW_MS = 3 * HOUR_MS;
export const DIGEST_RECOVERY_HOLD_MS = 6 * HOUR_MS;
export const DIGEST_REMIND_AFTER_MS = 20 * HOUR_MS;

// now가 속한 묶음 시각(슬롯). 슬롯 시각 뒤 3시간 안이면 그 슬롯 id, 아니면 null.
export function currentDigestSlot(now) {
  const today = kstDateOf(now);
  for (const label of [today, addDays(today, -1)]) {
    for (const hour of [...DIGEST_SLOT_HOURS_KST].reverse()) {
      const at = kstDayStartMs(label) + hour * HOUR_MS;
      if (at <= now && now - at < DIGEST_SLOT_WINDOW_MS) return `${label}@${String(hour).padStart(2, '0')}`;
    }
  }
  return null;
}

export function trackDigestState(state, results, now) {
  const next = { lastSlot: state?.lastSlot ?? null, sources: { ...(state?.sources ?? {}) } };
  for (const r of results) {
    if (r.urgent) continue;
    const prior = next.sources[r.id];
    if (r.status === 'stale') {
      next.sources[r.id] = { firstSeenAt: prior?.firstSeenAt ?? now, lastBadAt: now, lastSentAt: prior?.lastSentAt ?? null };
    } else if (prior && (r.status === 'suppressed' || r.status === 'error')) {
      next.sources[r.id] = { ...prior, lastBadAt: now };
    }
  }
  return next;
}

// 슬롯에 보낼 것: due(지금 stale이고 처음이거나 20시간 지남), recovered(보낸 적 있고 6시간 연속 문제없음).
// dropped: 보낸 적 없이 6시간 조용해진 깜빡임 — 알리지 않고 지운다.
export function planDigest(state, results, now) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const due = [];
  const recovered = [];
  const dropped = [];
  for (const [id, entry] of Object.entries(state.sources)) {
    const r = byId.get(id);
    if (!r) { dropped.push(id); continue; } // 표에서 빠진 출처
    if (r.status === 'stale') {
      if (entry.lastSentAt === null || now - entry.lastSentAt >= DIGEST_REMIND_AFTER_MS) due.push({ ...r, reminder: entry.lastSentAt !== null });
    } else if (now - entry.lastBadAt >= DIGEST_RECOVERY_HOLD_MS) {
      if (entry.lastSentAt !== null) recovered.push(r);
      else dropped.push(id);
    }
  }
  return { due, recovered, dropped };
}
