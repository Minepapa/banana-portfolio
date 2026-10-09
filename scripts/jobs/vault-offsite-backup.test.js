import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRIVE_BACKUP_SCOPES } from '../lib/google-oauth.mjs';
import { main } from './vault-offsite-backup.mjs';

const name = 'pantheon-vault-2026-10-09.bundle.enc';
const oldFile = { id: 'old', name, parents: ['folder'], appProperties: { pantheon: 'vault-backup' } };

function dependencies(overrides = {}) {
  const calls = { removed: [], trashed: [], listed: 0 };
  return { calls, io: {
    keyPath: () => '/fake/key', stat: async () => ({ mode: 0o100600 }),
    readFile: async (path) => path === '/fake/key' ? Buffer.alloc(32, 7) : Buffer.from('bundle'),
    mkdtemp: async () => '/fake/temporary', rm: async (...args) => calls.removed.push(args),
    exec: async () => {}, encryptBuffer: () => Buffer.alloc(42),
    getAccessToken: async ({ requiredScopes }) => {
      assert.deepEqual(requiredScopes, DRIVE_BACKUP_SCOPES); return 'fake-token';
    },
    findOrCreateFolder: async () => ({ id: 'folder' }),
    uploadBackup: async () => ({ id: 'new', size: 42 }),
    listFiles: async () => { calls.listed += 1; return [oldFile]; },
    deleteBackup: async ({ file }) => calls.trashed.push(file.id),
    now: () => Date.UTC(2026, 9, 8, 15), log: () => {},
    ...overrides,
  } };
}

test('업로드 실패와 크기 불일치에서는 보관 파일을 정리하지 않는다', async () => {
  const failed = dependencies({ uploadBackup: async () => { throw new Error('upload failed'); } });
  await assert.rejects(() => main([], failed.io), /upload failed/);
  assert.equal(failed.calls.listed, 0);
  assert.deepEqual(failed.calls.trashed, []);
  assert.equal(failed.calls.removed.length, 1);

  const mismatch = dependencies({ uploadBackup: async () => ({ id: 'new', size: 41 }) });
  await assert.rejects(() => main([], mismatch.io), /크기 불일치/);
  assert.equal(mismatch.calls.listed, 0);
  assert.deepEqual(mismatch.calls.trashed, []);
  assert.equal(mismatch.calls.removed.length, 1);
});

test('업로드 성공 후 같은 날 같은 이름의 이전 파일만 휴지통으로 보낸다', async () => {
  const current = dependencies();
  await main([], current.io);
  assert.deepEqual(current.calls.trashed, ['old']);
});

test('백업 키에 그룹 또는 다른 사용자 권한이 있으면 업로드하지 않는다', async () => {
  const current = dependencies({ stat: async () => ({ mode: 0o100640 }) });
  await assert.rejects(() => main([], current.io), /백업 키 권한 오류/);
  assert.equal(current.calls.listed, 0);
});
