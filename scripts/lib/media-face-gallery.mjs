// 얼굴 기준 계산은 입력값만 다룬다. 특징값과 좌표는 gallery 직렬화 경계 밖에 둔다.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const FACE_PARAMS = Object.freeze({ minDetection: 0.7, minSize: 60,
  blurExcludedFraction: 0.1, minSimilarity: 0.45, sheetLimit: 30 });
export const MATCH_HIGH = 0.50;
export const MATCH_LOW = 0.35;
// D100은 얼굴 리포트의 레거시 불확실 구간(0.35)과 별개의 사진 이름표 기준이다.
export const PHOTO_HIGH = 0.50;
export const PHOTO_HOLD = 0.40;
export const FACE_BIRTH = '2016-11-04';
export const FACE_BANDS = Object.freeze(['0-6m', '6-12m', '12-18m', '18-24m',
  ...Array.from({ length: 8 }, (_, index) => `${index + 2}y`)]);

function capturedDate(capturedAt) {
  if (!capturedAt) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(capturedAt) ? capturedAt : (() => {
    const instant = new Date(capturedAt);
    if (!Number.isFinite(instant.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric',
      month: '2-digit', day: '2-digit' }).format(instant);
  })();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month
    || check.getUTCDate() !== day) return null;
  return date;
}

export function capturePeriod(capturedAt, capturedConfidence) {
  const date = capturedDate(capturedAt);
  // estimated는 저장 시각 상한이므로 상한이 출생 전이면 촬영도 출생 전이다.
  if (date && date < FACE_BIRTH) return 'prebirth';
  return ageBand(capturedAt, capturedConfidence) ? 'banded' : 'bandless';
}

export function ageBand(capturedAt, capturedConfidence) {
  if (['estimated', 'review'].includes(capturedConfidence)) return null;
  const date = capturedDate(capturedAt);
  if (!date || date < FACE_BIRTH) return null;
  const [year, month, day] = date.split('-').map(Number);
  const months = (year - 2016) * 12 + month - 11 - (day < 4 ? 1 : 0);
  if (months < 24) return FACE_BANDS[Math.floor(months / 6)];
  const years = Math.floor(months / 12);
  return years <= 9 ? `${years}y` : null;
}

export function mineAlbum(album, albums) {
  if (!album || album === '미네 초음파') return false;
  const category = albums?.[album]?.category;
  return (Array.isArray(category) ? category : [category]).includes('201 미네');
}

export function selectGalleryCandidates(faceRows, mediaRows, albums, params = FACE_PARAMS) {
  const byId = new Map();
  for (const row of mediaRows) {
    if (!row.id || !row.importPath || !mineAlbum(row.album, albums) || row.duplicateOf) continue;
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  const byBand = new Map();
  for (const row of faceRows) {
    if (row.error || !Array.isArray(row.faces)) continue;
    const media = byId.get(row.id);
    const band = media && ageBand(media.capturedAt, media.capturedConfidence);
    if (!band) continue;
    for (const face of row.faces) {
      if (!Number.isInteger(face.i) || face.i < 0 || !Number.isFinite(face.det)
        || face.det < params.minDetection || !Number.isFinite(face.size)
        || face.size < params.minSize || !Number.isFinite(face.blur)) continue;
      const candidates = byBand.get(band) ?? [];
      candidates.push({ id: row.id, i: face.i, blur: face.blur });
      byBand.set(band, candidates);
    }
  }
  for (const [band, candidates] of byBand) {
    candidates.sort((left, right) => left.blur - right.blur || left.id.localeCompare(right.id)
      || left.i - right.i);
    byBand.set(band, candidates.slice(Math.floor(candidates.length * params.blurExcludedFraction)));
  }
  return byBand;
}

// numpy .npy v1-v3, little-endian float32, C-order (detect 단계의 저장 형식).
export function readNpyVectors(path) {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 6).toString('latin1') !== '\x93NUMPY') throw new Error(`npy 서명 오류: ${path}`);
  const major = bytes[6];
  const headerLength = major === 1 ? bytes.readUInt16LE(8) : bytes.readUInt32LE(8);
  const headerStart = major === 1 ? 10 : 12;
  const header = bytes.subarray(headerStart, headerStart + headerLength).toString('latin1');
  const shape = header.match(/'shape':\s*\((\d+),\s*(\d+)\)/);
  if (![1, 2, 3].includes(major) || !shape || Number(shape[2]) !== 512
    || !/'descr':\s*'[<|]f4'/.test(header) || !/\s'fortran_order':\s*False/.test(header)) {
    throw new Error(`npy 형식 오류: ${path}`);
  }
  const count = Number(shape[1]);
  const start = headerStart + headerLength;
  if (bytes.length !== start + count * 512 * 4) throw new Error(`npy 길이 오류: ${path}`);
  return Array.from({ length: count }, (_, index) => {
    const vector = new Float32Array(512);
    for (let dimension = 0; dimension < 512; dimension += 1) {
      vector[dimension] = bytes.readFloatLE(start + (index * 512 + dimension) * 4);
    }
    return vector;
  });
}

