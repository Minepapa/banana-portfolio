#!/usr/bin/env node
// Archive/Imports 원본은 읽기만 하고 Vision 결과는 Vault, 지문 캐시는 저장소에 기록한다.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { writeAtomic, withLock } from '../lib/state-writer.mjs';

const SOURCE = fileURLToPath(new URL('../tools/vision/media-vision.swift', import.meta.url));
const BINARY = fileURLToPath(new URL('../.cache/media-vision', import.meta.url));
const PRINTS = fileURLToPath(new URL('../.cache/vision-prints/', import.meta.url));
const BATCH_SIZE = 200;
const IMAGE = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.png']);
const VIDEO = new Set(['.mov', '.mp4']);
export const DEFAULT_VISION_CONFIG = Object.freeze({ labels: {}, ignore: [], minConfidence: 0.3,
  utilityTextLength: 80, duplicateWindowSec: 120,
  // VNFeaturePrintObservation의 L2 값은 정규화된 사진 지문의 실측값으로 재보정 전까지
  // 매우 가까운 연사만 묶는 보수적 초기값이다. 삭제/이동 판단에는 쓰지 않는다.
  duplicateDistance: 0.35,
  // 재압축 실측 전에는 기존 중복 판정 거리와 같은 보수적 상한만 허용한다.
  // 2026-10-13 재압축 실측: 같은 사진 0.10~0.22, 다른 사진 최소 0.80.
  memoMatchDistance: 0.35, memoMatchMargin: 0.1 });

function jsonLines(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

export function loadVisionConfig(path) {
  if (!existsSync(path)) return { ...DEFAULT_VISION_CONFIG };
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value.labels !== undefined && (!value.labels || typeof value.labels !== 'object' || Array.isArray(value.labels)))
    || (value.labels && Object.values(value.labels).some((label) => typeof label !== 'string'))
    || (value.ignore !== undefined && (!Array.isArray(value.ignore) || !value.ignore.every((item) => typeof item === 'string')))
    || (value.minConfidence !== undefined && (!Number.isFinite(value.minConfidence) || value.minConfidence < 0 || value.minConfidence > 1))
    || (value.utilityTextLength !== undefined && (!Number.isInteger(value.utilityTextLength) || value.utilityTextLength < 0))
    || (value.duplicateWindowSec !== undefined && (!Number.isFinite(value.duplicateWindowSec) || value.duplicateWindowSec < 0))
    || (value.duplicateDistance !== undefined && (!Number.isFinite(value.duplicateDistance) || value.duplicateDistance < 0))
    || (value.memoMatchDistance !== undefined && (!Number.isFinite(value.memoMatchDistance) || value.memoMatchDistance < 0))
    || (value.memoMatchMargin !== undefined && (!Number.isFinite(value.memoMatchMargin) || value.memoMatchMargin < 0))) {
    throw new Error('vision-labels.json 형식 오류');
  }
  return { ...DEFAULT_VISION_CONFIG, ...value };
}

export function selectVisionTargets(records, completed, { source = 'all', limit = 500, ids = null } = {}) {
  const requested = ids ? new Set(ids) : null;
  const candidates = records.filter((record) => {
    const origin = record.importPath ? 'imports' : 'archive';
    if (source !== 'all' && source !== origin) return false;
    if (!record.id || record.duplicateOf || record.screenshot) return false;
    if (requested && !requested.has(record.id)) return false;
    const extension = extname(record.importPath || record.archivePath || '').toLowerCase();
    return IMAGE.has(extension) || VIDEO.has(extension);
  });
  const status = (id) => completed instanceof Map ? completed.get(id) : completed.has(id) ? { schema: 2 } : null;
  return [...candidates.filter((item) => requested?.has(item.id) || (!status(item.id)?.error && (status(item.id)?.schema ?? 0) < 2)),
    ...candidates.filter((item) => !requested?.has(item.id) && status(item.id)?.error && (status(item.id)?.attempts ?? 1) < 3)]
    .slice(0, limit);
}

function safeMediaPath(mediaRoot, record) {
  const relative = record.importPath || record.archivePath;
  const origin = record.importPath ? 'Imports' : 'Archive';
  const base = resolve(mediaRoot, origin);
  const path = resolve(mediaRoot, relative);
  if (!path.startsWith(`${base}${sep}`)) throw new Error(`미디어 경로 오류: ${relative}`);
  return path;
}

