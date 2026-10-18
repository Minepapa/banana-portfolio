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
import { assignRecordingNames, createPythonSession, readNpy, runPython } from './media-diarize.mjs';
import { detectRepetition, transcribe } from './media-transcribe.mjs';
import { savePrivate, selectVideos } from './media-video.mjs';

const exec = promisify(execFile);
const ID = /^[a-f0-9]{16}$/i;
export const VIDEO_SPEECH_THRESHOLD = 0.3; // media-audio-cues.summarizeCues와 같은 문턱
export const VIDEO_TRANSCRIPT_VERSION = 2;
export const VIDEO_TRANSCRIPT_SESSION_ITEMS = 25;
export const VIDEO_TRANSCRIPT_HIGHLIGHT_RESERVE_MS = 5 * 60_000;
export const VIDEO_TRANSCRIPT_ESTIMATE_RATIO = 0.8;
export const VIDEO_TRANSCRIPT_PATHS = Object.freeze({
  root: join(homedir(), 'Pantheon', 'Media', 'VideoTranscripts'),
  model: join(homedir(), 'Pantheon', 'Models', 'whisper', 'ggml-large-v3.bin'),
});
export const VIDEO_HALLUCINATION_PHRASES = Object.freeze([
  '미리보기', '자막', '시청해주셔서감사', '구독과좋아요', '영상편집',
  'thanksforwatching', 'subtitlesby', 'sampaijumpadivideoselanjutnya',
  'terimakasihtelahmenonton', 'terimakasih', 'menonton',
]);
// 가족 영상은 한국어가 대부분이다. 언어 자동 감지는 아이가 부르는 한국어 동요(깡총깡총)를 영어·말레이어로
// 잘못 알아들어 'Kampung Kampung' 같은 글을 만들었다(2026-10-18 실측). 한국어로 먼저 전사한다.
export const VIDEO_LANGUAGE = 'ko';
const normalizeText = (text) => String(text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

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
    && Number(window.tags?.singing || 0) < 0.3
    && Number(window.tags?.speech) >= Number(window.tags?.singing || 0) * 1.5
    && Number.isFinite(window.start) && Number.isFinite(window.end) && window.end > window.start);
  const merged = [];
  for (const window of windows.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else merged.push({ start: window.start, end: window.end });
  }
  return merged;
}

export function speechAudioPlan(intervals) {
  let cursorMs = 0;
  return intervals.map((part) => {
    const span = { sourceStart: part.start, sourceEnd: part.end,
      audioStartMs: cursorMs, audioEndMs: cursorMs + Math.round((part.end - part.start) * 1000) };
    cursorMs = span.audioEndMs;
    return span;
  });
}

export function restoreSourceTime(segments, plan) {
  return segments.flatMap((segment) => {
    const matches = plan.map((part) => ({ part,
      overlap: Math.max(0, Math.min(segment.end, part.audioEndMs)
        - Math.max(segment.start, part.audioStartMs)) }));
    const best = matches.sort((a, b) => b.overlap - a.overlap)[0];
    if (!best?.overlap) return [];
    const { part } = best;
    return [{ ...segment,
      start: Math.round(part.sourceStart * 1000 + Math.max(0, segment.start - part.audioStartMs)),
      end: Math.round(part.sourceStart * 1000 + Math.min(part.audioEndMs - part.audioStartMs,
        segment.end - part.audioStartMs)) }];
  }).filter((segment) => segment.end > segment.start);
}

function repeatsThreeTimes(text) {
  const normalized = normalizeText(text);
  for (let length = 2; length <= Math.min(60, Math.floor(normalized.length / 3)); length += 1) {
    for (let start = 0; start + length * 3 <= normalized.length; start += 1) {
      const phrase = normalized.slice(start, start + length);
      if (normalized.slice(start + length, start + length * 2) === phrase
        && normalized.slice(start + length * 2, start + length * 3) === phrase) return true;
    }
  }
  return detectRepetition(text).looped;
}

