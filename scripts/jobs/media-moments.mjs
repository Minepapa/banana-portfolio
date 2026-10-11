#!/usr/bin/env node
// Archive 색인에서 Camera 순간 노트를 만든다. 실행당 각 노트는 한 번만 원자적으로 쓴다.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic, withLock } from '../lib/state-writer.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import { createCachedGeocoder } from '../lib/kakao-geocode.mjs';
import { haversineM, loadPlaces } from '../lib/location-stays.mjs';
import { computeRoute, readRoutePayments, readRoutePoints } from './daily-note.mjs';

export const MOMENT_GAP_MS = 90 * 60_000;
export const MOMENT_DISTANCE_M = 1500;
const START = '<!-- media-moments:start -->';
const END = '<!-- media-moments:end -->';
const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.avi', '.mkv', '.webm']);
const at = (item) => Date.parse(item.capturedAt);
const kst = (time) => new Date(time + 9 * 3600_000).toISOString();
const day = (time) => kst(time).slice(0, 10);
const clock = (time) => kst(time).slice(11, 16);
const coordinate = (gps) => gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lon) ? gps : null;
const clean = (text) => String(text || '').replace(/[\\/:*?"<>|\r\n#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);

export function groupMoments(records) {
  const sorted = records.filter((record) => record.kind === 'Camera' && typeof record.id === 'string'
    && Number.isFinite(at(record)) && typeof record.archivePath === 'string')
    .sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id));
  const moments = [];
  for (const record of sorted) {
    const current = moments.at(-1);
    const previous = current?.at(-1);
    const distant = coordinate(previous?.gps) && coordinate(record.gps)
      && haversineM(previous.gps, record.gps) > MOMENT_DISTANCE_M;
    if (!current || at(record) - at(previous) > MOMENT_GAP_MS || distant) moments.push([record]);
    else current.push(record);
  }
  return moments;
}

function readIndex(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n');
  // append 중인 마지막 행은 끝 개행이 생길 때까지 유효한 색인으로 보지 않는다.
  if (lines.at(-1) !== '') lines.pop();
  return lines.filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`미디어 색인 ${index + 1}줄 JSON 오류`); }
  });
}

function existingNotes(root, year) {
  const directory = `${VAULT_REL.mediaMoments}/${year}`;
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return new Map();
  const notes = new Map();
  for (const filename of readdirSync(absolute).filter((name) => name.endsWith('.md'))) {
    const rel = `${directory}/${filename}`;
    const id = parseFrontmatter(readFileSync(join(root, rel), 'utf8')).momentId;
    if (!id) continue;
    if (notes.has(id)) throw new Error(`중복 momentId 노트: ${id}`);
    notes.set(id, rel);
  }
  return notes;
}

function overlapping(route, first, last) {
  return route.filter((entry) => entry.kind !== 'move' && Date.parse(entry.startAt) <= last
    && (Date.parse(entry.endAt) >= first || entry.end === '24:00'))
    .sort((a, b) => Math.min(last, Date.parse(b.endAt)) - Math.max(first, Date.parse(b.startAt))
      - (Math.min(last, Date.parse(a.endAt)) - Math.max(first, Date.parse(a.startAt))))[0];
}

export async function describeMoment(records, { root, dryRun, geocode, routeForDay = computeRoute,
  routePoints = readRoutePoints, paymentsForDay = readRoutePayments, places = loadPlaces(root) } = {}) {
  const first = at(records[0]);
  const last = at(records.at(-1));
  const dates = [...new Set(records.map((record) => day(at(record))))];
  for (const date of dates) {
    if (date < '2026-10-09' || !routePoints(date, root).length) continue;
    const route = await routeForDay(date, { root, dryRun, geocode, points: routePoints(date, root),
      payments: paymentsForDay(date, root) });
    const stay = overlapping(route, first, last);
    if (stay) return { place: stay.placeName || (stay.autoNamed ? stay.label : stay.address) || null,
      summary: clean([stay.label, stay.activity].filter(Boolean).join(' · ')), source: 'route' };
  }
  const gps = records.map((record) => coordinate(record.gps)).find(Boolean);
  let place = null;
  let source = null;
  if (gps) {
    const registered = places.filter((entry) => haversineM(entry, gps) <= (entry.radius ?? 150))
      .sort((a, b) => haversineM(a, gps) - haversineM(b, gps))[0];
    if (registered) { place = registered.name; source = 'gps'; }
    else if (!dryRun) {
      const result = await geocode(gps.lat, gps.lon);
      place = result?.buildingName || result?.address || null;
      if (place) source = 'gps';
    }
  }
  const payments = dates.flatMap((date) => paymentsForDay(date, root));
  const payment = payments.find((entry) => Date.parse(entry.at) >= first && Date.parse(entry.at) <= last);
  const activity = clean(payment?.merchant);
  return { place, summary: clean([place, activity].filter(Boolean).join(' · ')) || `${clock(first).replace(':', '')}`, source: source || (activity ? 'payment' : 'time') };
}

