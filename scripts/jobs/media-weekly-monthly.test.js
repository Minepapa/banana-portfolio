import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runWeekly, reportMessage, writeWeeklyReport } from './media-delete-report-weekly.mjs';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { runMonthly, holdMessage, pendingHoldCount } from './media-faces-hold-monthly.mjs';
import { confirmHoldFaces, holdSampleHash, holdSheetMediaFaces, renderHoldSheet } from './media-faces.mjs';

test('주간 잡은 측정 뒤 리포트를 저장하고 테미스 정보 메시지를 한 번 보낸다', async () => {
  const events = [];
  const stateRoot = mkdtempSync(join(tmpdir(), 'weekly-send-'));
  try { await runWeekly([], {
    measure: (args) => { events.push(['measure', args]); },
    report: (_args, { writer }) => {
      events.push(['report']);
      writer({ day: '2026-10-18', markdown: '# 예시', summary: { candidateItems: 0 } });
      return { candidateItems: 0, candidateBytes: 0 };
    },
    save: () => { events.push(['save']); return { path: '/vault/report.md', created: true }; },
    send: (message) => { events.push(['send', message]); },
    output: { log() {} }, stateRoot,
  }); } finally { rmSync(stateRoot, { recursive: true, force: true }); }
  assert.deepEqual(events.map(([name]) => name), ['measure', 'report', 'save', 'send']);
  assert.match(events[0][1][0], /--limit=100/);
  assert.deepEqual(events[3][1], reportMessage({ candidateItems: 0, candidateBytes: 0 }, '/vault/report.md'));
  assert.equal(events[3][1].agent, 'themis');
});

test('주간 dry-run과 --no-send는 발송하지 않는다', async () => {
  let sent = 0;
  const send = () => { sent++; };
  await runWeekly(['--dry-run'], { measure() {}, report: () => ({ candidateItems: 1 }),
    send, output: { log() {} } });
  await runWeekly(['--no-send'], { measure() {}, report: (_a, { writer }) => {
    writer({ day: '2026-10-18' }); return { candidateItems: 1 };
  }, save: () => ({ path: '/tmp/r', created: true }), send, output: { log() {} } });
  assert.equal(sent, 0);
});

test('주간 발송 실패 뒤 재실행은 저장된 리포트를 다시 보내고 완료 후 중복을 막는다', async (t) => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'weekly-retry-'));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  let attempts = 0;
  const dependencies = {
    measure() {}, report: (_args, { writer }) => {
      writer({ day: '2026-10-18' });
      return { candidateItems: 1, candidateBytes: 10 };
    },
    save: () => ({ path: '/tmp/report.md', created: false }),
    send: () => { if (++attempts === 1) throw new Error('send failed'); },
    output: { log() {} }, stateRoot,
  };
  await assert.rejects(runWeekly([], dependencies), /send failed/);
  await runWeekly([], dependencies);
  await runWeekly([], dependencies);
  assert.equal(attempts, 2);
});

test('주간 리포트는 등록부 report 형식으로 한 번만 쓴다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'media-report-note-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registryPath = join(VAULT_PATHS.root, VAULT_REL.registryFile);
  const input = { day: '2026-10-18', markdown: '# 미디어 삭제 후보 측정\n\n후보 0건.\n', summary: {} };
  const first = writeWeeklyReport(input, { root, registryPath });
  assert.equal(first.created, true);
  assert.match(first.path, /50_Outputs\/Reports\/2026\/2026-10-18 미디어 삭제 후보 주간 관찰\.md$/);
  assert.match(readFileSync(first.path, 'utf8'), /type: "report"/);
  assert.equal(writeWeeklyReport(input, { root, registryPath }).created, false);
});

