import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCachedGeocoder, searchCategory } from './kakao-geocode.mjs';
import { VAULT_REL } from './vault-paths.mjs';

function fixture(t, results) {
  const root = mkdtempSync(join(tmpdir(), 'kakao-poi-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keyPath = join(root, 'key');
  writeFileSync(keyPath, 'fake-key', { mode: 0o600 });
  const calls = [];
  const fetchImpl = async (url) => {
    const code = url.searchParams.get('category_group_code');
    calls.push({ code, radius: url.searchParams.get('radius'), sort: url.searchParams.get('sort') });
    return { ok: true, json: async () => ({ documents: results[code] ?? [] }) };
  };
  return { root, keyPath, calls, fetchImpl };
}

test('카카오 카테고리 검색은 거리·코드·이름을 반환하고 HTTP 오류를 전파한다', async () => {
  const found = await searchCategory('FD6', 37, 127, { key: 'fake', fetchImpl: async (url) => {
    assert.equal(url.searchParams.get('x'), '127');
    assert.equal(url.searchParams.get('y'), '37');
    return { ok: true, json: async () => ({ documents: [{ place_name: '식당', category_group_code: 'FD6', distance: '12' }] }) };
  } });
  assert.deepEqual(found, { name: '식당', category: 'FD6', distance: 12 });
  await assert.rejects(searchCategory('FD6', 37, 127,
    { key: 'fake', fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
});

test('가장 가까운 POI를 택하고 동률이면 코드 순서, null도 캐시한다', async (t) => {
  const f = fixture(t, {
    AT4: [{ place_name: '관광지', category_group_code: 'AT4', distance: '20' }],
    FD6: [{ place_name: '식당', category_group_code: 'FD6', distance: '10' }],
    CE7: [{ place_name: '카페', category_group_code: 'CE7', distance: '10' }],
  });
  const geocode = createCachedGeocoder(f);
  assert.deepEqual(await geocode.nearbyPlace(37, 127), { name: '식당', category: 'FD6', distance: 10 });
  assert.equal(f.calls.length, 7);
  assert.ok(f.calls.every((call) => call.code !== 'PS3'));
  assert.ok(f.calls.every((call) => call.radius === '40' && call.sort === 'distance'));
  assert.equal((await geocode.nearbyPlace(37, 127)).name, '식당');
  assert.equal(f.calls.length, 7);
  await geocode.flush();
  const path = join(f.root, VAULT_REL.locationGeocodeCache);
  assert.equal(JSON.parse(readFileSync(path, 'utf8'))['poi:37.0000,127.0000'].name, '식당');

  const empty = fixture(t, {});
  const emptyGeocode = createCachedGeocoder(empty);
  assert.equal(await emptyGeocode.nearbyPlace(37, 127), null);
  assert.equal(await emptyGeocode.nearbyPlace(37, 127), null);
  assert.equal(empty.calls.length, 7);
  await emptyGeocode.flush();
  assert.equal(JSON.parse(readFileSync(join(empty.root, VAULT_REL.locationGeocodeCache), 'utf8'))['poi:37.0000,127.0000'], null);
});

test('PS3 검색 결과와 기존 캐시의 PS3는 장소로 쓰지 않는다', async (t) => {
  const f = fixture(t, { PS3: [{ place_name: '단지 어린이집', category_group_code: 'PS3', distance: '1' }],
    CE7: [{ place_name: '카페', category_group_code: 'CE7', distance: '12' }] });
  const cachePath = join(f.root, VAULT_REL.locationGeocodeCache);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ 'poi:37.0000,127.0000': { name: '단지 어린이집', category: 'PS3', distance: 1 } }));
  const geocode = createCachedGeocoder(f);
  assert.equal(await geocode.nearbyPlace(37, 127), null);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await geocode.nearbyPlace(37.001, 127), { name: '카페', category: 'CE7', distance: 12 });
  assert.equal(f.calls.length, 7);
  assert.ok(f.calls.every((call) => call.code !== 'PS3'));
});

test('카카오에 주소가 없는 좌표는 실패로 세지 않고 기억해 다시 묻지 않으며, 조회 오류는 이유별로 센다', async (t) => {
  const { root, keyPath } = fixture(t, {});
  let calls = 0;
  const empty = async () => { calls += 1; return { ok: true, json: async () => ({ documents: [] }) }; };
  const first = createCachedGeocoder({ root, keyPath, fetchImpl: empty });
  assert.equal((await first(33.1, 126.1)).reason, '주소 없음: 카카오');
  assert.equal(first.failureCount(), 0);
  await first.flush();
  const again = createCachedGeocoder({ root, keyPath, fetchImpl: empty });
  const before = calls;
  assert.equal((await again(33.1, 126.1)).reason, '주소 없음: 카카오');
  assert.equal(calls, before, '30일 안에는 다시 묻지 않는다');
  const broken = createCachedGeocoder({ root, keyPath, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  await broken(35.2, 129.2);
  assert.equal(broken.failureCount(), 1);
  assert.deepEqual(broken.failureReasons(), { '조회 오류': 1 });
});
