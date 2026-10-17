#!/usr/bin/env node
// 녹음·통화 소리 근거(웃음·울음·소리 지름·노래·한숨·속삭임, 목소리 높낮이·세기)를 맥 안에서 뽑아
// 감정 분류(결정 `미네-감정-분류`)의 근거로 넘긴다. Whisper 전사에는 웃음·톤이 남지 않아
// 노래·혼잣말이 '감정 없음'으로 쏠렸다(2026-10-16 녹음 70개 재분류에서 37개, 오너 승인으로 추가).
// - 모델: sherpa-onnx CED mini(AudioSet 527종, 로컬). 실행: diarize-venv 파이썬 작업기(nice 10).
// - 결과 캐시: 볼트 밖 ~/Pantheon/Media/AudioCues/{id}.json(0600). 원본 크기·수정 시각이 바뀌면 다시 계산.
// - 화자 분리 파일이 있으면 '미네' 구간과 겹치는 창만 센다(결정 §7: 미네의 감정만).
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MEDIA_DIARIZE_PATHS, VAULT_PATHS, VAULT_REL } from './vault-paths.mjs';
import { MINE_RECORDING_RULE, OWNER_MARGIN_MIN, RECORDING_DIALOGUE_KINDS, identifyOwner, readNpy, recordingKind } from '../jobs/media-diarize.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../tools/diarize/media_audio_cues.py', import.meta.url));

export const AUDIO_CUES_PATHS = Object.freeze({
  cacheDir: join(homedir(), 'Pantheon', 'Media', 'AudioCues'),
  mediaRoot: MEDIA_DIARIZE_PATHS.mediaRoot,
  python: MEDIA_DIARIZE_PATHS.python,
  model: join(homedir(), 'Pantheon', 'Models', 'audio-tagging', 'sherpa-onnx-ced-mini-audio-tagging-2024-04-19', 'model.int8.onnx'),
});

export const CUE_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.avi', '.mkv', '.webm']);
// 한 묶음(주간 잡 최대 30노트)의 소리 분석 전체 예산. 넘으면 나머지 노트는 '시간 예산 초과'로 소리 근거 없이 진행.
export const BATCH_BUDGET_MS = 20 * 60_000;
// 묶음별 확률 문턱. 웃음·울음은 짧고 확률이 낮게 나오는 편이라 노래보다 낮게 둔다
// (2026-10-16 실측: 요들송 녹음 웃음 0.18~0.39, 아이 노래 0.6~0.8).
export const CUE_THRESHOLDS = Object.freeze({ laughter: 0.25, crying: 0.25, shouting: 0.3, singing: 0.4, sigh: 0.3, whisper: 0.3 });
const CUE_NAMES = { laughter: '웃음', crying: '울음', shouting: '소리 지름', singing: '노래', sigh: '한숨', whisper: '속삭임' };
// 높은 목소리·큰 소리 구간: 그 녹음(미네 구간) 중앙값 대비 비율.
const HIGH_PITCH_RATIO = 1.25;
const LOUD_RATIO = 1.8;
// 4초 창의 75% 이상이 미네 구간일 때만 미네 소리로 센다(다른 사람 소리가 섞이는 것을 줄임, 리뷰 MEDIUM).
const MIN_OVERLAP = 0.75;

export function clock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// id → { archivePath, kind }. 통화(Calls)는 kind로 한 번 더 거른다.
export function loadArchivePaths(root = VAULT_PATHS.root) {
  const map = new Map();
  for (const index of [VAULT_REL.mediaArchiveIndex, VAULT_REL.mediaImportsIndex]) {
    const path = join(root, index);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const row = JSON.parse(line); if (row.id && !row.duplicateOf && (row.archivePath || row.importPath)) {
        map.set(row.id, { archivePath: row.archivePath || row.importPath, kind: row.kind, occurred: row.occurred });
      } } catch { /* 깨진 줄은 건너뜀 */ }
    }
  }
  return map;
}

export function loadSpeakers(root, id) {
  const base = join(root, VAULT_REL.mediaSpeakers);
  if (!existsSync(base)) return null;
  for (const year of readdirSync(base)) {
    const path = join(base, year, `${id}.json`);
    if (existsSync(path)) {
      try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
    }
  }
  return null;
}

