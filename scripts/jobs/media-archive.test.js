import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMediaArchive, repairMediaArchiveTimes } from './media-archive.mjs';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { warningCount, resetWarnings } from '../lib/job-alerts.mjs';

const NOW = new Date('2026-10-11T06:00:00Z');
const QUIET = { log() {}, error() {} };

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'media-archive-test-'));
  const mediaRoot = join(root, 'Media');
  const indexPath = join(root, 'Vault', 'archive-index.jsonl');
  const vaultRoot = join(root, 'Vault');
  const exiftoolPath = join(root, 'fake-exiftool');
  // 테스트 전용 외부 명령. 입력 경로를 JSON으로 되돌리고 합성 메타데이터만 붙인다.
  await fs.writeFile(exiftoolPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (!process.argv.slice(2).includes('-Duration#')) process.exit(2);
const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
fs.appendFileSync(${JSON.stringify(join(root, 'calls'))}, 'call\\n');
process.stdout.write(JSON.stringify(args.map((file) => {
  const name = path.basename(file);
  const cases = {
    'old_20240102_030405.jpg': '2000:01:09 00:00:00',
    'agree_20240102_030405.jpg': '2024:01:02 03:05:00',
    'boundary_20240102_030405.jpg': '2024:01:02 03:06:05',
    'differ_20240102_030405.jpg': '2024:01:05 03:04:05',
    '1704164645000.jpg': '2024:01:02 03:04:05',
    'BandPhoto_2024_01_02_03_04_05.jpg': '2024:01:02 03:07:06',
    'only-exif.jpg': '2024:01:02 03:04:05',
    'old-plain.jpg': '2000:01:09 00:00:00',
  };
  if (name === 'inside_20240102_030405.m4a') return { SourceFile: file, CreateDate: '2024:01:01 18:07:05', Duration: 65 };
  if (name === 'outside_20240102_030405.mp3') return { SourceFile: file, CreateDate: '2024:01:02 03:07:11', Duration: 65 };
  if (name === 'missing_20240102_030405.m4a') return { SourceFile: file, CreateDate: '2024:01:01 18:07:05' };
  if (name === 'before_20240102_030405.wav') return { SourceFile: file, CreateDate: '2024:01:02 03:01:04', Duration: 3600 };
  if (name === 'video_20240102_030405.mp4') return { SourceFile: file, DateTimeOriginal: '2024:01:02 03:07:05', Duration: 65 };
  if (name === 'photo_20240102_030405.jpg') return { SourceFile: file, DateTimeOriginal: '2024:01:02 03:07:05', Duration: 65 };
  if (cases[name]) return { SourceFile: file, DateTimeOriginal: cases[name] };
  if (name === 'oldutc_20250101_010000.mp4') return { SourceFile: file, MediaCreateDate: '2004:12:31 16:00:00' };
  if (name === 'exif.bin') return { SourceFile: file, DateTimeOriginal: '2022:03:04 05:06:07', CreateDate: '2021:01:01 00:00:00', GPSLatitude: 37.5, GPSLongitude: 127.1 };
  if (name === 'created.bin') return { SourceFile: file, CreateDate: '2022:04:05 06:07:08' };
  if (name === 'movie.bin') return { SourceFile: file, MediaCreateDate: '2023:01:01 16:20:30' };
  if (name === 'video.mp4') return { SourceFile: file, CreateDate: '2020:01:01 00:00:00', MediaCreateDate: '2023:01:01 16:20:30' };
  if (name === 'photo.jpg') return { SourceFile: file, CreateDate: '2022:02:02 03:04:05', MediaCreateDate: '2023:01:01 16:20:30' };
  if (name === 'call_260911_122817.m4a') return { SourceFile: file, CreateDate: '2026:09:11 03:29:11' };
  if (name.startsWith('cross_260131_235959') && name.endsWith('.m4a')) return { SourceFile: file, CreateDate: '2026:01:31 16:00:00' };
  if (name === 'zero_260201_010203.mp4') return { SourceFile: file, CreateDate: '0000:00:00 00:00:00', MediaCreateDate: '0000:00:00 00:00:00' };
  return { SourceFile: file };
})));
if (args.some((file) => path.basename(file) === 'badmeta_20240607_080910.bin')) process.exitCode = 1;
`);
  await fs.chmod(exiftoolPath, 0o755);
  async function put(kind, name, content, { folder = '', recent = false } = {}) {
    const path = join(mediaRoot, 'Inbox', kind, folder, name);
    await fs.mkdir(join(path, '..'), { recursive: true });
    await fs.writeFile(path, content);
    const time = recent ? new Date(NOW.getTime() - 30_000) : new Date('2025-01-01T00:00:00Z');
    await fs.utimes(path, time, time);
    return path;
  }
  async function person(contacts = ['가상연결']) {
    const directory = join(vaultRoot, VAULT_REL.people);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(directory, '가상인물.md'), `${buildFrontmatter({ phoneContacts: contacts })}# 가상인물\n`);
  }
  return {
    root, mediaRoot, indexPath, vaultRoot, exiftoolPath, put, person,
    options: { mediaRoot, indexPath, vaultRoot, exiftoolPath, now: NOW, output: QUIET },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function rows(indexPath) {
  const content = (await fs.readFile(indexPath, 'utf8')).trim();
  return content ? content.split('\n').map(JSON.parse) : [];
}

async function orphanFixture(f, name = '통화 녹음 가상미연결_261011_090000.m4a') {
  await f.put('Calls', name, '가상 통화');
  await runMediaArchive(f.options);
  const [record] = await rows(f.indexPath);
  await fs.writeFile(f.indexPath, '');
  await fs.unlink(join(f.mediaRoot, record.inboxPath));
  await f.person();
  const trashPath = `Trash/2026-10-11/Calls/${name}`;
  const manifest = join(f.mediaRoot, 'Trash', '2026-10-11', 'manifest.jsonl');
  await fs.mkdir(join(manifest, '..'), { recursive: true });
  await fs.writeFile(manifest, `${JSON.stringify({ record, trashPath })}\n`);
  return { record, trashPath, manifest };
}

test('manifest와 id가 맞는 미연결 고아 통화만 dry-run 후 휴지통 이동을 마친다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const { record, trashPath } = await orphanFixture(f);
  const archive = join(f.mediaRoot, record.archivePath);
  const dry = await runMediaArchive({ ...f.options, dryRun: true });
  assert.equal(dry.orphanCalls, 1);
  assert.equal(dry.trashedOrphan, 1);
  assert.ok((await fs.stat(archive)).isFile());
  const applied = await runMediaArchive(f.options);
  assert.equal(applied.trashedOrphan, 1);
  assert.equal(await fs.readFile(join(f.mediaRoot, trashPath), 'utf8'), '가상 통화');
  await assert.rejects(fs.stat(archive), { code: 'ENOENT' });
});

test('고아 통화의 manifest 부재·연결 연락처·대상 충돌은 원본을 보존한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const { record, trashPath, manifest } = await orphanFixture(f);
  const archive = join(f.mediaRoot, record.archivePath);
  await fs.writeFile(manifest, '');
  assert.equal((await runMediaArchive(f.options)).trashedOrphan, 0);
  assert.ok((await fs.stat(archive)).isFile());
  await fs.writeFile(manifest, `${JSON.stringify({ record, trashPath })}\n`);
  await f.person(['가상미연결']);
  assert.equal((await runMediaArchive(f.options)).trashedOrphan, 0);
  await f.person();
  await fs.mkdir(join(f.mediaRoot, trashPath, '..'), { recursive: true });
  await fs.writeFile(join(f.mediaRoot, trashPath), '다른 내용');
  const conflict = await runMediaArchive(f.options);
  assert.equal(conflict.trashedOrphan, 0);
  assert.ok(conflict.failed > 0);
  assert.ok((await fs.stat(archive)).isFile());
});

