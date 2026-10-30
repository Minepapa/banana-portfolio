// 소비 보고 1단계(Requests "소비 보고 카드별·항목별·고정비", 2026-10-31 오너 지시): 알림과 뱅크샐러드를 잇는 표의 후보를 만든다.
// - 카드 표: 알림의 카드사·카드번호 일부 ↔ 뱅크샐러드 결제수단(카드 상품 이름). 같은 날(±1일)·같은 금액 거래로 표를 모은다.
// - 항목 표: 뱅크샐러드 1년 치에서 가맹점마다 가장 많이 붙은 대분류/소분류. 알림 가맹점 이름은 뱅크샐러드와 조금씩 달라
//   ("KT통신요금" ↔ "KT통신요금 자동납부") 정규화 뒤 같음·포함으로 찾는다. 못 찾으면 null(미분류)로 두고 묻는다.
// - 고정비 후보: 같은 가맹점·같은 결제수단이 여러 달 비슷한 날·비슷한 금액으로 나간 것.
// 모두 후보다. 확정은 오너 확인을 거쳐 소비 설정 파일에 남긴다(새 볼트 경로 없음). 원본은 읽기만 한다.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DAY_MS = 86_400_000;
// 카드 짝은 이 이상 겹치고 과반일 때만 후보로 낸다(한두 건 우연 일치 배제).
export const CARD_MIN_MATCHES = 2;
export const FIXED_MIN_MONTHS = 4;
// 결제일이 달마다 이 폭 안에서 움직여야 고정비로 본다(주말·공휴일 밀림 포함).
export const FIXED_MAX_DAY_SPREAD = 6;
// 금액이 가운데 값에서 이 비율 넘게 벗어나는 달이 있으면 고정비가 아니다(관리비처럼 계절로 크게 바뀌는 것은 오너 확인으로 넣는다).
export const FIXED_MAX_AMOUNT_RATIO = 0.25;

// 기간이 가장 늦게 끝나는 내보내기 폴더의 분류 결과를 읽는다. 폴더 이름은 `{시작일}_{종료일}`(경로 등록부).
export function readBanksaladTransactions(spendingDir) {
  const root = join(spendingDir, 'Banksalad');
  if (!existsSync(root)) return { folder: null, transactions: [] };
  const folders = readdirSync(root).filter((name) => /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/.test(name)
    && existsSync(join(root, name, 'classified-report.json'))).sort((a, b) => a.slice(11).localeCompare(b.slice(11)));
  const folder = folders.at(-1);
  if (!folder) return { folder: null, transactions: [] };
  const report = JSON.parse(readFileSync(join(root, folder, 'classified-report.json'), 'utf8'));
  return { folder, transactions: (report.transactions ?? []).filter((row) => row.classification === 'expense') };
}

export function normalizeMerchant(name) {
  return String(name ?? '').replace(/\(?자동납부\)?/g, '').replace(/\(주\)|㈜|주식회사/g, '')
    .replace(/[\s_()\-.·]/g, '').toLowerCase();
}

export function buildMerchantIndex(transactions) {
  const index = new Map();
  for (const row of transactions) {
    const key = normalizeMerchant(row.description);
    if (!key) continue;
    const counts = index.get(key) ?? new Map();
    // 대분류 이름 자체에 /가 있어("카페/간식") 문자열로 잇지 않고 배열 JSON을 키로 쓴다.
    const category = JSON.stringify([row.original_category, row.original_subcategory]);
    counts.set(category, (counts.get(category) ?? 0) + 1);
    index.set(key, counts);
  }
  return index;
}

