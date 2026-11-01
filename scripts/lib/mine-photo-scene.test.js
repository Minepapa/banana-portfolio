import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureCriteria } from './mine-emotion-criteria.fixture.js';
import { PHOTO_KINDS } from './mine-photo-kind.mjs';
import { BLOCKED_WINDOW, DAILY_PHOTO_TEXT_CALLS, REDACTED, SCENE_CHOICES, SCENE_TEXT_FIELDS, buildPhotoTextPrompt, buildScenePrompt, effectiveKind, extractScene,
  faceEmotionUnknown, faceUnreadable, inBlockedWindow, photoTextAnchors, photoTextRoom, redactFeelingWords, sceneForClaude, sceneSchema, unknownReason, validateScene } from './mine-photo-scene.mjs';

const scene = (overrides = {}) => ({ mineVisible: '보임', mineFaceView: '정면', mineMask: '안 씀', faceCovered: '안 가려짐',
  mouthCorners: '올라감', mouthShape: '이가 보이게 벌림', eyeShape: '반달처럼 접힘', browShape: '편안함', tears: '없음', gaze: '카메라를 봄', bodyPose: '편안함',
  mineExpression: '입꼬리가 올라가고 이가 보임', mineAction: '두 팔을 들고 서 있음', place: '실외 놀이터', occasion: '미끄럼틀 놀이',
  people: '없음', other: '없음', ...overrides });
const at = (hhmm) => Date.parse(`2026-11-01T${hhmm}:00+09:00`);

