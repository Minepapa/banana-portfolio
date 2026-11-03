// 보유(Holdings) ↔ 체결 원장(Ledger/Executions·FundPurchases) 재생 대조 — 순수 판정(읽기·쓰기·발송 없음).
//
// 배경(2026-11-03 플루토스 점검): 보유 파일은 정본이지만, 원장을 처음부터 다시 재생한 결과와
// 맞춰 보는 수단이 없었다. update-holdings-from-executions가 체결을 하나씩 누적 반영하므로
// 반영 누락·이중 반영·보유 파일 되돌아감·손 수정이 생겨도 다음 체결 전까지 아무도 모른다.
// holdings-revert-check는 "적용 키 목록"만 보고, tools/verify-holdings-replay는 기초 잔고를
// 사람이 넣어야 하는 수동 도구다. 이 모듈은 그 둘 사이를 매일 자동으로 메운다.
//
// 기준점(앵커) 설계 — 원장은 2026-05부터라 그 전 보유(기초 잔고)는 원장 밖에 있다. 그래서
//   보유 수량 = 기초 잔고 + Σ(반영된 체결의 부호 있는 수량)
// 이 성립해야 하고, 원장이 빠짐없이 기록되는 한 "기초 잔고 = 보유 − Σ체결"(이하 암묵 기초)은
// 시간이 지나도 변하지 않는 상수다. 처음 본 날의 암묵 기초를 기준점으로 저장해 두고, 이후에는
// 기대 수량 = 기준점 + Σ체결 과 실제 보유를 비교한다. 체결 없이 보유가 바뀌거나(되돌아감·손 수정)
// 보유 반영 없이 원장 행이 늘거나 지워지면 기준점이 어긋난다.
// 기준점이 없어도 잡을 수 있는 것: 암묵 기초가 음수(원장 매도가 보유보다 많음 — 매수 누락·매도
// 이중 기록), 하루 끝 잔고가 이력 중 음수(같은 이유, 또는 날짜 뒤바뀜).
//
// 불변식:
//   - 수량만 본다. 평가금액·평단가·현재가는 읽지 않는다(평가값이 정본 파일에 섞여 있어도 무관).
//   - 퀀트는 State/Holdings에 쓰지 않는다(KIS API 정본, update-holdings-from-executions 참고) — 대조하지 않는다.
//   - 현금성 보유(isCashLike: 예수금·CMA·외화RP 잔고)는 체결이 아니라 잔고 조회로 덮어쓰므로 대조하지 않는다.
//   - IRP는 보유를 KIS 잔고조회가 덮어쓰고 원장은 카카오가 유일 소스다. 그래서 IRP의 재생 대조는
//     "카카오 원장 ↔ API 잔고" 외부 대사가 된다(다른 계좌는 원장에서 만든 보유와의 내부 정합성).
//   - 반영 대상 판정은 tools/verify-holdings-replay.mjs compareHoldingsReplay와 같은 규칙이다
//     (legacy 제외, duplicateOf·duplicate-skipped는 보유 적용 키가 실제 반영을 증명할 때만 포함,
//     미반영은 따로 보고). 그 모듈은 vault-paths를 import 시점에 읽어 테스트 정적 import가 금지라
//     규칙만 같게 옮겨 왔다 — 한쪽을 바꾸면 다른 쪽도 같이 바꾼다.
//   - 중복은 추정으로 지우지 않는다. 같은 원천 ID·같은 dedupKey·같은 주문의 같은 차수처럼 확정적인
//     것만 "중복"으로, 날짜·시각·수량·가격만 같은 것은 "중복 의심"으로 따로 보고한다(같은 초·같은
//     수량의 별개 분할 체결이 실제로 있다 — update-holdings-from-executions 2026-10-29 버그 수정 주석 참고).
import { findEquivalentExecutions } from './execution-identity.mjs';
import { FUND_PURCHASE_ACCOUNT } from './account-resolver.mjs';
import { escapeHtml } from './telegram.mjs';

