// IRP 잔고 증가 → "잔고 증가로 추정한 체결" 계획 — 순수 판정 + 작은 로컬 상태 파일 I/O.
//
// 배경(2026-11-07 오너 승인 "잔고로 알아내기"): IRP 체결조회 API(getIrpPensionExecutions,
// TTTC2201R)는 실거래 47회 내내 0건이라, 원장(Facts/Ledger/Executions)에 IRP 체결을 넣는 건
// 카카오 알림과 오너 수동 보충뿐이다. 알림이 빠지면 원장에 구멍이 나고 holdings-ledger-recon의
// IRP 외부 대사(카카오 원장 ↔ KIS 잔고)가 어긋난다. 반면 reconcile-irp(체결기준잔고 TTTC2202R)는
// 매번 정상이라, 그 잔고의 하루 순증가를 체결로 추정해 빈 곳만 채운다.
//
// 설계 — 하루 단위 순증감(실행마다의 증감이 아니라):
//   상태 = { day, open: 그날 처음 기준 보유, last: 그날 마지막으로 본 보유 }.
//   reconcile-irp가 돌 때마다 last를 갱신하고, 날짜가 바뀐 첫 실행에서 지난 날을 정산한다
//   (지난 날 last − open = 그날 순증가). 다음 날 정산하는 이유: ①카카오 알림이 체결 몇 분 뒤에
//   원장에 들어오므로 같은 날 바로 기록하면 알림과 이중 기록되는 경쟁이 생긴다 ②간헐적으로 이상한
//   잔고 응답이 와도 그날 마지막 값만 쓰므로 "줄었다가 다시 늘어난" 흔들림을 매수로 보지 않는다.
//
// 불변식:
//   1. 원장에 이미 같은 날·같은 종목의 IRP 매수가 있으면(카카오·수동 보충 manual-·이전 추정 기록
//      모두) 그 합이 순증가와 같을 때 기존 것을 인정하고 새로 쓰지 않는다. 합이 0도 아니고 순증가와도
//      다르면 추정하지 않고 경고만 한다(일부만 기록된 경우 나머지를 짐작하지 않는다).
//   2. 감소(매도·환매), 같은 날 원장 매도가 있는 종목, 처음 보는 종목(기준 보유 없음)은 기록하지 않고
//      경고만 한다 — 이번 범위는 증가(정기 적립 매수)뿐이다.
//   3. 이 모듈은 보유(State/Holdings)를 절대 건드리지 않는다. IRP 보유는 reconcile-irp가 KIS 잔고로
//      덮어쓰는 정본이고, update-holdings-from-executions는 IRP 매수 체결을 보유에 반영하지 않는다
//      (execution-source-policy·update-holdings-from-executions IRP 분기). 추정 체결은 원장에만 들어가
//      보유를 이중으로 늘리지 않는다.
//   4. 추정 기록은 항상 source=irp-balance-delta, estimated=true와 추정 설명(단가·시각)을 단다.
//      시각은 잔고 조회에서 처음 증가를 본 시각이지 실제 체결 시각이 아니다.
//   5. 상태 파일이 없거나 깨지면 지금 본 Vault 보유(덮어쓰기 전 = 직전 실행 값)를 기준으로 새로
//      시작한다. 상태를 잃으면 그날 추정을 놓칠 뿐 이중 기록은 생기지 않는다.
//   6. 정산 구간은 "그날"이 아니라 (기준 관측 시각, 마지막 관측 시각]이다(독립 리뷰 2026-11-07 HIGH —
//      잡이 평일 16:07 하루 한 번이면 시간외 체결은 앞날 날짜로 원장에 들어온다). 원장 대조(불변식 1)는
//      이 구간 안의 모든 IRP 체결로 한다. 시각 미상(00:00:00) 기록은 구간 양 끝 날짜 안이면 넣는다(합이
//      어긋나면 경고로 빠지는 쪽이 이중 기록보다 낫다). 구간 사이에 평일이 하나라도 끼었거나(관측 누락·
//      맥 잠듦·상태 저장 실패) 기준 관측 시각을 모르면 기록하지 않고 경고만 한다.
//   7. 추정 기록에는 구간(estimateWindowFrom/To)을 남긴다 — 나중에 그 구간에 든 카카오 매수가 들어오면
//      update-holdings-from-executions가 findOverlappingIrpEstimates로 찾아 경고한다(분할 도착은 수량
//      일치 중복 판정에 안 걸린다).
//
// vault-paths를 import하지 않는다(테스트가 정적 import해도 실제 볼트 경로를 읽지 않게).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { IRP_ACCOUNT_LABEL } from './account-resolver.mjs';

