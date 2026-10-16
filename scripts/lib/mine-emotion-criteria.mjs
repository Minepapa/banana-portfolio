import { resolveDecision } from './decision-resolver.mjs';

export const MAX_EMOTIONS = 3;
export const MIN_INTENSITY = 1;
export const MAX_INTENSITY = 3;

function section(body, number) {
  const match = body.match(new RegExp(`^## ${number}\\. [^\\n]+\\n([\\s\\S]*?)(?=^## \\d+\\. |^## 변경 이력|$(?![\\s\\S]))`, 'm'));
  if (!match) throw new Error(`미네 감정 분류 결정 문서 §${number}을 찾을 수 없습니다`);
  return match[0].trim();
}

export function parseEmotionCriteria(body) {
  if (typeof body !== 'string' || !body.trim()) throw new Error('미네 감정 분류 결정 문서 본문이 비어 있습니다');
  const lines = section(body, 2).split(/\r?\n/);
  const header = lines.findIndex((line) => line === '| 이름 | 영문 | 색 | 세계관 담당 | 편 | 사용 시작 |');
  if (header < 0 || !/^\|[-| ]+\|$/.test(lines[header + 1] ?? '')) {
    throw new Error('미네 감정 분류 결정 문서 §2 감정 표 형식이 잘못되었습니다');
  }
  const tableRows = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.trim()) break;
    tableRows.push(line);
  }
  const emotions = tableRows.map((line) => {
    if (!line.startsWith('|') || !line.endsWith('|')) throw new Error(`미네 감정 분류 결정 문서 §2 감정 표 행 오류: ${line}`);
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 6 || cells.some((cell) => !cell) || !/^[12]$/.test(cells[4])) {
      throw new Error(`미네 감정 분류 결정 문서 §2 감정 표 행 오류: ${line}`);
    }
    if (!['처음부터', '사춘기 경보 발령 뒤'].includes(cells[5])) {
      throw new Error(`미네 감정 분류 결정 문서 §2 사용 시작 값 오류: ${cells[5]}`);
    }
    if ((cells[4] === '1') !== (cells[5] === '처음부터')) {
      throw new Error(`미네 감정 분류 결정 문서 §2 편과 사용 시작 불일치: ${line}`);
    }
    return { name: cells[0], english: cells[1], color: cells[2], role: cells[3], part: Number(cells[4]), start: cells[5] };
  });
  if (!emotions.length || new Set(emotions.map((emotion) => emotion.name)).size !== emotions.length) {
    throw new Error('미네 감정 분류 결정 문서 §2 감정 표가 비었거나 이름이 중복됩니다');
  }
  const alarms = lines.filter((line) => line.startsWith('사춘기 경보:'));
  if (alarms.length !== 1 || !/^사춘기 경보: (미발령|\d{4}-\d{2}-\d{2})$/.test(alarms[0])) {
    throw new Error('미네 감정 분류 결정 문서 §2 사춘기 경보 줄 형식 오류');
  }
  const alarmValue = alarms[0].slice('사춘기 경보: '.length);
  if (alarmValue !== '미발령') validateRecordDate(alarmValue);
  const sections = Object.fromEntries([3, 4, 5, 6, 7].map((number) => [number, section(body, number)]));
  return { emotions, pubertyAlarmDate: alarmValue === '미발령' ? null : alarmValue, sections };
}

function validateRecordDate(recordDate) {
  const timestamp = Date.parse(`${recordDate}T00:00:00Z`);
  if (typeof recordDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(recordDate) ||
    !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== recordDate) {
    throw new Error(`미네 기록 날짜 오류: ${recordDate}`);
  }
}

export function loadEmotionCriteria(options = {}) {
  try {
    return parseEmotionCriteria(resolveDecision('미네-감정-분류', options).body);
  } catch (error) {
    throw new Error(`미네 감정 분류 기준을 읽을 수 없습니다: ${error.message}`, { cause: error });
  }
}

