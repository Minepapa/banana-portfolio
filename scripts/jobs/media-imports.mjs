#!/usr/bin/env node
// 완료된 과거 앨범을 읽기 전용으로 색인하고, 확인된 촬영 시각의 순간만 노트로 만든다.
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, extname, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { capturedTime, gpsFrom, kstIso } from './media-archive.mjs';
import { groupTimedRecords, render, timePeriod, titlePlace, visionForMoment, loadMomentVision,
  titleWithScene } from './media-moments.mjs';
import { createCachedGeocoder } from '../lib/kakao-geocode.mjs';
import { listSelectedCalendars, listEventsForRange } from '../lib/google-calendar.mjs';
import { getAccessToken, CALENDAR_READ_SCOPES } from '../lib/google-oauth.mjs';
import { loadPeople } from '../lib/media-people.mjs';
import { haversineM, loadPlaces } from '../lib/location-stays.mjs';
import { parseRegistry, checkNote } from '../lib/vault-registry.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic, withLock } from '../lib/state-writer.mjs';
import { writeReviewSheet, applyReview } from './media-import-review.mjs';

const execFileAsync = promisify(execFile);
const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.avi', '.mkv', '.webm']);
const clean = (value) => String(value || '').replace(/[\\/:*?"<>|\r\n#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
const dateOf = (record) => record.capturedAt.slice(0, 10);
const clockOf = (record) => record.capturedAt.slice(11, 16).replace(':', '');
const jsonLines = (path) => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex').slice(0, 16);
}

async function exifBatch(files, exiftoolPath) {
  const result = new Map();
  for (let offset = 0; offset < files.length; offset += 200) {
    const batch = files.slice(offset, offset + 200);
    let stdout;
    try {
      ({ stdout } = await execFileAsync(exiftoolPath, ['-json', '-n', '-DateTimeOriginal',
        '-CreateDate', '-MediaCreateDate', '-Duration#', '-GPSLatitude', '-GPSLongitude',
        ...batch.map((file) => file.path)], { maxBuffer: 32 * 1024 * 1024 }));
    } catch (error) {
      if (!error.stdout) throw error;
      stdout = error.stdout;
    }
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows)) throw new Error('exiftool JSON 배열이 아닙니다');
    for (const row of rows) result.set(row.SourceFile, row);
    for (const file of batch) if (!result.has(file.path)) throw new Error(`exiftool 메타데이터 누락: ${file.path}`);
  }
  return result;
}

function albumFiles(mediaRoot, albums, selectedAlbum) {
  const importsRoot = join(mediaRoot, 'Imports');
  const directories = readdirSync(importsRoot, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of directories) if (!albums[entry.name]) throw new Error(`설정에 없는 Imports 앨범: ${entry.name}`);
  if (selectedAlbum && !directories.some((entry) => entry.name === selectedAlbum)) throw new Error(`Imports 앨범 없음: ${selectedAlbum}`);
  const files = [];
  function visit(path, album) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '.stignore' || entry.name === '.DS_Store') continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child, album);
      else if (entry.isFile()) files.push({ path: child, album, stat: lstatSync(child),
        importPath: relative(mediaRoot, child).split('\\').join('/') });
      // Symlink는 따라가지 않는다. Imports 바깥 파일을 우연히 색인하지 않기 위해서다.
    }
  }
  for (const entry of directories) if (!selectedAlbum || entry.name === selectedAlbum) visit(join(importsRoot, entry.name), entry.name);
  return files.sort((a, b) => a.importPath.localeCompare(b.importPath));
}

function setDuplicates(records, albums, archiveIds) {
  const byId = new Map();
  for (const record of records) {
    delete record.duplicateOf;
    if (!byId.has(record.id)) byId.set(record.id, []);
    byId.get(record.id).push(record);
  }
  for (const [id, same] of byId) {
    if (archiveIds.has(id)) {
      for (const record of same) record.duplicateOf = `archive:${id}`;
      continue;
    }
    same.sort((a, b) => (albums[a.album]?.priority ?? Infinity) - (albums[b.album]?.priority ?? Infinity)
      || a.album.localeCompare(b.album) || a.importPath.localeCompare(b.importPath));
    for (const record of same.slice(1)) record.duplicateOf = `import:${same[0].importPath}`;
  }
}

