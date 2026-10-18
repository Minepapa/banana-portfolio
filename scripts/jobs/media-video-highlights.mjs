#!/usr/bin/env node
// 얼굴·소리 캐시를 읽어 볼트 밖 결과와 폰 검토용 단일 HTML을 갱신한다.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_FACES_PATHS } from '../lib/vault-paths.mjs';
import { AUDIO_CUES_PATHS } from '../lib/media-audio-cues.mjs';
import { VIDEO_FRAME_ROOT } from '../lib/media-video-frames.mjs';
import { videoHighlights } from '../lib/media-video-highlights.mjs';
import { applyVideoHoldAnswers, loadVideoHoldAnswers } from '../lib/video-hold-answers.mjs';
import { VIDEO_TRANSCRIPT_PATHS, VIDEO_TRANSCRIPT_VERSION } from './media-video-transcribe.mjs';

const OUTPUT_ROOT = join(homedir(), 'Pantheon', 'Media', 'VideoAnalysis');
export const HIGHLIGHT_PATHS = Object.freeze({
  matches: join(MEDIA_FACES_PATHS.root, 'video-matches.jsonl'),
  cues: AUDIO_CUES_PATHS.cacheDir,
  frames: VIDEO_FRAME_ROOT,
  status: join(OUTPUT_ROOT, 'status.json'),
  highlights: join(OUTPUT_ROOT, 'highlights.jsonl'),
  review: join(OUTPUT_ROOT, 'highlights-review.html'),
  transcripts: VIDEO_TRANSCRIPT_PATHS.root,
});
const ALGORITHM_VERSION = 1;

function lines(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
}

export function parseHighlightArgs(args) {
  const options = { ids: null, limit: Infinity, dryRun: false };
  for (const arg of args) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (/^--limit=\d+$/.test(arg)) options.limit = Number(arg.slice(8));
    else if (arg.startsWith('--ids=')) options.ids = arg.slice(6).split(',');
    else throw new Error(`media-video-highlights 옵션 오류: ${arg}`);
  }
  if (options.limit < 1 || !Number.isSafeInteger(options.limit) && options.limit !== Infinity
    || options.ids?.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))) {
    throw new Error('media-video-highlights 옵션 오류');
  }
  return options;
}

function savePrivate(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) { rmSync(temporary, { force: true }); throw error; }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function thumbnail(id, second, frameRoot) {
  const manifestPath = join(frameRoot, id, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.id !== id || !Array.isArray(manifest.frames)) return null;
    const frame = [...manifest.frames].filter((item) => Number.isFinite(item.second))
      .sort((left, right) => Math.abs(left.second - second) - Math.abs(right.second - second))[0];
    // manifest의 path는 캐시가 작성한 경로와 같을 때만 읽는다.
    const expected = frame && join(frameRoot, id, `${frame.second}.jpg`);
    if (!frame || frame.path !== expected || !existsSync(expected)) return null;
    return `data:image/jpeg;base64,${readFileSync(expected).toString('base64')}`;
  } catch { return null; }
}

