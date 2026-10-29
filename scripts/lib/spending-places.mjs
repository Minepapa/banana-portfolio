// 장소별 소비: 확정된 하루 동선(체류·이동)에 그날 지출을 시각으로 이어 파생 파일로 남긴다.
// - 데일리 동선 칸의 결제 가게 표시(route-activities)는 활동 분류가 되는 결제만 붙이고 등록 장소는 건너뛴다.
//   여기서는 표시와 별개로 모든 지출을 연결한다. 표시 규칙은 건드리지 않는다.
// - 원문(위치·지출 JSONL)은 읽기만 한다. 이 파일은 언제든 원문에서 다시 계산할 수 있는 파생값이다.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VAULT_PATHS, VAULT_REL } from './vault-paths.mjs';
import { PAYMENT_GRACE_MINUTES } from './route-activities.mjs';
import { writeAtomic } from './state-writer.mjs';

export const SPENDING_PLACES_SCHEMA = 1;
export const MOVE_PLACE = '이동 중';
export const NO_PLACE = '위치 없음';

export function spendingPlacesPath(date, root = VAULT_PATHS.root) {
  return join(root, ...VAULT_REL.spendingPlaces.split('/'), date.slice(0, 4), `${date}.json`);
}

// 체류 한 칸의 이름. 장소 위키에 등록된 곳이면 그 이름, 건물명·결제 가게로 이름이 붙었으면 그 이름,
// 아니면 주소(지번). 일정으로만 활동이 붙은 체류는 label이 "미등록: 주소" 그대로라 주소로 간다
// (같은 곳이 일정 유무에 따라 두 이름으로 갈리지 않게). "미등록: " 접두어는 데일리 표시용이라 뺀다.
function placeOf(entry) {
  if (entry.registered && entry.placeName) return { place: entry.placeName, placeKind: 'registered' };
  if (entry.kind === 'roam') return { place: String(entry.label ?? '일대 산책'), placeKind: 'area' };
  const label = String(entry.label ?? '');
  if ((entry.autoNamed || entry.activity) && label && !label.startsWith('미등록:')) return { place: label, placeKind: 'named' };
  const address = entry.address ?? String(entry.label ?? '').replace(/^미등록:\s*/, '');
  return { place: address || '이름 없는 곳', placeKind: 'area' };
}

// 결제 시각이 들어가는 칸을 고른다. 체류 안이 먼저, 그다음 체류 끝 직후 승인 유예, 마지막으로 이동 구간.
// (카드 승인이 가게를 나선 뒤 몇 분 늦게 찍히는 경우 — route-activities와 같은 유예값)
// 데일리에서 끝이 24:00으로 표시된 마지막 체류는 마지막 위치 점이 아니라 그날 자정까지로 본다
// (밤에 점이 끊겨도 집에 머문 것으로 확정한 체류 — 그 사이 결제가 '위치 없음'으로 빠지지 않게).
// 한계: computeRoute는 다음 날 점이 아예 없을 때도 24:00으로 둔다. 그날 밤 점 없이 외출해 결제하면 그 체류에 붙는다
// (데일리 표시와 같은 판단을 따른다).
// 체류와 이동 구간이 겹치는 드문 경우는 체류로 본다(route-activities 표시는 이동으로 건너뜀 — 여기는 금액을 어디엔가 묶는 게 목적).
export function linkPaymentsToRoute(route, payments, { date = null } = {}) {
  const dayEnd = date ? Date.parse(`${date}T00:00:00+09:00`) + 86_400_000 : NaN;
  const entries = (Array.isArray(route) ? route : []).map((entry) => ({ entry,
    start: Date.parse(entry.startAt),
    end: entry.end === '24:00' && Number.isFinite(dayEnd) ? dayEnd : Date.parse(entry.endAt) }))
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end));
  const stays = entries.filter(({ entry }) => entry.kind !== 'move');
  const moves = entries.filter(({ entry }) => entry.kind === 'move');
  const graceMs = PAYMENT_GRACE_MINUTES * 60_000;
  return payments.map((payment) => {
    const at = Date.parse(payment.at);
    const base = { at: payment.at, amount: payment.amount, merchant: payment.merchant ?? null,
      card: payment.card ?? null, category: payment.category ?? null };
    // 자동납부는 장소와 무관하므로 그 시각 체류·이동이 있어도 위치 없음이다.
    if (!Number.isFinite(at) || payment.autopay) return { ...base, where: 'none', place: NO_PLACE, placeKind: null };
    const inside = stays.find(({ start, end }) => at >= start && at <= end);
    // 이동 중이라도 앞 체류가 끝난 직후의 승인 유예면 그 체류로 본다(route-activities와 같은 우선순위).
    const grace = !inside && stays.find(({ end }) => at > end && at <= end + graceMs);
    const stay = (inside || grace)?.entry;
    const moving = !stay && moves.find(({ start, end }) => at > start && at < end);
    if (stay) {
      return { ...base, where: 'stay', ...placeOf(stay), activity: stay.activity ?? null,
        stayStart: stay.startAt, stayEnd: stay.endAt };
    }
    if (moving) return { ...base, where: 'move', place: MOVE_PLACE, placeKind: null };
    return { ...base, where: 'none', place: NO_PLACE, placeKind: null };
  });
}

// 같은 내용이면 다시 쓰지 않는다(LiveSync 부담). 반환: 쓴 경로 또는 null.
export function writeSpendingPlaces({ date, route, payments, root = VAULT_PATHS.root, write = writeAtomic }) {
  const path = spendingPlacesPath(date, root);
  const text = `${JSON.stringify({ schemaVersion: SPENDING_PLACES_SCHEMA, date,
    payments: linkPaymentsToRoute(route, payments, { date }) }, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return null;
  mkdirSync(dirname(path), { recursive: true });
  write(path, text);
  return path;
}

// 한 달치 파생 파일을 장소별로 묶는다. 파일이 없는 날은 days 밖이다(기록 시작 전·동선 실패).
export function summarizeMonthPlaces(month, root = VAULT_PATHS.root) {
  const dir = join(root, ...VAULT_REL.spendingPlaces.split('/'), month.slice(0, 4));
  const files = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.startsWith(`${month}-`) && name.endsWith('.json')).sort()
    : [];
  const byPlace = new Map();
  let moveAmount = 0;
  let noneAmount = 0;
  for (const name of files) {
    const day = name.slice(0, 10);
    const { payments = [] } = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    for (const payment of payments) {
      if (payment.where === 'move') { moveAmount += payment.amount; continue; }
      if (payment.where !== 'stay') { noneAmount += payment.amount; continue; }
      const current = byPlace.get(payment.place) ?? { place: payment.place, placeKind: payment.placeKind,
        days: new Set(), count: 0, amount: 0 };
      current.days.add(day);
      current.count += 1;
      current.amount += payment.amount;
      byPlace.set(payment.place, current);
    }
  }
  const places = [...byPlace.values()].map((entry) => ({ ...entry, days: entry.days.size }))
    .sort((first, second) => second.amount - first.amount || first.place.localeCompare(second.place));
  return { month, recordedDays: files.length, firstDay: files[0]?.slice(0, 10) ?? null,
    places, moveAmount, noneAmount };
}
