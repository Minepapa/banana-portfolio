#!/usr/bin/env node
// 영상 원본과 Vault 색인·갤러리는 읽기만 한다. 결과는 Media 아래에 기록한다.
import { existsSync, mkdirSync, readFileSync, chmodSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { VAULT_PATHS, VAULT_REL, MEDIA_FACES_PATHS } from '../lib/vault-paths.mjs';
import { withLock } from '../lib/state-writer.mjs';
import { matchFaces, vectorLoader } from '../lib/media-face-gallery.mjs';
import { PERSON_THRESHOLDS } from '../lib/media-face-people.mjs';
import { AUDIO_CUES_PATHS, computeCues, summarizeCues } from '../lib/media-audio-cues.mjs';
import { extractVideoFrames, probeVideo, safeVideoPath, VIDEO_EXTENSIONS, VIDEO_FRAME_ROOT } from '../lib/media-video-frames.mjs';
import { parseFaceOutput, runPythonFaces } from './media-faces.mjs';

const VIDEO_ROOT = join(homedir(), 'Pantheon', 'Media', 'VideoAnalysis');
export const VIDEO_PATHS = Object.freeze({
  frameRoot: VIDEO_FRAME_ROOT,
  facesRoot: MEDIA_FACES_PATHS.root,
  embeddings: join(MEDIA_FACES_PATHS.root, 'video', 'embeddings'),
  matches: join(MEDIA_FACES_PATHS.root, 'video-matches.jsonl'),
  status: join(VIDEO_ROOT, 'status.json'),
});
const BUDGET_MS = 20 * 60_000;

function jsonLines(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
}

export function savePrivate(path, content) {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}

export function parseVideoArgs(args) {
  const options = { limit: 30, ids: null, dryRun: false, faces: false, cues: false };
  for (const arg of args) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--faces') options.faces = true;
    else if (arg === '--cues') options.cues = true;
    else if (/^--limit=\d+$/.test(arg)) options.limit = Number(arg.slice(8));
    else if (arg.startsWith('--ids=')) options.ids = arg.slice(6).split(',');
    else throw new Error(`media-video 옵션 오류: ${arg}`);
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000
    || options.ids?.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))) throw new Error('media-video 옵션 오류');
  if (!options.faces && !options.cues) { options.faces = true; options.cues = true; }
  return options;
}

export function selectVideos(records, { limit = 30, ids = null, pending = null } = {}) {
  const requested = ids ? new Set(ids) : null;
  const seen = new Set();
  return records.filter((record) => {
    const relative = record.importPath || record.archivePath;
    if (!record.id || !/^[A-Za-z0-9_-]+$/.test(record.id) || seen.has(record.id)
      || record.duplicateOf || !VIDEO_EXTENSIONS.has(extname(relative || '').toLowerCase())
      || requested && !requested.has(record.id) || !requested && pending && !pending(record)) return false;
    seen.add(record.id);
    return true;
  }).slice(0, limit);
}

// 매 프레임의 점수 중 사람별 최댓값을 영상 이름표로 쓴다. 사진 콜라주 제한은 적용하지 않는다.
export function videoPeople(matches, manifest) {
  const best = new Map();
  for (const match of matches) {
    if (match.prebirth && !match.person || !Number.isFinite(match.score)) continue;
    const person = match.person || '미네';
    if (!PERSON_THRESHOLDS[person] || match.score < PERSON_THRESHOLDS[person].hold) continue;
    const frame = manifest.frames.find((item) => item.id === match.id);
    const second = frame?.second;
    if (!Number.isInteger(second)) continue;
    if (!best.has(person) || match.score > best.get(person).score) {
      best.set(person, { person, score: match.score, second, timestampSec: second,
        frameId: match.id, face: match.i });
    }
  }
  const people = []; const hold = []; const representatives = {};
  for (const [person, candidate] of best) {
    if (candidate.score >= PERSON_THRESHOLDS[person].label) people.push(person);
    else hold.push(person);
    representatives[person] = candidate;
  }
  return { id: manifest.id, original: manifest.original, durationSec: manifest.durationSec,
    sourceSize: manifest.size, sourceMtimeMs: manifest.mtimeMs,
    basis: 'video-frames', frameCount: manifest.frames.length,
    frameFingerprint: fingerprintFrames(manifest), people, hold, representatives };
}

export function fingerprintFrames(manifest) {
  return createHash('sha256').update(JSON.stringify(manifest.frames.map(({ id, second, path }) =>
    ({ id, second, path })))).digest('hex');
}

