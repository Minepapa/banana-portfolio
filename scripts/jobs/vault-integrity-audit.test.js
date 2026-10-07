import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import {
  STATUS_RULES, auditVault, extractWikiLinks, findExecutionDuplicates, findIdMismatches,
  parseFlatFrontmatter, resolveWikiTarget, validateStatus,
} from '../lib/vault-integrity-audit.mjs';

const CAN_RUN = process.platform === 'darwin' && existsSync(join(VAULT_PATHS.knowledge.meta, '상태표준.md'));

test('vault-integrity-audit: status는 지정 집합의 짧은 단일 값만 허용', () => {
  const allowed = ['완료', '진행중'];
  assert.equal(validateStatus('완료', allowed), true);
  assert.equal(validateStatus('완료 - 테스트 통과', allowed), false);
  assert.equal(validateStatus('완료\n추가 설명', allowed), false);
  assert.equal(validateStatus('x'.repeat(41), ['x'.repeat(41)]), false);
});

test('vault-integrity-audit: 제안 상태는 발송·주문접수·부분체결·취소·만료를 포함한다', () => {
  const allowed = STATUS_RULES.find((rule) => rule.path === VAULT_REL.decisionsProposals).allowed;
  for (const status of ['발송중', '발송오류', '주문접수', '부분체결', '취소', '만료']) {
    assert.equal(validateStatus(status, allowed), true, status);
  }
  assert.equal(validateStatus('주문 접수 완료', allowed), false);
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

test('vault-integrity-audit: 연도 하위 파일에도 상태와 ID 규칙을 적용한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-audit-year-'));
  try {
    const profile = join(root, VAULT_REL.decisionsProfile, '2026');
    const positions = join(root, VAULT_REL.stateBreakoutPositions, '2026');
    mkdirSync(profile, { recursive: true });
    mkdirSync(positions, { recursive: true });
    writeFileSync(join(profile, 'observation.md'), '---\nstatus: 잘못된상태\n---\n');
    writeFileSync(join(positions, 'wrong.md'), '---\nid: expected\n---\n');
    const result = auditVault(root, join(import.meta.dirname, '..', '..'));
    assert.ok(result.errors.some((error) => error.includes('observation.md: invalid status')));
    assert.ok(result.errors.some((error) => error.includes('wrong.md: filename does not match id')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('vault-integrity-audit: 로컬 Vault 전체 정합성', { skip: !CAN_RUN }, () => {
  const result = auditVault(VAULT_PATHS.root, join(import.meta.dirname, '..', '..'));
  for (const file of result.failedPositions) console.warn(`[Vault 무결성 경고] protectionStatus: failed — ${file}`);
  for (const group of result.executionDuplicates) console.warn(`[Vault 무결성 경고] 잠재적 크로스소스 체결 중복 — ${group.join(', ')}`);
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
});
