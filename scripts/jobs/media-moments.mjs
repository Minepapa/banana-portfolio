#!/usr/bin/env node
// Archive 색인에서 Camera와 촬영 시각이 확인된 KakaoTalk 사진·동영상의 순간 노트를 만든다. 각 노트는 실행당 한 번만 원자적으로 쓴다.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_FACES_PATHS, VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { loadVisionConfig } from './media-vision.mjs';
import { writeAtomic, withLock } from '../lib/state-writer.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import { mergeMomentPeople, momentPeople } from '../lib/media-face-people.mjs';
import { createCachedGeocoder } from '../lib/kakao-geocode.mjs';
import { haversineM, loadPlaces } from '../lib/location-stays.mjs';
import { computeRoute, readRoutePayments, readRoutePoints } from './daily-note.mjs';
import { linkPhotoMemos } from './media-photo-memos.mjs';

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
export function loadVideoPeople(path = join(MEDIA_FACES_PATHS.root, 'video-matches.jsonl'), output = console) {
  if (!existsSync(path)) return {};
  const people = {};
  for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (typeof row.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(row.id)
        || !Array.isArray(row.people) || !row.people.every((name) => typeof name === 'string')
        || row.hold != null && (!Array.isArray(row.hold) || !row.hold.every((name) => typeof name === 'string'))) {
        throw new Error('id/people/hold 형식 오류');
      }
      people[row.id] = { people: row.people, hold: row.hold ?? [] };
    } catch (error) {
      (output.warn ?? output.log).call(output, `[media-moments] 영상 이름표 ${index + 1}행 건너뜀: ${error.message}`);
    }
  }
  return people;
}

