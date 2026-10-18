import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHighlightArgs, runVideoHighlights } from './media-video-highlights.mjs';

test('CLI 옵션은 전체 백필과 특정 ID를 허용한다', () => {
  assert.deepEqual(parseHighlightArgs(['--limit=1394', '--ids=a,b', '--dry-run']),
    { ids: ['a', 'b'], limit: 1394, dryRun: true });
  assert.throws(() => parseHighlightArgs(['--ids=../a']), /옵션/);
  assert.throws(() => parseHighlightArgs(['--limit=0']), /옵션/);
});

test('증분 계산은 최신 ID 하나씩 저장하고 재료가 바뀌면 다시 계산한다', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-highlights-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const paths = { matches: join(base, 'matches.jsonl'), cues: join(base, 'cues'),
    frames: join(base, 'frames'), highlights: join(base, 'out', 'highlights.jsonl'),
    review: join(base, 'out', 'review.html') };
  mkdirSync(paths.cues);
  const match = { id: 'a', original: 'Archive/a.mp4', durationSec: 12, people: [],
    sourceSize: 50, sourceMtimeMs: 100 };
  writeFileSync(paths.matches, `${JSON.stringify(match)}\n`);
  const output = { log() {}, error() {} };
  assert.equal(runVideoHighlights({ paths, dryRun: true, output }).selected, 1);
  assert.equal(runVideoHighlights({ paths, output }).processed, 1);
  assert.equal(statSync(paths.highlights).mode & 0o777, 0o600);
  assert.equal(statSync(paths.review).mode & 0o777, 0o600);
  assert.match(readFileSync(paths.review, 'utf8'), /영상 하이라이트/);
  assert.equal(runVideoHighlights({ paths, output }).unchanged, 1);
  writeFileSync(join(paths.cues, 'a.json'), JSON.stringify({ size: 50, mtimeMs: 100, windows: [
    { start: 4, end: 8, tags: { laughter: 0.9 }, pitch: 100, rms: 0.05 }] }));
  assert.equal(runVideoHighlights({ paths, output }).processed, 1);
  const rows = readFileSync(paths.highlights, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].highlights[0].evidence.includes('웃음'));
  writeFileSync(join(paths.cues, 'a.json'), JSON.stringify({ size: 51, mtimeMs: 100,
    windows: [{ start: 4, end: 8, tags: { crying: 1 } }] }));
  assert.equal(runVideoHighlights({ paths, output }).processed, 1);
  assert.ok(!JSON.parse(readFileSync(paths.highlights, 'utf8')).highlights[0].evidence.includes('울음'));
});

test('새 영상의 얼굴 실패에도 상태 파일의 소리 근거로 계산하고 낡은 얼굴을 쓰지 않는다', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-highlights-audio-only-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const paths = { matches: join(base, 'matches.jsonl'), cues: join(base, 'cues'),
    frames: join(base, 'frames'), status: join(base, 'status.json'),
    highlights: join(base, 'highlights.jsonl'), review: join(base, 'review.html') };
  mkdirSync(paths.cues);
  writeFileSync(paths.matches, `${JSON.stringify({ id: 'old', durationSec: 14,
    people: ['미네'], representatives: { 미네: { timestampSec: 6 } },
    sourceSize: 10, sourceMtimeMs: 100 })}\n`);
  const stages = { faces: { ok: false }, cues: { ok: true, videoDurationSec: 14,
    sourceSize: 10, sourceMtimeMs: 100 } };
  writeFileSync(paths.status, JSON.stringify({ old: { path: 'Archive/old.mp4', stages },
    fresh: { path: 'Archive/fresh.mp4', stages } }));
  for (const id of ['old', 'fresh']) {
    writeFileSync(join(paths.cues, `${id}.json`), JSON.stringify({ size: 10, mtimeMs: 100,
      windows: [{ start: 4, end: 8, tags: { laughter: 0.9 } }] }));
  }
  assert.equal(runVideoHighlights({ paths, output: { log() {} } }).processed, 2);
  const rows = readFileSync(paths.highlights, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((row) => row.id), ['fresh', 'old']);
  assert.ok(rows.every((row) => row.highlights[0].evidence.includes('웃음')));
  assert.ok(rows.every((row) => !row.highlights[0].evidence.includes('미네 얼굴')));
});

test('검토 HTML 저장 실패는 JSONL을 앞당기지 않고 다음 실행에서 재시도한다', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-highlights-review-retry-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const paths = { matches: join(base, 'matches.jsonl'), cues: join(base, 'cues'),
    frames: join(base, 'frames'), highlights: join(base, 'highlights.jsonl'),
    review: join(base, 'review.html') };
  writeFileSync(paths.matches, `${JSON.stringify({ id: 'a', durationSec: 12 })}\n`);
  mkdirSync(paths.review);
  const output = { log() {}, error() {} };
  assert.throws(() => runVideoHighlights({ paths, output }));
  assert.throws(() => readFileSync(paths.highlights), /ENOENT/);
  rmSync(paths.review, { recursive: true });
  assert.equal(runVideoHighlights({ paths, output }).processed, 1);
  assert.equal(runVideoHighlights({ paths, output }).unchanged, 1);
  assert.match(readFileSync(paths.review, 'utf8'), /영상 하이라이트/);
});
