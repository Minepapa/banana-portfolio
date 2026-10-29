import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTileFetcher, TILE_USER_AGENT } from './osm-tiles.mjs';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const ok = (body) => ({ ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) });

test('타일: 식별 가능한 User-Agent로 받고 캐시해 다시 받지 않는다', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'osm-'));
  try {
    const calls = [];
    const fetcher = createTileFetcher({ cacheDir, fetchImpl: async (url, options) => { calls.push({ url, options }); return ok(png); } });
    assert.deepEqual(await fetcher.get({ z: 15, x: 1, y: 2 }), png);
    assert.deepEqual(await fetcher.get({ z: 15, x: 1, y: 2 }), png);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://tile.openstreetmap.org/15/1/2.png');
    assert.equal(calls[0].options.headers['User-Agent'], TILE_USER_AGENT);
    assert.ok(existsSync(join(cacheDir, '15', '1', '2.png')));
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});

test('타일: 실패·PNG 아님·범위 밖·상한 초과는 null, 오류 응답은 캐시하지 않는다', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'osm-'));
  try {
    const html = createTileFetcher({ cacheDir, fetchImpl: async () => ok(Buffer.from('<html>blocked</html>')) });
    assert.equal(await html.get({ z: 15, x: 3, y: 3 }), null);
    assert.ok(!existsSync(join(cacheDir, '15', '3', '3.png')));
    assert.equal(html.failureCount(), 1);
    const down = createTileFetcher({ cacheDir, fetchImpl: async () => ({ ok: false }) });
    assert.equal(await down.get({ z: 15, x: 4, y: 4 }), null);
    const thrown = createTileFetcher({ cacheDir, fetchImpl: async () => { throw new Error('network'); } });
    assert.equal(await thrown.get({ z: 15, x: 5, y: 5 }), null);
    const calls = [];
    const limited = createTileFetcher({ cacheDir, maxDownloads: 1, fetchImpl: async (url) => { calls.push(url); return ok(png); } });
    assert.equal(await limited.get({ z: 2, x: 9, y: 0 }), null); // 확대 2에서 x는 0~3
    await limited.get({ z: 15, x: 6, y: 6 });
    assert.equal(await limited.get({ z: 15, x: 7, y: 7 }), null);
    assert.equal(calls.length, 1);
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});

test('타일: 한 번 실패하면 그 실행은 더 받지 않고, 요청마다 시간 제한 신호를 단다', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'osm-'));
  try {
    const calls = [];
    const fetcher = createTileFetcher({ cacheDir, fetchImpl: async (url, options) => {
      calls.push(options.signal); throw new Error('timeout'); } });
    assert.equal(await fetcher.get({ z: 15, x: 1, y: 1 }), null);
    assert.equal(await fetcher.get({ z: 15, x: 2, y: 2 }), null);
    assert.equal(calls.length, 1);
    assert.ok(calls[0] instanceof AbortSignal);
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});

test('타일: 반년 지난 캐시는 다시 받고, 받기 실패하면 옛 타일을 쓴다', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'osm-'));
  try {
    const tile = { z: 15, x: 8, y: 8 };
    await createTileFetcher({ cacheDir, fetchImpl: async () => ok(png) }).get(tile);
    const later = () => Date.now() + 200 * 86_400_000;
    let calls = 0;
    const failing = createTileFetcher({ cacheDir, now: later, fetchImpl: async () => { calls += 1; return { ok: false, status: 503 }; } });
    assert.deepEqual(await failing.get(tile), png);
    assert.equal(calls, 1);
    const recent = createTileFetcher({ cacheDir, fetchImpl: async () => { throw new Error('called'); } });
    assert.deepEqual(await recent.get(tile), png);
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});
