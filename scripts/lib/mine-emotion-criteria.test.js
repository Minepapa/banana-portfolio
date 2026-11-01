import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS, VAULT_REL } from './vault-paths.mjs';
import { allowedEmotions, criteriaRef, emotionCriteriaPrompt, loadEmotionCriteria, parseEmotionCriteria,
  validateEmotionResult } from './mine-emotion-criteria.mjs';

import { fixture, fixtureCriteria as criteria } from './mine-emotion-criteria.fixture.js';

test('§2 표와 경보별 허용 감정 및 프롬프트 섹션', () => {
  const raised = parseEmotionCriteria(fixture.replace('사춘기 경보: 미발령', '사춘기 경보: 2026-10-16'));
  assert.equal(criteria.emotions.length, 9);
  assert.deepEqual(criteria.emotions[0], { name: '기쁨', english: 'Joy', color: '노랑', role: '긍정', part: 1, start: '처음부터' });
  assert.equal(allowedEmotions('2026-10-16', criteria).length, 5);
  assert.equal(allowedEmotions('2026-10-15', raised).length, 5);
  assert.equal(allowedEmotions('2026-10-16', raised).length, 9);
  assert.match(emotionCriteriaPrompt('2026-10-16', criteria), /\| 걱정 \| 소심 \|/);
  assert.doesNotMatch(emotionCriteriaPrompt('2026-10-16', criteria), /미래\./);
  assert.match(emotionCriteriaPrompt('2026-10-16', raised), /미래\./);
  assert.doesNotMatch(emotionCriteriaPrompt('2026-10-16', raised), /\| 걱정 \| 소심 \|/);
});

test('문서 없음과 깨진 표는 명확히 오류', () => {
  assert.throws(() => loadEmotionCriteria({ vaultRoot: '/missing/mine-criteria' }), /읽을 수 없습니다/);
  assert.throws(() => parseEmotionCriteria(fixture.replace('| 당황 | Embarrassment | 분홍 | 부끄러움 | 2 | 사춘기 경보 발령 뒤 |', '| 당황 | 없음 | 2 | 사춘기 경보 발령 뒤 |')), /표 행 오류/);
  assert.throws(() => parseEmotionCriteria(fixture.replace('| 이름 | 영문 | 색 | 세계관 담당 | 편 | 사용 시작 |', '| broken |')), /표 형식/);
  assert.throws(() => parseEmotionCriteria(fixture.replace('사춘기 경보: 미발령', '')), /사춘기 경보/);
  assert.throws(() => parseEmotionCriteria(fixture.replace('사춘기 경보: 미발령', '사춘기 경보: 곧')), /사춘기 경보/);
  assert.throws(() => parseEmotionCriteria(fixture.replace('| 처음부터 |', '| 13살 |')), /사용 시작/);
});

test('표 밖 추억 언급은 허용하되 분류 감정으로는 거부한다', () => {
  const withNostalgia = fixture.replace('설명\n', '추억은 본부 감정이 아니다.\n\n| 추억 | Nostalgia | 없음 | 회상 | 2 | 사춘기 경보 발령 뒤 |\n\n설명\n');
  const parsed = parseEmotionCriteria(withNostalgia);
  assert.equal(parsed.emotions.length, 9);
  assert.throws(() => validateEmotionResult({ emotions: ['추억'], primaryEmotion: '추억', emotionIntensity: 2,
    emotionEvidence: '지나간 일을 떠올림' }, { recordDate: '2026-10-16', criteria: parsed }), /어휘 밖/);
});