function dot(left, right) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return sum;
}

function memberKey(member) { return `${member.id}:${member.i}`; }

export function clusterBand(candidates, vectorFor, minSimilarity = FACE_PARAMS.minSimilarity) {
  if (!candidates.length) return { members: [], clusterSizes: [], distances: new Map() };
  const vectors = candidates.map((member) => vectorFor(member));
  const parent = candidates.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (dot(vectors[left], vectors[right]) >= minSimilarity) {
        parent[find(right)] = find(left);
      }
    }
  }
  const groups = new Map();
  for (let index = 0; index < candidates.length; index += 1) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  }
  const ordered = [...groups.values()].sort((left, right) => right.length - left.length
    || memberKey(candidates[left[0]]).localeCompare(memberKey(candidates[right[0]])));
  const largest = ordered[0];
  const center = new Float32Array(vectors[0].length);
  for (const index of largest) {
    for (let dimension = 0; dimension < center.length; dimension += 1) {
      center[dimension] += vectors[index][dimension];
    }
  }
  const selectedById = new Map();
  for (const index of largest) {
    const member = candidates[index];
    const score = dot(vectors[index], center);
    const previous = selectedById.get(member.id);
    if (!previous || score > previous.score || score === previous.score && member.i < previous.member.i) {
      selectedById.set(member.id, { member: { id: member.id, i: member.i }, score });
    }
  }
  const selected = [...selectedById.values()].sort((left, right) => right.score - left.score
    || memberKey(left.member).localeCompare(memberKey(right.member)));
  return { members: selected.map(({ member }) => member),
    clusterSizes: ordered.slice(0, 5).map((group) => group.length),
    distances: new Map(selected.map(({ member, score }) => [memberKey(member), score])) };
}

export function clusterFamily(faceRows, matches, vectorFor, params = FACE_PARAMS) {
  const mineKeys = new Set(matches.filter((match) => !match.person && !match.prebirth
    && match.score >= 0.40).map(memberKey));
  const candidates = faceRows.flatMap((row) => row.error ? [] : (row.faces ?? [])
    .filter((face) => face.det >= params.minDetection && face.size >= params.minSize
      && Number.isFinite(face.blur) && !mineKeys.has(memberKey({ id: row.id, i: face.i })))
    .map((face) => ({ id: row.id, i: face.i, blur: face.blur })));
  candidates.sort((left, right) => left.blur - right.blur);
  const eligible = candidates.slice(Math.floor(candidates.length * params.blurExcludedFraction));
  const vectors = eligible.map(vectorFor);
  const parent = eligible.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  for (let left = 0; left < eligible.length; left += 1) {
    for (let right = left + 1; right < eligible.length; right += 1) {
      if (cosine(vectors[left], vectors[right]) >= params.minSimilarity) parent[find(right)] = find(left);
    }
  }
  const groups = new Map();
  for (let index = 0; index < eligible.length; index += 1) {
    const root = find(index);
    const members = groups.get(root) ?? [];
    members.push(index);
    groups.set(root, members);
  }
  return [...groups.values()].sort((left, right) => right.length - left.length
    || memberKey(eligible[left[0]]).localeCompare(memberKey(eligible[right[0]]))).slice(0, 12)
    .map((indexes) => {
      const center = new Float32Array(vectors[indexes[0]].length);
      for (const index of indexes) {
        for (let dimension = 0; dimension < center.length; dimension += 1) {
          center[dimension] += vectors[index][dimension];
        }
      }
      return indexes.sort((left, right) => cosine(vectors[right], center) - cosine(vectors[left], center)
        || memberKey(eligible[left]).localeCompare(memberKey(eligible[right])))
        .map((index) => eligible[index]);
    });
}

