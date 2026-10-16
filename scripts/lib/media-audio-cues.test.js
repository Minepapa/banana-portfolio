import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  attachAudioCues, audioCuesForNote, clock, computeCues, mineIntervals, runCueWorker, summarizeCues, windowsInIntervals,
} from './media-audio-cues.mjs';

const win = (start, tags = {}, pitch = 280, rms = 0.05) =>
  ({ start, end: start + 4, tags: { laughter: 0, crying: 0, shouting: 0, singing: 0, sigh: 0, whisper: 0, ...tags }, pitch, rms });

test('clock: 초를 분:초로', () => {
  assert.equal(clock(5), '0:05');
  assert.equal(clock(70), '1:10');
});

test('mineIntervals: 녹음 이름표에서 미네 화자 구간만(초), 이름표 없으면 null', () => {
  const speakers = { labels: { S0: '나', S1: '미네' }, turns: [
    { start: 0, end: 4000, speaker: 'S0' }, { start: 4000, end: 10000, speaker: 'S1' }] };
  assert.deepEqual(mineIntervals(speakers), [{ start: 4, end: 10 }]);
  assert.equal(mineIntervals({ turns: [] }), null);
  assert.equal(mineIntervals(null), null);
});

test('windowsInIntervals: 미네 구간과 75% 이상 겹치는 창만, 겹친 구간은 한 번만 센다', () => {
  const windows = [win(0), win(2), win(3), win(6)];
  const kept = windowsInIntervals(windows, [{ start: 4, end: 10 }]);
  assert.deepEqual(kept.map((w) => w.start), [3, 6]);
  assert.equal(windowsInIntervals(windows, null).length, 4);
  // 같은 구간이 두 번 들어와도 겹침을 부풀리지 않는다(2~6 창은 4~6만 겹침 = 50%).
  assert.deepEqual(windowsInIntervals([win(2)], [{ start: 4, end: 6 }, { start: 4, end: 6 }]), []);
});

test('summarizeCues: 문턱 이상만, 이어진 창은 한 번으로, 웃음·노래·높이·세기 문장', () => {
  const windows = [
    win(0, { laughter: 0.36 }), win(2, { laughter: 0.30 }), win(10, { laughter: 0.1 }),
    win(30, { singing: 0.8 }), win(32, { singing: 0.7 }), win(40, { laughter: 0.39 }, 400, 0.2),
  ];
  const { lines, counts } = summarizeCues(windows, { scope: '미네 구간' });
  assert.equal(counts.laughter, 2);
  assert.equal(counts.singing, 1);
  assert.match(lines[0], /미네 구간.*틀릴 수 있음/);
  assert.ok(lines.some((line) => /웃음 2회\(0:00·0:40, 최대 0\.39\)/.test(line)));
  assert.ok(lines.some((line) => /노래 약 6초\(0:30 시작\)/.test(line)));
  assert.ok(lines.some((line) => /목소리 높이: .*높아진 구간 0:40/.test(line)));
  assert.ok(lines.some((line) => /소리 세기: 커진 구간 0:40/.test(line)));
  assert.ok(!lines.some((line) => /울음/.test(line) && !/신호 없음/.test(line)));
});

test('summarizeCues: 웃음·울음 없으면 그렇게 적고, 창이 없으면 분석할 구간 없음', () => {
  assert.ok(summarizeCues([win(0)], { scope: '전체(화자 분리 없음)' }).lines.includes('- 웃음·울음 신호 없음'));
  assert.match(summarizeCues([], { scope: '미네 구간' }).lines[0], /분석할 구간 없음/);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'audio-cues-test-'));
  const mediaRoot = join(dir, 'Media');
  mkdirSync(join(mediaRoot, 'Archive', '2020', '07', 'Recordings'), { recursive: true });
  const audio = join(mediaRoot, 'Archive', '2020', '07', 'Recordings', 'a.m4a');
  writeFileSync(audio, 'audio');
  return { dir, mediaRoot, cacheDir: join(dir, 'cache'), archivePaths: new Map([['aaaaaaaaaaaaaaaa', 'Archive/2020/07/Recordings/a.m4a']]) };
}

