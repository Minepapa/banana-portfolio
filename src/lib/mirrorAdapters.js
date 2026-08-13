// Firestore mirror/* 7종 문서 → 화면 전용 모양 변환 — 순수 함수(App.jsx 7탭 재배선,
// 2026-08-13). v2는 읽기 전용(useFirestoreMirror.js 참고)이라 여기서도 아무것도 쓰지
// 않는다 — 파생 계산만 한다.
import { DEFAULT_ACCOUNTS } from './constants.js';

// mirror/holdings.items(계좌 구분 없는 평평한 배열) → 계좌별로 묶어 DEFAULT_ACCOUNTS의
// 화면 메타(라벨·색상)와 합친다. 필드명은 기존 화면 코드가 기대하던 이름으로 맞춘다
// (price/eval/profit/rate — avgPrice/evalAmount/profitAmount/profitPct의 화면용 별칭).
export function accountsFromMirror(holdingsMirror) {
  const items = holdingsMirror?.items ?? [];
  const accounts = {};
  for (const [key, meta] of Object.entries(DEFAULT_ACCOUNTS)) {
    const rows = items.filter((h) => h.account === key);
    const total_invest = rows.reduce((s, h) => s + (h.avgPrice * h.qty || 0), 0);
    const total_eval = rows.reduce((s, h) => s + (h.evalAmount || 0), 0);
    accounts[key] = {
      label: meta.label, sub: meta.sub, color: meta.color,
      total_invest, total_eval, profit: total_eval - total_invest,
      holdings: rows.map((h) => {
        const invest = h.avgPrice * h.qty || 0;
        return {
          name: h.name, type: h.assetClass || '', isCashLike: !!h.isCashLike,
          price: h.avgPrice, qty: h.qty, invest,
          currentPrice: h.curPrice, eval: h.evalAmount,
          profit: h.profitAmount ?? (h.evalAmount - invest),
          rate: h.profitPct ?? (invest > 0 ? ((h.evalAmount - invest) / invest) * 100 : 0),
        };
      }),
    };
  }
  return accounts;
}

// mirror/allocation.accounts(계좌×자산군 flat 배열) + mirror/holdings(자산군별 평가금
// 합산용) → RebalanceTab이 기대하는 acct.assets 배열. DEFAULT_ACCOUNTS의 자산군
// 목록(순서 포함)이 정본 — allocation 미러에 없는 자산군은 0으로 채운다(추정 아님,
// "아직 그 자산군 배분 기록이 없다"는 사실 그대로).
export function rebalanceAccountFromMirror({ allocationMirror, holdingsMirror, acctKey }) {
  const meta = DEFAULT_ACCOUNTS[acctKey];
  const allocRows = (allocationMirror?.accounts ?? []).filter((r) => r.account === acctKey);
  const holdingRows = (holdingsMirror?.items ?? []).filter((h) => h.account === acctKey);
  const total_invest = holdingRows.reduce((s, h) => s + (h.avgPrice * h.qty || 0), 0);
  const total_eval = holdingRows.reduce((s, h) => s + (h.evalAmount || 0), 0);
  const assets = meta.assets.map((a) => {
    const row = allocRows.find((r) => r.assetName === a.name);
    const evalSum = holdingRows
      .filter((h) => (h.assetClass || '') === a.name)
      .reduce((s, h) => s + (h.evalAmount || 0), 0);
    return {
      name: a.name,
      target: row?.targetPct ?? 0,
      ratio: row?.currentPct ?? 0,
      rebalAmt: row?.rebalAmt ?? 0,
      eval: evalSum,
    };
  });
  return { label: meta.label, sub: meta.sub, color: meta.color, total_invest, total_eval, profit: total_eval - total_invest, assets };
}

function monthKey(dateStr) {
  return String(dateStr ?? '').slice(0, 7); // "YYYY-MM"
}

// mirror/dividends.items({date, name, amount, ...}) → 월별 그룹(연·월 오름차순).
export function monthlyDividendsFromMirror(dividendsMirror) {
  const items = dividendsMirror?.items ?? [];
  const groups = new Map();
  for (const it of items) {
    const key = monthKey(it.date);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => {
    const [year, month] = key.split('-').map(Number);
    return {
      year, month,
      amount: list.reduce((s, i) => s + (i.amount || 0), 0),
      items: list.map((i) => ({ name: i.name, amount: i.amount })),
    };
  });
}

// mirror/profits.items({date, stockName, profit, ...}) → 월별 그룹.
export function monthlyProfitsFromMirror(profitsMirror) {
  const items = profitsMirror?.items ?? [];
  const groups = new Map();
  for (const it of items) {
    const key = monthKey(it.date);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => {
    const [year, month] = key.split('-').map(Number);
    return {
      year, month,
      total: list.reduce((s, i) => s + (i.profit || 0), 0),
      items: list.map((i) => ({ name: i.stockName, profit: i.profit })),
    };
  });
}

// mirror/trades.items를 최신순으로 정렬만 — 나머지는 화면에서 그대로 사용.
export function sortedTradesFromMirror(tradesMirror) {
  const items = tradesMirror?.items ?? [];
  return [...items].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}
