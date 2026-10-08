import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { checkNote, parseRegistry } from './vault-registry.mjs';
import { vaultAbs } from './vault-paths.mjs';

const REGISTRY = `## 2. 등록표

| type | 경로 | 제목 | 필수 | 쓰는 주체 |
|---|---|---|---|---|
| \`note\` | \`20_Records/21_Notes/{YYYY}/\` | \`YYYY-MM-DD 내용\` | C + \`occurred\` · \`origin\` | 클리오 |
| \`category\` | \`01_Home/\` | \`번호 이름\` | S + \`number\` · \`parent\`(하위 분류) | 클리오 |
| \`topic\` | \`30_Wiki/34_Topics/\` | 명사구 | C + \`sources\` |
| \`topic\` | \`30_Wiki/34_Topics/{묶음}/\` | 한글 | C + \`sources\` |
| \`schema\` · \`config\` | \`90_Delphi/{Schema,Config}/\` | 이름 | S |
| \`index\` | \`90_Delphi/index.md\` | 고정 | 자동 생성 |
${Array.from({ length: 16 }, (_, i) => `| \`t${i}\` | \`x${i}/\` | 자유 | S |`).join('\n')}

## 3. 검사 규칙
`;
const fm = (o) => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n본문`;
const C = { category: '["[[01_Home/700 자산]]"]', description: '"설명"', sensitivity: '"일반"', modified: '"2026-10-09"' };

test('parseRegistry: 묶음·추가 필드·조건부 필드·여러 경로를 읽는다', () => {
  const rules = parseRegistry(REGISTRY);
  const note = rules.find((r) => r.type === 'note');
  assert.deepEqual(note.required.extra, ['occurred', 'origin']);
  assert.deepEqual(rules.find((r) => r.type === 'category').required.extra, ['number'], 'parent(하위 분류)는 조건부');
  assert.equal(rules.filter((r) => r.type === 'topic').length, 2);
  assert.ok(rules.find((r) => r.type === 'config').pathRegex.test('90_Delphi/Config/x.md'));
});

test('checkNote: type·경로·제목·필수 필드, 추가 필드는 시행일 이후 노트만', () => {
  const rules = parseRegistry(REGISTRY);
  const ok = fm({ type: 'note', ...C, created: '"2026-10-09"', occurred: '"2026-10-09"', origin: '"telegram"' });
  assert.deepEqual(checkNote('20_Records/21_Notes/2026/2026-10-09 메모.md', ok, rules), []);
  assert.match(checkNote('20_Records/21_Notes/2026/메모.md', ok, rules).join(), /제목 형식/);
  assert.match(checkNote('30_Wiki/메모.md', ok, rules).join(), /경로가 아님/);
  assert.match(checkNote('a.md', fm({ type: 'session' }), rules).join(), /등록되지 않은 type/);
  assert.match(checkNote('a.md', '본문만', rules).join(), /type 없음/);
  const newMissing = fm({ type: 'note', ...C, created: '"2026-10-09"' });
  assert.match(checkNote('20_Records/21_Notes/2026/2026-10-09 메모.md', newMissing, rules).join(), /occurred, origin/);
  const oldMissing = fm({ type: 'note', ...C, created: '"2026-09-01"' });
  assert.deepEqual(checkNote('20_Records/21_Notes/2026/2026-09-01 메모.md', oldMissing, rules), [], '시행일 이전은 추가 필드 면제');
  const list = `---\ntype: note\ncategory:\n  - "[[01_Home/700 자산]]"\ndescription: "d"\nsensitivity: "일반"\ncreated: "2026-09-01"\nmodified: "x"\n---\n`;
  assert.deepEqual(checkNote('20_Records/21_Notes/2026/2026-09-01 메모.md', list, rules), [], '여러 줄 목록 값도 인정');
  assert.deepEqual(checkNote('90_Delphi/index.md', fm({ type: 'index' }), rules), []);
});

test('실제 경로 등록부를 읽을 수 있다', { skip: !existsSync(vaultAbs('90_Delphi/Schema/경로 등록부.md')) }, () => {
  const rules = parseRegistry(readFileSync(vaultAbs('90_Delphi/Schema/경로 등록부.md'), 'utf8'));
  for (const t of ['inbox', 'note', 'decision', 'implementation', 'session-log', 'telegram-log', 'report', 'topic', 'schema', 'agent']) {
    assert.ok(rules.some((r) => r.type === t), t);
  }
});

test('parseRegistry: 괄호 안 다른 필드 설명은 앞 필드를 조건부로 만들지 않는다(media mediaCount), 셀 모자란 행은 건너뜀', () => {
  const rows = [
    '| `media` | `20_Records/24_Media/{YYYY}/` | `YYYY-MM-DD 순간` | C + `occurred` · `origin` · `mediaCount` (`place`는 위치 정보가 있을 때만) | 파이프라인 |',
    '| `broken` | `x/` |',
    '| `inbox` | `00_Inbox/` | 자유 | `origin` · `created` (최소 묶음, 클리오가 ingest 때 채움) | 사람 |',
    ...Array.from({ length: 20 }, (_, i) => `| \`t${i}\` | \`x${i}/\` | 자유 | S | 코드 \\| 잡 |`),
  ];
  const rules = parseRegistry(`| type | 경로 | 제목 | 필수 | 쓰는 주체 |\n|---|---|---|---|---|\n${rows.join('\n')}\n\n## 3. 검사\n`);
  assert.deepEqual(rules.find((r) => r.type === 'media').required.extra, ['occurred', 'origin', 'mediaCount']);
  assert.ok(!rules.some((r) => r.type === 'broken'));
  assert.equal(rules.find((r) => r.type === 't0').writer, '코드 | 잡', '이스케이프된 파이프는 셀 안 문자');
});

test('checkNote: 00_Inbox는 검사하지 않고, BOM이 있어도 머리말을 읽는다', () => {
  const rules = parseRegistry(REGISTRY);
  assert.deepEqual(checkNote('00_Inbox/폰 메모.md', '머리말 없는 메모', rules), []);
  const ok = `\uFEFF${fm({ type: 'note', ...C, created: '"2026-10-09"', occurred: '"x"', origin: '"y"' })}`;
  assert.deepEqual(checkNote('20_Records/21_Notes/2026/2026-10-09 메모.md', ok, rules), []);
});
