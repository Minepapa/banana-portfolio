import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { VAULT_REL } from './vault-paths.mjs';

export const STAY_RADIUS_M = 150;
export const STAY_MIN_MINUTES = 15;
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
  return { points, brokenLines };
}

export function haversineM(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDifference = radians(second.lat - first.lat);
  const longitudeDifference = radians(second.lon - first.lon);
  const arc = Math.sin(latitudeDifference / 2) ** 2 + Math.cos(radians(first.lat)) * Math.cos(radians(second.lat)) * Math.sin(longitudeDifference / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

export function detectStays(points, { radiusM = STAY_RADIUS_M, minMinutes = STAY_MIN_MINUTES, date } = {}) {
  const sorted = [...points].filter((point) => validCoordinate(point.lat, point.lon) && Number.isInteger(point.tst))
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
    const rawEnd = cluster.length === 1 && nextPoint ? nextPoint.tst * 1000 : cluster.at(-1).tst * 1000;
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
      if (next && haversineM(cluster[0], next) <= radiusM && haversineM(center, next) <= radiusM) continue;
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
      if (next.tst - anchor.tst < 60 * 60) continue;
      const nextStart = Math.max(next.tst * 1000, bounds?.[0] ?? -Infinity);
      const stayEnd = Math.min(stay.rawEnd, bounds?.[1] ?? Infinity);
      if (stayEnd - nextStart < minMinutes * 60_000) continue;
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
    for (const segment of segments) {
      const part = makeStay(segment.items, segment.rawEnd, segment.splitBoundary);
      if (part) split.push(part);
    }
  }
  return split.map(({ decisionCenter, items, rawEnd, ...stay }) => stay);
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

export async function describeStays(stays, { places, geocode }) {
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
      continue;
    }
    if (place) { described.push({ ...publicStay, label: place.name, registered: true, placeName: place.name }); previousPlace = place; continue; }
    const result = await geocode(stay.lat, stay.lon);
    const address = result?.address ?? (typeof result === 'string' ? result : null);
    const buildingName = result?.buildingName ?? null;
    const label = buildingName || (address ? `미등록: ${address}`
      : (result?.reason === 'dry-run' ? '미등록 장소(dry-run)' : `미등록 장소 (${result?.reason || '주소 미조회'})`));
    described.push({ ...publicStay, label, registered: false, autoNamed: Boolean(buildingName), address: address ?? null });
    previousPlace = null;
  }
  return described;
}
