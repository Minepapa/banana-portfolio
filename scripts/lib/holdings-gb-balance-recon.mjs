// 위탁 해외주식 보유(Holdings) ↔ NH 해외주식 잔고(gbstock balance) 외부 대사 — 순수 판정(읽기·쓰기·발송 없음).
//
// 배경(2026-11-04 제우스): 위탁 해외주식은 원장 경로가 NH 일별거래내역(gbstock dailyTransaction) 게시 뒤에야
// 체결을 기록하는데, 그 게시가 체결 다음 날 이후다. 그래서 원장과 보유가 "함께" 빠지는 시차·누락이 생기고,
// 원장 ↔ 보유 내부 대조(holdings-ledger-recon.mjs)는 원리상 이걸 못 잡는다(둘 다 같은 원천이라 같이 빠진다).
// IRP가 카카오 원장 ↔ KIS 잔고로 외부 대사를 하는 것처럼, 위탁 해외주식은 보유 ↔ NH 잔고로 외부 대사를 한다.
//
// NH 잔고 한 행(Output_1, 2026-11-04 실측 필드):
//   cns_bse_bnc_qty — 체결기준 잔고 수량(아직 결제·게시 전 체결까지 포함)
//   byn_cns_qty     — 아직 게시 전으로 보이는 매수 체결 수량
//   sll_cns_qty     — 같은 성격의 매도 체결 수량
// 실측: 전날 밤 매수 2주가 dailyTransaction에 아직 없을 때 cns_bse_bnc_qty는 그 2주를 포함했고 byn_cns_qty가 2였다.
// 매도 쪽(cns_bse_bnc_qty가 미게시 매도를 이미 뺀 값인지, 전량 매도 뒤 잔고 0 행이 남는지)은 아직 실측 전이다 — 첫 매도 때
// 확인한다. 틀렸다면 매도 뒤 하루 이틀 '수량 차이' 거짓 경고로 드러난다(조용히 묻히지는 않는다).
// 그래서 "게시된 수량" = cns_bse_bnc_qty − byn_cns_qty + sll_cns_qty 로 보고,
//   보유 == 체결기준 잔고          → 일치
//   보유 == 게시된 수량(대기분 ≠ 0) → 게시 대기(원장·보유가 아직 따라오지 못함, 정상 시차)
//   그 밖                           → 수량 차이
// 로 나눈다. 게시 대기는 시작일을 상태로 기억해 평일 기준 2일을 넘게 계속되면 경고한다.
//
// 불변식:
//   - 감지만 한다. 보유·원장을 고치지 않는다(자동 정정 없음).
//   - 응답이 없거나·배열이 아니거나·비었거나·행 구조가 이상하면 판정하지 않고 '건너뜀'(사유 포함)으로 돌려준다.
//     부분 판정은 하지 않는다 — 몇 행만 읽고 나머지를 '보유에만 있음'으로 내보내면 거짓 경고가 된다.
//   - 건너뛴 날은 게시 대기 상태를 바꾸지 않는다(nextPendingState 없음 — 호출부가 쓰지 않는다).
//   - 수량만 본다(평단가·평가금액 무관). 비교는 holdings-ledger-recon qtyEqual(소수 수량 허용오차)을 쓴다.
//   - 대상 보유는 account '위탁' + assetClass '해외주식' + isCashLike 아님(외화RP·예수금은 다른 잡이 잔고로 덮어쓴다).
//   - 매칭 순서: ① 보유 ticker == NH iem_cd ② 원장 체결의 stockCode(같은 계좌|종목 키로 묶인 것, NH 일별거래내역의
//     iem_cd에서 ' US'를 뗀 값) == iem_cd ③ 보유 name == iem_nm(공백·NFC 정규화). 위탁 해외 보유는 ticker가 빈 경우가
//     많아 ②가 실질 주 경로다. 원장 코드가 둘 이상으로 갈리면 추정하지 않고 ③으로 내려간다. 어디에도 안 맞으면 '수량 차이'.
import { holdingKey, makeKeyResolver, qtyEqual, roundQty, formatQty, buildQuantityTable } from './holdings-ledger-recon.mjs';
import { escapeHtml } from './telegram.mjs';

export const GB_ACCOUNT = '위탁';
export const GB_ASSET_CLASS = '해외주식';
// 게시 대기가 평일 기준 이 일수를 넘게 계속되면 경고. 미국 결제(T+1) 뒤 NH 일별거래내역 게시까지 하루 더 걸린 실측이 있어
// 2일까지는 정상 시차로 본다.
export const GB_PENDING_ALERT_BUSINESS_DAYS = 2;