test('고아 통화 대상에 동일 내용이 이미 있으면 보관본만 정리한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const { record, trashPath } = await orphanFixture(f);
  const archive = join(f.mediaRoot, record.archivePath);
  await fs.mkdir(join(f.mediaRoot, trashPath, '..'), { recursive: true });
  await fs.copyFile(archive, join(f.mediaRoot, trashPath));
  const result = await runMediaArchive(f.options);
  assert.equal(result.trashedOrphan, 1);
  await assert.rejects(fs.stat(archive), { code: 'ENOENT' });
});

test('고아 통화도 기존 대량 이동 한도에 포함한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person();
  const calls = join(f.mediaRoot, 'Archive', '2026', '10', 'Calls');
  const manifest = join(f.mediaRoot, 'Trash', '2026-10-11', 'manifest.jsonl');
  await fs.mkdir(calls, { recursive: true });
  await fs.mkdir(join(manifest, '..'), { recursive: true });
  for (let number = 0; number < 21; number++) {
    const name = `통화 녹음 가상미연결_261011_${String(100000 + number)}.m4a`;
    const content = `가상 통화 ${number}`;
    const id = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const archivePath = `Archive/2026/10/Calls/${name}`;
    await fs.writeFile(join(calls, name), content);
    await fs.appendFile(manifest, `${JSON.stringify({ record: { id, kind: 'Calls', archivePath },
      trashPath: `Trash/2026-10-11/Calls/${name}` })}\n`);
  }
  const result = await runMediaArchive(f.options);
  assert.equal(result.orphanCalls, 21);
  assert.equal(result.trashedOrphan, 0);
  assert.equal((await fs.readdir(calls)).length, 21);
});

test('미연결 새 통화만 휴지통으로 옮기고 연결·형식 오류 통화는 보관한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person();
  await f.put('Calls', '통화 녹음 가상미연결_261011_090000.m4a', 'unlinked');
  await f.put('Calls', '통화 녹음 가상연결_261011_100000.m4a', 'linked');
  await f.put('Calls', '형식오류.m4a', 'unknown');
  const result = await runMediaArchive(f.options);
  assert.equal(result.trashedNew, 1);
  assert.equal(result.archived, 2);
  assert.equal((await rows(f.indexPath)).length, 2);
  assert.deepEqual(await fs.readdir(join(f.mediaRoot, 'Trash', '2026-10-11', 'Calls')),
    ['통화 녹음 가상미연결_261011_090000.m4a']);
  assert.deepEqual(result.trashedByContact, { 가상미연결: 1 });
});

test('다른 종류의 색인도 inboxPath로 가리키는 통화는 새 휴지통에서 제외한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Camera', '가상사진.bin', 'camera');
  await runMediaArchive(f.options);
  const [record] = await rows(f.indexPath);
  const call = await f.put('Calls', '통화 녹음 가상미연결_261011_090000.m4a', 'call');
  const suffixedArchive = record.archivePath.replace('/가상사진.bin', '/가상사진 (2).bin');
  await fs.rename(join(f.mediaRoot, record.archivePath), join(f.mediaRoot, suffixedArchive));
  record.archivePath = suffixedArchive;
  record.inboxPath = 'Inbox/Calls/통화 녹음 가상미연결_261011_090000.m4a';
  await fs.writeFile(f.indexPath, `${JSON.stringify(record)}\n`);
  await f.person();
  const result = await runMediaArchive({ ...f.options, dryRun: true });
  assert.equal(result.trashedNew, 0);
  assert.ok((await fs.stat(call)).isFile());
});

test('인물 연락처가 비면 통화와 이전 휴지통을 삭제하지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person([]);
  await f.put('Calls', '통화 녹음 가상미연결_261011_090000.m4a', 'unlinked');
  await fs.mkdir(join(f.mediaRoot, 'Trash', '2026-08-01'), { recursive: true });
  const result = await runMediaArchive(f.options);
  assert.equal(result.archived, 1);
  assert.equal(result.trashedNew, 0);
  assert.equal(result.cleanedTrash, 0);
  assert.ok((await fs.stat(join(f.mediaRoot, 'Trash', '2026-08-01'))).isDirectory());
});

test('인물 노트 머리말이 손상되면 다른 연락처가 있어도 삭제를 건너뛴다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person();
  await fs.writeFile(join(f.vaultRoot, VAULT_REL.people, '가상손상.md'), '---\nphoneContacts: [broken\n');
  await f.put('Calls', '통화 녹음 가상미연결_261011_090000.m4a', 'unlinked');
  const result = await runMediaArchive(f.options);
  assert.equal(result.trashedNew, 0);
  assert.equal(result.archived, 1);
});

test('엄격 모드에서 휴지통을 건너뛰면 요약에 이유를 표시한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person([]);
  await f.put('Calls', '통화 녹음 가상미연결_261011_090000.m4a', 'unlinked');
  const logs = [];
  const result = await runMediaArchive({ ...f.options, output: { log: (line) => logs.push(line), error() {} } });
  assert.equal(result.archived, 1);
  assert.ok(logs.some((line) => line.includes('엄격 모드 건너뜀')));
});

test('기존 미연결 통화는 보관본·전사를 휴지통에 보존하고 동일 inode Inbox만 지운다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Calls', '통화 녹음 가상미연결_261011_090000.m4a', 'original');
  await runMediaArchive(f.options);
  const [record] = await rows(f.indexPath);
  const transcript = join(f.vaultRoot, VAULT_REL.mediaTranscripts, '2026', `${record.id}.json`);
  await fs.mkdir(join(transcript, '..'), { recursive: true });
  await fs.writeFile(transcript, '{}');
  await f.person();
  const result = await runMediaArchive(f.options);
  assert.equal(result.trashedNew, 0);
  assert.equal(result.trashedExisting, 1);
  assert.deepEqual(await rows(f.indexPath), []);
  await assert.rejects(fs.stat(join(f.mediaRoot, record.inboxPath)), { code: 'ENOENT' });
  await assert.rejects(fs.stat(transcript), { code: 'ENOENT' });
  assert.equal(await fs.readFile(join(f.mediaRoot, 'Trash', '2026-10-11', 'Transcripts', `${record.id}.json`), 'utf8'), '{}');
  const manifest = await fs.readFile(join(f.mediaRoot, 'Trash', '2026-10-11', 'manifest.jsonl'), 'utf8');
  assert.equal(JSON.parse(manifest.trim()).record.id, record.id);
  await assert.rejects(fs.stat(join(f.mediaRoot, record.archivePath)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(join(f.mediaRoot, 'Trash', '2026-10-11', 'Calls')),
    ['통화 녹음 가상미연결_261011_090000.m4a']);
  const separate = await f.put('Calls', '통화 녹음 가상미연결_261011_100000.m4a', 'before');
  await fs.rm(join(f.vaultRoot, VAULT_REL.people, '가상인물.md'));
  await runMediaArchive(f.options);
  const [second] = await rows(f.indexPath);
  await f.person();
  await fs.unlink(separate);
  await fs.writeFile(separate, 'different inode');
  await runMediaArchive(f.options);
  assert.equal(await fs.readFile(separate, 'utf8'), 'different inode');
  assert.deepEqual(await rows(f.indexPath), []);
  assert.ok((await fs.readdir(join(f.mediaRoot, 'Trash', '2026-10-11', 'Calls'))).length >= 2);
  assert.ok(second);
});

