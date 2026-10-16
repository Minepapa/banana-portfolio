#!/usr/bin/env node
// 결정 미디어-삭제-판정 §4-1: 원본 읽기 전용 측정. 삭제·이동 기능 없음.
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { MEDIA_RECORDINGS_PATHS, VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { mediaKind } from '../lib/media-delete-core.mjs';

const MEDIA = MEDIA_RECORDINGS_PATHS.mediaRoot;
const OUTPUT = join(MEDIA, 'Quality', 'quality.jsonl');
const FRAME_SIZE = 64 * 64;
export function lines(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
}
export function cacheHit(cached, stat) {
  return cached?.sourceSize === stat.size && cached?.sourceMtimeMs === stat.mtimeMs && !cached.error;
}
export function sourcePath(record, mediaRoot = MEDIA) {
  const relative = record.importPath || record.archivePath;
  const root = resolve(mediaRoot, record.importPath ? 'Imports' : 'Archive');
  const path = resolve(mediaRoot, relative || '');
  if (!relative || !path.startsWith(`${root}${sep}`)) throw new Error(`원본 경로 오류: ${relative}`);
  return path;
}
function run(command, args, timeout = 20_000, maxBuffer = 64 * 1024 * 1024) {
  const result = spawnSync('/usr/bin/nice', ['-n', '10', command, ...args], { timeout, maxBuffer });
  if (result.error || result.status !== 0) throw new Error(String(result.error?.message || result.stderr).slice(0, 300));
  return result.stdout;
}
export function frameMetrics(raw) {
  if (!raw.length || raw.length % FRAME_SIZE) throw new Error('프레임 측정 불완전');
  let sum = 0, sharpness = 0, dark = true;
  const frames = raw.length / FRAME_SIZE;
  for (let start = 0; start < raw.length; start += FRAME_SIZE) {
    let frameSum = 0, lapSum = 0, lapSquared = 0, count = 0;
    for (let pixel = start; pixel < start + FRAME_SIZE; pixel += 1) frameSum += raw[pixel];
    if (frameSum / FRAME_SIZE >= 3) dark = false;
    sum += frameSum;
    for (let y = 1; y < 63; y += 1) for (let x = 1; x < 63; x += 1) {
      const offset = start + y * 64 + x;
      const lap = 4 * raw[offset] - raw[offset - 1] - raw[offset + 1] - raw[offset - 64] - raw[offset + 64];
      lapSum += lap; lapSquared += lap * lap; count += 1;
    }
    sharpness += lapSquared / count - (lapSum / count) ** 2;
  }
  return { meanBrightness: sum / raw.length, sharpness: sharpness / frames,
    measuredFrames: frames, allFramesDark: dark, allFramesMeasured: true };
}
// 사진은 첫 프레임 1장만. 옵션 순서: 입력 → 스트림 선택(-map 0:v:0) → 프레임 수 → 필터 → 출력.
export function frameArgs(path, kind) {
  return ['-v', 'error', '-i', path, '-map', '0:v:0', ...(kind === 'photo' ? ['-frames:v', '1'] : []),
    '-vf', 'scale=64:64,format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'];
}
export function measure(path, kind) {
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path]).toString());
  const args = frameArgs(path, kind);
  const metrics = frameMetrics(run('ffmpeg', args));
  return { ...metrics, durationSec: kind === 'video' ? Number(probe.format?.duration) : null,
    hasAudio: kind === 'video' ? probe.streams?.some((stream) => stream.codec_type === 'audio') : null };
}
export function targets(archive, imports, cache, { limit = 500, ids = null } = {}) {
  const requested = ids ? new Set(ids) : null;
  return [...archive, ...imports].filter((record) => record.id && mediaKind(record)
    && (!requested || requested.has(record.id)))
    .filter((record) => {
      let path;
      try { path = sourcePath(record); } catch { return false; } // 잘못된 경로 1건이 전체 실행을 막지 않게
      if (!existsSync(path)) return false;
      return !cacheHit(cache.get(record.id), statSync(path));
    }).slice(0, limit);
}
export function parseArgs(argv) {
  const result = { limit: 500, ids: null, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg.startsWith('--limit=')) result.limit = Number(arg.slice(8));
    else if (arg === '--limit') result.limit = Number(argv[++index]);
    else if (arg.startsWith('--ids=')) result.ids = arg.slice(6).split(',');
    else if (arg === '--ids') result.ids = String(argv[++index]).split(',');
    else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 10000) throw new Error('--limit 범위 오류');
  return result;
}
// 남은 잠금 파일 정리: 기록된 PID가 없거나 2시간이 지났으면 오래된 잠금으로 본다.
export function clearStaleLock(lock, { now = Date.now(), alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
  if (!existsSync(lock)) return false;
  let info = {};
  try { info = JSON.parse(readFileSync(lock, 'utf8') || '{}'); } catch {}
  if (info.pid && alive(info.pid) && now - (info.startedAt ?? 0) < 2 * 3_600_000) return false;
  unlinkSync(lock);
  return true;
}
export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const cache = new Map(lines(OUTPUT).map((row) => [row.id, row]));
  const selected = targets(lines(VAULT_PATHS.mediaArchiveIndex),
    lines(join(VAULT_PATHS.root, VAULT_REL.mediaImportsIndex)), cache, options);
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, selected: selected.length, ids: selected.map((row) => row.id) }));
    return;
  }
  mkdirSync(join(MEDIA, 'Quality'), { recursive: true, mode: 0o700 });
  const lock = join(MEDIA, 'Quality', 'measure.lock');
  clearStaleLock(lock);
  const fd = openSync(lock, 'wx', 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const release = () => { try { closeSync(fd); } catch {} try { unlinkSync(lock); } catch {} };
  const onSignal = () => { release(); process.exit(130); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  let measuredSinceSave = 0;
  const save = () => {
    // 원자적 저장: 임시 파일에 쓰고 이름을 바꾼다(쓰는 중 멈춰도 기존 결과가 깨지지 않음).
    const temporary = `${OUTPUT}.tmp-${process.pid}`;
    writeFileSync(temporary, [...cache.values()].map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    renameSync(temporary, OUTPUT);
  };
  try {
    const deadline = Date.now() + 10 * 60_000;
    for (const record of selected) {
      if (Date.now() >= deadline) break;
      const path = sourcePath(record), stat = statSync(path);
      let result;
      try { result = measure(path, mediaKind(record)); }
      catch (error) { result = { error: String(error.message).slice(0, 300) }; }
      cache.set(record.id, { id: record.id, sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs, ...result });
      if (++measuredSinceSave >= 200) { save(); measuredSinceSave = 0; } // 중간 저장
    }
    save();
    console.log(JSON.stringify({ measured: selected.length, errors: [...cache.values()].filter((row) => row.error).length }));
  } finally { release(); process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
