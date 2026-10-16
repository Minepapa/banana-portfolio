import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EMOTIONS, IMPORTANCE_GUIDE } from '../jobs/mine-athena-fields.mjs';
import { buildArgs, headlessJsonFailure } from '../lib/headless-claude.mjs';
import { albumForMoment, buildPrompt, makeGrid, chooseTargets, choosePhotos, momentPhotos, verifyStripped, validateProposal, ownerEmotions,
  parseClaudeResult, summarize, renderSheet, run } from './media-memory-orb-trial.mjs';

const proposal = { emotions: ['기쁨'], primaryEmotion: '기쁨', confidence: '보통', importance: 2,
  scene: '미네가 웃고 있다.', titleSuggestion: '웃는 날', coreMemoryCandidate: { value: false, reason: '일상' } };

test('결정론 표본은 연도와 장면을 먼저 분산한다', () => {
  const candidates = Array.from({ length: 20 }, (_, i) => ({ id: `id${i}`, year: `${2017 + i % 10}`,
    sceneKey: `scene${i % 5}`, photos: [{ id: `p${i}` }] }));
  const first = chooseTargets(candidates);
  assert.deepEqual(chooseTargets(candidates).map((item) => item.id), first.map((item) => item.id));
  assert.equal(new Set(first.map((item) => item.year)).size, 10);
  assert.equal(new Set(first.map((item) => item.sceneKey)).size, 5);
  assert.deepEqual(chooseTargets(candidates, { ids: first.map((item) => item.id) }).map((item) => item.id), first.map((item) => item.id));
});

test('대표 사진은 미네 확인·얼굴 점수·다른 Vision 장면을 사용하고 영상은 제외', () => {
  const item = { photos: [
    { id: 'a', path: 'a.jpg', confirmedMine: true }, { id: 'b', path: 'b.jpg', confirmedMine: true },
    { id: 'c', path: 'c.jpg', confirmedMine: true }, { id: 'd', path: 'd.mov', confirmedMine: true },
    { id: 'e', path: 'e.jpg', confirmedMine: false },
  ] };
  const scores = new Map([['a', .9], ['b', .8], ['c', .7], ['d', 1], ['e', 1]]);
  const vision = new Map([['a', { labels: [{ name: 'park', confidence: .8 }] }],
    ['b', { labels: [{ name: 'park', confidence: .8 }] }], ['c', { labels: [{ name: 'cake', confidence: .8 }] }]]);
  assert.deepEqual(choosePhotos(item, scores, vision).map((photo) => photo.id), ['a', 'c', 'b']);
  assert.match(choosePhotos(item, scores, vision)[0].reason, /얼굴 점수/);
});

test('순간 본문의 사진 경로가 mediaId 색인과 다르면 선택하지 않는다', () => {
  const people = { a: { people: ['미네'] }, b: { people: ['미네'] } };
  const index = new Map([['a', { importPath: 'Imports/a.jpg' }], ['b', { importPath: 'Imports/b.jpg' }]]);
  const identity = (path) => path;
  const photos = momentPhotos(['a', 'b'], ['Imports/b.jpg', 'Imports/a.jpg'], people, index, '/media', () => true, identity);
  assert.deepEqual(photos, []);
  assert.equal(momentPhotos(['a'], ['Imports/a.jpg'], people, index, '/media', () => true, identity).length, 1);
  assert.deepEqual(momentPhotos(['a'], ['Imports/a.jpg'], people, index, '/media', () => true,
    (path) => path.endsWith('a.jpg') ? '/outside/a.jpg' : path), []);
});

test('EXIF/GPS 등 메타 잔류를 거부한다', () => {
  assert.equal(verifyStripped('/tmp/a.jpg', () => '[{"File:FileName":"a.jpg","JFIF:JFIFVersion":1}]'), true);
  for (const tag of ['ExifIFD:DateTimeOriginal', 'IFD0:Make', 'GPS:GPSLatitude',
    'XMP:GPSLongitude', 'Composite:GPSPosition']) {
    assert.throws(() => verifyStripped('/tmp/a.jpg', () => JSON.stringify([{ [tag]: 'secret' }])), /메타데이터 잔류/);
  }
});