test('색인된 통화의 종류 경로가 틀리면 이동 전에 중단한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Calls', '통화 녹음 가상미연결_261011_090000.m4a', 'original');
  await runMediaArchive(f.options);
  const [record] = await rows(f.indexPath);
  record.archivePath = record.archivePath.replace('/Calls/', '/Camera/');
  await fs.writeFile(f.indexPath, `${JSON.stringify(record)}\n`);
  await f.person();
  const invalid = await runMediaArchive(f.options);
  assert.ok(invalid.failed >= 1);
  await assert.rejects(fs.stat(join(f.mediaRoot, 'Trash')), { code: 'ENOENT' });
  assert.equal((await rows(f.indexPath))[0].archivePath, record.archivePath);
});

test('대량 차단은 아무것도 휴지통에 넣지 않고 붙잡힌 새 통화는 보관하며, 명시 플래그만 허용한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person();
  for (let index = 0; index < 21; index += 1) {
    await f.put('Calls', `통화 녹음 가상미연결_261011_${String(index).padStart(2, '0')}0000.m4a`, String(index));
  }
  const blocked = await runMediaArchive(f.options);
  assert.equal(blocked.failed, 1);
  assert.equal(blocked.trashedNew, 0);
  assert.equal(blocked.archived, 21);
  await assert.rejects(fs.stat(join(f.mediaRoot, 'Trash')), { code: 'ENOENT' });
  assert.equal((await rows(f.indexPath)).length, 21);
  const allowed = await runMediaArchive({ ...f.options, allowBulkTrash: true });
  assert.equal(allowed.trashedExisting, 21);
  assert.equal((await rows(f.indexPath)).length, 0);
});

test('대량 차단이어도 붙잡힌 새 통화를 보관하며 손상된 색인 꼬리를 정리한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person();
  await fs.mkdir(join(f.indexPath, '..'), { recursive: true });
  const partial = '{"id":"incomplete"';
  await fs.writeFile(f.indexPath, partial);
  for (let index = 0; index < 21; index += 1) {
    await f.put('Calls', `통화 녹음 가상미연결_261011_${String(index).padStart(2, '0')}0000.m4a`, String(index));
  }
  const result = await runMediaArchive(f.options);
  assert.equal(result.failed, 1);
  assert.equal((await rows(f.indexPath)).length, 21);
  assert.ok(!(await fs.readFile(f.indexPath, 'utf8')).includes(partial));
  await assert.rejects(fs.stat(join(f.mediaRoot, 'Trash')), { code: 'ENOENT' });
});

test('30일 지난 날짜 폴더만 정리하고 dry-run은 모든 경로를 보존한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person();
  const old = join(f.mediaRoot, 'Trash', '2026-08-01');
  const unknown = join(f.mediaRoot, 'Trash', 'keep-me');
  await fs.mkdir(old, { recursive: true });
  await fs.mkdir(join(f.mediaRoot, 'Trash', '2026-10-10'), { recursive: true }); // 최근 기록(시계 앞튐 보호 기준)
  await fs.mkdir(unknown, { recursive: true });
  await fs.writeFile(join(old, 'manifest.jsonl'), `${JSON.stringify({
    record: { id: 'abcdef0123456789', kind: 'Recordings' },
    trashPath: 'Trash/2026-08-01/Recordings/가상녹음.m4a',
  })}\n`);
  await f.put('Calls', '통화 녹음 가상미연결_261011_090000.m4a', 'unlinked');
  const dry = await runMediaArchive({ ...f.options, dryRun: true });
  assert.equal(dry.trashedNew, 1);
  assert.equal(dry.cleanedTrash, 1);
  assert.ok((await fs.stat(old)).isDirectory());
  await assert.rejects(fs.stat(f.indexPath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(join(f.mediaRoot, 'Trash', 'purged.jsonl')), { code: 'ENOENT' });
  const applied = await runMediaArchive(f.options);
  assert.equal(applied.cleanedTrash, 1);
  await assert.rejects(fs.stat(old), { code: 'ENOENT' });
  assert.ok((await fs.stat(unknown)).isDirectory());
});

test('영구 삭제 목록이 심볼릭 링크면 보관을 중단하고 Inbox를 보존한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  resetWarnings();
  t.after(resetWarnings);
  const inbox = await f.put('Recordings', '가상녹음.m4a', 'unreadable trash list');
  const trash = join(f.mediaRoot, 'Trash');
  await fs.mkdir(trash);
  const target = join(f.root, 'outside.jsonl');
  await fs.writeFile(target, '');
  await fs.symlink(target, join(trash, 'purged.jsonl'));
  const result = await runMediaArchive(f.options);
  assert.equal(result.failed, 1);
  assert.equal(result.archived, 0);
  assert.equal(warningCount(), 1);
  assert.ok((await fs.stat(inbox)).isFile());
  await assert.rejects(fs.stat(f.indexPath), { code: 'ENOENT' });
});

test('날짜형 휴지통 폴더가 심볼릭 링크면 보관을 중단하고 Inbox를 보존한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  resetWarnings();
  t.after(resetWarnings);
  const inbox = await f.put('Recordings', '가상녹음.m4a', 'deleted recording');
  const id = createHash('sha256').update('deleted recording').digest('hex').slice(0, 16);
  const outside = join(f.root, 'outside-trash');
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, 'manifest.jsonl'), `${JSON.stringify({ record: { id } })}\n`);
  await fs.mkdir(join(f.mediaRoot, 'Trash'));
  await fs.symlink(outside, join(f.mediaRoot, 'Trash', '2026-08-01'));
  const result = await runMediaArchive(f.options);
  assert.equal(result.failed, 1);
  assert.equal(result.archived, 0);
  assert.equal(warningCount(), 1);
  assert.ok((await fs.stat(inbox)).isFile());
  await assert.rejects(fs.stat(f.indexPath), { code: 'ENOENT' });
});

test('휴지통 manifest의 녹음 ID는 Inbox에 다시 나타나도 보관하지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const inbox = await f.put('Recordings', '가상녹음.m4a', 'deleted recording');
  const id = createHash('sha256').update('deleted recording').digest('hex').slice(0, 16);
  const manifest = join(f.mediaRoot, 'Trash', '2026-08-01', 'manifest.jsonl');
  await fs.mkdir(join(manifest, '..'), { recursive: true });
  await fs.writeFile(manifest, 'broken json\n' + `${JSON.stringify({
    record: { id, kind: 'Recordings', inboxPath: 'Inbox/Recordings/가상녹음.m4a' },
    trashPath: 'Trash/2026-08-01/Recordings/가상녹음.m4a',
  })}\n`);
  for (const options of [{ dryRun: true }, {}]) {
    const result = await runMediaArchive({ ...f.options, ...options });
    assert.equal(result.trashIgnored, 1);
    assert.equal(result.archived, 0);
    assert.equal(result.failed, 0);
    assert.ok((await fs.stat(inbox)).isFile());
    await assert.rejects(fs.stat(f.indexPath), { code: 'ENOENT' });
  }
});