export const IRP_BALANCE_DELTA_SOURCE = 'irp-balance-delta';
export const IRP_BALANCE_DELTA_STATE_FILE = process.env.IRP_BALANCE_DELTA_STATE
  || join(homedir(), '.cache', 'banana-portfolio-v2', 'irp-balance-delta.json');
export const IRP_BALANCE_DELTA_NOTE = '잔고 증가로 추정한 체결 — 단가는 매입금액 변화(없으면 현재가)로 계산, 시각은 잔고 조회에서 처음 증가를 본 시각(실제 체결 시각 아님)';

const BROKER = '한국투자증권';

function holdingKeyOf(item) {
  return String(item.code || item.name || '').trim();
}

function snapshotOf(kh, observedAt) {
  return {
    name: kh.name, code: kh.code ?? '', qty: Number(kh.qty),
    invest: Number.isFinite(Number(kh.invest)) && kh.invest != null ? Number(kh.invest) : null,
    curPrice: Number.isFinite(Number(kh.curPrice)) && kh.curPrice != null ? Number(kh.curPrice) : null,
    observedAt,
  };
}

// 그날 처음 기준(open)과 달라진 첫 관측 시각을 이어 준다. 다시 같아지면 지운다.
function withFirstChange(current, open, previousLast, observedAt) {
  const result = {};
  for (const [key, snap] of Object.entries(current)) {
    const differs = !open[key] || open[key].qty !== snap.qty;
    const carried = previousLast?.[key]?.firstChangeAt ?? null;
    result[key] = { ...snap, firstChangeAt: differs ? (carried ?? observedAt) : null };
  }
  return result;
}

// 상태 파일이 없을 때의 기준 — 덮어쓰기 전 Vault 보유(직전 실행이 쓴 KIS 값)를 KIS 코드로 맞춘다.
// reconcile-irp buildIrpHoldingsPlan과 같은 매칭(ticker 먼저, 없으면 종목명).
function bootstrapOpen(kisHoldings, vaultIrpHoldings) {
  const byCode = new Map(vaultIrpHoldings.filter((h) => h.ticker).map((h) => [h.ticker, h]));
  const byName = new Map(vaultIrpHoldings.map((h) => [h.name, h]));
  const open = {};
  for (const kh of kisHoldings) {
    const existing = (kh.code && byCode.get(kh.code)) || byName.get(kh.name);
    if (!existing || !Number.isFinite(Number(existing.qty))) continue;
    open[holdingKeyOf(kh)] = {
      name: kh.name, code: kh.code ?? '', qty: Number(existing.qty),
      invest: Number.isFinite(Number(existing.invest)) && existing.invest != null ? Number(existing.invest) : null,
    };
  }
  return open;
}

