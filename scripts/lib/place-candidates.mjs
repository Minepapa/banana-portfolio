import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { haversineM, STAY_RADIUS_M } from './location-stays.mjs';
import { writeAtomic } from './state-writer.mjs';
import { VAULT_REL } from './vault-paths.mjs';

const MIN_EVENT_OVERLAP_MS = 30 * 60_000;
const MIN_EVENT_OVERLAP_RATIO = 0.5;

export function readCandidates(root) {
  const path = join(root, VAULT_REL.locationCandidates);
  if (!existsSync(path)) return [];
  const candidates = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(candidates) || candidates.some((item) => !item || typeof item !== 'object'
    || typeof item.id !== 'string' || !Number.isFinite(item.lat) || !Number.isFinite(item.lon)
    || !Array.isArray(item.visits) || !Array.isArray(item.eventTitles) || typeof item.status !== 'string')) {
    throw new Error('장소 후보 파일 형식 오류');
  }
  return candidates;
}
export function saveCandidates(root, candidates) {
  const path = join(root, VAULT_REL.locationCandidates);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify(candidates, null, 2)}\n`);
}
const visitCount = (candidate, date) => candidate.visits.filter((visit) => visit >= new Date(Date.parse(`${date}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10) && visit <= date).length;
export function readyCandidate(candidate, date) {
  return visitCount(candidate, date) >= 2;
}
export function updateCandidates({ date, stays, events = [], root, dryRun = false }) {
  const candidates = readCandidates(root);
  for (const stay of stays.filter((item) => !item.registered && !item.autoNamed)) {
    let candidate = candidates.find((item) => haversineM(item, stay) <= STAY_RADIUS_M);
    if (candidate && candidate.status !== '관찰') continue;
    if (!candidate) {
      const next = Math.max(0, ...candidates.map((item) => Number(item.id.slice(1)) || 0)) + 1;
      candidate = { id: `C${next}`, lat: stay.lat, lon: stay.lon, address: stay.address || '', visits: [], eventTitles: [], status: '관찰', askedAt: null };
      candidates.push(candidate);
    }
    if (!candidate.visits.includes(date)) candidate.visits.push(date);
    candidate.visits.sort();
    const start = Date.parse(stay.start);
    const end = Date.parse(stay.end);
    for (const event of events) {
      const eventStart = Date.parse(event.start);
      const eventEnd = Date.parse(event.end);
      if (event.allDay || !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(eventStart) || !Number.isFinite(eventEnd)
        || eventStart >= end || eventEnd <= start) continue;
      const overlapMs = Math.min(end, eventEnd) - Math.max(start, eventStart);
      const eventDurationMs = eventEnd - eventStart;
      // 송도 센트럴파크 벼룩시장(11:00–16:00)과 인현동 체류(15:54–19:57)는 6분만 겹쳐 제외한다.
      if (overlapMs < MIN_EVENT_OVERLAP_MS && overlapMs < eventDurationMs * MIN_EVENT_OVERLAP_RATIO) continue;
      const title = String(event.title || '(제목 없음)').replace(/[\r\n]/g, ' ');
      if (!candidate.eventTitles.includes(title)) candidate.eventTitles.push(title);
    }
    if (!candidate.address && stay.address) candidate.address = stay.address;
  }
  const ready = candidates.filter((candidate) => candidate.status === '관찰' && readyCandidate(candidate, date));
  if (!dryRun) saveCandidates(root, candidates);
  return { candidates, ready };
}
export function candidateVisitCount(candidate, date) { return visitCount(candidate, date); }