test('영구 삭제 목록의 녹음 ID도 다시 보관하지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const inbox = await f.put('Recordings', '가상녹음.m4a', 'purged recording');
  const id = createHash('sha256').update('purged recording').digest('hex').slice(0, 16);
  const purged = join(f.mediaRoot, 'Trash', 'purged.jsonl');
  await fs.mkdir(join(purged, '..'), { recursive: true });
  await fs.writeFile(purged, `broken json\n${JSON.stringify({ id, kind: 'Recordings' })}\n`);
  const result = await runMediaArchive(f.options);
  assert.equal(result.trashIgnored, 1);
  assert.equal(result.archived, 0);
  assert.equal(result.failed, 0);
  assert.ok((await fs.stat(inbox)).isFile());
  await assert.rejects(fs.stat(f.indexPath), { code: 'ENOENT' });
});

test('만료 폴더 manifest를 영구 삭제 목록에 기록한 뒤 폴더를 지운다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person();
  const old = join(f.mediaRoot, 'Trash', '2026-08-01');
  await fs.mkdir(old, { recursive: true });
  await fs.mkdir(join(f.mediaRoot, 'Trash', '2026-10-10'), { recursive: true });
  const record = { id: 'abcdef0123456789', kind: 'Recordings', inboxPath: 'Inbox/Recordings/가상녹음.m4a' };
  const trashPath = 'Trash/2026-08-01/Recordings/가상녹음.m4a';
  await fs.writeFile(join(old, 'manifest.jsonl'), `broken json\n${JSON.stringify({ record, trashPath })}\n`);
  const result = await runMediaArchive(f.options);
  assert.equal(result.cleanedTrash, 1);
  assert.deepEqual(JSON.parse((await fs.readFile(join(f.mediaRoot, 'Trash', 'purged.jsonl'), 'utf8')).trim()),
    { id: record.id, kind: record.kind, inboxPath: record.inboxPath, trashPath,
      purgedAt: '2026-10-11T15:00:00.000+09:00' });
  await assert.rejects(fs.stat(old), { code: 'ENOENT' });
});

test('끊긴 영구 삭제 목록 뒤에 새 ID를 온전한 줄로 기록한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person();
  const old = join(f.mediaRoot, 'Trash', '2026-08-01');
  const purged = join(f.mediaRoot, 'Trash', 'purged.jsonl');
  const content = 'newly purged recording';
  const id = createHash('sha256').update(content).digest('hex').slice(0, 16);
  await fs.mkdir(old, { recursive: true });
  await fs.mkdir(join(f.mediaRoot, 'Trash', '2026-10-10'), { recursive: true });
  await fs.writeFile(join(old, 'manifest.jsonl'), `${JSON.stringify({
    record: { id, kind: 'Recordings', inboxPath: 'Inbox/Recordings/가상녹음.m4a' },
    trashPath: 'Trash/2026-08-01/Recordings/가상녹음.m4a',
  })}\n`);
  await fs.writeFile(purged, '{"id":"unfinished"');
  assert.equal((await runMediaArchive(f.options)).cleanedTrash, 1);
  const lines = (await fs.readFile(purged, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).id, id);
  const inbox = await f.put('Recordings', '가상녹음.m4a', content);
  const rerun = await runMediaArchive(f.options);
  assert.equal(rerun.trashIgnored, 1);
  assert.equal(rerun.archived, 0);
  assert.ok((await fs.stat(inbox)).isFile());
});

test('이미 영구 삭제 목록에 있는 ID를 정리할 때 중복 기록하지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person();
  const old = join(f.mediaRoot, 'Trash', '2026-08-01');
  const purged = join(f.mediaRoot, 'Trash', 'purged.jsonl');
  const id = 'abcdef0123456789';
  await fs.mkdir(old, { recursive: true });
  await fs.mkdir(join(f.mediaRoot, 'Trash', '2026-10-10'), { recursive: true });
  await fs.writeFile(join(old, 'manifest.jsonl'), `${JSON.stringify({
    record: { id, kind: 'Recordings' }, trashPath: 'Trash/2026-08-01/Recordings/가상녹음.m4a',
  })}\n`);
  const existing = `${JSON.stringify({ id, kind: 'Recordings' })}\n`;
  await fs.writeFile(purged, existing);
  assert.equal((await runMediaArchive(f.options)).cleanedTrash, 1);
  assert.equal(await fs.readFile(purged, 'utf8'), existing);
  await assert.rejects(fs.stat(old), { code: 'ENOENT' });
});

test('영구 삭제 목록에 기록하지 못하면 만료 폴더를 보존한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person();
  const old = join(f.mediaRoot, 'Trash', '2026-08-01');
  const purged = join(f.mediaRoot, 'Trash', 'purged.jsonl');
  await fs.mkdir(old, { recursive: true });
  await fs.mkdir(join(f.mediaRoot, 'Trash', '2026-10-10'), { recursive: true });
  await fs.writeFile(join(old, 'manifest.jsonl'), `${JSON.stringify({
    record: { id: 'abcdef0123456789', kind: 'Recordings' },
    trashPath: 'Trash/2026-08-01/Recordings/가상녹음.m4a',
  })}\n`);
  await fs.writeFile(purged, '');
  await fs.chmod(purged, 0o444);
  const result = await runMediaArchive(f.options);
  assert.equal(result.cleanedTrash, 0);
  assert.equal(result.failed, 1);
  assert.ok((await fs.stat(old)).isDirectory());
});

test('색인에 있는 ID는 휴지통 기록과 무관하게 기존대로 건너뛴다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Recordings', '가상녹음.m4a', 'indexed recording');
  await runMediaArchive(f.options);
  const [record] = await rows(f.indexPath);
  const purged = join(f.mediaRoot, 'Trash', 'purged.jsonl');
  await fs.mkdir(join(purged, '..'), { recursive: true });
  await fs.writeFile(purged, `${JSON.stringify({ id: record.id })}\n`);
  const result = await runMediaArchive(f.options);
  assert.equal(result.skipped, 1);
  assert.equal(result.trashIgnored, 0);
  assert.equal(result.failed, 0);
  assert.equal((await rows(f.indexPath)).length, 1);
});

test('휴지통 날짜가 미래이면 정리하지 않고, 과거 폴더도 실행당 세 개만 정리한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person();
  for (const day of ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']) {
    await fs.mkdir(join(f.mediaRoot, 'Trash', day), { recursive: true });
  }
  await fs.mkdir(join(f.mediaRoot, 'Trash', '2026-10-10'), { recursive: true });
  const future = join(f.mediaRoot, 'Trash', '2026-10-12');
  await fs.mkdir(future, { recursive: true });
  const guarded = await runMediaArchive(f.options);
  assert.equal(guarded.cleanedTrash, 0);
  await fs.rm(future, { recursive: true });
  const limited = await runMediaArchive(f.options);
  assert.equal(limited.cleanedTrash, 3);
  assert.ok((await fs.stat(join(f.mediaRoot, 'Trash', '2026-07-04'))).isDirectory());
});

test('시계가 최근 기록보다 2일 넘게 앞서면 휴지통을 정리하지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person();
  const old = join(f.mediaRoot, 'Trash', '2026-08-01');
  await fs.mkdir(old, { recursive: true });
  const jumped = await runMediaArchive(f.options);
  assert.equal(jumped.cleanedTrash, 0);
  assert.ok((await fs.stat(old)).isDirectory());
  await fs.mkdir(join(f.mediaRoot, 'Trash', '2026-10-09'), { recursive: true });
  const normal = await runMediaArchive(f.options);
  assert.equal(normal.cleanedTrash, 1);
});

