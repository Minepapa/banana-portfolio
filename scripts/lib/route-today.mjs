// 오늘 동선 임시 파일(2026-11-01 오너 승인, 올림푸스 헤르메스 방 — 제우스 요청): 하루가 끝나기 전에도 지금까지의 동선을 보인다.
// - 경로 `95_Etna/Location/Today.json` 한 개를 덮어쓴다. 확정 동선(Location/Days)과 따로 둔다 — 재계산은 Days 파일의
//   판 번호만 보고 "이미 있음"으로 보므로, 같은 경로에 임시본을 두면 밤 확정을 막을 수 있다.
// - 모양은 하루 동선 파일(route-days) 3판과 같고 provisional: true, asOf(마지막 위치 점 시각)가 더 붙는다.
//   마지막 항목(머무는 중이면 체류, 움직이는 중이면 이동)은 current: true이고 end가 비어 있다. 그 항목의 minutes와
//   하루 요약은 asOf까지로 센다. buildRouteDay는 이동의 current를 버리므로 여기서 다시 붙인다(2026-11-01 리뷰).
// - asOf는 실행 시각이 아니라 마지막 위치 점 시각이다. 새 점이 없으면 내용이 같아 다시 쓰지 않는다(LiveSync 부담).
// - 화면: date가 오늘이면 이 파일, 지난날은 Days 파일. 날짜가 바뀌면 다음 회차가 새 날짜로 덮어쓴다(점이 없으면 entries 빈 배열).
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VAULT_PATHS, VAULT_REL } from './vault-paths.mjs';
import { writeAtomic } from './state-writer.mjs';
import { buildRouteDay, routeDaySummary, routeMinutes } from './route-days.mjs';

export function routeTodayPath(root = VAULT_PATHS.root) {
  return join(root, ...VAULT_REL.locationToday.split('/'));
}

const kstHhmm = (ms) => new Date(ms + 9 * 3_600_000).toISOString().slice(11, 16);

// points: 위치 점({ tst(초) }) — 그날(KST) 점 중 가장 늦은 것이 asOf다. 그날 점이 없으면 asOf는 null.
export function buildRouteToday({ date, route, points = [] }) {
  const dayStart = Date.parse(`${date}T00:00:00+09:00`) / 1000;
  const lastTst = points.reduce((latest, point) => (point.tst >= dayStart && point.tst < dayStart + 86_400
    && point.tst > latest ? point.tst : latest), 0);
  const asOf = lastTst ? new Date(lastTst * 1000).toISOString() : null;
  const day = buildRouteDay({ date, route });
  const last = day.entries.at(-1);
  if (last && route.at(-1)?.current && !last.end) {
    last.current = true;
    if (asOf) last.minutes = routeMinutes(last.start, kstHhmm(lastTst * 1000));
  }
  return { schemaVersion: day.schemaVersion, date, provisional: true, asOf, summary: routeDaySummary(day.entries),
    entries: day.entries };
}

// 하루 동선 파일과 같은 한 줄 한 항목 형식(track 점 때문에 들여쓴 JSON은 너무 커진다).
export function routeTodayText(today) {
  const entries = today.entries.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n');
  return `{\n  "schemaVersion": ${today.schemaVersion},\n  "date": ${JSON.stringify(today.date)},\n`
    + `  "provisional": true,\n  "asOf": ${JSON.stringify(today.asOf)},\n  "summary": ${JSON.stringify(today.summary)},\n`
    + `  "entries": [${entries ? `\n${entries}\n  ` : ''}]\n}\n`;
}

// 같은 내용이면 쓰지 않는다. 반환: 쓴 경로 또는 null.
export function writeRouteToday(today, { root = VAULT_PATHS.root, write = writeAtomic } = {}) {
  const path = routeTodayPath(root);
  const text = routeTodayText(today);
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return null;
  mkdirSync(dirname(path), { recursive: true });
  write(path, text);
  return path;
}
