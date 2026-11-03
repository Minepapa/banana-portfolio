// 휴지통 영구 삭제 직전 경로별 확인(오너 결정 2026-11-03) 시험. 모든 경로는 임시 폴더다.
// 볼트 경로 상수가 실제 볼트를 가리키지 않게 VAULT_PATH를 먼저 정하고 동적 import 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VAULT_PATH = mkdtempSync(join(tmpdir(), 'trash-guard-vault-'));
const { runMediaArchive } = await import('./media-archive.mjs');
const { VAULT_REL } = await import('../lib/vault-paths.mjs');
const { buildFrontmatter } = await import('../lib/vault-frontmatter.mjs');
const { warningCount, resetWarnings } = await import('../lib/job-alerts.mjs');

const NOW = new Date('2026-12-20T06:00:00Z');
const QUIET = { log() {}, error() {} };
const ID = 'abcdef0123456789';
const PASS_ID = 'TV-20261201-abcdef12';

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'trash-guard-'));
  const mediaRoot = join(root, 'Media');
  const vaultRoot = join(root, 'Vault');
  const verdictsPath = join(root, 'verdicts.jsonl');
  const people = join(vaultRoot, VAULT_REL.people);
  await fs.mkdir(people, { recursive: true });
  await fs.writeFile(join(people, '가상인물.md'), `${buildFrontmatter({ phoneContacts: ['가상연결'] })}# 가상인물\n`);
  // 시계 앞튐 보호 기준이 되는 최근 휴지통 폴더(비어 있음).
  await fs.mkdir(join(mediaRoot, 'Trash', '2026-12-19'), { recursive: true });
  async function folder(day, { lines = null, files = [] } = {}) {
    const directory = join(mediaRoot, 'Trash', day);
    await fs.mkdir(directory, { recursive: true });
    for (const name of files) {
      await fs.mkdir(join(directory, name, '..'), { recursive: true });
      await fs.writeFile(join(directory, name), 'media');
    }
    if (lines) await fs.writeFile(join(directory, 'manifest.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    return directory;
  }
  return {
    root, mediaRoot, verdictsPath, folder,
    options: { mediaRoot, vaultRoot, verdictsPath, indexPath: join(vaultRoot, 'archive-index.jsonl'),
      exiftoolPath: join(root, 'missing-exiftool'), now: NOW, output: QUIET },
    purged: async () => {
      try { return (await fs.readFile(join(mediaRoot, 'Trash', 'purged.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

const line = (day, name, extra) => ({ record: { id: ID, kind: 'Camera' }, trashPath: `Trash/${day}/${name}`, ...extra });
const exists = (path) => fs.stat(path).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });

test.beforeEach(() => resetWarnings());
test.after(() => fs.rm(process.env.VAULT_PATH, { recursive: true, force: true }));

test('경로가 기록되고 모든 파일이 manifest에 있으면 지우고 purged.jsonl에 올린다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const directory = await f.folder('2026-11-10', {
    files: ['Camera/a.jpg'], lines: [line('2026-11-10', 'Camera/a.jpg', { route: 'owner-request' })],
  });
  const result = await runMediaArchive(f.options);
  assert.equal(result.cleanedTrash, 1);
  assert.equal(result.heldTrash, 0);
  assert.equal(await exists(directory), false);
  assert.deepEqual((await f.purged()).map((item) => item.id), [ID]);
  assert.equal(warningCount(), 0);
});

test('manifest 줄의 파일이 폴더에 없으면(이동이 끊긴 줄) 폴더는 지워도 purged.jsonl에는 올리지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const directory = await f.folder('2026-11-10', {
    files: ['Camera/a.jpg'],
    lines: [line('2026-11-10', 'Camera/a.jpg', { route: 'owner-request' }),
      { route: 'unlinked-call', record: { id: 'fedcba9876543210', kind: 'Calls' }, trashPath: 'Trash/2026-11-10/Calls/never-moved.m4a' }],
  });
  const result = await runMediaArchive(f.options);
  assert.equal(result.cleanedTrash, 1);
  assert.equal(await exists(directory), false);
  assert.deepEqual((await f.purged()).map((item) => item.id), [ID]);
});

test('폴더 안 심볼릭 링크는 보류하고, 11-04 뒤 폴더도 route가 있으면 지운다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const linked = await f.folder('2026-11-10', { files: ['Camera/a.jpg'], lines: [line('2026-11-10', 'Camera/a.jpg', { route: 'phone-deleted' })] });
  await fs.symlink(join(f.root, 'outside'), join(linked, 'Camera', 'link.jpg'));
  const ok = await f.folder('2026-11-12', { files: ['Camera/a.jpg'], lines: [line('2026-11-12', 'Camera/a.jpg', { route: 'phone-deleted' })] });
  const result = await runMediaArchive(f.options);
  assert.equal(result.heldTrash, 1);
  assert.equal(result.cleanedTrash, 1);
  assert.ok(await exists(join(linked, 'Camera', 'a.jpg')));
  assert.equal(await exists(ok), false);
});