// 가맹점 → { category, subcategory, count, share, via }. 오너가 정한 것(overrides)이 먼저다.
export function categoryFor(merchant, index, overrides = {}) {
  const key = normalizeMerchant(merchant);
  if (!key) return null;
  if (overrides[key]) return { ...overrides[key], via: 'owner' };
  let counts = index.get(key);
  let via = 'exact';
  if (!counts) {
    // 한쪽 이름이 다른 쪽을 품으면 같은 가게로 본다. 너무 짧은 이름(3자 미만)은 우연 일치가 많아 제외한다.
    const partial = [...index.entries()].filter(([other]) => Math.min(other.length, key.length) >= 3
      && (other.includes(key) || key.includes(other)));
    if (!partial.length) return null;
    counts = new Map();
    for (const [, each] of partial) for (const [category, count] of each) counts.set(category, (counts.get(category) ?? 0) + count);
    via = 'partial';
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const [top, count] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const [category, subcategory] = JSON.parse(top);
  return { category, subcategory, count, share: Math.round(count / total * 100) / 100, via };
}

const kstDate = (at) => new Date(Date.parse(at) + 9 * 3_600_000).toISOString().slice(0, 10);
export const cardKey = (entry) => `${entry.card ?? ''}|${entry.cardMask ?? entry.cardLast4 ?? ''}`;

export function cardCandidates(alertEntries, transactions) {
  const byKey = new Map();
  for (const entry of alertEntries) {
    if (entry.status !== 'expense' || !entry.card || !Number.isFinite(entry.amount) || !Number.isFinite(Date.parse(entry.at))) continue;
    const day = Date.parse(kstDate(entry.at));
    const matches = transactions.filter((row) => Math.abs(Date.parse(row.date) - day) <= DAY_MS
      && Number(row.signed_amount) === -entry.amount);
    const current = byKey.get(cardKey(entry)) ?? { key: cardKey(entry), card: entry.card,
      mask: entry.cardMask ?? entry.cardLast4 ?? null, alerts: 0, votes: new Map() };
    current.alerts += 1;
    // 알림 한 건은 결제수단마다 한 표만 준다(같은 날 같은 금액을 두 번 쓴 경우 한 건이 두 표가 되지 않게).
    for (const instrument of new Set(matches.map((row) => row.payment_instrument))) {
      current.votes.set(instrument, (current.votes.get(instrument) ?? 0) + 1);
    }
    byKey.set(current.key, current);
  }
  return [...byKey.values()].map((entry) => {
    const ranked = [...entry.votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const total = ranked.reduce((sum, [, count]) => sum + count, 0);
    const [instrument, count] = ranked[0] ?? [null, 0];
    const confident = count >= CARD_MIN_MATCHES && count * 2 > total;
    return { key: entry.key, card: entry.card, mask: entry.mask, alerts: entry.alerts,
      instrument: confident ? instrument : null, votes: Object.fromEntries(ranked) };
  }).sort((a, b) => b.alerts - a.alerts || a.key.localeCompare(b.key));
}

export function fixedCostCandidates(transactions, { minMonths = FIXED_MIN_MONTHS } = {}) {
  const groups = new Map();
  for (const row of transactions) {
    const key = `${normalizeMerchant(row.description)}|${row.payment_instrument}`;
    const group = groups.get(key) ?? { merchant: row.description, instrument: row.payment_instrument, rows: [] };
    group.rows.push({ date: row.date, amount: -Number(row.signed_amount) });
    groups.set(key, group);
  }
  const candidates = [];
  for (const group of groups.values()) {
    const byMonth = new Map();
    for (const row of group.rows) {
      const month = row.date.slice(0, 7);
      byMonth.set(month, [...(byMonth.get(month) ?? []), row]);
    }
    // 한 달에 여러 번 나간 달이 절반을 넘으면(교통·주차) 고정비가 아니다. 가끔 한 번 더 나간 달은 그 달만 뺀다.
    const multiMonths = [...byMonth.values()].filter((rows) => rows.length > 1).length;
    if (multiMonths * 2 > byMonth.size) continue;
    const monthly = [...byMonth.values()].filter((rows) => rows.length === 1).map(([row]) => row);
    if (monthly.length < minMonths) continue;
    // 결제일은 원형으로 비교한다(말일 결제가 주말로 1일에 밀려도 같은 날 무리로 본다).
    const days = monthly.map((row) => Number(row.date.slice(8, 10)));
    const dayGap = (first, second) => Math.min(Math.abs(first - second), 31 - Math.abs(first - second));
    if (days.some((day) => days.some((other) => dayGap(day, other) > FIXED_MAX_DAY_SPREAD))) continue;
    const amounts = monthly.map((row) => row.amount).sort((a, b) => a - b);
    const middle = amounts[amounts.length >> 1];
    if (amounts.some((amount) => Math.abs(amount - middle) > middle * FIXED_MAX_AMOUNT_RATIO)) continue;
    const latest = monthly.map((row) => row.date).sort().at(-1);
    candidates.push({ merchant: group.merchant, instrument: group.instrument, months: monthly.length,
      dayFrom: Math.min(...days), dayTo: Math.max(...days), amount: middle,
      amountMin: amounts[0], amountMax: amounts.at(-1), lastDate: latest });
  }
  return candidates.sort((a, b) => b.amount - a.amount || a.merchant.localeCompare(b.merchant));
}
