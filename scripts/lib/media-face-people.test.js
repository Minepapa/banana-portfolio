import test from 'node:test';
import assert from 'node:assert/strict';
import { photoPeople, photoPeopleWithGallery, mergeMomentPeople } from './media-face-people.mjs';
import { matchFaces, clusterFamily } from './media-face-gallery.mjs';

test('D100 사진 판정은 경계·콜라주·출생 이전·오너 확인을 따른다', () => {
  const matches = [
    { id: 'a', i: 0, score: 0.50, label: 'mine' },
    { id: 'a', i: 1, score: 0.65, label: 'uncertain', reason: 'same-photo-mine-limit' },
    { id: 'b', i: 0, score: 0.40, label: 'uncertain' },
    { id: 'c', i: 0, score: 0.399, label: 'uncertain' },
    { id: 'd', i: 0, score: 0.99, label: 'other', prebirth: true },
    { id: 'e', i: 0, score: 0.51, label: 'mine' },
  ];
  const photos = photoPeople(matches, { b: { 미네: true }, e: { 미네: false } });
  assert.deepEqual(photos.a.people, ['미네']);
  assert.deepEqual(photos.b.people, ['미네']);
  assert.deepEqual(photos.c.people, []);
  assert.equal(photos.d, undefined);
  assert.deepEqual(photos.e.people, []);
});

test('갤러리 얼굴별 오너 확인이 자동 점수를 이기고 사진별 보류 답이 최종 우선한다', () => {
  const matches = [{ id: 'same', i: 0, score: 0.9, label: 'mine' },
    { id: 'same', i: 1, score: 0.4, label: 'uncertain' },
    { id: 'accepted', i: 0, score: null, label: 'other' },
    { id: 'removed', i: 0, score: 0.8, label: 'mine' }];
  const gallery = { bands: { '0-6m': { confirmed: true,
    members: [{ id: 'accepted', i: 0 }],
    removed: [{ id: 'same', i: 0 }, { id: 'removed', i: 0 }] } },
    people: { 휘영: { confirmed: true, members: [{ id: 'family', i: 0 }] } } };
  const photos = photoPeopleWithGallery(matches, gallery);
  assert.deepEqual(photos.same, { people: [], hold: ['미네'] });
  assert.deepEqual(photos.accepted.people, ['미네']);
  assert.deepEqual(photos.removed, undefined);
  assert.deepEqual(photos.family.people, ['휘영']);
  const confirmed = photoPeopleWithGallery(matches, gallery, { accepted: { 미네: false },
    removed: { 미네: true } });
  assert.deepEqual(confirmed.accepted.people, []);
  assert.deepEqual(confirmed.removed.people, ['미네']);
});

test('가족은 출생 이전에도 판정하고 점수 최고 사람만 얼굴에 붙인다', () => {
  const vectors = { 'photo:0': [1, 0], 'mother:0': [1, 0], 'father:0': [0, 1] };
  const gallery = { bands: {}, people: { 휘영: { members: [{ id: 'mother', i: 0 }] },
    나: { members: [{ id: 'father', i: 0 }] } } };
  const matches = matchFaces([{ id: 'photo', faces: [{ i: 0 }] }],
    [{ id: 'photo', capturedAt: '2015-01-01' }], gallery,
    ({ id, i }) => vectors[`${id}:${i}`]);
  assert.equal(matches[0].person, '휘영');
  assert.equal(matches[0].label, 'mine');
  assert.deepEqual(photoPeople(matches).photo.people, ['휘영']);
});

test('확인 시트에 표시된 가족 얼굴만 점수와 무관하게 확정되고 나머지는 임계값을 따른다', () => {
  const gallery = { bands: {}, people: { 휘영: { confirmed: true,
    members: [{ id: 'shown', i: 0 }] } } };
  const vectors = { 'shown:0': [1, 0], 'unshown:0': [0, 1] };
  const matches = matchFaces([
    { id: 'shown', faces: [{ i: 0 }] }, { id: 'unshown', faces: [{ i: 0 }] },
  ], [{ id: 'shown', capturedAt: '2020-01-01' }, { id: 'unshown', capturedAt: '2020-01-01' }],
  gallery, ({ id, i }) => vectors[`${id}:${i}`]);
  assert.equal(matches[0].label, 'mine');
  assert.equal(matches[0].person, '휘영');
  assert.equal(matches[1].label, 'other');
  assert.equal(photoPeopleWithGallery(matches, gallery).unshown, undefined);
});

