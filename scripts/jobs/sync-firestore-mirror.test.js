import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { readVaultRecords } from './sync-firestore-mirror.mjs';

test('readVaultRecords: 디렉토리가 없으면 빈 배열(Phase 8·9 이전 정상 상태)', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'mirror-test-')), 'does-not-exist');
  assert.deepEqual(readVaultRecords(dir), []);
});

test('readVaultRecords: .md 파일들의 frontmatter를 전부 파싱', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-test-'));
  writeFileSync(join(dir, 'a.md'), buildFrontmatter({ type: 'execution', stockName: '삼성전자' }));
  writeFileSync(join(dir, 'b.md'), buildFrontmatter({ type: 'execution', stockName: 'SK하이닉스' }));
  writeFileSync(join(dir, 'not-md.txt'), 'ignore me');
  const records = readVaultRecords(dir);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.stockName).sort(), ['SK하이닉스', '삼성전자']);
  rmSync(dir, { recursive: true, force: true });
});
