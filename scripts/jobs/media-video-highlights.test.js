import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHighlightArgs, runVideoHighlights } from './media-video-highlights.mjs';

test('CLI 옵션은 전체 백필과 특정 ID를 허용한다', () => {
  assert.deepEqual(parseHighlightArgs(['--limit=1394', '--ids=a,b', '--dry-run']),
    { ids: ['a', 'b'], limit: 1394, dryRun: true });
  assert.throws(() => parseHighlightArgs(['--ids=../a']), /옵션/);
  assert.throws(() => parseHighlightArgs(['--limit=0']), /옵션/);
});

test('보류 확인은 미네 얼굴 근거와 fingerprint에 반영된다', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-highlights-answer-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sheetsPath = join(base, 'sheets');
  mkdirSync(sheetsPath);
  const paths = { matches: join(base, 'matches.jsonl'), cues: join(base, 'cues'),
    frames: join(base, 'frames'), highlights: join(base, 'highlights.jsonl'),
    review: join(base, 'review.html') };
  writeFileSync(paths.matches, `${JSON.stringify({ id: 'a', durationSec: 12, people: [], hold: ['미네'],
    representatives: { 미네: { timestampSec: 5 } }, sourceSize: 1, sourceMtimeMs: 1 })}\n`);
  const output = { log() {} };
  assert.equal(runVideoHighlights({ paths, sheetsPath, output }).processed, 1);
  const previous = JSON.parse(readFileSync(paths.highlights, 'utf8'));
  writeFileSync(join(sheetsPath, 'video-hold-review-2030-01.json'), JSON.stringify({ videoAnswers: [
    { id: 'a', person: '미네', timestampSec: 5, confirmedPerson: true },
  ] }));
  assert.equal(runVideoHighlights({ paths, sheetsPath, dryRun: true, output }).selected, 1);
  assert.equal(runVideoHighlights({ paths, sheetsPath, output }).processed, 1);
  const current = JSON.parse(readFileSync(paths.highlights, 'utf8'));
  assert.notEqual(current.fingerprint, previous.fingerprint);
  assert.ok(current.highlights.some((part) => part.evidence.includes('미네 얼굴')));
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

test('새 전사와 미네 발화 구간이 들어오면 해당 영상 하이라이트만 다시 계산한다', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-highlights-transcript-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const id = '1234567890abcdef';
  const paths = { matches: join(base, 'matches.jsonl'), cues: join(base, 'cues'),
    frames: join(base, 'frames'), transcripts: join(base, 'transcripts'),
    highlights: join(base, 'out.jsonl'), review: join(base, 'review.html') };
  mkdirSync(paths.cues);
  writeFileSync(paths.matches, `${JSON.stringify({ id, durationSec: 12,
    sourceSize: 50, sourceMtimeMs: 100 })}\n`);
  const output = { log() {} };
  assert.equal(runVideoHighlights({ paths, output }).processed, 1);
  const year = join(paths.transcripts, '2024');
  mkdirSync(year, { recursive: true });
  writeFileSync(join(year, `${id}.json`), JSON.stringify({ id, version: 2,
    sourceSize: 50, sourceMtimeMs: 100,
    segments: [{ start: 2000, end: 6000, text: '안녕', name: '미네' }] }));
  assert.equal(runVideoHighlights({ paths, output }).processed, 1);
  const row = JSON.parse(readFileSync(paths.highlights, 'utf8'));
  assert.ok(row.highlights[0].evidence.includes('미네 목소리'));
  assert.ok(row.highlights[0].evidence.includes('말소리'));
  assert.equal(runVideoHighlights({ paths, output }).unchanged, 1);
});

test('증분 한도가 있을 때 막 전사된 영상 ID를 먼저 계산한다', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-highlights-priority-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const paths = { matches: join(base, 'matches.jsonl'), cues: join(base, 'cues'),
    frames: join(base, 'frames'), highlights: join(base, 'out.jsonl'),
    review: join(base, 'review.html') };
  writeFileSync(paths.matches, ['old', 'new'].map((id) => JSON.stringify({ id,
    durationSec: 12, sourceSize: 1, sourceMtimeMs: 1 })).join('\n') + '\n');
  const result = runVideoHighlights({ paths, priorityIds: ['new'], limit: 1,
    output: { log() {} } });
  assert.equal(result.processed, 1);
  assert.equal(JSON.parse(readFileSync(paths.highlights, 'utf8')).id, 'new');
});

test('앞선 하이라이트 저장 실패가 반복돼도 다음 회차는 뒤쪽 후보를 확인한다', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-highlights-rotation-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const paths = { matches: join(base, 'matches.jsonl'), cues: join(base, 'cues'),
    frames: join(base, 'frames'), highlights: join(base, 'out.jsonl'),
    review: join(base, 'review.html') };
  writeFileSync(paths.matches, ['a', 'b', 'c'].map((id) => JSON.stringify({ id,
    durationSec: 12, sourceSize: 1, sourceMtimeMs: 1 })).join('\n') + '\n');
  mkdirSync(paths.review);
  assert.throws(() => runVideoHighlights({ paths, limit: 1, catchupOffset: 0,
    output: { log() {} } }));
  assert.equal(existsSync(paths.highlights), false);
  rmSync(paths.review, { recursive: true });
  assert.equal(runVideoHighlights({ paths, limit: 1, catchupOffset: 1,
    output: { log() {} } }).processed, 1);
  assert.equal(JSON.parse(readFileSync(paths.highlights, 'utf8')).id, 'b');
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