export function renderHighlightsReview(rows, { frameRoot = HIGHLIGHT_PATHS.frames,
  random = Math.random } = {}) {
  const sample = [...rows];
  for (let index = sample.length - 1; index > 0; index -= 1) {
    const picked = Math.floor(random() * (index + 1));
    [sample[index], sample[picked]] = [sample[picked], sample[index]];
  }
  const cards = sample.slice(0, 20).map((row) => {
    const parts = row.highlights.map((part) => {
      const image = thumbnail(row.id, (part.startSec + part.endSec) / 2, frameRoot);
      return `<li>${image ? `<img src="${image}" alt="대표 장면">` : '<span>썸네일 없음</span>'}`
        + `<div><strong>${escapeHtml(part.startSec)}–${escapeHtml(part.endSec)}초</strong>`
        + `<p>${escapeHtml(part.evidence.join(' · '))}</p><small>점수 ${escapeHtml(part.score)}</small></div></li>`;
    }).join('');
    return `<section><h2>${escapeHtml(row.id)}</h2><ol>${parts}</ol></section>`;
  }).join('');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>영상 하이라이트 검토</title><style>body{font:16px system-ui;background:#f8f6f2;color:#262421;max-width:760px;margin:auto;padding:18px}section{background:white;border-radius:16px;padding:14px;margin:16px 0;box-shadow:0 2px 12px #0001}h1{font-size:1.6rem}h2{font-size:1rem;overflow-wrap:anywhere}ol{padding:0;list-style:none}li{display:flex;gap:12px;border-top:1px solid #eee;padding:12px 0}img{width:120px;height:90px;object-fit:cover;border-radius:8px}p{margin:5px 0}small{color:#666}</style><h1>영상 하이라이트 20개 검토</h1><p>시각은 원본 영상 시작 기준입니다.</p>${cards}</html>`;
}

export function runVideoHighlights({ ids = null, limit = Infinity, dryRun = false,
  priorityIds = [], catchupOffset = 0,
  paths = HIGHLIGHT_PATHS, sheetsPath = MEDIA_FACES_PATHS.sheets,
  output = console, random = Math.random } = {}) {
  if (!Number.isSafeInteger(catchupOffset) || catchupOffset < 0) {
    throw new Error('media-video-highlights catchupOffset 오류');
  }
  const previous = new Map(lines(paths.highlights).map((row) => [row.id, row]));
  const requested = ids ? new Set(ids) : null;
  const status = paths.status && existsSync(paths.status)
    ? JSON.parse(readFileSync(paths.status, 'utf8')) : {};
  const answers = loadVideoHoldAnswers(sheetsPath, output);
  const byId = new Map(lines(paths.matches).filter((row) => /^[A-Za-z0-9_-]+$/.test(row.id))
    .map((row) => [row.id, applyVideoHoldAnswers(row, answers)]));
  for (const [id, state] of Object.entries(status)) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
    const stages = state?.stages ?? {};
    if (stages.faces?.ok === false && byId.has(id)) {
      const prior = byId.get(id);
      byId.set(id, { id, original: state.path ?? prior.original,
        durationSec: stages.cues?.videoDurationSec ?? prior.durationSec,
        sourceSize: stages.cues?.sourceSize ?? prior.sourceSize,
        sourceMtimeMs: stages.cues?.sourceMtimeMs ?? prior.sourceMtimeMs });
    }
    if (stages.cues?.ok && !byId.has(id)) {
      // 얼굴 단계가 실패한 영상에는 이전 회차의 이름표를 재사용하지 않는다.
      byId.set(id, { id, original: state.path,
        durationSec: stages.cues.videoDurationSec ?? stages.frames?.durationSec,
        sourceSize: stages.cues.sourceSize, sourceMtimeMs: stages.cues.sourceMtimeMs });
    }
  }
  const priority = new Set(priorityIds);
  const matches = [...byId.values()].filter((row) => !requested || requested.has(row.id));
  const preferred = matches.filter((row) => priority.has(row.id));
  const catchup = matches.filter((row) => !priority.has(row.id));
  const offset = catchup.length ? catchupOffset % catchup.length : 0;
  matches.splice(0, matches.length, ...preferred,
    ...catchup.slice(offset), ...catchup.slice(0, offset));
  const transcriptYears = paths.transcripts && existsSync(paths.transcripts)
    ? readdirSync(paths.transcripts).filter((name) => /^\d{4}$/.test(name)) : [];
  const selected = [];
  let unchanged = 0;
  for (const match of matches) {
    if (!Number.isFinite(match.durationSec) || match.durationSec <= 0) continue;
    const cuePath = join(paths.cues, `${match.id}.json`);
    let cues = null;
    if (existsSync(cuePath)) {
      try { cues = JSON.parse(readFileSync(cuePath, 'utf8')); } catch { /* 깨진 캐시는 없는 근거로 취급 */ }
    }
    if (cues && Number.isFinite(cues.size) && Number.isFinite(cues.mtimeMs)
      && (cues.size !== match.sourceSize || cues.mtimeMs !== match.sourceMtimeMs)) cues = null;
    let transcript = null;
    if (paths.transcripts && /^[a-f0-9]{16}$/i.test(match.id)) {
      for (const candidateYear of transcriptYears) {
        const path = join(paths.transcripts, candidateYear, `${match.id}.json`);
        if (!existsSync(path)) continue;
        try {
          const saved = JSON.parse(readFileSync(path, 'utf8'));
          if (saved.id === match.id && saved.version === VIDEO_TRANSCRIPT_VERSION
            && saved.sourceSize === match.sourceSize && saved.sourceMtimeMs === match.sourceMtimeMs) {
            transcript = saved;
          }
        } catch { /* 깨진 전사 결과는 무시한다. */ }
        break;
      }
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ version: ALGORITHM_VERSION,
      match, cues, transcript })).digest('hex');
    if (previous.get(match.id)?.fingerprint === fingerprint) { unchanged += 1; continue; }
    selected.push({ match, cues, transcript, fingerprint });
    if (selected.length >= limit) break;
  }
  if (dryRun) {
    output.log(`[media-video-highlights] dry-run 변경 ${selected.length}, 유지 ${unchanged}; 쓰기 없음`);
    return { selected: selected.length, processed: 0, unchanged, failed: 0 };
  }
  let processed = 0;
  let failed = 0;
  for (const { match, cues, transcript, fingerprint } of selected) {
    try {
      const transcripts = transcript?.segments?.map((segment) => ({
        start: segment.start / 1000, end: segment.end / 1000, text: segment.text })) ?? [];
      const mineVoice = transcript?.segments?.filter((segment) => segment.name === '미네')
        .map((segment) => ({ start: segment.start / 1000, end: segment.end / 1000 })) ?? [];
      previous.set(match.id, { id: match.id, original: match.original,
        durationSec: match.durationSec, fingerprint,
        highlights: videoHighlights(match, cues, { transcripts, mineVoice }) });
      processed += 1;
    } catch (error) {
      failed += 1;
      output.error?.(`[media-video-highlights] ${match.id}: ${error.message}`);
    }
  }
  if (processed) {
    const rows = [...previous.values()].sort((left, right) => left.id.localeCompare(right.id));
    savePrivate(paths.review, renderHighlightsReview(rows, { frameRoot: paths.frames, random }));
    // 검토 HTML이 실패하면 JSONL의 fingerprint를 앞당기지 않아 다음 실행에서 재시도한다.
    savePrivate(paths.highlights, `${rows.map(JSON.stringify).join('\n')}\n`);
  }
  output.log(`[media-video-highlights] 변경 ${processed}, 유지 ${unchanged}, 실패 ${failed}`);
  return { selected: selected.length, processed, unchanged, failed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = runVideoHighlights(parseHighlightArgs(process.argv.slice(2)));
    if (result.failed) process.exitCode = 1;
  } catch (error) { console.error(`[media-video-highlights] ${error.message}`); process.exitCode = 1; }
}
