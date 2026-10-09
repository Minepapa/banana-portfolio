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
  const bounds = date ? dayBounds(date) : null;
  const stays = [];
  let cluster = [];
  const centerOf = (items) => ({ lat: items.reduce((sum, point) => sum + point.lat, 0) / items.length,
    lon: items.reduce((sum, point) => sum + point.lon, 0) / items.length });
  const flush = (nextPoint = null) => {
    if (!cluster.length) return;
    const rawStart = cluster[0].tst * 1000;
    // 점 하나만 있는 군집은 이동 거리와 무관하게 다음 점 직전까지 그 자리에 있었다고 가정한다.
    const rawEnd = cluster.length === 1 && nextPoint ? nextPoint.tst * 1000 : cluster.at(-1).tst * 1000;
    const start = bounds ? Math.max(rawStart, bounds[0]) : rawStart;
    const end = bounds ? Math.min(rawEnd, bounds[1]) : rawEnd;
    if (end - start < minMinutes * 60_000) return;
    stays.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      ...centerOf(cluster), pointCount: cluster.length });
  };
  for (let index = 0; index < sorted.length; index += 1) {
    const point = sorted[index];
    if (!cluster.length) { cluster = [point]; continue; }
    const center = centerOf(cluster);
    if (haversineM(cluster[0], point) <= radiusM && haversineM(center, point) <= radiusM) cluster.push(point);
    else {
      const next = sorted[index + 1];
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
      && haversineM(previous, stay) <= radiusM) {
      const count = previous.pointCount + stay.pointCount;
      previous.lat = (previous.lat * previous.pointCount + stay.lat * stay.pointCount) / count;
      previous.lon = (previous.lon * previous.pointCount + stay.lon * stay.pointCount) / count;
      previous.end = stay.end;
      previous.pointCount = count;
    } else merged.push({ ...stay });
  }
  return merged;
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
  for (const stay of stays) {
    const place = matchPlace(stay, places);
    if (place) { described.push({ ...stay, label: place.name, registered: true, placeName: place.name }); continue; }
    const result = await geocode(stay.lat, stay.lon);
    const address = typeof result === 'string' ? result : result?.address;
    described.push({ ...stay, label: address ? `미등록: ${address}` : (result?.reason === 'dry-run' ? '미등록 장소(dry-run)' : `미등록 장소 (${result?.reason || '주소 미조회'})`),
      registered: false, address: address ?? null });
  }
  return described;
}