export function loadFacePhotos(root, { videoPeoplePath = join(MEDIA_FACES_PATHS.root, 'video-matches.jsonl'),
  output = console } = {}) {
  const facePeoplePath = join(root, VAULT_REL.mediaFacePeople);
  // 사진 이름표 파일이 없으면 앨범만으로 기존 순간의 얼굴 근거를 다시 계산하지 않는다.
  if (!existsSync(facePeoplePath)) return null;
  const photos = JSON.parse(readFileSync(facePeoplePath, 'utf8')).photos ?? {};
  return { ...loadVideoPeople(videoPeoplePath, output), ...photos };
}
const clean = (text) => String(text || '').replace(/[\\/:*?"<>|\r\n#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
export const timePeriod = (time) => {
  const hour = Number(clock(time).slice(0, 2));
  return ['새벽', '아침', '낮', '오후', '저녁', '밤'][
    hour < 6 ? 0 : hour < 11 ? 1 : hour < 14 ? 2 : hour < 18 ? 3 : hour < 22 ? 4 : 5];
};
const addressLabel = (address) => {
  const parts = clean(address).split(' ');
  const district = parts.findIndex((part) => /[시군구]$/.test(part) && !/^(?:서울|부산|대구|인천|광주|대전|울산|세종)(?:특별시|광역시|특별자치시)?$/.test(part));
  const area = parts.slice(district + 1).find((part) => /(?:동|읍|면|로|길)$/.test(part));
  return clean([district >= 0 ? parts[district] : null, area].filter(Boolean).join(' ')) || clean(address);
};
export const titlePlace = (place, address) => address && place === address ? `${addressLabel(address)} 일대` : place;
const cleanRouteLabel = (label) => {
  const value = String(label || '').replace(/^미등록:\s*/, '');
  return value.startsWith('미등록 장소') ? '' : value;
};

export function visionForMoment(records, visionRows, config) {
  if (!visionRows) return null;
  const counts = new Map();
  let faces = 0;
  let allPhotosAnalyzed = true;
  for (const record of records) {
    const vision = visionRows.get(record.id);
    const video = VIDEO.has(extname(record.archivePath || record.importPath).toLowerCase());
    if (!video && (!vision || (vision.schema ?? 0) < 2 || vision.error)) allPhotosAnalyzed = false;
    if (!vision || (vision.schema ?? 0) < 2 || vision.error) continue;
    faces = Math.max(faces, Number(vision.faces) || 0);
    if (video) continue;
    const photoLabels = new Map();
    for (const label of vision.labels ?? []) {
      if (Number(label.confidence) < config.minConfidence || config.ignore.includes(label.name)) continue;
      const korean = config.labels[label.name];
      if (typeof korean === 'string' && korean.trim()) {
        photoLabels.set(korean, Math.max(photoLabels.get(korean) || 0, Number(label.confidence)));
      }
    }
    for (const [name, confidence] of photoLabels) {
      const score = counts.get(name) ?? { photos: 0, confidence: 0 };
      counts.set(name, { photos: score.photos + 1, confidence: score.confidence + confidence });
    }
  }
  const scenes = [...counts].sort((a, b) => b[1].photos - a[1].photos
    || b[1].confidence - a[1].confidence || a[0].localeCompare(b[0], 'ko'))
    .slice(0, 3).map(([name]) => name);
  return { scenes, faces, allPhotosAnalyzed };
}

export function titleWithScene(summary, { place, occasions = [], scene, period }) {
  if (!scene || place || occasions.length || !summary.endsWith(period)) return summary;
  return `${summary.slice(0, -period.length)}${scene} ${period}`;
}

export function loadMomentVision(root, output = console) {
  const path = join(root, VAULT_REL.mediaVisionIndex);
  const configPath = join(root, VAULT_REL.mediaVisionLabels);
  let config;
  try { config = loadVisionConfig(configPath); }
  catch (error) {
    output.log(`[media-moments] vision 설정 오류: ${String(error.message).replace(/[\r\n]+/g, ' ')}`);
    return null;
  }
  if (!existsSync(path)) return null;
  const rows = readIndex(path);
  return { rows: new Map(rows.map((row) => [row.id, row])), config };
}

export function groupMoments(records) {
  const sorted = records.filter((record) => (record.kind === 'Camera'
    || (['KakaoTalk', 'KakaoTalkMovie'].includes(record.kind) && record.capturedFrom === 'exif'
      && ['confirmed', 'single'].includes(record.capturedConfidence)))
    && typeof record.id === 'string'
    && Number.isFinite(at(record)) && typeof record.archivePath === 'string')
  return groupTimedRecords(sorted);
}

export function groupTimedRecords(records) {
  const sorted = [...records].sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id));
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
    if (stay) {
      const address = stay.address || null;
      const place = stay.placeName || (stay.autoNamed ? cleanRouteLabel(stay.label) : null) || address;
      const label = titlePlace(cleanRouteLabel(stay.label) || place, address);
      return { place: place || null, address,
        summary: clean([label, stay.activity].filter(Boolean).join(' · ')) || timePeriod(first), source: 'route' };
    }
  }
  const gps = records.map((record) => coordinate(record.gps)).find(Boolean);
  let place = null;
  let address = null;
  let source = null;
  if (gps) {
    const registered = places.filter((entry) => haversineM(entry, gps) <= (entry.radius ?? 150))
      .sort((a, b) => haversineM(a, gps) - haversineM(b, gps))[0];
    if (registered) { place = registered.name; source = 'gps'; }
    else if (!dryRun) {
      const result = await geocode(gps.lat, gps.lon);
      address = result?.address || null;
      place = result?.buildingName || address;
      if (place) source = 'gps';
    }
  }
  const payments = dates.flatMap((date) => paymentsForDay(date, root));
  const payment = payments.find((entry) => Date.parse(entry.at) >= first && Date.parse(entry.at) <= last);
  const activity = clean(payment?.merchant);
  return { place, address, summary: clean([titlePlace(place, address), activity].filter(Boolean).join(' · '))
    || timePeriod(first), source: source || (activity ? 'payment' : 'time') };
}