test('기존 같은 연락처 네 건은 급변 보호하고 보관 작업은 완료한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  for (let index = 0; index < 4; index += 1) {
    await f.put('Calls', `통화 녹음 가상미연결_261011_0${index}0000.m4a`, `call-${index}`);
  }
  await runMediaArchive(f.options);
  await f.person();
  const protectedNew = await f.put('Calls', '통화 녹음 가상미연결_261011_050000.m4a', 'new');
  await f.put('Camera', '추가사진.jpg', 'photo');
  const guarded = await runMediaArchive(f.options);
  // 보호된 연락처의 새 통화는 지우지 않고 사진과 함께 보관한다.
  assert.equal(guarded.archived, 2);
  assert.equal(guarded.trashedExisting, 0);
  assert.equal(guarded.trashedNew, 0);
  assert.ok((await fs.stat(protectedNew)).isFile());
  assert.equal(guarded.failed, 1); // 연락처당 한 번만 센다
  assert.equal((await rows(f.indexPath)).length, 6);
  const allowed = await runMediaArchive({ ...f.options, allowBulkTrash: true });
  assert.equal(allowed.trashedExisting, 5);
  assert.equal(allowed.trashedNew, 0);
});

test('기존 대상 여러 건과 새 보관 건을 색인에 한 번만 원자적으로 쓴다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Calls', '통화 녹음 가상미연결_261011_090000.m4a', 'first');
  await f.put('Calls', '통화 녹음 가상미연결_261011_100000.m4a', 'second');
  await runMediaArchive(f.options);
  await f.person();
  await f.put('Camera', 'photo.jpg', 'photo');
  let writes = 0;
  const result = await runMediaArchive({ ...f.options, atomicWrite(path, content) {
    writes += 1;
    writeAtomic(path, content);
  } });
  assert.equal(writes, 1);
  assert.equal(result.archived, 1);
  assert.equal(result.trashedExisting, 2);
  assert.equal((await rows(f.indexPath)).length, 1);
});

test('색인 쓰기 실패 후에는 보관 통화를 이동하지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Calls', '통화 녹음 가상미연결_261011_090000.m4a', 'first');
  await runMediaArchive(f.options);
  const [record] = await rows(f.indexPath);
  await f.person();
  const result = await runMediaArchive({ ...f.options, atomicWrite() { throw new Error('가상 쓰기 실패'); } });
  assert.ok(result.failed > 0);
  assert.equal(result.trashedExisting, 0);
  assert.ok((await fs.stat(join(f.mediaRoot, record.archivePath))).isFile());
  assert.equal((await rows(f.indexPath)).length, 1);
});

test('매니페스트 심볼릭 링크에는 쓰지 않고 보관 통화도 이동하지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Calls', '통화 녹음 가상미연결_261011_090000.m4a', 'first');
  await runMediaArchive(f.options);
  const [record] = await rows(f.indexPath);
  await f.person();
  const outside = join(f.root, 'outside.txt');
  await fs.writeFile(outside, 'untouched');
  const dated = join(f.mediaRoot, 'Trash', '2026-10-11');
  await fs.mkdir(dated, { recursive: true });
  await fs.symlink(outside, join(dated, 'manifest.jsonl'));
  const result = await runMediaArchive(f.options);
  assert.ok(result.failed > 0);
  assert.equal(result.trashedExisting, 0);
  assert.equal(await fs.readFile(outside, 'utf8'), 'untouched');
  assert.ok((await fs.stat(join(f.mediaRoot, record.archivePath))).isFile());
});

test('색인이 가리키는 보관 통화가 없어도 다른 보관 작업은 완료한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Calls', '통화 녹음 가상미연결_261011_090000.m4a', 'first');
  await runMediaArchive(f.options);
  const [record] = await rows(f.indexPath);
  await fs.unlink(join(f.mediaRoot, record.archivePath));
  await f.person();
  await f.put('Camera', 'photo.jpg', 'photo');
  const result = await runMediaArchive(f.options);
  assert.equal(result.archived, 1);
  assert.ok(result.failed > 0);
  assert.equal(result.trashedExisting, 0);
});

test('휴지통 직전 Inbox 통화가 바뀌면 그 파일만 건너뛰고 보관 결과를 남긴다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person();
  const call = await f.put('Calls', '통화 녹음 가상미연결_261011_090000.m4a', 'first');
  await f.put('Camera', 'photo.jpg', 'photo');
  const result = await runMediaArchive({ ...f.options, atomicWrite(path, content) {
    writeAtomic(path, content);
    appendFileSync(call, 'changed');
  } });
  assert.equal(result.archived, 1);
  assert.equal(result.trashedNew, 0);
  assert.ok(result.failed > 0);
  assert.ok((await fs.stat(call)).isFile());
});

test('exiftool 실패는 보관 파일만 실패시키고 휴지통 단계는 계속한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.person();
  const call = await f.put('Calls', '통화 녹음 가상미연결_261011_090000.m4a', 'unlinked');
  await f.put('Camera', 'sample.bin', 'camera');
  const old = join(f.mediaRoot, 'Trash', '2026-08-01');
  await fs.mkdir(old, { recursive: true });
  await fs.mkdir(join(f.mediaRoot, 'Trash', '2026-10-10'), { recursive: true });
  const result = await runMediaArchive({ ...f.options, exiftoolPath: join(f.root, 'missing-exiftool') });
  assert.equal(result.failed, 1);
  assert.equal(result.trashedNew, 1);
  assert.equal(result.cleanedTrash, 1);
  await assert.rejects(fs.stat(call), { code: 'ENOENT' });
  await assert.rejects(fs.stat(old), { code: 'ENOENT' });
  await assert.rejects(fs.stat(f.indexPath), { code: 'ENOENT' });
});

test('날짜 우선순위, KST 영상, 파일명 형식, mtime, 하드링크와 재실행 멱등성', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const exif = await f.put('Camera', 'exif.bin', 'a');
  await f.put('Camera', '20240102_030405.jpg', 'b', { folder: 'nested' });
  await f.put('Screenshots', 'Screenshot_20240203-040506.png', 'c');
  await f.put('Recordings', '240405_0607.m4a', 'd');
  await f.put('Calls', '1700000000000.m4a', 'e');
  await f.put('Camera', 'movie.bin', 'f');
  await f.put('Camera', 'created.bin', 'h');
  await f.put('Camera', 'video.mp4', 'v');
  await f.put('Camera', 'photo.jpg', 'p');
  await f.put('Camera', 'plain.bin', 'g');

  const first = await runMediaArchive(f.options);
  assert.equal(first.archived, 10);
  assert.deepEqual(first.capturedFrom, { exif: 5, filename: 4, mtime: 1 });
  const records = await rows(f.indexPath);
  const byInbox = (name) => records.find((row) => row.inboxPath.endsWith(name));
  assert.equal(byInbox('exif.bin').capturedAt, '2022-03-04T05:06:07.000+09:00');
  assert.deepEqual(byInbox('exif.bin').gps, { lat: 37.5, lon: 127.1 });
  assert.equal(byInbox('movie.bin').capturedAt, '2023-01-02T01:20:30.000+09:00');
  assert.equal(byInbox('created.bin').capturedAt, '2022-04-05T06:07:08.000+09:00');
  assert.equal(byInbox('video.mp4').capturedAt, '2023-01-02T01:20:30.000+09:00');
  assert.equal(byInbox('photo.jpg').capturedAt, '2022-02-02T03:04:05.000+09:00');
  assert.equal(byInbox('20240102_030405.jpg').capturedFrom, 'filename');
  assert.equal(byInbox('Screenshot_20240203-040506.png').capturedFrom, 'filename');
  assert.equal(byInbox('240405_0607.m4a').capturedAt, '2024-04-05T06:07:00.000+09:00');
  assert.equal(byInbox('plain.bin').capturedFrom, 'mtime');
  const target = join(f.mediaRoot, byInbox('exif.bin').archivePath);
  assert.equal((await fs.stat(exif)).ino, (await fs.stat(target)).ino);
  const second = await runMediaArchive(f.options);
  assert.equal(second.archived, 0);
  assert.equal(second.skipped, 10);
  assert.deepEqual(second.capturedFrom, { exif: 5, filename: 4, mtime: 1 });
  assert.deepEqual(await rows(f.indexPath), records);
  assert.equal((await fs.readFile(join(f.root, 'calls'), 'utf8')).trim().split('\n').length, 2);
});