test('사진 격자 한 장은 1536px 이하이며 EXIF가 없다', () => {
  const out = mkdtempSync(join(tmpdir(), 'orb-grid-'));
  const paths = [1, 2, 3].map((number) => join(out, `${number}.jpg`));
  const generated = spawnSync('python3', ['-c', `from PIL import Image\nimport sys\nfor path in sys.argv[1:]: Image.new('RGB', (1200, 900), 'red').save(path, exif=Image.Exif())`, ...paths]);
  assert.equal(generated.status, 0);
  const target = join(out, 'grid.jpg');
  makeGrid(paths.map((path) => ({ path })), target);
  assert.equal(verifyStripped(target), true);
  const dimensions = JSON.parse(spawnSync('exiftool', ['-j', '-ImageWidth', '-ImageHeight', target], { encoding: 'utf8' }).stdout)[0];
  assert.ok(Math.max(dimensions.ImageWidth, dimensions.ImageHeight) <= 1536);
  assert.equal(statSync(target).mode & 0o777, 0o600);
  rmSync(out, { recursive: true });
});

test('프롬프트는 사건 정보·핵심 후보 주체·공유 중요도 기준을 포함한다', () => {
  const album = albumForMoment([{ id: 'media1', path: 'Imports/폴더명/a.jpg' }], new Map([['media1', { album: '첫돌 앨범' }]]));
  const text = buildPrompt({ id: 'x', album, fields: { occurred: '2017-11-09', description: '미네 첫돌', place: '집' }, memo: '가족 행사' }, [{ path: '/tmp/grid.jpg', reason: '1번' }]);
  for (const phrase of ['첫돌 앨범', '미네 첫돌', '집', '가족 행사', '후보 표시는 아테나의 일', '확정만 오너 몫', 'confidence', IMPORTANCE_GUIDE]) assert.ok(text.includes(phrase));
  assert.equal(text.match(/\/tmp\/grid.jpg/g).length, 1);
});

test('감정 어휘·대표 감정·중요도·핵심 후보 스키마를 검사한다', () => {
  assert.deepEqual(validateProposal(proposal).emotions, ['기쁨']);
  assert.throws(() => validateProposal({ ...proposal, emotions: ['환희'] }), /감정/);
  assert.throws(() => validateProposal({ ...proposal, primaryEmotion: EMOTIONS[1] }), /대표 감정/);
  assert.throws(() => validateProposal({ ...proposal, importance: 6 }), /중요도/);
  assert.throws(() => validateProposal({ ...proposal, coreMemoryCandidate: true }), /핵심/);
});

test('오너 감정은 보존하고 Claude 제안은 별도 필드에 둔다', () => {
  const owner = ownerEmotions({}, '감정: 슬픔, 기쁨\n추억');
  assert.deepEqual(owner, ['슬픔', '기쁨']);
  const result = validateProposal(proposal, owner);
  assert.deepEqual(result.emotions, owner);
  assert.deepEqual(result.suggestedEmotions, ['기쁨']);
  assert.equal(result.primaryEmotion, '슬픔');
  assert.equal(validateProposal(proposal, owner, '기쁨').primaryEmotion, '기쁨');
});

