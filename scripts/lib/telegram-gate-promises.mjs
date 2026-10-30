// 텔레그램 관문 약속 대기열 — "끝나면 알려줄게"를 말로만 하지 않고 관문이 지키게 하는 저장소와 판정(2026-10-30, 관문 3단계.
// 설계 9-1, 결정 `텔레그램-관문` 9·10항, Q4·Q10·Q11).
//
// 흐름:
//   LLM(관문 MCP promise_add) → 관문 상태 폴더 promise-requests.jsonl에 "요청"만 덧붙인다(MCP 서버는 볼트에 쓰지 않는다).
//   관문 데몬 1분 점검 → 요청을 다시 검사해 볼트 95_Etna/Jobs/TelegramGate/promises.jsonl에 옮긴다(볼트 쓰는 주체 = 관문 데몬뿐, 경로 등록부).
//   → 대기 중인 약속의 조건(시각·잡 상태·파일·or)을 순수 함수로 판정 → 충족되면 이행(기본 고정 문구, 맥락이 필요할 때만 LLM)
//   → 기한(기본 7일)이 지나면 "지키지 못한 약속"으로 한 번 알리고 닫는다.
// 파일 내용은 약속 줄 + 상태 줄이다. 같은 id는 한 번만, 깨진 줄은 건너뛴다. 쓰기는 덧붙이지 않고 매번 전체를 원자적으로 바꾼다(writeVaultFile).
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { AGENT_IDS } from './agent-registry.mjs';
import { escapeHtml } from './telegram.mjs';

export const PROMISE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING = 20;
export const TRIGGER_TYPES = Object.freeze(['time', 'job', 'file']);
export const TERMINAL = new Set(['이행', '만료', '취소', '실패']);
const JOB_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const JOB_STATUS = new Set(['ok', 'fail', 'any']);

// 볼트 파일 원자 교체: 같은 폴더의 점 파일(LiveSync는 숨김 파일을 동기화하지 않고 볼트 lint도 건너뜀)에 쓰고 fsync한 뒤 rename한다.
// 폰 쪽에는 rename 한 번(완성된 내용)만 보인다. 중간에 실패하면 임시 파일만 지우고 원본은 그대로 둔다.
export function writeVaultFile(path, content) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* 이미 닫힘 */ }
    try { unlinkSync(tmp); } catch { /* 없음 */ }
    throw error;
  }
}

// 순수 함수: 오래된 완료 건 정리. 줄 수가 limit을 넘을 때만, 끝난 지(마지막 상태 시각) keepMs보다 오래된 약속의 줄을 모두 뺀다. 대기 건은 그대로.
export const COMPACT_AT_LINES = 500;
export const COMPACT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export function compactPromiseLines(lines, { now, limit = COMPACT_AT_LINES, keepMs = COMPACT_KEEP_MS }) {
  if (lines.length <= limit) return lines;
  const drop = new Set();
  for (const [id, p] of foldPromises(lines)) {
    if (TERMINAL.has(p.status) && now.getTime() - new Date(p.at).getTime() > keepMs) drop.add(id);
  }
  return drop.size ? lines.filter((l) => !drop.has(l?.id)) : lines;
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// 순수 함수: 조건 하나 검사·정규화. knownJobs는 잡 이름 목록(job-labels), 볼트 상대 경로만 받는다.
export function validateTrigger(trigger, { now, knownJobs }) {
  if (!trigger || !TRIGGER_TYPES.includes(trigger.type)) throw new Error(`약속 조건 종류는 ${TRIGGER_TYPES.join('·')}`);
  if (trigger.type === 'time') {
    // 오너 기준은 KST다. 시간대가 없는 날짜·시각은 KST로 읽는다(서버 로컬·UTC 해석에 기대지 않음, 리뷰 L5·제우스 방향).
    // 날짜만 있는 값은 몇 시인지 알 수 없어 받지 않는다.
    const rawAt = String(trigger.at ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(rawAt)) throw new Error('시각 조건(at)은 날짜와 시각이 있는 ISO 시각이어야 합니다(예: 2026-10-31T18:00, KST로 읽음)');
    const at = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(rawAt) ? rawAt : `${rawAt}+09:00`);
    if (!Number.isFinite(at)) throw new Error('시각 조건(at)은 ISO 시각이어야 합니다(예: 2026-10-31T18:00:00+09:00)');
    if (at > now.getTime() + PROMISE_TTL_MS) throw new Error('7일 넘는 약속은 받지 않습니다');
    return { type: 'time', at: new Date(at).toISOString() };
  }
  if (trigger.type === 'job') {
    if (!JOB_RE.test(String(trigger.job ?? '')) || !knownJobs.includes(trigger.job)) throw new Error(`모르는 잡: ${trigger.job}`);
    const status = trigger.status ?? 'any';
    if (!JOB_STATUS.has(status)) throw new Error('잡 상태 조건은 ok·fail·any');
    return { type: 'job', job: trigger.job, status };
  }
  const raw = String(trigger.path ?? '').trim();
  const path = normalize(raw);
  if (!raw || path === '.' || !path || isAbsolute(path) || path.startsWith('..') || /^99/.test(path)) throw new Error('파일 조건은 볼트 안 상대 경로만(금고 제외)');
  return { type: 'file', path };
}

