import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { VAULT_REL } from './vault-paths.mjs';

export const STAY_RADIUS_M = 150;
export const STAY_MIN_MINUTES = 15;
export const ANCHOR_GAP_MINUTES = 30;
export const ROAM_MIN_POINTS = 4;
export const ROAM_MIN_DISTANCE_M = 200;
export const ROAM_MAX_GAP_MINUTES = 30;
// 누적거리만 보면 실내에서 GPS가 20~30m씩 튀는 것도 산책이 된다. 점들이 실제로 퍼진 범위(가장 먼 두 점)를 함께 본다.
export const ROAM_MIN_EXTENT_M = 100;
export const MOVE_MAX_ACCURACY_M = 200;
export const MOVE_SHORT_STRAIGHT_M = 300;
export const MOVE_SHORT_PATH_M = 500;
export const MOVE_WALK_MAX_KMH = 7;
export const MOVE_VEHICLE_MIN_KMH = 20;
// 실측 차량 지속 속도는 27.4·55.7km/h, 도보는 3.5km/h였다. 정차가 섞인 평균은 차량도 11.5km/h까지 낮아진다.
export const MOVE_SUSTAINED_VEHICLE_MIN_KMH = 25;
export const MOVE_WINDOW_MIN_MINUTES = 3;
export const MOVE_WINDOW_MAX_MINUTES = 10;
// 실측 GPS 튐은 315km/h까지 나왔다. 직전 채택 점 기준으로 제거해야 거리와 최고 속도 모두 오염되지 않는다.
export const MOVE_OUTLIER_MAX_KMH = 150;
// 폰은 GPS 점과 거의 같은 시각에 망 위치(정확도 100m, 매번 같은 좌표)를 끼워 남기곤 한다. 앞뒤 점은 서로 같은 자리인데
// 그 사이 한 점이 앞뒤 중 더 정확한 점보다 정확도가 나쁘고 앞뒤 어느 쪽과도 정확도 범위가 겹치지 않으면 튄 점으로 보고 뺀다.
// 앞뒤 중 하나는 2분 안에 찍혀 있어야 한다(오래 비운 사이의 진짜 외출 점을 지우지 않게). 달리는 중에는 앞뒤 점이 멀어 해당하지 않는다.
// 2026-10-30 회사 체류가 900m 옆 망 위치로 붙어 "서울대학교"로 표시된 사고.
export const CONFLICT_WINDOW_SECONDS = 120;
// 같은 망 위치는 소수점 끝자리까지 같은 좌표로 하루에 여러 번 찍힌다(진짜 GPS는 같은 좌표가 반복되지 않는다).
// 이런 반복 좌표가 2분 안의 더 정확한 점과 정확도 범위를 넘게 어긋나면, 앞뒤 이웃과 상관없이 뺀다(떠나는 길 첫머리에 끼어든 망 위치).
export const NETWORK_FIX_MIN_ACCURACY_M = 100;
// 점이 끊긴 동안 어디 있었는지 모를 때는, 다음 점까지 걸어서 가는 데 필요한 시간만큼만 이동으로 본다.
// 가만히 있으면 폰이 점을 거의 남기지 않아 체류가 마지막 점에서 끊기고 공백 전체가 가짜 이동이 되던 문제(2026-10-29 회사 08:55~10:11).
export const GAP_WALK_KMH = 4;
// 다음 점이 이보다 멀면 늘리지 않는다. 폰은 멀리 움직이면 점을 남기므로, 긴 공백 뒤 첫 점이 가까우면 그동안 그 자리에 있었던 것이다.
// 다음 점이 멀면(폰이 꺼진 밤 뒤 집, 저녁 식당 등) 언제 떠났는지 모르니 "그 자리에 있었다"고 단정하지 않는다.
// 실사례: 회사 공백 76분·105분·4시간 뒤 첫 점이 170~300m(나서는 길).
// 알려진 한계: 폰이 꺼진 채 밤을 넘기고 다음 날 첫 점이 같은 곳 500m 안이면 그 사이도 체류로 본다(집에서 충전하면 집 점이 남아 드물다).
export const GAP_EXTEND_MAX_DISTANCE_M = 500;
// 같은 장소 체류 둘을 합칠 때, 그 사이 정확한 점 둘 이상이 반경 밖에 5분 넘게 있고 이만큼 멀리 나갔으면 외출로 남긴다.
// 정확도·시간 조건은 망 위치가 연달아 두 번 찍혀 생기는 0분짜리 가짜 외출을 막는다.
export const OUTING_MIN_DISTANCE_M = 300;
export const OUTING_MAX_ACCURACY_M = 50;
export const OUTING_MIN_MINUTES = 5;
const DAY_MS = 86_400_000;
const dayBounds = (date) => [Date.parse(`${date}T00:00:00+09:00`), Date.parse(`${date}T00:00:00+09:00`) + DAY_MS];
const validCoordinate = (lat, lon) => Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180;