export function render(records, description, existing, now, movedFrom = null, options = {}) {
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
  const created = String(previousFields.created || now).slice(0, 10);
  const titleSummary = options.titleScene
    ? clean(titleWithScene(description.summary, { place: description.place, occasions: options.occasions,
      scene: options.titleScene, period: timePeriod(first) })) : description.summary;
  const momentTitle = `${day(first)} ${titleSummary} 순간`;
  const previousCategories = Array.isArray(previousFields.category) ? previousFields.category
    : previousFields.category ? [previousFields.category] : [];
  const configuredCategories = Array.isArray(options.category)
    ? options.category.map((category) => `[[${VAULT_REL.homeDir}/${category}]]`)
    : options.category || !previousCategories.length || previousFields.autoBaseCategory
      ? [`[[${VAULT_REL.homeDir}/${options.category || '100 나'}]]`] : [];
  // 출처가 기록된 자동 카테고리만 교체한다. 구형 노트의 출처 불명 값은 수동 값일 수 있다.
  const retainedCategories = previousCategories.filter((category) =>
    !(previousFields.autoBaseCategory ?? []).includes(category)
      || configuredCategories.includes(category));
  const categories = [...new Set([...retainedCategories, ...configuredCategories])];
  const fields = {
    ...previousFields,
    type: 'media', category: categories.length === 1 ? categories[0] : categories,
    description: momentTitle,
    sensitivity: '개인', created, modified: now.slice(0, 10), occurred: records[0].capturedAt,
    origin: `media:${records[0][options.pathField || 'archivePath']}`, mediaCount: records.length,
    momentId: records[0].id,
    mediaIds: records.map((record) => record.id), startAt: records[0].capturedAt,
    endAt: records.at(-1).capturedAt, infoSource: description.source,
  };
  if (options.category || !previousCategories.length || previousFields.autoBaseCategory) {
    fields.autoBaseCategory = configuredCategories;
  }
  if (options.source) fields.source = options.source;
  if (options.album) fields.album = options.album;
  if (options.albumLabel) fields.albumLabel = options.albumLabel;
  else if (options.source === 'import') delete fields.albumLabel;
  if (description.place) fields.place = description.place;
  else delete fields.place;
  if (description.address) fields.address = description.address;
  else delete fields.address;
  if (options.occasions?.length) {
    fields.occasions = options.occasions;
    fields.occasionSource = options.occasionSource;
  } else if (options.source === 'import') {
    delete fields.occasions;
    delete fields.occasionSource;
  }
  if (options.placeCategory) fields.placeCategory = options.placeCategory;
  else if (options.source === 'import') delete fields.placeCategory;
  if (options.vision) {
    if (options.vision.scenes.length) fields.scenes = options.vision.scenes;
    else delete fields.scenes;
    if (options.vision.faces > 0) fields.faces = options.vision.faces;
    else delete fields.faces;
  }
  if (options.titleScene) fields.titleScene = options.titleScene;
  else delete fields.titleScene;
  if (movedFrom) fields.movedFrom = [...new Set([
    ...(Array.isArray(previousFields.movedFrom) ? previousFields.movedFrom
      : previousFields.movedFrom ? [previousFields.movedFrom] : []), movedFrom])];
  const counts = options.facePhotos ? momentPeople(records.map((record) => record.id), options.facePhotos) : null;
  const needsPeople = counts && (Object.values(counts).some(Boolean)
    || fields.albumLabel === '미네' || previousFields.autoPeople?.length
    || previousFields.autoCategory?.length || previousFields.mineFaces != null
    || previousFields.mineBasis != null);
  const withPeople = needsPeople
    ? mergeMomentPeople(fields, records.map((record) => record.id), options.facePhotos,
      { albumMine: options.albumLabel === '미네' || fields.albumLabel === '미네' })
    : fields;
  const frontmatter = buildFrontmatter(withPeople);
  const lines = records.map((record) => {
    const path = record[options.pathField || 'archivePath'];
    return `- ${VIDEO.has(extname(path).toLowerCase()) ? '영상' : '사진'}: ${path}`;
  });
  const memoLinks = Array.isArray(fields.memos) ? fields.memos : [];
  const generated = `${START}\n# ${momentTitle}\n\n- 시간: ${clock(first)}–${clock(last)}\n- 장소·활동: ${description.summary}${description.address ? `\n- 주소: ${description.address}` : ''}${options.occasions?.length ? `\n- 기념일·일정: ${options.occasions.join(' · ')}` : ''}${options.vision?.scenes.length ? `\n- 장면: ${options.vision.scenes.join(', ')}` : ''}\n- 정보 출처: ${description.source}\n\n## 원본\n\n${lines.join('\n')}${memoLinks.length ? `\n\n${memoLinks.map((link) => `- 📎 메모: ${link}`).join('\n')}` : ''}\n${END}`;
  return `${frontmatter}${before}${generated}${owner}`;
}

