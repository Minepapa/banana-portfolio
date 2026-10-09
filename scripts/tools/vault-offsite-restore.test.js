import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRIVE_BACKUP_SCOPES } from '../lib/google-oauth.mjs';
import { main } from './vault-offsite-restore.mjs';

const name = 'pantheon-vault-2026-10-09.bundle.enc';
function dependencies(overrides = {}) {
  const calls = { tokens: 0, commands: [] };
  return { calls, io: {
    keyPath: () => '/fake/key', stat: async () => ({ mode: 0o100600 }),
    readFile: async () => Buffer.alloc(32, 7),
    existsSync: () => false, readdir: async () => [],
    getAccessToken: async ({ requiredScopes }) => {
      assert.deepEqual(requiredScopes, DRIVE_BACKUP_SCOPES); calls.tokens += 1; return 'fake-token';
    },
    listFiles: async ({ folderId }) => folderId
      ? [{ id: 'backup', name, parents: ['folder'], appProperties: { pantheon: 'vault-backup' } }]
      : [{ id: 'folder', mimeType: 'application/vnd.google-apps.folder', appProperties: { pantheon: 'vault-backup' } }],
    downloadBackup: async () => Buffer.from('encrypted'),
    decryptBuffer: () => Buffer.from('bundle'),
    mkdtemp: async () => '/fake/temporary', writeFile: async () => {},
    exec: async (_, args) => calls.commands.push(args), rm: async () => {}, log: () => {},
    ...overrides,
  } };
}

test('복구 인자 조합과 빈 --out 값을 거부한다', async () => {
  const { io, calls } = dependencies();
  for (const args of [[], ['--latest'], [`--name=${name}`], ['--latest', '--name=' + name, '--out=/tmp/output'],
    ['--verify', '--out=/tmp/output'], ['--latest', '--out='], ['--latest', '--out=/tmp/a', '--out=/tmp/b'],
    ['--latest', '--latest', '--out=/tmp/output']]) {
    await assert.rejects(() => main(args, io), /사용법/);
  }
  assert.equal(calls.tokens, 0);
  await assert.rejects(() => main(['--name=', '--out=/tmp/output'], io), /백업 파일 이름 오류/);
});

test('비어 있지 않은 --out은 다운로드 전에 거부한다', async () => {
  const { io, calls } = dependencies({ existsSync: () => true, readdir: async () => ['existing'] });
  await assert.rejects(() => main(['--latest', '--out=/tmp/output'], io), /비어 있어야/);
  assert.equal(calls.tokens, 0);
});

test('복구는 검증 뒤 지정한 출력으로 clone하고, 약한 키 권한은 거부한다', async () => {
  const current = dependencies();
  await main(['--latest', '--out=/tmp/output'], current.io);
  assert.deepEqual(current.calls.commands.map((args) => args[0]), ['init', 'bundle', 'clone']);
  assert.equal(current.calls.commands[2][2], '/tmp/output');
  const weakKey = dependencies({ stat: async () => ({ mode: 0o100604 }) });
  await assert.rejects(() => main(['--verify'], weakKey.io), /백업 키 권한 오류/);
  assert.equal(weakKey.calls.tokens, 0);
});
