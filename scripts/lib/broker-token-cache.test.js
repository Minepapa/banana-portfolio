import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readBrokerTokenCache, writeBrokerTokenCache, updateBrokerTokenCache } from './broker-token-cache.mjs';

test('구 캐시는 새 파일이 없을 때만 이관하고, 저장 시 만료 항목을 정리한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'broker-cache-test-'));
  const oldPath = join(root, 'old.json');
  const newPath = join(root, 'shared', 'token.json');
  const active = { token: 'valid', expiresAt: Date.now() + 86_400_000 };
  writeFileSync(oldPath, JSON.stringify({ active, expired: { token: 'old', expiresAt: 1 } }));
  assert.deepEqual(readBrokerTokenCache(newPath, oldPath), {
    active, expired: { token: 'old', expiresAt: 1 },
  });
  assert.equal(statSync(oldPath).isFile(), true);
  assert.equal(statSync(newPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, 'shared')).mode & 0o777, 0o700);
  writeBrokerTokenCache(newPath, readBrokerTokenCache(newPath, oldPath));
  assert.deepEqual(JSON.parse(readFileSync(newPath)), { active });
  writeFileSync(oldPath, '{}');
  assert.deepEqual(readBrokerTokenCache(newPath, oldPath), { active });
});

test('동시 갱신은 두 앱키를 모두 보존하고 읽는 쪽은 완전한 JSON만 본다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'broker-cache-race-'));
  const path = join(root, 'shared', 'token.json');
  const legacy = join(root, 'legacy.json');
  const expiry = Date.now() + 86_400_000;
  const writeOne = (key, delay) => updateBrokerTokenCache(path, legacy, async (cache) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    cache[key] = { token: key, expiresAt: expiry };
    return { result: key, changed: true };
  });
  const first = writeOne('one', 30);
  const second = writeOne('two', 0);
  await Promise.all([first, second]);
  assert.deepEqual(Object.keys(readBrokerTokenCache(path, legacy)).sort(), ['one', 'two']);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('테스트에서 환경변수 없는 NH·KIS 기본 캐시와 키 파일 접근을 막는다', () => {
  const nhUrl = new URL('./nhplug.mjs', import.meta.url).href;
  const kisUrl = new URL('./kis.mjs', import.meta.url).href;
  const cacheUrl = new URL('./broker-token-cache.mjs', import.meta.url).href;
  const script = `
    import { join } from 'node:path';
    import { hasNhplugCredentials, loadNhplugCredentials } from ${JSON.stringify(nhUrl)};
    import { hasKisCredentials, loadKisCredentials, loadIrpAccount } from ${JSON.stringify(kisUrl)};
    import { readBrokerTokenCache, writeBrokerTokenCache, updateBrokerTokenCache } from ${JSON.stringify(cacheUrl)};
    const blocked = async (fn) => { try { await fn(); return false; } catch (error) { return /임시 경로 필요/.test(error.message); } };
    const root = join(process.env.HOME, '.config', 'banana-portfolio-v2');
    const checks = await Promise.all([
      blocked(() => hasNhplugCredentials()), blocked(() => loadNhplugCredentials()),
      blocked(() => hasKisCredentials()), blocked(() => loadKisCredentials()), blocked(() => loadIrpAccount()),
      ...['nhplug-token.json', 'kis-token.json'].flatMap((name) => {
        const path = join(root, name);
        return [blocked(() => readBrokerTokenCache(path, path)),
          blocked(() => writeBrokerTokenCache(path, {})),
          blocked(() => updateBrokerTokenCache(path, path, async () => ({ result: null, changed: false })))];
      }),
    ]);
    if (checks.some((check) => !check)) process.exitCode = 1;
  `;
  const env = { ...process.env, NODE_TEST_CONTEXT: 'child-v8' };
  for (const key of ['NHPLUG_KEY_FILE', 'KIS_KEY_FILE', 'NHPLUG_TOKEN_CACHE_FILE', 'KIS_TOKEN_CACHE_FILE']) delete env[key];
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env });
});

test('새 캐시만 임시 경로여도 기본 NH·KIS 구 캐시 이관은 막는다', () => {
  const cacheUrl = new URL('./broker-token-cache.mjs', import.meta.url).href;
  const root = mkdtempSync(join(tmpdir(), 'legacy-cache-guard-'));
  const script = `
    import { dirname, join } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { readBrokerTokenCache, updateBrokerTokenCache } from ${JSON.stringify(cacheUrl)};
    const legacyRoot = join(dirname(fileURLToPath(${JSON.stringify(cacheUrl)})), '..', '.cache');
    for (const name of ['nhplug-token.json', 'kis-token.json']) {
      const path = join(${JSON.stringify(root)}, name);
      const legacyPath = join(legacyRoot, name);
      for (const operation of [
        () => readBrokerTokenCache(path, legacyPath),
        () => updateBrokerTokenCache(path, legacyPath, async () => ({ result: null, changed: false })),
      ]) {
        try { await operation(); process.exitCode = 1; }
        catch (error) { if (!/임시 경로 필요/.test(error.message)) throw error; }
      }
    }
  `;
  const env = { ...process.env, NODE_TEST_CONTEXT: 'child-v8',
    NHPLUG_TOKEN_CACHE_FILE: join(root, 'nhplug-token.json'),
    KIS_TOKEN_CACHE_FILE: join(root, 'kis-token.json') };
  delete env.NHPLUG_LEGACY_TOKEN_CACHE_FILE;
  delete env.KIS_LEGACY_TOKEN_CACHE_FILE;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env });
});