export async function indexImports({ root = VAULT_PATHS.root, mediaRoot = join(homedir(), 'Pantheon', 'Media'),
  album = null, dryRun = false, albumsPath = join(root, VAULT_REL.mediaImportAlbums),
  indexPath = join(root, VAULT_REL.mediaImportsIndex), archiveIndexPath = join(root, VAULT_REL.mediaArchiveIndex),
  exiftoolPath = '/opt/homebrew/bin/exiftool', metadataForFiles = exifBatch,
  hash = hashFile, write = writeAtomic, output = console, now = new Date().toISOString() } = {}) {
  const albums = JSON.parse(readFileSync(albumsPath, 'utf8')).albums;
  if (!albums || typeof albums !== 'object' || Array.isArray(albums)) throw new Error('import-albums.json 형식 오류');
  const files = albumFiles(mediaRoot, albums, album);
  const previous = jsonLines(indexPath);
  const byPath = new Map(previous.map((record) => [record.importPath, record]));
  const unchanged = (file) => byPath.get(file.importPath)?.size === file.stat.size
    && byPath.get(file.importPath)?.mtime === file.stat.mtimeMs;
  const changed = files.filter((file) => !unchanged(file));
  const metadata = !changed.length ? new Map() : await metadataForFiles(changed, exiftoolPath);
  const records = album ? previous.filter((record) => record.album !== album) : [];
  for (const file of files) {
    if (unchanged(file)) { records.push(byPath.get(file.importPath)); continue; }
    const tags = metadata.get(file.path);
    if (!tags) throw new Error(`exiftool 메타데이터 누락: ${file.path}`);
    const captured = capturedTime(file, tags);
    const year = Number(kstIso(captured.date).slice(0, 4));
    const bounds = albums[file.album].years;
    if (bounds && (year < bounds[0] || year > bounds[1])) {
      captured.confidence = 'review';
      const range = bounds[0] === bounds[1] ? String(bounds[0]) : `${bounds[0]}–${bounds[1]}`;
      captured.reason = [captured.reason, `폴더 연도 ${range}와 다름`].filter(Boolean).join('; ');
    }
    if (dryRun) {
      records.push({ album: file.album, capturedConfidence: captured.confidence,
        ...(basename(file.path).startsWith('Screenshot_') ? { screenshot: true } : {}) });
      continue;
    }
    const id = await hash(file.path);
    const latest = lstatSync(file.path);
    if (!latest.isFile() || latest.size !== file.stat.size || latest.mtimeMs !== file.stat.mtimeMs
      || latest.ino !== file.stat.ino || latest.dev !== file.stat.dev) throw new Error(`색인 중 원본 변경: ${file.importPath}`);
    const gps = gpsFrom(tags);
    records.push({ id, kind: 'Import', album: file.album, importPath: file.importPath,
      capturedAt: kstIso(captured.date), capturedFrom: captured.from,
      capturedConfidence: captured.confidence, ...(captured.reason ? { capturedReason: captured.reason } : {}),
      ...(gps ? { gps } : {}), size: file.stat.size, mtime: file.stat.mtimeMs, indexedAt: now,
      ...(basename(file.path).startsWith('Screenshot_') ? { screenshot: true } : {}) });
  }
  if (!dryRun) {
    const archiveIds = new Set(jsonLines(archiveIndexPath).map((record) => record.id));
    setDuplicates(records, albums, archiveIds);
    records.sort((a, b) => a.importPath.localeCompare(b.importPath));
    mkdirSync(dirname(indexPath), { recursive: true });
    await withLock(indexPath, () => write(indexPath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '')));
  }
  const summary = { albums: {}, confidence: { confirmed: 0, single: 0, estimated: 0, review: 0 },
    duplicate: { archive: 0, import: 0 }, screenshots: 0, reused: files.length - changed.length };
  for (const file of files) summary.albums[file.album] = (summary.albums[file.album] || 0) + 1;
  for (const record of records.filter((item) => !album || item.album === album)) {
    if (record.capturedConfidence in summary.confidence) summary.confidence[record.capturedConfidence] += 1;
    if (record.duplicateOf?.startsWith('archive:')) summary.duplicate.archive += 1;
    if (record.duplicateOf?.startsWith('import:')) summary.duplicate.import += 1;
    if (record.screenshot) summary.screenshots += 1;
  }
  output.log(`[media-imports] ${dryRun ? 'dry-run ' : ''}색인 ${JSON.stringify(summary)}`);
  return summary;
}

