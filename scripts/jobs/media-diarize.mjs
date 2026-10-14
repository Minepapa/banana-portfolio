#!/usr/bin/env node
// 통화 화자 분리(pyannote, 맥 안에서만 — D52).
// --trial: 엔진 비교 시험(결과는 Media/Diarize/trial). --apply: 본 처리 → 95_Etna/Media/Speakers + 통화 노트 대화 형식.
// '나' 목소리는 후보를 만든 뒤 오너 확인(--confirm-owner)으로만 등록한다. 목소리 특징값은 볼트 밖에만 둔다.
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, lstatSync, readdirSync, renameSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MEDIA_DIARIZE_PATHS, VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { writeAtomic, withLock } from '../lib/state-writer.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import { renderDialogue, counterpartFromNote } from '../lib/media-dialogue.mjs';
import { detectRepetition } from './media-transcribe.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../tools/diarize/media_diarize.py', import.meta.url));
const ID = /^[a-f0-9]{16}$/i;

export function selectTrial(records, { ids = null, limit = 10 } = {}) {
  const eligible = records.filter((item) => item.kind === 'Calls' && item.transcript?.segments?.length
    && item.transcript.durationSec >= 30 && item.transcript.durationSec <= 600
    && ['미네', '휘영'].includes(item.counterpart));
  if (ids) {
    const byId = new Map(eligible.map((item) => [item.id, item]));
    return ids.map((id) => {
      if (!byId.has(id)) throw new Error(`시험 대상 아님: ${id}`);
      return byId.get(id);
    });
  }
  const sorted = eligible.sort((a, b) => Date.parse(b.transcript.occurred) - Date.parse(a.transcript.occurred));
  const chosen = [];
  const days = new Set();
  const each = new Set();
  const add = (item) => {
    const day = item.transcript.occurred.slice(0, 10);
    if (days.has(day) || chosen.length >= limit) return;
    chosen.push(item);
    days.add(day);
    each.add(item.counterpart);
  };
  for (const item of sorted) {
    if (!each.has(item.counterpart)) add(item);
  }
  for (const item of sorted) {
    add(item);
  }
  return chosen;
}

export function combineSegments(segments, turns) {
  const mapped = segments.map((segment) => {
    const scores = { S0: 0, S1: 0 };
    for (const turn of turns) {
      if (!(turn.speaker in scores)) continue;
      scores[turn.speaker] += Math.max(0, Math.min(segment.end, turn.end) - Math.max(segment.start, turn.start));
    }
    const speaker = scores.S1 > scores.S0 ? 'S1' : 'S0';
    const overlap = scores[speaker];
    return { ...segment, speaker, uncertain: segment.end <= segment.start
      || overlap < (segment.end - segment.start) * 0.5 };
  });
  const utterances = [];
  for (const segment of mapped) {
    const last = utterances.at(-1);
    if (last?.speaker === segment.speaker) {
      last.end = segment.end;
      last.text = `${last.text} ${segment.text}`.trim();
      last.uncertain ||= segment.uncertain;
      last.segmentCount += 1;
    } else {
      utterances.push({ start: segment.start, end: segment.end, text: segment.text,
        speaker: segment.speaker, uncertain: segment.uncertain, segmentCount: 1 });
    }
  }
  return { segments: mapped, utterances };
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0; let left = 0; let right = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; left += a[i] ** 2; right += b[i] ** 2; }
  return left && right ? dot / Math.sqrt(left * right) : -1;
}

export function findOwner(calls) {
  if (calls.length < 2 || new Set(calls.map((call) => call.counterpart)).size < 2) {
    throw new Error('오너 자동 판정에는 서로 다른 상대의 통화가 필요함');
  }
  if (calls.length > 20) throw new Error('오너 후보 완전 탐색 최대 20건');
  const pairs = [];
  const adjacent = Array.from({ length: calls.length }, () => []);
  for (let i = 0; i < calls.length; i += 1) {
    for (let j = i + 1; j < calls.length; j += 1) {
      if (calls[i].counterpart === calls[j].counterpart) continue;
      const matrix = [[cosine(calls[i].voices[0], calls[j].voices[0]),
        cosine(calls[i].voices[0], calls[j].voices[1])],
      [cosine(calls[i].voices[1], calls[j].voices[0]),
        cosine(calls[i].voices[1], calls[j].voices[1])]];
      const pair = { i, j, matrix };
      pairs.push(pair);
      adjacent[i].push(pair);
      adjacent[j].push(pair);
    }
  }
  const scores = new Float64Array(2 ** calls.length);
  let sum = pairs.reduce((total, pair) => total + pair.matrix[0][0], 0);
  scores[0] = sum;
  let bestMask = 0;
  let bestScore = sum;
  // Gray 순서에서는 한 화자 선택만 바뀌므로 관련 통화 쌍의 표만 조회한다.
  for (let step = 1; step < scores.length; step += 1) {
    const mask = step ^ (step >> 1);
    const previous = (step - 1) ^ ((step - 1) >> 1);
    const changed = Math.log2(mask ^ previous);
    for (const pair of adjacent[changed]) {
      const oldI = (previous >> pair.i) & 1;
      const oldJ = (previous >> pair.j) & 1;
      const newI = (mask >> pair.i) & 1;
      const newJ = (mask >> pair.j) & 1;
      sum += pair.matrix[newI][newJ] - pair.matrix[oldI][oldJ];
    }
    scores[mask] = sum;
    if (sum > bestScore) { bestScore = sum; bestMask = mask; }
  }
  return calls.map((call, index) => {
    const owner = (bestMask >> index) & 1;
    // 나머지 통화 배정은 고정하고, 해당 통화의 화자만 뒤집었을 때 점수 차이.
    const flipped = scores[bestMask ^ (1 << index)];
    return { id: call.id, owner: `S${owner}`, counterpart: call.counterpart,
      // 그 통화가 걸린 쌍 수로 나눠 통화 수와 무관한 '쌍당' 여유로 만든다.
      margin: (bestScore - flipped) / Math.max(1, adjacent[index].length), score: bestScore / pairs.length };
  });
}

