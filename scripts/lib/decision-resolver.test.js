import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDecision } from './decision-resolver.mjs';
import { VAULT_REL } from './vault-paths.mjs';

test('resolveDecision: 결정됨 문서가 정확히 하나여야 하며 대체됨은 무시한다', () => {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'decision-resolver-'));
  const decisionDir = join(vaultRoot, VAULT_REL.decisionsCanonical);
  mkdirSync(decisionDir, { recursive: true });
  const writeDecision = (name, status, body) => writeFileSync(join(decisionDir, name),
    `---\ntype: "decision"\ndecisionKey: "투자자-성향"\nstatus: "${status}"\n---\n${body}`);
  try {
    assert.throws(() => resolveDecision('투자자-성향', { vaultRoot }), /0개.*정확히 1개/);
    writeDecision('옛 문서.md', '대체됨', '옛 본문');
    assert.throws(() => resolveDecision('투자자-성향', { vaultRoot }), /0개.*정확히 1개/);
    writeDecision('새 문서.md', '결정됨', '# 새 본문');
    assert.deepEqual(resolveDecision('투자자-성향', { vaultRoot }), {
      path: join(decisionDir, '새 문서.md'),
      frontmatter: { type: 'decision', decisionKey: '투자자-성향', status: '결정됨' },
      body: '# 새 본문',
    });
    writeDecision('중복 문서.md', '결정됨', '중복 본문');
    assert.throws(() => resolveDecision('투자자-성향', { vaultRoot }), /2개.*정확히 1개/);
    writeFileSync(join(decisionDir, '중복 문서.md'), '---\ndecisionKey: "투자자-성향"\nstatus: "대체됨"\n---\n');
    writeDecision('새 문서.md', '결정됨', '');
    assert.throws(() => resolveDecision('투자자-성향', { vaultRoot }), /본문이 비어/);
  } finally {
    rmSync(vaultRoot, { recursive: true, force: true });
  }
});