export function allowedEmotions(recordDate, criteria = loadEmotionCriteria()) {
  validateRecordDate(recordDate);
  return criteria.emotions.filter((emotion) => emotion.part === 1 ||
    (criteria.pubertyAlarmDate !== null && recordDate >= criteria.pubertyAlarmDate));
}

export function emotionCriteriaPrompt(recordDate, criteria = loadEmotionCriteria()) {
  const names = allowedEmotions(recordDate, criteria).map((emotion) => emotion.name);
  let definitions = criteria.sections[3];
  const later = definitions.match(/^### 사춘기 경보 뒤에만:[\s\S]*?(?=^### 사춘기 경보 전,|$(?![\s\S]))/m);
  const before = definitions.match(/^### 사춘기 경보 전,[\s\S]*$/m);
  if (!later || !before) throw new Error('미네 감정 분류 결정 문서 §3 경보 전후 판단 기준이 없습니다');
  if (criteria.pubertyAlarmDate === null || recordDate < criteria.pubertyAlarmDate) {
    definitions = definitions.replace(later[0], '');
  } else {
    definitions = definitions.replace(before[0], '');
  }
  return [`허용 감정: ${names.join('·')}`, definitions.trim(), ...[4, 5, 6, 7].map((number) => criteria.sections[number])].join('\n\n');
}

export function validateEmotionResult(result, { recordDate, ownerEmotions = [], criteria = loadEmotionCriteria() } = {}) {
  const allowed = new Set(allowedEmotions(recordDate, criteria).map((emotion) => emotion.name));
  const alarmRaised = criteria.pubertyAlarmDate !== null && recordDate >= criteria.pubertyAlarmDate;
  if (!Array.isArray(ownerEmotions) || ownerEmotions.length > MAX_EMOTIONS ||
    new Set(ownerEmotions).size !== ownerEmotions.length) {
    throw new Error(`오너 메모 감정은 중복 없이 최대 ${MAX_EMOTIONS}개여야 합니다`);
  }
  const emotions = result?.emotions;
  if (!Array.isArray(emotions) || emotions.length > MAX_EMOTIONS || new Set(emotions).size !== emotions.length) {
    throw new Error(`emotions는 중복 없이 최대 ${MAX_EMOTIONS}개여야 합니다`);
  }
  if (emotions.some((emotion) => !allowed.has(emotion))) throw new Error(`경보 상태 또는 어휘 밖 감정: ${emotions.filter((emotion) => !allowed.has(emotion)).join('·')}`);
  if (emotions.length ? !emotions.includes(result.primaryEmotion) : result.primaryEmotion != null && result.primaryEmotion !== '') {
    throw new Error('primaryEmotion은 emotions에 포함되어야 하며 감정 없음이면 비워야 합니다');
  }
  if (emotions.length ? !Number.isInteger(result.emotionIntensity) || result.emotionIntensity < MIN_INTENSITY || result.emotionIntensity > MAX_INTENSITY
    : result.emotionIntensity != null) throw new Error('emotionIntensity는 감정이 있으면 1~3, 없으면 비워야 합니다');
  if (typeof result.emotionEvidence !== 'string' || !result.emotionEvidence.trim()) throw new Error('emotionEvidence가 필요합니다');
  if (ownerEmotions.some((emotion) => !allowed.has(emotion))) {
    throw new Error('오너 메모에 경보 상태 또는 어휘 밖 감정이 있습니다');
  }
  const secondFilmNames = new Set(criteria.emotions.filter((emotion) => emotion.part === 2).map((emotion) => emotion.name));
  if (result.secondFilmSignal != null && result.secondFilmSignal !== '' &&
    (!secondFilmNames.has(result.secondFilmSignal) || alarmRaised)) {
    throw new Error('secondFilmSignal은 경보 전 2편 감정 하나 또는 비움이어야 합니다');
  }
  return { emotions, primaryEmotion: result.primaryEmotion || null,
    emotionIntensity: result.emotionIntensity ?? null, emotionEvidence: result.emotionEvidence.trim(),
    secondFilmSignal: result.secondFilmSignal || null };
}
