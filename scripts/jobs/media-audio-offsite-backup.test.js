import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { main, verify, audioRecords, purgedIds, planUploads, AUDIO_NAME } from './media-audio-offsite-backup.mjs';
import { encryptBuffer } from '../lib/vault-offsite-backup.mjs';

const id = (n) => n.toString(16).padStart(16, '0');
const row = (n, kind = 'Calls', archivedAt = `2026-10-1${n % 10}`) => ({ id: id(n), kind, archivePath: `Archive/2026/10/${kind}/${n}.m4a`, size: 100, archivedAt });

test('대상은 통화·녹음만, 영구 삭제 목록 해석, 회당 용량 상한', () => {
  const text = [row(1), row(2, 'Recordings'), row(3, 'Camera')].map((r) => JSON.stringify(r)).join('\n');
  assert.deepEqual(audioRecords(text).map((r) => r.id), [id(1), id(2)]);
  assert.deepEqual([...purgedIds(`{"id":"${id(2)}"}\n깨진 줄`)], [id(2)]);
  const plan = planUploads([row(1), row(2), row(3)], new Set([id(1)]), new Map(), 150);
  assert.equal(plan.pending, 2);
  assert.equal(plan.chosen.length, 1);
  // 상한보다 큰 한 파일도 단독으로는 올린다
  assert.equal(planUploads([{ ...row(4), size: 999 }], new Set(), new Map(), 150).chosen.length, 1);
});

test('빠진 파일만 암호화해 ID 이름으로 올리고, 영구 삭제된 ID는 원격에서 지운다', async () => {
  const uploads = []; const deletes = [];
  const files = { '/key': Buffer.alloc(32, 1), '/index': [row(1), row(2), row(3)].map((r) => JSON.stringify(r)).join('\n'),
    '/purged': `{"id":"${id(3)}"}\n` };
  const summary = await main([], {
    keyPath: () => '/key', stat: async () => ({ mode: 0o100600 }), lstat: async () => ({ isFile: () => true }), lock: (fn) => fn(),
    readFile: async (path, encoding) => {
      if (path in files) return encoding ? String(files[path]) : files[path];
      if (path.includes('/Archive/')) return Buffer.from('audio');
      throw Object.assign(new Error('없음'), { code: 'ENOENT' });
    },
    indexPath: '/index', paths: { mediaRoot: '/media', purged: '/purged' },
    getAccessToken: async () => 'token', findOrCreateFolder: async () => ({ id: 'folder' }),
    listFiles: async ({ folderId }) => (folderId ? [
      { id: 'r1', name: `pantheon-audio-${id(1)}.enc`, parents: ['folder'], appProperties: { pantheon: 'audio-backup' } },
      { id: 'r3', name: `pantheon-audio-${id(3)}.enc`, parents: ['folder'], appProperties: { pantheon: 'audio-backup' } },
      { id: 'x', name: 'pantheon-vault-2026-10-16.bundle.enc', parents: ['folder'], appProperties: { pantheon: 'vault-backup' } },
    ] : [{ id: 'folder', mimeType: 'application/vnd.google-apps.folder', appProperties: { pantheon: 'audio-backup' } }]),
    encryptBuffer: (buf) => Buffer.concat([Buffer.from('ENC'), buf]),
    uploadBackup: async (args) => { uploads.push(args); return { size: args.blob.length }; },
    deleteBackup: async ({ file }) => { deletes.push(file.id); },
    log() {},
  });
  assert.deepEqual(uploads.map((u) => u.name), [`pantheon-audio-${id(2)}.enc`]);
  assert.ok(AUDIO_NAME.test(uploads[0].name));
  assert.equal(uploads[0].blob.subarray(0, 3).toString(), 'ENC');
  assert.equal(uploads[0].appProperties.pantheon, 'audio-backup');
  assert.deepEqual(deletes, ['r3']);
  assert.equal(summary.uploaded, 1);
  assert.equal(summary.failed, 0);
});

test('키 권한이 넓으면 실패한다', async () => {
  await assert.rejects(main([], { keyPath: () => '/key', stat: async () => ({ mode: 0o100644 }), readFile: async () => Buffer.alloc(32) }), /권한/);
});

