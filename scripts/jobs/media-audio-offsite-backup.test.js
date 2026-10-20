import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import * as intentFs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, verify, audioRecords, purgedIds, planUploads, AUDIO_NAME } from './media-audio-offsite-backup.mjs';
import { encryptBuffer } from '../lib/vault-offsite-backup.mjs';

const id = (n) => n.toString(16).padStart(16, '0');
const row = (n, kind = 'Calls', archivedAt = `2026-10-1${n % 10}`) => ({ id: id(n), kind, archivePath: `Archive/2026/10/${kind}/${n}.m4a`, size: 100, archivedAt });
function memoryIntentStore() {
  const entries = new Map();
  return { entries, readIntent: async (audioId) => entries.get(audioId) ?? null,
    writeIntent: async (intent) => { entries.set(intent.audioId, intent); },
    deleteIntent: async (audioId) => { entries.delete(audioId); } };
}

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
    ...memoryIntentStore(), getAccessToken: async () => 'token', generateFileId: async () => 'new-file-id',
    findOrCreateFolder: async () => ({ id: 'folder' }),
    listFiles: async ({ folderId }) => (folderId ? [
      { id: 'r1', name: `pantheon-audio-${id(1)}.enc`, size: 132,
        parents: ['folder'], appProperties: { pantheon: 'audio-backup', kind: 'Calls' } },
      { id: 'r3', name: `pantheon-audio-${id(3)}.enc`, size: 132,
        parents: ['folder'], appProperties: { pantheon: 'audio-backup', kind: 'Calls' } },
      { id: 'x', name: 'pantheon-vault-2026-10-16.bundle.enc', parents: ['folder'], appProperties: { pantheon: 'vault-backup' } },
    ] : [{ id: 'folder', mimeType: 'application/vnd.google-apps.folder', appProperties: { pantheon: 'audio-backup' } }]),
    encryptBuffer: (buf) => Buffer.concat([Buffer.from('ENC'), buf]),
    uploadBackup: async (args) => { uploads.push(args); return remoteCopy(args); },
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
  await assert.rejects(main([], { keyPath: () => '/key', stat: async () => ({ mode: 0o100644 }),
    readFile: async () => Buffer.alloc(32), lock: (fn) => fn() }), /권한/);
});

test('plist는 매일 00:00 run.sh media-audio-offsite-backup', () => {
  const plist = readFileSync(new URL('../launchd/com.banana2.media-audio-offsite-backup.plist', import.meta.url), 'utf8');
  assert.match(plist, /<string>media-audio-offsite-backup<\/string>/);
  assert.match(plist, /<key>Hour<\/key><integer>0<\/integer><key>Minute<\/key><integer>0<\/integer>/);
});

test('크기 불일치 응답은 실패로 남기고, 없는 파일(ENOENT)은 건너뜀으로 센다', async () => {
  const deletes = [];
  const files = { '/key': Buffer.alloc(32, 1), '/index': [row(1), row(2)].map((r) => JSON.stringify(r)).join('\n') };
  const summary = await main([], {
    keyPath: () => '/key', stat: async () => ({ mode: 0o100600 }), lock: (fn) => fn(),
    lstat: async (path) => { if (path.endsWith('2.m4a')) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return { isFile: () => true }; },
    readFile: async (path, encoding) => { if (path in files) return encoding ? String(files[path]) : files[path];
      if (path.includes('/Archive/')) return Buffer.from('audio'); throw Object.assign(new Error('없음'), { code: 'ENOENT' }); },
    indexPath: '/index', paths: { mediaRoot: '/media', purged: '/purged' },
    ...memoryIntentStore(), getAccessToken: async () => 'token', generateFileId: async () => 'new-file-id',
    findOrCreateFolder: async () => ({ id: 'folder' }),
    listFiles: async ({ folderId }) => (folderId ? [] : []),
    encryptBuffer: (buf) => buf,
    uploadBackup: async (args) => ({ ...remoteCopy(args), size: 1 }),
    deleteBackup: async ({ file }) => { deletes.push(file.id); },
    log() {},
  });
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(deletes, []);
});

