import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from './deploy-android-app.mjs';
import { DRIVE_BACKUP_SCOPES } from '../lib/google-oauth.mjs';

const apk = Buffer.alloc(1024);
const file = (id, stamp) => ({ id, name: `kakao-notification-${stamp}-abc123.apk`,
  parents: ['folder'], appProperties: { pantheon: 'android-apps' } });

function fixture(overrides = {}) {
  const calls = { commands: [], removed: [], sent: [], token: 0, uploaded: 0, warnings: [] };
  const io = {
    exec: async (command, args, opts) => {
      calls.commands.push({ command, args, opts });
      if (args[0] === 'status') return { stdout: '' };
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n' };
      return { stdout: 'BUILD SUCCESSFUL' };
    },
    readFile: async () => apk,
    getAccessToken: async ({ requiredScopes }) => {
      assert.deepEqual(requiredScopes, DRIVE_BACKUP_SCOPES);
      calls.token += 1;
      return 'test-token';
    },
    findOrCreateFolder: async ({ appProperties, folderName }) => {
      assert.deepEqual(appProperties, { pantheon: 'android-apps' });
      assert.equal(folderName, 'Pantheon 앱');
      return { id: 'folder' };
    },
    uploadBackup: async ({ name, mimeType, blob }) => {
      calls.uploaded += 1;
      assert.equal(name, 'kakao-notification-20261010-0034-abc123.apk');
      assert.equal(mimeType, 'application/vnd.android.package-archive');
      assert.equal(blob, apk);
      return { id: 'new', size: 1024 };
    },
    listFiles: async () => [],
    deleteBackup: async ({ file }) => calls.removed.push(file.id),
    sendAgentMessage: async (message) => calls.sent.push(message),
    now: () => Date.UTC(2026, 9, 9, 15, 34),
    log: () => {}, warn: (message) => calls.warnings.push(message),
    ...overrides,
  };
  return { calls, io };
}

test('파일 이름, 빌드 환경, 메시지 링크와 속성을 확인한다', async () => {
  const { calls, io } = fixture();
  await main(['--project=/test/android'], io);
  assert.deepEqual(calls.commands.map(({ command, args }) => [command, ...args]), [
    ['git', 'status', '--porcelain'], ['git', 'rev-parse', '--short', 'HEAD'], ['gradle', ':app:assembleDebug'],
  ]);
  assert.equal(calls.commands[2].opts.cwd, '/test/android');
  assert.equal(calls.commands[2].opts.env.JAVA_HOME, '/Applications/Android Studio.app/Contents/jbr/Contents/Home');
  assert.deepEqual(calls.sent.map(({ agent, kind, topic }) => [agent, kind, topic]), [['zeus', '정보', '앱 배포']]);
  assert.match(calls.sent[0].body, /https:\/\/drive\.google\.com\/file\/d\/new\/view/);
  assert.match(calls.sent[0].body, /커밋: abc123/);
  assert.match(calls.sent[0].body, /알 수 없는 앱 설치/);
});

test('빌드 실패 시 마지막 30줄을 보여 주고 외부 작업을 중단한다', async () => {
  const { calls, io } = fixture({ exec: async (command, args) => {
    if (args[0] === 'status') return { stdout: '' };
    if (args[0] === 'rev-parse') return { stdout: 'abc123' };
    throw Object.assign(new Error('failed'), { stdout: Array.from({ length: 35 }, (_, index) => `line-${index}`).join('\n') });
  } });
  await assert.rejects(() => main([], io), (error) => error.message.includes('line-34') && !error.message.includes('line-0'));
  assert.equal(calls.token, 0);
  assert.equal(calls.uploaded, 0);
  assert.deepEqual(calls.sent, []);
});

test('dirty 상태는 경고만 하며 require-clean은 빌드 전에 중단한다', async () => {
  const { calls, io } = fixture({ exec: async (command, args, opts) => {
    calls.commands.push({ command, args, opts });
    if (args[0] === 'status') return { stdout: ' M app/src/main/AndroidManifest.xml' };
    if (args[0] === 'rev-parse') return { stdout: 'abc123' };
    return { stdout: '' };
  } });
  await assert.rejects(() => main(['--require-clean'], io), /커밋되지 않은 변경/);
  assert.equal(calls.commands.length, 1);
  await main(['--dry-run'], io);
  assert.equal(calls.warnings.length, 1);
});

test('업로드와 크기 확인 뒤에만 최근 다섯 개를 남긴다', async () => {
  const older = Array.from({ length: 6 }, (_, index) => file(`old-${index}`, `2026100${index + 1}-0034`));
  const success = fixture({ listFiles: async () => [...older, file('other', '20261009-0034'),
    { ...file('wrong', '20261001-0034'), appProperties: { pantheon: 'vault-backup' } }] });
  await main(['--no-send'], success.io);
  assert.deepEqual(success.calls.removed, ['old-2', 'old-1', 'old-0']);
  assert.deepEqual(success.calls.sent, []);

  const mismatch = fixture({ uploadBackup: async () => ({ id: 'new', size: 1 }),
    listFiles: async () => { throw new Error('목록 호출하면 안 됨'); } });
  await assert.rejects(() => main([], mismatch.io), /크기 불일치/);
  assert.deepEqual(mismatch.calls.removed, []);
  assert.deepEqual(mismatch.calls.sent, []);
});

test('dry-run은 빌드만 하고 OAuth·업로드·발송을 하지 않는다', async () => {
  const { calls, io } = fixture();
  await main(['--dry-run'], io);
  assert.equal(calls.commands.length, 3);
  assert.equal(calls.token, 0);
  assert.equal(calls.uploaded, 0);
  assert.deepEqual(calls.removed, []);
  assert.deepEqual(calls.sent, []);
});