test('KakaoTalk 사진을 촬영 시각 월의 Archive에 하드링크로 보관한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const source = await f.put('KakaoTalk', '1704164645001.jpg', 'kakao-photo');

  const summary = await runMediaArchive(f.options);
  const [record] = await rows(f.indexPath);
  const target = join(f.mediaRoot, record.archivePath);

  assert.equal(summary.archived, 1);
  assert.equal(record.kind, 'KakaoTalk');
  assert.equal(record.inboxPath, 'Inbox/KakaoTalk/1704164645001.jpg');
  assert.equal(record.archivePath, 'Archive/2024/01/KakaoTalk/1704164645001.jpg');
  assert.equal(record.capturedFrom, 'filename');
  assert.equal(record.capturedConfidence, 'estimated');
  assert.equal((await fs.stat(source)).ino, (await fs.stat(target)).ino);
});

test('KakaoTalkMovie를 저장 시각 월에 하드링크로 보관하고 촬영 시각을 추정한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const source = await f.put('KakaoTalkMovie', '2026_01_29 19_51.mp4', 'kakao-movie');

  const summary = await runMediaArchive(f.options);
  const [record] = await rows(f.indexPath);
  const target = join(f.mediaRoot, record.archivePath);

  assert.equal(summary.archived, 1);
  assert.equal(record.kind, 'KakaoTalkMovie');
  assert.equal(record.inboxPath, 'Inbox/KakaoTalkMovie/2026_01_29 19_51.mp4');
  assert.equal(record.archivePath, 'Archive/2026/01/KakaoTalkMovie/2026_01_29 19_51.mp4');
  assert.equal(record.capturedAt, '2026-01-29T19:51:00.000+09:00');
  assert.equal(record.capturedFrom, 'filename');
  assert.equal(record.capturedConfidence, 'estimated');
  assert.match(record.capturedReason, /저장 시각 파일명만/);
  assert.equal((await fs.stat(source)).ino, (await fs.stat(target)).ino);
});

test('저장 시각 파일명은 밑줄 구분과 선택적 초도 파싱한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('KakaoTalkMovie', '2026_01_29_19_51.mp4', 'minute');
  await f.put('KakaoTalkMovie', '2026_01_29 19_51_42.mp4', 'second');

  await runMediaArchive(f.options);
  const records = await rows(f.indexPath);
  const byName = (name) => records.find((record) => record.inboxPath.endsWith(name));
  assert.equal(byName('2026_01_29_19_51.mp4').capturedAt, '2026-01-29T19:51:00.000+09:00');
  assert.equal(byName('2026_01_29 19_51_42.mp4').capturedAt, '2026-01-29T19:51:42.000+09:00');
  assert.ok(records.every((record) => record.capturedConfidence === 'estimated'));
});

test('촬영 시각은 EXIF·카메라형·저장형 파일명을 대조하고 불확실성을 색인과 요약에 남긴다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const names = [
    'old_20240102_030405.jpg', 'agree_20240102_030405.jpg',
    'differ_20240102_030405.jpg', '1704164645000.jpg',
    'BandPhoto_2024_01_02_03_04_05.jpg', 'only-exif.jpg',
    'camera_20240102-030405.jpg', '1704164645001.jpg',
    'BandPhoto_2024_01_02_03_04_06.jpg',
    'plain-no-date.jpg', 'old-plain.jpg',
  ];
  for (const name of names) await f.put('Camera', name, name);
  const logs = [];
  const summary = await runMediaArchive({ ...f.options, output: { log: (line) => logs.push(line), error() {} } });
  const records = await rows(f.indexPath);
  const byName = (name) => records.find((row) => row.inboxPath.endsWith(name));
  assert.equal(summary.archived, names.length);
  assert.equal(byName('old_20240102_030405.jpg').capturedFrom, 'filename');
  assert.equal(byName('old_20240102_030405.jpg').capturedConfidence, 'single');
  assert.match(byName('old_20240102_030405.jpg').capturedReason, /EXIF 2005년 이전/);
  assert.equal(byName('agree_20240102_030405.jpg').capturedConfidence, 'confirmed');
  assert.equal(byName('agree_20240102_030405.jpg').capturedAt, '2024-01-02T03:05:00.000+09:00');
  assert.equal(byName('differ_20240102_030405.jpg').capturedConfidence, 'review');
  assert.match(byName('differ_20240102_030405.jpg').capturedReason, /3일 차이/);
  assert.equal(byName('1704164645000.jpg').capturedConfidence, 'single');
  assert.equal(byName('1704164645000.jpg').capturedFrom, 'exif');
  assert.equal(byName('BandPhoto_2024_01_02_03_04_05.jpg').capturedConfidence, 'review');
  assert.match(byName('BandPhoto_2024_01_02_03_04_05.jpg').capturedReason, /저장 시각보다 늦음/);
  assert.equal(byName('only-exif.jpg').capturedConfidence, 'single');
  assert.equal(byName('camera_20240102-030405.jpg').capturedConfidence, 'single');
  assert.equal(byName('camera_20240102-030405.jpg').capturedFrom, 'filename');
  assert.equal(byName('1704164645001.jpg').capturedConfidence, 'estimated');
  assert.match(byName('1704164645001.jpg').capturedReason, /저장 시각 파일명만/);
  assert.equal(byName('BandPhoto_2024_01_02_03_04_06.jpg').capturedConfidence, 'estimated');
  assert.equal(byName('BandPhoto_2024_01_02_03_04_06.jpg').capturedAt, '2024-01-02T03:04:06.000+09:00');
  assert.equal(byName('plain-no-date.jpg').capturedConfidence, 'review');
  assert.equal(byName('plain-no-date.jpg').capturedReason, '수정일뿐');
  assert.equal(byName('old-plain.jpg').capturedReason, 'EXIF 2005년 이전·수정일뿐');
  assert.deepEqual(summary.capturedConfidence, { confirmed: 1, single: 4, estimated: 2, review: 4 });
  assert.match(logs.at(-1), /판정 confirmed 1, single 4, estimated 2, review 4/);
});

