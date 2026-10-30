import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTestIsolation, buildGateSpawnEnv, loadGateConfig } from './telegram-gate-config.mjs';

// 실제 설정 파일은 쓰지 않는다 — 임시 폴더에 가짜 .env·access.json을 만든다.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-config-'));
  const paths = {
    liveEnv: join(dir, 'live.env'),
    access: join(dir, 'access.json'),
    testEnv: join(dir, 'test.env'),
    liveStateDir: join(dir, 'live-state'),
    testStateDir: join(dir, 'test-state'),
  };
  writeFileSync(paths.liveEnv, 'TELEGRAM_BOT_TOKEN=FAKE:live\n');
  writeFileSync(paths.access, JSON.stringify({ allowFrom: ['31337'] }));
  return { dir, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('시험 모드: 시험 env 토큰과 access.json 허용 사용자를 쓰고, 하트비트는 볼트에 쓰지 않는다', () => {
  const { paths, cleanup } = fixture();
  try {
    writeFileSync(paths.testEnv, 'TELEGRAM_BOT_TOKEN=FAKE:test\n');
    const cfg = loadGateConfig({ mode: 'test', env: {}, paths });
    assert.deepEqual(cfg.config, { botToken: 'FAKE:test', chatId: '31337' });
    assert.deepEqual([...cfg.allowFrom], ['31337']);
    assert.equal(cfg.stateDir, paths.testStateDir);
    assert.equal(cfg.heartbeatJob, null);
    assert.equal(cfg.vaultRoot, join(paths.testStateDir, 'vault'));
  } finally { cleanup(); }
});

test('시험 모드: 실제 봇 .env를 가리키면(직접·심볼릭 링크) 거부하고 실제 설정 로더를 부르지 않는다', () => {
  const { dir, paths, cleanup } = fixture();
  try {
    const loadLive = () => { throw new Error('실제 설정을 읽으면 안 됨'); };
    assert.throws(() => loadGateConfig({ mode: 'test', env: { TELEGRAM_GATE_TEST_ENV: paths.liveEnv }, paths, loadLive }), /실제 봇 설정 파일을 읽지 않습니다/);
    const link = join(dir, 'link.env');
    symlinkSync(paths.liveEnv, link);
    assert.throws(() => loadGateConfig({ mode: 'test', env: { TELEGRAM_GATE_TEST_ENV: link }, paths, loadLive }), /실제 봇 설정 파일을 읽지 않습니다/);
  } finally { cleanup(); }
});

test('시험 모드: 시험 env가 없거나 토큰이 없으면 거부한다(실제 봇으로 돌아가지 않음)', () => {
  const { paths, cleanup } = fixture();
  try {
    assert.throws(() => loadGateConfig({ mode: 'test', env: {}, paths }), /시험 봇 설정 파일이 없습니다/);
    writeFileSync(paths.testEnv, 'OTHER=1\n');
    assert.throws(() => loadGateConfig({ mode: 'test', env: {}, paths }), /TELEGRAM_BOT_TOKEN/);
  } finally { cleanup(); }
});

test('시험 모드: TELEGRAM_GATE_ALLOW_FROM이 있으면 그것을 쓰고 형식을 검사한다', () => {
  const { paths, cleanup } = fixture();
  try {
    writeFileSync(paths.testEnv, 'TELEGRAM_BOT_TOKEN=FAKE:test\nTELEGRAM_GATE_ALLOW_FROM=111, 222\n');
    const cfg = loadGateConfig({ mode: 'test', env: {}, paths });
    assert.deepEqual([...cfg.allowFrom], ['111', '222']);
    assert.equal(cfg.config.chatId, '111');
    writeFileSync(paths.testEnv, 'TELEGRAM_BOT_TOKEN=FAKE:test\nTELEGRAM_GATE_ALLOW_FROM=abc\n');
    assert.throws(() => loadGateConfig({ mode: 'test', env: {}, paths }), /허용 사용자/);
  } finally { cleanup(); }
});

test('실전 모드: 실제 봇 설정 로더 결과와 allowFrom 전체를 쓰고 하트비트 잡 이름을 둔다', () => {
  const { paths, cleanup } = fixture();
  try {
    writeFileSync(paths.access, JSON.stringify({ allowFrom: ['31337', '42'] }));
    const cfg = loadGateConfig({ mode: 'live', env: {}, paths });
    assert.deepEqual(cfg.config, { botToken: 'FAKE:live', chatId: '31337' });
    assert.deepEqual([...cfg.allowFrom], ['31337', '42']);
    assert.equal(cfg.heartbeatJob, 'telegram-gate');
    assert.throws(() => loadGateConfig({ mode: 'other', env: {}, paths }), /live 또는 test/);
  } finally { cleanup(); }
});

test('buildGateSpawnEnv: GATE=1을 넣고 SESSION·봇 토큰은 뺀다(원본 env는 바꾸지 않음)', () => {
  const base = { PATH: '/usr/bin', HOME: '/h', CLAUDE_TELEGRAM_SESSION: '1', TELEGRAM_BOT_TOKEN: 'FAKE:x', CLAUDE_TELEGRAM_GATE: '0' };
  const env = buildGateSpawnEnv(base);
  assert.equal(env.CLAUDE_TELEGRAM_GATE, '1');
  assert.equal('CLAUDE_TELEGRAM_SESSION' in env, false);
  assert.equal('TELEGRAM_BOT_TOKEN' in env, false);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(base.CLAUDE_TELEGRAM_SESSION, '1');
});

test('시험 모드: 하드링크로 실제 .env를 가리켜도 거부한다', () => {
  const { dir, paths, cleanup } = fixture();
  try {
    const hard = join(dir, 'hard.env');
    linkSync(paths.liveEnv, hard);
    assert.throws(() => loadGateConfig({ mode: 'test', env: { TELEGRAM_GATE_TEST_ENV: hard }, paths }), /실제 봇 설정 파일을 읽지 않습니다/);
  } finally { cleanup(); }
});

test('시험 모드: 상태 폴더를 실전 관문 상태 폴더로 바꾸면 거부한다', () => {
  const { paths, cleanup } = fixture();
  try {
    writeFileSync(paths.testEnv, 'TELEGRAM_BOT_TOKEN=FAKE:test\n');
    mkdirSync(paths.liveStateDir, { recursive: true });
    assert.throws(() => loadGateConfig({ mode: 'test', env: { TELEGRAM_GATE_STATE_DIR: paths.liveStateDir }, paths }), /실전 관문 상태 폴더/);
  } finally { cleanup(); }
});

test('assertTestIsolation: 시험 모드는 프로세스 볼트가 시험 볼트일 때만 통과(실제 볼트면 거부)', () => {
  const real = '/h/Pantheon/Mouseion';
  assert.doesNotThrow(() => assertTestIsolation({ mode: 'test', vaultRoot: '/s/vault', processVaultRoot: '/s/vault', realVaultRoot: real }));
  assert.throws(() => assertTestIsolation({ mode: 'test', vaultRoot: '/s/vault', processVaultRoot: real, realVaultRoot: real }), /실제 볼트에 쓰지 않는다/);
  assert.throws(() => assertTestIsolation({ mode: 'test', vaultRoot: real, processVaultRoot: real, realVaultRoot: real }), /실제 볼트/);
  assert.throws(() => assertTestIsolation({ mode: 'test', vaultRoot: null, processVaultRoot: '/x', realVaultRoot: real }), /시험 볼트/);
  assert.doesNotThrow(() => assertTestIsolation({ mode: 'live', vaultRoot: null, processVaultRoot: real, realVaultRoot: real }));
});

test('assertTestIsolation: 시험 볼트가 실제 볼트를 가리키는 심볼릭 링크면 거부한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-iso-'));
  try {
    const real = join(dir, 'Mouseion');
    mkdirSync(real);
    const testVault = join(dir, 'test-state', 'vault');
    mkdirSync(join(dir, 'test-state'));
    symlinkSync(real, testVault);
    assert.throws(() => assertTestIsolation({ mode: 'test', vaultRoot: testVault, processVaultRoot: testVault, realVaultRoot: real }), /실제 볼트에 쓰지 않는다/);
    const okVault = join(dir, 'ok-vault');
    mkdirSync(okVault);
    assert.doesNotThrow(() => assertTestIsolation({ mode: 'test', vaultRoot: okVault, processVaultRoot: okVault, realVaultRoot: real }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
