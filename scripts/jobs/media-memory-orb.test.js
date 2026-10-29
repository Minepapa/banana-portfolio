import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { fixtureCriteria } from '../lib/mine-emotion-criteria.fixture.js';
import { MAX_JOB_MS, NIGHTLY_LIMIT, ORB_FIELDS, PROMPT_VERSIONS, applyOrbFields, attemptState, ollamaPhotoDecision, orbSchema, validateOllamaOrb, readRuns,
  requireRegistryFields, run, upsertOrbIndex } from './media-memory-orb.mjs';
import { OLLAMA_MODELS } from '../lib/ollama-client.mjs';

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
    copyPhoto: () => {}, gridPhoto: () => {}, output: { log() {}, error() {} }, mineFaces: new Map(), anchors,
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
    levels: { 기쁨: '짙음', 슬픔: '보통', 버럭: '없음', 까칠: '없음', 소심: '없음' }, emotionState: '있음', nearestAnchor: 'photo-joy-2a' });
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

test('validateOllamaOrb: 세기 단어로 감정을 정하고 0.0과 같은 검증을 거친다, 모름은 근거에 표시', () => {
  const joy = validateOllamaOrb(ollamaAnswer({ 기쁨: '짙음' }), [], null, '2020-01-01', fixtureCriteria);
  assert.deepEqual([joy.primaryEmotion, joy.emotionIntensity, joy.emotionState, joy.titleSuggestion], ['기쁨', 3, '있음', '생일 케이크']);
  const unknown = validateOllamaOrb(ollamaAnswer({ 기쁨: '보통' }, '모름'), [], null, '2020-01-01', fixtureCriteria);
  assert.deepEqual([unknown.emotions, unknown.primaryEmotion, unknown.emotionState], [[], null, '모름']);
  assert.match(unknown.emotionEvidence, /^모름: /);
  assert.throws(() => validateOllamaOrb({ ...ollamaAnswer(), levels: {} }, [], null, '2020-01-01', fixtureCriteria),
    (error) => error.formatFailure === true);
});