export function reviewVideoSegments(segments, intervals) {
  const kept = [];
  const dropped = [];
  const normalizedTexts = segments.map((segment) => normalizeText(segment.text));
  const repeated = new Set();
  for (let index = 0; index < segments.length;) {
    let end = index + 1;
    while (end < segments.length && normalizedTexts[end] === normalizedTexts[index]) end += 1;
    if (normalizedTexts[index] && end - index >= 3) {
      for (let repeatedIndex = index; repeatedIndex < end; repeatedIndex += 1) repeated.add(repeatedIndex);
    }
    index = end;
  }
  for (const [index, segment] of segments.entries()) {
    const normalized = normalizeText(segment.text);
    const overlap = intervals.reduce((sum, part) => sum + Math.max(0,
      Math.min(segment.end, part.end * 1000) - Math.max(segment.start, part.start * 1000)), 0);
    let reason = null;
    if (!normalized || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
      || segment.end <= segment.start) reason = 'invalid';
    else if (VIDEO_HALLUCINATION_PHRASES.some((phrase) => normalized.includes(phrase))) reason = 'known-hallucination';
    else if (repeatsThreeTimes(segment.text) || repeated.has(index)) reason = 'repetition';
    else if (Number(segment.noSpeechProb) >= 0.6) reason = 'no-speech-probability';
    else if (segment.tokenConfidence !== null && Number.isFinite(segment.tokenConfidence)
      && segment.tokenConfidence < 0.15) reason = 'low-token-confidence';
    else if (overlap < Math.min(500, (segment.end - segment.start) * 0.3)) reason = 'low-speech-score';
    if (reason) dropped.push({ start: segment.start, end: segment.end, text: segment.text, reason });
    else kept.push(segment);
  }
  return { kept, dropped };
}

export function filterVideoSegments(segments, intervals) {
  return reviewVideoSegments(segments, intervals).kept;
}