export async function runMediaVideo(options = {}) {
  const { root = VAULT_PATHS.root, mediaRoot = MEDIA_FACES_PATHS.mediaRoot,
    paths = VIDEO_PATHS, limit = 30, ids = null, dryRun = false, faces = true, cues = true,
    framesFor = extractVideoFrames, faceWorker = runPythonFaces, cueWorker = computeCues,
    durationFor = probeVideo,
    output = console, now = Date.now, budgetMs = BUDGET_MS } = options;
  const records = [...jsonLines(join(root, VAULT_REL.mediaArchiveIndex)),
    ...jsonLines(join(root, VAULT_REL.mediaImportsIndex))];
  const plan = () => {
    const state = existsSync(paths.status) ? JSON.parse(readFileSync(paths.status, 'utf8')) : {};
    const previousMatches = new Map(jsonLines(paths.matches).map((row) => [row.id, row]));
    const galleryPath = join(root, VAULT_REL.mediaFaceGallery);
    const galleryText = faces && existsSync(galleryPath) ? readFileSync(galleryPath, 'utf8') : null;
    const galleryHash = galleryText ? createHash('sha256').update(galleryText).digest('hex') : null;
    const pending = (record) => {
      const stages = state[record.id]?.stages ?? {};
      if (faces && (!stages.faces?.ok || !previousMatches.has(record.id)) || cues && !stages.cues?.ok) return true;
      let source;
      try { source = statSync(safeVideoPath(mediaRoot, record)); } catch { return true; }
      const size = source.size;
      const mtimeMs = Math.round(source.mtimeMs);
      const match = previousMatches.get(record.id);
      return faces && (match.sourceSize !== size || match.sourceMtimeMs !== mtimeMs
        || match.galleryHash !== galleryHash)
        || cues && (stages.cues.sourceSize !== size || stages.cues.sourceMtimeMs !== mtimeMs);
    };
    const targets = selectVideos(records, { limit, ids, pending });
    return { state, previousMatches, galleryText, galleryHash, targets };
  };
  if (dryRun) {
    const { targets } = plan();
    for (const record of targets) output.log(`[media-video] dry-run ${record.id} ${record.importPath || record.archivePath} faces=${faces} cues=${cues}`);
    return { selected: targets.length, processed: 0, failed: 0, results: [] };
  }
  mkdirSync(dirname(paths.status), { recursive: true, mode: 0o700 });
  const started = now();
  return withLock(paths.status, async () => {
    const { state, previousMatches, galleryText, galleryHash, targets } = plan();
    const summary = { selected: targets.length, processed: 0, failed: 0, results: [] };
    if (faces && !galleryText) throw new Error('face-gallery.json이 없습니다');
    const gallery = galleryText ? JSON.parse(galleryText) : null;
    const photoVector = faces ? vectorLoader(MEDIA_FACES_PATHS.embeddings) : null;
    const videoVector = faces ? vectorLoader(paths.embeddings) : null;
    const vectorFor = (member) => member.id.includes('@') ? videoVector(member) : photoVector(member);
    for (const record of targets) {
      if (now() - started >= budgetMs) { output.log('[media-video] 시간 예산 도달'); break; }
      const stages = { ...(state[record.id]?.stages ?? {}) };
      delete stages.error;
      const persist = () => {
        state[record.id] = { path: record.importPath || record.archivePath,
          stages, updatedAt: new Date().toISOString() };
        savePrivate(paths.status, `${JSON.stringify(state, null, 2)}\n`);
      };
      if (faces) {
        let extracted = false;
        let manifest;
        try {
          manifest = await framesFor(record, { mediaRoot, frameRoot: paths.frameRoot,
            deadline: started + budgetMs });
          extracted = true;
          stages.frames = { ok: true, count: manifest.frames.length, durationSec: manifest.durationSec };
          persist();
          const previous = previousMatches.get(record.id);
          if (previous?.sourceSize === manifest.size && previous.sourceMtimeMs === manifest.mtimeMs
            && previous.galleryHash === galleryHash
            && previous.frameFingerprint === fingerprintFrames(manifest)) {
            stages.faces = { ok: true, cached: true, people: previous.people, hold: previous.hold,
              sourceSize: manifest.size, sourceMtimeMs: manifest.mtimeMs };
          } else {
            const images = manifest.frames.map(({ id, path }) => ({ id, path }));
            mkdirSync(paths.embeddings, { recursive: true, mode: 0o700 });
            chmodSync(paths.embeddings, 0o700);
            const remaining = started + budgetMs - now();
            if (remaining <= 0) throw new Error('얼굴 시간 예산 초과');
            const response = await faceWorker(images, { out: dirname(paths.embeddings), nice: true,
              timeoutMs: Math.min(images.length * 60_000, remaining) });
            const rows = parseFaceOutput(Array.isArray(response) ? response : response.lines ?? [], images);
            const failure = rows.find((row) => row.error || !existsSync(join(paths.embeddings, `${row.id}.npy`)));
            if (failure) throw new Error(`프레임 얼굴 실패: ${failure.error || '특징값 없음'} (${failure.id})`);
            const mediaFrames = manifest.frames.map((frame) => ({ ...record, id: frame.id }));
            const matches = matchFaces(rows, mediaFrames, gallery, vectorFor, { videoFrames: true });
            const label = { ...videoPeople(matches, manifest), galleryHash };
            const nextMatches = new Map(previousMatches);
            nextMatches.set(record.id, label);
            savePrivate(paths.matches, `${[...nextMatches.values()].map(JSON.stringify).join('\n')}\n`);
            previousMatches.set(record.id, label);
            stages.faces = { ok: true, people: label.people, hold: label.hold,
              sourceSize: manifest.size, sourceMtimeMs: manifest.mtimeMs };
          }
        } catch (error) {
          const previous = previousMatches.get(record.id);
          let currentSource;
          try { currentSource = statSync(safeVideoPath(mediaRoot, record)); } catch { /* 읽을 수 없는 원본은 기존 판정의 근거가 아니다. */ }
          const stillCurrent = previous && currentSource
            && previous.sourceSize === currentSource.size
            && previous.sourceMtimeMs === Math.round(currentSource.mtimeMs)
            && previous.galleryHash === galleryHash
            && (!manifest || previous.frameFingerprint === fingerprintFrames(manifest));
          if (previous && !stillCurrent) {
            // 실패한 재분석의 이전 판정을 순간 잡이 최신 이름표로 읽지 않게 한다.
            previousMatches.delete(record.id);
            savePrivate(paths.matches, `${[...previousMatches.values()].map(JSON.stringify).join('\n')}\n`);
          }
          if (!extracted) stages.frames = { ok: false, error: String(error.message) };
          stages.faces = { ok: false, error: String(error.message) };
          output.error?.(`[media-video] ${record.id} 얼굴: ${error.message}`);
        }
        persist();
      }
      if (cues) {
        try {
          const pathsById = new Map([[record.id, { archivePath: record.importPath || record.archivePath, kind: record.kind }]]);
          const source = statSync(safeVideoPath(mediaRoot, record));
          const remaining = started + budgetMs - now();
          if (remaining <= 0) throw new Error('소리 시간 예산 초과');
          const result = await cueWorker(record.id, { root, mediaRoot, cacheDir: AUDIO_CUES_PATHS.cacheDir,
            archivePaths: pathsById, timeoutMs: remaining, allowVideo: true });
          if (result.error) throw new Error(`소리 실패: ${result.error}`);
          const evidence = result.sound === 'none' ? null : summarizeCues(result.windows ?? [], { scope: '영상 전체' });
          // --cues 단독 실행에서는 이전 회차 프레임 길이가 현재 원본과 같다는 보장이 없다.
          let videoDurationSec = faces && stages.frames?.ok ? stages.frames.durationSec : null;
          if (videoDurationSec == null) {
            const probeRemaining = started + budgetMs - now();
            if (probeRemaining <= 0) throw new Error('영상 길이 확인 시간 예산 초과');
            videoDurationSec = await durationFor(safeVideoPath(mediaRoot, record),
              { timeoutMs: Math.min(30_000, probeRemaining) });
          }
          stages.cues = { ok: true, sound: result.sound ?? 'present', durationSec: result.durationSec,
            videoDurationSec,
            sourceSize: source.size, sourceMtimeMs: Math.round(source.mtimeMs),
            summary: result.sound === 'none' ? '소리 없음' : evidence.lines.join(' '),
            intervals: evidence?.intervals ?? {} };
        } catch (error) {
          stages.cues = { ok: false, error: String(error.message) };
          output.error?.(`[media-video] ${record.id} 소리: ${error.message}`);
        }
        persist();
      }
      if (faces && !stages.faces?.ok || cues && !stages.cues?.ok) summary.failed += 1;
      else summary.processed += 1;
      summary.results.push({ id: record.id, ...stages });
    }
    output.log(`[media-video] 대상 ${summary.selected}, 완료 ${summary.processed}, 실패 ${summary.failed}`);
    return summary;
  });
}

export async function runMediaVideoCli(args, { run = runMediaVideo } = {}) {
  const summary = await run(parseVideoArgs(args));
  return summary.failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = await runMediaVideoCli(process.argv.slice(2)); }
  catch (error) { console.error(`[media-video] ${error.message}`); process.exitCode = 1; }
}