test('오디오 백업 폴더가 둘이면 멈춘다', async () => {
  await assert.rejects(main([], {
    keyPath: () => '/key', stat: async () => ({ mode: 0o100600 }), lock: (fn) => fn(),
    readFile: async (path) => (path === '/key' ? Buffer.alloc(32) : ''), indexPath: '/index', paths: { mediaRoot: '/m', purged: '/p' },
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
    readFile: async (path) => (path === '/key' ? key : path === '/index' ? JSON.stringify(row(1)) : original),
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

function retryDependencies(overrides = {}) {
  const files = { '/key': Buffer.alloc(32, 1), '/index': JSON.stringify(row(1)) };
  return {
    keyPath: () => '/key', stat: async () => ({ mode: 0o100600 }), lstat: async () => ({ isFile: () => true }),
    lock: (fn) => fn(), readFile: async (path, encoding) => {
      if (path in files) return encoding ? String(files[path]) : files[path];
      if (path.includes('/Archive/')) return Buffer.from('audio');
      throw Object.assign(new Error('없음'), { code: 'ENOENT' });
    },
    indexPath: '/index', paths: { mediaRoot: '/media', purged: '/purged' },
    ...memoryIntentStore(), getAccessToken: async () => 'token', generateFileId: async () => 'fixed-id',
    delay: async () => {},
    listFiles: async ({ folderId }) => folderId ? [] : [
      { id: 'folder', mimeType: 'application/vnd.google-apps.folder', appProperties: { pantheon: 'audio-backup' } },
    ],
    encryptBuffer: (buf) => Buffer.concat([Buffer.from('ENC'), buf]),
    log() {}, ...overrides,
  };
}

function remoteCopy(args) {
  return { id: args.id, name: args.name, size: args.blob.length, parents: [args.folderId],
    appProperties: args.appProperties, md5Checksum: createHash('md5').update(args.blob).digest('hex') };
}

test('Drive 500 뒤 같은 사전 발급 ID로 재시도해 성공한다', async () => {
  const uploads = [];
  const summary = await main([], retryDependencies({
    uploadBackup: async (args) => {
      uploads.push(args);
      if (uploads.length === 1) throw Object.assign(new Error('HTTP 500'), { status: 500 });
      return remoteCopy(args);
    },
    getBackupMetadata: async () => { throw Object.assign(new Error('HTTP 404'), { status: 404 }); },
  }));
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].id, 'fixed-id');
  assert.equal(uploads[1].id, uploads[0].id);
  assert.equal(uploads[1].appProperties.blobSha256,
    createHash('sha256').update(uploads[1].blob).digest('hex'));
  assert.equal(summary.uploaded, 1);
  assert.equal(summary.failed, 0);
});

test('Drive 500 뒤 이미 생성된 정확한 사본을 확인하면 재전송하지 않는다', async () => {
  const uploads = [];
  const summary = await main([], retryDependencies({
    uploadBackup: async (args) => {
      uploads.push(args);
      throw Object.assign(new Error('HTTP 500'), { status: 500 });
    },
    getBackupMetadata: async ({ id: queriedId }) => {
      assert.equal(queriedId, 'fixed-id');
      return remoteCopy(uploads[0]);
    },
  }));
  assert.equal(uploads.length, 1);
  assert.equal(summary.uploaded, 1);
  assert.equal(summary.failed, 0);
});

test('Drive 429에도 같은 ID를 재사용하고 409면 원격 사본을 대조한다', async () => {
  const uploads = [];
  const summary = await main([], retryDependencies({
    uploadBackup: async (args) => {
      uploads.push(args);
      throw Object.assign(new Error(`HTTP ${uploads.length === 1 ? 429 : 409}`),
        { status: uploads.length === 1 ? 429 : 409 });
    },
    getBackupMetadata: async () => {
      if (uploads.length === 1) throw Object.assign(new Error('HTTP 404'), { status: 404 });
      return remoteCopy(uploads[0]);
    },
  }));
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].id, uploads[1].id);
  assert.equal(summary.uploaded, 1);
  assert.equal(summary.failed, 0);
});

test('Drive 500이 지속되고 원격 사본도 확인되지 않으면 제한 횟수 뒤 실패한다', async () => {
  const uploads = [];
  const summary = await main([], retryDependencies({
    uploadBackup: async (args) => {
      uploads.push(args);
      throw Object.assign(new Error('HTTP 500'), { status: 500 });
    },
    getBackupMetadata: async () => { throw Object.assign(new Error('HTTP 404'), { status: 404 }); },
  }));
  assert.equal(uploads.length, 3);
  assert.deepEqual(new Set(uploads.map(({ id: uploadId }) => uploadId)), new Set(['fixed-id']));
  assert.equal(summary.uploaded, 0);
  assert.equal(summary.failed, 1);
});

test('Drive 500 뒤 같은 ID라도 내용 확인 정보가 다르면 실패하고 재전송하지 않는다', async () => {
  let attempts = 0;
  const summary = await main([], retryDependencies({
    uploadBackup: async () => { attempts += 1; throw Object.assign(new Error('HTTP 500'), { status: 500 }); },
    getBackupMetadata: async () => ({ id: 'fixed-id', name: `pantheon-audio-${id(1)}.enc`,
      parents: ['folder'], appProperties: { pantheon: 'audio-backup', kind: 'Calls' }, size: 8 }),
  }));
  assert.equal(attempts, 1);
  assert.equal(summary.failed, 1);
});

test('2xx 응답의 ID가 다르면 업로드 완료로 처리하지 않고 의도를 보존한다', async () => {
  const store = memoryIntentStore();
  const summary = await main([], retryDependencies({ ...store,
    uploadBackup: async (args) => ({ ...remoteCopy(args), id: 'unexpected-id' }),
  }));
  assert.equal(summary.failed, 1);
  assert.equal(summary.uploaded, 0);
  assert.equal(store.entries.get(id(1)).id, 'fixed-id');
});

test('불확실한 실패 뒤 다음 실행도 저장한 ID와 암호문을 재사용한다', async () => {
  const store = memoryIntentStore();
  const attempts = [];
  const dependencies = retryDependencies({ ...store,
    uploadBackup: async (args) => {
      attempts.push(args);
      if (attempts.length <= 3) throw Object.assign(new Error('HTTP 500'), { status: 500 });
      return remoteCopy(args);
    },
    getBackupMetadata: async () => { throw Object.assign(new Error('HTTP 404'), { status: 404 }); },
  });
  const first = await main([], dependencies);
  assert.equal(first.failed, 1);
  assert.equal(store.entries.size, 1);
  const second = await main([], dependencies);
  assert.equal(second.failed, 0);
  assert.equal(second.uploaded, 1);
  assert.equal(attempts.length, 4);
  assert.deepEqual(new Set(attempts.map(({ id: uploadId }) => uploadId)), new Set(['fixed-id']));
  assert.ok(attempts.every(({ blob }) => blob.equals(attempts[0].blob)));
  assert.equal(store.entries.get(id(1)).completed, true);
  assert.equal(store.entries.get(id(1)).blob.length, 0);
  const third = await main([], { ...dependencies,
    getBackupMetadata: async () => remoteCopy(attempts[3]),
  });
  assert.equal(third.failed, 0);
  assert.equal(third.skipped, 1);
  assert.equal(attempts.length, 4);
});

test('이름만 같은 기존 원격 사본의 크기가 틀리면 건너뛰지 않고 실패한다', async () => {
  let uploaded = false;
  const summary = await main([], retryDependencies({
    listFiles: async ({ folderId }) => folderId
      ? [{ id: 'wrong', name: `pantheon-audio-${id(1)}.enc`, size: 1,
        parents: ['folder'], appProperties: { pantheon: 'audio-backup' } }]
      : [{ id: 'folder', mimeType: 'application/vnd.google-apps.folder', appProperties: { pantheon: 'audio-backup' } }],
    uploadBackup: async () => { uploaded = true; },
  }));
  assert.equal(uploaded, false);
  assert.equal(summary.failed, 1);
});

test('기존 원격 사본의 종류가 틀리거나 크기가 없으면 실패한다', async () => {
  for (const file of [
    { size: 132, appProperties: { pantheon: 'audio-backup', kind: 'Recordings' } },
    { appProperties: { pantheon: 'audio-backup', kind: 'Calls' } },
  ]) {
    const summary = await main([], retryDependencies({
      listFiles: async ({ folderId }) => folderId
        ? [{ id: 'wrong', name: `pantheon-audio-${id(1)}.enc`, parents: ['folder'], ...file }]
        : [{ id: 'folder', mimeType: 'application/vnd.google-apps.folder', appProperties: { pantheon: 'audio-backup' } }],
      uploadBackup: async () => { throw new Error('업로드하면 안 됨'); },
    }));
    assert.equal(summary.failed, 1);
  }
});

test('실제 의도 파일은 임시 경로에 저장되고 다음 실행에서 같은 ID로 재개된다', async (t) => {
  const intentDir = mkdtempSync(join(tmpdir(), 'audio-intent-'));
  t.after(() => rmSync(intentDir, { recursive: true, force: true }));
  let attempts = 0;
  const dependencies = retryDependencies({ intentDir,
    uploadBackup: async (args) => {
      attempts += 1;
      if (attempts <= 3) throw Object.assign(new Error('HTTP 500'), { status: 500 });
      assert.equal(args.id, 'fixed-id');
      return remoteCopy(args);
    },
    getBackupMetadata: async () => { throw Object.assign(new Error('HTTP 404'), { status: 404 }); },
  });
  delete dependencies.readIntent;
  delete dependencies.writeIntent;
  delete dependencies.deleteIntent;
  assert.equal((await main([], dependencies)).failed, 1);
  const intentFile = join(intentDir, `${id(1)}.intent`);
  const pending = readFileSync(intentFile);
  assert.match(pending.subarray(0, pending.indexOf(10)).toString(), /"id":"fixed-id"/);
  assert.equal((await main([], dependencies)).uploaded, 1);
  const receipt = readFileSync(intentFile);
  assert.equal(receipt.indexOf(10), receipt.length - 1);
  assert.match(receipt.toString(), /"completed":true/);
});

test('파일과 디렉터리 sync 및 rename이 끝난 뒤에만 업로드한다', async (t) => {
  const intentDir = mkdtempSync(join(tmpdir(), 'audio-intent-'));
  t.after(() => rmSync(intentDir, { recursive: true, force: true }));
  const events = [];
  const fs = { ...intentFs,
    open: async (path, ...args) => {
      const handle = await intentFs.open(path, ...args);
      return { writeFile: (...writeArgs) => handle.writeFile(...writeArgs), close: () => handle.close(),
        sync: async () => { events.push(path === intentDir ? 'directory sync'
          : path.endsWith('.tmp') ? 'file sync' : 'ancestor sync'); await handle.sync(); } };
    },
    rename: async (...args) => { events.push('rename'); await intentFs.rename(...args); },
  };
  const dependencies = retryDependencies({ intentDir, intentFs: fs,
    uploadBackup: async (args) => { events.push('POST'); return remoteCopy(args); },
  });
  delete dependencies.readIntent;
  delete dependencies.writeIntent;
  delete dependencies.deleteIntent;
  assert.equal((await main([], dependencies)).uploaded, 1);
  assert.deepEqual(events.filter((event) => event !== 'ancestor sync').slice(0, 4),
    ['file sync', 'rename', 'directory sync', 'POST']);
  assert.ok(events.indexOf('ancestor sync') < events.indexOf('POST'));
  assert.deepEqual(readdirSync(intentDir), [`${id(1)}.intent`]);
});

test('의도 파일이나 디렉터리 sync 실패 시 POST를 막고 임시 파일을 치운다', async (t) => {
  for (const failedSync of ['file', 'directory']) {
    const intentDir = mkdtempSync(join(tmpdir(), 'audio-intent-'));
    t.after(() => rmSync(intentDir, { recursive: true, force: true }));
    let posts = 0;
    const fs = { ...intentFs,
      open: async (path, ...args) => {
        const handle = await intentFs.open(path, ...args);
        return { writeFile: (...writeArgs) => handle.writeFile(...writeArgs), close: () => handle.close(),
          sync: async () => {
            if ((path === intentDir ? 'directory' : path.endsWith('.tmp') ? 'file' : 'ancestor') === failedSync)
              throw Object.assign(new Error('sync failed'), { code: 'EIO' });
            await handle.sync();
          } };
      },
    };
    const dependencies = retryDependencies({ intentDir, intentFs: fs,
      uploadBackup: async () => { posts += 1; throw new Error('POST must not run'); },
    });
    delete dependencies.readIntent;
    delete dependencies.writeIntent;
    delete dependencies.deleteIntent;
    const summary = await main([], dependencies);
    assert.equal(summary.failed, 1);
    assert.equal(posts, 0);
    assert.ok(readdirSync(intentDir).every((name) => !name.endsWith('.tmp')));
  }
});

test('디렉터리 sync 실패 뒤 재실행은 기존 의도를 다시 확정한 후 POST한다', async (t) => {
  const intentDir = mkdtempSync(join(tmpdir(), 'audio-intent-'));
  t.after(() => rmSync(intentDir, { recursive: true, force: true }));
  let failOnce = true;
  let posts = 0;
  const events = [];
  const fs = { ...intentFs,
    open: async (path, ...args) => {
      const handle = await intentFs.open(path, ...args);
      return { writeFile: (...writeArgs) => handle.writeFile(...writeArgs), close: () => handle.close(),
        sync: async () => {
          if (path === intentDir) {
            events.push('directory sync');
            if (failOnce) { failOnce = false; throw Object.assign(new Error('sync failed'), { code: 'EIO' }); }
          }
          await handle.sync();
        } };
    },
  };
  const dependencies = retryDependencies({ intentDir, intentFs: fs,
    uploadBackup: async (args) => { posts += 1; events.push('POST'); return remoteCopy(args); },
    getBackupMetadata: async () => { throw Object.assign(new Error('HTTP 404'), { status: 404 }); },
  });
  delete dependencies.readIntent;
  delete dependencies.writeIntent;
  delete dependencies.deleteIntent;
  assert.equal((await main([], dependencies)).failed, 1);
  assert.equal(posts, 0);
  assert.deepEqual(readdirSync(intentDir), [`${id(1)}.intent`]);
  assert.equal((await main([], dependencies)).uploaded, 1);
  assert.ok(events.indexOf('directory sync') < events.indexOf('POST'));
  assert.equal(events.filter((event) => event === 'directory sync').length, 3);
});

test('조상 디렉터리 sync 실패 뒤 재실행도 조상을 확정한 후 POST한다', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'audio-intent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const intentDir = join(root, 'new', 'intents');
  let failOnce = true;
  let posts = 0;
  let ancestorSyncs = 0;
  const fs = { ...intentFs,
    open: async (path, ...args) => {
      const handle = await intentFs.open(path, ...args);
      return { writeFile: (...writeArgs) => handle.writeFile(...writeArgs), close: () => handle.close(),
        sync: async () => {
          if (path === join(root, 'new')) {
            ancestorSyncs += 1;
            if (failOnce) { failOnce = false; throw Object.assign(new Error('sync failed'), { code: 'EIO' }); }
          }
          await handle.sync();
        } };
    },
  };
  const dependencies = retryDependencies({ intentDir, intentFs: fs,
    uploadBackup: async (args) => { posts += 1; return remoteCopy(args); },
  });
  delete dependencies.readIntent;
  delete dependencies.writeIntent;
  delete dependencies.deleteIntent;
  assert.equal((await main([], dependencies)).failed, 1);
  assert.equal(posts, 0);
  assert.equal((await main([], dependencies)).uploaded, 1);
  assert.equal(posts, 1);
  assert.ok(ancestorSyncs >= 2);
});

