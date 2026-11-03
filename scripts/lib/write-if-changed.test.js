import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REAL_VAULT_ROOT, assertNotRealVaultInTest, frontmatterTime, frontmatterWithout, writeIfChanged,
} from './write-if-changed.mjs';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-03T05:00:00Z'); // 14:00 KST

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'write-if-changed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const record = (value, stamp) => `---\ntype: "sample"\nvalue: ${value}\nupdatedAt: "${new Date(stamp).toISOString()}"\n---\n본문\n`;
const stampOptions = (now, extra = {}) => ({
  compareKey: (text) => frontmatterWithout(text, ['updatedAt']),
  writtenAt: (text) => frontmatterTime(text, 'updatedAt'),
  refreshMs: HOUR, now, ...extra,
});

test('REAL_VAULT_ROOT는 vault-paths DEFAULT_VAULT_ROOT와 같다(이 모듈은 vault-paths를 import하지 않으므로 대조로 묶는다)', async () => {
  const { DEFAULT_VAULT_ROOT } = await import('./vault-paths.mjs');
  assert.equal(REAL_VAULT_ROOT, DEFAULT_VAULT_ROOT);
});

test('이 모듈은 vault-paths·vault-frontmatter·state-writer를 import하지 않는다', () => {
  const source = readFileSync(new URL('./write-if-changed.mjs', import.meta.url), 'utf8');
  for (const name of ['vault-paths', 'vault-frontmatter', 'state-writer']) {
    assert.doesNotMatch(source, new RegExp(`from '\\./${name}\\.mjs'`));
  }
});

test('writeIfChanged: 파일이 없으면 쓰고, 바이트가 같으면 건너뛰고, 다르면 쓴다(기본 비교)', (t) => {
  const file = join(tempDir(t), 'a.txt');
  assert.equal(writeIfChanged(file, 'x'), true);
  assert.equal(writeIfChanged(file, 'x'), false);
  assert.equal(writeIfChanged(file, 'y'), true);
  assert.equal(readFileSync(file, 'utf8'), 'y');
});

test('writeIfChanged: 시각 칸만 다르면 refreshMs 안에선 안 쓰고, 값이 바뀌면 바로, refreshMs가 지나면 다시 쓴다', (t) => {
  const file = join(tempDir(t), 'a.md');
  assert.equal(writeIfChanged(file, record(1, T0), stampOptions(T0)), true);
  assert.equal(writeIfChanged(file, record(1, T0 + 10 * 60_000), stampOptions(T0 + 10 * 60_000)), false);
  assert.equal(frontmatterTime(readFileSync(file, 'utf8'), 'updatedAt'), T0, '건너뛰면 파일은 그대로');
  assert.equal(writeIfChanged(file, record(2, T0 + 20 * 60_000), stampOptions(T0 + 20 * 60_000)), true, '값이 바뀌면 바로');
  assert.equal(writeIfChanged(file, record(2, T0 + 79 * 60_000), stampOptions(T0 + 79 * 60_000)), false);
  assert.equal(writeIfChanged(file, record(2, T0 + 80 * 60_000), stampOptions(T0 + 80 * 60_000)), true, '마지막으로 쓴 지 1시간이면 다시');
});

test('writeIfChanged: sameKstDay면 KST 날짜가 바뀐 뒤 첫 시도는 refreshMs 안이어도 쓴다', (t) => {
  const file = join(tempDir(t), 'a.md');
  const beforeMidnight = Date.parse('2026-11-03T14:55:00Z'); // 23:55 KST
  const afterMidnight = Date.parse('2026-11-03T15:05:00Z'); // 다음날 00:05 KST
  writeIfChanged(file, record(1, beforeMidnight), stampOptions(beforeMidnight, { sameKstDay: true }));
  assert.equal(writeIfChanged(file, record(1, afterMidnight), stampOptions(afterMidnight, { sameKstDay: false })), false);
  assert.equal(writeIfChanged(file, record(1, afterMidnight), stampOptions(afterMidnight, { sameKstDay: true })), true);
});