test('repair-times는 촬영 시각이 같아도 confidence와 reason 변경을 색인에 반영한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Camera', 'agree_20240102_030405.jpg', 'agree');
  await runMediaArchive(f.options);
  const [record] = await rows(f.indexPath);
  record.capturedConfidence = 'review';
  record.capturedReason = '옛 판정';
  await fs.writeFile(f.indexPath, `${JSON.stringify(record)}\n`);
  const dry = await repairMediaArchiveTimes(f.options);
  assert.equal(dry.changed, 0);
  assert.equal((await rows(f.indexPath))[0].capturedConfidence, 'review');
  await repairMediaArchiveTimes({ ...f.options, apply: true });
  const [fixed] = await rows(f.indexPath);
  assert.equal(fixed.capturedConfidence, 'confirmed');
  assert.equal(fixed.capturedReason, undefined);
  assert.equal((await repairMediaArchiveTimes(f.options)).changed, 0);
});

test('repair-times --apply는 오너 확정 날짜를 다시 계산하지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Camera', 'agree_20240102_030405.jpg', 'agree');
  await runMediaArchive(f.options);
  const [record] = await rows(f.indexPath);
  record.capturedAt = '2023-12-31T12:00:00+09:00';
  record.capturedFrom = 'owner';
  record.capturedConfidence = 'confirmed';
  await fs.writeFile(f.indexPath, `${JSON.stringify(record)}\n`);
  const before = await fs.readFile(f.indexPath, 'utf8');
  assert.equal((await repairMediaArchiveTimes({ ...f.options, apply: true })).changed, 0);
  assert.equal(await fs.readFile(f.indexPath, 'utf8'), before);
});

test('2분 일치는 confirmed이고 UTC 비디오 EXIF의 원본 연도가 2004면 버린다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Camera', 'boundary_20240102_030405.jpg', 'boundary');
  await f.put('Camera', 'oldutc_20250101_010000.mp4', 'oldutc');
  await runMediaArchive(f.options);
  const records = await rows(f.indexPath);
  const byName = (name) => records.find((row) => row.inboxPath.endsWith(name));
  assert.equal(byName('boundary_20240102_030405.jpg').capturedConfidence, 'confirmed');
  assert.equal(byName('oldutc_20250101_010000.mp4').capturedFrom, 'filename');
  assert.equal(byName('oldutc_20250101_010000.mp4').capturedAt, '2025-01-01T01:00:00.000+09:00');
  assert.match(byName('oldutc_20250101_010000.mp4').capturedReason, /EXIF 2005년 이전/);
});

test('녹음·영상은 EXIF 종료 시각이 재생 길이와 2분 이내면 원래 EXIF 시각으로 confirmed한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  for (const name of [
    'inside_20240102_030405.m4a', 'outside_20240102_030405.mp3',
    'missing_20240102_030405.m4a', 'before_20240102_030405.wav',
    'video_20240102_030405.mp4', 'photo_20240102_030405.jpg',
  ]) await f.put('Recordings', name, name);
  await runMediaArchive(f.options);
  const records = await rows(f.indexPath);
  const byName = (name) => records.find((row) => row.inboxPath.endsWith(name));
  for (const name of ['inside_20240102_030405.m4a', 'video_20240102_030405.mp4']) {
    assert.equal(byName(name).capturedConfidence, 'confirmed');
    assert.equal(byName(name).capturedFrom, 'exif');
    assert.equal(byName(name).capturedAt, '2024-01-02T03:07:05.000+09:00');
  }
  for (const name of [
    'outside_20240102_030405.mp3', 'missing_20240102_030405.m4a',
    'before_20240102_030405.wav', 'photo_20240102_030405.jpg',
  ]) assert.equal(byName(name).capturedConfidence, 'review');

  const originalTime = byName('inside_20240102_030405.m4a').capturedAt;
  byName('inside_20240102_030405.m4a').capturedConfidence = 'review';
  byName('inside_20240102_030405.m4a').capturedReason = '옛 판정';
  await fs.writeFile(f.indexPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  assert.equal((await repairMediaArchiveTimes(f.options)).changed, 0);
  await repairMediaArchiveTimes({ ...f.options, apply: true });
  const repaired = (await rows(f.indexPath)).find((row) => row.inboxPath.endsWith('inside_20240102_030405.m4a'));
  assert.equal(repaired.capturedConfidence, 'confirmed');
  assert.equal(repaired.capturedAt, originalTime);
  assert.equal(repaired.capturedReason, undefined);
});

test('Syncthing 임시 파일, 숨김 파일, 최근 수정 파일을 제외한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Camera', 'good.bin', 'a');
  for (const name of ['.stfolder', '.stignore', '.syncthing.tmp', '~syncthing~part', 'piece.tmp', '.hidden']) {
    await f.put('Camera', name, 'x');
  }
  await f.put('Camera', 'recent.bin', 'r', { recent: true });
  assert.equal((await runMediaArchive(f.options)).archived, 1);
  assert.equal((await rows(f.indexPath)).length, 1);
});

test('같은 이름 다른 내용에는 접미사를 붙이고 기존 같은 내용은 재사용한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Camera', 'same.bin', 'one', { folder: 'left' });
  await f.put('Camera', 'same.bin', 'two', { folder: 'right' });
  const result = await runMediaArchive(f.options);
  assert.equal(result.archived, 2);
  const paths = (await rows(f.indexPath)).map((row) => row.archivePath).sort();
  assert.ok(paths.some((path) => path.endsWith('/same.bin')));
  assert.ok(paths.some((path) => path.endsWith('/same (2).bin')));
  // 색인 쓰기 전에 중단된 상황: 이미 만든 동일 하드링크를 재사용한다.
  await fs.writeFile(f.indexPath, '');
  const recovered = await runMediaArchive(f.options);
  assert.equal(recovered.archived, 0);
  assert.equal(recovered.skipped, 2);
  assert.equal((await rows(f.indexPath)).length, 2);
  assert.equal((await fs.readdir(join(f.mediaRoot, 'Archive', '2025', '01', 'Camera'))).length, 2);
});

test('하드링크 실패 시 복사하지 않고 실패를 보고한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Camera', 'sample.bin', 'a');
  const result = await runMediaArchive({ ...f.options, link: async () => {
    const error = new Error('cross-device');
    error.code = 'EXDEV';
    throw error;
  } });
  assert.equal(result.failed, 1);
  await assert.rejects(fs.stat(f.indexPath), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(join(f.mediaRoot, 'Archive', '2025', '01', 'Camera')), []);
});

test('dry-run은 Archive와 색인을 만들지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Camera', 'sample.bin', 'a');
  const result = await runMediaArchive({ ...f.options, dryRun: true });
  assert.equal(result.archived, 1);
  await assert.rejects(fs.stat(join(f.mediaRoot, 'Archive')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(f.indexPath), { code: 'ENOENT' });
});

test('색인된 내용이 다른 Inbox 이름으로 재등장해도 새 링크를 만들지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Camera', 'first.bin', 'same-content');
  assert.equal((await runMediaArchive(f.options)).archived, 1);
  await f.put('Camera', 'second.bin', 'same-content');
  const second = await runMediaArchive(f.options);
  assert.equal(second.archived, 0);
  assert.equal(second.skipped, 2);
  assert.equal((await rows(f.indexPath)).length, 1);
  assert.deepEqual(await fs.readdir(join(f.mediaRoot, 'Archive', '2025', '01', 'Camera')), ['first.bin']);
});

test('색인된 보관 파일이 사라지면 실패를 명시하고 링크를 만들지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Camera', 'first.bin', 'same-content');
  await runMediaArchive(f.options);
  const [record] = await rows(f.indexPath);
  await fs.unlink(join(f.mediaRoot, record.archivePath));
  await f.put('Camera', 'second.bin', 'same-content');
  const errors = [];
  const result = await runMediaArchive({ ...f.options, output: { log() {}, error: (message) => errors.push(message) } });
  assert.equal(result.failed, 2);
  assert.match(errors.join('\n'), /ENOENT/);
  assert.deepEqual(await fs.readdir(join(f.mediaRoot, 'Archive', '2025', '01', 'Camera')), []);
});