test('월간 보류 없음은 시트와 발송을 모두 건너뛰고, 보류가 있으면 한 번 보낸다', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'monthly-send-'));
  let created = 0;
  const sent = [];
  const create = () => { created++; return { count: 2, sheets: ['/tmp/hold.html'] }; };
  assert.deepEqual(await runMonthly([], { count: () => 0, create,
    send: (message) => sent.push(message) }), { count: 0, sheets: [] });
  assert.equal(created, 0);
  await runMonthly([], { count: () => 2, create, send: (message) => sent.push(message),
    output: { log() {} }, stateRoot });
  assert.equal(created, 1);
  assert.deepEqual(sent, [holdMessage(2, ['/tmp/hold.html'])]);
  assert.equal(sent[0].agent, 'athena');
  await runMonthly(['--dry-run'], { count: () => 2, create, send: (message) => sent.push(message),
    output: { log() {} } });
  assert.equal(created, 1);
  assert.equal(sent.length, 1);
  rmSync(stateRoot, { recursive: true, force: true });
});

test('월간 발송 완료 상태는 같은 달 재발송을 막는다', async (t) => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'monthly-once-'));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  let sent = 0;
  const dependencies = { count: () => 1, create: () => ({ count: 1, sheets: ['/tmp/hold.html'] }),
    send: () => { sent++; }, stateRoot, now: new Date('2026-10-01T01:00:00Z'), output: { log() {} } };
  await runMonthly([], dependencies);
  await runMonthly([], dependencies);
  assert.equal(sent, 1);
});

test('답한 영상 보류는 id·인물·시각이 일치할 때 집계에서 빠진다', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'answered-video-count-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sheetsPath = join(base, 'sheets');
  mkdirSync(sheetsPath);
  const videoMatchesPath = join(base, 'video-matches.jsonl');
  writeFileSync(videoMatchesPath, `${JSON.stringify({ id: 'a', hold: ['미네', '나'],
    representatives: { 미네: { timestampSec: 5 }, 나: { timestampSec: 8 } } })}\n`);
  writeFileSync(join(sheetsPath, 'video-hold-review-2026-09.json'), JSON.stringify({
    videoAnswers: [{ id: 'a', person: '미네', timestampSec: 5, confirmedPerson: false }],
  }));
  assert.equal(pendingHoldCount({ root: base, videoMatchesPath, sheetsPath }), 1);
});

test('영상 보류 카드는 대표 프레임과 시각을 표시한다', () => {
  const html = renderHoldSheet([{ id: 'video', kind: 'video', i: 0, number: 1,
    timestampSec: 5, framePath: '/tmp/video/5.jpg' }]);
  assert.match(html, /file:\/\/\/tmp\/video\/5.jpg/);
  assert.match(html, /영상 5초/);
  assert.match(html, /보류함: /);
});

test('영상 보류를 사진 보류 시트에 포함하고 대표 프레임 시각을 보존한다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-video-hold-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const out = join(base, 'faces');
  const frameRoot = join(base, 'frames');
  const archive = join(root, VAULT_REL.mediaArchiveIndex);
  mkdirSync(dirname(archive), { recursive: true });
  writeFileSync(archive, `${JSON.stringify({ id: 'video', capturedAt: '2026-09-12T00:00:00',
    archivePath: 'Archive/video.mov' })}\n${JSON.stringify({ id: 'missing-video',
    capturedAt: '2026-09-13T00:00:00', archivePath: 'Archive/missing.mov' })}\n`);
  const videoPath = join(out, 'video-matches.jsonl');
  mkdirSync(out, { recursive: true });
  writeFileSync(videoPath, `${JSON.stringify({ id: 'video', hold: ['미네'],
    representatives: { 미네: { timestampSec: 5 } } })}\n${JSON.stringify({ id: 'missing-video',
    hold: ['휘영'], representatives: { 휘영: { timestampSec: 8 } } })}\n`);
  const frame = join(frameRoot, 'video', '5.jpg');
  mkdirSync(dirname(frame), { recursive: true });
  writeFileSync(frame, 'frame');
  const warnings = [];
  const result = await holdSheetMediaFaces({ root, out, frameRoot,
    matchesPath: join(out, 'matches.jsonl'), videoMatchesPath: videoPath,
    indexPath: join(out, 'faces-index.jsonl'), returnDetails: true,
    output: { log() {}, warn: (message) => warnings.push(message) } });
  assert.equal(result.count, 1);
  assert.equal(result.missingFrames, 1);
  assert.match(warnings[0], /missing-video/);
  const sample = JSON.parse(readFileSync(join(out, 'sheets', 'hold-2026-09.json'), 'utf8')).sample;
  assert.deepEqual(sample.map(({ kind, timestampSec, person }) => ({ kind, timestampSec, person })),
    [{ kind: 'video', timestampSec: 5, person: '미네' }]);
  assert.match(readFileSync(result.sheets[0], 'utf8'), /영상 5초/);
  const second = await holdSheetMediaFaces({ root, out, frameRoot,
    matchesPath: join(out, 'matches.jsonl'), videoMatchesPath: videoPath,
    indexPath: join(out, 'faces-index.jsonl'), returnDetails: true, output: { log() {} } });
  assert.equal(second.count, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'sheets', 'hold-2026-09.json'), 'utf8')).sample, sample);
});