test('writeIfChanged: 모르면 쓴다 — 시각이 없거나 깨졌거나 미래이거나, 앞 파일 비교가 실패하면', (t) => {
  const dir = tempDir(t);
  const noStamp = join(dir, 'no-stamp.md');
  writeFileSync(noStamp, '---\ntype: "sample"\nvalue: 1\n---\n본문\n');
  assert.equal(writeIfChanged(noStamp, record(1, T0), stampOptions(T0)), true);

  const future = join(dir, 'future.md');
  writeFileSync(future, record(1, T0 + 5 * 60_000));
  assert.equal(writeIfChanged(future, record(1, T0), stampOptions(T0)), true, '시계가 어긋나 미래 시각이면 다시 쓴다');

  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{깨진');
  const jsonOptions = { compareKey: (text) => JSON.parse(text).k, writtenAt: (text) => Date.parse(JSON.parse(text).at), refreshMs: HOUR, now: T0 };
  assert.equal(writeIfChanged(broken, JSON.stringify({ k: 1, at: new Date(T0).toISOString() }), jsonOptions), true);
});

test('frontmatterWithout: 지정한 칸만 빼고 다른 칸·본문은 그대로 비교한다', () => {
  const a = '---\ntype: "x"\nupdatedAt: "2026-11-03T00:00:00Z"\nvalue: 1\n---\n본문 A\n';
  const b = '---\ntype: "x"\nupdatedAt: "2026-11-04T00:00:00Z"\nvalue: 1\n---\n본문 A\n';
  assert.equal(frontmatterWithout(a, ['updatedAt']), frontmatterWithout(b, ['updatedAt']));
  assert.notEqual(frontmatterWithout(a, ['updatedAt']), frontmatterWithout(b.replace('본문 A', '본문 B'), ['updatedAt']));
  assert.notEqual(frontmatterWithout(a, ['updatedAt']), frontmatterWithout(b.replace('value: 1', 'value: 2'), ['updatedAt']));
  // 칸 이름이 접두어로 겹쳐도(updatedAtNote) 빼지 않는다.
  assert.match(frontmatterWithout('---\nupdatedAtNote: "a"\n---\n', ['updatedAt']), /updatedAtNote/);
});

test('테스트 중 실볼트 아래 경로는 읽기·쓰기 전에 거부한다', () => {
  const target = join(REAL_VAULT_ROOT, '.write-if-changed-test-never', 'x.md');
  assert.throws(() => writeIfChanged(target, 'x'), /실볼트 경로 쓰기 금지/);
  assert.equal(existsSync(join(REAL_VAULT_ROOT, '.write-if-changed-test-never')), false);
  assert.throws(() => assertNotRealVaultInTest(REAL_VAULT_ROOT), /실볼트 경로 쓰기 금지/);
});

test('guardRoots: 심볼릭 링크로 들어가도 실경로로 막는다', (t) => {
  const dir = tempDir(t);
  const fakeVault = join(dir, 'vault');
  mkdirSync(join(fakeVault, 'Jobs'), { recursive: true });
  symlinkSync(fakeVault, join(dir, 'link'));
  assert.throws(() => writeIfChanged(join(dir, 'link', 'Jobs', 'x.md'), 'x', { guardRoots: [fakeVault] }), /실볼트 경로 쓰기 금지/);
  assert.equal(writeIfChanged(join(dir, 'outside.md'), 'x', { guardRoots: [fakeVault] }), true);
});

test('쓰기가 실패하면 임시 파일을 지우고 다시 던지며, 자리에 있던 것은 그대로다', (t) => {
  const dir = tempDir(t);
  const target = join(dir, 'occupied');
  mkdirSync(join(target, 'inner'), { recursive: true }); // 비어 있지 않은 폴더 자리로 이름 바꾸기 → 실패
  assert.throws(() => writeIfChanged(target, 'x'));
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp-')), []);
  assert.equal(existsSync(join(target, 'inner')), true);
});

test('비교 함수가 던지면 건너뛰지 않고 쓴다(안전한 쪽)', (t) => {
  const file = join(tempDir(t), 'keep.md');
  writeFileSync(file, 'x');
  assert.equal(writeIfChanged(file, 'x', { compareKey: () => { throw new Error('비교 실패'); } }), true);
  assert.equal(readFileSync(file, 'utf8'), 'x');
});
