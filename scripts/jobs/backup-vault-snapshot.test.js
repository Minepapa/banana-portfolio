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

test('buildLintNotice: 추천안은 위반 밑에, 자동 수정만 있어도 알린다', async () => {
  const { buildLintNotice } = await import('./backup-vault-snapshot.mjs');
  const withSuggestion = buildLintNotice({ checked: 3, results: [{ rel: 'a.md', problems: ['type 없음'], suggestions: ['type "note"'] }] });
  assert.match(withSuggestion, /- a\.md: type 없음\n {2}→ 추천: type "note"/);
  assert.match(withSuggestion, /클리오 세션에서 추천안을 확인/);
  const onlyFixed = buildLintNotice({ checked: 3, results: [], fixed: [{ rel: 'b.md', changes: ['waitingOn "외부 — x" → "외부"'] }] });
  assert.match(onlyFixed, /위반 0개/);
  assert.match(onlyFixed, /■ 자동 수정 1개/);
  assert.doesNotMatch(onlyFixed, /할 일/);
});

test('autoFixAfterSnapshot: 고친 노트와 기록만 경로 지정 커밋, 기록 실패해도 노트는 커밋, 수정 없으면 커밋 없음', async () => {
  const { autoFixAfterSnapshot, buildLintNotice } = await import('./backup-vault-snapshot.mjs');
  const quiet = { log() {}, error() {} };
  const one = () => Object.assign([{ rel: 'a.md', changes: ['c'] }], { skipped: [] });
  let calls = [];
  autoFixAfterSnapshot('2026-10-25', { root: '/r', runGit: (a) => calls.push(a), fix: one, record: () => 'log.md', log: quiet });
  assert.deepEqual(calls, [['add', '--', 'a.md', 'log.md'], ['commit', '-m', 'autofix 2026-10-25', '--quiet', '--', 'a.md', 'log.md']]);
  calls = [];
  const failed = autoFixAfterSnapshot('2026-10-25', { root: '/r', runGit: (a) => calls.push(a), fix: one, record: () => { throw new Error('잠김'); }, log: quiet });
  assert.deepEqual(calls[0], ['add', '--', 'a.md']);
  assert.match(buildLintNotice({ checked: 1, results: [], fixed: failed }), /기록 실패: 잠김/);
  calls = [];
  const none = autoFixAfterSnapshot('2026-10-25', { root: '/r', runGit: (a) => calls.push(a), fix: () => Object.assign([], { skipped: [{ rel: 'b.md', error: 'x' }] }), log: quiet });
  assert.deepEqual(calls, []);
  assert.match(buildLintNotice({ checked: 1, results: [], fixed: none }), /자동 수정 실패 1개/);
});