export function groupVisionDuplicates(rows, capturedAt, printsPath, config) {
  const sorted = rows.filter((row) => !row.error && Number.isFinite(Date.parse(capturedAt.get(row.id)))
    && Number.isInteger(row.printDims) && row.printDims > 0)
    .sort((a, b) => Date.parse(capturedAt.get(a.id)) - Date.parse(capturedAt.get(b.id)) || a.id.localeCompare(b.id));
  const parent = new Map(sorted.map((row) => [row.id, row.id]));
  const find = (id) => parent.get(id) === id ? id : find(parent.get(id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const prints = new Map();
  const vector = (row) => {
    if (!prints.has(row.id)) {
      const path = join(printsPath, `${row.id}.f32`);
      const data = existsSync(path) ? readFileSync(path) : null;
      prints.set(row.id, data && data.length === row.printDims * 4
        ? new Float32Array(Array.from({ length: row.printDims }, (_, index) => data.readFloatLE(index * 4))) : null);
    }
    return prints.get(row.id);
  };
  for (let i = 0; i < sorted.length; i += 1) {
    for (const id of prints.keys()) if ((Date.parse(capturedAt.get(sorted[i].id)) - Date.parse(capturedAt.get(id))) / 1000 > config.duplicateWindowSec) prints.delete(id);
    for (let j = i + 1; j < sorted.length; j += 1) {
      if ((Date.parse(capturedAt.get(sorted[j].id)) - Date.parse(capturedAt.get(sorted[i].id))) / 1000 > config.duplicateWindowSec) break;
      const representative = find(sorted[i].id);
      if ((Date.parse(capturedAt.get(sorted[j].id)) - Date.parse(capturedAt.get(representative))) / 1000 > config.duplicateWindowSec) continue;
      if (sorted[i].printDims !== sorted[j].printDims) continue;
      const a = vector(sorted[i]);
      const b = vector(sorted[j]);
      if (!a || !b) continue;
      let squared = 0;
      for (let k = 0; k < a.length; k += 1) squared += (a[k] - b[k]) ** 2;
      if (Math.sqrt(squared) <= config.duplicateDistance) parent.set(find(sorted[j].id), representative);
    }
  }
  const groups = new Map();
  for (const row of sorted) {
    const root = find(row.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(row.id);
  }
  for (const row of rows) delete row.duplicateGroup;
  for (const ids of groups.values()) if (ids.length > 1) {
    const earliest = ids[0];
    for (const id of ids) byId.get(id).duplicateGroup = earliest;
  }
  return rows;
}

function ensureBinary(binary = BINARY, source = SOURCE) {
  if (!existsSync(binary) || statSync(binary).mtimeMs < statSync(source).mtimeMs) {
    mkdirSync(dirname(binary), { recursive: true });
    // launchd와 제한된 실행 환경에서는 사용자 홈의 기본 모듈 캐시에 쓸 수 없을 수 있다.
    execFileSync('swiftc', ['-O', source, '-o', binary], { stdio: 'pipe', env: {
      ...process.env, CLANG_MODULE_CACHE_PATH: join(dirname(binary), 'clang-cache'),
      SWIFT_MODULE_CACHE_PATH: join(dirname(binary), 'swift-cache'),
    } });
  }
  return binary;
}

export async function runSwiftVision(inputs, { binary = ensureBinary(), timeoutMs = inputs.length * 30_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', (error) => { failed = true; stderr += error.message; });
    child.on('error', (error) => { failed = true; stderr += error.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const crashed = failed || code !== 0 || !!signal;
      if (crashed) console.error(`[media-vision] Swift 종료 ${signal || code}: ${stderr.slice(0, 500)}`);
      // 강제 종료 때 마지막 JSON은 중간에서 잘렸을 수 있으므로 완료된 줄만 넘긴다.
      const complete = crashed ? stdout.slice(0, stdout.lastIndexOf('\n') + 1) : stdout;
      resolvePromise({ lines: complete.trimEnd() ? complete.trimEnd().split('\n') : [], crashed });
    });
    child.stdin.end(`${inputs.map((input) => JSON.stringify(input)).join('\n')}\n`);
  });
}

export async function runMediaVision({ root = VAULT_PATHS.root, mediaRoot = join(homedir(), 'Pantheon', 'Media'),
  source = 'all', limit = 500, dryRun = false, ids = null,
  indexPath = join(root, VAULT_REL.mediaVisionIndex), printsPath = PRINTS,
  labelsPath = join(root, VAULT_REL.mediaVisionLabels), runner = runSwiftVision,
  write = writeAtomic, output = console, now = new Date().toISOString(), timeoutPerFileMs = 30_000 } = {}) {
  if (!['archive', 'imports', 'all'].includes(source) || !Number.isInteger(limit) || limit < 0
    || (ids && (!Array.isArray(ids) || ids.some((id) => !id)))) throw new Error('media-vision 옵션 오류');
  const records = [
    ...jsonLines(join(root, VAULT_REL.mediaArchiveIndex)),
    ...jsonLines(join(root, VAULT_REL.mediaImportsIndex)),
  ];
  const previous = jsonLines(indexPath);
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const targets = selectVisionTargets(records, previousById, { source, limit, ids });
  if (dryRun) {
    output.log(`[media-vision] dry-run 대상 ${targets.length}`);
    return { selected: targets.length, analyzed: 0, failed: 0 };
  }
  if (!targets.length) {
    output.log('[media-vision] 대상 0');
    return { selected: 0, analyzed: 0, failed: 0 };
  }
  let config;
  try { config = loadVisionConfig(labelsPath); }
  catch (error) {
    output.log(`[media-vision] vision 설정 오류: ${String(error.message).replace(/[\r\n]+/g, ' ')}`);
    config = { ...DEFAULT_VISION_CONFIG };
  }
  mkdirSync(printsPath, { recursive: true });
  for (const record of targets) if (!/^[A-Za-z0-9_-]+$/.test(record.id)) throw new Error(`지문 id 경로 오류: ${record.id}`);
  const inputs = targets.map((record) => ({ id: record.id, path: safeMediaPath(mediaRoot, record),
    kind: VIDEO.has(extname(record.importPath || record.archivePath).toLowerCase()) ? 'video' : 'image',
    printPath: join(printsPath, `${record.id}.f32`) }));
  const results = [];
  const pending = inputs.map((input, index) => ({ input, record: targets[index] }));
  while (pending.length) {
    const batch = pending.splice(0, BATCH_SIZE);
    let response;
    try { response = await runner(batch.map(({ input }) => input), { timeoutMs: batch.length * timeoutPerFileMs }); }
    catch (error) { response = { lines: error.lines ?? [], crashed: true }; }
    const lines = Array.isArray(response) ? response : response.lines ?? [];
    const crashed = !Array.isArray(response) && response.crashed;
    if (lines.length > batch.length) throw new Error(`Vision 출력 행 수 오류: ${lines.length}/${batch.length}`);
    const batchResults = [];
    for (let index = 0; index < Math.min(lines.length, batch.length); index += 1) {
      const result = typeof lines[index] === 'string' ? JSON.parse(lines[index]) : lines[index];
      if (result.id !== batch[index].input.id) throw new Error(`Vision 출력 id 오류: ${batch[index].input.id}`);
      const record = batch[index].record;
      batchResults.push({ id: result.id, schema: 2, source: record.importPath ? 'imports' : 'archive',
      labels: result.labels ?? [], text: result.text ?? '', textLength: result.textLength ?? 0,
      faces: result.faces ?? 0, aesthetic: result.aesthetic ?? null, isUtility: result.isUtility ?? null,
      utility: result.isUtility === true || (result.textLength ?? 0) >= config.utilityTextLength,
      printDims: result.printDims ?? null, frames: result.frames ?? 1, analyzedAt: now,
      ...(result.error ? { error: result.error,
        attempts: (previousById.get(result.id)?.attempts ?? (previousById.get(result.id)?.error ? 1 : 0)) + 1 } : {}) });
    }
    if (lines.length < batch.length) {
      if (!crashed) throw new Error(`Vision 출력 행 수 오류: ${lines.length}/${batch.length}`);
      const missing = batch[lines.length];
      batchResults.push({ id: missing.input.id, schema: 2,
        source: missing.record.importPath ? 'imports' : 'archive', error: 'crash',
        attempts: (previousById.get(missing.input.id)?.attempts
          ?? (previousById.get(missing.input.id)?.error ? 1 : 0)) + 1, analyzedAt: now });
      pending.unshift(...batch.slice(lines.length + 1));
    }
    mkdirSync(dirname(indexPath), { recursive: true });
    await withLock(indexPath, () => {
      const latest = jsonLines(indexPath);
      const byId = new Map(latest.map((row) => [row.id, row]));
      for (const row of batchResults) byId.set(row.id, row);
      const capturedAt = new Map(records.map((record) => [record.id, record.capturedAt]));
      const rows = groupVisionDuplicates([...byId.values()], capturedAt, printsPath, config);
      write(indexPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    });
    for (const row of batchResults) previousById.set(row.id, row);
    results.push(...batchResults);
  }
  const summary = { selected: targets.length, analyzed: results.filter((row) => !row.error).length,
    failed: results.filter((row) => row.error).length };
  output.log(`[media-vision] ${JSON.stringify(summary)}`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const source = args.find((arg) => arg.startsWith('--source='))?.slice(9) ?? 'all';
  const rawLimit = args.find((arg) => arg.startsWith('--limit='))?.slice(8);
  const ids = args.find((arg) => arg.startsWith('--ids='))?.slice(6).split(',') ?? null;
  const limit = rawLimit === undefined ? 500 : Number(rawLimit);
  if (args.some((arg) => !['--dry-run'].includes(arg) && !arg.startsWith('--source=')
    && !arg.startsWith('--limit=') && !arg.startsWith('--ids=')) || !['archive', 'imports', 'all'].includes(source)
    || !Number.isInteger(limit) || limit < 0 || ids?.some((id) => !id)) {
    console.error('usage: node scripts/jobs/media-vision.mjs [--source=archive|imports|all] [--limit=N] [--dry-run] [--ids=a,b]');
    process.exitCode = 2;
  } else runMediaVision({ source, limit, dryRun: args.includes('--dry-run'), ids }).catch((error) => {
    console.error(`[media-vision] ${error.stack}`); process.exitCode = 1;
  });
}