// 소수 수량(펀드 좌수·금 g·외화RP)은 부동소수 누적 오차가 있다. 정수 수량의 1주 차이는 항상 잡는다.
export const QTY_ABS_TOLERANCE = 0.001;
const QTY_REL_TOLERANCE = 1e-9;
// 아직 보유에 반영되지 않은 체결이 이 시간보다 오래되면 이상으로 본다(보유 반영 잡은 평일 16:05 + 장중 10분).
export const STALE_PENDING_MS = 24 * 60 * 60 * 1000;
// 오너가 실계좌로 확인해 손으로 넣은 체결(update-holdings-from-executions OWNER_CONFIRMED_SOURCE와 같은 값).
const OWNER_CONFIRMED_SOURCE = 'OWNER_CONFIRMED';
// 보유 파일을 쓰지 않는 계좌 — 체결은 원장에 있어도 보유와 대조할 대상이 없다.
const NOT_IN_HOLDINGS_ACCOUNTS = new Set(['퀀트']);

export function holdingKey(account, name) {
  return `${account}|${name}`;
}

export function qtyEqual(a, b) {
  const diff = Math.abs(Number(a) - Number(b));
  return diff <= Math.max(QTY_ABS_TOLERANCE, QTY_REL_TOLERANCE * Math.max(Math.abs(Number(a)), Math.abs(Number(b))));
}

function isNegative(value) {
  return value < 0 && !qtyEqual(value, 0);
}

