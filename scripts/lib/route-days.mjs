// 하루 동선 파일: 데일리 동선 칸과 같은 계산 결과(머문 곳·이동)를 구조화해 남긴다(2026-10-31 오너 승인).
// - 올림푸스 지도·H3·출퇴근 수단 판정이 같은 판정을 다시 하지 않고 이 파일을 읽는다(Requests "동선 인터랙티브 지도와 H3 기록").
// - 마지막 체류의 end "24:00"은 데일리가 자정까지 머문 것으로 확정한 표시다. 이때 endAt은 마지막 위치 점 시각이라 다르다.
//   걸린 시간·화면은 end(표시)를 정본으로 쓴다(장소별 소비와 같은 판단).
// - 원문(위치 JSONL)에서 언제든 다시 계산할 수 있는 파생값이다. 장소별 소비처럼 다음 날 확정 때 쓰고, 같은 내용이면 다시 쓰지 않는다.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VAULT_PATHS, VAULT_REL } from './vault-paths.mjs';
import { writeAtomic } from './state-writer.mjs';

// 2(2026-10-31): 이동에 track(거른 점 [위도, 경도, 초]) 추가. 옛 판의 파일은 재계산이 다시 쓴다(routeDayCurrent).
export const ROUTE_DAY_SCHEMA = 2;

export function routeDayPath(date, root = VAULT_PATHS.root) {
  return join(root, ...VAULT_REL.locationDays.split('/'), date.slice(0, 4), `${date}.json`);
}

// 데일리 표시 시각(HH:MM, 끝 24:00 포함) 사이의 분. 표시와 같은 값을 써야 화면마다 걸린 시간이 어긋나지 않는다.
export function routeMinutes(start, end) {
  const minutesOf = (value) => {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const from = minutesOf(start);
  const to = minutesOf(end);
  return from == null || to == null || to < from ? null : to - from;
}

const rounded = (value) => (Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null);

export function buildRouteDay({ date, route }) {
  const entries = (Array.isArray(route) ? route : []).map((entry) => {
    const base = { kind: entry.kind ?? 'stay', start: entry.start, end: entry.end || null,
      startAt: entry.startAt ?? null, endAt: entry.endAt ?? null, minutes: routeMinutes(entry.start, entry.end),
      label: String(entry.label ?? ''), lat: rounded(entry.lat), lon: rounded(entry.lon) };
    if (entry.kind === 'move') return { ...base, distanceKm: entry.distanceKm ?? null, mode: entry.mode ?? null,
      track: (entry.track ?? []).map((point) => [rounded(point.lat), rounded(point.lon), point.tst]) };
    return { ...base, registered: Boolean(entry.registered), placeName: entry.placeName ?? null,
      activity: entry.activity ?? null, current: Boolean(entry.current),
      outings: (entry.outings ?? []).map((outing) => ({ start: outing.start, end: outing.end,
        startAt: outing.startAt ?? null, endAt: outing.endAt ?? null, minutes: routeMinutes(outing.start, outing.end),
        area: outing.area ?? null, lat: rounded(outing.lat), lon: rounded(outing.lon) })) };
  });
  return { schemaVersion: ROUTE_DAY_SCHEMA, date, entries };
}

// 지금 판의 파일이 있는지. 없거나 옛 판·깨진 파일이면 재계산이 채운다.
export function routeDayCurrent(date, root = VAULT_PATHS.root) {
  const path = routeDayPath(date, root);
  if (!existsSync(path)) return false;
  try { return JSON.parse(readFileSync(path, 'utf8')).schemaVersion === ROUTE_DAY_SCHEMA; }
  catch { return false; }
}

// 같은 내용이면 다시 쓰지 않는다(LiveSync 부담). 반환: 쓴 경로 또는 null.
export function writeRouteDay({ date, route, root = VAULT_PATHS.root, write = writeAtomic }) {
  const path = routeDayPath(date, root);
  const text = `${JSON.stringify(buildRouteDay({ date, route }), null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return null;
  mkdirSync(dirname(path), { recursive: true });
  write(path, text);
  return path;
}