const normalizeText = (value) => String(value ?? '').trim().normalize('NFC');
// 이름 매칭용 — 공백 차이(연속 공백·앞뒤 공백)만 흡수한다. 대소문자·표기 차이는 합치지 않는다.
const normalizeName = (value) => normalizeText(value).replace(/\s+/g, ' ');
// NH 잔고 iem_cd는 ' US' 접미가 없고, 일별거래내역은 있다(nh-gbstock-execution normalizeGbStockCode와 같은 처리).
const normalizeCode = (value) => normalizeText(value).toUpperCase().replace(/\s+US$/, '');
const isCashLike = (holding) => holding?.isCashLike === true || holding?.isCashLike === 'true';

// NH 응답 숫자는 쉼표 포함 문자열일 수 있다(nh-gbstock-execution numberOrNull과 같은 규칙 — 빈 값은 0이 아니라 null).
function numberOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

// NH 잔고 응답 → 정규화 행. 하나라도 구조가 이상하면 전체를 건너뛴다(부분 판정 금지).
// byn_cns_qty·sll_cns_qty가 아예 없으면 0으로 본다(게시 대기 판정만 못 할 뿐 잔고 비교는 된다). 값이 있는데 숫자가
// 아니면 구조 이상이다.
export function parseGbBalanceRows(body) {
  if (body == null || typeof body !== 'object') return { ok: false, reason: '응답 없음' };
  const output = body.Output_1;
  if (output == null) return { ok: false, reason: '응답에 Output_1 없음' };
  if (!Array.isArray(output)) return { ok: false, reason: 'Output_1이 배열이 아님' };
  if (output.length === 0) return { ok: false, reason: '빈 응답(Output_1 0행)' };
  const rows = [];
  for (const [index, raw] of output.entries()) {
    if (raw == null || typeof raw !== 'object') return { ok: false, reason: `Output_1 ${index + 1}행이 객체가 아님` };
    const code = normalizeCode(raw.iem_cd);
    const name = normalizeName(raw.iem_nm);
    const balanceQty = numberOrNull(raw.cns_bse_bnc_qty);
    if (!code && !name) return { ok: false, reason: `Output_1 ${index + 1}행에 종목코드·종목명 없음` };
    if (balanceQty == null) return { ok: false, reason: `Output_1 ${index + 1}행 cns_bse_bnc_qty를 읽을 수 없음` };
    const optional = (field) => {
      if (raw[field] == null || String(raw[field]).trim() === '') return 0;
      return numberOrNull(raw[field]);
    };
    const buyPending = optional('byn_cns_qty');
    const sellPending = optional('sll_cns_qty');
    if (buyPending == null || sellPending == null) return { ok: false, reason: `Output_1 ${index + 1}행 byn_cns_qty·sll_cns_qty를 읽을 수 없음` };
    rows.push({ code, name, balanceQty, buyPending, sellPending });
  }
  return { ok: true, rows };
}

// 대상 보유 → 계좌|종목 키별 합(로트 파일이 여럿이면 합친다 — holdings-ledger-recon collectActualHoldings와 같은 규칙).
export function selectGbHoldings(holdings = []) {
  const byKey = new Map();
  for (const holding of holdings) {
    if (!holding?.name || normalizeText(holding.account) !== GB_ACCOUNT) continue;
    if (normalizeText(holding.assetClass) !== GB_ASSET_CLASS || isCashLike(holding)) continue;
    const key = holdingKey(holding.account, holding.name);
    const prev = byKey.get(key) ?? { key, name: normalizeText(holding.name), qty: 0, tickers: new Set() };
    prev.qty += Number(holding.qty) || 0;
    const ticker = normalizeCode(holding.ticker);
    if (ticker) prev.tickers.add(ticker);
    byKey.set(key, prev);
  }
  return [...byKey.values()];
}

// 원장 체결에서 위탁 계좌|종목 키 → 종목코드. 코드가 둘 이상으로 갈리면 null(추정하지 않는다).
export function ledgerCodesByKey(executions = [], holdings = []) {
  const keyOf = makeKeyResolver(holdings);
  const codes = new Map();
  for (const record of executions) {
    if (normalizeText(record?.account) !== GB_ACCOUNT || !record.stockName) continue;
    const code = normalizeCode(record.stockCode);
    if (!code) continue;
    const key = keyOf(record);
    if (!codes.has(key)) codes.set(key, new Set());
    codes.get(key).add(code);
  }
  return new Map([...codes].map(([key, set]) => [key, set.size === 1 ? [...set][0] : null]));
}

