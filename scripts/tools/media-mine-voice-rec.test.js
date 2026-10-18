import test from 'node:test';
import assert from 'node:assert/strict';
import { buildYearlyReference, OTHER_PERSON_FLOOR } from './media-mine-voice-rec.mjs';

test('연도별 미네 녹음 기준: 다른 인물과 닮은 녹음은 빼고 연도별 평균·응집을 만든다', () => {
  const samples = [
    { id: 'a', year: 2018, occurred: '2018-01-01', kind: '노래', vector: [1, 0] },
    { id: 'b', year: 2018, occurred: '2018-02-01', kind: '혼잣말', vector: [0.9, 0.1] },
    { id: 'c', year: 2021, occurred: '2021-01-01', kind: '동화', vector: [0.8, 0.2] },
    { id: 'd', year: 2021, occurred: '2021-02-01', kind: '기도', vector: [0, 1] },
  ];
  const built = buildYearlyReference(samples, { 휘영: [0, 1] });
  assert.equal(built.excluded.length, 1);
  assert.equal(built.excluded[0].id, 'd');
  assert.match(built.excluded[0].reason, /휘영/);
  assert.deepEqual(built.years.map((y) => [y.year, y.count]), [[2018, 2], [2021, 1]]);
  assert.ok(built.years[0].cohesion > 0.9);
  assert.ok(OTHER_PERSON_FLOOR >= 0.45);
});