// 미네 발화 구간(초). 녹음 Speakers의 labels에서 '미네'인 화자의 turns. 이름표가 없으면 null(알 수 없음).
export function mineIntervals(speakers, name = '미네') {
  if (!speakers?.labels || !Array.isArray(speakers.turns)) return null;
  const ids = Object.entries(speakers.labels).filter(([, label]) => label === name).map(([speaker]) => speaker);
  return speakers.turns.filter((turn) => ids.includes(turn.speaker))
    .map((turn) => ({ start: turn.start / 1000, end: turn.end / 1000 }));
}

function cosine(left, right) {
  if (!left || !right || left.length !== right.length) return -1;
  let product = 0; let leftSquare = 0; let rightSquare = 0;
  for (let index = 0; index < left.length; index += 1) {
    product += left[index] * right[index];
    leftSquare += left[index] ** 2;
    rightSquare += right[index] ** 2;
  }
  return leftSquare && rightSquare ? product / Math.sqrt(leftSquare * rightSquare) : -1;
}

function nearestMineVoice(mine, occurred) {
  const year = Number(String(occurred ?? '').slice(0, 4));
  const nearest = mine.meta.years?.length && Number.isFinite(year)
    ? [...mine.meta.years].sort((left, right) => Math.abs(left.year - year) - Math.abs(right.year - year)
      || right.year - left.year)[0] : null;
  return { reference: mine.vectors[nearest?.index ?? 0],
    distance: nearest ? Math.abs(nearest.year - year) : Infinity };
}

function subtractIntervals(other, owner) {
  const ownerParts = mergeIntervals(owner);
  return mergeIntervals(other).flatMap((part) => {
    const pieces = [];
    let start = part.start;
    for (const covered of ownerParts) {
      if (covered.end <= start || covered.start >= part.end) continue;
      if (covered.start - start >= 0.5) pieces.push({ start, end: covered.start });
      start = Math.max(start, covered.end);
      if (start >= part.end) break;
    }
    if (part.end - start >= 0.5) pieces.push({ start, end: part.end });
    return pieces;
  });
}

// Calls에는 labels가 없다. 저장된 owner/other 판정과 실제 목소리 특징값이 일치할 때만
// other를 미네로 확정한다. 실패 이유는 프롬프트에도 남겨 전화 명의만으로 추정하지 않게 한다.
export function callMineIntervals(speakers, { people, occurred, callVoices, owner, mine } = {}) {
  const namedPeople = (Array.isArray(people) ? people : [people]).map((person) => String(person ?? '')
    .replace(/^\[\[/u, '').replace(/\]\]$/u, '').split('|')[0].split('/').at(-1)
    .replace(/^\d+\s+/u, ''));
  if (!namedPeople.includes('미네')) return { intervals: [], reason: '노트 상대가 미네가 아님' };
  if (!speakers || !Array.isArray(speakers.turns) || !Array.isArray(speakers.segments)
    || speakers.check || !Number.isFinite(speakers.ownerMargin)
    || speakers.ownerMargin < OWNER_MARGIN_MIN
    || !speakers.segments.some((part) => part.speaker === 'owner')
    || !speakers.segments.some((part) => part.speaker === 'other')) {
    return { intervals: [], reason: '화자 확인 필요' };
  }
  if (!owner?.mean || !owner.meta || !mine?.vectors?.length || !mine.meta
    || !Array.isArray(callVoices) || callVoices.length !== 2
    || speakers.ownerVersion !== owner.meta.version) {
    return { intervals: [], reason: '목소리 기준 또는 화자 특징값 없음' };
  }
  const identified = identifyOwner(callVoices, owner.mean,
    { minSimilarity: owner.meta.minSimilarity ?? -1 });
  if (identified.check || identified.margin < OWNER_MARGIN_MIN
    || Math.abs(identified.margin - speakers.ownerMargin) > 0.001) {
    return { intervals: [], reason: '화자 확인 필요' };
  }
  const otherSpeaker = identified.speaker === 'S0' ? 'S1' : 'S0';
  const { reference, distance } = nearestMineVoice(mine, occurred);
  if (distance >= MINE_RECORDING_RULE.farYears) {
    return { intervals: [], reason: '미네 목소리 기준 연도가 멀어 확인 불가' };
  }
  const similarity = cosine(callVoices[Number(otherSpeaker.slice(1))], reference);
  const ownerSimilarity = cosine(callVoices[Number(otherSpeaker.slice(1))], owner.mean);
  const threshold = Math.max(0.45, Number(mine.meta.minSimilarity));
  if (!Number.isFinite(threshold) || similarity < threshold || similarity <= ownerSimilarity + 0.1) {
    return { intervals: [], reason: '상대 목소리가 미네 기준과 다름', similarity, ownerSimilarity };
  }
  const toIntervals = (speaker) => speakers.turns.filter((turn) => turn.speaker === speaker
    && Number.isFinite(turn.start) && Number.isFinite(turn.end) && turn.end > turn.start)
    .map((turn) => ({ start: turn.start / 1000, end: turn.end / 1000 }));
  const intervals = subtractIntervals(toIntervals(otherSpeaker), toIntervals(identified.speaker));
  return intervals.length ? { intervals, similarity, ownerSimilarity }
    : { intervals: [], reason: '미네 발화 구간 없음', similarity, ownerSimilarity };
}