export function buildGallery(previous, candidatesByBand, vectorFor, now, params = FACE_PARAMS) {
  const bands = {};
  const distances = new Map();
  for (const band of FACE_BANDS) {
    const old = previous?.bands?.[band];
    if (old?.confirmed === true) {
      bands[band] = { members: old.members.map(({ id, i }) => ({ id, i })),
        candidateCount: old.candidateCount, clusterSizes: old.clusterSizes,
        confirmed: true, removed: old.removed.map(({ id, i }) => ({ id, i })),
        ...(old.holdCandidates ? { holdCandidates: old.holdCandidates } : {}) };
      continue;
    }
    const candidates = candidatesByBand.get(band) ?? [];
    if (!candidates.length && !old) continue;
    const removed = (old?.removed ?? []).map(({ id, i }) => ({ id, i }));
    const excluded = new Set(removed.map(memberKey));
    const result = clusterBand(candidates.filter((member) => !excluded.has(memberKey(member))),
      vectorFor, params.minSimilarity);
    bands[band] = { members: result.members, candidateCount: candidates.length,
      clusterSizes: result.clusterSizes, confirmed: false, removed,
      ...(old?.holdCandidates ? { holdCandidates: old.holdCandidates } : {}) };
    distances.set(band, result.distances);
  }
  return { gallery: { schema: 1, person: '미네', birth: FACE_BIRTH, updatedAt: now,
    params: { ...params }, bands, ...(previous?.people ? { people: previous.people } : {}) }, distances };
}

export function selectSheetMembers(members, vectorFor, limit = FACE_PARAMS.sheetLimit) {
  for (const member of members) {
    if (!/^[A-Za-z0-9_-]+$/.test(member.id) || !Number.isInteger(member.i) || member.i < 0) {
      throw new Error(`얼굴 id/번호 오류: ${member.id}/${member.i}`);
    }
  }
  const vectors = members.map(vectorFor);
  if (!vectors.length) return [];
  const center = new Float32Array(vectors[0].length);
  for (const vector of vectors) for (let index = 0; index < center.length; index += 1) center[index] += vector[index];
  const sorted = members.map((member, index) => ({ member, score: dot(vectors[index], center) }))
    .sort((left, right) => right.score - left.score || memberKey(left.member).localeCompare(memberKey(right.member)));
  const count = Math.min(limit, members.length);
  const near = sorted.slice(0, Math.ceil(count / 2));
  const farCount = Math.floor(count / 2);
  const far = farCount ? sorted.slice(-farCount).reverse() : [];
  const mixed = [];
  for (let index = 0; index < near.length; index += 1) {
    mixed.push(near[index].member);
    if (far[index]) mixed.push(far[index].member);
  }
  return mixed;
}

export function confirmBand(gallery, band, mapping, removeNumbers, now) {
  if (!FACE_BANDS.includes(band) || !gallery.bands?.[band]) throw new Error(`나이대 오류: ${band}`);
  const current = gallery.bands[band];
  if ([...current.members, ...(current.removed ?? []), ...(current.holdCandidates ?? []),
    ...(mapping.members ?? []), ...(mapping.sheet ?? [])].some((member) => member.id?.includes('@'))) {
    throw new Error('영상 프레임은 사진 갤러리에서 편집할 수 없습니다');
  }
  if (current.confirmed) throw new Error(`이미 확인된 나이대: ${band}`);
  if (JSON.stringify(mapping.members) !== JSON.stringify(current.members)) {
    throw new Error('시트가 현재 기준 목록과 다릅니다. --sheets를 다시 실행하세요.');
  }
  const currentKeys = new Set(current.members.map(memberKey));
  if (!Array.isArray(mapping.sheet) || mapping.sheet.length > FACE_PARAMS.sheetLimit
    || mapping.sheet.some((member) => !currentKeys.has(memberKey(member)))) {
    throw new Error('시트 번호표가 기준 목록과 다릅니다. --sheets를 다시 실행하세요.');
  }
  const valid = new Map(mapping.sheet.map((member, index) => [index + 1, member]));
  const removed = [...current.removed];
  const removedKeys = new Set(removed.map(memberKey));
  for (const number of removeNumbers) {
    if (!Number.isInteger(number) || !valid.has(number)) throw new Error(`시트 번호 오류: ${number}`);
    const member = valid.get(number);
    if (!removedKeys.has(memberKey(member))) {
      removed.push({ id: member.id, i: member.i });
      removedKeys.add(memberKey(member));
    }
  }
  return { ...gallery, updatedAt: now, bands: { ...gallery.bands,
    [band]: { ...current, members: [...new Map([
      ...current.members.filter((member) => !removedKeys.has(memberKey(member))),
      ...(current.holdCandidates ?? []),
    ].map((member) => [memberKey(member), member])).values()],
      confirmed: true, removed } } };
}