test('이미 링크된 동일 파일은 색인만 복구하고 건너뜀으로 센다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const source = await f.put('Camera', 'already.bin', 'same-content');
  const target = join(f.mediaRoot, 'Archive', '2025', '01', 'Camera', 'already.bin');
  await fs.mkdir(join(target, '..'), { recursive: true });
  await fs.link(source, target);
  const result = await runMediaArchive(f.options);
  assert.equal(result.archived, 0);
  assert.equal(result.skipped, 1);
  assert.equal((await rows(f.indexPath)).length, 1);
});

test('중단된 JSONL 마지막 조각만 복구하며 dry-run은 손상 색인을 바꾸지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Camera', 'first.bin', 'first');
  await runMediaArchive(f.options);
  const complete = await fs.readFile(f.indexPath, 'utf8');
  await fs.appendFile(f.indexPath, '{"id":"incomplete"');
  await f.put('Camera', 'second.bin', 'second');
  await assert.rejects(runMediaArchive({ ...f.options, dryRun: true }), /읽기 전용 dry-run/);
  assert.equal(await fs.readFile(f.indexPath, 'utf8'), `${complete}{"id":"incomplete"`);
  const result = await runMediaArchive(f.options);
  assert.equal(result.archived, 1);
  assert.equal(result.skipped, 1);
  assert.equal((await rows(f.indexPath)).length, 2);
});

test('링크 직후 원본이 바뀌면 새 링크만 제거하고 실패한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Camera', 'changing.bin', 'before');
  const result = await runMediaArchive({ ...f.options, link: async (source, target) => {
    await fs.link(source, target);
    await fs.appendFile(source, 'after');
  } });
  assert.equal(result.failed, 1);
  assert.deepEqual(await fs.readdir(join(f.mediaRoot, 'Archive', '2025', '01', 'Camera')), []);
  await assert.rejects(fs.stat(f.indexPath), { code: 'ENOENT' });
});

test('exiftool 일부 파일 오류에도 JSON의 다른 메타데이터를 사용한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Camera', 'exif.bin', 'good');
  await f.put('Camera', 'badmeta_20240607_080910.bin', 'bad');
  const result = await runMediaArchive(f.options);
  assert.equal(result.failed, 0);
  const records = await rows(f.indexPath);
  assert.equal(records.find((row) => row.inboxPath.endsWith('exif.bin')).capturedFrom, 'exif');
  assert.equal(records.find((row) => row.inboxPath.endsWith('badmeta_20240607_080910.bin')).capturedFrom, 'filename');
});

test('m4a QuickTime 시각은 UTC, 6자리 통화 파일명은 KST, 0000 날짜는 파일명으로 넘어간다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put('Calls', 'call_260911_122817.m4a', 'call');
  await f.put('Calls', 'plain_260911_122817.m4a', 'plain');
  await f.put('Camera', 'zero_260201_010203.mp4', 'zero');
  await runMediaArchive(f.options);
  const records = await rows(f.indexPath);
  const byName = (name) => records.find((row) => row.inboxPath.endsWith(name));
  assert.equal(byName('call_260911_122817.m4a').capturedAt, '2026-09-11T12:29:11.000+09:00');
  assert.equal(byName('call_260911_122817.m4a').capturedFrom, 'exif');
  assert.equal(byName('plain_260911_122817.m4a').capturedAt, '2026-09-11T12:28:17.000+09:00');
  assert.equal(byName('plain_260911_122817.m4a').capturedFrom, 'filename');
  assert.equal(byName('zero_260201_010203.mp4').capturedAt, '2026-02-01T01:02:03.000+09:00');
  assert.equal(byName('zero_260201_010203.mp4').capturedFrom, 'filename');
});

test('repair dry-run은 읽기 전용이고 apply는 새 월 하드링크와 원자적 색인을 갱신한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const inbox = await f.put('Calls', 'cross_260131_235959.m4a', 'cross');
  await runMediaArchive(f.options);
  const [record] = await rows(f.indexPath);
  const newPath = join(f.mediaRoot, record.archivePath);
  const oldPath = join(f.mediaRoot, 'Archive', '2026', '01', 'Calls', 'cross_260131_235959.m4a');
  await fs.mkdir(join(oldPath, '..'), { recursive: true });
  await fs.link(newPath, oldPath);
  await fs.unlink(newPath);
  record.archivePath = 'Archive/2026/01/Calls/cross_260131_235959.m4a';
  record.capturedAt = '2026-01-31T16:00:00.000+09:00';
  await fs.writeFile(f.indexPath, `${JSON.stringify(record)}\n`);
  record.capturedAt = '2026-02-01T01:00:00.000+09:00';
  await fs.writeFile(f.indexPath, `${JSON.stringify(record)}\n`);
  const misplaced = await repairMediaArchiveTimes(f.options);
  assert.equal(misplaced.changed, 0);
  assert.equal(misplaced.moves.length, 1);
  record.capturedAt = '2026-01-31T16:00:00.000+09:00';
  await fs.writeFile(f.indexPath, `${JSON.stringify(record)}\n`);
  const before = await fs.readFile(f.indexPath, 'utf8');

  const dry = await repairMediaArchiveTimes(f.options);
  assert.equal(dry.changed, 1);
  assert.deepEqual(dry.byKind, { Calls: 1 });
  assert.equal(dry.moves.length, 1);
  assert.equal(await fs.readFile(f.indexPath, 'utf8'), before);
  assert.equal((await fs.stat(oldPath)).ino, (await fs.stat(inbox)).ino);
  await assert.rejects(fs.stat(newPath), { code: 'ENOENT' });

  // 내용이 같은 독립 복사본은 기존 하드링크를 대체할 수 없다.
  await fs.copyFile(oldPath, newPath);
  const applied = await repairMediaArchiveTimes({ ...f.options, apply: true });
  assert.equal(applied.changed, 1);
  const [fixed] = await rows(f.indexPath);
  assert.equal(fixed.capturedAt, '2026-02-01T01:00:00.000+09:00');
  assert.equal(fixed.archivePath, record.archivePath.replace('/01/', '/02/').replace('.m4a', ' (2).m4a'));
  assert.notEqual((await fs.stat(newPath)).ino, (await fs.stat(inbox)).ino);
  assert.equal((await fs.stat(join(f.mediaRoot, fixed.archivePath))).ino, (await fs.stat(inbox)).ino);
  await assert.rejects(fs.stat(oldPath), { code: 'ENOENT' });
  assert.equal((await repairMediaArchiveTimes(f.options)).changed, 0);

  // 색인 교체 직후 중단된 경우 다음 apply가 이전 링크 정리를 마친다.
  await fs.link(join(f.mediaRoot, fixed.archivePath), oldPath);
  fixed.repairFrom = record.archivePath;
  await fs.writeFile(f.indexPath, `${JSON.stringify(fixed)}\n`);
  assert.equal((await repairMediaArchiveTimes(f.options)).pendingCleanup, 1);
  await repairMediaArchiveTimes({ ...f.options, apply: true });
  assert.equal((await rows(f.indexPath))[0].repairFrom, undefined);
  await assert.rejects(fs.stat(oldPath), { code: 'ENOENT' });
});