test('Claude JSON usage와 평균·전체·밤 추정', () => {
  const parsed = parseClaudeResult(JSON.stringify({ result: JSON.stringify(proposal),
    usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 50 }, num_turns: 2, total_cost_usd: .01 }));
  assert.equal(parsed.inputTokens, 150);
  assert.equal(parsed.outputTokens, 50);
  assert.equal(parsed.num_turns, 2);
  assert.equal(parsed.total_cost_usd, .01);
  const summary = summarize([{ status: 'ok', inputTokens: 150, outputTokens: 50, photoCount: 2, elapsedMs: 1000 },
    { status: 'ok', inputTokens: 250, outputTokens: 50, photoCount: 3, elapsedMs: 3000 }]);
  assert.equal(summary.estimatedTotalTokens, 750000);
  assert.equal(summary.estimatedNightTokens, 12500);
  assert.equal(summary.estimatedNights, 60);
  assert.equal(summary.averageSeconds, 2);
  const accounted = summarize([{ status: 'ok', inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens,
    usage: parsed.usage, total_cost_usd: parsed.total_cost_usd, photoCount: 3, elapsedMs: 9000 }]);
  assert.equal(accounted.totalNewInputTokens, 120);
  assert.equal(accounted.totalCacheReadTokens, 30);
  assert.equal(accounted.averageCostUsd, .01);
  assert.equal(accounted.estimatedTotalCostUsd, 30);
  assert.deepEqual(accounted.nightTable.map((night) => night.count), [20, 50, 100]);
  assert.equal(accounted.nightTable[0].newInputTokens, 2400);
  const invalid = summarize([{ status: 'error', inputTokens: 100, outputTokens: 20, photoCount: 1, elapsedMs: 1000 }]);
  assert.equal(invalid.estimatedTotalTokens, 360000);
  assert.equal(invalid.measured, 1);
});

test('과금된 Claude 오류 JSON은 usage·비용을 보존하고 한도면 다음 순간을 멈춘다', async () => {
  const out = mkdtempSync(join(tmpdir(), 'orb-charged-error-'));
  const item = { id: 'a1b2c3d4e5f60000', rel: 'test.md', title: 'test',
    fields: { occurred: '2020-01-01' }, memo: '',
    chosen: [{ id: 'media1', path: 'Imports/a.jpg', reason: '얼굴 확인' }] };
  const envelope = JSON.stringify({ is_error: true, result: 'hit your session limit',
    usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 },
    num_turns: 2, total_cost_usd: .012 });
  assert.throws(() => parseClaudeResult(envelope), (error) => error.isLimit && error.usage.cache_read_input_tokens === 30);
  let calls = 0;
  const result = await run({ preparedItems: [item, { ...item, id: 'b1b2c3d4e5f60000' }], out,
    charter: { model: 'sonnet' }, mediaRoot: out, cooldown: () => false,
    copyPhoto: (_, target) => writeFileSync(target, 'copy'), gridPhoto: (_, target) => writeFileSync(target, 'grid'),
    judge: () => { calls++; throw headlessJsonFailure(envelope); }, output: { error() {} } });
  assert.equal(calls, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].inputTokens, 150);
  assert.equal(result.rows[0].outputTokens, 5);
  assert.equal(result.rows[0].num_turns, 2);
  assert.equal(result.rows[0].total_cost_usd, .012);
  assert.equal(result.summary.totalNewInputTokens, 120);
  assert.equal(result.summary.totalCacheReadTokens, 30);
  assert.equal(result.summary.totalCostUsd, .012);
  assert.equal(JSON.parse(readFileSync(join(out, 'results.jsonl'), 'utf8').trim()).usage.output_tokens, 5);
  rmSync(out, { recursive: true });
});

test('쿨다운 중에는 판단도 파일 쓰기도 하지 않는다', async () => {
  let called = 0;
  const result = await run({ preparedItems: [{}], cooldown: () => true, judge: () => { called++; }, out: '/not/writable' });
  assert.equal(called, 0);
  assert.equal(result.cooldown, true);
});