// 저장·표시용 반올림(부동소수 꼬리 제거). 대조 판정은 qtyEqual로 한다.
export function roundQty(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

function parseKeys(holding) {
  try {
    const parsed = JSON.parse(holding?.appliedDedupKeys ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 보유 파일 목록 → 계좌|종목별 수량. 같은 키의 파일이 여럿이면(로트 통합 전) 합친다 —
// update-holdings-from-executions의 consolidateLots가 수량을 합산하는 것과 같다.
export function collectActualHoldings(holdings) {
  const actual = new Map();
  for (const holding of holdings) {
    if (!holding?.account || !holding.name || holding.isCashLike === true || holding.isCashLike === 'true') continue;
    if (NOT_IN_HOLDINGS_ACCOUNTS.has(holding.account)) continue;
    const key = holdingKey(holding.account, holding.name);
    const prev = actual.get(key) ?? { qty: 0, appliedKeys: new Set() };
    prev.qty += Number(holding.qty) || 0;
    for (const item of parseKeys(holding)) if (typeof item === 'string' && item) prev.appliedKeys.add(item);
    actual.set(key, prev);
  }
  return actual;
}

const dayOf = (tradeDate) => String(tradeDate ?? '').slice(0, 10);

// executions: 원장 체결(+ 펀드 매수를 같은 모양으로 바꾼 것) 프론트매터 + filename.
// anchors: { '계좌|종목': 기초 잔고 }. holdings: 보유 파일 프론트매터(재시도 증거 판정용).
export function replayHoldings(executions, anchors = {}, { holdings = [], now = Date.now(), stalePendingMs = STALE_PENDING_MS } = {}) {
  const actual = collectActualHoldings(holdings);
  const appliedRetryWitness = (record) => record.holdingsApplied === 'duplicate-skipped' && record.dedupKey
    && (actual.get(holdingKey(record.account, record.stockName))?.appliedKeys.has(record.dedupKey) ?? false);
  const rows = new Map();
  const pending = [];
  const unassigned = [];
  let notInHoldings = 0;
  for (const record of executions) {
    if (record.legacy === true || record.legacy === 'true') continue;
    const witnessed = appliedRetryWitness(record);
    if (record.duplicateOf && !witnessed) continue;
    if (record.holdingsApplied === 'duplicate-skipped' && !witnessed) continue;
    if (record.holdingsApplied !== true && !witnessed) {
      pending.push({ ...record, stale: now - (Date.parse(record.recordedAt) || now) > stalePendingMs });
      continue;
    }
    const quantity = Number(record.quantity);
    if (!record.account || !record.stockName || !Number.isFinite(quantity)
      || (record.tradeType !== '매수' && record.tradeType !== '매도')) {
      unassigned.push(record.filename ?? record.dedupKey ?? '(이름 없음)');
      continue;
    }
    if (NOT_IN_HOLDINGS_ACCOUNTS.has(record.account)) {
      notInHoldings += 1;
      continue;
    }
    const key = holdingKey(record.account, record.stockName);
    const row = rows.get(key) ?? { key, account: record.account, name: record.stockName, ledgerNet: 0, ledgerCount: 0, byDay: new Map() };
    const signed = (record.tradeType === '매도' ? -1 : 1) * quantity;
    row.ledgerNet += signed;
    row.ledgerCount += 1;
    const day = dayOf(record.tradeDate);
    row.byDay.set(day, (row.byDay.get(day) ?? 0) + signed);
    rows.set(key, row);
  }
  for (const key of Object.keys(anchors)) {
    if (!rows.has(key)) {
      const [account, ...rest] = key.split('|');
      rows.set(key, { key, account, name: rest.join('|'), ledgerNet: 0, ledgerCount: 0, byDay: new Map() });
    }
  }
  for (const row of rows.values()) {
    // 하루 끝 누적(기초 0 기준)의 최솟값 — 같은 날 안의 순서는 NH API 행이 00:00:00이라 믿지 않는다.
    let running = 0;
    let minRunning = 0;
    for (const day of [...row.byDay.keys()].sort()) {
      running += row.byDay.get(day);
      minRunning = Math.min(minRunning, running);
    }
    row.minRunningFromZero = minRunning;
    row.anchor = Object.hasOwn(anchors, row.key) ? Number(anchors[row.key]) : null;
    row.expected = row.anchor == null ? null : row.anchor + row.ledgerNet;
    delete row.byDay;
  }
  return { rows, pending, unassigned, notInHoldings, actual };
}

// 상태:
//   ok                — 기준점 대비 일치(또는 기준점이 없고 이상 신호도 없음 → seed 후보)
//   mismatch          — 기준점 + Σ체결 ≠ 보유
//   negative-opening  — 기준점 없음, 보유 − Σ체결 < 0(원장 매도가 보유보다 많음)
//   negative-history  — 기초 잔고로 시작해도 하루 끝 잔고가 이력 중 음수
//   new-anchor        — 기준점 없음, 기초 잔고가 0이 아님(처음 보면 정상, 기준점이 이미 있던 뒤라면 설명 안 되는 보유)
export function diffHoldings(replay, holdings = null) {
  const actual = holdings ? collectActualHoldings(holdings) : replay.actual;
  const keys = new Set([...replay.rows.keys(), ...actual.keys()]);
  const result = [];
  for (const key of [...keys].sort()) {
    const row = replay.rows.get(key) ?? (() => {
      const [account, ...rest] = key.split('|');
      return { key, account, name: rest.join('|'), ledgerNet: 0, ledgerCount: 0, minRunningFromZero: 0, anchor: null, expected: null };
    })();
    const actualQty = actual.get(key)?.qty ?? 0;
    const impliedOpening = actualQty - row.ledgerNet;
    const opening = row.anchor ?? impliedOpening;
    let status;
    if (row.anchor != null && !qtyEqual(actualQty, row.expected)) status = 'mismatch';
    else if (row.anchor == null && isNegative(impliedOpening)) status = 'negative-opening';
    else if (isNegative(opening + row.minRunningFromZero)) status = 'negative-history';
    else if (row.anchor == null && !qtyEqual(impliedOpening, 0)) status = 'new-anchor';
    else status = 'ok';
    result.push({
      key, account: row.account, name: row.name, status,
      anchor: row.anchor, ledgerNet: roundQty(row.ledgerNet), ledgerCount: row.ledgerCount,
      expected: roundQty(row.anchor == null ? row.ledgerNet : row.expected),
      actual: roundQty(actualQty), diff: roundQty(actualQty - (row.anchor == null ? row.ledgerNet : row.expected)),
      impliedOpening: roundQty(impliedOpening), minRunning: roundQty(opening + row.minRunningFromZero),
    });
  }
  return result;
}

// 펀드 적립 매수(FundPurchases)는 체결 원장과 모양이 달라(amount·units) 같은 모양으로 바꿔 재생한다.
// 보유 반영 잡(update-fund-holdings-from-purchases)이 account 없으면 FUND_PURCHASE_ACCOUNT로 넣는 것과 같다.
export function fundPurchaseAsExecution(purchase) {
  return {
    filename: purchase.filename, tradeDate: purchase.date, tradeType: '매수',
    stockName: purchase.fundName, quantity: Number(purchase.units),
    account: purchase.account || FUND_PURCHASE_ACCOUNT, holdingsApplied: purchase.holdingsApplied,
    dedupKey: purchase.dedupKey, recordedAt: purchase.recordedAt, source: 'FUND_PURCHASE',
  };
}

// 새 기준점: 기준점이 없던 종목 중 이상 신호가 없는 것만 지금 암묵 기초로 잡는다.
// 상태 파일이 이미 있던 뒤에 나타난 종목의 0이 아닌 기초는 "설명 안 되는 보유"라 잡지 않는다(경고 유지).
export function nextAnchors(rows, previous, { rebaseline = false, nowIso = new Date().toISOString() } = {}) {
  const anchors = rebaseline ? {} : { ...(previous?.anchors ?? {}) };
  const anchorsExisted = !rebaseline && previous != null;
  let seeded = 0;
  for (const row of rows) {
    if (Object.hasOwn(anchors, row.key)) continue;
    if (row.status === 'negative-opening' || row.status === 'negative-history') continue;
    if (anchorsExisted && row.status === 'new-anchor') continue;
    anchors[row.key] = roundQty(row.impliedOpening);
    seeded += 1;
  }
  return { state: { version: 1, updatedAt: nowIso, anchors }, seeded };
}

// 중복(확정)과 중복 의심. 이미 duplicateOf·duplicate-skipped로 표시된 기록은 처리 끝난 것이라 뺀다.
export function findExecutionDuplicates(executions) {
  const live = executions.filter((record) => record.legacy !== true && record.legacy !== 'true'
    && !record.duplicateOf && record.holdingsApplied !== 'duplicate-skipped');
  const nameOf = (record) => record.filename ?? record.dedupKey;
  const confirmed = [];
  const pairSeen = new Set();
  const pairKey = (a, b) => [nameOf(a), nameOf(b)].sort().join('\0');
  const groupBy = (reason, keyOf) => {
    const groups = new Map();
    for (const record of live) {
      const key = keyOf(record);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) pairSeen.add(pairKey(group[i], group[j]));
      }
      confirmed.push({ reason, records: group });
    }
  };
  groupBy('같은 원천 ID', (r) => (r.source && r.sourceEventId ? `${r.source}|${r.sourceEventId}` : null));
  groupBy('같은 dedupKey', (r) => r.dedupKey || null);
  // 같은 주문의 같은 차수가 두 번 — 차수가 없으면 같은 주문의 별개 분할 체결일 수 있어 묶지 않는다.
  groupBy('같은 주문·같은 차수', (r) => (r.orderNo && r.fillRound != null && r.fillRound !== ''
    ? [r.account, r.broker, r.orderNo, r.tradeType, r.stockCode || r.stockName, r.quantity, r.fillRound].join('|') : null));

  const suspected = [];
  for (let i = 0; i < live.length; i += 1) {
    const candidate = live[i];
    for (const other of findEquivalentExecutions(candidate, live.slice(i + 1))) {
      if (pairSeen.has(pairKey(candidate, other))) continue;
      // 오너가 확인해 넣은 행은 "다른 경로 기록과 별개"임을 오너가 확인한 것이다.
      if (candidate.source === OWNER_CONFIRMED_SOURCE || other.source === OWNER_CONFIRMED_SOURCE) continue;
      // 차수가 서로 다르면 같은 주문의 별개 분할 체결이다(알림 원문 "체결(N차)").
      if (candidate.fillRound != null && other.fillRound != null && String(candidate.fillRound) !== String(other.fillRound)) continue;
      const sameSourceDistinctEvent = candidate.source && candidate.source === other.source
        && candidate.sourceEventId && other.sourceEventId && candidate.sourceEventId !== other.sourceEventId;
      suspected.push({ reason: sameSourceDistinctEvent ? '같은 출처·다른 이벤트, 날짜·시각·수량·가격 같음' : '날짜·시각·수량·가격 같음', records: [candidate, other] });
    }
  }
  return { confirmed, suspected };
}

// 체결 원장 파일명 규칙(ledger-vault-writer buildExecutionRecord·migration-vault-writer와 같은 조립식).
// ledger-vault-writer는 vault-paths를 import 시점에 읽어 정적 import하지 않고 규칙만 옮긴다.
function sanitizeSegment(s) {
  return String(s ?? '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-') || '_';
}

export const FILENAME_RULES = Object.freeze({
  quantity: '수량 포함(현행, 2026-09-02~)',
  noQuantity: '수량 없음(구형, ~2026-09-02)',
  utcTime: 'UTC 시각(퀀트 체결 확인 경로)',
  v1Row: 'v1 시트 행번호(이관)',
  unknown: '규칙 밖(프론트매터와 안 맞음)',
});

export function classifyExecutionFilename(filename, record) {
  if (/-r\d+\.md$/.test(filename)) return 'v1Row';
  const tradeDate = String(record?.tradeDate ?? '');
  const datePart = tradeDate.slice(0, 10);
  const timePart = tradeDate.slice(11).replace(/:/g, '') || '000000';
  const head = `${sanitizeSegment(datePart)}-${sanitizeSegment(timePart)}-${sanitizeSegment(record?.tradeType)}-${sanitizeSegment(record?.stockName)}`;
  const utc = /^\d{6}\.\d{3}Z$/.test(timePart);
  const withQty = `${head}-${sanitizeSegment(record?.quantity)}`;
  if (filename === `${withQty}.md` || filename.startsWith(`${withQty}-`)) return utc ? 'utcTime' : 'quantity';
  if (filename === `${head}.md`) return utc ? 'utcTime' : 'noQuantity';
  return 'unknown';
}

// 알림 대상 이상만 고른다. 중복 의심·파일명 규칙은 로그·보고에만 남긴다(사람 확인 전 단정 금지).
export function selectAlertIssues({ rows, duplicates, pending, anchorsExisted }) {
  const quantityIssues = rows.filter((row) => row.status === 'mismatch' || row.status === 'negative-opening'
    || row.status === 'negative-history' || (anchorsExisted && row.status === 'new-anchor'));
  return {
    quantityIssues,
    confirmedDuplicates: duplicates.confirmed,
    stalePending: pending.filter((record) => record.stale),
  };
}

export function hasAlertIssues(issues) {
  return issues.quantityIssues.length > 0 || issues.confirmedDuplicates.length > 0 || issues.stalePending.length > 0;
}

// 같은 이상 묶음이면 같은 문자열 — 하루 1회 억제 키의 재료.
export function alertSignature(issues) {
  return [
    ...issues.quantityIssues.map((row) => `q:${row.key}:${row.status}:${row.diff}`),
    ...issues.confirmedDuplicates.map((dup) => `d:${dup.records.map((r) => r.filename ?? r.dedupKey).sort().join('+')}`),
    ...issues.stalePending.map((record) => `p:${record.filename ?? record.dedupKey}`),
  ].sort().join('\n');
}

// ── 텔레그램 표 ──
// 폰 고정폭 한 줄 폭(themis-risk-review PHONE_PRE_COLS 실측 44칸과 같은 값 — 그 파일은 잡 진입점이라 import하지 않는다).
const PHONE_PRE_COLS = 44;
const MIN_NAME_COLS = 18;
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    width += (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3)
      || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) ? 2 : 1;
  }
  return width;
}
function fitDisplay(text, width) {
  let out = '';
  for (const ch of String(text)) {
    if (displayWidth(out + ch) > width) return `${out.slice(0, -1)}…`;
    out += ch;
  }
  return out;
}

