import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AUTO_END, AUTO_START, buildVaultIndex, parseCategories, replaceAutoBlock } from './vault-index-builder.mjs';
import { VAULT_REL } from './vault-paths.mjs';
import { MOUSEION_TOP_FOLDERS } from './vault-layout.mjs';

const top = (prefix) => MOUSEION_TOP_FOLDERS.find((f) => f.startsWith(prefix));

function makeVault() {
  const root = mkdtempSync(join(tmpdir(), 'vault-index-'));
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const home = top('01_');
  put(VAULT_REL.knowledgeIndexFile, '# 색인\n\n## 개인 원칙과 투자 결정\n\n| 표준 키워드 | 별칭 | 정본 | 확인 |\n|---|---|---|---|\n');
  put(`${home}/700 자산.md`, '---\ntype: "category"\n---\n# 700 자산\n');
  put(`${home}/500 기술.md`, '---\ntype: "category"\n---\n# 500 기술\n');
  put(`${VAULT_REL.wikiObjects}/ISA 계좌 (NH투자증권).md`,
    `---\ntype: "object"\nobjectKind: "계좌"\ncategory: ["[[${home}/700 자산]]"]\n---\n# ISA\n`);
  put(`${VAULT_REL.decisionsCanonical}/2026-10-08 투자자 성향.md`,
    `---\ntype: "decision"\nstatus: "결정됨"\ndecisionKey: "투자자-성향"\ncategory: ["[[${home}/700 자산]]", "[[${home}/500 기술]]"]\n---\n본문\n`);
  put(`${VAULT_REL.decisionsCanonical}/2026-09-25 투자자 성향.md`,
    '---\ntype: "decision"\nstatus: "대체됨"\ndecisionKey: "투자자-성향"\n---\n옛 본문\n');
  put(`${top('95_')}/Investing/Holdings/위탁-삼성전자.md`, `---\ncategory: ["[[${home}/700 자산]]"]\n---\n`);
  return { root, home };
}

test('parseCategories: 분류 노트 링크에서 이름만 뽑는다', () => {
  const home = top('01_');
  assert.deepEqual(parseCategories(`["[[${home}/500 기술]]", "[[${home}/700 자산]]"]`), ['500 기술', '700 자산']);
  assert.deepEqual(parseCategories(''), []);
});

test('replaceAutoBlock: 없으면 붙이고, 있으면 그 구역만 바꾸며, 짝이 안 맞으면 오류', () => {
  const once = replaceAutoBlock('# 제목\n본문\n', 'A');
  assert.match(once, /# 제목\n본문\n\n<!-- AUTO-INDEX:START/);
  const twice = replaceAutoBlock(once, 'B');
  assert.equal(twice.split(AUTO_START).length, 2);
  assert.match(twice, /\nB\n/);
  assert.doesNotMatch(twice, /\nA\n/);
  assert.throws(() => replaceAutoBlock(`x ${AUTO_START} y`, 'C'), /손상/);
});

test('buildVaultIndex: 키워드 표는 보존하고 자동 구역·분류 목록을 만들며, 다시 돌리면 변경 없음', () => {
  const { root, home } = makeVault();
  try {
    const changed = buildVaultIndex(root);
    assert.deepEqual(changed.sort(), [`${home}/500 기술.md`, `${home}/700 자산.md`, VAULT_REL.knowledgeIndexFile].sort());
    const index = readFileSync(join(root, VAULT_REL.knowledgeIndexFile), 'utf8');
    assert.match(index, /## 개인 원칙과 투자 결정\n\n\| 표준 키워드/);
    assert.match(index, /`투자자-성향` → \[\[.*2026-10-08 투자자 성향\]\]/);
    assert.doesNotMatch(index, /2026-09-25 투자자 성향/);
    assert.match(index, /\*\*계좌\*\* \(1\)/);
    assert.ok(index.includes(AUTO_END));
    const cat = readFileSync(join(root, `${home}/700 자산.md`), 'utf8');
    assert.match(cat, /총 2개/);
    assert.doesNotMatch(cat, /위탁-삼성전자/, '기계 데이터는 색인하지 않는다');
    assert.deepEqual(buildVaultIndex(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildVaultIndex: apply=false면 파일을 쓰지 않는다', () => {
  const { root } = makeVault();
  try {
    const before = readFileSync(join(root, VAULT_REL.knowledgeIndexFile), 'utf8');
    assert.ok(buildVaultIndex(root, { apply: false }).length > 0);
    assert.equal(readFileSync(join(root, VAULT_REL.knowledgeIndexFile), 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
