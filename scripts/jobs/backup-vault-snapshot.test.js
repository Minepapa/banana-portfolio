import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyRootFiles } from './backup-vault-snapshot.mjs';

test('루트 파일 사본: 있는 것만 .txt로 복사하고, 내용이 같으면 다시 쓰지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'root-files-'));
  const dest = join(root, 'vault', 'RootFiles');
  try {
    writeFileSync(join(root, 'CLAUDE.md'), '# 루트');
    assert.deepEqual(copyRootFiles(root, dest), ['CLAUDE.md.txt']);
    assert.equal(readFileSync(join(dest, 'CLAUDE.md.txt'), 'utf8'), '# 루트');
    assert.deepEqual(copyRootFiles(root, dest), []);
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude', 'settings.json'), '{}');
    assert.deepEqual(copyRootFiles(root, dest), ['claude-settings.json.txt']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