export function formatQty(value) {
  const n = Number(value);
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  // 큰 소수 수량(펀드 좌수)은 소수점이 폰 한 줄 폭만 잡아먹는다. 1,000 이상은 정수로 줄인다.
  return n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
}

const STATUS_SHORT = {
  mismatch: '기준점 대비 불일치', 'negative-opening': '원장 매도가 보유 초과',
  'negative-history': '이력 중 잔고 음수', 'new-anchor': '원장으로 설명 안 되는 새 보유',
};

// 숫자 칸을 앞(오른쪽 정렬), 한글이 든 이름 칸을 맨 끝에 둔다(CLAUDE.md 텔레그램 표 규칙, 2026-11-02 오너).
// 숫자 칸 값에는 한글을 넣지 않는다. 폭은 이스케이프 전 실제 글자로 재고, 패딩 뒤에 이스케이프한다.
export function buildQuantityTable(rows) {
  let header = ['기대', '실제', '차이'];
  let cells = rows.map((row) => [formatQty(row.expected), formatQty(row.actual), `${row.diff > 0 ? '+' : ''}${formatQty(row.diff)}`]);
  const widthsOf = () => header.map((title, i) => Math.max(displayWidth(title), ...cells.map((c) => c[i].length)));
  // 이름 칸이 너무 좁아지면(큰 수량) 기대 칸을 뺀다 — 기대 = 실제 − 차이라 정보는 그대로 남는다.
  if (PHONE_PRE_COLS - widthsOf().reduce((a, b) => a + b, 0) - header.length < MIN_NAME_COLS) {
    header = header.slice(1);
    cells = cells.map((c) => c.slice(1));
  }
  const widths = widthsOf();
  const nameWidth = Math.max(MIN_NAME_COLS, PHONE_PRE_COLS - widths.reduce((a, b) => a + b, 0) - widths.length);
  const pad = (text, width) => ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
  const line = (nums, name) => `${nums.map((text, i) => pad(text, widths[i])).join(' ')} ${fitDisplay(name, nameWidth)}`.trimEnd();
  const lines = [line(header, '계좌 종목'), ...rows.map((row, i) => line(cells[i], `${row.account} ${row.name}`))];
  return `<pre>${escapeHtml(lines.join('\n'))}</pre>`;
}

