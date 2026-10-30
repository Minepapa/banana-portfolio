import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fixtureCriteria as criteria } from './mine-emotion-criteria.fixture.js';
import { loadEmotionCriteria } from './mine-emotion-criteria.mjs';
import { VAULT_PATHS } from './vault-paths.mjs';
import {
  parseScoreRules, deriveEmotionFields, judgmentPreamble, scoreProperties, anchorBlock, parseAnchorTable, loadEmotionAnchors, bandScore,
} from './mine-judgment-prompt.mjs';

const anchors = [
  { id: 'joy-1', verdict: '기쁨 1', record: '2026-07-15 미네 통화', no: 2, why: '매주 있는 기쁨' },
  { id: 'unk-a', verdict: '모름', record: '사진 c5e3, 2022-11-04 마스크', no: 33, why: '표정이 가려짐' },
  { id: 'unk-b', verdict: '모름', record: '사진 0f7d, 2022-11-04 멀리', no: 38, why: '표정 못 읽음' },
];
const answer = (state, levels = {}, extra = {}) => ({ emotionState: state, nearestAnchor: '없음', emotionEvidence: '근거', secondFilmSignal: null,
  primary: null, levels: { 기쁨: '없음', 슬픔: '없음', 버럭: '없음', 까칠: '없음', 소심: '없음', ...levels }, ...extra });
const derive = (raw) => deriveEmotionFields(raw, { recordDate: '2026-10-15', criteria });

test('parseScoreRules: §6의 문턱과 강도 구간을 읽는다', () => {
  assert.deepEqual(parseScoreRules(criteria), { threshold: 0.25,
    bands: [{ level: 1, min: 0.25, max: 0.45 }, { level: 2, min: 0.45, max: 0.7 }, { level: 3, min: 0.7, max: Infinity }] });
});

test('[막아야 함] parseScoreRules: 숫자가 없거나 구간이 이어지지 않으면 오류(코드에 숫자를 복사해 두지 않는다)', () => {
  assert.throws(() => parseScoreRules({ sections: { 6: '강도 1~3' } }), /문턱·강도 구간/);
  const gap = criteria.sections[6].replace('2 = 0.45 이상', '2 = 0.50 이상');
  assert.throws(() => parseScoreRules({ sections: { 6: gap } }), /문턱·강도 구간/);
});

test('parseScoreRules: 진짜 결정 문서 §6도 읽힌다', { skip: !existsSync(VAULT_PATHS.root) }, () => {
  const rules = parseScoreRules(loadEmotionCriteria());
  assert.equal(rules.bands.length, 3);
  assert.ok(rules.threshold > 0 && rules.threshold < 1);
});

test('loadEmotionAnchors: 진짜 결정 문서 §10 표가 읽힌다', { skip: !existsSync(VAULT_PATHS.root) }, () => {
  const rows = loadEmotionAnchors();
  assert.ok(rows.length >= 30);
  assert.ok(rows.every((row) => Number.isInteger(row.no) && !row.record.includes('20_Records')));
});

test('deriveEmotionFields: 세기 단어를 §6 대표 점수로 바꾸고, 문턱 이상만 센 순서로, 대표 세기가 강도', () => {
  const out = derive(answer('있음', { 슬픔: '짙음', 소심: '옅음', 까칠: '보통' }));
  assert.deepEqual(out.fields.emotions, ['슬픔', '까칠', '소심']);
  assert.deepEqual([out.fields.primaryEmotion, out.fields.emotionIntensity], ['슬픔', 3]);
  assert.deepEqual(out.scores, { 기쁨: 0, 슬픔: 0.85, 버럭: 0, 까칠: 0.57, 소심: 0.35 });
  assert.equal(derive(answer('있음', { 기쁨: '옅음' })).fields.emotionIntensity, 1);
  assert.equal(derive(answer('있음', { 기쁨: '보통' })).fields.emotionIntensity, 2);
});

test('deriveEmotionFields: 같은 세기가 여럿이면 모델이 고른 대표를 앞에, 더 약한 감정을 대표로 고르면 무시', () => {
  const tie = derive(answer('있음', { 슬픔: '보통', 소심: '보통' }, { primary: '소심' }));
  assert.deepEqual([tie.fields.primaryEmotion, tie.fields.emotions], ['소심', ['소심', '슬픔']]);
  assert.equal(derive(answer('있음', { 슬픔: '보통', 소심: '보통' })).fields.primaryEmotion, '슬픔', '대표를 안 고르면 감정 표 순서');
  assert.equal(derive(answer('있음', { 슬픔: '짙음', 소심: '옅음' }, { primary: '소심' })).fields.primaryEmotion, '슬픔');
});