export function groupImportMoments(records) {
  const albums = new Map();
  for (const record of records) {
    if (record.kind !== 'Import' || record.duplicateOf || record.screenshot
      || !['confirmed', 'single', 'album'].includes(record.capturedConfidence)
      || !Number.isFinite(Date.parse(record.capturedAt)) || typeof record.id !== 'string') continue;
    const key = `${record.album}\0${record.capturedConfidence === 'album' ? 'unknown' : 'dated'}`;
    if (!albums.has(key)) albums.set(key, []);
    albums.get(key).push(record);
  }
  return [...albums].flatMap(([key, rows]) => key.endsWith('\0unknown')
    ? [[...rows].sort((a, b) => a.importPath.localeCompare(b.importPath))] : groupTimedRecords(rows))
    .sort((a, b) => Date.parse(a[0].capturedAt) - Date.parse(b[0].capturedAt)
      || a[0].album.localeCompare(b[0].album) || a[0].importPath.localeCompare(b[0].importPath));
}

export function unknownDateFormatRegistered(root) {
  const path = join(root, VAULT_REL.registryFile);
  if (!existsSync(path)) return false;
  // 등록부의 media 표 행에 경로·제목·occurred 값·dateCertainty가 모두 명시되어야
  // 새 형식을 허용한다. 일반 YYYY 정규식의 0000 매칭은 승인으로 취급하지 않는다.
  return readFileSync(path, 'utf8').split('\n').some((line) =>
    /^\|\s*`media`\s*\|/.test(line)
    && line.includes('24_Media/0000/') && line.includes('0000-00-00')
    && line.includes('occurred') && line.includes('날짜 미상')
    && line.includes('dateCertainty'));
}

export const isDomesticGps = (point) => point.lat >= 33 && point.lat <= 38.7
  && point.lon >= 124.5 && point.lon <= 131.9;

function observedDay(monthDay, year) {
  return monthDay === '02-29' && new Date(year, 1, 29).getMonth() !== 1 ? '02-28' : monthDay;
}

export function anniversariesForDay(date, people) {
  const year = Number(date.slice(0, 4));
  const matches = [];
  for (const person of [...people].sort((a, b) => a.title.localeCompare(b.title, 'ko'))) {
    if (typeof person.birthday === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(person.birthday)
      && observedDay(person.birthday.slice(5), year) === date.slice(5)
      && year >= Number(person.birthday.slice(0, 4))) {
      matches.push(`${person.title} ${person.birthday === date ? '태어난 날' : '생일'}`);
    }
    for (const entry of person.anniversaries ?? []) {
      const match = String(entry).match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
      if (!match || year < Number(match[1].slice(0, 4))
        || observedDay(match[1].slice(5), year) !== date.slice(5)) continue;
      matches.push(`${match[2]} ${match[1] === date ? '당일' : '기념일'}`);
    }
  }
  return [...new Set(matches)];
}

function calendarRules(config) {
  if (!Object.hasOwn(config, 'calendar')) return null;
  const rules = config.calendar;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)
    || !Number.isInteger(rules.maxAllDayDays) || rules.maxAllDayDays < 0
    || !Array.isArray(rules.keepKeywords) || !rules.keepKeywords.every((word) => typeof word === 'string' && word.length > 0)
    || !Array.isArray(rules.excludeKeywords) || !rules.excludeKeywords.every((word) => typeof word === 'string' && word.length > 0)) {
    throw new Error('import-albums.json calendar 형식 오류');
  }
  return rules;
}

