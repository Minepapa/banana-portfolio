import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { fixtureCriteria } from '../lib/mine-emotion-criteria.fixture.js';
import { MAX_JOB_MS, NIGHTLY_LIMIT, ORB_FIELDS, applyOrbFields, attemptState, readRuns, requireRegistryFields, run, upsertOrbIndex } from './media-memory-orb.mjs';

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
    copyPhoto: () => {}, gridPhoto: () => {}, output: { log() {}, error() {} },
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