test('manifest가 심볼릭 링크면 휴지통 ID 검사 단계에서 회차 전체를 멈추고 아무것도 지우지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const directory = await f.folder('2026-11-11', { files: ['Camera/a.jpg'] });
  await fs.writeFile(join(f.root, 'outside-manifest.jsonl'), `${JSON.stringify(line('2026-11-11', 'Camera/a.jpg', { route: 'phone-deleted' }))}\n`);
  await fs.symlink(join(f.root, 'outside-manifest.jsonl'), join(directory, 'manifest.jsonl'));
  const result = await runMediaArchive(f.options);
  assert.equal(result.failed, 1);
  assert.equal(result.cleanedTrash, 0);
  assert.ok(await exists(join(directory, 'Camera', 'a.jpg')));
});

test('auto-candidate에 테미스 통과 판정이 없으면(없음·보류·다른 갈래) 보류하고 purged.jsonl에 올리지 않는다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await fs.writeFile(f.verdictsPath, [
    { schemaVersion: 1, id: 'TV-20261201-abcdef34', verdict: '보류', kind: '미디어 삭제' },
    { schemaVersion: 1, id: 'TV-20261201-abcdef56', verdict: '통과', kind: '기타' },
  ].map((item) => JSON.stringify(item)).join('\n') + '\n');
  const days = { '2026-11-10': undefined, '2026-11-11': 'TV-20261201-abcdef34', '2026-11-12': 'TV-20261201-abcdef56' };
  for (const [day, verdictId] of Object.entries(days)) {
    await f.folder(day, { files: ['Camera/a.jpg'], lines: [line(day, 'Camera/a.jpg', { route: 'auto-candidate', verdictId })] });
  }
  const dry = await runMediaArchive({ ...f.options, dryRun: true });
  assert.equal(dry.cleanedTrash, 0);
  assert.equal(dry.heldTrash, 3);
  const result = await runMediaArchive(f.options);
  assert.equal(result.cleanedTrash, 0);
  assert.equal(result.heldTrash, 3);
  assert.equal(result.failed, 0);
  assert.equal(warningCount(), 3);
  for (const day of Object.keys(days)) assert.ok(await exists(join(f.mediaRoot, 'Trash', day, 'Camera', 'a.jpg')));
  assert.deepEqual(await f.purged(), []);
});

test('auto-candidate에 테미스 미디어 삭제 통과 판정이 이어지면 지운다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await fs.writeFile(f.verdictsPath, `${JSON.stringify({ schemaVersion: 1, id: PASS_ID, verdict: '통과', kind: '미디어 삭제' })}\n`);
  const directory = await f.folder('2026-11-10', {
    files: ['Camera/a.jpg'], lines: [line('2026-11-10', 'Camera/a.jpg', { route: 'auto-candidate', verdictId: PASS_ID })],
  });
  const result = await runMediaArchive(f.options);
  assert.equal(result.cleanedTrash, 1);
  assert.equal(await exists(directory), false);
  assert.deepEqual((await f.purged()).map((item) => item.id), [ID]);
});

test('판정 원장이 깨져 있으면 auto-candidate 폴더를 보류한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await fs.writeFile(f.verdictsPath, 'broken\n');
  await f.folder('2026-11-10', {
    files: ['Camera/a.jpg'], lines: [line('2026-11-10', 'Camera/a.jpg', { route: 'auto-candidate', verdictId: PASS_ID })],
  });
  const result = await runMediaArchive(f.options);
  assert.equal(result.cleanedTrash, 0);
  assert.equal(result.heldTrash, 1);
});

test('manifest 밖 파일이 있으면 보류하고, 기록을 채우면 다음 회차에 다시 검사해 지운다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const day = '2026-11-10';
  const directory = await f.folder(day, {
    files: ['Camera/a.jpg', 'Camera/extra.jpg', '.DS_Store'], lines: [line(day, 'Camera/a.jpg', { route: 'owner-request' })],
  });
  const held = await runMediaArchive(f.options);
  assert.equal(held.cleanedTrash, 0);
  assert.equal(held.heldTrash, 1);
  assert.ok(await exists(join(directory, 'Camera', 'extra.jpg')));
  assert.deepEqual(await f.purged(), []);
  const again = await runMediaArchive(f.options);
  assert.equal(again.heldTrash, 1, '보류 폴더는 다음 회차에도 다시 검사한다');
  await fs.appendFile(join(directory, 'manifest.jsonl'), `${JSON.stringify({ route: 'owner-request', trashPath: `Trash/${day}/Camera/extra.jpg` })}\n`);
  const cleaned = await runMediaArchive(f.options);
  assert.equal(cleaned.cleanedTrash, 1);
  assert.equal(await exists(directory), false);
});

