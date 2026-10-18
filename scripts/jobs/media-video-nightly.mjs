#!/usr/bin/env node
// 매일 07:10, 새 영상 분석·순간 이름표·하이라이트 뒤 말소리 전사를 증분 실행한다.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_DIARIZE_PATHS, MEDIA_FACES_PATHS, VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { withLock } from '../lib/state-writer.mjs';
import { runMediaVideo } from './media-video.mjs';
import { runVideoHighlights } from './media-video-highlights.mjs';
import { runMediaVideoTranscribe } from './media-video-transcribe.mjs';
import { refreshMomentPeople } from './media-moments.mjs';

export const VIDEO_NIGHTLY_LIMIT = 30;
export const VIDEO_NIGHTLY_BUDGET_MS = 40 * 60_000;
export const VIDEO_NIGHTLY_TRANSCRIPT_BUDGET_MINUTES = 45;

export function videoMorningDeadline(nowMs) {
  const localDay = new Date(nowMs + 9 * 60 * 60_000).toISOString().slice(0, 10);
  return Date.parse(`${localDay}T08:30:00+09:00`);
}

export async function runVideoNightly({ video = runMediaVideo, highlights = runVideoHighlights,
  refresh = refreshMomentPeople, transcribe = runMediaVideoTranscribe, now = Date.now,
  lock = withLock, facesRoot = MEDIA_FACES_PATHS.root, vaultRoot = VAULT_PATHS.root,
  mediaRoot = MEDIA_DIARIZE_PATHS.mediaRoot,
  dryRun = false, output = console } = {}) {
  const execute = async () => {
    const analysis = await video({ limit: VIDEO_NIGHTLY_LIMIT,
      budgetMs: VIDEO_NIGHTLY_BUDGET_MS, recheckGallery: false, dryRun, output });
    if (!analysis.results?.length) {
      output.log(`[media-video-nightly] 영상 대상 ${analysis.selected}, 실제 분석 0 — 순간 이름표 갱신 건너뜀`);
      return { analysis, highlights: null, notes: null, skipped: false };
    }
    const highlightIds = analysis.results.filter((row) => row.faces?.ok || row.cues?.ok)
      .map((row) => row.id);
    // 영상 판정은 Media에만 저장된다. 같은 실행에서 순간 노트의 people·201/202를 갱신한다.
    const notes = await refresh({ dryRun, output });
    let highlightResult = null;
    if (highlightIds.length) {
      try { highlightResult = await highlights({ ids: highlightIds, dryRun, output }); }
      catch (error) {
        output.error?.(`[media-video-nightly] 하이라이트 실패: ${error.message}`);
        highlightResult = { failed: 1, error: error.message };
      }
    }
    output.log(`[media-video-nightly] 영상 대상 ${analysis.selected}, 완료 ${analysis.processed}, 실패 ${analysis.failed}; 순간 노트 갱신 ${notes.changed}, 실패 ${notes.failed}`);
    return { analysis, highlights: highlightResult, notes, skipped: false };
  };
  const runTranscription = async (phase) => {
    const priorityIds = phase.analysis?.results?.filter((row) => row.cues?.ok).map((row) => row.id) ?? [];
    const morningDeadline = videoMorningDeadline(now());
    const previewDeadline = dryRun && now() >= morningDeadline
      ? morningDeadline + 24 * 60 * 60_000 : morningDeadline;
    // 공용 미디어 잠금을 놓은 다음 전사 자체 잠금을 획득한다.
    const transcript = await transcribe({ priorityIds, newestFirst: true,
      maxMinutes: VIDEO_NIGHTLY_TRANSCRIPT_BUDGET_MINUTES,
      stopAtMs: previewDeadline,
      ...(dryRun ? { previewStartMs: previewDeadline - 80 * 60_000 } : {}),
      dryRun, output });
    if (dryRun) output.log(`[media-video-nightly] 다음 회차 예상: 새 분석 후보 ${phase.analysis?.selected ?? 0}개(실제 성공 수 미확정), `
      + `현재 소리 캐시 기준 백필 약 ${transcript.estimated ?? 0}개(새 영상 전사 시 감소)`);
    let transcriptHighlights;
    try {
      // 이전 회차에서 전사는 저장됐지만 하이라이트 갱신이 실패했어도 fingerprint로 재시도한다.
      const changedIds = transcript.results?.map((row) => row.id) ?? [];
      transcriptHighlights = await highlights({ priorityIds: changedIds,
        limit: changedIds.length + 50,
        catchupOffset: Math.floor(previewDeadline / 86_400_000) * 50,
        dryRun, output });
    } catch (error) {
      output.error?.(`[media-video-nightly] 전사 후 하이라이트 실패: ${error.message}`);
      transcriptHighlights = { failed: 1, error: error.message };
    }
    return { ...phase, transcript, transcriptHighlights };
  };
  if (dryRun) return runTranscription(await execute());
  mkdirSync(facesRoot, { recursive: true, mode: 0o700 });
  const mediaLock = join(mediaRoot, 'Diarize', '.media-diarize');
  mkdirSync(join(mediaRoot, 'Diarize'), { recursive: true, mode: 0o700 });
  const faceLock = join(facesRoot, '.media-faces');
  const vaultLock = join(vaultRoot, VAULT_REL.mediaTranscribeState);
  try {
    const phase = await lock(mediaLock, () => lock(vaultLock, () =>
      lock(faceLock, execute, { retries: 0 }), { retries: 0 }), { retries: 0 });
    return runTranscription(phase);
  } catch (error) {
    if (![mediaLock, vaultLock, faceLock]
      .some((path) => error.message.startsWith(`락 획득 실패(포기): ${path} `))) throw error;
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
      if (result.analysis?.failed || result.highlights?.failed || result.notes?.failed
        || result.transcript?.failed || result.transcriptHighlights?.failed) process.exitCode = 1;
    } catch (error) {
      console.error(`[media-video-nightly] ${error.stack}`);
      process.exitCode = 1;
    }
  }
}
