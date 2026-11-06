import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { fixtureCriteria } from '../lib/mine-emotion-criteria.fixture.js';
import { MAX_JOB_MS, NIGHTLY_LIMIT, ORB_FIELDS, PROMPT_VERSIONS, applyOrbFields, attemptState, ollamaPhotoDecision, orbSchema, validateOllamaOrb, readRuns,
  requireRegistryFields, run, upsertOrbIndex, memoryOrbCounts, SCENE_ENGINE, SCENES_FILE, JOB_SCENE_VERSION, judgeSceneMoment } from './media-memory-orb.mjs';
import { PHOTO_TEXT_JUDGMENTS_FILE, PHOTO_TEXT_PROMPT_VERSION } from '../lib/mine-photo-scene.mjs';
import { OLLAMA_MODELS } from '../lib/ollama-client.mjs';
import { llmRunFailed } from '../lib/llm-run-outcome.mjs';

test('예약 상한은 직전 24시간, 두 번 실패한 후보는 14일 동안 보류한다', () => {
  const now = Date.parse('2026-10-17T02:20:00+09:00');
  const rows = [
    { id: 'old', status: 'reserved', at: new Date(now - 25 * 3_600_000).toISOString() },
    { id: 'recent', status: 'reserved', at: new Date(now - 23 * 3_600_000).toISOString() },
    { id: 'bad', status: 'error', at: new Date(now - 3 * 86_400_000).toISOString() },
    { id: 'bad', status: 'error', at: new Date(now - 2 * 86_400_000).toISOString() },
    { id: 'bad', status: 'deferred', at: new Date(now - 86_400_000).toISOString() },
  ];
  const state = attemptState(rows, now);
  assert.equal(state.count, 1);
  assert.deepEqual([...state.reserved], ['recent']);
  assert.equal(state.failed.get('bad'), 2);
  assert.equal(attemptState(rows, now + 15 * 86_400_000).failed.has('bad'), false);
});

test('한도와 시간 상한은 연기로 기록하고 실패 2회에 세지 않는다', async (t) => {
  for (const cause of ['limit', 'timeout']) {
    const fixture = setup(t);
    const failure = new Error(cause === 'limit' ? '사용량 한도' : '잡 시간 상한');
    if (cause === 'limit') failure.isLimit = true;
    const summary = await run(options(fixture, cause === 'limit'
      ? { judge: () => { throw failure; } }
      : { copyPhoto: () => { throw failure; }, judge: () => { throw new Error('호출하면 안 됨'); } }));
    assert.equal(summary.failed.length, 0);
    assert.equal(summary.deferred.length, 1);
    assert.equal(summary.cooldown, cause === 'limit');
    assert.equal(summary.timedOut, cause === 'timeout');
    const rows = readRuns(join(fixture.out, 'runs.jsonl'));
    assert.equal(rows.at(-1).status, 'deferred');
    assert.equal(attemptState(rows, Date.now()).failed.has(fixture.candidates[0].id), false);
  }
});

test('다음 후보를 시작하기 전 시간 상한에 도달해도 연기로 기록한다', async (t) => {
  const fixture = setup(t);
  const started = Date.parse('2026-10-17T00:00:00Z');
  let reads = 0;
  const summary = await run(options(fixture, {
    now: () => ++reads < 3 ? started : started + MAX_JOB_MS,
    judge: () => { throw new Error('호출하면 안 됨'); },
  }));
  assert.equal(summary.failed.length, 0);
  assert.equal(summary.deferred.length, 1);
  assert.equal(summary.timedOut, true);
  assert.equal(readRuns(join(fixture.out, 'runs.jsonl')).at(-1).status, 'deferred');
});

test('runs.jsonl은 끊긴 마지막 행만 버리고 완성된 오류는 닫힌 채로 실패한다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orb-runs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'runs.jsonl');
  writeFileSync(path, '{"status":"reserved","id":"a","at":"2026-10-17T00:00:00Z"}\n{"sta');
  assert.equal(readRuns(path).length, 1);
  assert.ok(readFileSync(path, 'utf8').endsWith('}\n'));
  writeFileSync(path, '{"status":"reserved","id":"a","at":"2026-10-17T00:00:00Z"}');
  assert.equal(readRuns(path).length, 1);
  assert.ok(readFileSync(path, 'utf8').endsWith('}\n'));
  writeFileSync(path, '{bad}\n');
  assert.throws(() => readRuns(path), SyntaxError);
  assert.throws(() => attemptState([{ status: 'reserve', id: 'a', at: '2026-10-17T00:00:00Z' }], Date.parse('2026-10-17T01:00:00Z')), /복구 필요/);
});

test('null mineAge는 계산한 만 나이로 채우고 머리말 왕복 오류는 쓰기 전에 막는다', (t) => {
  const fixture = setup(t);
  const original = fixture.candidates[0].content.replace('\n---\n', '\nmineAge: null\n---\n');
  const next = applyOrbFields(original, answer, []);
  assert.equal(parseFrontmatter(next).mineAge, 3);
  assert.throws(() => applyOrbFields(original, { ...answer, emotionEvidence: '줄바꿈\nimportance: 5' }, []), /머리말 왕복/);
});

const answer = { emotions: ['기쁨'], primaryEmotion: '기쁨', emotionIntensity: 2,
  emotionEvidence: '사진에서 미네가 웃는다', secondFilmSignal: null, confidence: '보통',
  importance: 3, scene: '미네가 케이크를 본다.', titleSuggestion: '생일 케이크',
  coreMemoryCandidate: { value: true, reason: '첫 생일' } };
