// D100: 이름표는 사진 단위로 판단한다. 얼굴 하나만 0.50 이상이어도 사진은 한 장이다.
import { VAULT_REL, categoryLink } from './vault-paths.mjs';
import { PHOTO_HIGH, PHOTO_HOLD } from './media-face-gallery.mjs';
export { PHOTO_HIGH, PHOTO_HOLD };
export const FACE_PEOPLE = Object.freeze({ mine: '미네', family: ['휘영', '나'] });
// 사람별 사진 이름표 기준. 미네는 D100(0.50 자동·0.40 보류), 휘영·나는 D101(2026-10-15 표본 60개씩:
// 0.40~0.50 구간 20개 모두 본인 → 0.40 자동·0.35 보류).
export const PERSON_THRESHOLDS = Object.freeze({
  미네: Object.freeze({ label: PHOTO_HIGH, hold: PHOTO_HOLD }),
  휘영: Object.freeze({ label: 0.40, hold: 0.35 }),
  나: Object.freeze({ label: 0.40, hold: 0.35 }),
});

export function photoPeople(matches, confirmations = {}) {
  const grouped = new Map();
  for (const match of matches) {
    // 가족은 미네 기준 'other'(0.35 미만 등)여도 사람별 보류 기준 이상이면 본다(D101).
    const familyKept = match?.person && match.score >= (PERSON_THRESHOLDS[match.person]?.hold ?? Infinity);
    if (!match?.id || match.prebirth && !match.person || match.label === 'other' && !familyKept || match.score == null) continue;
    const person = match.person || FACE_PEOPLE.mine;
    if (![FACE_PEOPLE.mine, ...FACE_PEOPLE.family].includes(person)) continue;
    const scores = grouped.get(match.id) ?? new Map();
    scores.set(person, Math.max(scores.get(person) ?? -Infinity, match.score));
    grouped.set(match.id, scores);
  }
  const photos = {};
  for (const [id, scores] of grouped) {
    const people = [...scores].filter(([person, score]) => score >= PERSON_THRESHOLDS[person].label)
      .map(([person]) => person);
    const hold = [...scores].filter(([person, score]) => score >= PERSON_THRESHOLDS[person].hold
      && score < PERSON_THRESHOLDS[person].label).map(([person]) => person);
    photos[id] = { people, ...(hold.length ? { hold } : {}) };
  }
  for (const [id, decisions] of Object.entries(confirmations)) {
    const current = photos[id] ?? { people: [] };
    const people = new Set(current.people);
    const hold = new Set(current.hold ?? []);
    for (const [person, accepted] of Object.entries(decisions)) {
      if (![FACE_PEOPLE.mine, ...FACE_PEOPLE.family].includes(person) || typeof accepted !== 'boolean') {
        throw new Error(`얼굴 확인 값 오류: ${id}/${person}`);
      }
      if (accepted) people.add(person);
      else people.delete(person);
      hold.delete(person);
    }
    photos[id] = { people: [...people], ...(hold.size ? { hold: [...hold] } : {}) };
  }
  return photos;
}

