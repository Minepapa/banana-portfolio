// 영상 원본은 읽기만 한다. 프레임과 캐시는 Media/VideoFrames에 비공개로 둔다.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.avi', '.mkv', '.webm']);
export const VIDEO_FRAME_ROOT = join(homedir(), 'Pantheon', 'Media', 'VideoFrames');

export function safeVideoPath(mediaRoot, record) {
  const pathPart = record.importPath || record.archivePath;
  const origin = record.importPath ? 'Imports' : 'Archive';
  if (!record.id || !/^[A-Za-z0-9_-]+$/.test(record.id) || typeof pathPart !== 'string'
    || !pathPart.startsWith(`${origin}/`) || !VIDEO_EXTENSIONS.has(extname(pathPart).toLowerCase())) {
    throw new Error('영상 id 또는 경로 오류');
  }
  const base = resolve(mediaRoot, origin);
  const path = resolve(mediaRoot, pathPart);
  const within = (parent, child) => {
    const rel = relative(parent, child);
    return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
  };
  if (!within(base, path) || !within(realpathSync(base), realpathSync(path))) throw new Error('영상 원본 경로 오류');
  return path;
}

export function frameTimes(durationSec, maxFrames = 30) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('영상 길이 오류');
  const count = Math.min(maxFrames, Math.max(1, Math.ceil(durationSec)));
  return [...new Set(Array.from({ length: count }, (_, index) => {
    const time = count === 1 ? 0 : index * (durationSec - Math.min(0.1, durationSec / 100)) / (count - 1);
    return Math.floor(time);
  }))];
}

export async function probeVideo(path, { run = exec, timeoutMs = 30_000 } = {}) {
  const { stdout } = await run('nice', ['-n', '10', '/opt/homebrew/bin/ffprobe', '-v', 'error', '-show_entries',
    'format=duration', '-of', 'json', path], { timeout: Math.min(30_000, timeoutMs) });
  const durationSec = Number(JSON.parse(stdout).format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('영상 길이 없음');
  return durationSec;
}

export async function extractVideoFrames(record, { mediaRoot = join(homedir(), 'Pantheon', 'Media'),
  frameRoot = VIDEO_FRAME_ROOT, probe = probeVideo, run = exec, deadline = Infinity } = {}) {
  const original = safeVideoPath(mediaRoot, record);
  const source = statSync(original);
  const directory = join(frameRoot, record.id);
  const manifestPath = join(directory, 'manifest.json');
  const stamp = { size: source.size, mtimeMs: Math.round(source.mtimeMs) };
  if (existsSync(manifestPath)) {
    try {
      const saved = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (saved.id === record.id && saved.original === (record.importPath || record.archivePath)
        && saved.size === stamp.size && saved.mtimeMs === stamp.mtimeMs
        && saved.frames?.every((frame) => frame.id === `${record.id}@${frame.second}`
          && frame.path === join(directory, `${frame.second}.jpg`) && existsSync(frame.path))) return saved;
    } catch { /* 불완전한 캐시를 재생성 */ }
  }
  const probeRemaining = deadline - Date.now();
  if (probeRemaining <= 0) throw new Error('영상 길이 확인 시간 예산 초과');
  const durationSec = await probe(original, { run, timeoutMs: Math.min(30_000, probeRemaining) });
  const seconds = frameTimes(durationSec);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const frames = [];
  for (const second of seconds) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('프레임 시간 예산 초과');
    const destination = join(directory, `${second}.jpg`);
    const temporary = join(directory, `.${second}.${process.pid}.jpg`);
    try {
      await run('nice', ['-n', '10', '/opt/homebrew/bin/ffmpeg', '-nostdin', '-loglevel', 'error', '-ss', String(second), '-i', original,
        '-frames:v', '1', '-vf', 'scale=768:768:force_original_aspect_ratio=decrease', '-q:v', '3', '-y', temporary],
      { timeout: Math.min(60_000, remaining) });
      if (!existsSync(temporary)) throw new Error(`프레임 누락: ${second}`);
      chmodSync(temporary, 0o600);
      renameSync(temporary, destination);
    } finally { rmSync(temporary, { force: true }); }
    frames.push({ id: `${record.id}@${second}`, second, path: destination });
  }
  const finalSource = statSync(original);
  if (finalSource.size !== stamp.size || Math.round(finalSource.mtimeMs) !== stamp.mtimeMs) {
    throw new Error('추출 중 영상 원본 변경');
  }
  const manifest = { id: record.id, original: record.importPath || record.archivePath,
    ...stamp, durationSec, frames };
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  renameSync(temporary, manifestPath);
  chmodSync(manifestPath, 0o600);
  return manifest;
}