// KST 날짜(YYYY-MM-DD).
export function kstDay(now) {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

// fromDay 다음 날부터 toDay까지의 평일 수. 주말만 뺀다 — KRX 휴장일 달력은 미국 휴장일과 달라(추수감사절 등)
// 쓰면 오히려 틀린다. 미국 휴일이 끼면 하루 일찍 경고할 수 있는데, 늦게 알리는 것보다 낫다고 본다.
export function businessDaysBetween(fromDay, toDay) {
  const start = Date.parse(`${fromDay}T00:00:00Z`);
  const end = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  let count = 0;
  for (let t = start + 86_400_000; t <= end; t += 86_400_000) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

function classifyPair(holdingQty, nh) {
  if (qtyEqual(holdingQty, nh.balanceQty)) return 'match';
  const hasPending = !qtyEqual(nh.buyPending, 0) || !qtyEqual(nh.sellPending, 0);
  const postedQty = nh.balanceQty - nh.buyPending + nh.sellPending;
  if (hasPending && qtyEqual(holdingQty, postedQty)) return 'pending';
  return 'mismatch';
}

// holdings: 보유 파일 프론트매터. executions: 원장 체결(매칭 코드 재료). body: getGbBalance 응답(호출부가 이미 받아 온 것).
// pendingState: { pending: { 키: { since } } } — 이전 실행이 기억한 게시 대기 시작일. today: KST 날짜.
// 돌려주는 것: status 'ok'(판정함) 또는 'skipped'(reason). ok면 matched·pending·mismatches·stalePending·nextPendingState.
export function reconcileGbBalance({ holdings = [], executions = [], body, pendingState = null, today }) {
  const parsed = parseGbBalanceRows(body);
  if (!parsed.ok) return { status: 'skipped', reason: parsed.reason };
  const targets = selectGbHoldings(holdings);
  const ledgerCodes = ledgerCodesByKey(executions, holdings);
  const nhByCode = new Map();
  const nhByName = new Map();
  parsed.rows.forEach((row, index) => {
    if (row.code) nhByCode.set(row.code, [...(nhByCode.get(row.code) ?? []), index]);
    if (row.name) nhByName.set(row.name, [...(nhByName.get(row.name) ?? []), index]);
  });
  const used = new Set();
  // 같은 코드·이름 행이 여럿이면 합친다(같은 종목의 다른 잔고 구분일 수 있음 — 나눠 보면 양쪽 다 차이로 보인다).
  const sumRows = (indexes) => indexes.reduce((acc, index) => ({
    balanceQty: acc.balanceQty + parsed.rows[index].balanceQty,
    buyPending: acc.buyPending + parsed.rows[index].buyPending,
    sellPending: acc.sellPending + parsed.rows[index].sellPending,
  }), { balanceQty: 0, buyPending: 0, sellPending: 0 });
  const free = (indexes) => (indexes ?? []).filter((index) => !used.has(index));

  const items = [];
  for (const target of targets) {
    const codes = [...target.tickers];
    const ledgerCode = ledgerCodes.get(target.key) ?? null;
    let indexes = [];
    let matchedBy = null;
    // 로트 파일끼리 ticker가 갈리면 추정하지 않고 다음 단계로 내려간다.
    if (codes.length === 1) {
      indexes = free(nhByCode.get(codes[0]));
      if (indexes.length) matchedBy = 'ticker';
    }
    if (!indexes.length && ledgerCode) {
      indexes = free(nhByCode.get(ledgerCode));
      if (indexes.length) matchedBy = 'ledgerCode';
    }
    if (!indexes.length) {
      indexes = free(nhByName.get(normalizeName(target.name)));
      if (indexes.length) matchedBy = 'name';
    }
    for (const index of indexes) used.add(index);
    const nh = indexes.length ? sumRows(indexes) : null;
    if (!nh) {
      // 보유도 0이면(전량 매도 뒤 남은 파일) 비교할 것이 없다.
      if (qtyEqual(target.qty, 0)) continue;
      items.push({ key: target.key, name: target.name, holdingsQty: target.qty, nhQty: null, side: 'holdings-only', status: 'mismatch' });
      continue;
    }
    items.push({ key: target.key, name: target.name, holdingsQty: target.qty, nhQty: nh.balanceQty,
      buyPending: nh.buyPending, sellPending: nh.sellPending, matchedBy, status: classifyPair(target.qty, nh) });
  }
  parsed.rows.forEach((row, index) => {
    if (used.has(index)) return;
    // 잔고·대기분이 모두 0인 행(전량 매도 뒤 남은 행)은 비교 대상이 아니다.
    if (qtyEqual(row.balanceQty, 0) && qtyEqual(row.buyPending, 0) && qtyEqual(row.sellPending, 0)) return;
    const label = row.name || row.code;
    items.push({ key: holdingKey(GB_ACCOUNT, label), name: label, holdingsQty: null, nhQty: row.balanceQty,
      buyPending: row.buyPending, sellPending: row.sellPending, side: 'nh-only', status: classifyPair(0, row) });
  });
  items.sort((a, b) => a.key.localeCompare(b.key));

  const previous = pendingState?.pending ?? {};
  const nextPending = {};
  const stalePending = [];
  for (const item of items.filter((entry) => entry.status === 'pending')) {
    // 대기분이 바뀌어도(대기 중 새 체결) 시작일은 처음 대기를 본 날로 둔다 — 가장 오래 기다린 체결 기준으로 알린다.
    const since = typeof previous[item.key]?.since === 'string' ? previous[item.key].since : today;
    item.since = since;
    item.businessDays = businessDaysBetween(since, today);
    nextPending[item.key] = { since };
    if (item.businessDays > GB_PENDING_ALERT_BUSINESS_DAYS) stalePending.push(item);
  }
  return {
    status: 'ok',
    compared: items.length,
    matched: items.filter((item) => item.status === 'match'),
    pending: items.filter((item) => item.status === 'pending'),
    mismatches: items.filter((item) => item.status === 'mismatch'),
    stalePending,
    nextPendingState: { version: 1, pending: nextPending },
  };
}

// 볼트 사본 요약 칸. checkedAt은 사본 비교 키에서 뺀다(호출부 vaultCopyCompareKey).
export function buildGbSummary(result, checkedAt) {
  if (result.status !== 'ok') return { checkedAt, status: 'skipped', reason: result.reason };
  const brief = (item) => ({
    name: item.name, holdingsQty: item.holdingsQty == null ? null : roundQty(item.holdingsQty),
    nhQty: item.nhQty == null ? null : roundQty(item.nhQty),
  });
  return {
    checkedAt, status: 'ok', compared: result.compared,
    matched: result.matched.map(brief),
    pending: result.pending.map((item) => ({ ...brief(item), since: item.since, businessDays: item.businessDays })),
    mismatches: result.mismatches.map((item) => ({ ...brief(item), side: item.side ?? null })),
  };
}

export function hasGbAlertIssues(result) {
  return result?.status === 'ok' && (result.mismatches.length > 0 || result.stalePending.length > 0);
}

// 같은 이상이면 같은 문자열 — 하루 1회 억제 키의 재료(원장 대조 서명과 겹치지 않게 'gb' 접두).
export function gbAlertSignature(result) {
  return [
    ...result.mismatches.map((item) => `gb-m:${item.key}:${item.holdingsQty ?? '-'}:${item.nhQty ?? '-'}`),
    ...result.stalePending.map((item) => `gb-p:${item.key}:${item.since}`),
  ].sort().join('\n');
}

// 판단·이상 보고 4단 구조. 경고는 '수량 차이'와 '게시 대기 2영업일 초과' 두 종류뿐이다. 문구는 스크립트 고정이라 llm:false.
export function buildGbReconMessage(result) {
  const facts = [];
  if (result.mismatches.length) {
    // 표는 원장 대조 표를 그대로 쓴다: 기대 = 보유 파일, 실제 = NH 잔고(체결기준), 차이 = NH − 보유.
    const rows = result.mismatches.map((item) => {
      const expected = item.holdingsQty ?? 0;
      const actual = item.nhQty ?? 0;
      const mark = item.side === 'holdings-only' ? ' (NH 없음)' : item.side === 'nh-only' ? ' (보유 없음)' : '';
      return { account: GB_ACCOUNT, name: `${item.name}${mark}`, expected: roundQty(expected), actual: roundQty(actual), diff: roundQty(actual - expected) };
    });
    facts.push(`수량 차이 ${rows.length}종목(기대 = 보유 파일, 실제 = NH 잔고, 차이 = 실제 − 기대)\n${buildQuantityTable(rows)}`);
  }
  if (result.stalePending.length) {
    const lines = result.stalePending.map((item) => escapeHtml(
      `${item.name}: 보유 ${formatQty(item.holdingsQty ?? 0)} · NH ${formatQty(item.nhQty)} · ${item.since}부터 평일 ${item.businessDays}일`,
    ));
    facts.push([`게시 대기 ${GB_PENDING_ALERT_BUSINESS_DAYS}영업일 초과 ${result.stalePending.length}종목`, ...lines].join('\n'));
  }
  return {
    agent: 'plutus', kind: '판단', topic: '경고', llm: false,
    conclusion: '위탁 해외주식 보유 파일과 NH 해외주식 잔고가 맞지 않습니다.',
    facts,
    context: '위탁 해외주식은 NH 일별거래내역이 게시된 뒤에야 원장·보유에 들어가 하루 이틀 시차가 정상입니다. 시차로 설명되는 차이(NH 체결 대기분)는 2영업일까지 기다리고, 그 밖의 차이와 오래 남은 대기만 알립니다. 이 잡은 읽기만 하고 고치지 않습니다.',
    decisions: [
      'NH 앱 해외주식 잔고와 대조해 실제 수량을 확인해 주세요.',
      '정정은 개발 세션이 원장(일별거래내역 반영)과 보유를 함께 고칩니다.',
    ],
  };
}
