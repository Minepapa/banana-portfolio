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
  // documents가 배열이 아닌 응답은 '주소 없음'이 아니라 비정상 응답이다(30일 기억되지 않게 오류로).
  if (!Array.isArray(result?.documents)) throw new Error('카카오 응답 형식 오류');
  const document = result.documents[0];
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

const NO_ADDRESS_TTL_MS = 30 * 86_400_000;

export function createCachedGeocoder({ root, keyPath = KAKAO_KEY_PATH, fetchImpl = fetch } = {}) {
  const path = join(root, VAULT_REL.locationGeocodeCache);
  let failures = 0;
  // 실패 이유별 개수(밤 점검이 "무엇이 왜 실패했는지"를 보여 준다). 좌표는 남기지 않는다.
  const failureReasons = {};
  const fail = (reason) => { failures += 1; failureReasons[reason] = (failureReasons[reason] ?? 0) + 1; };
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
      // 카카오에 주소가 없는 곳(바다·해외 등)은 30일 동안 다시 묻지 않는다(2026-10-25: 같은 6곳을 매시간 다시 물어
      // '지오코딩 실패 6건'이 8일째 이어짐). 30일이 지나면 다시 확인한다.
      if (cached?.noAddressAt && Date.now() - Date.parse(cached.noAddressAt) < NO_ADDRESS_TTL_MS) {
        return { reason: '주소 없음: 카카오' };
      }
      if (cached && typeof cached === 'object' && !Array.isArray(cached) && !cached.noAddressAt
        && (cached.buildingName == null || typeof cached.buildingName === 'string')
        && (cached.address == null || typeof cached.address === 'string')) return cached;
      let key;
      try { key = readKakaoKey(keyPath); }
      catch { fail('키 권한'); return { reason: '주소 미조회: 카카오 키 권한 오류' }; }
      if (!key) { fail('키 없음'); return { reason: '주소 미조회: 카카오 키 없음' }; }
      let result;
      try { result = await reverseGeocode(lat, lon, { key, fetchImpl }); }
      catch { fail('조회 오류'); return { reason: '주소 미조회: 카카오 조회 실패' }; }
      if (!result) {
        // 실패가 아니라 '주소 없음'이라는 답이다: 기억해 두고 세지 않는다.
        cache[coordinateKey] = { noAddressAt: new Date().toISOString() };
        dirty = true;
        return { reason: '주소 없음: 카카오' };
      }
      cache[coordinateKey] = result;
      dirty = true;
      return result;
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
      catch { fail('키 권한'); return null; }
      if (!key) { fail('키 없음'); return null; }
      try {
        const result = await find(key);
        cache[cacheKey] = result;
        dirty = true;
        return result;
      } catch { fail('조회 오류'); return null; }
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
  geocode.failureReasons = () => ({ ...failureReasons });
  return geocode;
}
