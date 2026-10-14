#!/usr/bin/env node
// 수동 시험 전용. Vault와 Archive는 읽기만 하고 결과는 Media/Diarize에 쓴다.
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MEDIA_DIARIZE_PATHS, VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';

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
      margin: (bestScore - flipped) / pairs.length, score: bestScore / pairs.length };
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
  spawnProcess = spawn } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:HF|HUGGINGFACE|HUGGING_FACE).*TOKEN$/i.test(key)));
    const child = spawnProcess(python, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], signal,
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
    return [{ ...item, transcript, counterpart: transcript.people?.find((name) => ['미네', '휘영'].includes(name)),
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

export function parseArgs(args) {
  const options = {};
  for (const arg of args) {
    if (arg === '--trial') options.trial = true;
    else if (arg.startsWith('--ids=')) options.ids = arg.slice(6).split(',');
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8));
    else if (arg.startsWith('--backend=')) options.backend = arg.slice(10);
    else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  if (!options.trial || options.ids && options.limit !== undefined
    || options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 20)
    || options.ids && (options.ids.length < 1 || options.ids.length > 20
      || new Set(options.ids).size !== options.ids.length)
    || options.ids?.some((id) => !ID.test(id))) throw new Error('--trial 및 --limit=1..20 또는 --ids=ID,ID 필요');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTrial(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(`[media-diarize] ${error.message}`);
    if (!process.exitCode) process.exitCode = 1;
  });
}
