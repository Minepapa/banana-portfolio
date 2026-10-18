import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyVideoHoldAnswers, loadVideoHoldAnswers } from './video-hold-answers.mjs';

test('영상 보류 답은 최신 파일이 우선이고 깨진 파일은 건너뛴다', (t) => {
  const sheets = mkdtempSync(join(tmpdir(), 'video-hold-answers-'));
  t.after(() => rmSync(sheets, { recursive: true, force: true }));
  writeFileSync(join(sheets, 'video-hold-review-2025-01.json'), JSON.stringify({ videoAnswers: [
    { id: 'a', person: '미네', timestampSec: 2, confirmedPerson: false },
    { id: 'b', person: '휘영', timestampSec: 3, confirmedPerson: true },
  ] }));
  writeFileSync(join(sheets, 'video-hold-review-2025-02.json'), JSON.stringify({ videoAnswers: [
    { id: 'a', person: '미네', timestampSec: 4, confirmedPerson: true },
  ] }));
  writeFileSync(join(sheets, 'video-hold-review-2025-03.json'), '{broken');
  const warnings = [];
  const answers = loadVideoHoldAnswers(sheets, { warn: (message) => warnings.push(message) });
  assert.equal(answers.size, 2);
  assert.deepEqual(answers.get('a:미네'), { id: 'a', person: '미네', timestampSec: 4, confirmedPerson: true });
  assert.equal(answers.get('b:휘영').confirmedPerson, true);
  assert.match(warnings[0], /2025-03/);
});

test('확인한 보류는 이름표와 대표 프레임에 추가하고 원본은 보존한다', () => {
  const entry = { id: 'a', people: ['엄마'], hold: ['미네', '휘영', '아빠'],
    representatives: { 미네: { timestampSec: 5 }, 휘영: { timestampSec: 3 } },
    framePeople: [{ second: 10, people: ['엄마'] }, { second: 5, people: ['아빠'] }] };
  const original = structuredClone(entry);
  const answers = new Map([
    ['a:미네', { confirmedPerson: true }], ['a:휘영', { confirmedPerson: false }],
  ]);
  const result = applyVideoHoldAnswers(entry, answers);
  assert.deepEqual(result.people, ['엄마', '미네']);
  assert.deepEqual(result.hold, ['아빠']);
  assert.deepEqual(result.ownerConfirmed, { 미네: true, 휘영: false });
  assert.deepEqual(result.framePeople, [
    { second: 5, people: ['아빠', '미네'] }, { second: 10, people: ['엄마'] },
  ]);
  assert.deepEqual(entry, original);
});

test('기존 문턱 통과 이름표는 보류 답이 있어도 유지한다', () => {
  const entry = { id: 'a', people: ['미네'], hold: ['미네', '휘영'],
    representatives: { 휘영: { timestampSec: 2 } } };
  const result = applyVideoHoldAnswers(entry, new Map([
    ['a:미네', { confirmedPerson: false }], ['a:휘영', { confirmedPerson: true }],
  ]));
  assert.deepEqual(result.people, ['미네', '휘영']);
  assert.deepEqual(result.hold, ['미네']);
  assert.deepEqual(result.ownerConfirmed, { 휘영: true });
  assert.deepEqual(result.framePeople, [{ second: 2, people: ['휘영'] }]);
});