export function readDayPoints(date, { root }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('날짜 형식 오류');
  const path = join(root, VAULT_REL.location, date.slice(0, 4), `${date}.jsonl`);
  if (!existsSync(path)) return { points: [], brokenLines: 0 };
  const points = [];
  let brokenLines = 0;
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    try {
      const point = JSON.parse(line);
      if (!validCoordinate(point.lat, point.lon) || !Number.isInteger(point.tst) || point.tst <= 0) throw new Error('invalid');
      if (point.acc != null && (!Number.isFinite(point.acc) || point.acc < 0)) throw new Error('invalid accuracy');
      if (point.acc == null || point.acc <= 200) points.push(point);
    } catch { brokenLines += 1; }
  }
  return { points: dropConflictingFixes(points), brokenLines };
}

// 망 위치 튄 점을 뺀다. 판정 근거는 위 CONFLICT_WINDOW_SECONDS·NETWORK_FIX_MIN_ACCURACY_M 주석.
// 반복 좌표 규칙을 먼저 적용해, 함께 지워질 망 위치가 앞뒤 기준점으로 쓰이지 않게 한다.
export function dropConflictingFixes(points) {
  const sorted = [...points].sort((first, second) => first.tst - second.tst);
  const coordinateKey = (point) => `${point.lat},${point.lon}`;
  const repeats = new Map();
  for (const point of sorted) repeats.set(coordinateKey(point), (repeats.get(coordinateKey(point)) ?? 0) + 1);
  const isContradictedNetworkFix = (point) => point.acc >= NETWORK_FIX_MIN_ACCURACY_M && repeats.get(coordinateKey(point)) >= 2
    && sorted.some((other) => other !== point && Number.isFinite(other.acc) && other.acc < point.acc
      && Math.abs(other.tst - point.tst) <= CONFLICT_WINDOW_SECONDS && haversineM(other, point) > other.acc + point.acc);
  const dropped = new Set(sorted.filter(isContradictedNetworkFix));
  const remaining = sorted.filter((point) => !dropped.has(point));
  for (let index = 1; index < remaining.length - 1; index += 1) {
    const [before, point, after] = [remaining[index - 1], remaining[index], remaining[index + 1]];
    if (![before, point, after].every((item) => Number.isFinite(item.acc))) continue;
    if (Math.min(point.tst - before.tst, after.tst - point.tst) > CONFLICT_WINDOW_SECONDS) continue;
    if (point.acc <= Math.min(before.acc, after.acc)) continue;
    // 걷는 속도 넘게 달리는 중이라고 기록된 점은 정상 주행 점이다.
    if (Number.isFinite(point.vel) && point.vel > MOVE_WALK_MAX_KMH) continue;
    // 앞뒤가 "같은 자리"라는 것은 정확도 합과 체류 반경 둘 다 안일 때만 믿는다(한쪽이 망 위치면 정확도 합이 커서 주행 중에도 참이 된다).
    if (haversineM(before, after) > Math.min(before.acc + after.acc, STAY_RADIUS_M)) continue;
    if (haversineM(before, point) > before.acc + point.acc && haversineM(point, after) > point.acc + after.acc) dropped.add(point);
  }
  return dropped.size ? points.filter((point) => !dropped.has(point)) : points;
}