test('computeCues: 계산 결과를 0600 캐시로 남기고, 원본이 같으면 다시 계산하지 않으며 바뀌면 다시 계산', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const options = { mediaRoot: f.mediaRoot, cacheDir: f.cacheDir, archivePaths: f.archivePaths, temporaryRoot: f.dir,
      exec: async () => {}, worker: async ([item]) => { calls += 1; return [{ id: item.id, durationSec: 8, windowSec: 4, hopSec: 2, windows: [win(0)] }]; } };
    const first = await computeCues('aaaaaaaaaaaaaaaa', options);
    assert.equal(first.windows.length, 1);
    assert.equal(statSync(join(f.cacheDir, 'aaaaaaaaaaaaaaaa.json')).mode & 0o777, 0o600);
    await computeCues('aaaaaaaaaaaaaaaa', options);
    assert.equal(calls, 1);
    writeFileSync(join(f.mediaRoot, 'Archive', '2020', '07', 'Recordings', 'a.m4a'), 'changed audio');
    await computeCues('aaaaaaaaaaaaaaaa', options);
    assert.equal(calls, 2);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('computeCues: 색인에 없거나 원본이 없거나 작업기가 실패하면 오류를 돌려준다(예외로 멈추지 않음)', async () => {
  const f = fixture();
  try {
    const base = { mediaRoot: f.mediaRoot, cacheDir: f.cacheDir, temporaryRoot: f.dir, exec: async () => {} };
    assert.deepEqual(await computeCues('bbbbbbbbbbbbbbbb', { ...base, archivePaths: f.archivePaths }), { error: '색인에 원본 없음' });
    assert.deepEqual(await computeCues('aaaaaaaaaaaaaaaa', { ...base, archivePaths: new Map([['aaaaaaaaaaaaaaaa', 'Archive/x.m4a']]) }), { error: '원본 파일 없음' });
    assert.deepEqual(await computeCues('aaaaaaaaaaaaaaaa', { ...base, archivePaths: new Map([['aaaaaaaaaaaaaaaa', '../etc/passwd']]) }), { error: 'Archive 경로 오류' });
    const failed = await computeCues('aaaaaaaaaaaaaaaa', { ...base, archivePaths: f.archivePaths, worker: async () => [{ id: 'aaaaaaaaaaaaaaaa', error: 'boom' }] });
    assert.deepEqual(failed, { error: 'boom' });
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('audioCuesForNote: 녹음은 미네 구간 요약, 화자 파일 없으면 전체, 통화는 아직 연결하지 않음', async () => {
  const note = '---\nconvKind: "녹음"\n---\n<!-- media-transcribe:id aaaaaaaaaaaaaaaa -->\n본문';
  const compute = async () => ({ windows: [win(0, { laughter: 0.4 }), win(8, { crying: 0.5 })] });
  const withSpeakers = await audioCuesForNote(note, { compute, archivePaths: new Map(), speakersFor: () => ({
    labels: { S0: '미네', S1: '나' }, turns: [{ start: 0, end: 4000, speaker: 'S0' }, { start: 8000, end: 12000, speaker: 'S1' }] }) });
  assert.equal(withSpeakers.ok, true);
  assert.match(withSpeakers.text, /미네 구간/);
  assert.match(withSpeakers.text, /웃음 1회/);
  assert.doesNotMatch(withSpeakers.text, /울음 1회/);
  const alone = await audioCuesForNote(note, { compute, archivePaths: new Map(), speakersFor: () => null });
  assert.match(alone.text, /전체\(한 사람 녹음\)/);
  assert.match(alone.text, /울음 1회/);
  const call = await audioCuesForNote(note.replace('녹음', '통화'), { compute, archivePaths: new Map() });
  assert.equal(call.ok, false);
  assert.match(call.text, /통화는 미네 구간 연결 전/);
  const failed = await audioCuesForNote(note, { compute: async () => ({ error: '원본 파일 없음' }), archivePaths: new Map() });
  assert.equal(failed.ok, false);
  assert.match(failed.text, /없음\(원본 파일 없음\)/);
});

function fakeSpawn({ stdout = '', stderr = '', code = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => { child.stdout.end(stdout); child.stderr.end(stderr); setImmediate(() => child.emit('close', code)); });
    return child;
  };
}

test('runCueWorker: 결과가 아닌 줄은 버리고, 실패 종료는 거부로(프로세스를 죽이지 않음)', async () => {
  const rows = await runCueWorker([{ id: 'a', wav: 'x' }], { spawnProcess: fakeSpawn({ stdout: 'onnx warning\n{"id":"a","windows":[]}\n' }) });
  assert.deepEqual(rows, [{ id: 'a', windows: [] }]);
  await assert.rejects(runCueWorker([], { spawnProcess: fakeSpawn({ stderr: 'boom', code: 1 }) }), /소리 분석 실패: boom/);
});

test('attachAudioCues: 계산 예외는 노트별 없음으로, 시간 예산을 넘으면 나머지는 예산 초과', async () => {
  const withId = '<!-- media-transcribe:id aaaaaaaaaaaaaaaa -->';
  const items = [{ content: withId }, { content: withId }, { content: withId }];
  let t = 0;
  await attachAudioCues(items, { archivePaths: new Map(), budgetMs: 10, now: () => t,
    compute: async () => { t += 20; throw new Error('x'); } });
  assert.match(items[0].audioCues.text, /없음/);
  assert.equal(items[0].audioCues.ok, false);
  assert.match(items[1].audioCues.text, /시간 예산 초과/);
});

test('audioCuesForNote: 화자 분리에 미네가 없으면 소리 근거 없음(전체를 쓰지 않음)', async () => {
  const note = '---\nconvKind: "녹음"\n---\n<!-- media-transcribe:id aaaaaaaaaaaaaaaa -->';
  const r = await audioCuesForNote(note, { compute: async () => ({ windows: [win(0, { laughter: 0.9 })] }), archivePaths: new Map(),
    speakersFor: () => ({ labels: { S0: '나', S1: '다른 사람' }, turns: [{ start: 0, end: 4000, speaker: 'S0' }] }) });
  assert.match(r.text, /미네 화자 미확인/);
  assert.doesNotMatch(r.text, /웃음 1회/);
  const single = await audioCuesForNote(note.replace('"녹음"', "'통화'"), { compute: async () => ({ windows: [] }), archivePaths: new Map() });
  assert.match(single.text, /통화는 미네 구간 연결 전/);
});

test('computeCues: 통화(kind Calls)·Archive 밖 경로는 읽지 않고, 실패는 원본이 같으면 다시 시도하지 않는다', async () => {
  const f = fixture();
  try {
    const base = { mediaRoot: f.mediaRoot, cacheDir: f.cacheDir, temporaryRoot: f.dir, exec: async () => {} };
    const calls = new Map([['aaaaaaaaaaaaaaaa', { archivePath: 'Archive/2020/07/Recordings/a.m4a', kind: 'Calls' }]]);
    assert.deepEqual(await computeCues('aaaaaaaaaaaaaaaa', { ...base, archivePaths: calls }), { error: '녹음이 아님(통화 등)' });
    const escape = new Map([['aaaaaaaaaaaaaaaa', { archivePath: 'Archive/../../x.m4a', kind: 'Recordings' }]]);
    assert.deepEqual(await computeCues('aaaaaaaaaaaaaaaa', { ...base, archivePaths: escape }), { error: 'Archive 경로 오류' });
    let tries = 0;
    const failing = { ...base, archivePaths: f.archivePaths, worker: async () => { tries += 1; return [{ id: 'aaaaaaaaaaaaaaaa', error: 'boom' }]; } };
    await computeCues('aaaaaaaaaaaaaaaa', failing);
    const again = await computeCues('aaaaaaaaaaaaaaaa', failing);
    assert.equal(tries, 1);
    assert.match(again.error, /boom\(이전 실패 기록\)/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('audioCuesForNote: 대화형 녹음인데 화자 분리 전이면 소리 근거를 주지 않는다', async () => {
  const note = '---\nconvKind: "녹음"\n---\n<!-- media-transcribe:id aaaaaaaaaaaaaaaa -->';
  const paths = new Map([['aaaaaaaaaaaaaaaa', { archivePath: 'Archive/2023/01/Recordings/2023-01-01 미네 대화 친구 이야기.m4a', kind: 'Recordings' }]]);
  const r = await audioCuesForNote(note, { compute: async () => ({ windows: [win(0, { laughter: 0.9 })] }), archivePaths: paths, speakersFor: () => null });
  assert.match(r.text, /화자 분리 전/);
  const song = new Map([['aaaaaaaaaaaaaaaa', { archivePath: 'Archive/2021/01/Recordings/2021-01-20 미네 노래 아침 해.m4a', kind: 'Recordings' }]]);
  const s2 = await audioCuesForNote(note, { compute: async () => ({ windows: [win(0, { laughter: 0.9 })] }), archivePaths: song, speakersFor: () => null });
  assert.match(s2.text, /전체\(한 사람 녹음\)/);
});