// 확인된 나이대에서 시트에 안 나온 "그다음으로 먼" 얼굴을 고른다(중심과의 유사도 낮은 순).
export function selectTailMembers(members, shown, vectorFor, count = 30) {
  if ([...members, ...shown].some((member) => member.id?.includes('@'))) {
    throw new Error('영상 프레임은 사진 갤러리에서 편집할 수 없습니다');
  }
  const shownKeys = new Set(shown.map(memberKey));
  const vectors = members.map(vectorFor);
  if (!vectors.length) return [];
  const center = new Float32Array(vectors[0].length);
  for (const vector of vectors) for (let index = 0; index < center.length; index += 1) center[index] += vector[index];
  return members.map((member, index) => ({ member, score: dot(vectors[index], center) }))
    .filter(({ member }) => !shownKeys.has(memberKey(member)))
    .sort((left, right) => left.score - right.score || memberKey(left.member).localeCompare(memberKey(right.member)))
    .slice(0, count).map(({ member }) => ({ id: member.id, i: member.i }));
}

// 확인이 끝난 나이대에서 추가 시트로 고른 얼굴만 뺀다(확인 상태는 유지).
export function removeTailMembers(gallery, band, mapping, removeNumbers, now) {
  if (!FACE_BANDS.includes(band) || !gallery.bands?.[band]) throw new Error(`나이대 오류: ${band}`);
  const current = gallery.bands[band];
  if ([...current.members, ...(current.removed ?? []), ...(mapping.members ?? []),
    ...(mapping.sheet ?? [])].some((member) => member.id?.includes('@'))) {
    throw new Error('영상 프레임은 사진 갤러리에서 편집할 수 없습니다');
  }
  if (JSON.stringify(mapping.members) !== JSON.stringify(current.members)) {
    throw new Error('추가 시트가 현재 기준 목록과 다릅니다. --tail-sheets를 다시 실행하세요.');
  }
  const currentKeys = new Set(current.members.map(memberKey));
  if (!Array.isArray(mapping.sheet) || mapping.sheet.some((member) => !currentKeys.has(memberKey(member)))) {
    throw new Error('추가 시트 번호표가 기준 목록과 다릅니다. --tail-sheets를 다시 실행하세요.');
  }
  const valid = new Map(mapping.sheet.map((member, index) => [index + 1, member]));
  const removed = [...(current.removed ?? [])];
  const removedKeys = new Set(removed.map(memberKey));
  for (const number of removeNumbers) {
    if (!Number.isInteger(number) || !valid.has(number)) throw new Error(`시트 번호 오류: ${number}`);
    const member = valid.get(number);
    if (!removedKeys.has(memberKey(member))) {
      removed.push({ id: member.id, i: member.i });
      removedKeys.add(memberKey(member));
    }
  }
  return { ...gallery, updatedAt: now, bands: { ...gallery.bands,
    [band]: { ...current, members: current.members.filter((member) => !removedKeys.has(memberKey(member))), removed } } };
}

export function vectorLoader(embeddingsPath) {
  const cache = new Map();
  return ({ id, i }) => {
    if (!/^[A-Za-z0-9_-]+(?:@\d+)?$/.test(id)) throw new Error(`얼굴 id 오류: ${id}`);
    if (!cache.has(id)) cache.set(id, readNpyVectors(join(embeddingsPath, `${id}.npy`)));
    const vector = cache.get(id)[i];
    if (!vector || vector.some((value) => !Number.isFinite(value))) throw new Error(`특징값 오류: ${id}/${i}`);
    return vector;
  };
}

