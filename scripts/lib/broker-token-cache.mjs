// 두 증권사 토큰은 worktree 간 같은 앱키를 공유하므로 저장소 밖 한 경로에 둔다.
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { withLock } from './state-writer.mjs';

function guardTestCachePath(path, legacyPath) {
  if (!process.env.NODE_TEST_CONTEXT) return;
  const home = process.env.HOME;
  if (!process.env.NHPLUG_TOKEN_CACHE_FILE
    && path === join(home, '.config', 'banana-portfolio-v2', 'nhplug-token.json')) {
    throw new Error('테스트에서 NHPLUG_TOKEN_CACHE_FILE 임시 경로 필요');
  }
  if (!process.env.KIS_TOKEN_CACHE_FILE
    && path === join(home, '.config', 'banana-portfolio-v2', 'kis-token.json')) {
    throw new Error('테스트에서 KIS_TOKEN_CACHE_FILE 임시 경로 필요');
  }
  const defaultLegacyRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache');
  if (!process.env.NHPLUG_LEGACY_TOKEN_CACHE_FILE
    && legacyPath === join(defaultLegacyRoot, 'nhplug-token.json')) {
    throw new Error('테스트에서 NHPLUG_LEGACY_TOKEN_CACHE_FILE 임시 경로 필요');
  }
  if (!process.env.KIS_LEGACY_TOKEN_CACHE_FILE
    && legacyPath === join(defaultLegacyRoot, 'kis-token.json')) {
    throw new Error('테스트에서 KIS_LEGACY_TOKEN_CACHE_FILE 임시 경로 필요');
  }
}

function ensureCacheDirectory(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
}

export function readBrokerTokenCache(path, legacyPath) {
  guardTestCachePath(path, legacyPath);
  if (!existsSync(path) && existsSync(legacyPath)) {
    ensureCacheDirectory(path);
    const temporaryPath = `${path}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temporaryPath, readFileSync(legacyPath), { mode: 0o600 });
      // 링크 생성은 이미 새 캐시가 생긴 경우 실패해 이관본이 덮어쓰지 않는다.
      try { linkSync(temporaryPath, path); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } finally { try { unlinkSync(temporaryPath); } catch { /* 정리 오류는 읽기와 분리 */ } }
  }
  try {
    chmodSync(path, 0o600);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function writeBrokerTokenCache(path, cache) {
  guardTestCachePath(path);
  const active = Object.fromEntries(Object.entries(cache).filter(([, value]) =>
    value && typeof value.token === 'string' && Number(value.expiresAt) > Date.now()));
  ensureCacheDirectory(path);
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(active), { mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally { try { unlinkSync(temporaryPath); } catch { /* rename 뒤에는 없음 */ } }
}

// 읽기·토큰 발급·쓰기 전체를 직렬화해 같은 앱키의 중복 발급과 다른 앱키의 갱신 유실을 막는다.
export async function updateBrokerTokenCache(path, legacyPath, update) {
  guardTestCachePath(path, legacyPath);
  ensureCacheDirectory(path);
  return withLock(path, async () => {
    const cache = readBrokerTokenCache(path, legacyPath);
    const { result, changed } = await update(cache);
    if (changed) writeBrokerTokenCache(path, cache);
    return result;
  }, { retries: 300, retryDelayMs: 100 });
}
