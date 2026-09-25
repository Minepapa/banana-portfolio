import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import {
  auditVault, extractWikiLinks, findExecutionDuplicates, findIdMismatches,
  parseFlatFrontmatter, resolveWikiTarget, validateStatus,
} from '../lib/vault-integrity-audit.mjs';

const CAN_RUN = process.platform === 'darwin' && existsSync(join(VAULT_PATHS.root, 'Knowledge', 'Meta', '상태표준.md'));

test('vault-integrity-audit: status는 지정 집합의 짧은 단일 값만 허용', () => {
  const allowed = ['완료', '진행중'];
  assert.equal(validateStatus('완료', allowed), true);
  assert.equal(validateStatus('완료 - 테스트 통과', allowed), false);
  assert.equal(validateStatus('완료\n추가 설명', allowed), false);
  assert.equal(validateStatus('x'.repeat(41), ['x'.repeat(41)]), false);
});

test('vault-integrity-audit: frontmatter flat fields and id/file mismatch', () => {
  assert.deepEqual(parseFlatFrontmatter('---\nid: "abc-1"\nstatus: 완료\n---\nbody'), { id: 'abc-1', status: '완료' });
  assert.deepEqual(findIdMismatches([{ filename: 'abc-1.md', id: 'abc-1' }, { filename: 'wrong.md', id: 'abc-1' }]), [{ filename: 'wrong.md', id: 'abc-1' }]);
});

test('vault-integrity-audit: 코드 내부 링크는 무시하고 깨진 링크만 검출', () => {
  const result = extractWikiLinks('본문 [[Knowledge/Index]] `[[ignored]]`\n```md\n[[also-ignored]]\n```\n[[broken]');
  assert.deepEqual(result.links, ['Knowledge/Index']);
  assert.deepEqual(result.malformed, ['[[broken]']);
  assert.equal(resolveWikiTarget('Knowledge/Index', ['Knowledge/Index.md']), true);
  assert.equal(resolveWikiTarget('표준 이름', [{ path: 'Knowledge/Index.md', aliases: ['표준 이름'] }]), true);
  assert.equal(resolveWikiTarget('unknown', ['Knowledge/Index.md']), false);
});

test('vault-integrity-audit: executions 완전 일치 중복만 후보로 반환', () => {
  const make = (path, quantity = 2, tradeDate = '2026-09-25T10:00:00+09:00') => ({ path, text: `---\ntradeDate: ${tradeDate}\ntradeType: 매수\nstockName: 삼성전자\nquantity: ${quantity}\n---` });
  assert.deepEqual(findExecutionDuplicates([make('a.md'), make('b.md', 2, '2026-09-25T15:00:00+09:00'), make('c.md', 3)]), [['a.md', 'b.md']]);
});

test('vault-integrity-audit: 로컬 Vault 전체 정합성', { skip: !CAN_RUN }, () => {
  const result = auditVault(VAULT_PATHS.root, join(import.meta.dirname, '..', '..'));
  for (const file of result.failedPositions) console.warn(`[Vault 무결성 경고] protectionStatus: failed — ${file}`);
  for (const group of result.executionDuplicates) console.warn(`[Vault 무결성 경고] 잠재적 크로스소스 체결 중복 — ${group.join(', ')}`);
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
});