// 한 번의 잔고 조회를 상태에 반영한다. 날짜가 바뀌었으면 지난 날 정산 대상(settle)을 돌려준다.
// kisHoldings는 비어 있지 않은 정상 응답만 넘긴다(빈 응답은 reconcile-irp가 suspiciousEmpty로 거른다).
export function observeIrpBalance(state, { today, observedAt, kisHoldings, vaultIrpHoldings = [] }) {
  const current = {};
  for (const kh of kisHoldings) {
    if (!Number.isFinite(Number(kh.qty))) continue;
    current[holdingKeyOf(kh)] = snapshotOf(kh, observedAt);
  }
  const valid = state && typeof state.day === 'string' && state.open && state.last;
  if (!valid) {
    const open = bootstrapOpen(kisHoldings, vaultIrpHoldings);
    return { state: { day: today, open, last: withFirstChange(current, open, null, observedAt) }, settle: null, bootstrapped: true };
  }
  if (state.day === today) {
    return { state: { day: today, open: state.open, last: withFirstChange(current, state.open, state.last, observedAt) }, settle: null };
  }
  if (state.day > today) {
    // 시계가 거꾸로 간 경우 — 정산하지 않고 상태도 바꾸지 않는다.
    return { state, settle: null, clockSkew: true };
  }
  // 날짜가 바뀌었다. 지난 날 마지막 관측이 오늘의 기준이 된다. 지난 날 마지막 응답에 없던 종목은
  // 이번 정산에서 감소 경고를 한 번 내고 기준에서 빠진다(매일 같은 경고가 반복되지 않게). 응답 일부
  // 결측이었다면 다음 날 "처음 보는 종목" 경고만 나고 기록은 하지 않는다(불변식 2).
  const nextOpen = {};
  for (const [key, snap] of Object.entries(state.last)) {
    nextOpen[key] = { name: snap.name, code: snap.code, qty: snap.qty, invest: snap.invest ?? null, observedAt: snap.observedAt ?? null };
  }
  return {
    state: { day: today, open: nextOpen, last: withFirstChange(current, nextOpen, null, observedAt) },
    settle: { day: state.day, open: state.open, last: state.last },
  };
}

function sameInstrument(record, snap) {
  const recordCode = String(record.stockCode ?? '').trim();
  if (recordCode && snap.code) return recordCode === snap.code;
  return String(record.stockName ?? '').trim() === snap.name;
}

function counted(record) {
  if (record.legacy === true || record.legacy === 'true') return false;
  if (record.duplicateOf) return false;
  if (record.holdingsApplied === 'duplicate-skipped') return false;
  return true;
}

