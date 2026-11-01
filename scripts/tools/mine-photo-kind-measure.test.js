import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHOTO_KINDS } from '../lib/mine-photo-kind.mjs';
import { measurePhoto, quantiles, renderReport, uprightSizes } from './mine-photo-kind-measure.mjs';

test('분위수: 가까운 순위 값, 빈 목록이면 null', () => {
  assert.deepEqual(quantiles([5, 1, 3], [0, 0.5, 1]), [[0, 1], [0.5, 3], [1, 5]]);
  assert.equal(quantiles([NaN]), null);
});

test('측정 행: 얼굴 색인에 없으면 분석 전, 있으면 종류와 수치', () => {
  assert.equal(measurePhoto({ id: 'a', path: 'p', faces: undefined }).kind, null);
  const row = measurePhoto({ id: 'b', path: 'p', faces: [{ i: 0, bbox: [0, 0, 164, 164], det: 0.9, blur: 50 }], mine: { i: 0 },
    size: { width: 3000, height: 4000 } });
  assert.equal(row.kind, PHOTO_KINDS.far);
  assert.equal(row.analyzed, true);
});

test('세운 크기 읽기: 파이썬 출력 줄을 경로별로, 실패하면 오류', () => {
  const execute = (_python, _args, options) => {
    assert.deepEqual(JSON.parse(options.input), ['/a.jpg', '/b.heic']);
    return { status: 0, stdout: '{"path":"/a.jpg","width":3,"height":4}\n{"path":"/b.heic","error":"bad"}\n' };
  };
  const sizes = uprightSizes(['/a.jpg', '/b.heic'], { execute });
  assert.equal(sizes.get('/a.jpg').width, 3);
  assert.equal(sizes.get('/b.heic').error, 'bad');
  assert.equal(uprightSizes([], { execute: () => { throw new Error('부르면 안 됨'); } }).size, 0);
  assert.throws(() => uprightSizes(['/a.jpg'], { execute: () => ({ status: 1, stderr: 'boom' }) }), /사진 크기 읽기 실패: boom/);
});

test('보고서: 종류 분포·모름 순간 수·기준 예시 표', () => {
  const photo = (kind) => ({ kind, metrics: kind ? { mineFound: kind !== PHOTO_KINDS.hidden, copyFacePx: 100, mineWidthRatio: 0.1,
    comparableFaces: 1, faceCount: 1, det: 0.8, blur: 50 } : null });
  const report = renderReport({ startedAt: '2026-11-01T00:00:00.000Z',
    anchors: [{ no: 38, answer: '모름', kind: PHOTO_KINDS.far, metrics: { faceCount: 1, comparableFaces: 1, mineWidthRatio: 0.055, mineHeightRatio: 0.053, copyFacePx: 32, det: 0.869, blur: 118 }, size: { width: 3000, height: 4000 } }],
    photos: [photo(PHOTO_KINDS.close), photo(PHOTO_KINDS.hidden), photo(null)],
    moments: [{ kinds: [PHOTO_KINDS.hidden], forcesUnknown: true }, { kinds: [PHOTO_KINDS.close, null], forcesUnknown: false }] });
  assert.match(report, /얼굴 가까이 1 · 여럿이 함께 0 · 멀리서 0 · 가려짐 1 · 종류 없음\(얼굴 분석 전·크기 못 읽음\) 1/);
  assert.match(report, /모두 가려짐\): 1개/);
  assert.match(report, /\| 38 \| 모름 \| 멀리서 \| 1 \| 1 \| 0\.055×0\.053 \| 32 \|/);
  assert.match(report, /- 얼굴 가까이\+종류 없음: 1/);
});
