import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureCriteria as criteria } from './mine-emotion-criteria.fixture.js';
import { appendJudgment, assertEngine, callsOn, emotionProperties, judgedNotes, noteKeys, readJudgments, validScores } from './mine-judgment.mjs';

const version = { engine: 'ollama', model: 'exaone', criteriaRef: '미네-감정-분류@2026-10-19', promptVersion: 'athena-fields/0.0' };

test('판단 기록은 0600으로 덧붙이고, 끊긴 마지막 줄만 버리며 깨진 줄은 멈춘다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mine-judgment-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'sub', 'judgments.jsonl');
  assert.deepEqual(readJudgments(path), []);
  appendJudgment(path, { rel: 'a.md', status: 'applied', ...version });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(path, `${readFileSync(path, 'utf8')}{"rel":"b.md","sta`);
  assert.deepEqual(readJudgments(path).map((row) => row.rel), ['a.md']);
  writeFileSync(path, '{"rel":"a.md"}\nnot json\n');
  assert.throws(() => readJudgments(path), /2행 오류/);
});

test('같은 판으로 끝난 노트만 고른다: 판정·엔진·모델·기준·프롬프트가 모두 같아야 한다', () => {
  const rows = [
    { rel: 'applied.md', status: 'applied', ...version },
    { rel: 'same.md', status: 'same', ...version },
    { rel: 'skip.md', status: 'skip', ...version },
    { rel: 'ambiguous.md', status: 'ambiguous', ...version },
    { rel: 'retry.md', status: 'retry', ...version },
    { rel: 'old-prompt.md', status: 'applied', ...version, promptVersion: 'athena-fields/-1' },
    { rel: 'claude.md', status: 'applied', ...version, engine: 'claude', model: 'sonnet' },
    { rel: 'old-criteria.md', status: 'applied', ...version, criteriaRef: '미네-감정-분류@2026-10-18' },
  ];
  assert.deepEqual([...judgedNotes(rows, version)].sort(), ['ambiguous.md', 'applied.md', 'same.md', 'skip.md']);
});

test('옮긴 노트는 movedFrom의 옛 경로로도 찾는다', () => {
  assert.deepEqual(noteKeys('new.md', {}), ['new.md']);
  assert.deepEqual(noteKeys('new.md', { movedFrom: '[[20_Records/old|별칭]]' }), ['new.md', '20_Records/old.md']);
  assert.deepEqual(noteKeys('new.md', { movedFrom: ['a.md', '', null] }), ['new.md', 'a.md']);
});

test('답 모양은 기록 날짜의 어휘를 따르고, 점수는 감정 이름·0~1만 받는다', () => {
  const properties = emotionProperties('2026-10-15', criteria);
  const first = criteria.emotions.filter((emotion) => emotion.part === 1).map((emotion) => emotion.name);
  const second = criteria.emotions.filter((emotion) => emotion.part === 2).map((emotion) => emotion.name);
  assert.deepEqual(properties.emotions.items.enum, first);
  assert.deepEqual(properties.secondFilmSignal.enum, [...second, null]);
  const raised = { ...criteria, pubertyAlarmDate: '2026-01-01' };
  assert.deepEqual(emotionProperties('2026-10-15', raised).secondFilmSignal.enum, [null]);
  assert.equal(emotionProperties('2026-10-15', raised).emotions.items.enum.length, criteria.emotions.length);
  assert.equal(validScores(undefined, criteria), null);
  assert.deepEqual(validScores({ [first[0]]: 0.5, [second[0]]: null }, criteria), { [first[0]]: 0.5, [second[0]]: null });
  assert.throws(() => validScores({ 행복: 0.5 }, criteria), /scores/);
  assert.throws(() => validScores({ [first[0]]: 1.5 }, criteria), /scores/);
  assert.throws(() => validScores([0.5], criteria), /scores/);
  assert.equal(assertEngine('ollama'), 'ollama');
  assert.throws(() => assertEngine('gpt'), /판단 엔진/);
});

test('callsOn: 그 날 그 엔진으로 실제로 부른 횟수만 센다', () => {
  const rows = [{ engine: 'claude', at: '2026-10-31', calls: 2 }, { engine: 'claude', at: '2026-10-31', calls: 1 },
    { engine: 'claude', at: '2026-10-31' }, { engine: 'claude', at: '2026-10-30', calls: 2 }, { engine: 'ollama', at: '2026-10-31', calls: 1 }];
  assert.equal(callsOn(rows, { engine: 'claude', date: '2026-10-31' }), 3);
  assert.equal(callsOn([], { engine: 'claude', date: '2026-10-31' }), 0);
});