function timeOf(ts) {
  const m = String(ts ?? '').match(/(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : '00:00:00';
}

// (from, to] 구간 판정. 시각 미상(00:00:00·시각 없음)은 날짜만으로 양 끝 포함(불변식 6).
export function tradeInWindow(tradeDate, from, to) {
  const ts = String(tradeDate ?? '');
  const date = ts.slice(0, 10);
  const time = ts.slice(11, 19);
  if (!from || !to || date.length !== 10) return false;
  if (!time || time === '00:00:00') return date >= from.slice(0, 10) && date <= to.slice(0, 10);
  return ts > from && ts <= to;
}

// 두 날짜 사이(양 끝 제외)에 평일이 있으면 true — 그 평일의 관측이 빠졌다는 뜻이다(공휴일은 모른다:
// 공휴일이 끼면 경고로 빠지는 보수적 방향).
function weekdayBetween(fromDate, toDate) {
  const cursor = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return true;
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  for (; cursor < end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) return true;
  }
  return false;
}

// 정산에 필요한 원장 날짜 목록 — 기준 관측일부터 정산일까지(최대 7일, 그보다 길면 어차피 경고로 빠진다).
export function ledgerDatesForSettle({ day, open = {} }) {
  const starts = Object.values(open).map((o) => String(o.observedAt ?? '').slice(0, 10)).filter((d) => d.length === 10 && d <= day);
  const start = starts.length ? starts.sort()[0] : day;
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  while (dates.length < 7) {
    const date = cursor.toISOString().slice(0, 10);
    if (date > day) break;
    dates.push(date);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (!dates.includes(day)) dates.push(day);
  return dates;
}

// 이미 원장에 있는 추정 기록 중, 들어온 IRP 매수(카카오·수동)가 그 구간 안에 드는 것(불변식 7).
export function findOverlappingIrpEstimates(exec, ledgerExecutions) {
  if (exec.account !== IRP_ACCOUNT_LABEL || exec.tradeType !== '매수' || exec.source === IRP_BALANCE_DELTA_SOURCE) return [];
  return ledgerExecutions.filter((record) => record.source === IRP_BALANCE_DELTA_SOURCE
    && record.account === IRP_ACCOUNT_LABEL && counted(record)
    && sameInstrument(exec, { code: String(record.stockCode ?? '').trim(), name: String(record.stockName ?? '').trim() })
    && tradeInWindow(exec.tradeDate, record.estimateWindowFrom, record.estimateWindowTo));
}

function estimatePrice(open, last, delta) {
  if (open.invest != null && last.invest != null) {
    const price = (last.invest - open.invest) / delta;
    if (Number.isFinite(price) && price > 0) return { price: Math.round(price * 100) / 100, basis: '매입금액 변화' };
  }
  if (last.curPrice != null && last.curPrice > 0) return { price: last.curPrice, basis: '현재가' };
  return null;
}

// 정산: 지난 구간 순증가 중 원장에 없는 것만 추정 체결 입력으로 만든다.
// ledgerExecutions: 원장 체결 프론트매터들(ledgerDatesForSettle 날짜 것을 넘긴다. 구간 판정은 여기서 한다).
// 반환 records는 buildExecutionRecord 입력 모양(acctNo는 호출측이 채운다).
export function planIrpBalanceDeltaExecutions({ day, open = {}, last = {}, ledgerExecutions = [] }) {
  const records = [];
  const recognized = [];
  const warnings = [];
  const irpRows = ledgerExecutions.filter((record) => record.account === IRP_ACCOUNT_LABEL && counted(record));
  for (const key of new Set([...Object.keys(open), ...Object.keys(last)])) {
    const o = open[key];
    const l = last[key];
    if (!l) { warnings.push(`IRP ${o.name} — ${day} 마지막 잔고에 없음(감소·매도는 자동 기록 범위 밖, 확인 필요)`); continue; }
    if (!o) { warnings.push(`IRP ${l.name} — ${day} 처음 보는 종목(${l.qty}주), 기준 보유가 없어 자동 기록 안 함(확인 필요)`); continue; }
    const delta = l.qty - o.qty;
    if (!Number.isFinite(delta)) { warnings.push(`IRP ${l.name} — ${day} 수량을 숫자로 읽지 못함, 기록 안 함`); continue; }
    if (delta === 0) continue;
    if (delta < 0) { warnings.push(`IRP ${l.name} — ${day} 잔고 ${-delta}주 감소(매도·환매는 자동 기록 범위 밖, 확인 필요)`); continue; }
    const from = o.observedAt;
    const to = l.observedAt;
    if (!from || !to) {
      warnings.push(`IRP ${l.name} — ${day} 순증가 ${delta}주, 기준 관측 시각을 몰라(상태 새로 시작) 구간을 정할 수 없음 — 기록 안 함(확인 필요)`);
      continue;
    }
    if (weekdayBetween(from.slice(0, 10), to.slice(0, 10))) {
      warnings.push(`IRP ${l.name} — 순증가 ${delta}주가 ${from}~${to} 구간(거래일 하나를 넘음, 관측 누락)에 걸쳐 체결일을 정할 수 없음 — 기록 안 함(확인 필요)`);
      continue;
    }
    const rows = irpRows.filter((record) => sameInstrument(record, l) && tradeInWindow(record.tradeDate, from, to));
    if (rows.some((record) => record.tradeType === '매도')) {
      warnings.push(`IRP ${l.name} — ${day} 원장에 매도가 있어 순증가 ${delta}주를 매수로 추정하지 않음(확인 필요)`);
      continue;
    }
    const ledgerBuyQty = rows.filter((record) => record.tradeType === '매수')
      .reduce((sum, record) => sum + (Number(record.quantity) || 0), 0);
    if (ledgerBuyQty === delta) {
      recognized.push({ day, name: l.name, quantity: delta, sources: rows.map((record) => record.source ?? '') });
      continue;
    }
    if (ledgerBuyQty !== 0) {
      warnings.push(`IRP ${l.name} — ${day} 잔고 순증가 ${delta}주 ≠ 원장 매수 ${ledgerBuyQty}주, 추정하지 않음(확인 필요)`);
      continue;
    }
    const estimate = estimatePrice(o, l, delta);
    if (!estimate) { warnings.push(`IRP ${l.name} — ${day} 순증가 ${delta}주의 단가를 추정할 근거가 없어 기록 안 함`); continue; }
    records.push({
      tradeDate: `${day} ${timeOf(l.firstChangeAt ?? l.observedAt)}`,
      tradeType: '매수',
      stockCode: l.code ?? '',
      stockName: l.name,
      quantity: delta,
      price: estimate.price,
      currency: 'KRW',
      broker: BROKER,
      account: IRP_ACCOUNT_LABEL,
      source: IRP_BALANCE_DELTA_SOURCE,
      sourceEventId: `${IRP_BALANCE_DELTA_SOURCE}-${day}-${key}`,
      estimated: true,
      estimateNote: `${IRP_BALANCE_DELTA_NOTE} [단가 근거: ${estimate.basis}]`,
      estimateWindowFrom: from,
      estimateWindowTo: to,
    });
  }
  return { records, recognized, warnings };
}

export function readIrpBalanceDeltaState(path = IRP_BALANCE_DELTA_STATE_FILE) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

export function writeIrpBalanceDeltaState(state, path = IRP_BALANCE_DELTA_STATE_FILE) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

// 소급 미리보기용 — reconcile-irp 로그(launchd stdout)에서 잔고 관측을 되살린다. 로그에는 매입금액이
// 없어 평단가×수량으로 대신한다(평단가가 원 단위로 반올림돼 있어 단가 추정은 더 거칠다).
// 한 실행 블록: "+ [예수금] IRP {시각} 잔고 …" 다음의 "[종목] IRP {이름} {수량}주 @{평단}원" 줄들.
// 예수금 줄이 없는 블록(예수금 0·조회 실패)은 시각을 알 수 없어 버린다.
const LOG_CASH_LINE = /\[예수금(?:\(예정\))?\] IRP (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) 잔고/;
const LOG_HOLDING_LINE = /\[종목(?:\(예정\))?\] IRP (.+) (\d+(?:\.\d+)?)주 @(-?\d+(?:\.\d+)?)원/;
const LOG_BLOCK_END = /^(?:🫀 reconcile-irp|✅ IRP 종목|▶ )/;

export function parseReconcileIrpLog(text) {
  const observations = [];
  let current = null;
  const close = () => {
    if (current?.observedAt && current.holdings.length) observations.push(current);
    current = null;
  };
  for (const line of String(text).split('\n')) {
    const cash = line.match(LOG_CASH_LINE);
    if (cash) { close(); current = { observedAt: cash[1], holdings: [] }; continue; }
    const holding = line.match(LOG_HOLDING_LINE);
    if (holding && current) {
      const qty = Number(holding[2]);
      const avgPrice = Number(holding[3]);
      current.holdings.push({ code: '', name: holding[1].trim(), qty, invest: avgPrice * qty, curPrice: avgPrice });
      continue;
    }
    if (LOG_BLOCK_END.test(line.trim())) close();
  }
  close();
  return observations.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
}

// 관측 목록을 실제 잡과 같은 observeIrpBalance로 흘려 날짜별 정산 대상을 만든다. 마지막 관측일은
// 그 뒤 관측이 없어 정산되지 않으므로, through(오늘)보다 이전이면 그날도 정산한다(오늘은 하지 않는다 —
// 그날 알림이 아직 들어올 수 있다).
export function settlesFromObservations(observations, { through = '' } = {}) {
  let state = null;
  const settles = [];
  for (const { observedAt, holdings } of observations) {
    const result = observeIrpBalance(state, {
      today: observedAt.slice(0, 10), observedAt, kisHoldings: holdings, vaultIrpHoldings: state ? [] : holdings,
    });
    state = result.state;
    if (result.settle) settles.push(result.settle);
  }
  if (state && through && state.day < through) settles.push({ day: state.day, open: state.open, last: state.last });
  return settles;
}