// Ollama 0.2 답(감정별 세기 단어·상태). 사진 칸은 0.0과 같다.
const ollamaAnswer = (levels = { 기쁨: '보통' }, state = '있음') => ({ emotionState: state, nearestAnchor: 'photo-joy-2a', primary: null,
  levels: { 기쁨: '없음', 슬픔: '없음', 버럭: '없음', 까칠: '없음', 소심: '없음', ...levels }, emotionEvidence: '사진에서 미네가 웃는다', secondFilmSignal: null,
  confidence: '보통', importance: 3, scene: '미네가 케이크를 본다.', titleSuggestion: '생일 케이크', coreMemoryCandidate: { value: true, reason: '첫 생일' } });
const anchors = [{ id: 'photo-joy-2a', verdict: '기쁨 2', record: '사진 b553, 2023-06-03 웃음', no: 34, why: '큰 웃음' }];
const envelope = (value) => JSON.stringify({ result: JSON.stringify(value),
  usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 0.01 });

function setup(t, count = 1) {
  const root = mkdtempSync(join(tmpdir(), 'orb-job-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mediaRoot = join(root, 'media');
  mkdirSync(mediaRoot);
  writeFileSync(join(mediaRoot, 'photo.jpg'), 'fixture');
  const candidates = Array.from({ length: count }, (_, index) => {
    const id = String(index).padStart(16, '0');
    const rel = `20_Records/24_Media/2020/2020-01-01 순간${id}.md`;
    const path = join(root, rel);
    mkdirSync(join(root, '20_Records/24_Media/2020'), { recursive: true });
    const content = `${buildFrontmatter({ type: 'media', description: `2020-01-01 순간${id}`,
      occurred: '2020-01-01', category: '[[01_Home/201 미네]]' })}\n## 오너 메모\n감정: 슬픔\n`;
    writeFileSync(path, content);
    return { id, rel, content, date: '2020-01-01', title: `순간${id}`,
      fields: parseFrontmatter(content), memo: '감정: 슬픔', photos: [{ id, path: 'photo.jpg', confirmedMine: true }] };
  });
  return { root, mediaRoot, out: join(root, 'out'), candidates };
}

function options(fixture, overrides = {}) {
  return { ...fixture, registryText: `| \`media\` | \`20_Records/24_Media/{YYYY}/\` | title | fields | owner |\n\n\`201 미네\`가 붙은 conversation·media에는 ${ORB_FIELDS.map((key) => `\`${key}\``).join(' · ')}가 선택 머리말이다.\n`, criteria: fixtureCriteria,
    rules: [{ type: 'media', pathRegex: /^20_Records\/24_Media\/2020\//,
      titleRegex: null, required: { bundle: [], extra: [] } }],
    charter: { model: 'sonnet', systemPrompt: '' }, photoScores: new Map(), visionRows: new Map(),
    copyPhoto: () => {}, gridPhoto: () => {}, output: { log() {}, error() {} }, mineFaces: new Map(), photoFaces: new Map(), anchors,
    ...overrides };
}

test('dry-run과 쿨다운은 Claude 호출·파일 쓰기가 없다', async (t) => {
  const fixture = setup(t);
  let calls = 0;
  const judge = () => { calls += 1; return envelope(answer); };
  await run(options(fixture, { dryRun: true, judge }));
  await run(options(fixture, { cooldown: () => true, judge }));
  assert.equal(calls, 0);
  assert.equal(readFileSync(join(fixture.root, fixture.candidates[0].rel), 'utf8'), fixture.candidates[0].content);
  assert.throws(() => statSync(fixture.out), { code: 'ENOENT' });
});

test('등록부에 필드가 없으면 호출 전에 중단한다', async (t) => {
  const fixture = setup(t);
  let calls = 0;
  await assert.rejects(run(options(fixture, { registryText: '', judge: () => { calls += 1; } })), /등록 필요/);
  assert.equal(calls, 0);
  assert.throws(() => requireRegistryFields(`## 다른 절\n${ORB_FIELDS.join(' ')}\n`), /등록 필요/);
  assert.throws(() => requireRegistryFields(`| \`media\` | row |\n\n\`201 미네\`가 붙은 conversation·media에는 감정 필드.\n\n## 변경 이력\n${ORB_FIELDS.join(' ')}\n`), /등록 필요/);
  assert.throws(() => requireRegistryFields(`| \`media\` | row |\n\n\`201 미네\`가 붙은 conversation·media에는 ${ORB_FIELDS.join(' · ')}를 아직 등록하지 않았다.\n`), /등록 필요/);
  await assert.rejects(run(options(fixture, { dryRun: true, registryText: '' })), /등록 필요/);
  assert.throws(() => statSync(fixture.out), { code: 'ENOENT' });
});

test('실제 등록부는 노트 기록 필드 검사를 통과한다', () => {
  const registry = readFileSync(join(VAULT_PATHS.root, VAULT_REL.registryFile), 'utf8');
  assert.doesNotThrow(() => requireRegistryFields(registry));
});