export function loadCallVoices(id, paths = MEDIA_DIARIZE_PATHS) {
  if (!/^[a-f0-9]{16}$/i.test(id)) return null;
  const callPath = join(paths.voices, 'pyannote', `${id}.npy`);
  if (![callPath, paths.ownerVoice, paths.ownerMeta, paths.mineVoice, paths.mineMeta]
    .every((path) => existsSync(path))) return null;
  return { callVoices: readNpy(callPath),
    owner: { mean: readNpy(paths.ownerVoice)[0], meta: JSON.parse(readFileSync(paths.ownerMeta, 'utf8')) },
    mine: { vectors: readNpy(paths.mineVoice), meta: JSON.parse(readFileSync(paths.mineMeta, 'utf8')) } };
}

function mergeIntervals(intervals) {
  const merged = [];
  for (const part of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && part.start <= last.end) last.end = Math.max(last.end, part.end);
    else merged.push({ ...part });
  }
  return merged;
}

export function windowsInIntervals(windows, intervals) {
  if (!intervals) return windows;
  intervals = mergeIntervals(intervals);
  return windows.filter((window) => {
    const length = window.end - window.start;
    const overlap = intervals.reduce((sum, part) =>
      sum + Math.max(0, Math.min(window.end, part.end) - Math.max(window.start, part.start)), 0);
    return length > 0 && overlap / length >= MIN_OVERLAP;
  });
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

// 이어진 창(겹치는 창)을 한 구간으로 묶는다.
function runsOf(windows, test) {
  const runs = [];
  for (const window of windows) {
    if (!test(window)) continue;
    const last = runs.at(-1);
    if (last && window.start <= last.end) { last.end = Math.max(last.end, window.end); last.peak = Math.max(last.peak, window.peak ?? 0); }
    else runs.push({ start: window.start, end: window.end, peak: window.peak ?? 0 });
  }
  return runs;
}

function describeRuns(runs, { limit = 4 } = {}) {
  const shown = runs.slice(0, limit).map((run) => clock(run.start));
  return `${shown.join('·')}${runs.length > limit ? ` 외 ${runs.length - limit}곳` : ''}`;
}

// LLM에 넘길 한국어 요약. scope: '미네 구간' | '전체(화자 분리 없음)'.
export function summarizeCues(windows, { scope, thresholds = CUE_THRESHOLDS, includeSpeech = scope === '영상 전체' } = {}) {
  if (!windows.length) return { lines: [`소리 근거(${scope}): 분석할 구간 없음`], counts: {}, intervals: {} };
  const lines = [`소리 근거(${scope}, 맥 안 기계 감지 — 틀릴 수 있음):`];
  const counts = {};
  const intervals = {};
  for (const [group, label] of Object.entries(CUE_NAMES)) {
    const marked = windows.map((window) => ({ ...window, peak: window.tags?.[group] ?? 0 }));
    const runs = runsOf(marked, (window) => window.peak >= thresholds[group]);
    counts[group] = runs.length;
    intervals[group] = runs.map(({ start, end }) => ({ start, end }));
    if (!runs.length) continue;
    const seconds = Math.round(runs.reduce((sum, run) => sum + run.end - run.start, 0));
    const peak = Math.max(...runs.map((run) => run.peak));
    lines.push(group === 'singing'
      ? `- ${label} 약 ${seconds}초(${describeRuns(runs)} 시작)`
      : `- ${label} ${runs.length}회(${describeRuns(runs)}, 최대 ${peak.toFixed(2)})`);
  }
  if (!counts.laughter && !counts.crying) lines.push('- 웃음·울음 신호 없음');
  const speechRuns = runsOf(windows.map((window) => ({ ...window, peak: window.tags?.speech ?? 0 })),
    (window) => window.peak >= 0.3);
  counts.speech = speechRuns.length;
  intervals.speech = speechRuns.map(({ start, end }) => ({ start, end }));
  if (includeSpeech && speechRuns.length) lines.push(`- 말소리 있음(대략 ${Math.round(speechRuns.reduce((sum, run) => sum + run.end - run.start, 0))}초)`);
  const pitchMedian = median(windows.map((window) => window.pitch));
  if (pitchMedian) {
    const high = runsOf(windows, (window) => window.pitch && window.pitch >= pitchMedian * HIGH_PITCH_RATIO);
    lines.push(`- 목소리 높이: 중앙값 약 ${Math.round(pitchMedian)}Hz${high.length ? `, 높아진 구간 ${describeRuns(high)}` : ', 크게 높아진 구간 없음'}`);
  }
  const rmsMedian = median(windows.map((window) => window.rms));
  if (rmsMedian) {
    const loud = runsOf(windows, (window) => window.rms >= rmsMedian * LOUD_RATIO);
    lines.push(`- 소리 세기: ${loud.length ? `커진 구간 ${describeRuns(loud)}` : '크게 커진 구간 없음'}`);
  }
  return { lines, counts, intervals };
}

function inside(base, path) {
  const rel = relative(base, path);
  return Boolean(rel) && !rel.startsWith('..') && !rel.startsWith(sep);
}

// 문자열 검사 + 실제 경로(심볼릭 링크 해제) 검사. Archive 밖(볼트·금고 등)을 가리키면 읽지 않는다.
function safeAudioPath(mediaRoot, archivePath) {
  const errorText = archivePath?.startsWith('Imports/') ? 'Imports 경로 오류' : 'Archive 경로 오류';
  if (typeof archivePath !== 'string' || !/^(Archive|Imports)\//.test(archivePath)) throw new Error(errorText);
  const base = resolve(mediaRoot, archivePath.split('/')[0]);
  const path = resolve(mediaRoot, archivePath);
  if (!inside(base, path)) throw new Error(errorText);
  if (existsSync(path) && !inside(realpathSync(base), realpathSync(path))) throw new Error(errorText);
  return path;
}

function writePrivate(path, content) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  try { renameSync(temporary, path); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}

export function runCueWorker(items, { python = AUDIO_CUES_PATHS.python, spawnProcess = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnProcess('nice', ['-n', '10', python, SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_OFFLINE: '1' } });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); rejectPromise(new Error('소리 분석 시간 초과')); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); rejectPromise(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 콜백 안 예외는 Promise를 거부하지 않고 프로세스를 죽이므로 모두 잡아 거부로 바꾼다(리뷰 HIGH).
      try {
        if (code !== 0) throw new Error(`소리 분석 실패: ${stderr.trim().split('\n').at(-1) ?? code}`);
        const rows = [];
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          try { rows.push(JSON.parse(line)); } catch { /* 결과가 아닌 줄은 버린다 */ }
        }
        resolvePromise(rows);
      } catch (error) { rejectPromise(error); }
    });
    child.stdin.on('error', () => { /* 작업기가 먼저 죽으면 close에서 판정 */ });
    child.stdin.end(`${JSON.stringify({ items })}\n`);
  });
}

