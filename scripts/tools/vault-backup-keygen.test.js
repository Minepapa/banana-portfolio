import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKey } from './vault-backup-keygen.mjs';

test('키 생성은 32바이트·600이고 기존 키를 덮어쓰지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-keygen-'));
  const path = join(dir, 'config', 'vault-backup.key');
  try {
    assert.equal(generateKey(path), path);
    const first = readFileSync(path);
    assert.equal(first.length, 32);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => generateKey(path), /EEXIST/);
    assert.deepEqual(readFileSync(path), first);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