test('500 응답 뒤 목록에 안 보이는 원격 사본도 영구 삭제 시 저장된 ID로 찾아 지운다', async () => {
  const store = memoryIntentStore();
  let purged = false;
  const uploads = [];
  const deleted = [];
  const dependencies = retryDependencies({ ...store,
    readFile: async (path, encoding) => {
      if (path === '/purged') return purged ? `{"id":"${id(1)}"}\n` : '';
      if (path === '/key') return Buffer.alloc(32, 1);
      if (path === '/index') return JSON.stringify(row(1));
      if (path.includes('/Archive/')) return encoding ? 'audio' : Buffer.from('audio');
      throw Object.assign(new Error('없음'), { code: 'ENOENT' });
    },
    uploadBackup: async (args) => {
      uploads.push(args);
      throw Object.assign(new Error('HTTP 500'), { status: 500 });
    },
    getBackupMetadata: async () => {
      if (!purged) throw Object.assign(new Error('HTTP 404'), { status: 404 });
      return remoteCopy(uploads[0]);
    },
    deleteBackup: async ({ file }) => { deleted.push(file.id); },
  });
  assert.equal((await main([], dependencies)).failed, 1);
  assert.equal(store.entries.size, 1);
  purged = true;
  const summary = await main([], dependencies);
  assert.equal(summary.deleted, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(deleted, ['fixed-id']);
  assert.equal(store.entries.size, 0);
  assert.equal(uploads.length, 3);
});

test('저장된 ID의 원격 삭제가 실패하면 의도를 보존하고 FAIL로 남긴다', async () => {
  const store = memoryIntentStore();
  const blob = Buffer.from('ENCaudio');
  const intent = { audioId: id(1), id: 'fixed-id', folderId: 'folder', name: `pantheon-audio-${id(1)}.enc`,
    blob, appProperties: { pantheon: 'audio-backup', kind: 'Calls',
      blobSha256: createHash('sha256').update(blob).digest('hex') } };
  await store.writeIntent(intent);
  const base = retryDependencies({ ...store,
    getBackupMetadata: async () => remoteCopy(intent),
    deleteBackup: async () => { throw new Error('Drive delete failed'); },
  });
  const originalReadFile = base.readFile;
  base.readFile = async (path, encoding) => path === '/purged'
    ? `{"id":"${id(1)}"}\n` : originalReadFile(path, encoding);
  const summary = await main([], base);
  assert.equal(summary.failed, 1);
  assert.equal(summary.deleted, 0);
  assert.equal(store.entries.get(id(1)).id, 'fixed-id');
});

test('삭제 성공 뒤 의도 제거 전에 중단되면 다음 실행의 404로 정리한다', async () => {
  const store = memoryIntentStore();
  const blob = Buffer.from('ENCaudio');
  await store.writeIntent({ audioId: id(1), id: 'fixed-id', folderId: 'folder',
    name: `pantheon-audio-${id(1)}.enc`, blob,
    appProperties: { pantheon: 'audio-backup', kind: 'Calls',
      blobSha256: createHash('sha256').update(blob).digest('hex') } });
  let deleted = false;
  let deleteIntentAttempts = 0;
  const base = retryDependencies({ ...store,
    getBackupMetadata: async () => {
      if (deleted) throw Object.assign(new Error('HTTP 404'), { status: 404 });
      return remoteCopy(store.entries.get(id(1)));
    },
    deleteBackup: async () => { deleted = true; },
    deleteIntent: async (audioId) => {
      deleteIntentAttempts += 1;
      if (deleteIntentAttempts === 1) throw new Error('interrupted');
      await store.deleteIntent(audioId);
    },
  });
  const originalReadFile = base.readFile;
  base.readFile = async (path, encoding) => path === '/purged'
    ? `{"id":"${id(1)}"}\n` : originalReadFile(path, encoding);
  const first = await main([], base);
  assert.equal(first.failed, 1);
  assert.equal(store.entries.get(id(1)).id, 'fixed-id');
  const second = await main([], base);
  assert.equal(second.failed, 0);
  assert.equal(second.deleted, 1);
  assert.equal(store.entries.size, 0);
  assert.equal(deleteIntentAttempts, 2);
});

test('404라도 같은 이름의 다른 원격 사본이 있으면 의도를 보존한다', async () => {
  const store = memoryIntentStore();
  const blob = Buffer.from('ENCaudio');
  await store.writeIntent({ audioId: id(1), id: 'fixed-id', folderId: 'folder',
    name: `pantheon-audio-${id(1)}.enc`, blob,
    appProperties: { pantheon: 'audio-backup', kind: 'Calls',
      blobSha256: createHash('sha256').update(blob).digest('hex') } });
  const base = retryDependencies({ ...store,
    listFiles: async ({ folderId }) => folderId
      ? [{ id: 'other-id', name: `pantheon-audio-${id(1)}.enc` }]
      : [{ id: 'folder', mimeType: 'application/vnd.google-apps.folder', appProperties: { pantheon: 'audio-backup' } }],
    getBackupMetadata: async () => { throw Object.assign(new Error('HTTP 404'), { status: 404 }); },
    deleteBackup: async () => { throw new Error('must not delete'); },
  });
  const originalReadFile = base.readFile;
  base.readFile = async (path, encoding) => path === '/purged'
    ? `{"id":"${id(1)}"}\n` : originalReadFile(path, encoding);
  const summary = await main([], base);
  assert.equal(summary.failed, 1);
  assert.equal(store.entries.size, 1);
});

test('목록에 같은 ID가 남았는데 메타데이터가 404면 의도를 보존한다', async () => {
  const store = memoryIntentStore();
  const blob = Buffer.from('ENCaudio');
  await store.writeIntent({ audioId: id(1), id: 'fixed-id', folderId: 'folder',
    name: `pantheon-audio-${id(1)}.enc`, blob,
    appProperties: { pantheon: 'audio-backup', kind: 'Calls',
      blobSha256: createHash('sha256').update(blob).digest('hex') } });
  const base = retryDependencies({ ...store,
    listFiles: async ({ folderId }) => folderId
      ? [{ id: 'fixed-id', name: `pantheon-audio-${id(1)}.enc`,
        appProperties: { pantheon: 'audio-backup' } }]
      : [{ id: 'folder', mimeType: 'application/vnd.google-apps.folder', appProperties: { pantheon: 'audio-backup' } }],
    getBackupMetadata: async () => { throw Object.assign(new Error('HTTP 404'), { status: 404 }); },
  });
  const originalReadFile = base.readFile;
  base.readFile = async (path, encoding) => path === '/purged'
    ? `{"id":"${id(1)}"}\n` : originalReadFile(path, encoding);
  const summary = await main([], base);
  assert.equal(summary.failed, 1);
  assert.equal(summary.deleted, 0);
  assert.equal(store.entries.size, 1);
});

test('의도 없는 삭제 대상의 상태가 불명확하면 404로 정리하지 않는다', async () => {
  let metadataLookups = 0;
  const base = retryDependencies({
    listFiles: async ({ folderId }) => folderId ? []
      : [{ id: 'folder', mimeType: 'application/vnd.google-apps.folder', appProperties: { pantheon: 'audio-backup' } }],
    getBackupMetadata: async () => { metadataLookups += 1; throw Object.assign(new Error('HTTP 404'), { status: 404 }); },
    deleteBackup: async () => { throw new Error('must not delete'); },
  });
  const originalReadFile = base.readFile;
  base.readFile = async (path, encoding) => path === '/purged'
    ? `{"id":"${id(1)}"}\n` : originalReadFile(path, encoding);
  const summary = await main([], base);
  assert.equal(summary.deleted, 0);
  assert.equal(metadataLookups, 0);
});