test('감정 없음, 경보 상태, 강도, 근거, 최대 개수를 검증', () => {
  const base = { emotions: ['기쁨'], primaryEmotion: '기쁨', emotionIntensity: 2, emotionEvidence: '미네가 웃음' };
  assert.deepEqual(validateEmotionResult(base, { recordDate: '2026-10-16', criteria }).emotions, ['기쁨']);
  assert.equal(validateEmotionResult({ emotions: [], primaryEmotion: null, emotionIntensity: null, emotionEvidence: '미네 목소리 없음' },
    { recordDate: '2026-10-16', criteria }).primaryEmotion, null);
  assert.throws(() => validateEmotionResult({ ...base, emotions: ['불안'], primaryEmotion: '불안' }, { recordDate: '2026-10-16', criteria }), /경보 상태/);
  assert.throws(() => validateEmotionResult({ ...base, emotionIntensity: 4 }, { recordDate: '2026-10-16', criteria }), /emotionIntensity/);
  assert.throws(() => validateEmotionResult({ ...base, emotionEvidence: '' }, { recordDate: '2026-10-16', criteria }), /emotionEvidence/);
  assert.throws(() => validateEmotionResult({ ...base, emotionEvidence: '첫 줄\nimportance: 5' }, { recordDate: '2026-10-16', criteria }), /emotionEvidence/);
  assert.throws(() => validateEmotionResult({ ...base, emotionEvidence: 'x'.repeat(201) }, { recordDate: '2026-10-16', criteria }), /emotionEvidence/);
  assert.throws(() => validateEmotionResult({ ...base, emotions: ['기쁨', '슬픔', '버럭', '까칠'] }, { recordDate: '2026-10-16', criteria }), /최대 3개/);
  assert.equal(validateEmotionResult({ ...base, secondFilmSignal: '불안' }, { recordDate: '2026-10-16', criteria }).secondFilmSignal, '불안');
  assert.throws(() => validateEmotionResult({ ...base, secondFilmSignal: '추억' }, { recordDate: '2026-10-16', criteria }), /secondFilmSignal/);
  const raised = parseEmotionCriteria(fixture.replace('사춘기 경보: 미발령', '사춘기 경보: 2026-10-16'));
  assert.throws(() => validateEmotionResult({ ...base, secondFilmSignal: '불안' }, { recordDate: '2026-10-16', criteria: raised }), /secondFilmSignal/);
  assert.equal(validateEmotionResult({ ...base, secondFilmSignal: null }, { recordDate: '2026-10-16', criteria: raised }).secondFilmSignal, null);
});

test('실제 결정 문서가 있는 Mac이면 로드', { skip: !existsSync(join(VAULT_PATHS.root, VAULT_REL.decisionsCanonical)) }, () => {
  const actual = loadEmotionCriteria();
  assert.ok(actual.emotions.length >= 5);
  assert.equal(allowedEmotions('2026-10-16', actual).length, 5);
  assert.match(emotionCriteriaPrompt('2026-10-16', actual), /경보 전 처리/);
  assert.equal(actual.emotions.length, 9);
  assert.equal(actual.pubertyAlarmDate, null);
  assert.match(actual.sections[6], /최대 3개/);
  assert.match(actual.sections[6], /1\(옅음\)·2\(보통\)·3\(짙음\)/);
});

test('기준 판 이름: recordCriteriaFrom이 있으면 그 날짜, 없으면 appliesFrom·created — 기록 판단 규칙이 같으면 다시 묻지 않게', () => {
  assert.equal(criteriaRef({ appliesFrom: '2026-11-01', recordCriteriaFrom: '2026-10-19' }), '미네-감정-분류@2026-10-19');
  assert.equal(criteriaRef({ appliesFrom: '2026-10-19' }), '미네-감정-분류@2026-10-19');
  assert.equal(criteriaRef({ created: '2026-10-16' }), '미네-감정-분류@2026-10-16');
  assert.throws(() => criteriaRef({ appliesFrom: '2026-11-01', recordCriteriaFrom: '어제' }), /recordCriteriaFrom/);
  assert.throws(() => criteriaRef({ appliesFrom: '2026-11-01', recordCriteriaFrom: '2026-02-30' }), /recordCriteriaFrom/, '없는 날짜');
  assert.throws(() => criteriaRef({ appliesFrom: '2026-11-01', recordCriteriaFrom: '' }), /recordCriteriaFrom/, '빈 값도 멈춘다');
  assert.throws(() => criteriaRef({ appliesFrom: '2026-11-01', recordCriteriaFrom: null }), /recordCriteriaFrom/, 'null도 멈춘다');
  assert.throws(() => criteriaRef({ appliesFrom: '2026-11-01', recordCriteriaFrom: '2026-12-01' }), /appliesFrom/, '시행일보다 늦으면 멈춘다');
});

// recordCriteriaFrom은 통화·녹음 등 기록 하나를 판단하는 규칙이 v3(10-19)와 같을 때만 쓴다.
// 다음 개정에서 기록 판단 규칙(감정 정의·문턱·강도·기준 예시·주체 규칙 등)이 바뀌면 이 칸을 그 개정일로 올리고
// 아래 기대값도 같이 바꾼다 — 안 올리면 새 규칙으로 다시 판단해야 할 기록을 옛 판으로 끝난 것으로 본다.
test('실제 결정 문서: v4(2026-11-01)도 통화·녹음 판단 기록과 같은 판 이름(10-19) — 이미 판단한 기록을 다시 묻지 않는다',
  { skip: !existsSync(join(VAULT_PATHS.root, VAULT_REL.decisionsCanonical)) }, () => {
  assert.equal(loadEmotionCriteria().ref, '미네-감정-분류@2026-10-19');
});