// 순수 함수: LLM이 넘긴 약속 요청 → 저장할 약속. 틀리면 이유와 함께 던진다.
export function validatePromiseInput(input, { now, knownJobs, uuid = randomUUID }) {
  const text = String(input?.text ?? '').trim();
  if (!text || text.length > 300) throw new Error('약속 문구는 1~300자');
  const trigger = validateTrigger(input.trigger, { now, knownJobs });
  const or = input.or ? validateTrigger(input.or, { now, knownJobs }) : null;
  const agent = input.agent ?? 'zeus';
  if (!AGENT_IDS.includes(agent)) throw new Error(`미등록 담당: ${agent}`);
  const action = input.action === 'llm' ? 'llm' : 'notify';
  const expiresAt = new Date(now.getTime() + PROMISE_TTL_MS).toISOString();
  return {
    type: 'promise',
    // 날짜는 KST(리뷰 L6).
    id: `P-${new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10).replaceAll('-', '')}-${uuid().slice(0, 6)}`,
    createdAt: now.toISOString(),
    by: agent,
    text,
    trigger,
    ...(or ? { or } : {}),
    action,
    ...(Number.isSafeInteger(input.sourceMessageId) ? { sourceMessageId: input.sourceMessageId } : {}),
    expiresAt,
  };
}

// 순수 함수: 조건 하나가 충족됐는지. ctx.jobHealth(job) → { lastRun, status } | null, ctx.fileMtime(path) → ms | null.
// 잡·파일 조건은 약속을 만든 뒤에 일어난 일만 센다(이미 끝난 일로 바로 이행되지 않게).
export function triggerMet(trigger, { now, since, jobHealth, fileMtime }) {
  if (trigger.type === 'time') return now.getTime() >= Date.parse(trigger.at);
  if (trigger.type === 'job') {
    const health = jobHealth(trigger.job);
    const lastRun = Date.parse(health?.lastRun ?? '');
    if (!Number.isFinite(lastRun) || lastRun <= since) return false;
    if (trigger.status === 'ok') return health.status === 'OK';
    if (trigger.status === 'fail') return health.status !== 'OK';
    return true;
  }
  const mtime = fileMtime(trigger.path);
  return Number.isFinite(mtime) && mtime > since;
}

export function promiseMet(promise, ctx) {
  const since = Date.parse(promise.createdAt);
  return triggerMet(promise.trigger, { ...ctx, since }) || (promise.or ? triggerMet(promise.or, { ...ctx, since }) : false);
}

// "10/30 18:00" 꼴(KST).
const kst = (iso) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

// 순수 함수: 조건을 사람 말로(고정 문구).
export function describeTrigger(trigger) {
  if (trigger.type === 'time') return `${kst(trigger.at)}이 되면`;
  if (trigger.type === 'job') return `${trigger.job} 잡이 ${trigger.status === 'ok' ? '성공하면' : trigger.status === 'fail' ? '실패하면' : '돌면'}`;
  return `${trigger.path}가 바뀌면`;
}