export function withinOuting(stay, atMs) {
  return (stay.outings ?? []).some((outing) => atMs >= Date.parse(outing.startAt ?? outing.start)
    && atMs <= Date.parse(outing.endAt ?? outing.end));
}

export function haversineM(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDifference = radians(second.lat - first.lat);
  const longitudeDifference = radians(second.lon - first.lon);
  const arc = Math.sin(latitudeDifference / 2) ** 2 + Math.cos(radians(first.lat)) * Math.cos(radians(second.lat)) * Math.sin(longitudeDifference / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

function acceptedMovePoints(points) {
  const accepted = [];
  for (const point of points) {
    const previous = accepted.at(-1);
    if (previous) {
      const elapsedHours = (point.tst - previous.tst) / 3600;
      if (elapsedHours <= 0 || haversineM(previous, point) / 1000 / elapsedHours > MOVE_OUTLIER_MAX_KMH) continue;
    }
    accepted.push(point);
  }
  return accepted;
}

function sustainedSpeedKmh(points) {
  let fastest = null;
  for (let start = 0; start < points.length; start += 1) {
    for (let end = start + 1; end < points.length; end += 1) {
      const minutes = (points[end].tst - points[start].tst) / 60;
      if (minutes > MOVE_WINDOW_MAX_MINUTES) break;
      if (minutes < MOVE_WINDOW_MIN_MINUTES) continue;
      const speed = haversineM(points[start], points[end]) / 1000 / (minutes / 60);
      fastest = Math.max(fastest ?? 0, speed);
    }
  }
  return fastest;
}

export function movePaymentCoordinate(move, stays, points, at) {
  const start = Date.parse(move.start);
  const end = Date.parse(move.end);
  const validPoints = [...points].filter((point) => validCoordinate(point.lat, point.lon)
    && Number.isInteger(point.tst) && (point.acc == null || point.acc <= MOVE_MAX_ACCURACY_M))
    .sort((first, second) => first.tst - second.tst);
  const previousStay = stays.filter((stay) => Date.parse(stay.end) <= start).at(-1);
  const observedOrigin = previousStay && validPoints.filter((point) => point.tst * 1000 >= Date.parse(previousStay.start)
    && point.tst * 1000 <= start && haversineM(point, previousStay) <= STAY_RADIUS_M).at(-1);
  // 이전 체류에 원시 점이 없어도 체류 좌표를 기준점으로 삼아 첫 이동 점의 GPS 튐을 거른다.
  const origin = observedOrigin ?? (previousStay && validCoordinate(previousStay.lat, previousStay.lon)
    ? { lat: previousStay.lat, lon: previousStay.lon, tst: start / 1000 } : null);
  const candidates = validPoints.filter((point) => point.tst * 1000 > start && point.tst * 1000 <= end);
  const nearest = (origin ? acceptedMovePoints([origin, ...candidates]) : [])
    .filter((point) => point.tst * 1000 > start)
    .reduce((best, point) => !best || Math.abs(point.tst * 1000 - at) < Math.abs(best.tst * 1000 - at) ? point : best, null);
  if (nearest) return { lat: nearest.lat, lon: nearest.lon };
  const surrounding = stays.filter((stay) => Date.parse(stay.end) <= start || Date.parse(stay.start) >= end)
    .sort((first, second) => Math.min(Math.abs(Date.parse(first.start) - at), Math.abs(Date.parse(first.end) - at))
      - Math.min(Math.abs(Date.parse(second.start) - at), Math.abs(Date.parse(second.end) - at)))[0];
  return surrounding ? { lat: surrounding.lat, lon: surrounding.lon } : { lat: move.lat, lon: move.lon };
}

export function buildMoveSegments(stays, points, { date } = {}) {
  if (!stays.length) return [];
  const bounds = date ? dayBounds(date) : [-Infinity, Infinity];
  const validPoints = [...points].filter((point) => validCoordinate(point.lat, point.lon)
    && Number.isInteger(point.tst) && (point.acc == null || point.acc <= MOVE_MAX_ACCURACY_M))
    .sort((first, second) => first.tst - second.tst);
  const pointAtStay = (stay, last) => {
    const inside = validPoints.filter((point) => point.tst * 1000 >= Date.parse(stay.start)
      && point.tst * 1000 <= Date.parse(stay.end) && haversineM(point, stay) <= STAY_RADIUS_M);
    if (inside.length) return last ? inside.at(-1) : inside[0];
    // 자정에 잘린 체류는 점이 전날(또는 다음 날)에만 있을 수 있다. 그 자리의 가장 가까운 점을 출발·도착점으로 쓴다.
    const nearby = validPoints.filter((point) => haversineM(point, stay) <= STAY_RADIUS_M
      && (last ? point.tst * 1000 <= Date.parse(stay.end) : point.tst * 1000 >= Date.parse(stay.start)));
    return last ? nearby.at(-1) : nearby[0];
  };
  const moves = [];
  for (let index = 0; index < stays.length; index += 1) {
    const previous = stays[index];
    const next = stays[index + 1];
    const start = Math.max(Date.parse(previous.end), bounds[0]);
    const origin = pointAtStay(previous, true);
    const nextInsideDay = next && Date.parse(next.start) <= bounds[1];
    const trailingPoints = nextInsideDay ? [] : validPoints.filter((point) => point.tst * 1000 > start && point.tst * 1000 <= bounds[1]);
    const acceptedTrailing = !origin ? [] : acceptedMovePoints([origin, ...trailingPoints]).slice(1);
    const end = Math.min(next ? Date.parse(next.start) : (acceptedTrailing.at(-1)?.tst ?? 0) * 1000, bounds[1]);
    if (!(end > start)) continue;
    const between = validPoints.filter((point) => point.tst * 1000 > start && point.tst * 1000 < end);
    if (!nextInsideDay && !acceptedTrailing.length) continue;
    if (next && !between.length && previous.registered && next.registered
      && previous.placeName === next.placeName) continue;
    // 다음 체류가 내일 시작하면 내일 첫 점을 오늘 이동 거리로 더하지 않는다.
    const destination = nextInsideDay ? pointAtStay(next, false) : acceptedTrailing.at(-1);
    const straightM = nextInsideDay ? haversineM(previous, next) : destination ? haversineM(previous, destination) : Infinity;
    const path = acceptedMovePoints([origin, ...between, destination].filter(Boolean));
    // 체류 사이 관측점이 없으면 양 끝 좌표만으로 이동 거리·수단을 추정하지 않는다.
    const hasRoute = next ? path.some((point) => point.tst * 1000 > start && point.tst * 1000 < end)
      : acceptedTrailing.length > 0;
    const distanceM = hasRoute && origin && destination && path.length > 1
      ? path.slice(1).reduce((sum, point, pathIndex) => sum + haversineM(path[pathIndex], point), 0) : null;
    if (straightM < MOVE_SHORT_STRAIGHT_M && (distanceM == null || distanceM < MOVE_SHORT_PATH_M)) continue;
    if (!next && distanceM == null) continue;
    const averageSpeedKmh = distanceM == null ? null : distanceM / 1000 / ((end - start) / 3_600_000);
    const sustainedSpeed = distanceM == null ? null : sustainedSpeedKmh(path);
    const speedKmh = sustainedSpeed ?? averageSpeedKmh;
    const vehicleThreshold = sustainedSpeed == null ? MOVE_VEHICLE_MIN_KMH : MOVE_SUSTAINED_VEHICLE_MIN_KMH;
    const mode = speedKmh == null ? null : speedKmh < MOVE_WALK_MAX_KMH ? '도보'
      : speedKmh >= vehicleThreshold ? '차량' : null;
    const distanceKm = distanceM == null ? null : distanceM / 1000;
    const distanceText = distanceKm == null ? '' : ` · ${mode ? `${mode} ` : ''}약 ${distanceKm < 1 ? distanceKm.toFixed(1) : Math.round(distanceKm)}km`;
    moves.push({ kind: 'move', start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      label: `이동${distanceText}`, lat: origin?.lat ?? previous.lat, lon: origin?.lon ?? previous.lon,
      // 하루 동선 파일·지도용 구조값(표시 문구는 label).
      distanceKm: distanceKm == null ? null : Math.round(distanceKm * 10) / 10, mode });
  }
  return moves;
}

export function detectStays(points, { radiusM = STAY_RADIUS_M, minMinutes = STAY_MIN_MINUTES, date } = {}) {
  const sorted = [...points].filter((point) => validCoordinate(point.lat, point.lon) && Number.isInteger(point.tst)
    && (point.acc == null || point.acc <= MOVE_MAX_ACCURACY_M))
    .sort((first, second) => first.tst - second.tst);
  const timedPoints = sorted.map((point, index) => ({ ...point, nextTst: sorted[index + 1]?.tst }));
  const bounds = date ? dayBounds(date) : null;
  const stays = [];
  let cluster = [];
  // 군집 가입 판정은 기존 산술 중심을 유지한다. 시간 가중 중심이 가입 순서를 바꾸지 않도록 한다.
  const centerOf = (items) => ({ lat: items.reduce((sum, point) => sum + point.lat, 0) / items.length,
    lon: items.reduce((sum, point) => sum + point.lon, 0) / items.length });
  const makeStay = (items, rawEnd, splitBoundary = false) => {
    const rawStart = items[0].tst * 1000;
    const start = bounds ? Math.max(rawStart, bounds[0]) : rawStart;
    const end = bounds ? Math.min(rawEnd, bounds[1]) : rawEnd;
    if (end - start < minMinutes * 60_000) return false;
    let dwellMs = 0;
    let weightedLat = 0;
    let weightedLon = 0;
    for (const point of items) {
      // 마지막 점도 군집 밖 다음 점까지 가중한다. 자정 밖 시간은 이 날짜의 중심에 넣지 않는다.
      const nextTime = (point.nextTst ?? rawEnd / 1000) * 1000;
      if (bounds && (nextTime <= bounds[0] || point.tst * 1000 >= bounds[1])) continue;
      const intervalStart = bounds ? Math.max(point.tst * 1000, bounds[0]) : point.tst * 1000;
      const intervalEnd = bounds ? Math.min(nextTime, bounds[1]) : nextTime;
      const weight = Math.max(60_000, intervalEnd - intervalStart);
      dwellMs += weight;
      weightedLat += point.lat * weight;
      weightedLon += point.lon * weight;
    }
    const stay = { start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      lat: weightedLat / dwellMs, lon: weightedLon / dwellMs, pointCount: items.length, dwellMs, splitBoundary,
      // 병합 판정은 시간 가중 좌표에 끌리지 않도록 기존 점 평균을 따로 보존한다.
      decisionCenter: centerOf(items), items, rawEnd };
    return stay;
  };
  const flush = (nextPoint = null) => {
    if (!cluster.length) return;
    // 점 하나만 있는 군집은 이동 거리와 무관하게 다음 점 직전까지 그 자리에 있었다고 가정한다.
    // 점이 여럿이어도 다음 점까지 공백이 길면, 다음 점까지 걸어가는 시간만 빼고 그 자리에 있었다고 본다.
    const lastTst = cluster.at(-1).tst;
    const nextDistanceM = nextPoint ? haversineM(centerOf(cluster), nextPoint) : Infinity;
    const walkSeconds = nextDistanceM / 1000 / GAP_WALK_KMH * 3600;
    const gapEnd = nextPoint && nextPoint.tst - lastTst >= ANCHOR_GAP_MINUTES * 60 && nextDistanceM <= GAP_EXTEND_MAX_DISTANCE_M
      ? Math.max(lastTst, nextPoint.tst - walkSeconds) : lastTst;
    const rawEnd = cluster.length === 1 && nextPoint ? nextPoint.tst * 1000 : Math.round(gapEnd * 1000);
    const stay = makeStay(cluster, rawEnd);
    if (stay) stays.push(stay);
  };
  for (let index = 0; index < timedPoints.length; index += 1) {
    const point = timedPoints[index];
    if (!cluster.length) { cluster = [point]; continue; }
    const center = centerOf(cluster);
    if (haversineM(cluster[0], point) <= radiusM && haversineM(center, point) <= radiusM) cluster.push(point);
    else {
      const next = timedPoints[index + 1];
      // 한 점만 튀고 다음 점이 군집으로 돌아오면 그 점을 건너뛴다. 다만 군집 첫 점보다 정확한 점은 튄 점이 아니라
      // 부정확한 첫 점이 군집을 잘못 잡은 것이므로 건너뛰지 않는다(2026-10-19 회사 도착 직후 100m 점이 기준이 된 사례).
      const moreAccurateThanAnchor = Number.isFinite(point.acc) && Number.isFinite(cluster[0].acc) && point.acc < cluster[0].acc;
      if (!moreAccurateThanAnchor && next && haversineM(cluster[0], next) <= radiusM && haversineM(center, next) <= radiusM) continue;
      flush(point);
      cluster = [point];
    }
  }
  flush();
  const merged = [];
  for (const stay of stays) {
    const previous = merged.at(-1);
    if (previous && Date.parse(stay.start) - Date.parse(previous.end) <= 30 * 60_000
      && haversineM(previous.decisionCenter, stay.decisionCenter) <= radiusM) {
      // 사이에 멀리 나갔다 온 점이 있으면 한 체류로 합치되 외출로 남긴다(예: 회사에서 역까지 16분).
      const away = sorted.filter((point) => point.tst * 1000 > Date.parse(previous.end) && point.tst * 1000 < Date.parse(stay.start)
        && (point.acc == null || point.acc <= OUTING_MAX_ACCURACY_M) && haversineM(previous.decisionCenter, point) > radiusM);
      const farthest = away.reduce((best, point) => !best
        || haversineM(previous.decisionCenter, point) > haversineM(previous.decisionCenter, best) ? point : best, null);
      if (away.length >= 2 && away.at(-1).tst - away[0].tst >= OUTING_MIN_MINUTES * 60
        && haversineM(previous.decisionCenter, farthest) >= OUTING_MIN_DISTANCE_M) {
        previous.outings = [...(previous.outings ?? []), { start: new Date(away[0].tst * 1000).toISOString(),
          end: new Date(away.at(-1).tst * 1000).toISOString(), lat: farthest.lat, lon: farthest.lon }];
      }
      const dwellMs = previous.dwellMs + stay.dwellMs;
      previous.lat = (previous.lat * previous.dwellMs + stay.lat * stay.dwellMs) / dwellMs;
      previous.lon = (previous.lon * previous.dwellMs + stay.lon * stay.dwellMs) / dwellMs;
      previous.decisionCenter = {
        lat: (previous.decisionCenter.lat * previous.pointCount + stay.decisionCenter.lat * stay.pointCount) / (previous.pointCount + stay.pointCount),
        lon: (previous.decisionCenter.lon * previous.pointCount + stay.decisionCenter.lon * stay.pointCount) / (previous.pointCount + stay.pointCount),
      };
      previous.end = stay.end;
      previous.pointCount += stay.pointCount;
      previous.dwellMs = dwellMs;
      previous.items.push(...stay.items);
      previous.rawEnd = stay.rawEnd;
    } else merged.push({ ...stay });
  }
  const split = [];
  for (const stay of merged) {
    let segments = [{ items: stay.items, rawEnd: stay.rawEnd, splitBoundary: false }];
    for (let index = 0; index < stay.items.length - 1; index += 1) {
      const anchor = stay.items[index];
      const next = stay.items[index + 1];
      if (next.tst - anchor.tst < ANCHOR_GAP_MINUTES * 60) continue;
      const nextStart = Math.max(next.tst * 1000, bounds?.[0] ?? -Infinity);
      const stayEnd = Math.min(stay.rawEnd, bounds?.[1] ?? Infinity);
      // 마지막 관측점이 공백의 끝이면 앞 점 자체가 긴 정지의 앵커다.
      if (stayEnd - nextStart < minMinutes * 60_000
        && !(next === stay.items.at(-1) && next.tst * 1000 < (bounds?.[1] ?? Infinity)
          && next.tst - anchor.tst >= minMinutes * 60)) continue;
      const segmentIndex = segments.findIndex(({ items }) => items.includes(anchor) && items.includes(next));
      if (segmentIndex < 0) continue;
      const segment = segments[segmentIndex];
      const anchorIndex = segment.items.indexOf(anchor);
      const front = segment.items.slice(0, anchorIndex);
      const back = segment.items.slice(anchorIndex + 1);
      const pieces = [];
      if (front.length) pieces.push({ items: front, rawEnd: anchor.tst * 1000, splitBoundary: segment.splitBoundary });
      pieces.push({ items: [anchor], rawEnd: next.tst * 1000, splitBoundary: front.length > 0 || segment.splitBoundary });
      if (back.length) pieces.push({ items: back, rawEnd: segment.rawEnd, splitBoundary: true });
      // 짧은 앞뒤 조각은 경계 옆 조각에 흡수한다.
      if (front.length && anchor.tst * 1000 - front[0].tst * 1000 < minMinutes * 60_000) {
        pieces[1].items.unshift(...pieces[0].items);
        pieces[1].splitBoundary = segment.splitBoundary;
        pieces.shift();
      }
      const last = pieces.at(-1);
      if (pieces.length > 1 && last !== pieces[0]
        && last.rawEnd - last.items[0].tst * 1000 < minMinutes * 60_000) {
        pieces.at(-2).items.push(...last.items);
        pieces.at(-2).rawEnd = last.rawEnd;
        pieces.pop();
      }
      segments.splice(segmentIndex, 1, ...pieces);
    }
    const parts = segments.map((segment) => makeStay(segment.items, segment.rawEnd, segment.splitBoundary)).filter(Boolean);
    // 외출은 그 시각을 품은 조각(없으면 외출 직전 조각)에 붙인다.
    for (const outing of stay.outings ?? []) {
      const at = Date.parse(outing.start);
      const covering = parts.find((part) => Date.parse(part.start) <= at && at <= Date.parse(part.end));
      const owner = covering ?? parts.filter((part) => Date.parse(part.start) <= at).at(-1) ?? parts[0];
      if (owner) owner.outings = [...(owner.outings ?? []), outing];
    }
    split.push(...parts);
  }
  return split.map(({ decisionCenter, items, rawEnd, ...stay }) => {
    const distance = items.slice(1).reduce((sum, point, index) => sum + haversineM(items[index], point), 0);
    // 마지막 점 뒤로 늘린 꼬리(공백 연장)도 공백으로 센다. 차를 세우고 머문 곳이 주행 점 때문에 산책으로 보이지 않게 한다.
    const longestGap = items.slice(1).reduce((max, point, index) => Math.max(max, point.tst - items[index].tst),
      Math.max(0, rawEnd / 1000 - items.at(-1).tst));
    const extent = items.reduce((max, point, index) => Math.max(max,
      ...items.slice(index + 1).map((other) => haversineM(point, other))), 0);
    return { ...stay, kind: items.length >= ROAM_MIN_POINTS && distance >= ROAM_MIN_DISTANCE_M && extent >= ROAM_MIN_EXTENT_M
      && longestGap < ROAM_MAX_GAP_MINUTES * 60 ? 'roam' : 'stay' };
  });
}

export function matchPlace(stay, places) {
  return places.map((place) => ({ place, distance: haversineM(stay, place) }))
    .filter(({ place, distance }) => distance <= (place.radius ?? STAY_RADIUS_M))
    .sort((first, second) => first.distance - second.distance)[0]?.place ?? null;
}

export function loadPlaces(root) {
  const directory = join(root, VAULT_REL.places);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith('.md')).flatMap((name) => {
    const fields = parseFrontmatter(readFileSync(join(directory, name), 'utf8'));
    const lat = Number(fields.lat);
    const lon = Number(fields.lon);
    if (!validCoordinate(lat, lon) || fields.lat == null || fields.lon == null) return [];
    return [{ name: String(fields.title || name.slice(0, -3)), lat, lon, radius: Number(fields.radius) || STAY_RADIUS_M }];
  });
}

export async function describeStays(stays, { places, geocode, region = async () => null }) {
  const described = [];
  let previousPlace = null;
  for (const stay of stays) {
    const { splitBoundary, ...publicStay } = stay;
    const place = matchPlace(stay, places);
    const previous = described.at(-1);
    if (splitBoundary && place && previousPlace === place && previous.end === stay.start) {
      const dwellMs = previous.dwellMs + stay.dwellMs;
      previous.lat = (previous.lat * previous.dwellMs + stay.lat * stay.dwellMs) / dwellMs;
      previous.lon = (previous.lon * previous.dwellMs + stay.lon * stay.dwellMs) / dwellMs;
      previous.end = stay.end;
      previous.pointCount += stay.pointCount;
      previous.dwellMs = dwellMs;
      if (stay.outings) previous.outings = [...(previous.outings ?? []), ...stay.outings];
      continue;
    }
    // 30분 앵커 분리로 같은 미등록 장소가 두 줄로 갈라지면 지오코딩 전에 다시 합친다(앞뒤 모두 정지·반경 안).
    if (splitBoundary && !place && previous && !previous.registered && previous.kind !== 'roam' && stay.kind !== 'roam'
      && previous.end === stay.start && haversineM(previous, stay) <= STAY_RADIUS_M) {
      const dwellMs = previous.dwellMs + stay.dwellMs;
      previous.lat = (previous.lat * previous.dwellMs + stay.lat * stay.dwellMs) / dwellMs;
      previous.lon = (previous.lon * previous.dwellMs + stay.lon * stay.dwellMs) / dwellMs;
      previous.end = stay.end;
      previous.pointCount += stay.pointCount;
      previous.dwellMs = dwellMs;
      if (stay.outings) previous.outings = [...(previous.outings ?? []), ...stay.outings];
      continue;
    }
    if (place) { described.push({ ...publicStay, kind: 'stay', label: place.name, registered: true, placeName: place.name }); previousPlace = place; continue; }
    if (stay.kind === 'roam') {
      const district = await region(stay.lat, stay.lon);
      described.push({ ...publicStay, label: district ? `${district} 일대 산책` : '일대 산책', registered: false });
      previousPlace = null;
      continue;
    }
    const result = await geocode(stay.lat, stay.lon);
    const address = result?.address ?? (typeof result === 'string' ? result : null);
    const buildingName = result?.buildingName ?? null;
    const label = buildingName || (address ? `미등록: ${address}`
      : (result?.reason === 'dry-run' ? '미등록 장소(dry-run)' : `미등록 장소 (${result?.reason || '주소 미조회'})`));
    described.push({ ...publicStay, label, registered: false, autoNamed: Boolean(buildingName), address: address ?? null });
    previousPlace = null;
  }
  // 외출은 가장 멀리 간 점의 동네 이름으로 부른다(조회 실패면 이름 없이).
  for (const stay of described) {
    if (!stay.outings) continue;
    stay.outings = await Promise.all(stay.outings.map(async (outing) => ({ ...outing, area: await region(outing.lat, outing.lon) ?? null })));
  }
  return described;
}