function render(records, description, existing, now) {
  const first = at(records[0]);
  const last = at(records.at(-1));
  const prior = existing?.match(new RegExp(`${START}([\\s\\S]*?)${END}`));
  if (existing && (!prior || existing.indexOf(START) !== existing.lastIndexOf(START)
    || existing.indexOf(END) !== existing.lastIndexOf(END))) throw new Error('기계 생성 표식이 없거나 중복됨');
  const previousFields = existing ? parseFrontmatter(existing) : {};
  if (existing && previousFields.momentId !== records[0].id) throw new Error('기존 노트 momentId 불일치');
  const frontmatterEnd = existing?.match(/^---\n[\s\S]*?\n---\n/)?.[0].length;
  if (existing && (frontmatterEnd == null || frontmatterEnd > existing.indexOf(START))) throw new Error('기존 노트 머리말 오류');
  const before = existing ? existing.slice(frontmatterEnd, existing.indexOf(START)) : '';
  const owner = existing ? existing.slice(existing.indexOf(END) + END.length) : '\n\n## 오너 메모\n\n';
  const created = previousFields.created || now;
  const fields = {
    ...previousFields,
    type: 'media', category: `[[${VAULT_REL.homeDir}/100 나]]`, description: `${day(first)} ${description.summary} 순간`,
    sensitivity: '개인', created, modified: now, occurred: records[0].capturedAt,
    origin: `media:${records[0].archivePath}`, mediaCount: records.length,
    momentId: records[0].id,
    mediaIds: records.map((record) => record.id), startAt: records[0].capturedAt,
    endAt: records.at(-1).capturedAt, infoSource: description.source,
  };
  if (description.place) fields.place = description.place;
  else delete fields.place;
  const frontmatter = buildFrontmatter(fields);
  const lines = records.map((record) => `- ${VIDEO.has(extname(record.archivePath).toLowerCase()) ? '영상' : '사진'}: ${record.archivePath}`);
  const generated = `${START}\n# ${day(first)} ${description.summary} 순간\n\n- 시간: ${clock(first)}–${clock(last)}\n- 장소·활동: ${description.place || description.summary}\n- 정보 출처: ${description.source}\n\n## 원본\n\n${lines.join('\n')}\n${END}`;
  return `${frontmatter}${before}${generated}${owner}`;
}