function cosine(left, right) {
  let product = 0;
  let leftLength = 0;
  let rightLength = 0;
  for (let dimension = 0; dimension < left.length; dimension += 1) {
    product += left[dimension] * right[dimension];
    leftLength += left[dimension] ** 2;
    rightLength += right[dimension] ** 2;
  }
  return leftLength && rightLength ? product / Math.sqrt(leftLength * rightLength) : 0;
}

export function classifyFaceScore(score, high = MATCH_HIGH, low = MATCH_LOW) {
  return score >= high ? 'mine' : score >= low ? 'uncertain' : 'other';
}

export function matchFaces(faceRows, mediaRows, gallery, vectorFor, { videoFrames = false } = {}) {
  const mediaById = new Map(mediaRows.map((row) => [row.id, row]));
  const galleryByBand = gallery?.bands ?? {};
  const allMembers = Object.values(galleryByBand).flatMap((state) => state.members ?? []);
  const results = [];
  for (const row of faceRows) {
    if (row.error || !Array.isArray(row.faces)) continue;
    const media = mediaById.get(row.id);
    const period = capturePeriod(media?.capturedAt, media?.capturedConfidence);
    const band = period === 'banded' ? ageBand(media?.capturedAt, media?.capturedConfidence) : null;
    const bandIndex = FACE_BANDS.indexOf(band);
    const eligible = bandIndex < 0 ? allMembers : FACE_BANDS.slice(Math.max(0, bandIndex - 1),
      bandIndex + 2).flatMap((name) => galleryByBand[name]?.members ?? []);
    const faces = row.faces.map(({ i }) => {
      const vector = vectorFor({ id: row.id, i });
      // 같은 사진의 다른 얼굴도 정답 근거가 될 수 없어 사진 id 전체를 제외한다.
      const scores = eligible.filter((member) => member.id !== row.id)
        .map((member) => cosine(vector, vectorFor(member)))
        .sort((left, right) => right - left).slice(0, 5);
      const score = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
      const familyScores = Object.entries(gallery.people ?? {}).map(([person, state]) => {
        const values = (state.members ?? []).filter((member) => member.id !== row.id)
          .map((member) => cosine(vector, vectorFor(member))).sort((left, right) => right - left).slice(0, 5);
        return { person, score: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null };
      }).filter((item) => item.score !== null);
      const bestFamily = familyScores.sort((left, right) => right.score - left.score)[0];
      const confirmedFamily = Object.entries(gallery.people ?? {}).find(([, state]) => state.confirmed
        && (state.members ?? []).some((member) => member.id === row.id && member.i === i));
      const familyWins = confirmedFamily || bestFamily
        && (period === 'prebirth' || bestFamily.score > (score ?? -Infinity));
      const familyPerson = confirmedFamily?.[0] ?? bestFamily?.person;
      const familyScore = confirmedFamily ? 1 : bestFamily?.score;
      return { id: row.id, i, band, score: familyWins ? familyScore : score,
        ...(familyWins ? { person: familyPerson, mineScore: score } : {}),
        label: familyWins ? classifyFaceScore(familyScore, PHOTO_HIGH, PHOTO_HOLD)
          : period === 'prebirth' || score === null ? 'other' : classifyFaceScore(score),
        ...(period === 'prebirth' ? { prebirth: true, reason: '출생 이전' } : {}),
        ...(period === 'bandless' ? { bandless: true } : {}) };
    });
    const likely = faces.filter((face) => !face.person && face.label === 'mine')
      .sort((left, right) => right.score - left.score || left.i - right.i);
    for (const face of videoFrames ? [] : likely.slice(1)) {
      face.label = 'uncertain';
      face.reason = 'same-photo-mine-limit';
    }
    results.push(...faces.sort((left, right) => left.i - right.i));
  }
  const mineByPhoto = new Map();
  for (const face of results.filter((item) => !item.person && item.label === 'mine')) {
    const previous = mineByPhoto.get(face.id);
    if (!previous || face.score > previous.score || face.score === previous.score && face.i < previous.i) {
      mineByPhoto.set(face.id, face);
    }
  }
  for (const face of videoFrames ? [] : results) {
    if (!face.person && face.label === 'mine' && mineByPhoto.get(face.id) !== face) {
      face.label = 'uncertain';
      face.reason = 'same-photo-mine-limit';
    }
  }
  return results;
}

