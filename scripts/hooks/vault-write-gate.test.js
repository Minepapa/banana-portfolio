import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decideWrite, resultingContent, vaultRelForCheck } from './vault-write-gate.mjs';

const REGISTRY = `## 2. 등록표

| type | 경로 | 제목 | 필수 | 쓰는 주체 |
|---|---|---|---|---|
| \`note\` | \`20_Records/21_Notes/{YYYY}/\` | \`YYYY-MM-DD 내용\` | C + \`origin\` | 클리오 |
${Array.from({ length: 20 }, (_, i) => `| \`t${i}\` | \`x${i}/\` | 자유 | S |`).join('\n')}

## 3. 검사 규칙
`;
const good = '---\ntype: "note"\ncategory: ["[[01_Home/100 나]]"]\ndescription: "d"\nsensitivity: "일반"\ncreated: "2026-10-09"\nmodified: "2026-10-09"\norigin: "telegram"\n---\n본문';

test('vaultRelForCheck: 볼트 노트만 검사, 보관·기계 데이터·금고·헌법·비md·볼트 밖은 제외, 심볼릭 링크는 풀어서', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-'));
  try {
    const vault = join(root, 'Mouseion');
    mkdirSync(join(vault, '20_Records'), { recursive: true });
    symlinkSync(vault, join(root, 'old-vault'));
    assert.equal(vaultRelForCheck(join(vault, '20_Records/a.md'), vault), '20_Records/a.md');
    assert.equal(vaultRelForCheck(join(root, 'old-vault/20_Records/new/b.md'), vault), '20_Records/new/b.md');
    for (const p of ['80_Archive/a.md', '95_Etna/a.md', '99_Adyton/a.md', 'CLAUDE.md', '20_Records/a.json', '.obsidian/a.md']) {
      assert.equal(vaultRelForCheck(join(vault, p), vault), null, p);
    }
    assert.equal(vaultRelForCheck(join(root, 'elsewhere.md'), vault), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resultingContent: Write는 content, Edit는 치환 결과, 적용 불가면 null', () => {
  assert.equal(resultingContent('Write', { content: 'x' }, null), 'x');
  assert.equal(resultingContent('Edit', { old_string: 'a', new_string: 'b' }, 'a a'), 'b a');
  assert.equal(resultingContent('Edit', { old_string: 'a', new_string: 'b', replace_all: true }, 'a a'), 'b b');
  assert.equal(resultingContent('Edit', { old_string: '$&', new_string: '$1' }, 'x$&'), 'x$1', '치환 패턴 문자를 그대로');
  assert.equal(resultingContent('Edit', { old_string: 'z', new_string: 'b' }, 'a'), null);
  assert.equal(resultingContent('Edit', { old_string: 'a', new_string: 'b' }, null), null);
});

test('decideWrite: 규칙에 맞으면 통과, 어긋나면 사유와 함께 차단, 등록부 해석 불가도 차단', () => {
  assert.deepEqual(decideWrite({ relPath: '20_Records/21_Notes/2026/2026-10-09 메모.md', content: good, registryText: REGISTRY }), { block: false });
  const bad = decideWrite({ relPath: '20_Records/21_Notes/2026/메모.md', content: good, registryText: REGISTRY });
  assert.equal(bad.block, true);
  assert.match(bad.reason, /제목 형식/);
  assert.match(decideWrite({ relPath: '20_Records/21_Notes/2026/2026-10-09 x.md', content: '본문만', registryText: REGISTRY }).reason, /type 없음/);
  assert.match(decideWrite({ relPath: 'a.md', content: good, registryText: '깨진 등록부' }).reason, /해석하지 못해/);
});

test('훅 실행: 볼트 밖 파일은 통과(종료 0), 볼트 안 규칙 위반은 종료 2', () => {
  const hook = new URL('./vault-write-gate.mjs', import.meta.url).pathname;
  const run = (input) => spawnSync('node', [hook], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: '/tmp/not-vault.md', content: 'x' } }).status, 0);
  assert.equal(run({ tool_name: 'Read', tool_input: { file_path: '/tmp/x.md' } }).status, 0);
});

test('decideWrite: 등록부 자체를 쓸 때는 새 내용으로 판정 — 깨진 등록부는 막고, 디스크 등록부가 깨져 있어도 고치는 쓰기는 통과', () => {
  const rel = '90_Delphi/Schema/경로 등록부.md';
  const regDoc = `---\ntype: "schema"\ndescription: "d"\ncreated: "2026-10-08"\nmodified: "2026-10-09"\n---\n${REGISTRY}`.replace(
    '| `note`', '| `schema` | `90_Delphi/{Schema,Config}/` | 이름 | S |\n| `note`');
  assert.match(decideWrite({ relPath: rel, content: '---\ntype: "schema"\n---\n표 없음', registryText: REGISTRY }).reason, /새 경로 등록부 내용을 해석할 수 없어/);
  assert.deepEqual(decideWrite({ relPath: rel, content: regDoc, registryText: '깨진 디스크 등록부' }), { block: false });
});

test('resultingContent: 없는 파일을 빈 old_string Edit로 만들면 new_string을 검사', () => {
  assert.equal(resultingContent('Edit', { old_string: '', new_string: 'new' }, null), 'new');
});

test('훅 실행: 임시 볼트에서 규칙 위반 쓰기는 종료 2, 맞는 쓰기는 종료 0', async () => {
  const { mkdtempSync: mk, mkdirSync: md, writeFileSync: wf, rmSync: rm } = await import('node:fs');
  const vault = mk(join(tmpdir(), 'gate-vault-'));
  try {
    md(join(vault, '90_Delphi/Schema'), { recursive: true });
    wf(join(vault, '90_Delphi/Schema/경로 등록부.md'), REGISTRY);
    const hook = new URL('./vault-write-gate.mjs', import.meta.url).pathname;
    const run = (input) => spawnSync('node', [hook], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, VAULT_PATH: vault } });
    const bad = run({ tool_name: 'Write', tool_input: { file_path: join(vault, '20_Records/21_Notes/2026/메모.md'), content: '본문만' } });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /type 없음/);
    const ok = run({ tool_name: 'Write', tool_input: { file_path: join(vault, '20_Records/21_Notes/2026/2026-10-09 메모.md'), content: good } });
    assert.equal(ok.status, 0, ok.stderr);
  } finally { rm(vault, { recursive: true, force: true }); }
});