test('가족 묶음은 미네 후보와 낮은 검출·작은 얼굴을 제외한다', () => {
  const faces = [{ id: 'a', faces: [{ i: 0, det: 0.9, size: 80, blur: 10 }] },
    { id: 'b', faces: [{ i: 0, det: 0.9, size: 80, blur: 20 }] },
    { id: 'c', faces: [{ i: 0, det: 0.9, size: 80, blur: 30 }] },
    { id: 'small', faces: [{ i: 0, det: 0.9, size: 30, blur: 40 }] }];
  const vectors = { 'b:0': [1, 0], 'c:0': [1, 0] };
  const clusters = clusterFamily(faces, [{ id: 'a', i: 0, score: 0.4 }],
    ({ id, i }) => vectors[`${id}:${i}`]);
  assert.deepEqual(clusters.map((items) => items.map((item) => item.id)), [['b', 'c']]);
});

test('사람·카테고리 수동 값은 보존하고 이전 자동 값만 제거한다', () => {
  const old = { category: ['[[01_Home/201 미네]]', '[[01_Home/500 기술]]'],
    people: ['[[30_Wiki/31_People/미네]]', '[[30_Wiki/31_People/친구]]'],
    autoCategory: ['[[01_Home/201 미네]]'], autoPeople: ['[[30_Wiki/31_People/미네]]'],
    movedFrom: ['옛 경로'], emotions: ['기쁨'] };
  const next = mergeMomentPeople(old, ['photo'], { photo: { people: ['휘영'] } });
  assert.deepEqual(next.category, ['[[01_Home/500 기술]]', '[[01_Home/202 휘영]]']);
  assert.deepEqual(next.people, ['[[30_Wiki/31_People/친구]]', '[[30_Wiki/31_People/휘영]]']);
  assert.deepEqual(next.movedFrom, ['옛 경로']);
  assert.deepEqual(next.emotions, ['기쁨']);
  assert.equal(next.mineFaces, undefined);
  const album = mergeMomentPeople(old, [], {}, { albumMine: true });
  assert.equal(album.category.includes('[[01_Home/201 미네]]'), true);
  assert.equal(album.people.includes('[[30_Wiki/31_People/미네]]'), false);
  assert.equal(album.mineBasis, 'album');
});

test('기존 앨범 201·202와 수동 사람은 얼굴 이름표가 사라져도 남고 새 자동 201만 지운다', () => {
  const mine = '[[01_Home/201 미네]]';
  const family = '[[01_Home/202 휘영]]';
  const familyPerson = '[[30_Wiki/31_People/휘영]]';
  const albumFamily = { category: [family], people: [familyPerson], autoBaseCategory: [family] };
  const withFamily = mergeMomentPeople(albumFamily, ['p'], { p: { people: ['휘영'] } });
  assert.deepEqual(withFamily.autoCategory, []);
  assert.deepEqual(withFamily.autoPeople, []);
  const withoutFamily = mergeMomentPeople(withFamily, ['p'], {});
  assert.deepEqual(withoutFamily.category, [family]);
  assert.deepEqual(withoutFamily.people, [familyPerson]);
  assert.deepEqual(mergeMomentPeople(withoutFamily, ['p'], {}), withoutFamily);
  const travelMine = mergeMomentPeople({ category: [mine], autoBaseCategory: [mine] },
    ['p'], { p: { people: ['미네'] } });
  assert.deepEqual(mergeMomentPeople(travelMine, ['p'], {}).category, [mine]);
  const newMine = mergeMomentPeople({ category: ['[[01_Home/500 기술]]'] },
    ['p'], { p: { people: ['미네'] } });
  assert.deepEqual(newMine.autoCategory, [mine]);
  assert.deepEqual(mergeMomentPeople(newMine, ['p'], {}).category, ['[[01_Home/500 기술]]']);
});
