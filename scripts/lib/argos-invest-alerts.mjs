// 아르고스 → 투자 알림(카톡 증권사 알림) 수신함 어댑터와 출처 간 중복 판정(2026-11-06, 카카오 알림 앱 제거 준비).
//
// 같은 카톡 알림을 두 앱이 받는다: 카카오 알림 앱(Firestore kakaoInbox)과 아르고스(볼트 95_Etna/Events의
// notification.received). parse-notifications-to-vault는 원래 앞의 것만 읽었다. 여기서는 아르고스 이벤트를
// 같은 모양 {id, ts, body}로 바꿔 같은 루프·같은 파서(notification-parsers.mjs)에 넣는다.
//
// 단계(잡의 --argos-mode, 기본 shadow):
// - shadow: 아르고스 알림은 장부에 쓰지 않는다. "primary였다면 무엇을 했을지"를 대조 보고서로만 남긴다.
//   중복 판정은 primary와 같은 함수(findCrossSourceTwin)라, 보고서가 곧 primary 중복 방지의 실측 검증이다.
// - primary: 아르고스 알림이 기존 쓰기 경로를 탄다. Firestore는 읽지도 지우지도 않는다.
//
// ⚠️ 불변식(가장 중요): 같은 실제 체결·입금이 두 출처에 다 있어도 장부엔 한 번만 쓴다.
// - 같은 출처 안 중복은 기존 장치가 막는다(파일명 = dedup 키, 체결은 sourceEventId가 파일명에 들어감).
// - 출처 간 중복은 파일명만으로 못 막는다: 수신 시각이 앱마다 몇 초 다르고(파일명에 초까지 들어감),
//   체결 파일명엔 출처별 문서 id(sourceEventId)가 붙는다. 그래서 쓰기 전에 "다른 출처가 이미 남긴 같은 기록"
//   (findCrossSourceTwin)을 찾고, 있으면 쓰지 않고 처리 완료로 표시한다.
// - 짝짓기는 1:1이다(used). 분할 체결처럼 같은 종목·수량·단가 알림이 몇 초 간격으로 여러 건 오면, 다른 출처
//   기록 하나에 한 알림만 짝짓는다 — 짝이 모자란 나머지는 진짜 별개 체결로 보고 쓴다. 짝지은 기록은 상태
//   파일(twin)에 남겨 다음 실행에서도 재사용하지 않는다.
// - 출처 구분: 문서 id가 'argos-'로 시작하면 아르고스, 아니면 카카오 알림 앱(수동 'manual-' 문서 포함).
//   장부 기록은 체결이면 머리말 sourceEventId로, 그 밖(배당·예수금 등 출처 칸 없음)은 아르고스가 쓴 파일
//   목록(상태 파일 written)으로 출처를 안다. API 정본 체결(source가 KAKAO 아닌 것)은 짝 후보가 아니다.
// - Firestore 쪽 문서도 같은 판정을 거친다(아르고스가 쓴 기록과 짝이면 쓰지 않음). 아르고스가 아직 아무것도
//   안 썼으면(shadow) 후보가 없어 기존 동작과 같다 — primary에서 shadow로 되돌려도 중복이 생기지 않게 한 것.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { INVESTMENT_ALERT_BROKERS } from './notification-parsers.mjs';
import { classifyInvestmentNotification, kstTimestamp } from './argos-notifications.mjs';
import { classifyKakaoExecution } from './execution-source-policy.mjs';
import { EXCHANGE_ACCOUNT, FUND_PURCHASE_ACCOUNT } from './account-resolver.mjs';
import {
  buildCashEventRecord, buildDividendRecord, buildExchangeRecord, buildFundPurchaseRecord, buildFundValuationRecord,
} from './ledger-vault-writer.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { writeAtomic } from './state-writer.mjs';