export function calendarOccasions(group, events, rules = null) {
  const date = dateOf(group[0]);
  const start = Date.parse(group[0].capturedAt);
  const end = Date.parse(group.at(-1).capturedAt);
  const matches = [...events].filter((event) => {
    if (!event.title?.trim() || event.title === '(제목 없음)' || event.pantheon
      || /#(?:holiday|contacts|weeknum)@/.test(event.calendarId ?? '')) return false;
    if (rules) {
      const title = event.title.toLowerCase();
      if (rules.excludeKeywords.some((word) => title.includes(word.toLowerCase()))) return false;
      if (event.allDay && (Date.parse(event.end) - Date.parse(event.start)) / 86_400_000 > rules.maxAllDayDays
        && !rules.keepKeywords.some((word) => title.includes(word.toLowerCase()))) return false;
    }
    if (event.allDay) return event.start <= date && date < event.end;
    return Date.parse(event.start) <= end + 30 * 60_000
      && Date.parse(event.end) >= start - 30 * 60_000;
  }).sort((a, b) => Number(b.allDay) - Number(a.allDay)
    || Date.parse(a.start) - Date.parse(b.start));
  return [...new Set(matches.map((event) => clean(event.title)).filter(Boolean))].slice(0, 1);
}

export function selectOccasions(anniversaries, calendar) {
  const exact = anniversaries.filter((item) => item.endsWith(' 당일') || item.endsWith(' 태어난 날'));
  const recurring = exact.length ? [] : anniversaries.filter((item) => item.endsWith(' 기념일') || item.endsWith(' 생일'));
  return [...new Set([...exact, ...calendar.slice(0, 1), ...recurring])].slice(0, 2);
}

function existingImportNotes(root, year) {
  const directory = join(root, VAULT_REL.mediaMoments, year);
  const found = new Map();
  if (!existsSync(directory)) return found;
  for (const name of readdirSync(directory).filter((item) => item.endsWith('.md'))) {
    const rel = `${VAULT_REL.mediaMoments}/${year}/${name}`;
    const fields = parseFrontmatter(readFileSync(join(root, rel), 'utf8'));
    if (fields.source !== 'import' || !fields.momentId) continue;
    if (found.has(fields.momentId)) throw new Error(`중복 Imports momentId 노트: ${fields.momentId}`);
    found.set(fields.momentId, rel);
  }
  return found;
}

export async function runImportMoments({ root = VAULT_PATHS.root, album = null, limit = 300, dryRun = false,
  noCalendar = false, noPoi = false, calendarFetch = fetch,
  accessToken = () => getAccessToken({ requiredScopes: CALENDAR_READ_SCOPES }),
  albumsPath = join(root, VAULT_REL.mediaImportAlbums), indexPath = join(root, VAULT_REL.mediaImportsIndex),
  statePath = join(root, VAULT_REL.mediaImportMomentsState),
  geocode = createCachedGeocoder({ root }), places = loadPlaces(root), registryRules,
  write = writeAtomic, output = console, now = new Date().toISOString(), indexRecords = null,
  reviewIds = null } = {}) {
  if (!Number.isInteger(limit) || limit < 0) throw new Error('--limit 양의 정수 오류');
  const albumsConfig = JSON.parse(readFileSync(albumsPath, 'utf8'));
  const albums = albumsConfig.albums;
  const calendar = calendarRules(albumsConfig);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const rules = registryRules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  const facePeoplePath = join(root, VAULT_REL.mediaFacePeople);
  const facePhotos = existsSync(facePeoplePath)
    ? JSON.parse(readFileSync(facePeoplePath, 'utf8')).photos ?? {} : null;
  const allGroups = groupImportMoments(indexRecords ?? jsonLines(indexPath));
  const selectedGroups = allGroups.filter((group) => (!album || group[0].album === album)
    && (!reviewIds || group.some((record) => reviewIds.has(record.id))));
  const stateEntries = Object.entries(state);
  const overlaps = (group, ownerId, entry) => group.some((record) => record.id === ownerId
    || entry.mediaIds?.includes(record.id));
  // 날짜 교정으로 기존 순간의 첫 파일이 바뀌어도 기존 노트를 다시 사용한다.
  // 한 노트가 두 순간으로 갈라지거나 두 노트가 합쳐지면 자동 이관은 메모 소유권을 잃을 수 있어 중단한다.
  for (const [ownerId, entry] of stateEntries) {
    if (!selectedGroups.some((group) => overlaps(group, ownerId, entry))) continue;
    if (allGroups.filter((group) => overlaps(group, ownerId, entry)).length > 1)
      throw new Error(`Imports 순간 분할 판정 보류: ${ownerId}`);
  }
  const groups = selectedGroups;
  const unknownDateApproved = unknownDateFormatRegistered(root);
  const vision = loadMomentVision(root, output);
  const people = loadPeople(root);
  const eventsByYear = new Map();
  const datedGroups = groups.filter((group) => group[0].capturedConfidence !== 'album');
  if (!noCalendar && datedGroups.length) {
    try {
      const token = await accessToken();
      const calendars = await listSelectedCalendars({ token, fetchImpl: calendarFetch });
      for (const year of new Set(datedGroups.map((group) => dateOf(group[0]).slice(0, 4)))) {
        const firstDay = Date.parse(`${year}-01-01T00:00:00+09:00`);
        const nextDay = Date.parse(`${Number(year) + 1}-01-01T00:00:00+09:00`);
        eventsByYear.set(year, await listEventsForRange(
          new Date(firstDay - 30 * 60_000).toISOString(), new Date(nextDay + 30 * 60_000).toISOString(),
          { token, fetchImpl: calendarFetch, calendars }));
      }
    } catch (error) {
      eventsByYear.clear();
      (output.warn ?? output.log).call(output, `[media-imports] 캘린더 미조회: ${String(error.message).replace(/[\r\n]+/g, ' ')}`);
    }
  }
  const reserved = new Set(Object.values(state).map((entry) => entry.notePath));
  const discovered = new Map();
  const summary = { created: 0, updated: 0, skipped: 0, deferred: 0, unprocessed: 0, examples: [] };
  let stateDirty = false;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    if (!dryRun && summary.created + summary.updated >= limit) {
      // 변경 여부는 제목·장소·앨범 설정에도 달려 있으므로, 읽지 않은 순간 수만 보고한다.
      summary.unprocessed = groups.length - groupIndex;
      break;
    }
    const group = groups[groupIndex];
    const first = group[0];
    const dateUnknown = group.some((record) => record.capturedConfidence === 'album');
    if (dateUnknown && !dryRun && !unknownDateApproved) {
      summary.deferred += 1;
      continue;
    }
    const config = albums[first.album];
    if (!config) throw new Error(`설정에 없는 Imports 앨범: ${first.album}`);
    const gps = group.map((record) => record.gps).find((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon));
    let place = null;
    let address = null;
    let placeCategory = null;
    let unresolvedGps = false;
    if (gps) {
      const registered = places.filter((entry) => haversineM(entry, gps) <= (entry.radius ?? 150))
        .sort((a, b) => haversineM(a, gps) - haversineM(b, gps))[0];
      if (registered) place = registered.name;
      else if (!dryRun && isDomesticGps(gps)) {
        const nearby = !noPoi ? await geocode.nearbyPlace?.(gps.lat, gps.lon) : null;
        const found = await geocode(gps.lat, gps.lon);
        address = found?.address || null;
        place = nearby?.name || found?.buildingName || address;
        placeCategory = nearby?.name ? nearby.category : null;
      } else if (dryRun && isDomesticGps(gps)) unresolvedGps = true;
    }
    const date = dateOf(first);
    const noteDay = dateUnknown ? '0000-00-00' : date;
    const noteYear = noteDay.slice(0, 4);
    const anniversaries = dateUnknown ? [] : anniversariesForDay(date, people);
    const calendarMatches = dateUnknown ? [] : calendarOccasions(group, eventsByYear.get(date.slice(0, 4)) ?? [], calendar);
    const occasions = selectOccasions(anniversaries, calendarMatches);
    const enrichment = visionForMoment(group, vision?.rows, vision?.config);
    const period = timePeriod(Date.parse(first.capturedAt));
    const titleParts = () => [dateUnknown ? '날짜 미상' : null, config.label || (dateUnknown ? first.album : null),
      ...occasions, titlePlace(place, address)].filter(Boolean).join(' · ');
    const summaryTitle = clean(titleParts() + (!dateUnknown && !place && !occasions.length && config.label ? ` ${period}` : '') || period);
    const occasionSource = [...new Set([
      ...(occasions.some((item) => anniversaries.includes(item)) ? ['anniversary'] : []),
      ...(occasions.some((item) => calendarMatches.includes(item)) ? ['calendar'] : []),
    ])];
    const description = { summary: summaryTitle, place, address,
      source: dateUnknown ? 'album' : place ? 'gps' : occasionSource[0] || 'time' };
    const directory = `${VAULT_REL.mediaMoments}/${noteYear}`;
    if (!discovered.has(noteYear)) discovered.set(noteYear, existingImportNotes(root, noteYear));
    const owners = stateEntries.filter(([ownerId, entry]) => overlaps(group, ownerId, entry));
    if (owners.length > 1) throw new Error(`Imports 순간 병합 판정 보류: ${first.id}`);
    const ownerId = owners[0]?.[0] ?? first.id;
    const savedRel = owners[0]?.[1].notePath;
    const interruptedMoveFrom = savedRel && !existsSync(join(root, savedRel)) ? savedRel : null;
    const oldRel = interruptedMoveFrom
      ? discovered.get(noteYear).get(first.id) || discovered.get(noteYear).get(ownerId)
      : savedRel || discovered.get(noteYear).get(first.id);
    if (interruptedMoveFrom && !oldRel) throw new Error(`이동된 Imports 순간 노트 없음: ${savedRel}`);
    if (oldRel && (!new RegExp(`^${VAULT_REL.mediaMoments}/\\d{4}/[^/]+\\.md$`).test(oldRel)
      || !existsSync(join(root, oldRel)))) throw new Error(`기존 Imports 순간 노트 없음: ${oldRel}`);
    const previousScene = oldRel ? parseFrontmatter(readFileSync(join(root, oldRel), 'utf8')).titleScene : null;
    const chosenScene = place || occasions.length || enrichment?.allPhotosAnalyzed === false ? null
      : previousScene || enrichment?.scenes[0];
    const withScene = titleWithScene(summaryTitle, { place, occasions, scene: chosenScene, period });
    const titleScene = withScene === summaryTitle ? null : chosenScene;
    const title = withScene === summaryTitle ? summaryTitle : clean(withScene);
    const base = `${noteDay} ${title} 순간`;
    const candidates = dateUnknown
      ? [`${directory}/${base}.md`, `${directory}/${base} ${first.id.slice(0, 8)}.md`]
      : [`${directory}/${base}.md`, `${directory}/${base} ${clockOf(first)}.md`,
        `${directory}/${base} ${first.id.slice(0, 8)}.md`];
    const rel = candidates.find((candidate) => candidate === oldRel || (!reserved.has(candidate) && !existsSync(join(root, candidate))));
    if (!rel) throw new Error(`순간 노트 파일명 충돌: ${first.id}`);
    reserved.add(rel);
    if (summary.examples.length < 20) summary.examples.push(unresolvedGps
      ? `${rel} (GPS 주소 미확인; 실제 제목 변경 가능)` : rel);
    const oldPath = join(root, oldRel || rel);
    const existing = oldRel ? readFileSync(oldPath, 'utf8') : null;
    const existingFields = existing ? parseFrontmatter(existing) : null;
    if (existingFields && (existingFields.source !== 'import'
      || ![ownerId, first.id].includes(existingFields.momentId)))
      throw new Error(`기존 Imports 순간 소유자 불일치: ${oldRel}`);
    const next = render(group, description, existing, now,
      oldRel && oldRel !== rel ? oldRel : interruptedMoveFrom,
      { category: config.category, source: 'import', album: first.album, albumLabel: config.label,
        pathField: 'importPath', occasions, occasionSource, placeCategory, vision: enrichment,
        titleScene, facePhotos, dateUnknown,
        previousMomentId: existingFields?.momentId });
    if (existing && next.replace(/^modified:.*$/m, '') === existing.replace(/^modified:.*$/m, '')) {
      if (!dryRun && (!state[first.id] || state[first.id].notePath !== rel
        || JSON.stringify(state[first.id].mediaIds) !== JSON.stringify(group.map((record) => record.id)))) {
        if (ownerId !== first.id) delete state[ownerId];
        state[first.id] = { notePath: rel, mediaIds: group.map((record) => record.id) };
        stateDirty = true;
      }
      summary.skipped += 1;
      continue;
    }
    const problems = rules ? checkNote(rel, next, rules) : [];
    if (problems.length) throw new Error(`순간 노트 쓰기 관문: ${problems.join('; ')}`);
    if (!dryRun) {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      await withLock(oldPath, () => {
        if ((existsSync(oldPath) ? readFileSync(oldPath, 'utf8') : null) !== existing) throw new Error(`쓰기 전 노트 변경: ${oldRel || rel}`);
        if (oldRel && oldRel !== rel) {
          if (existsSync(path)) throw new Error(`이동 대상 노트가 이미 있음: ${rel}`);
          renameSync(oldPath, path);
        }
        write(path, next);
      });
      if (ownerId !== first.id) delete state[ownerId];
      state[first.id] = { notePath: rel, mediaIds: group.map((record) => record.id) };
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
  output.log(`[media-imports] ${dryRun ? 'dry-run ' : ''}순간 ${JSON.stringify(summary)}`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const stages = { index: args.includes('--index'), moments: args.includes('--moments'),
    reviewSheet: args.includes('--review-sheet'), applyReview: args.find((arg) => arg.startsWith('--apply-review=')) };
  const album = args.find((arg) => arg.startsWith('--album='))?.slice(8);
  const rawLimit = args.find((arg) => arg.startsWith('--limit='))?.slice(8);
  const limit = rawLimit === undefined ? 300 : Number(rawLimit);
  const usage = 'usage: node scripts/jobs/media-imports.mjs --review-sheet [--include-estimated] | --apply-review=answers.json [--dry-run] | [--index] [--moments] [--album=이름] [--limit=n] [--dry-run] [--no-calendar] [--no-poi]';
  if ((!stages.index && !stages.moments && !stages.reviewSheet && !stages.applyReview)
    || [stages.index, stages.moments, stages.reviewSheet, stages.applyReview].filter(Boolean).length > 2
    || (stages.reviewSheet || stages.applyReview) && (stages.index || stages.moments || album || rawLimit)
    || !Number.isInteger(limit) || limit < 0
    || args.some((arg) => !['--index', '--moments', '--review-sheet', '--include-estimated', '--dry-run', '--no-calendar', '--no-poi'].includes(arg)
      && !arg.startsWith('--apply-review=') && !arg.startsWith('--album=') && !arg.startsWith('--limit='))) {
    console.error(usage); process.exitCode = 2;
  } else (async () => {
    if (stages.index) await indexImports({ album, dryRun: args.includes('--dry-run') });
    if (stages.moments) await runImportMoments({ album, limit, dryRun: args.includes('--dry-run'),
      noCalendar: args.includes('--no-calendar'), noPoi: args.includes('--no-poi') });
    if (stages.reviewSheet) await writeReviewSheet({ includeEstimated: args.includes('--include-estimated') });
    if (stages.applyReview) await applyReview({ answersPath: stages.applyReview.slice('--apply-review='.length),
      dryRun: args.includes('--dry-run'), runMoments: runImportMoments });
  })().catch((error) => { console.error(`[media-imports] ${error.stack}`); process.exitCode = 1; });
}
