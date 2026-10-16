import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHORT_VIDEO_SECONDS, chooseRepresentative, classify, exclusionReasons, detectSignals } from './media-delete-core.mjs';
import { frameArgs, frameMetrics } from '../tools/media-quality-measure.mjs';

const clean = (overrides = {}) => ({
  record: { id: 'a', archivePath: 'Archive/2025/01/Camera/a.jpg', size: 100, googlePhotosBackupConfirmed: true, ...overrides.record },
  vision: { labels: [], text: '', faces: 0, aesthetic: 0.5, ...overrides.vision },
  quality: { sharpness: 100, meanBrightness: 120, ...overrides.quality },
  face: overrides.face ?? {}, note: overrides.note ?? {}, groupSize: 1, ...overrides.item,
});

test('절대 제외: 미네·가족 얼굴·앨범·카테고리, 핵심 기억, 사건, 오너 메모, 녹음·통화, 분석 누락, 백업 미확인, 모르는 얼굴', () => {
  assert.deepEqual(exclusionReasons(clean()), []);
  const cases = [
    [{ face: { people: ['미네'] } }, '미네·가족'],
    [{ face: { hold: ['휘영'] } }, '미네·가족'],
    [{ note: { category: ['[[01_Home/201 미네]]'] } }, '미네·가족'],
    [{ record: { importPath: 'Imports/미네 2019/x.jpg' } }, '미네·가족'],
    [{ note: { coreMemory: true } }, '핵심 기억'],
    [{ note: { description: '2019 미네 생일 순간' } }, '사건·기념일'],
    [{ note: { ownerMemo: true } }, '오너 메모'],
    [{ record: { archivePath: 'Archive/x.m4a' } }, '녹음·통화'],
    [{ vision: { error: 'x' } }, '분석 누락'],
    [{ record: { googlePhotosBackupConfirmed: false } }, '구글 포토 백업 미확인'],
    [{ vision: { faces: 1 } }, '얼굴 있음'],
  ];
  for (const [override, reason] of cases) {
    const reasons = exclusionReasons(clean(override));
    assert.ok(reasons.some((value) => value.includes(reason)), `${reason}: ${reasons}`);
    assert.deepEqual(classify(clean(override)).candidates, []);
  }
});

test('신호: 검은 화면 A, 짧은 무의미 영상(3초 이하·소리 없음)만, 소리 있으면 제외, 실수 촬영은 C라 후보 아님', () => {
  const dark = clean({ quality: { meanBrightness: 1, sharpness: 1 } });
  assert.deepEqual(classify(dark).candidates.map((s) => `${s.type} ${s.grade}`), ['검은 화면·주머니 촬영 A']);
  const video = (durationSec, hasAudio) => clean({ record: { archivePath: 'Archive/x.mp4' },
    quality: { durationSec, hasAudio, meanBrightness: 100, allFramesMeasured: true, allFramesDark: false } });
  assert.ok(detectSignals(video(SHORT_VIDEO_SECONDS, false)).some((s) => s.type === '짧은 무의미 영상'));
  assert.ok(!detectSignals(video(SHORT_VIDEO_SECONDS + 0.5, false)).some((s) => s.type === '짧은 무의미 영상'));
  assert.ok(!detectSignals(video(2, true)).some((s) => s.type === '짧은 무의미 영상'));
  const miss = clean({ vision: { labels: [{ name: 'floor' }] } });
  assert.deepEqual(classify(miss).candidates, []);
});

test('완전 중복은 하드링크(같은 inode)면 제외, 다른 파일이면 A', () => {
  const dup = (sameInode) => clean({ record: { duplicateOf: 'archive:b' }, item: { sameInode } });
  assert.ok(exclusionReasons(dup(true)).includes('하드링크 중복'));
  assert.ok(classify(dup(false)).candidates.some((s) => s.type === '완전 중복' && s.grade === 'A'));
});

test('백업 확인만 남은 행은 후보가 아니라 따로 표시', () => {
  const dark = clean({ record: { googlePhotosBackupConfirmed: false }, quality: { meanBrightness: 1, sharpness: 1 } });
  const row = classify(dark);
  assert.deepEqual(row.candidates, []);
  assert.deepEqual(row.pendingBackupOnly.map((s) => s.type), ['검은 화면·주머니 촬영']);
});

test('연사 대표: 미네 얼굴 점수 → 선명도 순, 동률은 촬영 시각', () => {
  const item = (id, mineFaceScore, sharpness, capturedAt) => ({ record: { id, capturedAt, size: 1 }, mineFaceScore, quality: { sharpness } });
  assert.equal(chooseRepresentative([item('a', 0.2, 900, '2'), item('b', 0.6, 10, '3')]).record.id, 'b');
  assert.equal(chooseRepresentative([item('a', 0, 10, '2'), item('b', 0, 50, '3')]).record.id, 'b');
  assert.equal(chooseRepresentative([item('b', 0, 10, '3'), item('a', 0, 10, '2')]).record.id, 'a');
});

test('측정: 프레임 밝기·선명도 계산, 불완전 프레임은 오류', () => {
  const black = Buffer.alloc(64 * 64, 0);
  assert.equal(frameMetrics(black).allFramesDark, true);
  const pattern = Buffer.from(Array.from({ length: 64 * 64 }, (_, i) => (i % 2 ? 255 : 0)));
  const metrics = frameMetrics(pattern);
  assert.equal(metrics.allFramesDark, false);
  assert.ok(metrics.sharpness > 1000);
  assert.throws(() => frameMetrics(Buffer.alloc(10)), /불완전/);
});

test('짧은 영상 기준이 결정 문서(미디어-삭제-판정)의 3초와 같다', (t) => {
  const path = join(process.env.HOME ?? '', 'Pantheon/Mouseion/50_Outputs/Decisions/2026-10-17 미디어 삭제 판정 기준.md');
  if (!existsSync(path)) return t.skip('볼트 없음');
  assert.match(readFileSync(path, 'utf8'), new RegExp(`\\*\\*${SHORT_VIDEO_SECONDS}초 이하\\*\\*`));
});

test('측정·리포트 코드에는 원본 삭제·이동이 없다(측정 잠금 파일 해제만 예외)', () => {
  const dir = fileURLToPath(new URL('..', import.meta.url));
  for (const file of ['lib/media-delete-core.mjs', 'tools/media-delete-report.mjs', 'tools/media-quality-measure.mjs']) {
    const source = readFileSync(join(dir, file), 'utf8');
    assert.doesNotMatch(source, /\brmSync\b|\brenameSync\b|\bcpSync\b|Trash/, file);
    const unlinks = source.match(/unlinkSync\(([^)]*)\)/g) ?? [];
    assert.ok(unlinks.every((call) => call === 'unlinkSync(lock)'), `${file}: ${unlinks}`);
  }
});

test('측정 ffmpeg 인자: 사진은 -map 0:v:0 다음에 -frames:v 1(실측 버그 회귀), 영상은 프레임 제한 없음', () => {
  const photo = frameArgs('/x.jpg', 'photo');
  assert.deepEqual(photo.slice(4, 8), ['-map', '0:v:0', '-frames:v', '1']);
  assert.ok(!frameArgs('/x.mp4', 'video').includes('-frames:v'));
});