// 한 미디어 id의 창별 결과(캐시 우선). 반환: { windows, durationSec } 또는 { error }.
export async function computeCues(id, { root = VAULT_PATHS.root, mediaRoot = AUDIO_CUES_PATHS.mediaRoot,
  cacheDir = AUDIO_CUES_PATHS.cacheDir, archivePaths = loadArchivePaths(root), exec = execFileAsync,
  worker = runCueWorker, write = writePrivate, temporaryRoot = tmpdir(), timeoutMs = DEFAULT_TIMEOUT_MS,
  allowVideo = false, allowCalls = false } = {}) {
  const entry = archivePaths.get(id);
  const archivePath = typeof entry === 'string' ? entry : entry?.archivePath;
  if (!archivePath) return { error: '색인에 원본 없음' };
  const video = allowVideo && ['Camera', 'KakaoTalkMovie', 'Import', 'Imports', 'Recordings'].includes(entry?.kind)
    && VIDEO_EXTENSIONS.has(extname(archivePath).toLowerCase());
  if (entry?.kind === 'Calls' && !allowCalls || entry?.kind && !['Recordings', 'Calls'].includes(entry.kind) && !video
    || !entry?.kind && VIDEO_EXTENSIONS.has(extname(archivePath).toLowerCase())) {
    return { error: '녹음이 아님(통화 등)' };
  }
  let audio;
  try { audio = safeAudioPath(mediaRoot, archivePath); } catch (error) { return { error: error.message }; }
  if (!existsSync(audio)) return { error: '원본 파일 없음' };
  const source = statSync(audio);
  const budgetLimited = timeoutMs < DEFAULT_TIMEOUT_MS;
  // 기존 녹음 95개 캐시는 보존한다. 영상은 말소리 태그를 포함한 새 스키마를 쓴다.
  const key = { version: video ? 2 : CUE_VERSION, size: source.size, mtimeMs: Math.round(source.mtimeMs) };
  const cachePath = join(cacheDir, `${id}.json`);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (cached.version === key.version && cached.size === key.size && cached.mtimeMs === key.mtimeMs) {
        // 이전 회차의 짧은 예산 때문에 남은 실패 기록만 재시도한다.
        if (!cached.budgetLimited) {
          return cached.error ? { error: `${cached.error}(이전 실패 기록)` } : cached;
        }
      }
    } catch { /* 깨진 캐시는 다시 계산 */ }
  }
  const remember = async (result) => {
    // 실패도 같은 원본 기준으로 기억해 매주 다시 오래 시도하지 않는다(원본이 바뀌면 다시 계산).
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    chmodSync(cacheDir, 0o700);
    await write(cachePath, `${JSON.stringify(result)}\n`);
    chmodSync(cachePath, 0o600);
    return result;
  };
  const temporary = mkdtempSync(join(temporaryRoot, 'media-audio-cues-'));
  try {
    const wav = join(temporary, `${id}.wav`);
    const started = Date.now();
    const ffmpegArgs = ['-nostdin', '-loglevel', 'error', '-i', audio,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav];
    await exec(video ? 'nice' : '/opt/homebrew/bin/ffmpeg',
      video ? ['-n', '10', '/opt/homebrew/bin/ffmpeg', ...ffmpegArgs] : ffmpegArgs,
      { timeout: Math.min(300_000, timeoutMs) });
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new Error('소리 분석 시간 초과');
    const [row] = await worker([{ id, wav }], { timeoutMs: remaining });
    if (!row || row.error) {
      const error = row?.error ?? '소리 분석 결과 없음';
      if (!budgetLimited || !/시간 초과|timed out|ETIMEDOUT/i.test(error)) await remember({ id, ...key, error });
      return { error };
    }
    const { error: _ignored, ...clean } = { id, ...key, durationSec: row.durationSec, windowSec: row.windowSec, hopSec: row.hopSec, windows: row.windows };
    return await remember(clean);
  } catch (error) {
    if (video && /does not contain any stream|Output file #0 does not contain any stream|Stream map.*matches no streams/i.test(error.stderr || error.message)) {
      return await remember({ id, ...key, sound: 'none', durationSec: null, windows: [] });
    }
    if (error.killed || /시간 초과|timed out|ETIMEDOUT/i.test(error.message)) {
      if (!budgetLimited) {
        try { await remember({ id, ...key, error: '소리 분석 시간 초과' }); } catch { /* 기록 실패는 무시 */ }
      }
    }
    return { error: error.message };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function noteMediaIds(content) {
  return [...String(content).matchAll(/<!-- media-transcribe:id ([a-f0-9]{16}) -->/gi)].map((match) => match[1]);
}

function callSectionNeedsReview(content, id) {
  const marker = `<!-- media-transcribe:id ${id} -->`;
  const start = content.indexOf(marker);
  if (start < 0) return true;
  const next = content.indexOf('<!-- media-transcribe:id ', start + marker.length);
  const end = content.indexOf('<!-- media-transcribe:end -->', start + marker.length);
  const boundary = [next, end].filter((position) => position >= 0).sort((a, b) => a - b)[0] ?? content.length;
  return /\[화자 확인 필요\]/u.test(content.slice(start, boundary));
}

// 노트 하나의 소리 근거 문장. 여러 파일이 묶인 노트면 파일마다 요약.
export async function audioCuesForNote(content, { root = VAULT_PATHS.root, compute = computeCues,
  archivePaths, speakersFor, voicesFor = loadCallVoices } = {}) {
  const call = /^convKind:\s*["']?통화["']?\s*$/m.test(String(content));
  const fields = call ? parseFrontmatter(content) : null;
  const people = call ? [fields.people, fields.counterpart, fields.상대].flat() : null;
  const ids = noteMediaIds(content);
  if (!ids.length) return { text: '소리 근거: 없음(노트에 미디어 id 없음)', ok: false };
  const paths = archivePaths ?? loadArchivePaths(root);
  const parts = [];
  let ok = false;
  for (const id of ids) {
    const prefix = ids.length > 1 ? `[${id}] ` : '';
    const entry = paths.get(id);
    const speakers = (speakersFor ?? ((mediaId) => loadSpeakers(root, mediaId)))(id);
    let intervals;
    if (call) {
      if (entry?.kind !== 'Calls') { parts.push(`${prefix}소리 근거: 없음(통화 원본 색인 아님)`); continue; }
      if (callSectionNeedsReview(content, id)) {
        parts.push(`${prefix}소리 근거: 없음(화자 확인 필요)`); continue;
      }
      let confirmation;
      try {
        confirmation = callMineIntervals(speakers, { people, occurred: fields.occurred ?? entry.occurred,
          ...voicesFor(id) });
      } catch (error) {
        parts.push(`${prefix}소리 근거: 없음(목소리 판정 오류: ${error.message})`);
        continue;
      }
      if (!confirmation.intervals.length) {
        parts.push(`${prefix}소리 근거: 없음(${confirmation.reason})`);
        continue;
      }
      intervals = confirmation.intervals;
    }
    // 통화는 미네 구간이 확정된 다음에만 원본 분석·캐시 접근을 허용한다.
    const cues = await compute(id, { root, archivePaths: paths, ...(call ? { allowCalls: true } : {}) });
    if (cues.error) { parts.push(`${prefix}소리 근거: 없음(${cues.error})`); continue; }
    // 화자 분리는 대화형 녹음만 한다. 대화형인데 화자 파일이 없으면 '아직 분리 전'이라 누구 소리인지 모른다 → 쓰지 않는다.
    // 노래·혼잣말 등 비대화형은 원래 분리하지 않는 한 사람 녹음이라 전체를 쓴다.
    const kind = recordingKind({ archivePath: typeof entry === 'string' ? entry : entry?.archivePath });
    if (!call && !speakers && RECORDING_DIALOGUE_KINDS.includes(kind)) { parts.push(`${prefix}소리 근거: 없음(대화형 녹음인데 화자 분리 전)`); continue; }
    if (!call) intervals = mineIntervals(speakers);
    if (intervals && !intervals.length) { parts.push(`${prefix}소리 근거: 없음(화자 분리에서 미네 화자 미확인)`); continue; }
    const scope = call || intervals ? '미네 구간' : speakers ? '전체(미네 이름표 없음)' : '전체(한 사람 녹음)';
    const windows = windowsInIntervals(cues.windows ?? [], intervals);
    const summary = summarizeCues(windows, { scope });
    parts.push(`${prefix}${summary.lines.join('\n')}`);
    ok = true;
  }
  return { text: parts.join('\n'), ok };
}

// mine-athena-fields 배치에 소리 근거를 붙인다(item.audioCues). 실패해도 배치는 진행하고 이유를 남긴다.
export async function attachAudioCues(items, options = {}) {
  const archivePaths = options.archivePaths ?? loadArchivePaths(options.root ?? VAULT_PATHS.root);
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? BATCH_BUDGET_MS);
  for (const item of items) {
    if (now() > deadline) { item.audioCues = { text: '소리 근거: 없음(시간 예산 초과)', ok: false }; continue; }
    try { item.audioCues = await audioCuesForNote(item.content, { ...options, archivePaths }); }
    catch (error) { item.audioCues = { text: `소리 근거: 없음(${error.message})`, ok: false }; }
  }
  return items;
}

function callNotes(root, rel = VAULT_REL.mediaConversations) {
  const directory = join(root, rel);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('99_')) return [];
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) return callNotes(root, child);
    if (!entry.isFile() || !entry.name.endsWith('.md')) return [];
    const content = readFileSync(join(root, child), 'utf8');
    if (!/^convKind:\s*["']?통화["']?\s*$/m.test(content)) return [];
    const fields = parseFrontmatter(content);
    const people = [fields.people, fields.counterpart, fields.상대].flat();
    if (!people.some((person) => String(person ?? '').split('|')[0].includes('미네'))) return [];
    return [{ content, fields }];
  });
}

