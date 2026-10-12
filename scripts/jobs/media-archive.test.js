import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMediaArchive, repairMediaArchiveTimes } from './media-archive.mjs';

const NOW = new Date('2026-10-11T06:00:00Z');
const QUIET = { log() {}, error() {} };

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'media-archive-test-'));
  const mediaRoot = join(root, 'Media');
  const indexPath = join(root, 'Vault', 'archive-index.jsonl');
  const exiftoolPath = join(root, 'fake-exiftool');
  // 테스트 전용 외부 명령. 입력 경로를 JSON으로 되돌리고 합성 메타데이터만 붙인다.
  await fs.writeFile(exiftoolPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
fs.appendFileSync(${JSON.stringify(join(root, 'calls'))}, 'call\\n');
process.stdout.write(JSON.stringify(args.map((file) => {
  const name = path.basename(file);
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
  return {
    root, mediaRoot, indexPath, exiftoolPath, put,
    options: { mediaRoot, indexPath, exiftoolPath, now: NOW, output: QUIET },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function rows(indexPath) {
  return (await fs.readFile(indexPath, 'utf8')).trim().split('\n').map(JSON.parse);
}

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
  assert.equal((await rows(f.indexPath)).length, 10);
  assert.equal((await fs.readFile(join(f.root, 'calls'), 'utf8')).trim().split('\n').length, 2);
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
