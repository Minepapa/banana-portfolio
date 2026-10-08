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

test('buildLintNotice: 위반 없으면 null, 있으면 항목별 한 줄 + 초과분 안내', async () => {
  const { buildLintNotice } = await import('./backup-vault-snapshot.mjs');
  assert.equal(buildLintNotice({ checked: 5, results: [] }), null);
  const results = Array.from({ length: 12 }, (_, i) => ({ rel: `a${i}.md`, problems: ['type 없음'] }));
  const notice = buildLintNotice({ checked: 20, results });
  assert.match(notice, /볼트 등록부 위반 12개/);
  assert.equal(notice.split('\n').filter((l) => l.startsWith('- a')).length, 10);
  assert.match(notice, /외 2개/);
});