test('장면 낱말 답 모양: 감정 칸이 없고 모든 칸이 필수', () => {
  const schema = sceneSchema();
  assert.deepEqual(schema.required, [...Object.keys(SCENE_CHOICES), ...Object.keys(SCENE_TEXT_FIELDS)]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(Object.keys(schema.properties).some((key) => /emotion|primary|intensity|levels|state|score/i.test(key)), false);
  for (const name of ['기쁨', '슬픔', '버럭', '감정']) assert.equal(JSON.stringify(schema).includes(name), false);
});

test('장면 낱말 프롬프트: 미네 얼굴 위치·종류·나이를 글로 주고 마음 낱말을 금한다, 채운 예시는 없다', () => {
  const prompt = buildScenePrompt({ age: 6, kind: PHOTO_KINDS.far, kindReason: '미네 얼굴이 작음(사본에서 31px)', face: '미네 얼굴: 왼쪽 위 (가로 0.10~0.20, 세로 0.10~0.20, 사진 전체 0~1 기준)' });
  assert.match(prompt, /만 6세/);
  assert.match(prompt, /미네 얼굴: 왼쪽 위.*그 자리의 아이가 미네다/);
  assert.match(prompt, /사진 종류\(얼굴 인식으로 정한 값\): 멀리서 — 미네 얼굴이 작음/);
  assert.match(prompt, /마음을 나타내는 낱말은 쓰지 않는다/);
  // 0.2: 얼굴 단서는 고르는 칸(값 목록)으로 묻는다. 글 칸에 채운 예시 구절은 여전히 두지 않는다(0.1 첫 시험에서 그대로 베낌).
  assert.match(prompt, /- mouthCorners: "올라감" \| "평평함" \| "내려감" \| "안 보임"/);
  assert.match(prompt, /얼굴이 정말 보이지 않을 때만 "안 보임"/);
  assert.doesNotMatch(prompt, /입꼬리가 올라가고|눈을 감고 입을/, '글 칸 채운 예시 없음'); 
  assert.match(buildScenePrompt({}), /위치를 모른다/);
});

test('validateScene: 값 검사, 칸 설명·자리표시 베낌과 모르는 칸은 형식 실패', () => {
  assert.deepEqual(validateScene({ ...scene(), place: '  실외 놀이터 ' }).place, '실외 놀이터');
  const bad = [
    { ...scene(), mineMask: '마스크' },
    { ...scene(), mineAction: SCENE_TEXT_FIELDS.mineAction.guide },
    { ...scene(), occasion: '보임 | 안 보임' },
    { ...scene(), other: '' },
    { ...scene(), emotion: '기쁨' },
    { ...scene(), place: 'x'.repeat(61) },
    [scene()],
  ];
  for (const raw of bad) assert.throws(() => validateScene(raw), (error) => error.formatFailure === true);
});

test('감정 낱말 지우기: 감정 표 이름과 마음 낱말은 지우고 웃음·울음 같은 보이는 동작은 남긴다', () => {
  const { text, count } = redactFeelingWords('신나게 뛰어감, 기쁨 가득한 웃음, 눈물을 흘리며 울음', fixtureCriteria);
  assert.equal(count, 2);
  assert.equal(text, `${REDACTED} 뛰어감, ${REDACTED} 가득한 웃음, 눈물을 흘리며 울음`);
  assert.equal(redactFeelingWords('입을 벌리고 웃음', fixtureCriteria).count, 0);
});

test('마스크 정정: 장면 낱말에 미네 마스크가 있으면 가려짐(낮추기만)', () => {
  assert.deepEqual(effectiveKind(PHOTO_KINDS.close, scene({ mineMask: '씀' }), 'r'),
    { kind: PHOTO_KINDS.hidden, kindReason: '장면 낱말: 미네가 마스크를 씀(얼굴 인식 종류 얼굴 가까이 → 가려짐)', corrected: true });
  assert.equal(effectiveKind(null, scene({ mineMask: '씀' })).kind, PHOTO_KINDS.hidden, '얼굴 분석 전 사진도 마스크면 가려짐');
  assert.deepEqual(effectiveKind(PHOTO_KINDS.group, scene({ mineMask: '모름' }), 'r'), { kind: PHOTO_KINDS.group, kindReason: 'r', corrected: false });
  assert.equal(effectiveKind(PHOTO_KINDS.hidden, scene({ mineMask: '씀' })).corrected, false);
  assert.equal(effectiveKind(PHOTO_KINDS.hidden, scene({ mineVisible: '보임', mineFaceView: '정면' })).kind, PHOTO_KINDS.hidden, '장면 낱말로 가려짐을 올리지 않는다');
});

test('모름 강제(0.2): 사진 종류가 아니라 장면 낱말이 미네 얼굴이 안 보인다고 할 때만, 대표 사진 모두 그럴 때', () => {
  const hiddenFace = scene({ mineFaceView: '얼굴 안 보임' });
  assert.equal(faceUnreadable(scene()), false);
  for (const overrides of [{ mineVisible: '안 보임' }, { mineFaceView: '뒷모습' }, { mineFaceView: '얼굴 안 보임' }, { mineMask: '씀' }, { faceCovered: '대부분 가려짐' }]) {
    assert.equal(faceUnreadable(scene(overrides)), true, JSON.stringify(overrides));
  }
  assert.equal(faceUnreadable(scene({ faceCovered: '일부 가려짐', mineFaceView: '옆얼굴' })), false);
  assert.equal(faceUnreadable(undefined), false, '장면 낱말이 없으면 Claude에 맡긴다');
  // 멀리서·가려짐 종류여도 얼굴 단서가 보이면 Claude가 판단한다(오너 검수: 멀리서 27/30 읽힘).
  assert.equal(faceEmotionUnknown([{ kind: PHOTO_KINDS.far, scene: scene() }]), false);
  assert.equal(faceEmotionUnknown([{ kind: PHOTO_KINDS.hidden, scene: scene() }]), false);
  assert.equal(faceEmotionUnknown([{ kind: PHOTO_KINDS.close, scene: hiddenFace }]), true);
  assert.equal(faceEmotionUnknown([{ kind: PHOTO_KINDS.far, scene: hiddenFace }, { kind: PHOTO_KINDS.far, scene: scene() }]), false);
  assert.equal(faceEmotionUnknown([]), false);
  assert.match(unknownReason([{ scene: scene({ mineMask: '씀' }) }, { scene: hiddenFace }]), /2장 모두 장면 낱말에 미네 얼굴이 보이지 않음\(마스크 1장\)/);
});

test('Claude에 넘기는 장면 낱말: 얼굴이 안 보이는 사진은 표정 칸·단서 칸을 빼고, 감정 낱말은 지운다', () => {
  const back = sceneForClaude(scene({ mineFaceView: '뒷모습', mineAction: '신나게 뛰어감' }), PHOTO_KINDS.far, fixtureCriteria);
  assert.equal(back.scene.mineExpression, undefined);
  for (const key of ['mouthCorners', 'mouthShape', 'eyeShape', 'browShape', 'tears', 'gaze']) assert.equal(back.scene[key], undefined, key);
  assert.equal(back.scene.bodyPose, '편안함', '몸 모양은 얼굴이 안 보여도 넘긴다');
  assert.equal(back.scene.mineAction, `${REDACTED} 뛰어감`);
  assert.equal(back.redactions, 1);
  const mixed = sceneForClaude(scene({ mineMask: '씀', mineAction: '활짝 웃으며 달림', other: '눈물 자국' }), PHOTO_KINDS.hidden, fixtureCriteria).scene;
  assert.equal(mixed.mineAction, `활짝 ${REDACTED} 달림`, '얼굴이 안 보이는 사진은 다른 칸의 얼굴 동작도 지운다');
  const far = sceneForClaude(scene({ mineAction: '웃으며 달림' }), PHOTO_KINDS.far, fixtureCriteria).scene;
  assert.deepEqual([far.mineExpression, far.mouthCorners, far.mineAction], ['입꼬리가 올라가고 이가 보임', '올라감', '웃으며 달림'], '0.2: 멀리서여도 얼굴이 보이면 단서를 넘긴다');
  assert.equal(mixed.other, `${REDACTED} 자국`);
  assert.equal(sceneForClaude(scene({ mineAction: '웃으며 달림' }), PHOTO_KINDS.close, fixtureCriteria).scene.mineAction, '웃으며 달림');
  assert.equal(sceneForClaude(scene(), PHOTO_KINDS.close, fixtureCriteria).scene.mineExpression, '입꼬리가 올라가고 이가 보임');
  assert.equal(sceneForClaude(scene(), null, fixtureCriteria).scene.mineExpression, '입꼬리가 올라가고 이가 보임');
});

test('Claude 사진 글 프롬프트에는 사진 바이트·경로·base64·사진 id가 없다, 사진 기준 예시는 장면 낱말로 바꾸거나 뺀다', () => {
  const photoId = 'b553faed17c2e6b4';
  const anchors = [
    { id: 'joy-1', verdict: '기쁨 1', record: '2026-07-15 미네 통화 등굣길', no: 2, why: '매주 있을 수 있는 기쁨' },
    { id: 'photo-joy-2a', verdict: '기쁨 2', record: `사진 ${photoId}, 2023-06-03 눈 감고 터진 웃음`, no: 34, why: '(오너 확인) 큰 웃음' },
    { id: 'unk-b', verdict: '모름', record: '사진 0f7d4a2e5c73b976, 2022-11-04 멀리 작게', no: 38, why: '표정을 읽을 수 없음' },
    { id: 'odd', verdict: '기쁨 1', record: '사진 1111222233334444 날짜 없음', no: 39, why: 'x' },
  ];
  const item = { id: '55dbba58380ee683', rel: '20_Records/24_Media/2024/x.md', date: '2024-10-08', memo: '',
    fields: { occurred: '2024-10-08T11:27:09+09:00', description: '2024-10-08 크루즈 여행 순간', place: '부산항', mediaIds: ['55dbba58380ee683'] } };
  const photos = [{ id: '55dbba58380ee683', path: '/Users/x/Pantheon/Media/copies/55dbba58380ee683-1.jpg', sourcePath: 'Imports/미네 2024/20241008_112709.jpg',
    image: 'aGVsbG8=', kind: PHOTO_KINDS.close, kindReason: '미네 얼굴이 크게 보임(사본에서 85px)', face: '미네 얼굴: 한가운데 (가로 0.40~0.60, 세로 0.40~0.60, 사진 전체 0~1 기준)', scene: scene() }];
  const anchorScenes = { [photoId]: { kind: PHOTO_KINDS.close, scene: scene({ mineExpression: '눈을 감고 입을 크게 벌림' }) } };
  const { prompt, photoAnchorsUsed, photoAnchorsOmitted } = buildPhotoTextPrompt(item, photos, fixtureCriteria,
    { anchors, anchorScenes, recordDate: '2024-10-08', age: 7, ownerEmotions: [], importanceGuide: '1 일상' });
  for (const leak of ['/Users', '.jpg', 'Imports/', 'aGVsbG8=', 'base64', 'data:image', '55dbba58380ee683', photoId, '0f7d4a2e5c73b976', '1111222233334444', 'x.md']) {
    assert.equal(prompt.includes(leak), false, `프롬프트에 ${leak}`);
  }
  assert.deepEqual([photoAnchorsUsed, photoAnchorsOmitted], [['photo-joy-2a'], ['unk-b', 'odd']]);
  assert.match(prompt, /photo-joy-2a: 기쁨 2=보통 — 사진 2023-06-03 장면 낱말\(얼굴 가까이\): .*mineExpression 눈을 감고 입을 크게 벌림/);
  assert.doesNotMatch(prompt, /unk-b/);
  assert.match(prompt, /joy-1: 기쁨 1=옅음/);
  assert.match(prompt, /사진은 보지 않는다/);
  const data = JSON.parse(prompt.match(/<note-data>\n([\s\S]*?)\n<\/note-data>/)[1]);
  assert.deepEqual(Object.keys(data.photos[0]), ['number', 'photoKind', 'kindReason', 'mineFace', 'scene']);
  assert.deepEqual([data.date, data.age, data.place], ['2024-10-08', 7, '부산항']);
});

test('extractScene: 로컬 이미지 모델에 사진 한 장(base64)과 감정 칸 없는 답 모양을 보내고 답을 검사한다', async () => {
  const calls = [];
  const result = await extractScene({ image: 'aGk=', age: 6, kind: PHOTO_KINDS.close, face: '미네 얼굴: 한가운데',
    invoke: async (request) => { calls.push(request); return { json: scene(), usage: { promptTokens: 1 } }; } });
  assert.equal(result.scene.place, '실외 놀이터');
  assert.deepEqual(calls[0].images, ['aGk=']);
  assert.equal(calls[0].model, 'qwen3-vl:8b-instruct');
  assert.deepEqual(calls[0].schema, sceneSchema());
  await assert.rejects(extractScene({ image: 'aGk=', invoke: async () => ({ json: { ...scene(), mineMask: 'x' } }) }), (error) => error.formatFailure);
});

test('회차 시간 가드: KST 06:20 이상 07:30 미만', () => {
  assert.equal(BLOCKED_WINDOW.text, '06:20~07:30');
  assert.equal(inBlockedWindow(at('06:19')), false);
  assert.equal(inBlockedWindow(at('06:20')), true);
  assert.equal(inBlockedWindow(at('07:29')), true);
  assert.equal(inBlockedWindow(at('07:30')), false);
  assert.equal(inBlockedWindow(at('13:00')), false);
});

test('하루 상한: 그 KST 날짜의 Claude 호출만 센다', () => {
  const rows = [{ engine: 'claude', at: '2026-11-01', calls: 2 }, { engine: 'claude', at: '2026-11-01', calls: 1 },
    { engine: 'claude', at: '2026-10-31', calls: 50 }, { engine: 'ollama', at: '2026-11-01', calls: 9 }];
  assert.equal(photoTextRoom(rows, at('01:00')), DAILY_PHOTO_TEXT_CALLS - 3);
  assert.equal(photoTextRoom([{ engine: 'claude', at: '2026-11-01', calls: 140 }], at('01:00')), 0);
});