test('plist는 매일 00:00 run.sh media-audio-offsite-backup', () => {
  const plist = readFileSync(new URL('../launchd/com.banana2.media-audio-offsite-backup.plist', import.meta.url), 'utf8');
  assert.match(plist, /<string>media-audio-offsite-backup<\/string>/);
  assert.match(plist, /<key>Hour<\/key><integer>0<\/integer><key>Minute<\/key><integer>0<\/integer>/);
});

test('크기 불일치 사본은 지우고 실패로, 없는 파일(ENOENT)은 건너뜀으로 센다', async () => {
  const deletes = [];
  const files = { '/key': Buffer.alloc(32, 1), '/index': [row(1), row(2)].map((r) => JSON.stringify(r)).join('\n') };
  const summary = await main([], {
    keyPath: () => '/key', stat: async () => ({ mode: 0o100600 }), lock: (fn) => fn(),
    lstat: async (path) => { if (path.endsWith('2.m4a')) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return { isFile: () => true }; },
    readFile: async (path, encoding) => { if (path in files) return encoding ? String(files[path]) : files[path];
      if (path.includes('/Archive/')) return Buffer.from('audio'); throw Object.assign(new Error('없음'), { code: 'ENOENT' }); },
    indexPath: '/index', paths: { mediaRoot: '/media', purged: '/purged' },
    getAccessToken: async () => 'token', findOrCreateFolder: async () => ({ id: 'folder' }),
    listFiles: async ({ folderId }) => (folderId ? [] : []),
    encryptBuffer: (buf) => buf,
    uploadBackup: async (args) => ({ id: 'u1', name: args.name, size: 1 }),
    deleteBackup: async ({ file }) => { deletes.push(file.id); },
    log() {},
  });
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(deletes, ['u1']);
});

test('오디오 백업 폴더가 둘이면 멈춘다', async () => {
  await assert.rejects(main([], {
    keyPath: () => '/key', stat: async () => ({ mode: 0o100600 }), lock: (fn) => fn(),
    readFile: async (path, encoding) => (path === '/key' ? Buffer.alloc(32) : ''), indexPath: '/index', paths: { mediaRoot: '/m', purged: '/p' },
    getAccessToken: async () => 't',
    listFiles: async () => [1, 2].map((n) => ({ id: `f${n}`, mimeType: 'application/vnd.google-apps.folder', appProperties: { pantheon: 'audio-backup' } })),
    log() {},
  }), /폴더가 2개/);
});

test('복원 확인은 실제 암·복호화로 원본 해시를 비교한다', async () => {
  const key = Buffer.alloc(32, 7);
  const original = Buffer.from('진짜 음성 바이트');
  const ok = await verify(id(1), {
    keyPath: () => '/key', stat: async () => ({ mode: 0o100600 }),
    readFile: async (path, encoding) => (path === '/key' ? key : path === '/index' ? JSON.stringify(row(1)) : original),
    indexPath: '/index', paths: { mediaRoot: '/media' }, getAccessToken: async () => 't',
    listFiles: async ({ folderId }) => (folderId ? [{ id: 'r1', name: `pantheon-audio-${id(1)}.enc` }]
      : [{ id: 'folder', mimeType: 'application/vnd.google-apps.folder', appProperties: { pantheon: 'audio-backup' } }]),
    downloadBackup: async () => encryptBuffer(original, key), log() {},
  });
  assert.equal(ok, true);
});

test('dry-run은 토큰·네트워크를 쓰지 않는다', async () => {
  const summary = await main(['--dry-run'], {
    keyPath: () => '/key', stat: async () => ({ mode: 0o100600 }),
    readFile: async (path) => { if (path === '/key') return Buffer.alloc(32); if (path === '/index') return JSON.stringify(row(1));
      throw Object.assign(new Error('없음'), { code: 'ENOENT' }); },
    indexPath: '/index', paths: { mediaRoot: '/m', purged: '/p' },
    getAccessToken: async () => { throw new Error('네트워크 사용'); }, log() {},
  });
  assert.equal(summary.pending, 1);
});