export function photoPeopleWithGallery(matches, gallery, confirmations = {}) {
  const accepted = new Map();
  const rejected = new Set();
  for (const state of Object.values(gallery?.bands ?? {})) {
    if (!state.confirmed) continue;
    for (const member of state.members ?? []) {
      const key = `${member.id}:${member.i}`;
      accepted.set(key, [...new Set([...(accepted.get(key) ?? []), '미네'])]);
    }
    for (const member of state.removed ?? []) rejected.add(`${member.id}:${member.i}`);
  }
  for (const [person, state] of Object.entries(gallery?.people ?? {})) {
    if (!state.confirmed || !FACE_PEOPLE.family.includes(person)) continue;
    for (const member of state.members ?? []) {
      const key = `${member.id}:${member.i}`;
      accepted.set(key, [...new Set([...(accepted.get(key) ?? []), person])]);
    }
  }
  const filtered = matches.filter((face) => !rejected.has(`${face.id}:${face.i}`));
  const photos = photoPeople(filtered);
  for (const [key, persons] of accepted) {
    const [id] = key.split(':');
    const entry = photos[id] ?? { people: [] };
    const hold = (entry.hold ?? []).filter((name) => !persons.includes(name));
    photos[id] = { people: [...new Set([...entry.people, ...persons])], ...(hold.length ? { hold } : {}) };
  }
  // hold 시트의 사진별 오너 답은 갤러리 얼굴별 답보다 나중에 확인한 결정이다.
  for (const [id, decisions] of Object.entries(confirmations)) {
    const entry = photos[id] ?? { people: [] };
    const people = new Set(entry.people);
    const hold = new Set(entry.hold ?? []);
    for (const [person, answer] of Object.entries(decisions)) {
      if (![FACE_PEOPLE.mine, ...FACE_PEOPLE.family].includes(person)) {
        throw new Error(`얼굴 확인 값 오류: ${id}/${person}`);
      }
      if (answer === true) people.add(person);
      else if (answer === false) people.delete(person);
      else throw new Error(`얼굴 확인 값 오류: ${id}/${person}`);
      hold.delete(person);
    }
    photos[id] = { people: [...people], ...(hold.size ? { hold: [...hold] } : {}) };
  }
  return photos;
}

export function momentPeople(mediaIds, photos) {
  const counts = { 미네: 0, 휘영: 0, 나: 0 };
  for (const id of new Set(mediaIds)) {
    for (const person of photos[id]?.people ?? []) if (person in counts) counts[person] += 1;
  }
  return counts;
}

const PERSON_LINKS = Object.freeze({
  미네: `[[${VAULT_REL.people}/미네]]`,
  휘영: `[[${VAULT_REL.people}/휘영]]`,
  나: `[[${VAULT_REL.people}/정영호]]`,
});
const FACE_CATEGORIES = Object.freeze({
  미네: categoryLink('201 미네'), 휘영: categoryLink('202 휘영'),
});

function list(value) { return Array.isArray(value) ? value : value ? [value] : []; }

export function mergeMomentPeople(fields, mediaIds, photos, { albumMine = false } = {}) {
  const counts = momentPeople(mediaIds, photos);
  const automaticPeople = Object.entries(counts).filter(([, count]) => count > 0)
    .map(([person]) => PERSON_LINKS[person]);
  const automaticCategories = Object.entries(FACE_CATEGORIES)
    .filter(([person]) => counts[person] > 0).map(([, link]) => link);
  // 동일 링크가 자동·수동으로 동시에 적힌 경우 YAML 배열은 출처를 표현하지 못한다.
  // 수동 고정이 필요하면 manualPeople/manualCategory에 같은 링크를 명시한다.
  const retainedPeople = list(fields.people).filter((link) => !list(fields.autoPeople).includes(link)
    || list(fields.manualPeople).includes(link));
  const retainedCategories = list(fields.category).filter((link) => !list(fields.autoCategory).includes(link)
    || list(fields.manualCategory).includes(link));
  // 앨범의 201은 얼굴 판정과 무관한 출처이므로 자동 얼굴 출처에서 제거하지 않는다.
  if (albumMine && !retainedCategories.includes(FACE_CATEGORIES.미네)) retainedCategories.push(FACE_CATEGORIES.미네);
  // 이미 노트에 있던 링크는 앨범 설정이나 수동 입력일 수 있다. 새로 넣은 값만 소유한다.
  const addedCategories = automaticCategories.filter((link) => !retainedCategories.includes(link));
  const addedPeople = automaticPeople.filter((link) => !retainedPeople.includes(link));
  const next = { ...fields,
    category: [...new Set([...retainedCategories, ...automaticCategories])],
    autoCategory: addedCategories,
    autoPeople: addedPeople,
  };
  const people = [...new Set([...retainedPeople, ...automaticPeople])];
  if (people.length) next.people = people;
  else delete next.people;
  if (counts.미네) next.mineFaces = counts.미네;
  else delete next.mineFaces;
  if (counts.미네 && albumMine) next.mineBasis = 'both';
  else if (counts.미네) next.mineBasis = 'face';
  else if (albumMine) next.mineBasis = 'album';
  else delete next.mineBasis;
  return next;
}
