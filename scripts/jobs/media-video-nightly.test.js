import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_INTERVALS_MS } from './health-watcher.mjs';
import { JOB_LABELS } from '../lib/job-labels.mjs';
import { withLock } from '../lib/state-writer.mjs';
import { runVideoNightly, VIDEO_NIGHTLY_BUDGET_MS, VIDEO_NIGHTLY_LIMIT,
  VIDEO_NIGHTLY_TRANSCRIPT_BUDGET_MINUTES, videoMorningDeadline } from './media-video-nightly.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('영상 밤 잡의 plist·디스패치·감시 주기가 일치한다', () => {
  const plist = readFileSync(join(root, 'scripts/launchd/com.banana2.media-video.plist'), 'utf8');
  const runner = readFileSync(join(root, 'scripts/launchd/run.sh'), 'utf8');
  assert.match(plist, /<string>com\.banana2\.media-video<\/string>/);
  assert.match(plist, /<string>media-video<\/string>/);
  assert.match(plist, /<key>Hour<\/key><integer>4<\/integer><key>Minute<\/key><integer>0<\/integer>/);
  assert.match(runner, /media-video\) CMD=\(scripts\/jobs\/media-video-nightly\.mjs\)/);
  assert.match(runner, /usage: run\.sh \{[^\n]*media-video/);
  assert.equal(EXPECTED_INTERVALS_MS['media-video'], 24 * 60 * 60 * 1000);
  assert.match(JOB_LABELS['media-video'], /04:00/);
});

test('영상 제한·시간 예산을 전달하고 분석 뒤에만 순간 이름표를 갱신한다', async () => {
  const calls = [];
  const video = async (options) => {
    calls.push(['video', options]);
    return { selected: 2, processed: 1, failed: 1, results: [{ id: 'a' }, { id: 'b' }] };
  };
  const refresh = async (options) => {
    calls.push(['refresh', options]);
    return { changed: 1, failed: 0 };
  };
  const result = await runVideoNightly({ video, refresh, dryRun: true,
    transcribe: async () => ({ results: [] }),
    highlights: async () => ({ unchanged: 0, failed: 0 }),
    lock: () => { throw new Error('dry-run에서 잠금 사용'); }, output: { log() {} } });
  assert.deepEqual(calls.map(([name]) => name), ['video', 'refresh']);
  assert.equal(calls[0][1].limit, VIDEO_NIGHTLY_LIMIT);
  assert.equal(calls[0][1].budgetMs, VIDEO_NIGHTLY_BUDGET_MS);
  assert.equal(calls[0][1].recheckGallery, false);
  assert.equal(calls[1][1].dryRun, true);
  assert.equal(result.notes.changed, 1);
});

test('새 영상이 없거나 시간 예산으로 첫 영상을 못 다루면 순간 노트를 갱신하지 않는다', async () => {
  for (const selected of [0, 2]) {
    const lines = [];
    const result = await runVideoNightly({
      video: async () => ({ selected, processed: 0, failed: 0, results: [] }),
      refresh: () => { throw new Error('분석 결과 없이 노트 갱신'); },
      transcribe: async () => ({ results: [] }),
      highlights: async () => ({ unchanged: 0, failed: 0 }),
      dryRun: true, output: { log: (line) => lines.push(line) },
    });
    assert.equal(result.notes, null);
    assert.equal(result.analysis.selected, selected);
    assert.ok(lines.some((line) => new RegExp(`영상 대상 ${selected}, 실제 분석 0`).test(line)));
  }
});

test('영상 분석이 실패했어도 시도했다면 오래된 이름표 제거를 위해 노트를 갱신한다', async () => {
  let refreshed = 0;
  const result = await runVideoNightly({
    video: async () => ({ selected: 1, processed: 0, failed: 1, results: [{ id: 'a', faces: { ok: false } }] }),
    refresh: async () => { refreshed += 1; return { changed: 1, failed: 0 }; },
    transcribe: async () => ({ results: [] }),
    highlights: async () => ({ unchanged: 0, failed: 0 }),
    dryRun: true, output: { log() {} },
  });
  assert.equal(refreshed, 1);
  assert.equal(result.notes.changed, 1);
});

test('밤 잡은 분석 직후 새 영상만, 전사 직후에는 증분 전체를 확인한다', async () => {
  const calls = [];
  await runVideoNightly({ dryRun: true,
    video: async () => ({ selected: 2, processed: 1, failed: 1,
      results: [{ id: 'a', faces: { ok: true } }, { id: 'b', faces: { ok: false } }] }),
    highlights: ({ ids, priorityIds, limit, dryRun }) => {
      calls.push({ ids, priorityIds, limit }); assert.equal(dryRun, true); },
    refresh: async () => ({ changed: 0, failed: 0 }),
    transcribe: async () => ({ results: [] }), output: { log() {} } });
  assert.deepEqual(calls, [{ ids: ['a'], priorityIds: undefined, limit: undefined },
    { ids: undefined, priorityIds: [], limit: 50 }]);
});