export function selectVideoTranscriptTargets(records, { cacheDir, outputRoot, mediaRoot,
  ids = null, priorityIds = [], newestFirst = false, limit = Infinity, failures = {}, model = VIDEO_TRANSCRIPT_PATHS.model,
  sourceStat = statSync } = {}) {
  const selected = [];
  let durationSec = 0;
  const priority = new Set(priorityIds);
  const candidates = selectVideos(records, { ids, limit: Infinity });
  if (newestFirst) candidates.sort((left, right) =>
    Number(priority.has(right.id)) - Number(priority.has(left.id))
    || Date.parse(right.occurred || right.capturedAt) - Date.parse(left.occurred || left.capturedAt)
    || left.id.localeCompare(right.id));
  for (const record of candidates) {
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
  // 미네 혼자 녹음으로 만든 연도별 기준(scripts/tools/media-mine-voice-rec.mjs, 2017~)이 있으면 합친다.
  // 영상 소리는 전화보다 녹음에 가깝고 어린 시절 영상이 많다(통화 기준은 2024~2026만). 같은 해는 녹음 기준을 쓴다.
  const recVoice = paths.mineVoice?.replace(/\.npy$/, '-rec.npy');
  const recMeta = paths.mineMeta?.replace(/\.json$/, '-rec.json');
  if (recVoice && recMeta && existsSync(recVoice) && existsSync(recMeta)) {
    references.미네 = mergeMineReferences(references.미네, readNpy(recVoice), JSON.parse(readFileSync(recMeta, 'utf8')));
  }
  return references;
}

export function mergeMineReferences(calls, recVectors, recMeta) {
  const vectors = [...recVectors];
  const years = recMeta.years.map((entry) => ({ ...entry }));
  const recYears = new Set(years.map((entry) => entry.year));
  for (const entry of calls?.years ?? []) {
    if (recYears.has(entry.year) || !calls.vectors?.[entry.index]) continue;
    vectors.push(calls.vectors[entry.index]);
    years.push({ ...entry, index: vectors.length - 1 });
  }
  const firsts = [recMeta.period?.first, calls?.period?.first].filter(Boolean).sort();
  const lasts = [recMeta.period?.last, calls?.period?.last].filter(Boolean).sort();
  return { mean: vectors[0], vectors, years, period: { first: firsts[0], last: lasts.at(-1) },
    minSimilarity: recMeta.minSimilarity ?? calls?.minSimilarity };
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
  model = VIDEO_TRANSCRIPT_PATHS.model, ids = null, priorityIds = [], newestFirst = false,
  limit = Infinity, maxMinutes = 50, stopAtMs = Infinity, previewStartMs = null,
  dryRun = false, output = console, clock = () => Date.now(), temporaryRoot = tmpdir(),
  transcribeFn = transcribe, diarizeFn = runPython, execute = exec,
  voiceLoader = readNpy, referencesLoader = loadVideoVoiceReferences, lock = withLock,
  sessionFactory = createPythonSession } = {}) {
  if (!Number.isSafeInteger(limit) && limit !== Infinity || limit < 1
    || !Number.isFinite(maxMinutes) || maxMinutes <= 0 || ids?.some((id) => !ID.test(id))
    || priorityIds.some((id) => !ID.test(id)) || !(stopAtMs === Infinity || Number.isFinite(stopAtMs))
    || previewStartMs !== null && !Number.isFinite(previewStartMs)) {
    throw new Error('media-video-transcribe 옵션 오류');
  }
  const rows = [...readRows(join(root, VAULT_REL.mediaArchiveIndex)),
    ...readRows(join(root, VAULT_REL.mediaImportsIndex))]
    .map((record) => ({ ...record, occurred: record.occurred || record.capturedAt }));
  const statePath = join(outputRoot, 'state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { failures: {} };
  state.failures ||= {};
  const { selected, durationSec } = selectVideoTranscriptTargets(rows, { cacheDir, outputRoot,
    mediaRoot, ids, priorityIds, newestFirst, limit, model, failures: state.failures });
  const summary = { selected: selected.length, durationSec, processed: 0, silent: 0, failed: 0,
    elapsedMs: 0, results: [], busy: false, morningDeferred: 0 };
  if (dryRun) {
    let estimated = 0;
    let estimatedMs = 0;
    const previewStarted = previewStartMs ?? clock();
    for (const item of selected) {
      const itemEstimateMs = item.durationSec * VIDEO_TRANSCRIPT_ESTIMATE_RATIO * 1000;
      if (estimatedMs >= maxMinutes * 60_000 || previewStarted + estimatedMs >= stopAtMs) break;
      if (stopAtMs !== Infinity && previewStarted + estimatedMs + itemEstimateMs
        + VIDEO_TRANSCRIPT_HIGHLIGHT_RESERVE_MS > stopAtMs) break;
      estimated += 1;
      estimatedMs += itemEstimateMs;
    }
    summary.estimated = estimated;
    output.log(`[media-video-transcribe] dry-run 대상 ${selected.length}, 총 ${(durationSec / 3600).toFixed(2)}시간; `
      + `0.8배 추정 ${estimated}개/최대 ${maxMinutes}분`);
    return summary;
  }
  if (!selected.length) return summary;
  const commonLock = join(root, VAULT_REL.mediaTranscribeState) + '.lock';
  if (existsSync(commonLock)) return { ...summary, busy: true };
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const started = clock();
  const deadline = Math.min(started + maxMinutes * 60_000, stopAtMs);
  const run = async () => {
    const references = referencesLoader(paths);
    let session = null;
    let sessionItems = 0;
    try {
    for (const item of selected) {
      if (clock() >= deadline || existsSync(commonLock)) break;
      const expectedMs = item.durationSec * VIDEO_TRANSCRIPT_ESTIMATE_RATIO * 1000;
      if (stopAtMs !== Infinity
        && clock() + expectedMs + VIDEO_TRANSCRIPT_HIGHLIGHT_RESERVE_MS > stopAtMs) {
        summary.morningDeferred = selected.length - summary.processed - summary.failed;
        output.log('[media-video-transcribe] 08:30 전 종료 여유 부족 — 남은 영상은 다음 회차로 이월');
        break;
      }
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
        const intervals = speechIntervals(item.cue);
        const plan = speechAudioPlan(intervals);
        const wav = join(temporary, `${item.record.id}.wav`);
        const audioStarted = performance.now();
        const filters = plan.map((part, index) =>
          `[0:a]atrim=start=${part.sourceStart}:end=${part.sourceEnd},asetpts=PTS-STARTPTS[a${index}]`);
        const filter = `${filters.join(';')};${plan.map((_, index) => `[a${index}]`).join('')}`
          + `concat=n=${plan.length}:v=0:a=1[out]`;
        const itemTimeoutMs = Math.min(90 * 60_000,
          Math.max(10 * 60_000, item.durationSec * 4_000));
        await execute('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', video,
          '-filter_complex', filter, '-map', '[out]', '-ar', '16000', '-ac', '1',
          '-c:a', 'pcm_s16le', wav],
        { timeout: itemTimeoutMs });
        const audioExtractMs = Math.round(performance.now() - audioStarted);
        const decoded = await transcribeFn({ ...item.record, path: video }, {
          ffmpegPath: '/opt/homebrew/bin/ffmpeg', ffprobePath: '/opt/homebrew/bin/ffprobe',
          whisperPath: '/opt/homebrew/bin/whisper-cli', model, temporaryRoot, now: new Date().toISOString(),
          // GPU(Metal)는 launchd·대화형 실행에서 정상 동작한다(30초 음성: GPU 8.1초 vs CPU 62.2초, 2026-10-18 실측).
          // Codex 격리 환경에서만 Metal 초기화가 실패하므로 CPU 고정을 두지 않는다.
          language: VIDEO_LANGUAGE, fullJson: true, noSpeechThreshold: 0.45,
          inputWav: wav, inputDurationSec: plan.at(-1).audioEndMs / 1000,
          shouldRetryLanguage: (first) => repeatsThreeTimes(first.text)
            || VIDEO_HALLUCINATION_PHRASES.some((phrase) => normalizeText(first.text).includes(phrase)),
          timeoutMs: itemTimeoutMs, output });
        const restored = restoreSourceTime(decoded.segments, plan);
        const { kept: segments, dropped } = reviewVideoSegments(restored, intervals);
        let diarizeMs = 0;
        let featureMs = 0;
        let diarizeDevice = null;
        let named = segments;
        let speakers = null;
        if (segments.length) {
          if (diarizeFn === runPython && !session) {
            session = sessionFactory({ python: paths.python, voicesDir: paths.voices,
              signal: AbortSignal.timeout(2 * 60 * 60_000) });
          }
          const runDiarize = session ? (backend, items) => session.run(backend, items) : diarizeFn;
          const shortSpeech = decoded.durationSec < 8;
          const backend = shortSpeech ? 'pyannote-single' : 'pyannote';
          const diarizeStarted = performance.now();
          const [row] = await runDiarize(backend, [{ id: item.record.id, wav }],
            { voicesDir: paths.voices, lowPriority: true, recordings: true,
              signal: AbortSignal.timeout(itemTimeoutMs) });
          if (session && ++sessionItems >= VIDEO_TRANSCRIPT_SESSION_ITEMS) {
            await session.close();
            session = null;
            sessionItems = 0;
          }
          diarizeMs = Math.round(performance.now() - diarizeStarted);
          featureMs = row?.featureMs || 0;
          diarizeDevice = row?.device || null;
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
              const sourceTurns = restoreSourceTime(row.turns, plan);
              ({ segments: named, speakers } = nameVideoSegments(segments, sourceTurns, voices,
                references, item.record.occurred));
              if (shortSpeech) speakers.engine = 'pyannote-single';
            }
          }
        }
        const result = { version: VIDEO_TRANSCRIPT_VERSION, id: item.record.id, kind: 'Video',
          occurred: item.record.occurred, durationSec: item.durationSec,
          sourceSize: source.size, sourceMtimeMs: Math.round(source.mtimeMs),
          speech: Boolean(named.length), text: named.map((part) => part.text).join(' '),
          segments: named, speakers, model, modelVersion: basename(model), language: VIDEO_LANGUAGE,
          detectedLanguage: decoded.detectedLanguage || null,
          ...(decoded.languageFallback ? { languageFallback: decoded.languageFallback } : {}),
          dropped, timings: { ...decoded.timings, audioExtractMs, diarizeMs, featureMs,
            diarizeDevice },
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
        await session?.close();
        session = null;
        sessionItems = 0;
        state.failures[item.record.id] ||= [];
        state.failures[item.record.id].push({ at: new Date().toISOString(), message: error.message });
        summary.failed += 1;
        output.error?.(`[media-video-transcribe] ${item.record.id}: ${error.message}`);
      } finally {
        await fs.rm(temporary, { recursive: true, force: true });
        savePrivate(statePath, `${JSON.stringify(state, null, 2)}\n`);
      }
    }
    } finally { await session?.close(); }
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