export function parsePythonOutput(text, items, backend) {
  const rows = text.trim() ? text.trim().split(/\r?\n/).map((line) => JSON.parse(line)) : [];
  const ids = new Set(items.map((item) => item.id));
  const found = new Map();
  for (const row of rows) {
    if (!ids.has(row.id) || found.has(row.id)) throw new Error('파이썬 결과 ID 오류/중복');
    if (!row.error && (row.backend !== backend || !Array.isArray(row.turns)
      || !Number.isFinite(row.ms) || !Number.isFinite(row.audioSec)
      || row.turns.some((turn) => !['S0', 'S1'].includes(turn.speaker)
        || !Number.isFinite(turn.start) || !Number.isFinite(turn.end) || turn.end <= turn.start))) {
      throw new Error(`파이썬 결과 형식 오류: ${row.id}`);
    }
    found.set(row.id, row);
  }
  return items.map((item) => found.get(item.id) || { id: item.id, error: '파이썬 결과 누락' });
}

export async function runPython(backend, items, { python = MEDIA_DIARIZE_PATHS.python,
  voicesDir = MEDIA_DIARIZE_PATHS.voices,
  signal,
  spawnProcess = spawn, lowPriority = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:HF|HUGGINGFACE|HUGGING_FACE).*TOKEN$/i.test(key)));
    const child = spawnProcess(lowPriority ? 'nice' : python,
      lowPriority ? ['-n', '10', python, SCRIPT] : [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], signal,
      env: { ...environment, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYANNOTE_METRICS_ENABLED: '0' } });
    let stdout = ''; let stderr = '';
    let spawnError = null;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (code) => {
      if (spawnError) { rejectPromise(spawnError); return; }
      if (code !== 0) { rejectPromise(new Error(`화자 엔진 실패: ${stderr.slice(0, 500)}`)); return; }
      try { resolvePromise(parsePythonOutput(stdout, items, backend)); }
      catch (error) { rejectPromise(error); }
    });
    child.stdin.end(`${JSON.stringify({ backend, items, numSpeakers: 2, voicesDir })}\n`);
  });
}

export function availableBackends(requested, pyannoteReady) {
  if (requested === 'sherpa') return ['sherpa'];
  if (requested === 'pyannote') {
    if (!pyannoteReady) throw new Error('pyannote 모델 없음 — setup.sh와 HF 토큰 필요');
    return ['pyannote'];
  }
  if (requested !== 'both') throw new Error('backend 값 오류');
  return pyannoteReady ? ['sherpa', 'pyannote'] : ['sherpa'];
}

function readNpy(path) {
  const data = readFileSync(path);
  if (data.toString('latin1', 0, 6) !== '\x93NUMPY') throw new Error('npy 형식 오류');
  const major = data[6];
  const headerLength = major < 2 ? data.readUInt16LE(8) : data.readUInt32LE(8);
  const start = major < 2 ? 10 : 12;
  const header = data.toString('latin1', start, start + headerLength);
  const dtype = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const shape = /'shape':\s*\((\d+),\s*(\d+)\)/.exec(header);
  if (!shape || !['<f4', '<f8'].includes(dtype)) throw new Error('npy 형식 오류');
  const count = Number(shape[1]) * Number(shape[2]);
  const offset = start + headerLength;
  const width = dtype === '<f4' ? 4 : 8;
  if (data.length < offset + count * width) throw new Error('npy 길이 오류');
  const numbers = Array.from({ length: count }, (_, i) => dtype === '<f4'
    ? data.readFloatLE(offset + i * width) : data.readDoubleLE(offset + i * width));
  return Array.from({ length: Number(shape[1]) }, (_, i) => numbers.slice(i * Number(shape[2]), (i + 1) * Number(shape[2])));
}

function safeAudioPath(mediaRoot, archivePath) {
  if (typeof archivePath !== 'string' || !archivePath.startsWith('Archive/')) throw new Error('Archive 경로 오류');
  const base = resolve(mediaRoot, 'Archive');
  if (existsSync(base) && lstatSync(base).isSymbolicLink()) throw new Error('Archive 심볼릭 링크');
  const path = resolve(mediaRoot, archivePath);
  const inside = relative(base, path);
  if (!inside || inside.startsWith('..') || inside.startsWith(sep)) throw new Error('Archive 경로 오류');
  let current = base;
  for (const part of inside.split(sep)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Archive 심볼릭 링크');
  }
  return path;
}

function loadCandidates(root, mediaRoot) {
  const index = readFileSync(join(root, VAULT_REL.mediaArchiveIndex), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  return index.filter((item) => item.kind === 'Calls' && ID.test(item.id)).flatMap((item) => {
    const transcriptRoot = join(root, VAULT_REL.mediaTranscripts);
    const year = item.occurred?.slice(0, 4);
    const years = readdirSync(transcriptRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name)).map((entry) => entry.name);
    const candidates = year ? [year, ...years.filter((value) => value !== year)] : years;
    const transcriptPath = candidates.map((candidate) => join(transcriptRoot, candidate, `${item.id}.json`))
      .find((path) => existsSync(path));
    if (!transcriptPath) return [];
    const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8'));
    return [{ ...item, transcript, transcriptPath, counterpart: transcript.people?.find((name) => ['미네', '휘영'].includes(name)),
      mediaRoot }];
  });
}

function agreement(a, b) {
  const count = Math.min(a.segments.length, b.segments.length);
  if (!count) return null;
  let same = 0;
  for (let i = 0; i < count; i += 1) {
    if (a.segments[i].name === b.segments[i].name) same += 1;
  }
  return same / count;
}

