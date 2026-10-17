/** Read-only ranking for Mine's photo memory orbs. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { VAULT_PATHS, VAULT_REL, MEDIA_FACES_PATHS, categoryLink } from './vault-paths.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { occurredDate } from '../jobs/mine-athena-fields.mjs';
import { albumForMoment, momentPhotos } from '../tools/media-memory-orb-trial.mjs';

export const CANDIDATE_LIMIT = 600; // Owner's 2026-10-17 target: roughly 400–600 moments.
export const BUSY_DAY_FRACTION = 0.10;
// Event words named in request 5-5f-2 and the 2026-10-17 decision; unlike a generic place,
// each denotes a discrete moment that can become a replayable orb.
export const EVENT_WORDS = Object.freeze(['생일', '첫', '돌', '여행', '결혼', '입학', '졸업', '공연', '기념일', '입원', '퇴원', '발표회', '운동회', '수학여행']);
const EVENT_RE = new RegExp(EVENT_WORDS.join('|'));
const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.avi', '.mkv', '.webm']);
const MINE_CATEGORY = categoryLink('201 미네');
const MINE_PERSON = `[[${VAULT_REL.people}/미네]]`;
const ORB_KEYS = ['emotions', 'primaryEmotion', 'emotionIntensity', 'emotionEvidence',
  'secondFilmSignal', 'importance', 'coreMemory', 'coreMemoryCandidate', 'coreMemoryReason',
  'representativePhotos', 'representativePhotoEvidence', 'orbScene', 'orbTitleSuggestion'];
const list = (value) => Array.isArray(value) ? value : value == null ? [] : [value];

function files(root, rel) {
  const dir = join(root, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('99_') || entry.name.startsWith('.')) return [];
    const child = `${rel}/${entry.name}`;
    return entry.isDirectory() ? files(root, child) : entry.isFile() && entry.name.endsWith('.md') ? [child] : [];
  });
}

function jsonLines(path) {
  if (!existsSync(path)) throw new Error(`필수 색인 없음: ${path}`);
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines.at(-1) !== '') lines.pop(); // Ignore an in-progress append.
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}

export function hasOrb(fields) {
  return ORB_KEYS.some((key) => fields[key] !== undefined);
}

export function scoreMoment(item, { busyDates = new Set(), relatedDates = new Map() } = {}) {
  const reasons = [];
  const add = (weight, signal, evidence) => { if (evidence) reasons.push({ signal, evidence: String(evidence).slice(0, 200), weight }); };
  for (const [signal, value] of [
    ['제목', item.title], ['앨범', item.album], ['기념일', item.fields.anniversary ?? item.fields.occasion],
    ['캘린더 일정', item.calendar],
  ]) {
    const match = String(value ?? '').match(EVENT_RE);
    if (match) add(signal === '앨범' ? 8 : 12, signal, `${match[0]}: ${value}`);
  }
  if (item.memo.trim()) add(12, '오너 메모', item.memo.trim());
  if (item.photoMemo) add(10, '사진 메모', item.photoMemo);
  if (busyDates.has(item.date)) add(5, '그 해 사진·영상 많은 날', `${item.date} ${item.dayMediaCount}개`);
  if (item.mineVideoNames.length) add(9, '미네 이름표 영상', item.mineVideoNames.join(', '));
  const related = relatedDates.get(item.date) ?? [];
  if (related.length) add(7, '같은 날 녹음·통화·노트', related.slice(0, 3).join(', '));
  return { ...item, score: reasons.reduce((sum, reason) => sum + reason.weight, 0), reasons };
}

export function rankCandidates(items, { limit = CANDIDATE_LIMIT, relatedDates = new Map() } = {}) {
  const dayCounts = new Map();
  for (const item of items) dayCounts.set(item.date, (dayCounts.get(item.date) ?? 0) + item.mediaCount);
  const byYear = new Map();
  for (const [date, count] of dayCounts) {
    const year = date.slice(0, 4);
    byYear.set(year, [...(byYear.get(year) ?? []), { date, count }]);
  }
  const busyDates = new Set();
  for (const days of byYear.values()) {
    const topCount = Math.max(1, Math.ceil(days.length * BUSY_DAY_FRACTION));
    days.sort((a, b) => b.count - a.count || a.date.localeCompare(b.date));
    for (const day of days.slice(0, topCount)) busyDates.add(day.date);
  }
  return items.map((item) => scoreMoment({ ...item, dayMediaCount: dayCounts.get(item.date) }, { busyDates, relatedDates }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.mediaCount - a.mediaCount || a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function sameDayRecords(root) {
  const dates = new Map();
  for (const rel of [...files(root, VAULT_REL.mediaConversations), ...files(root, VAULT_REL.recordsNotes)]) {
    const content = readFileSync(join(root, rel), 'utf8');
    const fields = parseFrontmatter(content);
    if (!list(fields.category).includes(MINE_CATEGORY) && !list(fields.people).includes(MINE_PERSON)) continue;
    const date = occurredDate(fields.occurred);
    if (date) dates.set(date, [...(dates.get(date) ?? []), rel.split('/').at(-1)]);
  }
  return dates;
}

export function loadCandidates({ root = VAULT_PATHS.root, mediaRoot = MEDIA_FACES_PATHS.mediaRoot,
  limit = CANDIDATE_LIMIT } = {}) {
  const people = JSON.parse(readFileSync(join(root, VAULT_REL.mediaFacePeople), 'utf8')).photos;
  const media = [...jsonLines(join(root, VAULT_REL.mediaArchiveIndex)), ...jsonLines(join(root, VAULT_REL.mediaImportsIndex))];
  const mediaById = new Map(media.map((row) => [row.id, row]));
  const videoPeoplePath = join(MEDIA_FACES_PATHS.root, 'video-matches.jsonl');
  const videoPeople = existsSync(videoPeoplePath) ? new Map(jsonLines(videoPeoplePath).map((row) => [row.id, row])) : new Map();
  const items = [];
  for (const rel of files(root, VAULT_REL.mediaMoments)) {
    const content = readFileSync(join(root, rel), 'utf8');
    const fields = parseFrontmatter(content);
    if (!list(fields.category).includes(MINE_CATEGORY) || hasOrb(fields) || !/^[a-f0-9]{16}$/i.test(String(fields.momentId ?? ''))) continue;
    const paths = [...content.matchAll(/^- (?:사진|영상): (.+)$/gm)].map((match) => match[1]);
    const ids = list(fields.mediaIds);
    const albumBasis = fields.mineBasis === 'album';
    const photos = momentPhotos(ids, paths, people, mediaById, mediaRoot, undefined, undefined, { allowAlbumBasis: albumBasis });
    if (!photos.length) continue; // A photo orb needs a verified source path and Mine basis.
    const date = occurredDate(fields.occurred);
    if (!date) continue;
    const memo = content.split(/^## 오너 메모\s*$/m)[1]?.split(/^## /m)[0]?.trim().slice(0, 2500) ?? '';
    const calendar = content.match(/^- 기념일·일정: (.+)$/m)?.[1] ?? '';
    const photoMemo = [...content.matchAll(/^- 📎 메모: (.+)$/gm)].map((match) => match[1]).join(', ');
    const mineVideoNames = ids.map((id, index) => VIDEO.has(extname(paths[index] ?? '').toLowerCase())
      && videoPeople.get(id)?.people?.includes('미네') ? paths[index] : null).filter(Boolean);
    items.push({ id: fields.momentId, rel, content, fields, date,
      title: fields.description ?? rel.split('/').at(-1).replace(/\.md$/, ''),
      album: albumForMoment(photos, mediaById) ?? fields.album, memo, calendar, photoMemo,
      photos, albumBasis, mineVideoNames, mediaCount: ids.length });
  }
  return rankCandidates(items, { limit, relatedDates: sameDayRecords(root) });
}