const conditionText = (promise) => `${describeTrigger(promise.trigger)}${promise.or ? ` 또는 ${describeTrigger(promise.or)}` : ''}`;

// 순수 함수: 이행 알림 본문. 약속 문구는 LLM이 쓴 문장이라 인용문으로 감싸고(굵은 선, 결정 `텔레그램-메시지-구분`),
// 조건·시각은 스크립트 사실로 그 아래에 둔다. 모두 HTML 이스케이프(링크 위장·태그 주입 방지, 리뷰 M5).
export function promiseNotifyBody(promise) {
  return [`<blockquote>${escapeHtml(promise.text)}</blockquote>`, '약속한 일을 알려 드립니다.', `· 조건: ${escapeHtml(conditionText(promise))}`, `· 약속 ${kst(promise.createdAt)}`].join('\n');
}

export function promiseExpiredBody(promise) {
  return [`<blockquote>${escapeHtml(promise.text)}</blockquote>`, '기한(7일) 안에 조건이 충족되지 않아 이 약속을 닫습니다.', `· 조건: ${escapeHtml(conditionText(promise))}`].join('\n');
}

// 순수 함수: 줄 목록 → id별 { promise, status, at }.
export function foldPromises(lines) {
  const map = new Map();
  for (const l of lines) {
    if (l?.type === 'promise' && l.id && !map.has(l.id)) map.set(l.id, { promise: l, status: '대기', at: l.createdAt, detail: '' });
    else if (l?.type === 'status' && map.has(l.id)) Object.assign(map.get(l.id), { status: l.status, at: l.at, detail: l.detail ?? '' });
  }
  return map;
}

// 순수 함수: 오류를 오너에게 보여도 되는 문구로. 검사에서 일부러 던진 메시지(Error)만 그대로, 그 밖(RangeError 등)은 감춘다(리뷰 M5).
export function safeReason(error) {
  return error?.constructor === Error ? String(error.message).slice(0, 120) : '요청 형식 오류';
}

function readRequests(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((name) => {
    const path = join(dir, name);
    try { return { path, request: JSON.parse(readFileSync(path, 'utf8')) }; } catch { return { path, request: null }; }
  });
}