const GOLD_SAMPLE_SEED = 'media-faces-gold-v1';

function stableRank(member) {
  return createHash('sha256').update(`${GOLD_SAMPLE_SEED}:${member.id}:${member.i}`).digest('hex');
}

export function selectGoldSample(matches, quotas = { mine: 80, uncertain: 60, other: 60 }) {
  const groups = Object.fromEntries(Object.keys(quotas).map((label) => [label, new Map()]));
  const bestById = new Map();
  for (const face of matches) {
    if (face.prebirth) continue;
    const previous = bestById.get(face.id);
    if (face.score !== null && (!previous || face.score > previous.score
      || face.score === previous.score && face.i < previous.i)) bestById.set(face.id, face);
  }
  for (const face of matches) {
    if (face.prebirth) continue;
    const byBand = groups[face.label];
    if (!byBand) continue;
    const band = face.band ?? 'unknown';
    const bucket = byBand.get(band) ?? [];
    bucket.push({ id: face.id, i: face.i, score: face.score, predicted: face.label,
      band: face.band, winner: bestById.get(face.id)?.i === face.i });
    byBand.set(band, bucket);
  }
  const selected = [];
  for (const [label, count] of Object.entries(quotas)) {
    const buckets = [...groups[label].entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([, members]) => members.sort((left, right) => stableRank(left).localeCompare(stableRank(right))));
    // 각 나이대에서 한 명씩 순환해 작은 나이대도 표본에 남긴다.
    while (selected.filter((member) => member.predicted === label).length < count
      && buckets.some((bucket) => bucket.length)) {
      for (const bucket of buckets) {
        if (selected.filter((member) => member.predicted === label).length >= count) break;
        if (bucket.length) selected.push(bucket.shift());
      }
    }
  }
  return selected.map((member, index) => ({ number: index + 1, ...member }));
}

export function goldMetrics(sample, labels, population = sample) {
  if (sample.some((member) => typeof labels[member.number] !== 'boolean')) {
    throw new Error('골드 라벨이 모든 표본에 지정되지 않았습니다');
  }
  const stratum = (member) => `${member.predicted ?? member.label}:${member.band ?? 'unknown'}`;
  const populationCounts = new Map();
  const sampleCounts = new Map();
  for (const member of population.filter((face) => !face.prebirth)) populationCounts.set(stratum(member),
    (populationCounts.get(stratum(member)) ?? 0) + 1);
  for (const member of sample) sampleCounts.set(stratum(member),
    (sampleCounts.get(stratum(member)) ?? 0) + 1);
  const weight = (member) => populationCounts.get(stratum(member)) / sampleCounts.get(stratum(member));
  const countAt = (threshold) => {
    const truePositive = sample.filter((member) => member.winner && member.score !== null
      && member.score >= threshold && labels[member.number])
      .reduce((sum, member) => sum + weight(member), 0);
    const falsePositive = sample.filter((member) => member.winner && member.score !== null
      && member.score >= threshold && !labels[member.number])
      .reduce((sum, member) => sum + weight(member), 0);
    const positives = sample.filter((member) => labels[member.number])
      .reduce((sum, member) => sum + weight(member), 0);
    return { threshold, truePositive, falsePositive,
      precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null,
      recall: positives ? truePositive / positives : null };
  };
  const thresholds = Array.from({ length: 7 }, (_, index) => countAt(Number((0.30 + index * 0.05).toFixed(2))));
  const recommended = thresholds.find((item) => item.precision !== null && item.precision >= 0.98)?.threshold ?? null;
  const byBand = Object.fromEntries([...new Set(sample.map((member) => member.band ?? 'unknown'))]
    .map((band) => [band, sample.filter((member) => (member.band ?? 'unknown') === band)
      .filter((member) => (member.predicted === 'mine') !== labels[member.number]).length]));
  return { atDefault: countAt(0.50), thresholds, recommended, errorsByBand: byBand };
}