export async function runMediaMoments({ root = VAULT_PATHS.root, indexPath = join(root, VAULT_REL.mediaArchiveIndex),
  statePath = join(root, VAULT_REL.mediaMomentsState), dryRun = false, since = null,
  geocode = createCachedGeocoder({ root }), routeForDay = computeRoute,
  routePoints = readRoutePoints, paymentsForDay = readRoutePayments, places,
  write = writeAtomic, output = console, now = new Date().toISOString(), registryRules } = {}) {
  if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`)))) throw new Error('--since 날짜 오류');
  if (!existsSync(root)) throw new Error(`볼트 경로 없음: ${root}`);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('moments.json 형식 오류');
  const rules = registryRules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  // media-archive가 같은 JSONL을 append/복구할 수 있으므로 락 아래서 완성된 스냅샷만 읽는다.
  // 사진 분류·노트 생성은 락을 놓은 뒤 수행해 archive를 오래 막지 않는다.
  const records = dryRun || !existsSync(dirname(indexPath)) ? readIndex(indexPath)
    : await withLock(indexPath, () => readIndex(indexPath), { retries: 1200, retryDelayMs: 100 });
  const moments = groupMoments(records).filter((group) => !since || day(at(group.at(-1))) >= since);
  const names = new Set(Object.values(state).map((entry) => entry.notePath));
  const discovered = new Map();
  const summary = { created: 0, updated: 0, skipped: 0 };
  const visitedPaths = new Set();
  const routes = new Map();
  const routeGeocode = (...args) => geocode(...args);
  routeGeocode.region = geocode.region?.bind(geocode);
  routeGeocode.keyword = geocode.keyword?.bind(geocode);
  routeGeocode.failureCount = geocode.failureCount?.bind(geocode);
  // computeRoute의 날짜별 flush를 막는다. 캐시 파일은 모든 순간 처리 후 한 번만 쓴다.
  routeGeocode.flush = async () => {};
  const cachedRouteForDay = (date, options) => {
    if (!routes.has(date)) routes.set(date, routeForDay(date, { ...options, geocode: routeGeocode }));
    return routes.get(date);
  };
  let stateDirty = false;
  for (const records of moments) {
    const id = records[0].id;
    const description = await describeMoment(records, { root, dryRun, geocode, routeForDay: cachedRouteForDay, routePoints,
      paymentsForDay, places: places ?? loadPlaces(root) });
    const date = day(at(records[0]));
    const base = `${date} ${clean(description.summary) || clock(at(records[0])).replace(':', '')} 순간`;
    const directory = `${VAULT_REL.mediaMoments}/${date.slice(0, 4)}`;
    let rel = state[id]?.notePath;
    if (!rel) {
      if (!discovered.has(date.slice(0, 4))) discovered.set(date.slice(0, 4), existingNotes(root, date.slice(0, 4)));
      rel = discovered.get(date.slice(0, 4)).get(id);
    }
    if (!rel) {
      rel = `${directory}/${base}.md`;
      if (names.has(rel) || existsSync(join(root, rel))) rel = `${directory}/${base} ${clock(at(records[0])).replace(':', '')}.md`;
      if (names.has(rel) || existsSync(join(root, rel))) rel = `${directory}/${base} ${id.slice(0, 8)}.md`;
    }
    if (!rel.startsWith(`${directory}/`) || rel.includes('..')) throw new Error(`순간 상태 경로 오류: ${id}`);
    if (visitedPaths.has(rel)) throw new Error(`중복 순간 노트 경로: ${rel}`);
    visitedPaths.add(rel);
    names.add(rel);
    const path = join(root, rel);
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (state[id] && existing == null) throw new Error(`기존 순간 노트가 없음: ${rel}`);
    const next = render(records, description, existing, now);
    const stable = existing && next.replace(/^modified:.*$/m, '') === existing.replace(/^modified:.*$/m, '');
    if (stable) {
      if (!dryRun && (!state[id] || JSON.stringify(state[id].mediaIds) !== JSON.stringify(records.map((record) => record.id)))) {
        state[id] = { notePath: rel, mediaIds: records.map((record) => record.id) };
        stateDirty = true;
      }
      summary.skipped += 1; continue;
    }
    const problems = rules ? checkNote(rel, next, rules) : [];
    if (problems.length) throw new Error(`순간 노트 쓰기 관문: ${problems.join('; ')}`);
    if (!dryRun) {
      mkdirSync(dirname(path), { recursive: true });
      await withLock(path, () => {
        const latest = existsSync(path) ? readFileSync(path, 'utf8') : null;
        if (latest !== existing) throw new Error(`쓰기 전 노트 변경: ${rel}`);
        write(path, next);
      });
      state[id] = { notePath: rel, mediaIds: records.map((record) => record.id) };
      stateDirty = true;
    }
    if (existing) summary.updated += 1;
    else summary.created += 1;
  }
  if (!dryRun) {
    await geocode.flush?.();
    if (stateDirty) {
      mkdirSync(dirname(statePath), { recursive: true });
      await withLock(statePath, () => write(statePath, `${JSON.stringify(state, null, 2)}\n`));
    }
  }
  output.log(`[media-moments] ${dryRun ? 'dry-run ' : ''}새 순간 ${summary.created}, 갱신 ${summary.updated}, 건너뜀 ${summary.skipped}`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const since = args.find((arg) => arg.startsWith('--since='))?.slice('--since='.length);
  if (args.some((arg) => arg !== '--dry-run' && !arg.startsWith('--since='))) {
    console.error('usage: node scripts/jobs/media-moments.mjs [--dry-run] [--since=YYYY-MM-DD]');
    process.exitCode = 2;
  } else runMediaMoments({ dryRun: args.includes('--dry-run'), since }).catch((error) => {
    console.error(`[media-moments] ${error.stack}`); process.exitCode = 1;
  });
}