export async function runMediaMoments({ root = VAULT_PATHS.root, indexPath = join(root, VAULT_REL.mediaArchiveIndex),
  statePath = join(root, VAULT_REL.mediaMomentsState), dryRun = false, since = null,
  videoPeoplePath = join(MEDIA_FACES_PATHS.root, 'video-matches.jsonl'),
  geocode = createCachedGeocoder({ root }), routeForDay = computeRoute,
  routePoints = readRoutePoints, paymentsForDay = readRoutePayments, places,
  write = writeAtomic, output = console, now = new Date().toISOString(), registryRules } = {}) {
  if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`)))) throw new Error('--since 날짜 오류');
  if (!existsSync(root)) throw new Error(`볼트 경로 없음: ${root}`);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('moments.json 형식 오류');
  const rules = registryRules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  const facePhotos = loadFacePhotos(root, { videoPeoplePath, output });
  // media-archive가 같은 JSONL을 append/복구할 수 있으므로 락 아래서 완성된 스냅샷만 읽는다.
  // 사진 분류·노트 생성은 락을 놓은 뒤 수행해 archive를 오래 막지 않는다.
  const records = dryRun || !existsSync(dirname(indexPath)) ? readIndex(indexPath)
    : await withLock(indexPath, () => readIndex(indexPath), { retries: 1200, retryDelayMs: 100 });
  const moments = groupMoments(records).filter((group) => !since || day(at(group.at(-1))) >= since);
  const vision = loadMomentVision(root, output);
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
    const enrichment = visionForMoment(records, vision?.rows, vision?.config);
    const date = day(at(records[0]));
    const directory = `${VAULT_REL.mediaMoments}/${date.slice(0, 4)}`;
    let oldRel = state[id]?.notePath;
    let interruptedMoveFrom = null;
    // 노트 이동 뒤 상태 파일 쓰기가 중단됐으면 momentId로 새 경로를 복구한다.
    if (oldRel && !existsSync(join(root, oldRel))) {
      interruptedMoveFrom = oldRel;
      names.delete(oldRel);
      oldRel = null;
    }
    if (!oldRel) {
      if (!discovered.has(date.slice(0, 4))) discovered.set(date.slice(0, 4), existingNotes(root, date.slice(0, 4)));
      oldRel = discovered.get(date.slice(0, 4)).get(id);
    }
    if (oldRel && (!oldRel.startsWith(`${directory}/`) || oldRel.includes('..'))) throw new Error(`순간 상태 경로 오류: ${id}`);
    const previousNote = oldRel && existsSync(join(root, oldRel)) ? readFileSync(join(root, oldRel), 'utf8') : null;
    const previousScene = previousNote && parseFrontmatter(previousNote).titleScene;
    const chosenScene = description.place || enrichment?.allPhotosAnalyzed === false ? null
      : previousScene || enrichment?.scenes[0];
    const title = titleWithScene(description.summary, { place: description.place,
      scene: chosenScene, period: timePeriod(at(records[0])) });
    const titleScene = title === description.summary ? null : chosenScene;
    const base = `${date} ${clean(title)} 순간`;
    const available = (candidate) => candidate === oldRel || (!names.has(candidate)
      && !visitedPaths.has(candidate) && !existsSync(join(root, candidate)));
    const candidates = [`${directory}/${base}.md`,
      `${directory}/${base} ${clock(at(records[0])).replace(':', '')}.md`,
      `${directory}/${base} ${id.slice(0, 8)}.md`];
    const rel = candidates.find(available);
    if (!rel) throw new Error(`순간 노트 파일명 충돌: ${id}`);
    if (visitedPaths.has(rel)) throw new Error(`중복 순간 노트 경로: ${rel}`);
    visitedPaths.add(rel);
    names.add(rel);
    const path = join(root, rel);
    const oldPath = join(root, oldRel || rel);
    const existing = existsSync(oldPath) ? readFileSync(oldPath, 'utf8') : null;
    if (state[id] && existing == null) throw new Error(`기존 순간 노트가 없음: ${state[id].notePath}`);
    const next = render(records, description, existing, now,
      oldRel && oldRel !== rel ? oldRel : interruptedMoveFrom,
      { vision: enrichment, titleScene, facePhotos });
    const stable = oldRel === rel && existing
      && next.replace(/^modified:.*$/m, '') === existing.replace(/^modified:.*$/m, '');
    if (stable) {
      if (!dryRun && (state[id]?.notePath !== rel
        || JSON.stringify(state[id].mediaIds) !== JSON.stringify(records.map((record) => record.id)))) {
        state[id] = { notePath: rel, mediaIds: records.map((record) => record.id) };
        stateDirty = true;
      }
      summary.skipped += 1; continue;
    }
    const problems = rules ? checkNote(rel, next, rules) : [];
    if (problems.length) throw new Error(`순간 노트 쓰기 관문: ${problems.join('; ')}`);
    if (!dryRun) {
      mkdirSync(dirname(path), { recursive: true });
      await withLock(oldPath, () => {
        const latest = existsSync(oldPath) ? readFileSync(oldPath, 'utf8') : null;
        if (latest !== existing) throw new Error(`쓰기 전 노트 변경: ${oldRel || rel}`);
        if (oldRel && oldRel !== rel && existsSync(path)) throw new Error(`이동 대상 노트가 이미 있음: ${rel}`);
        if (oldRel && oldRel !== rel) renameSync(oldPath, path);
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
  // 이 실행에서 새 순간 노트의 상태를 기록한 다음 연결해야 새 사진도 찾을 수 있다.
  try { await linkPhotoMemos({ root, state, archive: records, dryRun, now, write, registryRules: rules, output }); }
  catch (error) { output.log(`[media-moments] 사진 메모 연결 실패: ${String(error.message).split(/[\r\n]/, 1)[0]}`); }
  output.log(`[media-moments] ${dryRun ? 'dry-run ' : ''}새 순간 ${summary.created}, 갱신 ${summary.updated}, 건너뜀 ${summary.skipped}`);
  return summary;
}

export async function refreshMomentPeople({ root = VAULT_PATHS.root, dryRun = false,
  videoPeoplePath = join(MEDIA_FACES_PATHS.root, 'video-matches.jsonl'),
  write = writeAtomic, output = console, now = new Date().toISOString(), registryRules } = {}) {
  const photos = loadFacePhotos(root, { videoPeoplePath, output });
  if (!photos) {
    throw new Error('face-people.json이 없습니다');
  }
  const rules = registryRules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  const albumsPath = join(root, VAULT_REL.mediaImportAlbums);
  const albums = existsSync(albumsPath)
    ? JSON.parse(readFileSync(albumsPath, 'utf8')).albums ?? {} : {};
  const summary = { changed: 0, skipped: 0, failed: 0, examples: [], failures: [] };
  for (const stateRel of [VAULT_REL.mediaMomentsState, VAULT_REL.mediaImportMomentsState]) {
    const statePath = join(root, stateRel);
    if (!existsSync(statePath)) continue;
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    for (const entry of Object.values(state)) {
      if (!entry?.notePath || !Array.isArray(entry.mediaIds)) continue;
      const rel = entry.notePath;
      try {
      if (!rel.startsWith(`${VAULT_REL.mediaMoments}/`) || rel.includes('..')) throw new Error(`순간 경로 오류: ${rel}`);
      const path = join(root, rel);
      const existing = readFileSync(path, 'utf8');
      const header = existing.match(/^---\n[\s\S]*?\n---\n/);
      if (!header) throw new Error(`순간 머리말 오류: ${rel}`);
      // 공용 파서는 지원하지 않는 YAML 줄을 건너뛰므로 왕복 쓰기 전에 완전 파싱을 확인한다.
      const headerLines = header[0].slice(4, -5).split('\n');
      if (headerLines.some((line) => !/^[A-Za-z0-9_]+:\s*.*$/.test(line))) {
        throw new Error(`순간 머리말 미해석 줄: ${rel}`);
      }
      const fields = parseFrontmatter(existing);
      const counts = momentPeople(entry.mediaIds, photos);
      const configuredAlbum = fields.source === 'import' && fields.album ? albums[fields.album] : null;
      const needsBaseCategory = configuredAlbum && !Object.hasOwn(fields, 'autoBaseCategory');
      if (!Object.values(counts).some(Boolean) && fields.albumLabel !== '미네'
        && !fields.autoPeople?.length && !fields.autoCategory?.length
        && fields.mineFaces == null && fields.mineBasis == null && !needsBaseCategory) {
        summary.skipped += 1; continue;
      }
      const nextFields = mergeMomentPeople(fields, entry.mediaIds, photos,
        { albumMine: fields.albumLabel === '미네' });
      // 값이 하나일 때 원래 노트의 표기(목록/한 값)를 그대로 따른다 — 매시 순간 노트 잡과 번갈아 다시 쓰지 않게.
      if (nextFields.category.length === 1 && !Array.isArray(fields.category)) {
        nextFields.category = nextFields.category[0];
      }
      if (needsBaseCategory) {
        const configured = Array.isArray(configuredAlbum.category)
          ? configuredAlbum.category : [configuredAlbum.category];
        nextFields.autoBaseCategory = configured.map((category) => `[[${VAULT_REL.homeDir}/${category}]]`);
      }
      const comparable = (value) => JSON.stringify({ ...value, modified: null });
      if (comparable(nextFields) === comparable(fields)) { summary.skipped += 1; continue; }
      nextFields.modified = now.slice(0, 10);
      const next = `${buildFrontmatter(nextFields)}${existing.slice(header[0].length)}`;
      const problems = checkNote(rel, next, rules);
      if (problems.length) throw new Error(`순간 노트 쓰기 관문: ${problems.join('; ')}`);
      if (!dryRun) await withLock(path, () => {
        if (readFileSync(path, 'utf8') !== existing) throw new Error(`쓰기 전 노트 변경: ${rel}`);
        write(path, next);
      });
      summary.changed += 1;
      if (summary.examples.length < 10) summary.examples.push(rel);
      } catch (error) {
        summary.failed += 1;
        summary.failures.push({ notePath: rel, error: error.message });
        output.error?.(`[media-moments] 이름표 갱신 실패 ${rel}: ${error.message}`);
      }
    }
  }
  output.log(`[media-moments] ${dryRun ? 'dry-run ' : ''}이름표 갱신 ${summary.changed}, 건너뜀 ${summary.skipped}, 실패 ${summary.failed}`);
  for (const rel of summary.examples) output.log(`  ${rel}`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const since = args.find((arg) => arg.startsWith('--since='))?.slice('--since='.length);
  if (args.some((arg) => arg !== '--dry-run' && arg !== '--refresh-people' && !arg.startsWith('--since='))
    || args.includes('--refresh-people') && since) {
    console.error('usage: node scripts/jobs/media-moments.mjs [--dry-run] [--since=YYYY-MM-DD] | --refresh-people [--dry-run]');
    process.exitCode = 2;
  } else (args.includes('--refresh-people')
    ? refreshMomentPeople({ dryRun: args.includes('--dry-run') })
    : runMediaMoments({ dryRun: args.includes('--dry-run'), since })).catch((error) => {
    console.error(`[media-moments] ${error.stack}`); process.exitCode = 1;
  }).then((summary) => {
    if (args.includes('--refresh-people') && summary?.failed) process.exitCode = 1;
  });
}