test('manifest가 없으면 파일이 있는 폴더는 보류하고, 빈 폴더(.DS_Store뿐)는 지운다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const withFiles = await f.folder('2026-10-12', { files: ['Calls/통화.m4a', '.DS_Store'] });
  const empty = await f.folder('2026-10-13', { files: ['.DS_Store'] });
  await fs.mkdir(join(empty, 'Calls'));
  const result = await runMediaArchive(f.options);
  assert.equal(result.heldTrash, 1);
  assert.equal(result.cleanedTrash, 1);
  assert.ok(await exists(join(withFiles, 'Calls', '통화.m4a')));
  assert.equal(await exists(empty), false);
  assert.deepEqual(await f.purged(), []);
});

test('경로 없는 줄은 2026-11-03까지 만든 폴더면 legacy로 지우고, 그 뒤 폴더는 경로 미상으로 보류한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const legacy = await f.folder('2026-11-03', { files: ['Camera/a.jpg'], lines: [line('2026-11-03', 'Camera/a.jpg', { reason: '오너 요청' })] });
  const later = await f.folder('2026-11-04', { files: ['Camera/a.jpg'], lines: [line('2026-11-04', 'Camera/a.jpg', { reason: 'phone-deleted' })] });
  const unknown = await f.folder('2026-11-05', { files: ['Camera/a.jpg'], lines: [line('2026-11-05', 'Camera/a.jpg', { route: 'guess' })] });
  const result = await runMediaArchive(f.options);
  assert.equal(result.cleanedTrash, 1);
  assert.equal(result.heldTrash, 2);
  assert.equal(await exists(legacy), false);
  assert.ok(await exists(later));
  assert.ok(await exists(unknown));
});

test('보류 폴더는 실행당 세 폴더 한도를 차지하지 않고, 손으로 쓴 moved·transcripts와 NFD 파일 이름도 대조한다', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  for (const day of ['2026-10-01', '2026-10-02']) await f.folder(day, { files: ['Calls/x.m4a'] });
  const nfd = '멕시코.m4a'.normalize('NFD');
  await f.folder('2026-10-15', {
    files: [`Recordings/${nfd}`, 'Transcripts/t.json', 'Notes/n.md'],
    lines: [{ record: { id: ID, kind: 'Recordings' }, trashPath: 'Trash/2026-10-15/Recordings/멕시코.m4a'.normalize('NFC'),
      moved: [{ from: 'vault:x', to: 'Trash/2026-10-15/Notes/n.md' }] },
    { route: 'unlinked-call', trashPath: 'Trash/2026-10-16/elsewhere.m4a', transcripts: ['Trash/2026-10-15/Transcripts/t.json'] }],
  });
  for (const day of ['2026-10-16', '2026-10-17', '2026-10-18']) await f.folder(day);
  const result = await runMediaArchive(f.options);
  assert.equal(result.heldTrash, 2);
  assert.equal(result.cleanedTrash, 3);
  assert.equal(await exists(join(f.mediaRoot, 'Trash', '2026-10-15')), false);
  assert.ok(await exists(join(f.mediaRoot, 'Trash', '2026-10-18')));
});

test('미연결 새 통화는 이동 전에 휴지통 manifest에 unlinked-call 경로를 남긴다(기존 보관 통화는 media-archive.test.js)', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const inbox = join(f.mediaRoot, 'Inbox', 'Calls', '통화 녹음 가상미연결_261219_090000.m4a');
  await fs.mkdir(join(inbox, '..'), { recursive: true });
  await fs.writeFile(inbox, 'unlinked');
  const old = new Date('2026-12-01T00:00:00Z');
  await fs.utimes(inbox, old, old);
  const result = await runMediaArchive(f.options);
  assert.equal(result.trashedNew, 1);
  const manifest = (await fs.readFile(join(f.mediaRoot, 'Trash', '2026-12-20', 'manifest.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(manifest, [{ route: 'unlinked-call', inboxPath: 'Inbox/Calls/통화 녹음 가상미연결_261219_090000.m4a',
    trashPath: 'Trash/2026-12-20/Calls/통화 녹음 가상미연결_261219_090000.m4a' }]);
  assert.ok(await exists(join(f.mediaRoot, manifest[0].trashPath)));
});