// 판단·이상 보고 4단 구조(결론·사실·맥락·의사결정). 문구는 스크립트 고정이라 llm:false.
export function buildReconMessage(issues) {
  const facts = [];
  if (issues.quantityIssues.length) {
    // 사유는 표 밖 한 줄로(이름 칸을 줄이지 않게). 같은 사유끼리 묶어 센다.
    const reasons = Object.entries(issues.quantityIssues.reduce((acc, row) => {
      const label = STATUS_SHORT[row.status] ?? row.status;
      return { ...acc, [label]: (acc[label] ?? 0) + 1 };
    }, {})).map(([label, count]) => `${label} ${count}`).join(' · ');
    facts.push(`수량 차이 ${issues.quantityIssues.length}종목(차이 = 실제 − 기대)\n${buildQuantityTable(issues.quantityIssues)}\n사유: ${reasons}`);
  }
  for (const dup of issues.confirmedDuplicates.slice(0, 5)) {
    const first = dup.records[0];
    facts.push(`중복 체결(${escapeHtml(dup.reason)}) ${dup.records.length}건\n${escapeHtml(`${String(first.tradeDate).slice(0, 10)} ${first.account ?? '계좌미상'} ${first.stockName} ${first.tradeType} ${formatQty(first.quantity)}`)}`);
  }
  if (issues.confirmedDuplicates.length > 5) facts.push(`중복 체결 외 ${issues.confirmedDuplicates.length - 5}묶음`);
  if (issues.stalePending.length) {
    const lines = issues.stalePending.slice(0, 5).map((r) => escapeHtml(`${String(r.tradeDate).slice(0, 10)} ${r.account ?? '계좌미상'} ${r.stockName} ${r.tradeType} ${formatQty(r.quantity)}`));
    if (issues.stalePending.length > lines.length) lines.push(`외 ${issues.stalePending.length - lines.length}건`);
    facts.push([`보유 미반영 체결 ${issues.stalePending.length}건(하루 넘음)`, ...lines].join('\n'));
  }
  return {
    agent: 'plutus', kind: '판단', topic: '경고', llm: false,
    conclusion: '보유 파일과 체결 원장 재생 결과가 맞지 않습니다.',
    facts,
    context: '보유 수량 = 기초 잔고 + 반영된 체결 합계여야 합니다. 기초 잔고는 처음 대조한 날 기준점으로 저장했고, 그 뒤 체결 없이 보유가 바뀌었거나 원장 행이 늘거나 빠지면 차이가 납니다. 이 잡은 읽기만 하고 고치지 않습니다.',
    decisions: [
      '증권사 앱 잔고와 대조해 실제 수량을 확인해 주세요.',
      '정정은 개발 세션이 원장 대조(verify-holdings-replay) 뒤 원장·보유를 함께 고치고 기준점을 다시 잡습니다.',
    ],
  };
}