test('하이라이트 오류가 나도 순간 이름표를 갱신하고 실패를 반환한다', async () => {
  let refreshed = 0;
  const errors = [];
  const result = await runVideoNightly({ dryRun: true,
    video: async () => ({ selected: 1, processed: 1, failed: 0,
      results: [{ id: 'a', faces: { ok: true } }] }),
    highlights: async () => { throw new Error('출력 실패'); },
    refresh: async () => { refreshed += 1; return { changed: 1, failed: 0 }; },
    transcribe: async () => ({ results: [] }),
    output: { log() {}, error: (line) => errors.push(line) } });
  assert.equal(refreshed, 1);
  assert.equal(result.highlights.failed, 1);
  assert.match(errors[0], /하이라이트 실패: 출력 실패/);
});

test('분석·이름표·하이라이트·전사 순서와 전사 후 증분 하이라이트', async () => {
  const calls = [];
  const freshId = '1234567890abcdef';
  const result = await runVideoNightly({ dryRun: true,
    now: () => Date.parse('2026-10-18T04:00:00+09:00'),
    video: async () => { calls.push('analysis'); return { selected: 1, processed: 1, failed: 0,
      results: [{ id: freshId, cues: { ok: true }, faces: { ok: true } }] }; },
    refresh: async () => { calls.push('labels'); return { changed: 1, failed: 0 }; },
    highlights: async ({ ids, priorityIds, limit }) => {
      calls.push(`highlights:${ids?.join(',') ?? 'incremental'}`);
      if (!ids) {
        assert.deepEqual(priorityIds, [freshId]);
        assert.equal(limit, 51);
      }
      return { processed: 1, failed: 0 }; },
    transcribe: async (options) => { calls.push('transcribe');
      assert.deepEqual(options.priorityIds, [freshId]);
      assert.equal(options.newestFirst, true);
      assert.equal(options.maxMinutes, VIDEO_NIGHTLY_TRANSCRIPT_BUDGET_MINUTES);
      assert.equal(options.stopAtMs, videoMorningDeadline(Date.parse('2026-10-18T04:00:00+09:00')));
      return { results: [{ id: freshId }], processed: 1, failed: 0 }; },
    output: { log() {} } });
  assert.deepEqual(calls, ['analysis', 'labels', `highlights:${freshId}`,
    'transcribe', 'highlights:incremental']);
  assert.equal(result.transcriptHighlights.processed, 1);
});

test('04:55 상한은 한국 시간 기준이며 다음 날 dry-run은 다음 회차를 본다', async () => {
  assert.equal(videoMorningDeadline(Date.parse('2026-10-18T04:00:00+09:00')),
    Date.parse('2026-10-18T04:55:00+09:00'));
  let stopAtMs;
  await runVideoNightly({ dryRun: true,
    now: () => Date.parse('2026-10-18T13:30:00+09:00'),
    video: async () => ({ selected: 0, results: [] }),
    highlights: async () => ({ unchanged: 0, failed: 0 }),
    transcribe: async (options) => { stopAtMs = options.stopAtMs; return { estimated: 0,
      results: [] }; }, output: { log() {} } });
  assert.equal(stopAtMs, Date.parse('2026-10-19T04:55:00+09:00'));
});

test('전사가 이미 저장된 다음 회차에도 증분 하이라이트를 재시도한다', async () => {
  let checked = 0;
  const result = await runVideoNightly({ dryRun: true,
    video: async () => ({ selected: 0, results: [] }),
    transcribe: async () => ({ results: [], processed: 0 }),
    highlights: async ({ ids, priorityIds, limit }) => { assert.equal(ids, undefined);
      assert.deepEqual(priorityIds, []);
      assert.equal(limit, 50);
      checked += 1;
      return { selected: 1, processed: 1, failed: 0 }; },
    output: { log() {} } });
  assert.equal(checked, 1);
  assert.equal(result.transcriptHighlights.processed, 1);
});

test('공용 미디어 잠금 또는 얼굴 잠금이 있으면 분석·노트 갱신을 건너뛴다', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'media-video-nightly-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const facesRoot = join(base, 'faces');
  const vaultRoot = join(base, 'vault');
  // 실제 잠금 경로를 쓰도록 import 상수와 같은 상대 경로를 사용한다.
  const { VAULT_REL } = await import('../lib/vault-paths.mjs');
  const shared = join(vaultRoot, VAULT_REL.mediaTranscribeState);
  mkdirSync(dirname(shared), { recursive: true });
  const never = () => { throw new Error('잠금 중 실행됨'); };
  const options = { facesRoot, vaultRoot, mediaRoot: join(base, 'media'),
    video: never, refresh: never, output: { log() {} } };
  await withLock(shared, async () => {
    assert.equal((await runVideoNightly(options)).skipped, true);
  });
  mkdirSync(facesRoot, { recursive: true });
  await withLock(join(facesRoot, '.media-faces'), async () => {
    assert.equal((await runVideoNightly(options)).skipped, true);
  });
  const mediaLock = join(options.mediaRoot, 'Diarize', '.media-diarize');
  mkdirSync(dirname(mediaLock), { recursive: true });
  await withLock(mediaLock, async () => {
    assert.equal((await runVideoNightly(options)).skipped, true);
  });
});
