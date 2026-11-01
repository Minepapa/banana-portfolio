import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHOTO_KINDS, PHOTO_KIND_RULES, loadPhotoFaces, momentForcesUnknown, photoKind, photoKindMetrics } from './mine-photo-kind.mjs';

// 세로 사진 3000×4000 → 사본 긴 변 768이면 배율 0.192. 얼굴 짧은 변 250px → 사본 48px(문턱 그 자리).
const SIZE = { width: 3000, height: 4000 };
const face = (i, x, y, side, extra = {}) => ({ i, bbox: [x, y, x + side, y + side], det: 0.85, blur: 100, ...extra });

test('얼굴 가까이: 미네 얼굴이 크고 다른 얼굴이 없거나 하나(아빠와 셀카 #37 모양)', () => {
  assert.equal(photoKind({ faces: [face(0, 700, 600, 1160)], mineIndex: 0, size: SIZE }).kind, PHOTO_KINDS.close);
  const selfie = photoKind({ faces: [face(0, 800, 900, 970), face(1, 1700, 100, 1350)], mineIndex: 0, size: { width: 3648, height: 2736 } });
  assert.equal(selfie.kind, PHOTO_KINDS.close);
  assert.equal(selfie.metrics.comparableFaces, 2);
});

test('멀리서: 사본 얼굴 짧은 변이 문턱 미만이면(#38: 164px → 사본 32px)', () => {
  const far = photoKind({ faces: [face(0, 2311, 1761, 164)], mineIndex: 0, size: SIZE });
  assert.equal(far.kind, PHOTO_KINDS.far);
  assert.equal(Math.round(far.metrics.copyFacePx), 31);
  assert.match(far.reason, /사본에서 31px/);
});

test('멀리서 경계: 문턱 바로 아래는 멀리서, 문턱이면 얼굴 가까이', () => {
  const side = PHOTO_KIND_RULES.farCopyFacePx / (PHOTO_KIND_RULES.copyLongSide / 4000);
  assert.equal(photoKind({ faces: [face(0, 0, 0, side - 1)], mineIndex: 0, size: SIZE }).kind, PHOTO_KINDS.far);
  assert.equal(photoKind({ faces: [face(0, 0, 0, side)], mineIndex: 0, size: SIZE }).kind, PHOTO_KINDS.close);
  // 가로 사진도 긴 변 기준(4000×3000이어도 같은 배율).
  assert.equal(photoKind({ faces: [face(0, 0, 0, side - 1)], mineIndex: 0, size: { width: 4000, height: 3000 } }).kind, PHOTO_KINDS.far);
});

test('여럿이 함께: 미네 얼굴 절반 이상 크기의 얼굴이 미네 포함 3개 이상(얼굴이 작아도 먼저)', () => {
  const group = [face(0, 0, 0, 400), face(1, 500, 0, 300), face(2, 900, 0, 200)];
  assert.equal(photoKind({ faces: group, mineIndex: 0, size: SIZE }).kind, PHOTO_KINDS.group);
  // 셋째 얼굴이 절반보다 작으면(뒤쪽 낯선 사람) 여럿으로 세지 않는다.
  const background = [face(0, 0, 0, 400), face(1, 500, 0, 300), face(2, 900, 0, 199)];
  assert.equal(photoKind({ faces: background, mineIndex: 0, size: SIZE }).kind, PHOTO_KINDS.close);
  // 단체 사진은 얼굴이 작아도 여럿이 함께.
  const smallGroup = [face(0, 0, 0, 100), face(1, 200, 0, 100), face(2, 400, 0, 100)];
  assert.equal(photoKind({ faces: smallGroup, mineIndex: 0, size: SIZE }).kind, PHOTO_KINDS.group);
});

test('가려짐: 미네 얼굴로 확인된 얼굴이 없거나 얼굴이 하나도 없으면', () => {
  const others = photoKind({ faces: [face(0, 0, 0, 900)], mineIndex: undefined, size: SIZE });
  assert.equal(others.kind, PHOTO_KINDS.hidden);
  assert.match(others.reason, /미네 얼굴로 확인된 것이 없음/);
  assert.match(photoKind({ faces: [], mineIndex: undefined, size: SIZE }).reason, /얼굴을 찾지 못함/);
  // 미네 번호가 색인 얼굴에 없으면(색인이 바뀜) 가려짐.
  assert.equal(photoKind({ faces: [face(0, 0, 0, 900)], mineIndex: 3, size: SIZE }).kind, PHOTO_KINDS.hidden);
  // 미네 얼굴이 없으면 크기를 몰라도 가려짐.
  assert.equal(photoKind({ faces: [face(0, 0, 0, 900)], mineIndex: undefined, size: undefined }).kind, PHOTO_KINDS.hidden);
  // 상자 값이 숫자가 아니면 미네 얼굴로 쓰지 않는다.
  assert.equal(photoKind({ faces: [{ i: 0, bbox: [0, NaN, 10, 10] }], mineIndex: 0, size: SIZE }).kind, PHOTO_KINDS.hidden);
});

test('미네 얼굴은 있는데 사진 크기를 모르면 종류 없음(null) — 모름 강제로 떨어지지 않는다', () => {
  assert.equal(photoKind({ faces: [face(0, 0, 0, 900)], mineIndex: 0, size: undefined }), null);
  assert.equal(momentForcesUnknown([null]), false);
});

test('얼굴 분석 전 사진은 종류를 정하지 않는다(null)', () => {
  assert.equal(photoKind({ analyzed: false, faces: [], size: SIZE }), null);
});

test('검출 점수·흐림은 수치로만 남고 종류를 바꾸지 않는다(마스크 #33 검출 0.848)', () => {
  const masked = photoKind({ faces: [face(0, 724, 646, 1160, { det: 0.53, blur: 4 })], mineIndex: 0, size: SIZE });
  assert.equal(masked.kind, PHOTO_KINDS.close);
  assert.equal(masked.metrics.det, 0.53);
  assert.equal(masked.metrics.blur, 4);
  assert.deepEqual(photoKindMetrics({ faces: [], size: SIZE }), { faceCount: 0, mineFound: false });
});

test('순간의 감정을 코드가 모름으로 두는 것은 대표 사진이 모두 가려짐일 때만', () => {
  const hidden = { kind: PHOTO_KINDS.hidden };
  assert.equal(momentForcesUnknown([hidden, hidden]), true);
  assert.equal(momentForcesUnknown([hidden, { kind: PHOTO_KINDS.far }]), false);
  assert.equal(momentForcesUnknown([hidden, null]), false); // 분석 전 사진이 있으면 모델에 맡긴다.
  assert.equal(momentForcesUnknown([]), false);
});

test('얼굴 색인: 사진마다 얼굴 전부, 얼굴 0개도 분석한 사진으로 남고 덜 쓴 끝 줄·오류 행은 버린다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'photo-kind-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const indexPath = join(dir, 'faces-index.jsonl');
  writeFileSync(indexPath, [{ id: 'a', faces: [face(0, 0, 0, 10)] }, { id: 'b', faces: [] }, { id: 'c', error: 'x' }]
    .map((row) => JSON.stringify(row)).join('\n') + '\n{"id":"torn"');
  const faces = loadPhotoFaces({ indexPath });
  assert.deepEqual([...faces.keys()], ['a', 'b']);
  assert.deepEqual(faces.get('b'), []);
  assert.deepEqual([...loadPhotoFaces({ indexPath, ids: ['b'] }).keys()], ['b']);
  assert.equal(loadPhotoFaces({ indexPath: join(dir, 'missing.jsonl') }).size, 0);
});