export async function runTrial({ root = VAULT_PATHS.root, paths = MEDIA_DIARIZE_PATHS,
  ids = null, limit = 10, backend = 'both', output = console, runWorker = runPython,
  exec = execFileAsync, signal } = {}) {
  const pyannoteReady = existsSync(join(paths.pyannote, 'speaker-diarization-community-1', 'config.yaml'));
  const backends = availableBackends(backend, pyannoteReady);
  if (backend === 'both' && !pyannoteReady) output.warn('pyannote 모델 없음 — sherpa만 시험');
  const selected = selectTrial(loadCandidates(root, paths.mediaRoot), { ids, limit });
  if (!selected.length) throw new Error('시험 대상 통화 없음');
  const temporary = await fs.mkdtemp(join(tmpdir(), 'media-diarize-'));
  const controller = new AbortController();
  const abort = () => controller.abort();
  const onInterrupt = () => { process.exitCode = 130; abort(); };
  const onTerminate = () => { process.exitCode = 143; abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  const results = new Map();
  try {
    const items = [];
    for (const item of selected) {
      controller.signal.throwIfAborted();
      let path;
      try { path = safeAudioPath(item.mediaRoot, item.archivePath); }
      catch (error) { output.warn(`${item.id}: ${error.message}`); continue; }
      if (!existsSync(path)) { output.warn(`음성 없음: ${item.id}`); continue; }
      const wav = join(temporary, `${item.id}.wav`);
      await exec('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', path,
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
      { timeout: 300_000, signal: controller.signal });
      items.push({ id: item.id, wav });
    }
    for (const name of backends) {
      controller.signal.throwIfAborted();
      let rows;
      try { rows = await runWorker(name, items, { voicesDir: paths.voices, signal: controller.signal }); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        output.warn(`${name}: ${error.message}`);
        continue;
      }
      const successes = [];
      for (const row of rows) {
        if (row.error) { output.warn(`${name} ${row.id}: ${row.error}`); continue; }
        const item = selected.find((candidate) => candidate.id === row.id);
        const voicePath = join(paths.voices, name, `${row.id}.npy`);
        const voices = readNpy(voicePath);
        if (voices.length !== 2) { output.warn(`${name} ${row.id}: 화자 특징값 2개 아님`); continue; }
        successes.push({ ...row, voices, counterpart: item.counterpart,
          combined: combineSegments(item.transcript.segments, row.turns) });
      }
      if (successes.length < 2 || new Set(successes.map((row) => row.counterpart)).size < 2) {
        output.warn(`${name}: 오너 판정에 필요한 서로 다른 상대 통화 부족`);
        continue;
      }
      const owners = new Map(findOwner(successes).map((row) => [row.id, row]));
      const completed = successes.map((row) => {
        const owner = owners.get(row.id);
        const segments = row.combined.segments.map((segment) => ({ ...segment,
          name: segment.speaker === owner.owner ? '나' : row.counterpart }));
        const utterances = row.combined.utterances.map((turn) => ({ ...turn,
          name: turn.speaker === owner.owner ? '나' : row.counterpart }));
        return { id: row.id, backend: name, turns: row.turns, segments, utterances,
          owner: owner.owner, counterpart: row.counterpart, margin: owner.margin,
          ms: row.ms, audioSec: row.audioSec,
          uncertainRate: segments.filter((segment) => segment.uncertain).length / segments.length,
          shortTurnRate: row.turns.filter((turn) => turn.end - turn.start < 1000).length / row.turns.length };
      });
      results.set(name, completed);
      const directory = join(paths.trial, name);
      mkdirSync(directory, { recursive: true });
      for (const row of completed) {
        writeFileSync(join(directory, `${row.id}.json`), `${JSON.stringify(row, null, 2)}\n`);
        writeFileSync(join(directory, `${row.id}.md`),
          `# ${row.id} · ${name}\n\n${row.utterances.map((turn) => `${turn.name}: ${turn.text}${turn.uncertain ? ' [?]' : ''}`).join('\n')}\n`);
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    await fs.rm(temporary, { recursive: true, force: true });
  }
  mkdirSync(paths.trial, { recursive: true });
  const lines = ['# 통화 화자 분리 시험', '', '| 엔진 | ID | 처리 초 | 실시간 배율 | 나 판정 여유 | uncertain | 1초 미만 발화 | 엔진 일치 |',
    '|---|---|---:|---:|---:|---:|---:|---:|'];
  for (const [name, rows] of results) {
    for (const row of rows) {
      const other = results.get(name === 'sherpa' ? 'pyannote' : 'sherpa')?.find((value) => value.id === row.id);
      const match = other ? `${(agreement(row, other) * 100).toFixed(1)}%` : '—';
      lines.push(`| ${name} | ${row.id} | ${(row.ms / 1000).toFixed(1)} | ${(row.ms / 1000 / row.audioSec).toFixed(2)}× | ${row.margin.toFixed(3)} | ${(row.uncertainRate * 100).toFixed(1)}% | ${(row.shortTurnRate * 100).toFixed(1)}% | ${match} |`);
    }
  }
  writeFileSync(join(paths.trial, 'summary.md'), `${lines.join('\n')}\n`);
  output.log(lines.join('\n'));
  if (!results.size) throw new Error('시험 성공 통화가 부족해 오너를 판정하지 못함');
  return results;
}

// 영구 실패(화자 2명 아님 등)는 같은 전사 버전에서 다시 고르지 않는다. 일시 실패는 3회까지.
export const MAX_ATTEMPTS = 3;
// 통화 자체의 문제만 영구 실패로 본다. 엔진 프로세스 실패(메모리 등 일시 장애)는 시도 횟수로만 센다.
const FINAL_ERROR = /^(?:화자 특징값 2개 아님|expected two speakers|oversized |Archive 경로 오류|Archive 심볼릭 링크)/;

function failureBlocks(state, item) {
  const failure = state?.failures?.[item.id];
  return Boolean(failure && failure.transcribedAt === item.transcript.transcribedAt
    && (failure.final || failure.attempts >= MAX_ATTEMPTS));
}

export function selectApply(records, saved, { ids = null, limit = 20, maxMinutes = 50, state = null } = {}) {
  // 음성 없음(speech 거짓) 전사는 대화 형식으로 바꾸지 않는다 — 전사 잡의 "(음성 없음)"과 맞춘다.
  const eligible = records.filter((item) => item.kind === 'Calls' && ID.test(item.id)
    && item.transcript?.kind === 'Calls' && item.transcript.speech
    && Array.isArray(item.transcript.segments)
    && item.transcript.segments.length && Number.isFinite(item.transcript.durationSec)
    && item.transcript.transcribedAt && (!saved.get(item.id)
      || saved.get(item.id).transcribedAt !== item.transcript.transcribedAt)
    && !failureBlocks(state, item));
  const filtered = ids ? eligible.filter((item) => ids.includes(item.id)) : eligible;
  filtered.sort((a, b) => Date.parse(b.transcript.occurred) - Date.parse(a.transcript.occurred));
  const chosen = [];
  chosen.oversized = [];
  let seconds = 0;
  for (const item of filtered) {
    if (chosen.length >= limit) break;
    if (item.transcript.durationSec > maxMinutes * 60) {
      // 긴 한 건이 뒤 통화를 가로막지 않도록 따로 모은다(실패가 아니라 건너뜀으로 기록).
      chosen.oversized.push(item);
      continue;
    }
    if (seconds + item.transcript.durationSec > maxMinutes * 60) continue;
    chosen.push(item);
    seconds += item.transcript.durationSec;
  }
  if (ids && chosen.length !== ids.length) throw new Error('지정한 ID 중 대상이 아니거나 시간 상한 초과');
  return chosen;
}

function npyBuffer(matrix) {
  if (!matrix.length || !matrix[0].length || matrix.some((row) => row.length !== matrix[0].length
    || row.some((value) => !Number.isFinite(value)))) throw new Error('목소리 벡터 형식 오류');
  const headerText = `{'descr': '<f4', 'fortran_order': False, 'shape': (${matrix.length}, ${matrix[0].length}), }`;
  const padding = (16 - (10 + headerText.length + 1) % 16) % 16;
  const header = Buffer.from(`${headerText}${' '.repeat(padding)}\n`, 'latin1');
  const output = Buffer.alloc(10 + header.length + matrix.length * matrix[0].length * 4);
  output.write('\x93NUMPY', 0, 'latin1'); output[6] = 1; output[7] = 0;
  output.writeUInt16LE(header.length, 8); header.copy(output, 10);
  let offset = 10 + header.length;
  for (const row of matrix) for (const value of row) { output.writeFloatLE(value, offset); offset += 4; }
  return output;
}

function writePrivate(path, content) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}

function normalized(vector) {
  const length = Math.hypot(...vector);
  if (!length) throw new Error('빈 목소리 벡터');
  return vector.map((value) => value / length);
}

// 여유(두 화자 유사도 차)가 작거나, 더 비슷한 쪽도 등록 목소리와 멀면(둘 다 '나'가 아닐 수 있음) 확인 필요.
export const OWNER_MARGIN_MIN = 0.05;
export function identifyOwner(voices, mean, { minSimilarity = -1 } = {}) {
  const similarities = voices.map((voice) => cosine(normalized(voice), normalized(mean)));
  const index = similarities[1] > similarities[0] ? 1 : 0;
  const margin = Math.abs(similarities[0] - similarities[1]);
  const check = margin < OWNER_MARGIN_MIN || similarities[index] < minSimilarity;
  return { speaker: `S${index}`, margin, similarity: similarities[index], check: check ? '필요' : undefined };
}

// 등록 목소리는 오너 확인으로만 바뀐다(자동 갱신 없음 — 틀린 '나'가 강화되며 흘러가는 것을 막는다).
// 시험 호환용으로만 남긴다.
export function updateOwnerMean(mean, voice, count) {
  const weight = Math.min(1 / 20, 1 / Math.max(8, count + 1));
  const oldUnit = normalized(mean); const nextUnit = normalized(voice);
  return normalized(oldUnit.map((value, index) => value * (1 - weight) + nextUnit[index] * weight));
}

function speakerYear(item) {
  // media-transcribe 노트 렌더와 같은 기준(전사 원본의 occurred)으로 연도 폴더를 정한다.
  return String(item.transcript.occurred || item.occurred).slice(0, 4);
}

function speakerFile(root, item) {
  return join(root, VAULT_REL.mediaSpeakers, speakerYear(item), `${item.id}.json`);
}

function savedSpeakers(root) {
  const base = join(root, VAULT_REL.mediaSpeakers);
  const found = new Map();
  if (!existsSync(base)) return found;
  for (const year of readdirSync(base).filter((name) => /^\d{4}$/.test(name))) {
    for (const filename of readdirSync(join(base, year)).filter((name) => /^[a-f0-9]{16}\.json$/i.test(name))) {
      try {
        const row = JSON.parse(readFileSync(join(base, year, filename), 'utf8'));
        found.set(row.id, row);
      } catch { /* 깨진 파일은 다시 처리되도록 없는 것으로 본다 */ }
    }
  }
  return found;
}

function indexNotes(root) {
  const base = join(root, VAULT_REL.mediaConversations);
  const found = new Map();
  if (!existsSync(base)) return found;
  for (const year of readdirSync(base).filter((name) => /^\d{4}$/.test(name))) {
    for (const filename of readdirSync(join(base, year)).filter((name) => name.endsWith('.md'))) {
      const path = join(base, year, filename);
      const content = readFileSync(path, 'utf8');
      for (const match of content.matchAll(/<!-- media-transcribe:id ([a-f0-9]{16}) -->/gi)) found.set(match[1], path);
    }
  }
  return found;
}

export function renderSpeakerNote(existing, transcript, speakers, fallback) {
  const marker = `<!-- media-transcribe:id ${speakers.id} -->`;
  const start = existing.indexOf(marker);
  if (start < 0 || existing.indexOf(marker, start + marker.length) >= 0) throw new Error('노트 통화 ID 오류');
  const autoStart = existing.indexOf('<!-- media-transcribe:start -->');
  const autoEnd = existing.indexOf('<!-- media-transcribe:end -->');
  if (autoStart < 0 || autoEnd < 0 || start < autoStart || start > autoEnd) throw new Error('노트 자동 구역 밖 통화 ID');
  const source = existing.indexOf('\n원본:', start);
  if (source < 0 || source > autoEnd) throw new Error('노트 원본 표식 없음');
  const headingEnd = existing.indexOf('\n\n', start);
  if (headingEnd < 0 || headingEnd > source) throw new Error('노트 제목 표식 없음');
  const prior = parseFrontmatter(existing);
  if (prior.type !== 'conversation' || prior.origin !== 'media-transcribe') throw new Error('노트 소유권 오류');
  const dialogue = renderDialogue(transcript, speakers, counterpartFromNote(prior, fallback),
    { looped: detectRepetition(transcript.text).looped });
  if (!dialogue) return existing;
  const prefix = existing.slice(0, headingEnd + 2);
  const suffix = existing.slice(source);
  return `${prefix}${dialogue}\n${suffix}`;
}

// 한 노트(하루·상대별)에 통화가 여럿이면 모두 반영한 뒤 한 번만 쓴다(LiveSync 연속 쓰기 방지).
async function refreshNotes(root, items, saved, { dryRun, write, rules, notePaths, output, summary }) {
  const byNote = new Map();
  for (const item of items) {
    const speakers = saved.get(item.id);
    if (!speakers?.segments?.length || speakers.transcribedAt !== item.transcript.transcribedAt) continue;
    const path = notePaths.get(item.id);
    if (!path) continue;
    if (!byNote.has(path)) byNote.set(path, []);
    byNote.get(path).push({ item, speakers });
  }
  for (const [path, entries] of byNote) {
    try {
      const before = readFileSync(path, 'utf8');
      let next = before;
      for (const { item, speakers } of entries) {
        const latest = JSON.parse(readFileSync(item.transcriptPath, 'utf8'));
        if (latest.transcribedAt !== speakers.transcribedAt) throw new Error(`노트 쓰기 전 전사 갱신: ${item.id}`);
        next = renderSpeakerNote(next, latest, speakers, item.counterpart);
      }
      if (next === before) continue;
      const rel = relative(root, path).split(sep).join('/');
      const problems = checkNote(rel, next, rules);
      if (problems.length) throw new Error(`대화 노트 쓰기 관문: ${problems.join('; ')}`);
      if (!dryRun) await withLock(path, () => {
        if (readFileSync(path, 'utf8') !== before) throw new Error('쓰기 전 대화 노트 변경');
        write(path, next);
      });
      summary.notes += 1;
    } catch (error) {
      summary.failed += 1;
      output.error(`[media-diarize] 노트 ${relative(root, path)}: ${error.message}`);
    }
  }
}

function readOwner(paths) {
  if (!existsSync(paths.ownerVoice) || !existsSync(paths.ownerMeta)) return null;
  const meta = JSON.parse(readFileSync(paths.ownerMeta, 'utf8'));
  if (!meta.version) throw new Error('오너 목소리 메타에 version 없음 — --confirm-owner로 다시 등록');
  return { mean: readNpy(paths.ownerVoice)[0], meta };
}

function assignSpeakers(item, turns, voices, owner, now) {
  if (voices.length !== 2) throw new Error('화자 특징값 2개 아님');
  const result = identifyOwner(voices, owner.mean, { minSimilarity: owner.meta.minSimilarity ?? -1 });
  return { id: item.id, engine: 'pyannote', model: 'pyannote/speaker-diarization-community-1',
    diarizedAt: now.toISOString(), transcribedAt: item.transcript.transcribedAt, turns,
    segments: combineSegments(item.transcript.segments, turns).segments.map((segment, i) => ({
      i, speaker: segment.speaker === result.speaker ? 'owner' : 'other', uncertain: segment.uncertain,
    })), ownerMargin: result.margin, ownerVersion: owner.meta.version,
    ...(result.check ? { check: result.check } : {}) };
}

function voicePathFor(paths, id) {
  return join(paths.voices, 'pyannote', `${id}.npy`);
}

// '나' 등록 후보: 상대마다 60초 이상 통화 3건 이상, 상대 2명 이상. 상대별로 최근 순 번갈아 최대 20건.
export function enrollmentCalls(rows, { perCounterpart = 3, minSeconds = 60, max = 20 } = {}) {
  const groups = new Map();
  for (const row of [...rows].sort((a, b) => Date.parse(b.occurred) - Date.parse(a.occurred))) {
    if (!row.counterpart || !(row.durationSec >= minSeconds)) continue;
    if (!groups.has(row.counterpart)) groups.set(row.counterpart, []);
    groups.get(row.counterpart).push(row);
  }
  const eligible = [...groups.values()].filter((list) => list.length >= perCounterpart);
  if (eligible.length < 2) return [];
  const chosen = [];
  for (let round = 0; chosen.length < max; round += 1) {
    let added = false;
    for (const list of eligible) {
      if (list[round] && chosen.length < max) { chosen.push(list[round]); added = true; }
    }
    if (!added) break;
  }
  return chosen;
}

// 품질 관문: findOwner 통화별 여유의 중앙값·최솟값과, 고른 '나' 목소리끼리의 평균 유사도.
export const ENROLL_GATE = { medianMargin: 0.04, minMargin: 0.01, ownerCohesion: 0.3 };
export const ENROLL_STRONG_MARGIN = 0.1;
export function evaluateEnrollment(calls) {
  const owners = findOwner(calls);
  const ownerVoices = calls.map((call, i) => normalized(call.voices[owners[i].owner === 'S1' ? 1 : 0]));
  const margins = owners.map((row) => row.margin).sort((a, b) => a - b);
  const median = margins[Math.floor(margins.length / 2)];
  let total = 0; let count = 0;
  for (let i = 0; i < ownerVoices.length; i += 1) {
    for (let j = i + 1; j < ownerVoices.length; j += 1) { total += cosine(ownerVoices[i], ownerVoices[j]); count += 1; }
  }
  const cohesion = count ? total / count : 0;
  // 기준 목소리는 '나' 판정이 또렷한 통화로만 만든다(여유가 작은 통화 — 예: 다른 가족이 오너 폰으로 건 통화 — 제외).
  const strong = ownerVoices.filter((_, i) => owners[i].margin >= ENROLL_STRONG_MARGIN);
  const basis = strong.length >= 6 ? strong : ownerVoices;
  const mean = normalized(basis[0].map((_, k) => basis.reduce((sum, voice) => sum + voice[k], 0)));
  const similarities = basis.map((voice) => cosine(voice, mean)).sort((a, b) => a - b);
  const reasons = [];
  if (median < ENROLL_GATE.medianMargin) reasons.push(`여유 중앙값 ${median.toFixed(3)} < ${ENROLL_GATE.medianMargin}`);
  if (margins[0] < ENROLL_GATE.minMargin) reasons.push(`여유 최솟값 ${margins[0].toFixed(3)} < ${ENROLL_GATE.minMargin}`);
  if (cohesion < ENROLL_GATE.ownerCohesion) reasons.push(`'나' 목소리 응집 ${cohesion.toFixed(3)} < ${ENROLL_GATE.ownerCohesion}`);
  return { owners, mean, median, minMargin: margins[0], cohesion, basisCount: basis.length,
    // 확정 뒤 '나'로 볼 최소 유사도: 등록 통화 중 가장 낮은 값보다 0.1 낮게(하한 0.2).
    minSimilarity: Math.min(0.5, Math.max(0.2, similarities[0] - 0.1)), passed: reasons.length === 0, reasons };
}

// 후보가 없거나, 관문 미달 후보인데 그 뒤 처리된 통화가 늘었으면 다시 만든다.
function candidateStale(paths, records, saved) {
  if (!existsSync(paths.ownerCandidateMeta)) return true;
  try {
    const meta = JSON.parse(readFileSync(paths.ownerCandidateMeta, 'utf8'));
    if (meta.passed) return false;
    const done = records.filter((item) => saved.get(item.id)?.transcribedAt === item.transcript.transcribedAt).length;
    return done > (meta.processedCount ?? 0);
  } catch { return true; }
}

function buildCandidate(root, records, saved, paths, now, output) {
  const rows = records.filter((item) => {
    const speakers = saved.get(item.id);
    return speakers && speakers.transcribedAt === item.transcript.transcribedAt
      && item.transcript.speech && existsSync(voicePathFor(paths, item.id));
  }).map((item) => ({ id: item.id, item, counterpart: item.counterpart, occurred: item.transcript.occurred,
    durationSec: item.transcript.durationSec }));
  const chosen = enrollmentCalls(rows);
  if (!chosen.length) return null;
  const calls = chosen.map((row) => ({ ...row, voices: readNpy(voicePathFor(paths, row.id)) }))
    .filter((call) => call.voices.length === 2);
  if (calls.length < 6) return null;
  const result = evaluateEnrollment(calls);
  const lines = [`# '나' 목소리 등록 후보 (${now.toISOString()})`, '',
    `- 통화 ${calls.length}건, 상대 ${[...new Set(calls.map((call) => call.counterpart))].join('·')}`,
    `- 여유 중앙값 ${result.median.toFixed(3)} · 최솟값 ${result.minMargin.toFixed(3)} · '나' 응집 ${result.cohesion.toFixed(3)}`,
    `- 기준 목소리에 쓴 통화: 여유 ${ENROLL_STRONG_MARGIN} 이상 ${result.basisCount}건(나머지는 판정만 참고)`,
    `- 품질 관문: ${result.passed ? '통과' : `미달 — ${result.reasons.join(', ')}`}`, '',
    '확인 뒤 등록: `node scripts/jobs/media-diarize.mjs --confirm-owner`', ''];
  calls.forEach((call, i) => {
    const owner = result.owners[i];
    const combined = combineSegments(call.item.transcript.segments, saved.get(call.id).turns);
    lines.push(`## ${call.occurred.slice(0, 16)} ${call.counterpart} (여유 ${owner.margin.toFixed(3)})`, '');
    for (const turn of combined.utterances.slice(0, 6)) {
      lines.push(`- ${turn.speaker === owner.owner ? '나' : call.counterpart}: ${turn.text.slice(0, 80)}${turn.uncertain ? ' [?]' : ''}`);
    }
    lines.push('');
  });
  writePrivate(paths.ownerCandidate, npyBuffer([result.mean]));
  writePrivate(paths.ownerCandidateMeta, JSON.stringify({ createdAt: now.toISOString(), calls: calls.map((call) => call.id),
    processedCount: records.filter((item) => saved.get(item.id)?.transcribedAt === item.transcript.transcribedAt).length,
    median: result.median, minMargin: result.minMargin, cohesion: result.cohesion,
    minSimilarity: result.minSimilarity, passed: result.passed, reasons: result.reasons }));
  writePrivate(paths.ownerReview, `${lines.join('\n')}\n`);
  output.log(`[media-diarize] '나' 등록 후보 작성(${result.passed ? '관문 통과' : '관문 미달'}) — 오너 확인 필요: ${paths.ownerReview}`);
  return result;
}

export async function confirmOwner({ paths = MEDIA_DIARIZE_PATHS, now = new Date(), output = console } = {}) {
  if (!existsSync(paths.ownerCandidate) || !existsSync(paths.ownerCandidateMeta)) throw new Error('등록 후보 없음 — --apply가 후보를 먼저 만든다');
  const candidate = JSON.parse(readFileSync(paths.ownerCandidateMeta, 'utf8'));
  if (!candidate.passed) throw new Error(`후보가 품질 관문 미달: ${candidate.reasons.join(', ')}`);
  writePrivate(paths.ownerVoice, readFileSync(paths.ownerCandidate));
  writePrivate(paths.ownerMeta, JSON.stringify({ version: now.toISOString(), confirmedAt: now.toISOString(),
    callCount: candidate.calls.length, calls: candidate.calls, minSimilarity: candidate.minSimilarity,
    median: candidate.median, cohesion: candidate.cohesion }));
  output.log(`[media-diarize] '나' 목소리 등록(통화 ${candidate.calls.length}건). 다음 --apply가 저장된 통화를 다시 배정하고 노트를 고친다.`);
  return { confirmed: true };
}

function loadState(paths) {
  try { return JSON.parse(readFileSync(paths.state, 'utf8')); } catch { return { failures: {} }; }
}

function recordFailure(state, item, message, { final = false, process = false } = {}) {
  const old = state.failures[item.id];
  const attempts = old && old.transcribedAt === item.transcript.transcribedAt ? old.attempts + 1 : 1;
  state.failures[item.id] = { transcribedAt: item.transcript.transcribedAt, attempts,
    final: final || (!process && FINAL_ERROR.test(message)), lastError: String(message).slice(0, 300) };
}

export async function runApply({ root = VAULT_PATHS.root, paths = MEDIA_DIARIZE_PATHS,
  ids = null, limit = 20, maxMinutes = 50, dryRun = false, renderNotes = false,
  output = console, runWorker = runPython, exec = execFileAsync, write = writeAtomic,
  now = new Date(), temporaryRoot = tmpdir(), registryRules, callTimeoutMs = 30 * 60_000,
  clock = () => Date.now(), allowNight = false } = {}) {
  // 01~08시 전사 잡과 겹치지 않게(2026-10-15 오너): 00~07시에는 새 통화 처리를 하지 않고(--ids 수동 지정 제외),
  // 한 회차는 시작 후 maxMinutes+15분이 지나면 새 통화를 시작하지 않는다.
  const kstHour = (new Date(now.getTime() + 9 * 3_600_000)).getUTCHours();
  const nightBlocked = !allowNight && !ids && kstHour < 8;
  const deadline = clock() + (maxMinutes + 15) * 60_000;
  const records = loadCandidates(root, paths.mediaRoot);
  const rules = registryRules ?? parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  const run = async () => {
    const summary = { processed: 0, notes: 0, failed: 0, skipped: 0, reassigned: 0, remaining: 0 };
    const saved = savedSpeakers(root);
    const notePaths = indexNotes(root);
    const state = loadState(paths);
    const owner = readOwner(paths);
    const persist = (item, speakers) => {
      const path = speakerFile(root, item);
      mkdirSync(join(path, '..'), { recursive: true });
      write(path, `${JSON.stringify(speakers, null, 2)}\n`);
      saved.set(item.id, speakers);
    };
    if (!renderNotes && nightBlocked) output.log('[media-diarize] 00~07시는 전사 시간대 — 새 통화 처리 건너뜀');
    if (!renderNotes && !nightBlocked) {
      const chosen = selectApply(records, saved, { ids, limit, maxMinutes, state });
      summary.remaining = records.filter((item) => item.transcript.speech && item.transcript.segments?.length
        && saved.get(item.id)?.transcribedAt !== item.transcript.transcribedAt && !failureBlocks(state, item)).length
        - chosen.length - chosen.oversized.length;
      if (dryRun) {
        output.log(`[media-diarize] dry-run ${JSON.stringify(chosen.map((item) => item.id))}, 긴 통화 건너뜀 ${chosen.oversized.length}, 남음 ${summary.remaining}`);
        return summary;
      }
      for (const item of chosen.oversized) {
        recordFailure(state, item, `oversized ${item.transcript.durationSec}초`, { final: true });
        summary.skipped += 1;
      }
      if (chosen.length && !existsSync(join(paths.pyannote, 'speaker-diarization-community-1', 'config.yaml')))
        throw new Error('pyannote 모델 없음 — 대체 엔진 사용 안 함');
      const controller = new AbortController();
      const interrupt = () => { process.exitCode = 130; controller.abort(); };
      const terminate = () => { process.exitCode = 143; controller.abort(); };
      process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
      try {
        for (const item of chosen) {
          if (controller.signal.aborted) break;
          if (clock() > deadline) { output.log('[media-diarize] 회차 시간 상한 — 남은 통화는 다음 회차로'); break; }
          const temporary = await fs.mkdtemp(join(temporaryRoot, 'media-diarize-'));
          // 통화마다 따로 시간 제한 — 한 건의 시간 초과가 남은 통화를 끊지 않는다.
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(callTimeoutMs)]);
          try {
            const audio = safeAudioPath(paths.mediaRoot, item.archivePath);
            if (!existsSync(audio)) throw new Error('음성 없음');
            const wav = join(temporary, `${item.id}.wav`);
            await exec('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', audio,
              '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { timeout: 300_000, signal });
            let rows;
            try {
              rows = await runWorker('pyannote', [{ id: item.id, wav }], {
                voicesDir: paths.voices, signal, lowPriority: true });
            } catch (error) { error.processFailure = true; throw error; }
            if (rows[0]?.error) throw new Error(rows[0].error);
            if (rows[0]?.id !== item.id || !Array.isArray(rows[0]?.turns)) throw new Error('화자 결과 오류');
            const latest = JSON.parse(readFileSync(item.transcriptPath, 'utf8'));
            if (latest.transcribedAt !== item.transcript.transcribedAt) throw new Error('처리 중 전사 갱신');
            const voices = readNpy(voicePathFor(paths, item.id));
            if (voices.length !== 2) throw new Error('화자 특징값 2개 아님');
            persist(item, owner ? assignSpeakers(item, rows[0].turns, voices, owner, now) : {
              id: item.id, engine: 'pyannote', model: 'pyannote/speaker-diarization-community-1',
              diarizedAt: now.toISOString(), transcribedAt: item.transcript.transcribedAt,
              turns: rows[0].turns, segments: [], ownerMargin: null });
            delete state.failures[item.id];
            summary.processed += 1;
          } catch (error) {
            if (controller.signal.aborted) throw error;
            recordFailure(state, item, error.message, { process: Boolean(error.processFailure) });
            const blocked = failureBlocks(state, item);
            if (blocked) summary.skipped += 1; else summary.failed += 1;
            output.error(`[media-diarize] ${item.id}: ${error.message}${blocked ? ' (다시 시도하지 않음)' : ''}`);
          } finally { await fs.rm(temporary, { recursive: true, force: true }); }
        }
      } finally {
        process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
        try {
          mkdirSync(paths.root, { recursive: true });
          writeAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`);
        } catch (error) { output.error(`[media-diarize] 실패 기록 저장: ${error.message}`); }
      }
    }
    if (owner) {
      // 등록 전에 처리했거나 등록 버전이 바뀐 통화는 저장된 구간·특징값으로 다시 배정한다(pyannote 재실행 없음).
      for (const item of records) {
        const old = saved.get(item.id);
        if (!old || old.transcribedAt !== item.transcript.transcribedAt
          || (old.segments?.length && old.ownerVersion === owner.meta.version)) continue;
        if (!existsSync(voicePathFor(paths, item.id))) { summary.skipped += 1; continue; }
        try {
          const voices = readNpy(voicePathFor(paths, item.id));
          const next = assignSpeakers(item, old.turns, voices, owner, now);
          if (!dryRun) persist(item, next); else saved.set(item.id, next);
          summary.reassigned += 1;
        } catch (error) { summary.failed += 1; output.error(`[media-diarize] 재배정 ${item.id}: ${error.message}`); }
      }
      await refreshNotes(root, records, saved, { dryRun, write, rules, notePaths, output, summary });
    } else if (!renderNotes && candidateStale(paths, records, saved)) {
      try { buildCandidate(root, records, saved, paths, now, output); }
      catch (error) { summary.failed += 1; output.error(`[media-diarize] 등록 후보: ${error.message}`); }
    }
    output.log(`[media-diarize] 처리 ${summary.processed}, 재배정 ${summary.reassigned}, 노트 ${summary.notes}, 실패 ${summary.failed}, 건너뜀 ${summary.skipped}, 남음 ${summary.remaining}${owner ? '' : ", '나' 미등록(노트 변경 없음)"}`);
    return summary;
  };
  if (dryRun) return run();
  mkdirSync(paths.root, { recursive: true });
  try {
    // 밤 전사 잡과 같은 상태 잠금을 함께 잡는다 — 둘이 동시에 무거운 작업을 하지 않게.
    return await withLock(join(paths.root, '.media-diarize'), () =>
      withLock(join(root, VAULT_REL.mediaTranscribeState), run, { retries: 0 }), { retries: 0 });
  } catch (error) {
    if (/락 획득 실패/.test(error.message)) {
      output.log('[media-diarize] 다른 미디어 작업 실행 중 — 이번 회차 건너뜀');
      return { processed: 0, notes: 0, failed: 0, skipped: 0, reassigned: 0, remaining: 0, busy: true };
    }
    throw error;
  }
}

export function parseArgs(args) {
  const options = {};
  for (const arg of args) {
    if (arg === '--trial') options.trial = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--render-notes') options.renderNotes = true;
    else if (arg === '--confirm-owner') options.confirmOwner = true;
    else if (arg === '--allow-night') options.allowNight = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--ids=')) options.ids = arg.slice(6).split(',');
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8));
    else if (arg.startsWith('--max-minutes=')) options.maxMinutes = Number(arg.slice(14));
    else if (arg.startsWith('--backend=')) options.backend = arg.slice(10);
    else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  if ([options.trial, options.apply, options.renderNotes, options.confirmOwner].filter(Boolean).length !== 1
    || options.confirmOwner && Object.keys(options).length !== 1
    || options.trial && options.dryRun || options.renderNotes && (options.ids || options.limit || options.maxMinutes)
    || options.trial && (options.apply || options.renderNotes || options.maxMinutes)
    || options.trial && options.ids && options.limit !== undefined
    || options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 20)
    || options.ids && (options.ids.length < 1 || options.ids.length > 20
      || new Set(options.ids).size !== options.ids.length)
    || options.ids?.some((id) => !ID.test(id))
    || options.maxMinutes !== undefined && (!Number.isFinite(options.maxMinutes) || options.maxMinutes <= 0))
    throw new Error('--trial 또는 --apply [--limit=N] [--max-minutes=M] [--ids=...] [--dry-run] 또는 --render-notes [--dry-run] 또는 --confirm-owner 필요');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  // launchd(run.sh)는 인자 없이 부른다 → 정기 실행 기본값.
  const argv = process.argv.slice(2);
  try { options = parseArgs(argv.length ? argv : ['--apply', '--limit=20', '--max-minutes=45']); }
  catch (error) { console.error(`[media-diarize] ${error.message}`); process.exitCode = 2; }
  if (options) (options.trial ? runTrial(options) : options.confirmOwner ? confirmOwner() : runApply(options)).then((summary) => {
    if (summary?.failed) process.exitCode = 1;
  }).catch((error) => {
    console.error(`[media-diarize] ${error.message}`);
    if (!process.exitCode) process.exitCode = 1;
  });
}