export const ARGOS_DOC_PREFIX = 'argos-';
export const KAKAO_PACKAGE = 'com.kakao.talk';
// 약 2일. 아르고스 이벤트는 지워지지 않으므로 이 기간만 다시 읽고, 처리한 것은 상태 파일로 거른다.
export const ARGOS_LOOKBACK_DAYS = 2;
// 두 앱 수신 시각 차이 허용(초). 실측은 몇 초 — 대조 도구(argos-notification-compare)와 같은 3분.
export const CROSS_SOURCE_TOLERANCE_SEC = 180;
// 상태 파일 보관 기간. 조회 기간(2일)보다 넉넉히. 단 장부를 쓴 기록(written)은 지우지 않는다 — 배당·예수금·
// 금현물 파일엔 출처 칸이 없어, 지우면 오래 primary를 쓰다 shadow로 되돌렸을 때 Firestore 쪽이 같은 기록을 다시 쓴다.
const STATE_KEEP_DAYS = 14;
const DAY_MS = 24 * 3600_000;
const LEDGER_NAME = /^(\d{4}-\d{2}-\d{2})-(\d{6})-(.+)\.md$/;

/** 잡 인자에서 모드를 읽는다. 없으면 shadow. 모르는 값은 거부한다(오타가 조용히 shadow·primary로 가지 않게). */
export function parseArgosMode(argv = []) {
  const args = argv.filter((a) => a === '--argos-mode' || a.startsWith('--argos-mode='));
  if (!args.length) return 'shadow';
  const m = args.length === 1 ? /^--argos-mode=(shadow|primary)$/.exec(args[0]) : null;
  if (!m) throw new Error(`--argos-mode=shadow|primary 하나만 (받은 값: ${args.join(' ')})`);
  return m[1];
}

export const isArgosDocId = (id) => String(id ?? '').startsWith(ARGOS_DOC_PREFIX);

/** 카톡 발신자가 파서가 아는 증권사(이름 그대로 또는 '이름 …' 채널, 예: 퇴직연금 채널)인가. */
export function isInvestmentAlertSender(sender) {
  const s = String(sender ?? '').trim();
  return INVESTMENT_ALERT_BROKERS.some((b) => s === b || s.startsWith(`${b} `));
}

/**
 * 문서 id는 이벤트 id(앱이 매번 새로 만드는 UUID)가 아니라 내용(발신자·postedAt·본문)에서 만든다.
 * 아르고스는 앱 재시작 뒤 최근 알림을 다시 보내는데 그때 이벤트 id만 새로 붙는다 — 이벤트 id를 쓰면 같은 체결이
 * 체결 파일명(sourceEventId)·처리 기록을 다 통과해 두 번 써진다(카카오 알림 앱도 같은 이유로 내용 해시 id).
 * 아르고스 이벤트 → 수신함 문서 {id, ts, body, sender}. 카톡(KAKAO_PACKAGE)이 아니면 거른다 — 증권사 앱 자체
 * 푸시가 같은 문구로 오면 한 체결이 두 번 들어갈 수 있다. 친구 대화방에 붙여넣은 알림 원문을 거르려고
 * 발신자도 증권사로 한정한다. ts는 카카오 수신함과 같은 KST 'YYYY-MM-DD HH:mm:ss'(postedAt 기준).
 */
