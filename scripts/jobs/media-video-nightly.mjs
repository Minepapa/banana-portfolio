#!/usr/bin/env node
// 매일 07:10, 사진 갤러리 갱신 뒤 새 영상의 얼굴·소리 근거를 분석하고 순간 이름표를 반영한다.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_FACES_PATHS, VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { withLock } from '../lib/state-writer.mjs';
import { runMediaVideo } from './media-video.mjs';
import { refreshMomentPeople } from './media-moments.mjs';

export const VIDEO_NIGHTLY_LIMIT = 30;
export const VIDEO_NIGHTLY_BUDGET_MS = 40 * 60_000;

export async function runVideoNightly({ video = runMediaVideo, refresh = refreshMomentPeople,
  lock = withLock, facesRoot = MEDIA_FACES_PATHS.root, vaultRoot = VAULT_PATHS.root,
  dryRun = false, output = console } = {}) {
  const execute = async () => {
    const analysis = await video({ limit: VIDEO_NIGHTLY_LIMIT,
      budgetMs: VIDEO_NIGHTLY_BUDGET_MS, recheckGallery: false, dryRun, output });
    if (!analysis.results?.length) {
      output.log(`[media-video-nightly] 영상 대상 ${analysis.selected}, 실제 분석 0 — 순간 이름표 갱신 건너뜀`);
      return { analysis, notes: null, skipped: false };
    }
    // 영상 판정은 Media에만 저장된다. 같은 실행에서 순간 노트의 people·201/202를 갱신한다.
    const notes = await refresh({ dryRun, output });
    output.log(`[media-video-nightly] 영상 대상 ${analysis.selected}, 완료 ${analysis.processed}, 실패 ${analysis.failed}; 순간 노트 갱신 ${notes.changed}, 실패 ${notes.failed}`);
    return { analysis, notes, skipped: false };
  };
  if (dryRun) return execute();
  mkdirSync(facesRoot, { recursive: true, mode: 0o700 });
  const faceLock = join(facesRoot, '.media-faces');
  const mediaLock = join(vaultRoot, VAULT_REL.mediaTranscribeState);
  try {
    return await lock(mediaLock, () => lock(faceLock, execute, { retries: 0 }), { retries: 0 });
  } catch (error) {
    if (![mediaLock, faceLock].some((path) => error.message.startsWith(`락 획득 실패(포기): ${path} `))) throw error;
    output.log('[media-video-nightly] 다른 미디어 작업 중 — 건너뜀');
    return { analysis: null, notes: null, skipped: true };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--dry-run')) {
    console.error('usage: node scripts/jobs/media-video-nightly.mjs [--dry-run]');
    process.exitCode = 2;
  } else {
    try {
      const result = await runVideoNightly({ dryRun: args.includes('--dry-run') });
      if (result.analysis?.failed || result.notes?.failed) process.exitCode = 1;
    } catch (error) {
      console.error(`[media-video-nightly] ${error.stack}`);
      process.exitCode = 1;
    }
  }
}