// CLI 사전 계산은 노트에 연결된 미네 통화 중 목소리 확인까지 통과한 ID만 선택한다.
export function selectCallCueTargets(rows, { root = VAULT_PATHS.root, ids,
  limit = Infinity, notes = callNotes(root), speakersFor = (id) => loadSpeakers(root, id),
  voicesFor = loadCallVoices } = {}) {
  const noteById = new Map(notes.flatMap((note) => noteMediaIds(note.content).map((id) => [id, note])));
  const selected = [];
  for (const row of rows) {
    if (selected.length >= limit) break;
    if (row.kind !== 'Calls' || ids && !ids.includes(row.id)) continue;
    const note = noteById.get(row.id);
    if (!note || callSectionNeedsReview(note.content, row.id)) continue;
    const fields = note.fields ?? parseFrontmatter(note.content);
    let confirmation;
    try {
      confirmation = callMineIntervals(speakersFor(row.id), {
        people: [fields.people, fields.counterpart, fields.상대].flat(),
        occurred: fields.occurred ?? row.occurred, ...voicesFor(row.id),
      });
    } catch { continue; }
    if (confirmation.intervals.length) selected.push(row);
  }
  return selected;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ids = args.find((arg) => arg.startsWith('--ids='))?.slice(6).split(',').filter(Boolean);
  const limitArg = args.find((arg) => arg.startsWith('--limit='))?.slice(8);
  const limit = limitArg === undefined ? Infinity : Number(limitArg);
  if (!Number.isInteger(limit) && limit !== Infinity) throw new Error('--limit은 정수');
  const dryRun = args.includes('--dry-run');
  const calls = args.includes('--calls');
  if (!args.every((arg) => ['--calls', '--recordings', '--dry-run'].includes(arg)
    || /^--ids=[a-f0-9,]+$/i.test(arg) || /^--limit=\d+$/.test(arg))
    || (calls && args.includes('--recordings')) || (!calls && !args.includes('--recordings') && !ids)) {
    console.error('usage: media-audio-cues.mjs (--recordings|--calls) [--ids=id1,id2] [--limit=N] [--dry-run]');
    process.exitCode = 2;
  } else {
    const root = VAULT_PATHS.root;
    const index = join(root, VAULT_REL.mediaArchiveIndex);
    const rows = readFileSync(index, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const notes = calls ? callNotes(root) : [];
    const targets = calls ? selectCallCueTargets(rows, { root, ids, limit, notes })
      : rows.filter((row) => (ids ? ids.includes(row.id) : row.kind === 'Recordings')).slice(0, limit);
    if (dryRun) console.log(`[media-audio-cues] dry-run 대상 ${targets.length}개${calls ? `, 미네 통화 노트 ${notes.length}개` : ''}, 쓰기·분석 없음`);
    else {
      const archivePaths = loadArchivePaths(root);
      let done = 0; let failed = 0;
      for (const row of targets) {
        const result = await computeCues(row.id, { root, archivePaths, ...(calls ? { allowCalls: true } : {}) });
        if (result.error) { failed += 1; console.error(`[media-audio-cues] ${row.id}: ${result.error}`); } else done += 1;
      }
      console.log(`[media-audio-cues] 완료 ${done}, 실패 ${failed}`);
      if (failed) process.exitCode = 1;
    }
  }
}
