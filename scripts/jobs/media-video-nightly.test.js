import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_INTERVALS_MS } from './health-watcher.mjs';
import { JOB_LABELS } from '../lib/job-labels.mjs';
import { withLock } from '../lib/state-writer.mjs';
import { runVideoNightly, VIDEO_NIGHTLY_BUDGET_MS, VIDEO_NIGHTLY_LIMIT } from './media-video-nightly.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('영상 밤 잡의 plist·디스패치·감시 주기가 일치한다', () => {
  const plist = readFileSync(join(root, 'scripts/launchd/com.banana2.media-video.plist'), 'utf8');
  const runner = readFileSync(join(root, 'scripts/launchd/run.sh'), 'utf8');
  assert.match(plist, /<string>com\.banana2\.media-video<\/string>/);
  assert.match(plist, /<string>media-video<\/string>/);
  assert.match(plist, /<key>Hour<\/key><integer>7<\/integer><key>Minute<\/key><integer>10<\/integer>/);
  assert.match(runner, /media-video\) CMD=\(scripts\/jobs\/media-video-nightly\.mjs\)/);
  assert.match(runner, /usage: run\.sh \{[^\n]*media-video/);
  assert.equal(EXPECTED_INTERVALS_MS['media-video'], 24 * 60 * 60 * 1000);
  assert.match(JOB_LABELS['media-video'], /07:10/);
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
      dryRun: true, output: { log: (line) => lines.push(line) },
    });
    assert.equal(result.notes, null);
    assert.equal(result.analysis.selected, selected);
    assert.match(lines.at(-1), new RegExp(`영상 대상 ${selected}, 실제 분석 0`));
  }
});

test('영상 분석이 실패했어도 시도했다면 오래된 이름표 제거를 위해 노트를 갱신한다', async () => {
  let refreshed = 0;
  const result = await runVideoNightly({
    video: async () => ({ selected: 1, processed: 0, failed: 1, results: [{ id: 'a', faces: { ok: false } }] }),
    refresh: async () => { refreshed += 1; return { changed: 1, failed: 0 }; },
    dryRun: true, output: { log() {} },
  });
  assert.equal(refreshed, 1);
  assert.equal(result.notes.changed, 1);
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
  const options = { facesRoot, vaultRoot, video: never, refresh: never, output: { log() {} } };
  await withLock(shared, async () => {
    assert.equal((await runVideoNightly(options)).skipped, true);
  });
  mkdirSync(facesRoot, { recursive: true });
  await withLock(join(facesRoot, '.media-faces'), async () => {
    assert.equal((await runVideoNightly(options)).skipped, true);
  });
});