test('영상 보류 확인은 사진 갤러리 기준에 영상 id를 넣지 않는다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'video-hold-confirm-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const out = join(base, 'faces');
  const galleryPath = join(root, VAULT_REL.mediaFaceGallery);
  const sheetsPath = join(out, 'sheets');
  mkdirSync(dirname(galleryPath), { recursive: true });
  mkdirSync(sheetsPath, { recursive: true });
  const gallery = { bands: { '2y': { confirmed: true, members: [], holdCandidates: [] } } };
  writeFileSync(galleryPath, JSON.stringify(gallery));
  const sample = [
    { id: 'video', kind: 'video', person: '미네', number: 1, timestampSec: 5 },
  ];
  writeFileSync(join(sheetsPath, 'hold-2026-09.json'), JSON.stringify({ sample, sampleHash: holdSampleHash(sample) }));
  const answerPath = join(out, 'hold-2026-09.txt');
  writeFileSync(answerPath, `해시: ${'0'.repeat(64)}\n미네: 1`);
  await assert.rejects(confirmHoldFaces(answerPath, { root, out, galleryPath,
    output: { log() {} } }), /해시 불일치/);
  writeFileSync(answerPath, `해시: ${holdSampleHash(sample)}\n미네: 1`);
  await confirmHoldFaces(answerPath, { root, out, galleryPath, output: { log() {} } });
  assert.deepEqual(JSON.parse(readFileSync(galleryPath, 'utf8')), gallery);
  const review = JSON.parse(readFileSync(join(sheetsPath, 'video-hold-review-2026-09.json'), 'utf8'));
  assert.deepEqual(review.videoAnswers, [{ id: 'video', person: '미네', timestampSec: 5,
    confirmedPerson: true }]);
});

test('새 plist와 run.sh가 같은 잡을 가리키고 원본 삭제 명령은 없다', () => {
  const run = readFileSync(new URL('../launchd/run.sh', import.meta.url), 'utf8');
  for (const name of ['media-delete-report-weekly', 'media-faces-hold-monthly']) {
    const plist = readFileSync(new URL(`../launchd/com.banana2.${name}.plist`, import.meta.url), 'utf8');
    assert.match(run, new RegExp(`${name}\\) CMD=\\(scripts/jobs/${name}\\.mjs\\)`));
    assert.match(plist, new RegExp(`/banana-portfolio-v2/scripts/launchd/run\\.sh`));
    assert.match(plist, new RegExp(`<string>${name}</string>`));
  }
  const weekly = readFileSync(new URL('./media-delete-report-weekly.mjs', import.meta.url), 'utf8');
  const monthly = readFileSync(new URL('./media-faces-hold-monthly.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(weekly + monthly, /unlinkSync|rmSync|renameSync|\.move\(/);
});
