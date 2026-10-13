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
  const buildingName = document?.road_address?.building_name || null;
  const address = document?.road_address?.address_name || document?.address?.address_name || null;
  return buildingName || address ? { buildingName, address } : null;
}
export async function regionAt(lat, lon, { key, fetchImpl = fetch } = {}) {
  if (!key) return null;
  const url = new URL('https://dapi.kakao.com/v2/local/geo/coord2regioncode.json');
  url.searchParams.set('x', String(lon));
  url.searchParams.set('y', String(lat));
  const response = await fetchImpl(url, { headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`카카오 HTTP ${response.status}`);
  const result = await response.json();
  return result.documents?.find((document) => document.region_type === 'H')?.region_3depth_name || null;
}

export async function searchMerchant(merchant, lat, lon, { key, fetchImpl = fetch } = {}) {
  if (!key) return null;
  const url = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
  url.searchParams.set('query', merchant);
  url.searchParams.set('x', String(lon));
  url.searchParams.set('y', String(lat));
  url.searchParams.set('radius', '500');
  const response = await fetchImpl(url, { headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`카카오 HTTP ${response.status}`);
  const result = await response.json();
  const place = result.documents?.[0];
  return place ? { name: place.place_name, category: place.category_group_code } : null;
}
export async function searchCategory(category, lat, lon, { key, fetchImpl = fetch } = {}) {
  if (!key) return null;
  const url = new URL('https://dapi.kakao.com/v2/local/search/category.json');
  url.searchParams.set('category_group_code', category);
  url.searchParams.set('x', String(lon));
  url.searchParams.set('y', String(lat));
  url.searchParams.set('radius', '40');
  url.searchParams.set('sort', 'distance');
  const response = await fetchImpl(url, { headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`카카오 HTTP ${response.status}`);
  const place = (await response.json()).documents?.[0];
  return place ? { name: place.place_name, category: place.category_group_code, distance: Number(place.distance) } : null;
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
      const cached = cache[coordinateKey];
      if (cached && typeof cached === 'object' && !Array.isArray(cached)
        && (cached.buildingName == null || typeof cached.buildingName === 'string')
        && (cached.address == null || typeof cached.address === 'string')) return cached;
      let key;
      try { key = readKakaoKey(keyPath); }
      catch { failures += 1; return { reason: '주소 미조회: 카카오 키 권한 오류' }; }
      if (!key) { failures += 1; return { reason: '주소 미조회: 카카오 키 없음' }; }
      try {
        const result = await reverseGeocode(lat, lon, { key, fetchImpl });
        if (!result) throw new Error('주소 없음');
        cache[coordinateKey] = result;
        dirty = true;
        return result;
      } catch { failures += 1; return { reason: '주소 미조회: 카카오 조회 실패' }; }
    });
    pending = operation.then(() => {}, () => {});
    return operation;
  };
  const lookup = (cacheKey, find) => {
    const operation = pending.then(async () => {
      loadCache();
      if (Object.hasOwn(cache, cacheKey)) return cache[cacheKey];
      let key;
      try { key = readKakaoKey(keyPath); }
      catch { failures += 1; return null; }
      if (!key) { failures += 1; return null; }
      try {
        const result = await find(key);
        cache[cacheKey] = result;
        dirty = true;
        return result;
      } catch { failures += 1; return null; }
    });
    pending = operation.then(() => {}, () => {});
    return operation;
  };
  geocode.region = (lat, lon) => lookup(`region:${lat.toFixed(4)},${lon.toFixed(4)}`,
    (key) => regionAt(lat, lon, { key, fetchImpl }));
  geocode.keyword = (merchant, lat, lon) => lookup(`keyword:${merchant}:${lat.toFixed(4)},${lon.toFixed(4)}`,
    (key) => searchMerchant(merchant, lat, lon, { key, fetchImpl }));
  geocode.nearbyPlace = async (lat, lon) => {
    const place = await lookup(`poi:${lat.toFixed(4)},${lon.toFixed(4)}`, async (key) => {
      const categories = ['AT4', 'CT1', 'AD5', 'FD6', 'CE7', 'HP8', 'SC4'];
      const places = await Promise.all(categories.map((category) => searchCategory(category, lat, lon, { key, fetchImpl })));
      return places.filter((place) => place && Number.isFinite(place.distance))
        .sort((a, b) => a.distance - b.distance)[0] ?? null;
    });
    return place?.category === 'PS3' ? null : place;
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
