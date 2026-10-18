#!/usr/bin/env node
// 영상 말소리 전사와 화자 판정. Vault와 영상 원본은 읽기만 하고 결과는 Media에만 둔다.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AUDIO_CUES_PATHS } from '../lib/media-audio-cues.mjs';
import { safeVideoPath } from '../lib/media-video-frames.mjs';
import { MEDIA_DIARIZE_PATHS, VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { withLock } from '../lib/state-writer.mjs';
import { assignRecordingNames, readNpy, runPython } from './media-diarize.mjs';
import { detectRepetition, transcribe } from './media-transcribe.mjs';
import { savePrivate, selectVideos } from './media-video.mjs';

const exec = promisify(execFile);
const ID = /^[a-f0-9]{16}$/i;
export const VIDEO_SPEECH_THRESHOLD = 0.3; // media-audio-cues.summarizeCues와 같은 문턱
export const VIDEO_TRANSCRIPT_VERSION = 1;
export const VIDEO_TRANSCRIPT_PATHS = Object.freeze({
  root: join(homedir(), 'Pantheon', 'Media', 'VideoTranscripts'),
  model: join(homedir(), 'Pantheon', 'Models', 'whisper', 'ggml-large-v3.bin'),
});
const QUIET = /^(?:시청해주셔서감사합니다|구독과좋아요(?:부탁드립니다)?|자막제공|영상편집|감사합니다|thanksforwatching|subtitlesby|music)$/iu;

function readRows(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
}

function transcriptPath(root, record) {
  const year = String(record.occurred || '').slice(0, 4);
  if (!/^\d{4}$/.test(year) || !ID.test(record.id)) throw new Error('영상 ID 또는 연도 오류');
  return join(root, year, `${record.id}.json`);
}

export function speechIntervals(cue) {
  const windows = (cue?.windows || []).filter((window) =>
    Number(window.tags?.speech) >= VIDEO_SPEECH_THRESHOLD
    && Number.isFinite(window.start) && Number.isFinite(window.end) && window.end > window.start);
  const merged = [];
  for (const window of windows.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else merged.push({ start: window.start, end: window.end });
  }
  return merged;
}

export function filterVideoSegments(segments, intervals) {
  if (detectRepetition(segments.map((segment) => segment.text).join(' ')).looped) return [];
  return segments.filter((segment) => {
    const text = String(segment.text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
    if (!text || QUIET.test(text) || detectRepetition(segment.text).looped) return false;
    return Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start
      && intervals.some((part) => Math.min(segment.end, part.end * 1000)
        - Math.max(segment.start, part.start * 1000) >= Math.min(500, (segment.end - segment.start) * 0.3));
  });
}

export function selectVideoTranscriptTargets(records, { cacheDir, outputRoot, mediaRoot,
  ids = null, limit = Infinity, failures = {}, model = VIDEO_TRANSCRIPT_PATHS.model,
  sourceStat = statSync } = {}) {
  const selected = [];
  let durationSec = 0;
  for (const record of selectVideos(records, { ids, limit: Infinity })) {
    const cachePath = join(cacheDir, `${record.id}.json`);
    if (!existsSync(cachePath)) continue;
    let cue;
    let source;
    try {
      cue = JSON.parse(readFileSync(cachePath, 'utf8'));
      source = sourceStat(safeVideoPath(mediaRoot, record));
      if (cue.version !== 2 || cue.error || cue.budgetLimited
        || cue.size !== source.size || cue.mtimeMs !== Math.round(source.mtimeMs)
        || !speechIntervals(cue).length) continue;
      const path = transcriptPath(outputRoot, record);
      if (!ids && existsSync(path)) {
        const saved = JSON.parse(readFileSync(path, 'utf8'));
        if (saved.version === VIDEO_TRANSCRIPT_VERSION && saved.sourceSize === source.size
          && saved.sourceMtimeMs === Math.round(source.mtimeMs)
          && saved.model === model) continue;
      }
      if (!ids && (failures[record.id]?.length || 0) >= 3) continue;
      const seconds = Number(cue.durationSec);
      if (!Number.isFinite(seconds) || seconds <= 0) continue;
      selected.push({ record, cue, path, source, durationSec: seconds });
      durationSec += seconds;
      if (selected.length >= limit) break;
    } catch { /* 원본·캐시가 깨졌으면 다른 영상을 계속 고른다. */ }
  }
  return { selected, durationSec };
}

export function loadVideoVoiceReferences(paths = MEDIA_DIARIZE_PATHS) {
  const references = {};
  if (existsSync(paths.ownerVoice) && existsSync(paths.ownerMeta)) {
    const meta = JSON.parse(readFileSync(paths.ownerMeta, 'utf8'));
    references.나 = { mean: readNpy(paths.ownerVoice)[0], minSimilarity: meta.minSimilarity ?? 0.2 };
  }
  for (const [name, voicePath, metaPath] of [
    ['휘영', paths.personVoice, paths.personMeta], ['미네', paths.mineVoice, paths.mineMeta],
  ]) {
    if (!voicePath || !metaPath || !existsSync(voicePath) || !existsSync(metaPath)) continue;
    const vectors = readNpy(voicePath);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    references[name] = { mean: vectors[0], minSimilarity: meta.minSimilarity,
      ...(name === '미네' ? { vectors, period: meta.period, years: meta.years } : {}) };
  }
  return references;
}

export function nameVideoSegments(segments, turns, voices, references, occurred) {
  if (!voices.length || voices.length > 3) throw new Error('화자 수 오류');
  const short = segments.at(-1).end - segments[0].start < 15_000;
  const counts = voices.map((_, index) => turns.filter((turn) => turn.speaker === `S${index}`)
    .reduce((sum, turn) => sum + turn.end - turn.start, 0));
  const dominant = counts.indexOf(Math.max(...counts));
  const activeVoices = short ? [voices[dominant]] : voices;
  const activeTurns = short ? turns.filter((turn) => turn.speaker === `S${dominant}`)
    .map((turn) => ({ ...turn, speaker: 'S0' })) : turns;
  const { labels, evidence, similarities } = assignRecordingNames(activeVoices, [], references,
    activeTurns, occurred);
  const named = segments.map((segment) => {
    const overlaps = activeVoices.map((_, index) => activeTurns.filter((turn) => turn.speaker === `S${index}`)
      .reduce((sum, turn) => sum + Math.max(0, Math.min(segment.end, turn.end)
        - Math.max(segment.start, turn.start)), 0));
    const speaker = `S${overlaps.indexOf(Math.max(...overlaps))}`;
    const uncertain = overlaps[Number(speaker.slice(1))] < (segment.end - segment.start) * 0.5;
    return { ...segment, speaker: uncertain ? null : speaker,
      name: uncertain ? null : labels[speaker], uncertain };
  });
  return { segments: named, speakers: { turns: activeTurns, labels, evidence, similarities,
    engine: 'pyannote', model: 'pyannote/speaker-diarization-community-1' } };
}

export async function runMediaVideoTranscribe({ root = VAULT_PATHS.root,
  mediaRoot = MEDIA_DIARIZE_PATHS.mediaRoot, cacheDir = AUDIO_CUES_PATHS.cacheDir,
  outputRoot = VIDEO_TRANSCRIPT_PATHS.root, paths = MEDIA_DIARIZE_PATHS,
  model = VIDEO_TRANSCRIPT_PATHS.model, ids = null, limit = Infinity, maxMinutes = 50,
  dryRun = false, output = console, clock = () => Date.now(), temporaryRoot = tmpdir(),
  transcribeFn = transcribe, diarizeFn = runPython, execute = exec,
  voiceLoader = readNpy, referencesLoader = loadVideoVoiceReferences, lock = withLock } = {}) {
  if (!Number.isSafeInteger(limit) && limit !== Infinity || limit < 1
    || !Number.isFinite(maxMinutes) || maxMinutes <= 0 || ids?.some((id) => !ID.test(id))) {
    throw new Error('media-video-transcribe 옵션 오류');
  }
  const rows = [...readRows(join(root, VAULT_REL.mediaArchiveIndex)),
    ...readRows(join(root, VAULT_REL.mediaImportsIndex))]
    .map((record) => ({ ...record, occurred: record.occurred || record.capturedAt }));
  const statePath = join(outputRoot, 'state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { failures: {} };
  state.failures ||= {};
  const { selected, durationSec } = selectVideoTranscriptTargets(rows, { cacheDir, outputRoot,
    mediaRoot, ids, limit, model, failures: state.failures });
  const summary = { selected: selected.length, durationSec, processed: 0, silent: 0, failed: 0,
    elapsedMs: 0, results: [], busy: false };
  if (dryRun) {
    output.log(`[media-video-transcribe] dry-run 대상 ${selected.length}, 총 ${(durationSec / 3600).toFixed(2)}시간`);
    return summary;
  }
  if (!selected.length) return summary;
  const commonLock = join(root, VAULT_REL.mediaTranscribeState) + '.lock';
  if (existsSync(commonLock)) return { ...summary, busy: true };
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const started = clock();
  const deadline = started + maxMinutes * 60_000;
  const run = async () => {
    const references = referencesLoader(paths);
    for (const item of selected) {
      if (clock() - started >= maxMinutes * 60_000 || existsSync(commonLock)) break;
      if (!ids && existsSync(item.path)) {
        const saved = JSON.parse(readFileSync(item.path, 'utf8'));
        if (saved.version === VIDEO_TRANSCRIPT_VERSION && saved.model === model
          && saved.sourceSize === item.source.size
          && saved.sourceMtimeMs === Math.round(item.source.mtimeMs)) continue;
      }
      const temporary = await fs.mkdtemp(join(temporaryRoot, 'media-video-transcribe-'));
      try {
        const video = safeVideoPath(mediaRoot, item.record);
        const source = statSync(video);
        if (source.size !== item.source.size || Math.round(source.mtimeMs) !== Math.round(item.source.mtimeMs))
          throw new Error('원본 변경');
        // 이 Mac의 whisper.cpp 1.9.5 Metal 초기화가 GGML_ASSERT(buffer)로 중단되어 CPU로 실행한다.
        const decoded = await transcribeFn({ ...item.record, path: video }, {
          ffmpegPath: '/opt/homebrew/bin/ffmpeg', ffprobePath: '/opt/homebrew/bin/ffprobe',
          whisperPath: '/opt/homebrew/bin/whisper-cli', model, temporaryRoot, now: new Date().toISOString(),
          language: 'auto', noGpu: true, timeoutMs: Math.max(1, deadline - clock()), output });
        const segments = filterVideoSegments(decoded.segments, speechIntervals(item.cue));
        let named = segments;
        let speakers = null;
        if (segments.length) {
          const wav = join(temporary, `${item.record.id}.wav`);
          await execute('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', video,
            '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
          { timeout: Math.max(1, Math.min(300_000, deadline - clock())) });
          const [row] = await diarizeFn('pyannote', [{ id: item.record.id, wav }],
            { voicesDir: paths.voices, lowPriority: true, recordings: true,
              signal: AbortSignal.timeout(Math.max(1, deadline - clock())) });
          if (/expected 1\.\.3 speakers with embeddings, found 0/.test(row?.error || '')) {
            named = segments.map((segment) => ({ ...segment, speaker: null, name: null, uncertain: true }));
            speakers = { turns: [], labels: {}, evidence: {}, engine: 'pyannote',
              model: 'pyannote/speaker-diarization-community-1', reason: '목소리 특징값 없음' };
          } else {
            if (!row || row.error || !Array.isArray(row.turns)) throw new Error(row?.error || '화자 결과 없음');
            const voicePath = join(paths.voices, 'pyannote-rec', `${item.record.id}.npy`);
            const voices = voiceLoader(voicePath);
            if (voices.length !== new Set(row.turns.map((turn) => turn.speaker)).size) throw new Error('화자 특징값 오류');
            if (voices.some((voice) => !voice.length || voice.some((value) => !Number.isFinite(value))
              || !voice.some((value) => value !== 0))) {
              await fs.rm(voicePath, { force: true });
              named = segments.map((segment) => ({ ...segment, speaker: null, name: null, uncertain: true }));
              speakers = { turns: row.turns, labels: {}, evidence: {}, engine: 'pyannote',
                model: 'pyannote/speaker-diarization-community-1', reason: '목소리 특징값 오류' };
            } else {
              ({ segments: named, speakers } = nameVideoSegments(segments, row.turns, voices,
                references, item.record.occurred));
            }
          }
        }
        const result = { version: VIDEO_TRANSCRIPT_VERSION, id: item.record.id, kind: 'Video',
          occurred: item.record.occurred, durationSec: decoded.durationSec,
          sourceSize: source.size, sourceMtimeMs: Math.round(source.mtimeMs),
          speech: Boolean(named.length), text: named.map((part) => part.text).join(' '),
          segments: named, speakers, model, modelVersion: basename(model), language: 'auto',
          detectedLanguage: decoded.detectedLanguage || null,
          ...(decoded.languageFallback ? { languageFallback: decoded.languageFallback } : {}),
          transcribedAt: new Date().toISOString() };
        mkdirSync(join(outputRoot, String(item.record.occurred).slice(0, 4)),
          { recursive: true, mode: 0o700 });
        savePrivate(item.path, `${JSON.stringify(result, null, 2)}\n`);
        delete state.failures[item.record.id];
        summary.processed += 1;
        if (!result.speech) summary.silent += 1;
        summary.results.push({ id: item.record.id, durationSec: item.durationSec, speech: result.speech,
          names: [...new Set(named.map((part) => part.name))] });
      } catch (error) {
        state.failures[item.record.id] ||= [];
        state.failures[item.record.id].push({ at: new Date().toISOString(), message: error.message });
        summary.failed += 1;
        output.error?.(`[media-video-transcribe] ${item.record.id}: ${error.message}`);
      } finally {
        await fs.rm(temporary, { recursive: true, force: true });
        savePrivate(statePath, `${JSON.stringify(state, null, 2)}\n`);
      }
    }
    summary.elapsedMs = clock() - started;
    output.log(`[media-video-transcribe] 완료 ${summary.processed}, 무음 ${summary.silent}, 실패 ${summary.failed}`);
    return summary;
  };
  try { return await lock(join(paths.root, '.media-diarize'), run, { retries: 0 }); }
  catch (error) {
    if (error.message.startsWith('락 획득 실패')) return { ...summary, busy: true };
    throw error;
  }
}

export function parseVideoTranscriptArgs(args) {
  const options = { dryRun: false, ids: null, limit: Infinity, maxMinutes: 50 };
  for (const arg of args) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--ids=')) options.ids = arg.slice(6).split(',');
    else if (/^--limit=\d+$/.test(arg)) options.limit = Number(arg.slice(8));
    else if (/^--max-minutes=\d+(?:\.\d+)?$/.test(arg)) options.maxMinutes = Number(arg.slice(14));
    else throw new Error(`media-video-transcribe 옵션 오류: ${arg}`);
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await runMediaVideoTranscribe(parseVideoTranscriptArgs(process.argv.slice(2)));
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    console.error(`[media-video-transcribe] ${error.stack}`);
    process.exitCode = 1;
  }
}
