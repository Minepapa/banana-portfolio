import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadPeople } from './media-people.mjs';
import { VAULT_REL } from './vault-paths.mjs';
import { buildFrontmatter } from './vault-frontmatter.mjs';

test('가족 하위 category 링크를 추출하고 200과 없는 경우를 제외한다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'media-people-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function add(title, category) {
    const path = join(root, VAULT_REL.people, `${title}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${buildFrontmatter({ category })}# ${title}\n`);
  }
  add('가상가족', ['[[01_Home/202 휘영]]', '[[01_Home/200 가족]]',
    '[[01_Home/201 미네]]', '[[01_Home/202 휘영]]']);
  add('가상동료', '[[01_Home/100 나]]');
  const people = loadPeople(root);
  assert.deepEqual(people.find((person) => person.title === '가상가족').subcategories,
    ['[[01_Home/201 미네]]', '[[01_Home/202 휘영]]']);
  assert.equal(people.find((person) => person.title === '가상가족').home201, true);
  assert.deepEqual(people.find((person) => person.title === '가상동료').subcategories, []);
});
