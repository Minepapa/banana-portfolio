import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AUTO_END, AUTO_START, buildConceptCounts, buildIndexBlock, buildVaultIndex, parseCategories, replaceAutoBlock } from './vault-index-builder.mjs';
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

test('buildIndexBlock: 결정 요지는 있을 때만 한 줄로 붙이고 120자를 넘으면 줄인다', () => {
  const decision = (key, description) => ({
    rel: `${VAULT_REL.decisionsCanonical}/${key}.md`,
    decisionKey: key,
    status: '결정됨',
    categories: [],
    description,
  });
  const block = buildIndexBlock([
    decision('있음', '요지 내용'),
    decision('없음'),
    decision('줄바꿈', '첫 줄\n둘째 줄'),
    decision('긴 문장', '가'.repeat(121)),
    decision('배열', ['요지', '문자열 아님']),
  ]);
  assert.match(block, /`있음` → \[\[.*\/있음\]\] — 요지 내용/);
  assert.match(block, /`없음` → \[\[.*\/없음\]\]\n/);
  assert.match(block, /`줄바꿈` → \[\[.*\/줄바꿈\]\] — 첫 줄 둘째 줄/);
  assert.ok(block.includes(`\`긴 문장\` → [[${VAULT_REL.decisionsCanonical}/긴 문장]] — ${'가'.repeat(120)}…`));
  assert.match(block, /`배열` → \[\[.*\/배열\]\]\n/);
});

test('buildVaultIndex: 키워드 표는 보존하고 자동 구역·분류 목록을 만들며, 다시 돌리면 변경 없음', () => {
  const { root, home } = makeVault();
  try {
    const changed = buildVaultIndex(root);
    assert.deepEqual(changed.sort(), [`${home}/500 기술.md`, `${home}/700 자산.md`, VAULT_REL.knowledgeIndexFile, VAULT_REL.mouseionConceptCounts].sort());
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

test('buildConceptCounts: 분류 노트별 건수, 이름순, 99로 시작하는 개념은 넣지 않는다', () => {
  const notes = [
    { rel: '01_Home/700 자산.md', type: 'category', categories: [] },
    { rel: '01_Home/500 기술.md', type: 'category', categories: [] },
    { rel: '01_Home/99 금고.md', type: 'category', categories: [] },
    { rel: `${top('80_')}/옛 분류.md`, type: 'category', categories: [] },
    { rel: 'a.md', type: 'note', categories: ['700 자산', '500 기술'] },
    { rel: 'b.md', type: 'note', categories: ['700 자산', '99 금고'] },
  ];
  const now = new Date('2026-10-31T14:50:00Z');
  assert.deepEqual(buildConceptCounts(notes, now), {
    schemaVersion: 1,
    generatedAt: '2026-10-31T14:50:00.000Z',
    totalNotes: 6,
    concepts: [{ name: '500 기술', count: 1 }, { name: '700 자산', count: 2 }],
  });
});

test('buildVaultIndex: 개념별 건수 파일을 쓰고, 건수가 같으면 다시 쓰지 않으며, 바뀌면 다시 쓴다', () => {
  const { root, home } = makeVault();
  const file = join(root, VAULT_REL.mouseionConceptCounts);
  try {
    buildVaultIndex(root, { now: new Date('2026-10-30T14:50:00Z') });
    const first = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(first.generatedAt, '2026-10-30T14:50:00.000Z');
    assert.deepEqual(first.concepts, [{ name: '500 기술', count: 1 }, { name: '700 자산', count: 2 }]);
    assert.ok(!JSON.stringify(first).includes('위탁-삼성전자'), '기계 데이터는 세지 않는다');
    assert.deepEqual(buildVaultIndex(root, { now: new Date('2026-10-31T14:50:00Z') }), []);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).generatedAt, '2026-10-30T14:50:00.000Z');
    writeFileSync(join(root, '30_Wiki', '새 노트.md'), `---\ncategory: ["[[${home}/500 기술]]"]\n---\n`);
    assert.ok(buildVaultIndex(root, { now: new Date('2026-10-31T14:50:00Z') }).includes(VAULT_REL.mouseionConceptCounts));
    const second = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(second.generatedAt, '2026-10-31T14:50:00.000Z');
    assert.deepEqual(second.concepts[0], { name: '500 기술', count: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildVaultIndex: apply=false면 개념별 건수 파일도 쓰지 않는다', () => {
  const { root } = makeVault();
  try {
    assert.ok(buildVaultIndex(root, { apply: false }).includes(VAULT_REL.mouseionConceptCounts));
    assert.throws(() => readFileSync(join(root, VAULT_REL.mouseionConceptCounts), 'utf8'), { code: 'ENOENT' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildVaultIndex: 이전 건수 파일이 깨졌으면 새로 쓰고, 색인 파일이 없어 실패해도 건수는 먼저 쓴다', () => {
  const { root } = makeVault();
  const file = join(root, VAULT_REL.mouseionConceptCounts);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{"schemaVersion": 1, "conce');
    rmSync(join(root, VAULT_REL.knowledgeIndexFile));
    assert.throws(() => buildVaultIndex(root), /색인 파일이 없습니다/);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).concepts.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
