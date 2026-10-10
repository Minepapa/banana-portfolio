import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { decryptBuffer, deleteBackup, downloadBackup, encryptBuffer, findOrCreateFolder, listFiles, planRetention, uploadBackup } from './vault-offsite-backup.mjs';

const file = (date) => `pantheon-vault-${date}.bundle.enc`;
test('AES-256-GCM 왕복, 헤더, 변조 및 키 검증', () => {
  const key = Buffer.alloc(32, 7);
  const input = Buffer.from('test bundle');
  const encrypted = encryptBuffer(input, key);
  assert.equal(encrypted.subarray(0, 4).toString(), 'PVB1');
  assert.deepEqual(decryptBuffer(encrypted, key), input);
  const changed = Buffer.from(encrypted); changed[changed.length - 1] ^= 1;
  assert.throws(() => decryptBuffer(changed, key));
  assert.throws(() => decryptBuffer(encrypted, Buffer.alloc(32, 8)));
  assert.throws(() => encryptBuffer(input, Buffer.alloc(31)));
  const iv = Buffer.alloc(12, 1);
  const legacy = createCipheriv('aes-256-gcm', key, iv);
  const legacyBody = Buffer.concat([legacy.update(input), legacy.final()]);
  assert.throws(() => decryptBuffer(Buffer.concat([Buffer.from('PVB1'), iv, legacy.getAuthTag(), legacyBody]), key));
});

test('보관 정책: 14일 경계, 월말, 12개월 초과, 무관 파일', () => {
  const names = [file('2026-10-09'), file('2026-09-26'), file('2026-09-25'), file('2026-09-24'), file('2026-09-30'), file('2026-08-31'), file('2026-08-01'), file('2025-10-31'), file('2025-09-30'), 'other-file.txt'];
  const result = planRetention(names, '2026-10-09');
  assert.ok(result.keep.includes(file('2026-09-26')));
  assert.ok(result.keep.includes(file('2026-09-25')));
  assert.ok(result.delete.includes(file('2026-09-24')));
  assert.ok(result.keep.includes(file('2026-09-30')));
  assert.ok(result.keep.includes(file('2026-08-31')));
  assert.ok(result.delete.includes(file('2026-08-01')));
  assert.ok(result.delete.includes(file('2025-09-30')));
  assert.ok(!result.keep.includes('other-file.txt') && !result.delete.includes('other-file.txt'));
});

test('보관 정책: 기준일과 파일명 날짜 검증, 윤일에서 12개월 전 월말로 고정', () => {
  assert.throws(() => planRetention([], '2026-02-30'), /today 날짜 오류/);
  const invalid = file('2026-13-40');
  const result = planRetention([invalid, file('2027-02-28'), file('2027-02-27')], '2028-02-29');
  assert.ok(!result.keep.includes(invalid) && !result.delete.includes(invalid));
  assert.ok(result.keep.includes(file('2027-02-28')));
  assert.ok(result.delete.includes(file('2027-02-27')));
});

test('Drive 폴더·목록·업로드·다운로드·휴지통 요청은 앱 소유 범위를 지킨다', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === 'POST' && String(url).includes('uploadType=multipart')) return { ok: true, json: async () => ({ id: 'uploaded', size: 5 }) };
    if (options.method === 'POST') return { ok: true, json: async () => ({ id: 'folder' }) };
    if (options.method === 'PATCH') return { ok: true };
    if (String(url).includes('alt=media')) return { ok: true, arrayBuffer: async () => Uint8Array.of(1, 2).buffer };
    return { ok: true, json: async () => ({ files: [] }) };
  };
  const params = { token: 'fake', fetchImpl };
  assert.deepEqual(await listFiles(params), []);
  assert.deepEqual(await findOrCreateFolder(params), { id: 'folder' });
  await uploadBackup({ ...params, folderId: 'folder', name: file('2026-10-09'), blob: Buffer.alloc(5) });
  assert.deepEqual(await downloadBackup({ ...params, id: 'uploaded' }), Buffer.from([1, 2]));
  await assert.rejects(() => deleteBackup({ ...params, folderId: 'folder', file: { id: 'foreign', name: file('2026-10-09'), parents: ['folder'] } }), /앱 백업 파일만/);
  await deleteBackup({ ...params, folderId: 'folder', file: { id: 'uploaded', name: file('2026-10-09'), parents: ['folder'], appProperties: { pantheon: 'vault-backup' } } });
  assert.ok(calls.some((call) => call.options.signal instanceof AbortSignal && call.options.method === 'POST' && call.options.headers['Content-Type'].startsWith('multipart/related')));
  const trashed = calls.filter((call) => call.options.method === 'PATCH');
  assert.equal(trashed.length, 1);
  assert.deepEqual(JSON.parse(trashed[0].options.body), { trashed: true });
  assert.equal(calls.filter((call) => call.options.method === 'DELETE').length, 0);
});

test('Android 앱 폴더·파일은 별도 속성과 APK MIME을 사용한다', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === 'POST') return { ok: true, json: async () => ({ id: 'created', size: 4 }) };
    if (options.method === 'PATCH') return { ok: true };
    return { ok: true, json: async () => ({ files: [] }) };
  };
  const appProperties = { pantheon: 'android-apps' };
  const namePattern = /^kakao-notification-\d{8}-\d{4}-[0-9a-f]+\.apk$/;
  const params = { token: 'fake', fetchImpl, appProperties };
  await findOrCreateFolder({ ...params, folderName: 'Pantheon 앱' });
  const folderQuery = new URL(calls[0].url).searchParams.get('q');
  assert.match(folderQuery, /value='android-apps'/);
  assert.equal(JSON.parse(calls[1].options.body).name, 'Pantheon 앱');
  const name = 'kakao-notification-20261010-0034-abc123.apk';
  await uploadBackup({ ...params, folderId: 'created', name, blob: Buffer.alloc(4),
    mimeType: 'application/vnd.android.package-archive', namePattern });
  assert.match(calls[2].options.body.toString(), /Content-Type: application\/vnd\.android\.package-archive/);
  assert.match(calls[2].options.body.toString(), /"pantheon":"android-apps"/);
  await assert.rejects(() => deleteBackup({ ...params, folderId: 'created', namePattern,
    file: { id: 'foreign', name, parents: ['created'], appProperties: { pantheon: 'vault-backup' } } }), /앱 백업 파일만/);
  await deleteBackup({ ...params, folderId: 'created', namePattern,
    file: { id: 'owned', name, parents: ['created'], appProperties } });
  assert.equal(calls.at(-1).options.method, 'PATCH');
});