export function argosInboxDocs(events) {
  const docs = [];
  const seen = new Set();
  for (const event of events ?? []) {
    if (event?.type !== 'notification.received' || !event.id) continue;
    const p = event.payload;
    if (!p || typeof p !== 'object' || p.packageName !== KAKAO_PACKAGE || !isInvestmentAlertSender(p.sender)) continue;
    const body = typeof p.body === 'string' ? p.body : '';
    const at = Number(p.postedAt ?? event.occurred_at);
    if (!body.trim() || !Number.isFinite(at)) continue;
    const sender = String(p.sender).trim();
    const id = `${ARGOS_DOC_PREFIX}${createHash('sha256').update(`${sender}\n${at}\n${body}`).digest('hex').slice(0, 24)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    // receivedAt: 맥이 받은 시각(폰이 늦게 올린 알림의 보류 경고 기준, countAgingArgosDocs).
    docs.push({ id, eventId: String(event.id), ts: kstTimestamp(at), at, receivedAt: Date.parse(event.received_at), body, sender });
  }
  return docs.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/**
 * 최근 lookbackDays일 아르고스 이벤트(날짜 파일 95_Etna/Events/{YYYY}/{YYYY-MM-DD}.jsonl). 깨진 줄은 건너뛴다.
 * 알림 시각(postedAt) 또는 맥 수신 시각(received_at) 중 하나라도 기간 안이면 넣는다 — 폰이 며칠 오프라인이었다가
 * 늦게 올린 알림도 빠지지 않게. 날짜 파일은 수신 쪽이 정하므로 기간 안 날짜 파일만 읽어도 된다.
 */
export function readRecentArgosEvents(eventsDir, nowMs, lookbackDays = ARGOS_LOOKBACK_DAYS) {
  const since = nowMs - lookbackDays * DAY_MS;
  const events = [];
  for (let i = lookbackDays; i >= 0; i -= 1) {
    const label = kstTimestamp(nowMs - i * DAY_MS).slice(0, 10);
    const path = join(eventsDir, label.slice(0, 4), `${label}.jsonl`);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const at = Number(event?.payload?.postedAt ?? event?.occurred_at);
      const receivedAt = Date.parse(event?.received_at);
      if ((Number.isFinite(at) && at >= since) || (Number.isFinite(receivedAt) && receivedAt >= since)) events.push(event);
    }
  }
  return events;
}

// ── 상태 파일 { version, processed: { [문서 id]: { at, twin?, written? } }, pending: { [문서 id]: { at, path } } } ──
// twin: 이 알림과 짝지은 다른 출처 기록(경로 또는 'confirmation:<id>'), written: 이 알림으로 쓴 장부 파일.
// pending: 장부를 쓰기 직전에 디스크에 먼저 남긴 쓰기 의도(createArgosLedgerWriter). 실행 끝 settleArgosProcessed가
// written으로 옮기고 지운다. processed가 아니므로 primary는 그 문서를 다시 읽는다(쓰기 전에 죽었으면 다시 쓴다).
/** 없으면 빈 상태. 깨졌으면 던진다(primary에서 조용히 빈 상태로 시작하면 짝 기록을 잃는다). */
export function loadArgosState(file) {
  if (!existsSync(file)) return { version: 1, processed: {}, pending: {} };
  const state = JSON.parse(readFileSync(file, 'utf8'));
  if (!state || typeof state.processed !== 'object' || state.processed === null) throw new Error(`아르고스 상태 파일 형식 오류: ${file}`);
  if (state.pending !== undefined && (typeof state.pending !== 'object' || state.pending === null)) throw new Error(`아르고스 상태 파일 형식 오류(pending): ${file}`);
  return { ...state, pending: state.pending ?? {} };
}

export function saveArgosState(file, state, nowMs) {
  const keepSince = nowMs - STATE_KEEP_DAYS * DAY_MS;
  const processed = Object.fromEntries(Object.entries(state.processed ?? {})
    .filter(([, v]) => v?.written || !(Date.parse(v?.at) < keepSince)));
  mkdirSync(dirname(file), { recursive: true });
  // pending은 지우지 않는다 — 쓰기 의도가 남은 파일은 아르고스 것으로 계속 보여야 한다(정리는 settleArgosProcessed만).
  writeAtomic(file, `${JSON.stringify({ version: 1, processed, pending: state.pending ?? {} }, null, 2)}\n`);
}

/**
 * ⚠️ 크래시 안전(2026-11-07, primary 전환 전 재리뷰 MEDIUM). 불변식: 아르고스 문서로 장부에 쓴 파일은 언제 잡이
 * 죽어도 상태 파일에서 아르고스 것으로 보인다(processed.written 또는 pending). 배당·예수금·금현물 파일엔 출처 칸이
 * 없어, 이게 깨지면 shadow로 되돌렸을 때 Firestore 쪽 같은 기록이 짝을 못 찾고 두 번 써진다.
 * 그래서 아르고스 문서는 쓰기 전에 의도(pending)를 먼저 디스크에 저장하고(write-ahead), 그다음 장부를 쓴다.
 * - 의도 저장 뒤·쓰기 전에 죽음: 파일이 없으니 무해. 문서는 processed가 아니라 다음 실행이 다시 읽어 같은 이름으로 쓴다.
 * - 쓰기 뒤·마지막 상태 저장 전에 죽음: pending이 남아 crossSourceContextFromState가 아르고스 파일로 본다.
 * 카카오 알림 앱(Firestore) 문서는 기존대로 쓰기만 한다(머리말·파일명이 아니라 상태로 출처를 아는 쪽은 아르고스뿐).
 */
export function createArgosLedgerWriter({ stateFile, state, records, argosWritten, nowMs, write = writeAtomic }) {
  return (id, filepath, content) => {
    if (!isArgosDocId(id)) { write(filepath, content); return; }
    state.pending = { ...(state.pending ?? {}), [id]: { at: new Date(nowMs).toISOString(), path: filepath } };
    saveArgosState(stateFile, state, nowMs);
    argosWritten.add(filepath);
    write(filepath, content);
    records[id] = { ...records[id], written: filepath };
  };
}

/**
 * 실행 끝: 처리한 문서를 processed로 옮긴다. 이번 실행에 쓴 파일이 없어도 지난 실행의 쓰기 의도가 남았고 그 파일이
 * 있으면 written으로 이어 붙인다(크래시 뒤 재실행은 기존 파일 존재로 건너뛰므로 records엔 written이 없다).
 * 처리한 문서의 의도는 지운다. 처리 못 한 문서의 의도는 그대로 둔다.
 */
export function settleArgosProcessed(state, ids, records, nowMs) {
  const at = new Date(nowMs).toISOString();
  const pending = { ...(state.pending ?? {}) };
  for (const id of ids) {
    const intent = pending[id];
    const written = records[id]?.written ?? (intent?.path && existsSync(intent.path) ? intent.path : undefined);
    state.processed[id] = { at, ...records[id], ...(written ? { written } : {}) };
    delete pending[id];
  }
  state.pending = pending;
}

/**
 * primary 보류 경고 대상 수: 처리 못 했고 장부 대상 알림인데 하루 넘게 남은 것. 조회 기간(2일)은 알림 시각 또는 맥
 * 수신 시각 중 늦은 쪽 기준으로 빠지므로 나이도 그 기준으로 센다(폰이 늦게 올린 알림이 첫 실행에 바로 경고되지 않게).
 * 체결 확인 대기에 들어간 건은 이미 오너에게 물었고 원문이 확인 기록에 있으므로 뺀다(매 실행 같은 경고 반복 방지).
 */
export function countAgingArgosDocs({ docs, done, nowMs, hasConfirmation = () => false, ageMs = DAY_MS }) {
  return (docs ?? []).filter((doc) => {
    if (done.has(doc.id) || hasConfirmation(doc.id)) return false;
    const seen = Math.max(doc.at, Number.isFinite(doc.receivedAt) ? doc.receivedAt : -Infinity);
    return nowMs - seen > ageMs && Boolean(classifyInvestmentNotification(doc.body, doc.ts));
  }).length;
}

/** 상태에서 짝 판정 문맥을 만든다: used(이미 짝지은 기록), argosWritten(아르고스가 쓴 장부 파일). */
export function crossSourceContextFromState(state) {
  const used = new Set();
  const argosWritten = new Set();
  for (const v of Object.values(state?.processed ?? {})) {
    if (v?.twin) used.add(v.twin);
    if (v?.written) argosWritten.add(v.written);
  }
  // 쓰기 의도만 남은 파일(크래시)도 아르고스 것으로 본다(createArgosLedgerWriter 불변식).
  for (const v of Object.values(state?.pending ?? {})) if (v?.path) argosWritten.add(v.path);
  return { used, argosWritten };
}

const kstMs = (ts) => Date.parse(`${String(ts ?? '').trim().replace(' ', 'T')}+09:00`);
const sameText = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
// 둘 다 값이 있을 때만 비교한다(한쪽 형식에 없는 칸은 판정에 쓰지 않는다).
const compatible = (a, b) => !String(a ?? '').trim() || !String(b ?? '').trim() || sameText(a, b);

function readMd(path) {
  try { return parseFrontmatter(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * 체결(주식·금현물)의 다른 출처 짝: 장부(Executions) 또는 계좌 확인 대기(ExecutionConfirmations).
 * 같아야 하는 것: 매매구분·종목명·수량·단가, 시각 차이 toleranceSec 이내. 둘 다 있으면 차수·주문번호·계좌번호도.
 */
export function findCrossSourceExecutionTwin({ docId, event, executionsDir, confirmations = [], argosWritten, used,
  toleranceSec = CROSS_SOURCE_TOLERANCE_SEC }) {
  const at = kstMs(event?.tradeDate);
  if (!Number.isFinite(at)) return null;
  const selfArgos = isArgosDocId(docId);
  const same = (o) => sameText(o.tradeType, event.tradeType) && sameText(o.stockName, event.stockName)
    && Number(o.quantity) === Number(event.quantity) && Number(o.price) === Number(event.price)
    && compatible(o.fillRound, event.fillRound) && compatible(o.orderNo, event.orderNo) && compatible(o.acctNo, event.acctNo);
  let best = null;
  const consider = (key, otherAt) => {
    const gap = Math.abs(otherAt - at);
    if (Number.isFinite(gap) && gap <= toleranceSec * 1000 && (!best || gap < best.gap)) best = { key, gap };
  };
  const days = new Set([-1, 0, 1].map((d) => kstTimestamp(at + d * DAY_MS).slice(0, 10)));
  const names = existsSync(executionsDir) ? readdirSync(executionsDir) : [];
  for (const name of names) {
    if (!name.endsWith('.md') || !days.has(name.slice(0, 10))) continue;
    const path = join(executionsDir, name);
    if (used.has(path)) continue;
    const fm = readMd(path);
    if (!fm || (fm.source && fm.source !== 'KAKAO')) continue; // API 정본 체결은 알림 출처가 아니다
    const otherArgos = argosWritten.has(path) || isArgosDocId(fm.sourceEventId);
    if (otherArgos === selfArgos || !same(fm)) continue;
    consider(path, kstMs(fm.tradeDate));
  }
  for (const record of confirmations) {
    const key = `confirmation:${record.id}`;
    // 장부까지 쓴 확인 건은 그 장부 파일이 짝 후보다(같은 체결을 두 번 세지 않게).
    if (record.ledgerFile || used.has(key) || isArgosDocId(record.firestoreDocId) === selfArgos || !same(record)) continue;
    consider(key, kstMs(record.receivedAt || record.tradeDate));
  }
  if (best) used.add(best.key);
  return best?.key ?? null;
}

/**
 * 체결 외 기록(배당·예수금 등)의 다른 출처 짝. 파일명 '날짜-시각-나머지.md'에서 나머지가 같고 시각 차이가
 * toleranceSec 이내인 다른 출처 파일. 날짜만 든 이름(펀드·환전)은 시각이 없어 이름이 같으면 기존 존재 검사가
 * 이미 막으므로 여기선 null. sameRecord(머리말)로 추가 확인(배당 계좌 원문 등).
 */
export function findCrossSourceRecordTwin({ docId, filename, dir, argosWritten, used, sameRecord = () => true,
  toleranceSec = CROSS_SOURCE_TOLERANCE_SEC }) {
  const m = LEDGER_NAME.exec(filename);
  if (!m || !existsSync(dir)) return null;
  const selfArgos = isArgosDocId(docId);
  const epoch = (date, t) => Date.parse(`${date}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}+09:00`);
  const at = epoch(m[1], m[2]);
  let best = null;
  for (const name of readdirSync(dir)) {
    const o = LEDGER_NAME.exec(name);
    if (!o || o[3] !== m[3] || name === filename) continue; // 같은 이름은 기존 존재 검사 몫
    const path = join(dir, name);
    if (used.has(path) || argosWritten.has(path) === selfArgos) continue;
    const gap = Math.abs(epoch(o[1], o[2]) - at);
    if (gap > toleranceSec * 1000 || (best && gap >= best.gap)) continue;
    const fm = readMd(path);
    if (fm && sameRecord(fm)) best = { path, gap };
  }
  if (best) used.add(best.path);
  return best?.path ?? null;
}

const RECORD_BUILDERS = {
  배당: (p) => buildDividendRecord(p),
  예수금: (p) => buildCashEventRecord(p),
  펀드적립: (p) => buildFundPurchaseRecord({ ...p, account: FUND_PURCHASE_ACCOUNT }),
  펀드평가: (p) => buildFundValuationRecord({ ...p, account: FUND_PURCHASE_ACCOUNT }),
  환전: (p) => buildExchangeRecord({ ...p, account: EXCHANGE_ACCOUNT }),
};

/**
 * 한 수신함 문서의 다른 출처 짝. 반환 { type, parsed, twin, record? }. type이 null이면 장부에 쓸 알림이 아님.
 * ctx: { dirs: { executions, confirmations?, 배당, 예수금, 펀드적립, 펀드평가, 환전 }, confirmations, argosWritten, used }
 */
export function findCrossSourceTwin(doc, ctx) {
  const hit = classifyInvestmentNotification(doc.body, doc.ts);
  if (!hit) return { type: null, parsed: null, twin: null };
  const { type, parsed } = hit;
  const base = { docId: doc.id, argosWritten: ctx.argosWritten, used: ctx.used };
  if (type === '체결' || type === '금현물') {
    const event = type === '체결' ? parsed
      : { tradeDate: parsed.date, tradeType: parsed.tradeType, stockName: parsed.stockName, quantity: parsed.qty, price: parsed.price, orderNo: parsed.orderNo };
    const twin = findCrossSourceExecutionTwin({ ...base, event, executionsDir: ctx.dirs.executions, confirmations: ctx.confirmations ?? [] });
    return { type, parsed, twin };
  }
  const record = RECORD_BUILDERS[type](parsed);
  const sameRecord = type === '배당' ? (fm) => compatible(fm.acctRaw, parsed.acctRaw) : undefined;
  const twin = findCrossSourceRecordTwin({ ...base, filename: record.filename, dir: ctx.dirs[type], sameRecord });
  return { type, parsed, twin, record };
}

/**
 * shadow 보고서의 한 줄 판정. 원문은 남기지 않는다(개인 알림일 수 있다) — 발신자·종류·짝 파일 이름만.
 * verdict: matched(다른 출처가 이미 장부·확인대기에 남김 → primary면 건너뜀) / api-covered(API가 정본이라 장부에 안 씀)
 *          / argos-only(primary였다면 새로 씀 — 카카오 알림 앱이 놓쳤거나 아직 안 들어온 것) / filtered(장부에 쓸 알림 아님)
 */
export function shadowVerdict(doc, ctx) {
  const r = findCrossSourceTwin(doc, ctx);
  const row = { id: doc.id, ts: doc.ts, sender: doc.sender ?? '', type: r.type };
  if (!r.type) return { ...row, verdict: 'filtered' };
  if (r.twin) return { ...row, verdict: 'matched', twin: r.twin.startsWith('confirmation:') ? r.twin : basename(r.twin) };
  if (r.type === '체결' || r.type === '금현물') {
    const route = classifyKakaoExecution({ kind: r.type === '금현물' ? 'gold' : 'stock', event: r.parsed, receivedAt: doc.ts, holdings: ctx.holdings ?? [] });
    if (route.action === 'exclude-api') return { ...row, verdict: 'api-covered' };
  }
  if (r.type === '예수금' && ctx.cashApiExcluded?.has(r.parsed.account)) return { ...row, verdict: 'api-covered' };
  if (r.record && existsSync(join(ctx.dirs[r.type], r.record.filename))) return { ...row, verdict: 'matched', twin: r.record.filename };
  return { ...row, verdict: 'argos-only' };
}

export function buildShadowReport(docs, ctx, nowMs) {
  const items = docs.map((doc) => shadowVerdict(doc, ctx));
  const counts = {};
  for (const item of items) counts[item.verdict] = (counts[item.verdict] ?? 0) + 1;
  return { generatedAt: new Date(nowMs).toISOString(), mode: 'shadow', lookbackDays: ARGOS_LOOKBACK_DAYS, counts,
    items: items.filter((i) => i.verdict !== 'filtered') };
}

export function shadowLogLine(report) {
  const c = report.counts;
  return `[argos-shadow] 최근 ${report.lookbackDays}일 아르고스 투자 알림 — 일치 ${c.matched ?? 0} · 아르고스만 ${c['argos-only'] ?? 0}`
    + ` · API 정본 ${c['api-covered'] ?? 0} · 걸러냄 ${c.filtered ?? 0} (장부 쓰기 없음)`;
}