// vaultFile: 볼트 promises.jsonl(관문 데몬만 씀). requestDir: 관문 상태 폴더 promise-requests/(MCP가 요청마다 파일 하나).
// 요청을 한 파일씩 원자적으로 만들고(임시 파일 → rename) 데몬이 볼트에 반영한 뒤 지운다 — 열린 파일에 늦게 써서 사라지는 경합이 없다(리뷰 M6).
// 볼트 쓰기(3단계 리뷰 L1, 제우스 방향): 볼트는 LiveSync로 폰과 동기화되고 연속 쓰기가 폰에서 'corrupted' 사고를 낸 전례가 있다.
// 그래서 덧붙이지 않고, 점검마다 모은 줄을 기존 내용과 합쳐 파일 전체를 한 번에(점 임시 파일 → fsync → rename) 쓴다(flush). 점검당 최대 1회,
// 내용이 그대로면 쓰지 않는다. 커지면 오래된 완료 건을 같은 쓰기 안에서 정리한다(compactPromiseLines).
export function createPromiseStore({ vaultFile, requestDir, now = () => new Date(), writeFile = writeVaultFile }) {
  let buffer = [];
  const allLines = () => [...readLines(vaultFile), ...buffer];
  return {
    // MCP 쪽: uuid·요청 시각을 미리 정해 최종 약속 id를 계산해 돌려준다(promise_cancel이 바로 쓸 수 있게, 리뷰 M3).
    request(entry, { uuid = randomUUID(), requestedAt = now().toISOString() } = {}) {
      mkdirSync(requestDir, { recursive: true, mode: 0o700 });
      const name = `${requestedAt.replace(/[:.]/g, '')}-${uuid}.json`;
      const tmp = join(requestDir, `.${name}.tmp`);
      writeFileSync(tmp, `${JSON.stringify({ ...entry, uuid, requestedAt })}\n`, { mode: 0o600 });
      renameSync(tmp, join(requestDir, name));
      return { uuid, requestedAt };
    },
    pendingRequestCount() {
      return readRequests(requestDir).filter((r) => r.request?.kind === 'add').length;
    },
    // 데몬 쪽: 요청 파일들을 다시 검사해 버퍼에 담는다. 반환한 consumed(요청 파일 경로)는 flush가 성공한 뒤에만 지운다.
    // 지우기 전에 멈추면 다음 점검이 다시 읽지만 id가 uuid로 정해져 있어 한 번만 저장된다. 같은 묶음의 추가→취소도 반영(리뷰 L2).
    ingest({ knownJobs }) {
      const files = readRequests(requestDir);
      if (!files.length) return { added: [], cancelled: [], rejected: [], consumed: [], rejectedPaths: [] };
      const current = foldPromises(allLines());
      const added = [];
      const cancelled = [];
      const rejected = [];
      const rejectedPaths = [];
      for (const { path, request: r } of files) {
        try {
          if (!r) throw new Error('읽을 수 없는 요청');
          if (r.kind === 'cancel') {
            const target = current.get(r.id);
            if (target?.status === '취소') continue; // 다시 읽은 요청
            if (!target || target.status !== '대기') throw new Error(`대기 중인 약속이 아님: ${r.id}`);
            buffer.push({ type: 'status', id: r.id, status: '취소', at: now().toISOString(), detail: '오너·담당 요청으로 취소' });
            target.status = '취소';
            cancelled.push(r.id);
            continue;
          }
          const promise = validatePromiseInput(r.input, { now: new Date(r.requestedAt ?? now()), knownJobs, uuid: () => r.uuid ?? randomUUID() });
          if (current.has(promise.id)) continue;
          const pendingCount = [...current.values()].filter((p) => p.status === '대기').length;
          if (pendingCount >= MAX_PENDING) throw new Error(`대기 약속이 ${MAX_PENDING}건을 넘습니다`);
          buffer.push(promise);
          current.set(promise.id, { promise, status: '대기', at: promise.createdAt, detail: '' });
          added.push(promise);
        } catch (error) {
          rejected.push({ request: r, reason: safeReason(error), error });
          rejectedPaths.push(path);
        }
      }
      // 거절한 요청 파일은 볼트 기록과 상관없어 바로 지운다(볼트 쓰기가 실패해도 거절 알림이 반복되지 않게).
      return { added, cancelled, rejected, consumed: files.map((f) => f.path).filter((p) => !rejectedPaths.includes(p)), rejectedPaths };
    },
    list() {
      return [...foldPromises(allLines()).values()];
    },
    pending() {
      return this.list().filter((p) => p.status === '대기');
    },
    markStatuses(entries) {
      for (const { id, status, detail = '' } of entries) buffer.push({ type: 'status', id, status, at: now().toISOString(), detail: String(detail).slice(0, 200) });
    },
    markStatus(id, status, detail = '') {
      this.markStatuses([{ id, status, detail }]);
    },
    hasUnflushed: () => buffer.length > 0,
    // 모은 줄을 볼트 파일 전체 재작성 한 번으로 반영한다. 실패하면 버퍼를 버리고 던진다(요청 파일은 남아 다음 점검에서 다시 읽힌다).
    flush() {
      if (!buffer.length) return 0;
      const count = buffer.length;
      try {
        const text = compactPromiseLines(allLines(), { now: now() }).map((l) => `${JSON.stringify(l)}\n`).join('');
        const before = existsSync(vaultFile) ? readFileSync(vaultFile, 'utf8') : null;
        if (text !== before) {
          mkdirSync(dirname(vaultFile), { recursive: true });
          writeFile(vaultFile, text);
        }
        buffer = [];
        return count;
      } catch (error) {
        buffer = [];
        throw error;
      }
    },
    removeRequests(paths) {
      for (const path of paths) { try { unlinkSync(path); } catch { /* 이미 지움 */ } }
    },
  };
}