test('시트는 즉시 답 버튼·고친 감정·JSON 내보내기를 갖는다', () => {
  const sheet = renderSheet([{ id: 'abc', title: '<test>', copies: [{ name: 'x.jpg' }],
    ownerEmotions: [], proposal }]);
  assert.match(sheet, /data-answer="맞음"/);
  assert.match(sheet, /data-answer="틀림"/);
  assert.match(sheet, /data-emotion="기쁨"/);
  assert.match(sheet, /data-importance="5"/);
  assert.match(sheet, /data-core="yes"/);
  assert.match(sheet, /data-primary-emotion="기쁨"/);
  assert.match(sheet, /coreMemoryCandidate/);
  assert.match(sheet, /memo/);
  assert.match(sheet, /JSON 내보내기/);
  assert.match(sheet, /new Blob/);
  assert.doesNotMatch(sheet, /<h2><test><\/h2>/);
  assert.match(renderSheet([{ id: 'x', title: 'x', copies: [], ownerEmotions: ['슬픔'],
    proposal: { ...proposal, emotions: ['슬픔'], primaryEmotion: '슬픔', suggestedEmotions: ['기쁨'] } }]), /제안 감정: 기쁨/);
  const preserved = renderSheet([{ id: 'x', title: 'x', copies: [], ownerEmotions: ['슬픔'],
    proposal: { ...proposal, emotions: ['슬픔'], primaryEmotion: '슬픔', suggestedEmotions: ['기쁨'] } }]);
  assert.match(preserved, /data-emotion="슬픔" class="active"/);
  assert.doesNotMatch(preserved, /data-emotion="기쁨" class="active"/);
});

test('헤드리스 호출 옵션은 Read만 노출하고 JSON 계측을 허용한다', () => {
  const args = buildArgs('prompt', 'sonnet', 'Read', { tools: 'Read', outputFormat: 'json',
    permissionMode: 'dontAsk', restricted: true, strictMcpConfig: true,
    mcpConfig: '{"mcpServers":{}}', disallowedTools: 'mcp__*' });
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', 'Read']);
  assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2), ['--output-format', 'json']);
  assert.ok(args.includes('--restricted'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--mcp-config'));
});

test('검증 실패 순간도 이미 소비한 토큰·사진 수·시간을 results에 남긴다', async () => {
  const out = mkdtempSync(join(tmpdir(), 'orb-test-'));
  const item = { id: 'a1b2c3d4e5f60000', rel: 'test.md', title: 'test',
    fields: { occurred: '2020-01-01' }, memo: '',
    chosen: [{ id: 'media1', path: 'Imports/a.jpg', reason: '얼굴 확인' }] };
  const result = await run({ preparedItems: [item], out, charter: { model: 'sonnet' },
    mediaRoot: out, cooldown: () => false, copyPhoto: (_, target) => writeFileSync(target, 'copy'),
    gridPhoto: (_, target) => writeFileSync(target, 'grid'),
    judge: () => JSON.stringify({ result: JSON.stringify({ ...proposal, emotions: ['어휘밖'] }),
      usage: { input_tokens: 120, output_tokens: 30 } }), output: { error() {} } });
  assert.equal(result.rows[0].status, 'error');
  assert.equal(result.rows[0].inputTokens, 120);
  assert.equal(result.rows[0].photoCount, 1);
  assert.equal(result.rows[0].copies[0].mediaId, 'media1');
  assert.equal(result.summary.estimatedTotalTokens, 450000);
  const recorded = JSON.parse(readFileSync(join(out, 'results.jsonl'), 'utf8').trim());
  assert.equal(recorded.inputTokens, 120);
  assert.deepEqual(recorded.usage, { input_tokens: 120, output_tokens: 30 });
  assert.equal(recorded.num_turns, 0);
  assert.equal(recorded.total_cost_usd, 0);
  assert.equal(statSync(join(out, 'results.jsonl')).mode & 0o777, 0o600);
  assert.match(readFileSync(join(out, 'sheet-standalone.html'), 'utf8'), /data:image\/jpeg;base64,/);
  assert.equal(statSync(join(out, 'sheet-standalone.html')).mode & 0o777, 0o600);
  rmSync(out, { recursive: true });
});