test('deriveEmotionFields: 모두 없음이면 감정 없음, 상태와 세기가 어긋나면 세기를 따르고 표시', () => {
  const none = derive(answer('있음'));
  assert.deepEqual([none.fields.emotions, none.fields.primaryEmotion, none.fields.emotionIntensity, none.emotionState], [[], null, null, '감정 없음']);
  assert.equal(none.stateConflict, true);
  const some = derive(answer('감정 없음', { 까칠: '옅음' }));
  assert.deepEqual([some.emotionState, some.fields.primaryEmotion, some.stateConflict], ['있음', '까칠', true]);
  assert.equal(derive(answer('감정 없음')).stateConflict, undefined);
});

test('deriveEmotionFields: 모름은 세기보다 앞서고, 근거 앞에 "모름: "을 붙인다', () => {
  const out = derive(answer('모름', { 기쁨: '짙음' }, { emotionEvidence: '마스크로 얼굴이 가려짐' }));
  assert.deepEqual([out.fields.emotions, out.fields.primaryEmotion, out.emotionState], [[], null, '모름']);
  assert.equal(out.fields.emotionEvidence, '모름: 마스크로 얼굴이 가려짐');
  assert.equal(derive(answer('모름', {}, { emotionEvidence: '모름: 목소리 없음' })).fields.emotionEvidence, '모름: 목소리 없음');
});

test('[막아야 함] deriveEmotionFields: 세기 빠짐·모르는 단어·모르는 감정·잘못된 상태·대표는 오류', () => {
  assert.throws(() => derive({ ...answer('있음'), levels: { 기쁨: '보통' } }), /levels/);
  assert.throws(() => derive(answer('있음', { 기쁨: 0.5 })), /levels/, '숫자는 받지 않는다');
  assert.throws(() => derive(answer('있음', { 기쁨: '아주 큼' })), /levels/);
  assert.throws(() => derive(answer('있음', { 불안: '보통' })), /levels/, '경보 전에는 2편 감정 칸이 없다');
  assert.throws(() => derive(answer('평온')), /emotionState/);
  assert.throws(() => derive(answer('있음', { 기쁨: '보통' }, { primary: '불안' })), /primary/);
  assert.throws(() => derive(null), /JSON 객체/);
});

test('scoreProperties: 경보 전 허용 감정만 세기 칸, 상태 세 가지', () => {
  const props = scoreProperties('2026-10-15', criteria);
  assert.deepEqual(props.levels.required, ['기쁨', '슬픔', '버럭', '까칠', '소심']);
  assert.deepEqual(props.levels.properties.기쁨.enum, ['없음', '옅음', '보통', '짙음']);
  assert.deepEqual(props.emotionState.enum, ['있음', '감정 없음', '모름']);
});

test('anchorBlock·judgmentPreamble: 같은 날짜 형제 예시까지 빼고, 사진은 사진 칸을 추가', () => {
  assert.equal(anchorBlock(anchors, { excludeNo: 33, excludeDate: '2022-11-04' }), '- joy-1: 기쁨 1=옅음 — 2026-07-15 미네 통화 — 매주 있는 기쁨');
  const text = judgmentPreamble({ criteria, recordDate: '2026-10-15', anchors });
  const photo = judgmentPreamble({ criteria, recordDate: '2026-10-15', anchors, medium: 'photo' });
  assert.match(text, /"없음"\(신호 없음\) · "옅음"/);
  assert.doesNotMatch(text, /titleSuggestion/);
  assert.match(photo, /titleSuggestion/);
  assert.match(photo, /mineFace/);
  assert.match(text, /협상·조르기는 싫다는/);
  assert.doesNotMatch(photo, /협상·조르기는 싫다는|속상해|화자 표시가 없는 한 사람 녹음/, '사진 프롬프트는 대화 다듬기(0.3~0.5)에 안 바뀜');
});

test('parseAnchorTable: 시트 번호 없는 행은 오류', () => {
  const body = '## 10. 기준 예시\n| ID | 판정 | 기록 | 오너 근거 |\n|---|---|---|---|\n| a | 기쁨 1 | 기록 | 이유 |\n';
  assert.throws(() => parseAnchorTable(body), /행 오류/);
});

test('bandScore·기준 예시 단어: 강도마다 §6 구간 대표 점수, 예시 판정은 고를 단어로 보여 준다', () => {
  const rules = parseScoreRules(criteria);
  assert.deepEqual([1, 2, 3].map((level) => bandScore(rules, level)), [0.35, 0.57, 0.85]);
  const block = anchorBlock([...anchors, { id: 'none-a', verdict: '감정 없음', record: '협상', no: 14, why: '일상' },
    { id: 'mix-1', verdict: '슬픔 3 + 소심·까칠', record: '복합', no: 29, why: '복합' }]);
  assert.match(block, /joy-1: 기쁨 1=옅음/);
  assert.match(block, /none-a: 감정 없음\(모든 감정 없음\)/);
  assert.match(block, /mix-1: 슬픔 3=짙음 \+ 소심·까칠/);
  assert.match(block, /unk-a: 모름 —/);
});
