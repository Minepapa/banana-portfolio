import { existsSync, lstatSync, readFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { VAULT_REL } from './vault-paths.mjs';
import { writeAtomic } from './state-writer.mjs';

export const KAKAO_KEY_PATH = join(homedir(), '.config', 'banana-portfolio-v2', 'kakao-rest.key');
export function readKakaoKey(path = KAKAO_KEY_PATH) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('카카오 키 파일 소유자 또는 링크 오류');
  if (stat.mode & 0o077) throw new Error('카카오 키 파일 권한은 600이어야 합니다');
  return readFileSync(path, 'utf8').trim() || null;
}
export async function reverseGeocode(lat, lon, { key, fetchImpl = fetch } = {}) {
  if (!key) return null;
  const url = new URL('https://dapi.kakao.com/v2/local/geo/coord2address.json');
  url.searchParams.set('x', String(lon));
  url.searchParams.set('y', String(lat));
  const response = await fetchImpl(url, { headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`카카오 HTTP ${response.status}`);
  const result = await response.json();
  const document = result.documents?.[0];
  return document?.road_address?.building_name || document?.road_address?.address_name || document?.address?.address_name || null;
}
export function createCachedGeocoder({ root, keyPath = KAKAO_KEY_PATH, fetchImpl = fetch } = {}) {
  const path = join(root, VAULT_REL.locationGeocodeCache);
  let failures = 0;
  let cache;
  let dirty = false;
  let pending = Promise.resolve();
  const loadCache = () => {
    if (cache !== undefined) return;
    cache = {};
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('형식 오류');
      cache = parsed;
    } catch {
      const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      renameSync(path, backup);
      console.warn(`[geocode] 캐시 손상, 격리: ${backup}`);
    }
  };
  const geocode = async (lat, lon) => {
    const operation = pending.then(async () => {
      loadCache();
      const coordinateKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
      if (cache[coordinateKey]) return { address: cache[coordinateKey] };
      let key;
      try { key = readKakaoKey(keyPath); }
      catch { failures += 1; return { reason: '주소 미조회: 카카오 키 권한 오류' }; }
      if (!key) { failures += 1; return { reason: '주소 미조회: 카카오 키 없음' }; }
      try {
        const address = await reverseGeocode(lat, lon, { key, fetchImpl });
        if (!address) throw new Error('주소 없음');
        cache[coordinateKey] = address;
        dirty = true;
        return { address };
      } catch { failures += 1; return { reason: '주소 미조회: 카카오 조회 실패' }; }
    });
    pending = operation.then(() => {}, () => {});
    return operation;
  };
  geocode.flush = async () => {
    await pending;
    if (dirty) {
      mkdirSync(dirname(path), { recursive: true });
      writeAtomic(path, `${JSON.stringify(cache, null, 2)}\n`);
      dirty = false;
    }
  };
  geocode.failureCount = () => failures;
  return geocode;
}