test('노트 쓰기가 실패하면 새 색인 행을 지우고 다음날 다시 시도한다', async (t) => {
  const fixture = setup(t);
  const first = await run(options(fixture, {
    now: () => Date.parse('2026-10-17T03:40:00+09:00'), judge: () => envelope(answer),
    write: () => { throw new Error('note write failed'); },
  }));
  assert.equal(first.failed.length, 1);
  assert.equal(readFileSync(join(fixture.root, fixture.candidates[0].rel), 'utf8'), fixture.candidates[0].content);
  assert.throws(() => statSync(join(fixture.out, 'orbs.jsonl')), { code: 'ENOENT' });
  const second = await run(options(fixture, {
    now: () => Date.parse('2026-10-18T03:40:00+09:00'), judge: () => envelope(answer),
    write: writeAtomic,
  }));
  assert.equal(second.written, 1);
  assert.equal(readFileSync(join(fixture.out, 'orbs.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal(parseFrontmatter(readFileSync(join(fixture.root, fixture.candidates[0].rel), 'utf8')).coreMemoryCandidate, true);
});

test('노트 쓰기 실패 시 기존 색인을 원래 내용과 0600 권한으로 복원한다', async (t) => {
  const fixture = setup(t);
  mkdirSync(fixture.out);
  const path = join(fixture.out, 'orbs.jsonl');
  const original = '{"id":"0000000000000000","orbScene":"previous"}\n{"id":"other","orbScene":"keep"}\n';
  writeFileSync(path, original);
  chmodSync(path, 0o644);
  const summary = await run(options(fixture, {
    judge: () => envelope(answer), write: () => { throw new Error('note write failed'); },
  }));
  assert.equal(summary.failed.length, 1);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('dry-run은 사진과 프롬프트 사전 검사를 수행하고 쓰거나 호출하지 않는다', async (t) => {
  const fixture = setup(t);
  let calls = 0;
  const judge = () => { calls += 1; return envelope(answer); };
  const invalidCriteria = { ...fixtureCriteria, sections: {} };
  const invalid = await run(options(fixture, { dryRun: true, judge, criteria: invalidCriteria }));
  assert.equal(invalid.failed.length, 1);
  assert.match(invalid.failed[0].reason, /undefined|match/);
  rmSync(join(fixture.mediaRoot, 'photo.jpg'));
  const missingPhoto = await run(options(fixture, { dryRun: true, judge }));
  assert.equal(missingPhoto.failed.length, 1);
  assert.match(missingPhoto.failed[0].reason, /대표 사진 원본 없음/);
  assert.equal(calls, 0);
  assert.throws(() => statSync(fixture.out), { code: 'ENOENT' });
});

test('구슬 색인은 순간 id별 최신 한 행이며 기존 공개 권한도 0600으로 고친다', (t) => {
  const fixture = setup(t);
  mkdirSync(fixture.out);
  const path = join(fixture.out, 'orbs.jsonl');
  writeFileSync(path, '{"id":"one","orbScene":"old"}\n');
  chmodSync(path, 0o644);
  upsertOrbIndex(path, { id: 'one', orbScene: 'new' });
  upsertOrbIndex(path, { id: 'two', orbScene: 'other' });
  assert.deepEqual(readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse), [
    { id: 'one', orbScene: 'new' }, { id: 'two', orbScene: 'other' },
  ]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('50개 상한, 검증 실패 쓰기 없음, 오너 감정 우선, 재실행 멱등', async (t) => {
  const fixture = setup(t, 51);
  let calls = 0;
  const summary = await run(options(fixture, { judge: () => {
    calls += 1;
    return envelope(calls === 1 ? { ...answer, importance: 9 } : answer);
  } }));
  assert.equal(summary.selected, NIGHTLY_LIMIT);
  assert.equal(calls, NIGHTLY_LIMIT);
  assert.equal(summary.written, NIGHTLY_LIMIT - 1);
  assert.equal(summary.failed.length, 1);
  assert.equal(readFileSync(join(fixture.root, fixture.candidates[0].rel), 'utf8'), fixture.candidates[0].content);
  const written = readFileSync(join(fixture.root, fixture.candidates[1].rel), 'utf8');
  const fields = parseFrontmatter(written);
  const originalKeys = new Set(Object.keys(fixture.candidates[1].fields));
  assert.deepEqual(Object.keys(fields).filter((key) => !originalKeys.has(key)).sort(), [...ORB_FIELDS].sort());
  assert.deepEqual(fields.emotions, ['슬픔']);
  assert.equal(fields.primaryEmotion, '슬픔');
  assert.equal(fields.coreMemoryCandidate, true);
  assert.equal(fields.mineAge, 3);
  for (const key of ['coreMemoryReason', 'representativePhotos', 'representativePhotoEvidence',
    'orbScene', 'orbTitleSuggestion']) assert.equal(fields[key], undefined);
  const orbs = readFileSync(join(fixture.out, 'orbs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(orbs.length, NIGHTLY_LIMIT - 1);
  assert.deepEqual(orbs[0].representativePhotos, ['photo.jpg']);
  assert.equal(orbs[0].coreMemoryReason, '첫 생일');
  assert.equal(orbs[0].orbScene, '미네가 케이크를 본다.');
  assert.equal(statSync(join(fixture.out, 'orbs.jsonl')).mode & 0o777, 0o600);
  assert.ok(written.endsWith('## 오너 메모\n감정: 슬픔\n'));
  assert.equal(applyOrbFields(written, answer, [{ sourcePath: 'photo.jpg', reason: '확인' }]), null);
  let repeatedCalls = 0;
  const repeated = await run(options(fixture, { candidates: [fixture.candidates[1]],
    judge: () => { repeatedCalls += 1; return envelope(answer); } }));
  assert.equal(repeatedCalls, 0);
  assert.equal(repeated.written, 0);
});

test('같은 KST 날짜 재실행에서도 예약 기록이 호출 총량을 50개로 제한한다', async (t) => {
  const fixture = setup(t, 51);
  let calls = 0;
  const fixedNow = () => Date.parse('2026-10-17T03:40:00+09:00');
  await run(options(fixture, { judge: () => { calls += 1; return envelope(answer); }, now: fixedNow }));
  await run(options(fixture, { candidates: fixture.candidates.slice(1),
    judge: () => { calls += 1; return envelope(answer); }, now: fixedNow }));
  assert.equal(calls, NIGHTLY_LIMIT);
  const rows = readFileSync(join(fixture.out, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter((row) => row.status === 'reserved' && row.kstDate === '2026-10-17').length, NIGHTLY_LIMIT);
});

test('Ollama 사진 판단: 이미지 모델에 격자 사본을 base64로 붙이고 답 모양을 묶는다', async () => {
  const schema = orbSchema('2020-01-01', fixtureCriteria);
  assert.deepEqual(schema.properties.confidence.enum, ['낮음', '보통', '높음']);
  assert.ok(schema.required.includes('coreMemoryCandidate'));
  assert.deepEqual(schema.properties.levels.required, ['기쁨', '슬픔', '버럭', '까칠', '소심']);
  assert.equal(schema.properties.primaryEmotion, undefined, '0.2는 primaryEmotion 칸을 묻지 않는다(코드가 세기로 정함)');
  const calls = [];
  const decide = ollamaPhotoDecision({ criteria: fixtureCriteria, output: { log() {} }, readImage: (path) => `b64:${path}`,
    invoke: async (request) => { calls.push(request); return { json: answer, usage: { promptTokens: 900, outputTokens: 80 } }; } });
  const measured = await decide('프롬프트', '/copies', 60_000, { imagePaths: ['/copies/a-1.jpg', '/copies/a-2.jpg'], recordDate: '2020-01-01' });
  assert.deepEqual(measured, { result: answer, inputTokens: 900, outputTokens: 80, usage: { promptTokens: 900, outputTokens: 80 } });
  assert.equal(calls[0].model, OLLAMA_MODELS.vision);
  assert.deepEqual(calls[0].images, ['b64:/copies/a-1.jpg', 'b64:/copies/a-2.jpg']);
  assert.equal(calls[0].timeoutMs, 60_000);
  assert.deepEqual(calls[0].schema, schema);
});

test('run --engine=ollama: 쿨다운과 무관, 판 이름을 색인·runs에 남기고, 형식 실패는 실패·멈춤은 연기 후 중단', async (t) => {
  const fixture = setup(t, 4);
  const prompts = [];
  let unloaded = 0;
  const measured = (value) => ({ result: value, inputTokens: 900, outputTokens: 80, usage: {} });
  const replies = [
    () => measured(ollamaAnswer({ 기쁨: '짙음', 슬픔: '보통' })),
    () => { throw Object.assign(new Error('로컬 모델 답이 JSON이 아님'), { formatFailure: true }); },
    () => { throw Object.assign(new Error('Ollama 연결 실패: fetch failed'), { unavailable: true }); },
    () => { throw new Error('부르면 안 됨'); },
  ];
  const summary = await run(options(fixture, { engine: 'ollama', cooldown: () => true, criteria: { ...fixtureCriteria, ref: '미네-감정-분류@시험' },
    unload: async () => { unloaded += 1; },
    judge: async (prompt, _cwd, _timeout, { imagePaths, recordDate }) => {
      prompts.push(prompt);
      assert.match(imagePaths[0], /-1\.jpg$/);
      assert.equal(recordDate, '2020-01-01');
      return replies[prompts.length - 1]();
    } }));
  assert.equal(prompts.length, 3);
  assert.doesNotMatch(prompts[0], /Read/);
  assert.equal(summary.cooldown, false);
  assert.equal(summary.written, 1);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.deferred.length, 1);
  assert.equal(summary.unavailable, true);
  assert.equal(unloaded, 0, '시험 주입이면 모델을 내리지 않는다');
  const version = { engine: 'ollama', model: OLLAMA_MODELS.vision, criteriaRef: '미네-감정-분류@시험', promptVersion: PROMPT_VERSIONS.ollama };
  const [orb] = readFileSync(join(fixture.out, 'orbs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const { at, ...judgment } = orb.judgment;
  assert.ok(Date.parse(at));
  assert.deepEqual(judgment, { ...version, scores: { 기쁨: 0.85, 슬픔: 0.57, 버럭: 0, 까칠: 0, 소심: 0 },
    levels: { 기쁨: '짙음', 슬픔: '보통', 버럭: '없음', 까칠: '없음', 소심: '없음' }, emotionState: '있음', nearestAnchor: 'photo-joy-2a', photoKinds: [null] });
  assert.match(prompts[0], /# 기준 예시[\s\S]*photo-joy-2a[\s\S]*<note-data>/);
  const runs = readRuns(join(fixture.out, 'runs.jsonl'));
  assert.deepEqual(runs.map((row) => row.status), ['reserved', 'written', 'reserved', 'error', 'reserved', 'deferred']);
  assert.ok(runs.every((row) => row.engine === 'ollama' && row.model === OLLAMA_MODELS.vision && row.promptVersion === PROMPT_VERSIONS.ollama));
  assert.equal(runs[3].formatFailure, true);
  await assert.rejects(run(options(fixture, { engine: 'gpt' })), /판단 엔진/);
});

test('Ollama 실제 경로: 격자를 읽어 붙이고 끝나면 이미지 모델을 한 번 내린다, 시간 초과는 그 순간만의 실패', async (t) => {
  const fixture = setup(t, 2);
  const unloaded = [];
  const images = [];
  let calls = 0;
  const summary = await run(options(fixture, { engine: 'ollama', readImage: (path) => { images.push(path); return 'aGk='; },
    unload: async (model) => { unloaded.push(model); },
    invoke: async (request) => {
      calls += 1;
      assert.deepEqual(request.images, ['aGk=']);
      if (calls === 1) throw Object.assign(new Error('로컬 모델 시간 초과(180초)'), { timeout: true });
      return { json: ollamaAnswer(), usage: { promptTokens: 1, outputTokens: 1 } };
    } }));
  assert.equal(calls, 2, '시간 초과 뒤에도 다음 순간으로 간다');
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.written, 1);
  assert.equal(summary.unavailable, undefined);
  assert.ok(images.every((path) => /-1\.jpg$/.test(path)), '격자 대신 사진 사본을 붙인다');
  assert.deepEqual(unloaded, [OLLAMA_MODELS.vision]);
});

test('Ollama 사진 입력: 사진마다 세운 원본 크기로 미네 얼굴 위치를 붙이고 격자는 만들지 않는다', async (t) => {
  const fixture = setup(t, 1);
  const prompts = [];
  let grids = 0;
  await run(options(fixture, { engine: 'ollama', mineFaces: new Map([[fixture.candidates[0].id, { i: 0, score: 0.9, bbox: [1400, 1800, 1600, 2200] }]]),
    copyPhoto: () => ({ width: 3024, height: 4032 }), gridPhoto: () => { grids += 1; },
    judge: async (prompt) => { prompts.push(prompt); return { result: ollamaAnswer(), inputTokens: 1, outputTokens: 1, usage: {} }; } }));
  assert.equal(grids, 0);
  const data = JSON.parse(prompts[0].match(/<note-data>\n([\s\S]*?)\n<\/note-data>/)[1]);
  assert.deepEqual(data.photoCopies, [{ number: 1, reason: data.photoCopies[0].reason,
    mineFace: '미네 얼굴: 한가운데 (가로 0.46~0.53, 세로 0.45~0.55, 사진 전체 0~1 기준)' }]);
  assert.equal(JSON.stringify(data).includes('copies'), false, '파일 경로를 넣지 않는다');
});

test('Ollama 0.3 사진 종류: 사진마다 photoKind를 주고, 대표 사진이 모두 가려짐이면 모델 답과 관계없이 모름', async (t) => {
  const fixture = setup(t, 2);
  const [visible, hidden] = fixture.candidates.map((item) => item.id);
  const prompts = [];
  await run(options(fixture, { engine: 'ollama',
    mineFaces: new Map([[visible, { i: 0, score: 0.9, bbox: [700, 600, 1860, 1760] }]]),
    // 보이는 사진: 미네 얼굴이 크다(얼굴 가까이). 가려진 사진: 얼굴은 있으나 미네로 확인된 것이 없다.
    photoFaces: new Map([[visible, [{ i: 0, bbox: [700, 600, 1860, 1760], det: 0.9, blur: 80 }]], [hidden, [{ i: 0, bbox: [0, 0, 900, 900] }]]]),
    copyPhoto: () => ({ width: 3000, height: 4000 }),
    judge: async (prompt) => { prompts.push(prompt); return { result: ollamaAnswer({ 기쁨: '보통' }), inputTokens: 1, outputTokens: 1, usage: {} }; } }));
  const kinds = prompts.map((prompt) => JSON.parse(prompt.match(/<note-data>\n([\s\S]*?)\n<\/note-data>/)[1]).photoCopies[0].photoKind);
  assert.deepEqual(kinds, ['얼굴 가까이', '가려짐']);
  assert.match(prompts[0], /# 사진 종류[\s\S]*멀리서: 얼굴이 작아/);
  const orbs = new Map(readFileSync(join(fixture.out, 'orbs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map((row) => [row.id, row]));
  assert.deepEqual(orbs.get(visible).judgment.photoKinds, ['얼굴 가까이']);
  assert.equal(orbs.get(visible).judgment.emotionState, '있음');
  assert.equal(orbs.get(hidden).judgment.emotionState, '모름');
  assert.deepEqual(orbs.get(hidden).judgment.forcedUnknown, { modelState: '있음' });
  assert.equal(orbs.get(hidden).orbScene, '미네가 케이크를 본다.', '장면은 상황 근거로 남긴다');
  const note = readFileSync(join(fixture.root, fixture.candidates[1].rel), 'utf8');
  // 이 시험 노트는 오너 메모에 감정(슬픔)이 있어 오너 값이 남고, 사진 근거만 모름으로 붙는다(오너 정정 우선).
  assert.match(note, /^emotions: \["슬픔"\]$/m);
  assert.match(note, /^emotionEvidence: "오너 메모 감정: 슬픔; 사진 근거: 모름: 사진 종류 가려짐/m);
});

test('validateOllamaOrb forceUnknown: 상태·근거를 코드가 정하고 모델 글(웃음)은 근거로 쓰지 않는다', () => {
  const forced = validateOllamaOrb(ollamaAnswer({ 기쁨: '짙음' }), [], null, '2020-01-01', fixtureCriteria, { forceUnknown: true });
  assert.deepEqual([forced.emotions, forced.primaryEmotion, forced.emotionIntensity, forced.emotionState], [[], null, null, '모름']);
  assert.doesNotMatch(forced.emotionEvidence, /웃는다/);
  assert.equal(forced.stateConflict, undefined);
  assert.equal(forced.titleSuggestion, '생일 케이크');
  assert.equal(validateOllamaOrb(ollamaAnswer(), [], null, '2020-01-01', fixtureCriteria).forcedUnknown, undefined);
  assert.throws(() => validateOllamaOrb({ ...ollamaAnswer(), levels: {} }, [], null, '2020-01-01', fixtureCriteria, { forceUnknown: true }),
    (error) => error.formatFailure === true, '가려짐이어도 답 형식은 검사한다');
  assert.throws(() => validateOllamaOrb({ ...ollamaAnswer(), emotionState: '행복' }, [], null, '2020-01-01', fixtureCriteria, { forceUnknown: true }),
    (error) => error.formatFailure === true, '상태 칸도 덮어쓰기 전에 검사한다');
});

test('validateOllamaOrb: 세기 단어로 감정을 정하고 0.0과 같은 검증을 거친다, 모름은 근거에 표시', () => {
  const joy = validateOllamaOrb(ollamaAnswer({ 기쁨: '짙음' }), [], null, '2020-01-01', fixtureCriteria);
  assert.deepEqual([joy.primaryEmotion, joy.emotionIntensity, joy.emotionState, joy.titleSuggestion], ['기쁨', 3, '있음', '생일 케이크']);
  const unknown = validateOllamaOrb(ollamaAnswer({ 기쁨: '보통' }, '모름'), [], null, '2020-01-01', fixtureCriteria);
  assert.deepEqual([unknown.emotions, unknown.primaryEmotion, unknown.emotionState], [[], null, '모름']);
  assert.match(unknown.emotionEvidence, /^모름: /);
  assert.throws(() => validateOllamaOrb({ ...ollamaAnswer(), levels: {} }, [], null, '2020-01-01', fixtureCriteria),
    (error) => error.formatFailure === true);
});

test('종료코드 규칙: 판단이 전부 실패하면(10-18 --restricted 사고) 잡 실패, 한도로 연기만 됐으면 OK', async (t) => {
  const broken = setup(t);
  const failed = await run(options(broken, { judge: () => { throw new Error("claude 종료코드 1: error: unknown option '--restricted'"); } }));
  assert.equal(failed.written, 0);
  assert.equal(failed.failed.length, 1);
  assert.equal(llmRunFailed(memoryOrbCounts(failed)), true);
  const limited = setup(t);
  const limit = new Error('사용량 한도');
  limit.isLimit = true;
  const deferred = await run(options(limited, { judge: () => { throw limit; } }));
  assert.equal(llmRunFailed(memoryOrbCounts(deferred)), false);
});

test('종료코드 규칙: 남은 잡 예산으로 잘린 claude 호출의 시간 초과는 연기(잡 시간 상한)로 센다', async (t) => {
  const fixture = setup(t);
  const started = Date.parse('2026-10-17T00:00:00Z');
  let late = false;
  const summary = await run(options(fixture, {
    now: () => (late ? started + MAX_JOB_MS : started),
    judge: () => { late = true; throw new Error('헤드리스 타임아웃 (5분 초과)'); },
  }));
  assert.equal(summary.failed.length, 0);
  assert.equal(summary.timedOut, true);
  assert.equal(llmRunFailed(memoryOrbCounts(summary)), false);
});

// ---- 사진 글 판(scene-claude): 로컬 장면 낱말 → Claude 두 번 ----
const sceneWords = (overrides = {}) => ({ mineVisible: '보임', mineFaceView: '정면', mineMask: '안 씀', faceCovered: '안 가려짐',
  mouthCorners: '올라감', mouthShape: '이가 보이게 벌림', eyeShape: '반달처럼 접힘', browShape: '편안함', tears: '없음', gaze: '카메라를 봄', bodyPose: '편안함',
  mineExpression: '입꼬리가 올라가고 이가 보임', mineAction: '케이크 앞에 앉아 있음', place: '실내', occasion: '생일 케이크 앞', people: '어른 1명',
  other: '없음', ...overrides });
const AFTERNOON = () => Date.parse('2026-11-01T14:00:00+09:00');
const cropTargets = [];
function sceneOptions(fixture, { scene = sceneWords(), answers = [ollamaAnswer({ 기쁨: '보통' })], ...overrides } = {}) {
  const ollama = []; const claude = [];
  let index = 0;
  cropTargets.length = 0;
  // 오너 메모 감정이 있으면 한 번만 묻는다 — 두 번 묻기 시험은 메모 없는 순간으로.
  if (!overrides.keepMemo) for (const item of fixture.candidates) item.memo = '';
  delete overrides.keepMemo;
  const visible = new Map(fixture.candidates.map((item) => [item.id, { i: 0, score: 0.9, bbox: [700, 600, 1860, 1760] }]));
  return { ollama, claude, options: options(fixture, { engine: SCENE_ENGINE, now: AFTERNOON, cooldown: () => false, anchorScenes: {},
    mineFaces: visible, photoFaces: new Map([...visible].map(([id, face]) => [id, [{ ...face, det: 0.9, blur: 80 }]])),
    copyPhoto: () => ({ width: 3000, height: 4000 }), readImage: (path) => (path.endsWith('-face.jpg') ? 'RkFDRQ==' : 'aGk='),
    cropFace: (source, target) => { writeFileSync(target, 'x'); cropTargets.push(target); return { width: 448, height: 448 }; },
    invoke: async (request) => { ollama.push(request); return { json: scene, usage: { promptTokens: 1 } }; },
    judge: async (prompt) => { claude.push(prompt); const answer = answers[Math.min(index, answers.length - 1)]; index += 1; return JSON.stringify(answer); },
    ...overrides }) };
}
const ledger = (fixture) => readFileSync(join(fixture.out, PHOTO_TEXT_JUDGMENTS_FILE), 'utf8').trim().split('\n').map(JSON.parse);

test('scene-claude: 사진은 로컬 모델에만(base64), Claude에는 장면 낱말 글만 두 번, 판 이름·호출 수를 판단 기록에', async (t) => {
  const fixture = setup(t);
  const { ollama, claude, options: opts } = sceneOptions(fixture);
  const summary = await run(opts);
  assert.equal(summary.written, 1);
  assert.equal(ollama.length, 1);
  assert.deepEqual(ollama[0].images, ['aGk=', 'RkFDRQ=='], '0.4-face: 사진 전체 + 미네 얼굴 확대 그림');
  assert.match(ollama[0].prompt, /두 번째는 첫 번째 사진에서 미네 얼굴 부분만 잘라 크게 키운 것/);
  assert.equal(JSON.stringify(ollama[0].schema).includes('emotion'), false, '장면 낱말 답 모양에 감정 칸 없음');
  assert.equal(claude.length, 2, '순간마다 두 번');
  for (const prompt of claude) {
    for (const leak of ['aGk=', 'RkFDRQ==', '.jpg', fixture.root, 'photo.jpg']) assert.equal(prompt.includes(leak), false, `Claude 프롬프트에 ${leak}`);
    assert.match(prompt, /장면 낱말/);
  }
  const [row] = ledger(fixture);
  assert.deepEqual([row.mode, row.status, row.calls, row.engine, row.promptVersion, row.sceneModel, row.scenePromptVersion, row.at],
    ['orb', 'applied', 2, 'claude', PHOTO_TEXT_PROMPT_VERSION, OLLAMA_MODELS.vision, JOB_SCENE_VERSION, '2026-11-01']);
  assert.equal(row.answers.length, 2);
  assert.deepEqual(row.faceCrops, [true]);
  assert.ok(cropTargets.length === 1 && cropTargets.every((target) => !existsSync(target)), '확대 그림 파일은 읽은 뒤 지운다');
  const stored = readFileSync(join(fixture.out, SCENES_FILE), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([stored[0].photoId, stored[0].sceneVersion, stored[0].faceCrop], [fixture.candidates[0].id, JOB_SCENE_VERSION, true]);
  const orb = JSON.parse(readFileSync(join(fixture.out, 'orbs.jsonl'), 'utf8').trim());
  assert.deepEqual([orb.judgment.promptVersion, orb.judgment.photoKinds, orb.judgment.emotionState], [PHOTO_TEXT_PROMPT_VERSION, ['얼굴 가까이'], '있음']);
});

test('scene-claude: 두 답이 다르면 애매함 — 노트에 쓰지 않고 같은 판으로 다시 묻지 않는다', async (t) => {
  const fixture = setup(t);
  const { claude, options: opts } = sceneOptions(fixture, { answers: [ollamaAnswer({ 기쁨: '보통' }), ollamaAnswer({ 기쁨: '옅음' })] });
  const summary = await run(opts);
  assert.equal(summary.written, 0);
  assert.deepEqual(summary.ambiguous, [fixture.candidates[0].id]);
  assert.equal(readFileSync(join(fixture.root, fixture.candidates[0].rel), 'utf8'), fixture.candidates[0].content);
  assert.equal(ledger(fixture)[0].status, 'ambiguous');
  assert.equal(readRuns(join(fixture.out, 'runs.jsonl')).at(-1).status, 'ambiguous');
  // 다음 날 다시 돌려도(예약 24시간 뒤) 묻지 않는다.
  const again = sceneOptions(fixture, { now: () => AFTERNOON() + 2 * 86_400_000 });
  await run(again.options);
  assert.equal(claude.length, 2);
  assert.equal(again.claude.length, 0);
});

test('scene-claude: 장면 낱말에 미네 마스크면 가려짐 → 감정은 코드가 모름, 중요도용으로 한 번만 묻는다', async (t) => {
  const fixture = setup(t);
  const { claude, options: opts } = sceneOptions(fixture, { scene: sceneWords({ mineMask: '씀', faceCovered: '일부 가려짐' }) });
  await run(opts);
  assert.equal(claude.length, 1);
  const data = JSON.parse(claude[0].match(/<note-data>\n([\s\S]*?)\n<\/note-data>/)[1]);
  assert.equal(data.photos[0].photoKind, '가려짐');
  assert.equal(data.photos[0].scene.mineExpression, undefined, '가려진 사진의 표정 낱말은 넘기지 않는다');
  const [row] = ledger(fixture);
  assert.deepEqual([row.forcedUnknown, row.kindCorrected, row.calls], [true, [true], 1]);
  const orb = JSON.parse(readFileSync(join(fixture.out, 'orbs.jsonl'), 'utf8').trim());
  assert.equal(orb.judgment.emotionState, '모름');
  assert.match(readFileSync(join(fixture.root, fixture.candidates[0].rel), 'utf8'), /^emotionEvidence: "모름: 대표 사진 1장 모두 장면 낱말에 미네 얼굴이 보이지 않음\(마스크 1장\)"$/m);
});

test('scene-claude: 06:20~07:30에는 돌지 않는다(--ignore-window면 돈다), 하루 상한이 차면 묻지 않는다', async (t) => {
  const fixture = setup(t);
  const morning = sceneOptions(fixture, { now: () => Date.parse('2026-11-01T06:45:00+09:00') });
  const blocked = await run(morning.options);
  assert.equal(blocked.blockedWindow, true);
  assert.equal(morning.ollama.length + morning.claude.length, 0);
  const override = sceneOptions(fixture, { now: () => Date.parse('2026-11-01T06:45:00+09:00'), ignoreWindow: true });
  assert.equal((await run(override.options)).written, 1);

  const full = setup(t);
  mkdirSync(full.out, { recursive: true });
  writeFileSync(join(full.out, PHOTO_TEXT_JUDGMENTS_FILE), `${JSON.stringify({ mode: 'review', engine: 'claude', at: '2026-11-01', calls: 99 })}\n`);
  const capped = sceneOptions(full);
  const summary = await run(capped.options);
  assert.equal(summary.capped, true);
  assert.equal(capped.claude.length + capped.ollama.length, 0);
});

test('scene-claude: 호출 중 회차 시간에 들어서면 남은 호출을 미루고 연기로 남긴다, 쿨다운도 매 호출 전 확인', async (t) => {
  const fixture = setup(t);
  let clock = Date.parse('2026-11-01T06:19:00+09:00');
  const { claude, options: opts } = sceneOptions(fixture, { now: () => clock });
  opts.judge = async (prompt) => { claude.push(prompt); clock = Date.parse('2026-11-01T06:21:00+09:00'); return JSON.stringify(ollamaAnswer()); };
  const summary = await run(opts);
  assert.equal(claude.length, 1);
  assert.equal(summary.blockedWindow, true);
  assert.equal(summary.deferred.length, 1);
  assert.equal(ledger(fixture)[0].status, 'retry');
  assert.equal(ledger(fixture)[0].calls, 1, '부른 한 번은 상한에 센다');

  const other = setup(t);
  let cooled = false;
  const second = sceneOptions(other, { cooldown: () => cooled });
  second.options.judge = async () => { second.claude.push(1); cooled = true; return JSON.stringify(ollamaAnswer()); };
  const result = await run(second.options);
  assert.equal(second.claude.length, 1);
  assert.equal(result.cooldown, true);
});

test('scene-claude: 오너 메모에 감정이 있으면 오너 값이 노트에 가고 한 번만 묻는다', async (t) => {
  const fixture = setup(t);
  const { claude, options: opts } = sceneOptions(fixture, { keepMemo: true });
  assert.equal((await run(opts)).written, 1);
  assert.equal(claude.length, 1);
  assert.match(readFileSync(join(fixture.root, fixture.candidates[0].rel), 'utf8'), /^emotions: \["슬픔"\]$/m);
});

test('judgeSceneMoment: 얼굴이 보이는 사진이 하나라도 있으면 Claude 두 번, 얼굴 안 보이는 사진은 표정 낱말 없이, 멀리서도 얼굴이 보이면 단서를 넘긴다', async () => {
  const item = { id: 'm', date: '2020-01-01', memo: '', fields: { occurred: '2020-01-01', description: '순간' } };
  const prompts = [];
  const result = await judgeSceneMoment(item, [{ kind: '얼굴 가까이', scene: sceneWords() }, { kind: '멀리서', scene: sceneWords({ mineFaceView: '뒷모습' }) },
    { kind: '멀리서', scene: sceneWords() }],
    { criteria: fixtureCriteria, anchors, anchorScenes: {}, decide: async (prompt) => { prompts.push(prompt); return JSON.stringify(ollamaAnswer()); } });
  assert.equal(result.forced, false);
  assert.equal(result.calls, 2);
  const data = JSON.parse(prompts[0].match(/<note-data>\n([\s\S]*?)\n<\/note-data>/)[1]);
  assert.equal(data.photos[0].scene.mineExpression, '입꼬리가 올라가고 이가 보임');
  assert.equal(data.photos[1].scene.mineExpression, undefined);
  assert.equal(data.photos[2].scene.mineExpression, '입꼬리가 올라가고 이가 보임');
  const allHidden = await judgeSceneMoment(item, [{ kind: '멀리서', scene: sceneWords({ mineVisible: '안 보임' }) }],
    { criteria: fixtureCriteria, anchors, anchorScenes: {}, decide: async () => JSON.stringify(ollamaAnswer()) });
  assert.equal(allHidden.forced, true);
  const bad = await judgeSceneMoment(item, [{ kind: '얼굴 가까이', scene: sceneWords() }],
    { criteria: fixtureCriteria, anchors, decide: async () => 'JSON 아님' });
  assert.equal(bad.formatFailure, true);
});

test('scene-claude: 얼굴 확대 그림을 못 만들면 사진 전체만으로 장면 낱말을 뽑고 순간은 그대로 판단한다', async (t) => {
  const fixture = setup(t);
  const errors = [];
  let written = null;
  const { ollama, options: opts } = sceneOptions(fixture, { cropFace: (source, target) => { writeFileSync(target, 'x'); written = target; throw new Error('exiftool 없음'); } });
  const summary = await run({ ...opts, output: { log() {}, error: (line) => errors.push(line) } });
  assert.equal(summary.written, 1);
  assert.deepEqual(ollama[0].images, ['aGk=']);
  assert.doesNotMatch(ollama[0].prompt, /두 번째 그림/);
  assert.ok(errors.some((line) => /얼굴 확대 그림 실패/.test(line)));
  const stored = readFileSync(join(fixture.out, SCENES_FILE), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([stored[0].faceCrop, stored[0].faceCropError], [false, 'exiftool 없음']);
  assert.equal(summary.faceCropFailures, 1);
  assert.equal(existsSync(written), false, '실패해도 확대 그림 파일을 지운다');
  assert.deepEqual(ledger(fixture)[0].faceCrops, [false]);
});
