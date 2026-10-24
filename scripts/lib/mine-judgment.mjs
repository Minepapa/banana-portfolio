// 미네 기록 판단의 엔진 선택과 볼트 밖 판단 기록(기억 판단 체계 §15.0·§15.3 1단계 ③).
// 정본은 노트 머리말이다. 이 기록은 노트에 안 들어가는 값(감정별 점수·모델 원답)과
// "어느 기준·프롬프트 판·모델로 판단했나"를 남겨, 같은 판으로는 다시 묻지 않게 한다.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MAX_EMOTIONS, MAX_EVIDENCE_CHARS, MAX_INTENSITY, MIN_INTENSITY, allowedEmotions } from './mine-emotion-criteria.mjs';

export const JUDGMENT_ENGINES = Object.freeze(['claude', 'ollama']);
// 이 판정이면 그 판으로는 끝난 것이다. 그 밖(형식 실패·검증 실패·연기)은 다음 회차에 다시 묻는다.
export const DONE_STATUSES = Object.freeze(['applied', 'same', 'skip']);

export function assertEngine(engine) {
  if (!JUDGMENT_ENGINES.includes(engine)) throw new Error(`판단 엔진은 ${JUDGMENT_ENGINES.join('·')} 중 하나: ${engine}`);
  return engine;
}

// 끊긴 마지막 줄(쓰는 도중 멈춤)은 버린다. 완성된 줄이 깨졌으면 멈춘다 — 손으로 고친 뒤 다시 돌린다.
export function readJudgments(path) {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  const complete = content.slice(0, content.lastIndexOf('\n') + 1);
  return complete.split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`판단 기록 ${index + 1}행 오류: ${path}`); }
  });
}

export function appendJudgment(path, row) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

const sameVersion = (row, current) => ['engine', 'model', 'criteriaRef', 'promptVersion']
  .every((key) => (row[key] ?? null) === (current[key] ?? null));

// 지금 판(엔진·모델·기준·프롬프트)으로 이미 끝난 노트 경로.
export function judgedNotes(rows, current) {
  const done = new Set();
  for (const row of rows) {
    if (typeof row?.rel === 'string' && DONE_STATUSES.includes(row.status) && sameVersion(row, current)) done.add(row.rel);
  }
  return done;
}

// 노트를 옮기면 경로가 바뀐다. 옛 경로는 movedFrom에 남는다(D95) — 옛 경로의 기록도 같은 노트로 본다.
export function noteKeys(rel, fields = {}) {
  const moved = (Array.isArray(fields.movedFrom) ? fields.movedFrom : [fields.movedFrom])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().replace(/^\[\[|\]\]$/g, '').split('|')[0])
    .map((value) => value.endsWith('.md') ? value : `${value}.md`);
  return [rel, ...moved];
}

// 감정 판단 한 건의 답 모양(Ollama 구조화 출력). 어휘·경보 상태는 기록 날짜의 기준을 따른다.
// 검사는 validateEmotionResult가 다시 한다 — 스키마는 모델이 그 모양으로만 답하게 묶는 용도다.
export function emotionProperties(recordDate, criteria) {
  const names = allowedEmotions(recordDate, criteria).map((emotion) => emotion.name);
  const alarmRaised = criteria.pubertyAlarmDate !== null && recordDate >= criteria.pubertyAlarmDate;
  const secondFilm = alarmRaised ? [] : criteria.emotions.filter((emotion) => emotion.part === 2).map((emotion) => emotion.name);
  return {
    emotions: { type: 'array', maxItems: MAX_EMOTIONS, items: { enum: names } },
    primaryEmotion: { enum: [...names, null] },
    emotionIntensity: { type: ['integer', 'null'], minimum: MIN_INTENSITY, maximum: MAX_INTENSITY },
    emotionEvidence: { type: 'string', minLength: 1, maxLength: MAX_EVIDENCE_CHARS },
    secondFilmSignal: { enum: [...secondFilm, null] },
  };
}
export const EMOTION_REQUIRED = Object.freeze(['emotions', 'primaryEmotion', 'emotionIntensity', 'emotionEvidence', 'secondFilmSignal']);

// 감정별 0~1 점수(결정 `미네-감정-분류` §6의 원장 값). 프롬프트가 묻기 시작하면(2단계) 판단 기록에 남긴다.
export function validScores(scores, criteria) {
  if (scores === undefined || scores === null) return null;
  const names = new Set(criteria.emotions.map((emotion) => emotion.name));
  if (typeof scores !== 'object' || Array.isArray(scores) || Object.entries(scores).some(([name, value]) =>
    !names.has(name) || (value !== null && (typeof value !== 'number' || value < 0 || value > 1)))) {
    throw new Error('scores 형식 오류');
  }
  return scores;
}
