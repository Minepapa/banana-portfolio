import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLegacyPath } from '../lib/vault-layout.mjs';
import { VAULT_PATHS, VAULT_ROOT } from '../lib/vault-paths.mjs';
import {
  brokenFullPathLinks, determineYear, migrateVault, planMigration, rewriteLinks,
} from './migrate-vault-layout.mjs';

const CLI = fileURLToPath(new URL('./migrate-vault-layout.mjs', import.meta.url));
const reportSource = 'Log/Reports/2026-10-01-report.md';
const reportDestination = '50_Outputs/Reports/2026/2026-10-01-report.md';
const noteSource = 'Knowledge/Topics/note.md';
const noteDestination = mapLegacyPath(noteSource).to;

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function fakeVault(entries, commitDate) {
  const root = mkdtempSync(join(tmpdir(), 'vault-migration-'));
  git(root, 'init', '-q');
  for (const [path, content] of Object.entries(entries)) {
    const absolutePath = join(root, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  git(root, 'add', '.');
  commitAt(root, 'fixture', commitDate);
  return root;
}

function commitAt(root, message, date) {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', message], { env });
}

function withVault(entries, run) {
  const root = fakeVault(entries);
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('연도는 파일명, 머리말 date 순서로 정하고 없으면 추측하지 않는다', () => {
  assert.equal(determineYear(reportSource, '---\ndate: 2025-01-01\n---'), '2026');
  assert.equal(determineYear('Log/Reports/report.md', '---\ndate: 2025-01-01\n---\n본문'), '2025');
  assert.equal(determineYear('Log/Reports/report.md', '본문'), null);
});

test('연도 반영 후 목적지 충돌과 이미 존재하는 목적지 충돌을 찾는다', () => {
  const first = 'Log/Reports/2026-01-01-same.md';
  const second = 'Log/Research/2026-01-01-same.md';
  const plan = planMigration([
    { path: first, content: '' }, { path: second, content: '' },
    { path: '50_Outputs/Reports/2026/other.md', content: '' },
  ]);
  assert.deepEqual(plan.collisions, [{ to: '50_Outputs/Reports/2026/2026-01-01-same.md', sources: [first, second] }]);
});

test('날짜 없는 파일은 git 최초 추가 연도를 쓰고 근거별 개수를 보고한다', () => {
  const undated = 'Log/Reports/undated.md';
  const named = 'Log/Reports/2026-01-01-named.md';
  const dated = 'Log/Reports/dated.md';
  const root = fakeVault({
    [undated]: '첫 내용',
    [named]: '---\ndate: 2022-01-01\n---\n',
    [dated]: '---\ndate: 2024-01-01\n---\n',
  }, '2023-03-02T12:00:00Z');
  try {
    writeFileSync(join(root, undated), '나중 내용');
    git(root, 'add', undated);
    commitAt(root, 'later edit', '2025-04-01T12:00:00Z');
    const plan = migrateVault(root);
    assert.ok(plan.moves.some(({ from, to }) => from === undated && to === '50_Outputs/Reports/2023/undated.md'));
    assert.deepEqual(plan.yearSources, { filename: 1, frontmatter: 1, gitFirstCommit: 1 });
    assert.deepEqual(plan.gitFirstCommitFiles, [{ path: undated, year: '2023' }]);
    assert.deepEqual(plan.unresolvedYears, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('날짜 없는 미추적 파일은 연도 미결정으로 적용을 거부한다', () => {
  const undated = 'Log/Reports/undated.md';
  withVault({ '.gitignore': `${undated}\n` }, (root) => {
    mkdirSync(dirname(join(root, undated)), { recursive: true });
    writeFileSync(join(root, undated), '미추적');
    const plan = migrateVault(root);
    assert.deepEqual(plan.unresolvedYears, [undated]);
    assert.deepEqual(plan.yearSources, { filename: 0, frontmatter: 0, gitFirstCommit: 0 });
    assert.throws(() => migrateVault(root, { apply: true }), /연도 미결정/);
    assert.equal(readFileSync(join(root, undated), 'utf8'), '미추적');
  });
});

test('삭제 커밋 뒤 미추적으로 다시 생긴 파일에는 과거 추가 연도를 쓰지 않는다', () => {
  const undated = 'Log/Reports/undated.md';
  const root = fakeVault({ [undated]: '처음 파일' }, '2023-03-02T12:00:00Z');
  try {
    git(root, 'rm', '--', undated);
    commitAt(root, 'remove file', '2024-04-01T12:00:00Z');
    mkdirSync(dirname(join(root, undated)), { recursive: true });
    writeFileSync(join(root, undated), '새 미추적 파일');
    const plan = migrateVault(root);
    assert.deepEqual(plan.unresolvedYears, [undated]);
    assert.deepEqual(plan.gitFirstCommitFiles, []);
    assert.throws(() => migrateVault(root, { apply: true }), /연도 미결정/);
    assert.equal(readFileSync(join(root, undated), 'utf8'), '새 미추적 파일');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('파일 단위 연도 규칙은 파일명 앞에 연도 폴더를 삽입한다', () => {
  const source = 'Knowledge/Kangto/README.md';
  const plan = planMigration([{ path: source, content: '---\ndate: 2026-01-01\n---\n' }]);
  assert.deepEqual(plan.moves, [{
    from: source,
    to: '20_Records/22_Literature/2026/README.md',
  }]);
});

test('별칭, 제목, 블록, 임베드, 확장자와 머리말 링크를 치환하고 코드는 제외한다', () => {
  const source = `---\nrelated: "[[${noteSource.slice(0, -3)}|별칭]]"\n---\n[[${noteSource}#제목]] ![[${noteSource.slice(0, -3)}^블록]]\n[[note]] [[Knowledge/Kangto/deleted.md]]\n\`${'[[' + noteSource + ']]'}\`\n\`\`\`md\n[[${noteSource}]]\n\`\`\`\n`;
  const result = rewriteLinks(source, [{ from: noteSource, to: noteDestination }], ['Knowledge/Kangto/deleted.md']);
  assert.match(result.content, new RegExp(`related: "\\[\\[${noteDestination.slice(0, -3)}\\|별칭`));
  assert.ok(result.content.includes(`[[${noteDestination}#제목]]`));
  assert.ok(result.content.includes(`![[${noteDestination.slice(0, -3)}^블록]]`));
  assert.ok(result.content.includes(`[[${noteSource}]]`));
  assert.equal(result.changedLinks, 3);
  assert.equal(result.basenameLinks, 1);
  assert.deepEqual(result.deletedLinks, ['Knowledge/Kangto/deleted.md']);
});

test('여러 백틱으로 감싼 인라인 코드는 짧은 백틱과 링크를 포함해도 건드리지 않는다', () => {
  const content = `\`\`literal \` [[${noteSource.slice(0, -3)}]]\`\` [[${noteSource.slice(0, -3)}]]`;
  const result = rewriteLinks(content, [{ from: noteSource, to: noteDestination }]);
  assert.equal(result.changedLinks, 1);
  assert.ok(result.content.startsWith(`\`\`literal \` [[${noteSource.slice(0, -3)}]]\`\``));
  assert.deepEqual(brokenFullPathLinks(`\`\`literal \` [[Missing/path]]\`\``, []), []);
});

test('물결표와 네 백틱 펜스 안의 링크는 치환하거나 파손으로 세지 않는다', () => {
  const fence = '`'.repeat(4);
  const content = `~~~md\n[[${noteSource}]]\n~~~\n${fence}md\n[[${noteSource}]]\n\`\`\`\n[[${noteSource}]]\n${fence}\n[[${noteSource}]]`;
  const rewritten = rewriteLinks(content, [{ from: noteSource, to: noteDestination }]);
  assert.equal(rewritten.changedLinks, 1);
  assert.ok(rewritten.content.includes(`~~~md\n[[${noteSource}]]\n~~~`));
  assert.ok(rewritten.content.includes(`${fence}md\n[[${noteSource}]]\n\`\`\`\n[[${noteSource}]]`));
  assert.deepEqual(brokenFullPathLinks(`~~~\n[[Missing/path]]\n~~~\n${fence}\n[[Missing/path]]\n${fence}`, []), []);
});

test('상대 링크는 옛 위치에서 대상을 찾고 새 위치에서 다시 계산한다', () => {
  const from = 'Knowledge/Meta/foo.md';
  const to = mapLegacyPath(from).to;
  const neighbor = 'Knowledge/Topics/neighbor.md';
  const rewritten = rewriteLinks('[[../Meta/foo]] [[./neighbor]]',
    [{ from: noteSource, to: noteDestination }, { from, to },
      { from: neighbor, to: mapLegacyPath(neighbor).to }], [],
    [noteSource, from, neighbor], noteSource);
  assert.equal(rewritten.content, '[[../../90_Delphi/foo]] [[./neighbor]]');
  assert.equal(rewritten.changedLinks, 1);
  assert.equal(rewriteLinks('[[./neighbor]]', [], [],
    [noteDestination, mapLegacyPath(neighbor).to], noteDestination).changedLinks, 0);
  const attachment = 'Knowledge/Meta/chart.png';
  assert.equal(rewriteLinks('![[../Meta/chart.png]]',
    [{ from: noteSource, to: noteDestination },
      { from: attachment, to: mapLegacyPath(attachment).to }], [],
    [noteSource, attachment], noteSource).content, '![[../../90_Delphi/chart.png]]');
});

test('깨진 링크 판정은 표 이스케이프, 상대 경로, 부분 경로를 해석한다', () => {
  const paths = [
    '30_Wiki/34_Topics/CashFlow/fcf_yield.md',
    '30_Wiki/34_Topics/neighbor.md',
    '90_Delphi/무인잡-카탈로그.md',
  ];
  const content = String.raw`[[CashFlow/fcf_yield]] | [[CashFlow/fcf_yield\|표]]
[[../neighbor]] [[../../../90_Delphi/무인잡-카탈로그]] [[Missing/path]]`;
  assert.deepEqual(brokenFullPathLinks(content, paths, '30_Wiki/34_Topics/CashFlow/note.md'), ['Missing/path']);
});

test('깨진 링크 판정은 없는 basename 링크도 보고한다', () => {
  assert.deepEqual(brokenFullPathLinks('[[Missing]] [[Existing]]', ['30_Wiki/Existing.md']), ['Missing']);
  assert.deepEqual(brokenFullPathLinks('[[#Section]] [[^block]]', ['30_Wiki/Existing.md']), []);
});

test('이관은 표에서 이스케이프한 별칭 링크도 갱신한다', () => {
  const source = String.raw`| [[Knowledge/Topics/note\|별칭]] |`;
  const result = rewriteLinks(source, [{ from: noteSource, to: noteDestination }]);
  assert.equal(result.content, String.raw`| [[30_Wiki/34_Topics/note\|별칭]] |`);
  assert.equal(result.changedLinks, 1);
});

test('이름이 바뀐 유일한 노트의 basename 링크는 별칭·제목·임베드까지 갱신한다', () => {
  const from = 'Knowledge/Meta/므네모시네-파일배선도.md';
  const to = '90_Delphi/Schema/경로 등록부.md';
  const content = '[[므네모시네-파일배선도]] [[므네모시네-파일배선도|별칭]] '
    + '[[므네모시네-파일배선도#제목]] ![[므네모시네-파일배선도]]';
  const result = rewriteLinks(content, [{ from, to }], [], [from], 'Knowledge/Index.md');
  assert.equal(result.content, '[[경로 등록부]] [[경로 등록부|별칭]] '
    + '[[경로 등록부#제목]] ![[경로 등록부]]');
  assert.equal(result.basenameChangedLinks, 4);
  assert.deepEqual(result.deferredBasenameLinks, []);
});

test('옛 basename 중복은 보류하고 새 basename 중복은 전체 경로로 바꾼다', () => {
  const from = 'Knowledge/API/README.md';
  const to = '30_Wiki/34_Topics/API 개요.md';
  const ambiguous = rewriteLinks('[[README]]', [{ from, to }], [],
    [from, 'Knowledge/Playbook/README.md'], 'Knowledge/Index.md');
  assert.equal(ambiguous.content, '[[README]]');
  assert.deepEqual(ambiguous.deferredBasenameLinks, [{
    file: 'Knowledge/Index.md', target: 'README',
    candidates: [from, 'Knowledge/Playbook/README.md'],
  }]);

  const unique = rewriteLinks('[[README.md]]', [{ from, to }], [],
    [from, '30_Wiki/API 개요.md'], 'Knowledge/Index.md');
  assert.equal(unique.content, '[[30_Wiki/34_Topics/API 개요.md]]');
  assert.equal(unique.basenameChangedLinks, 1);
});

test('이관 계획과 보고에 basename 치환 수와 보류 목록을 담는다', () => {
  const renamed = 'Knowledge/Meta/므네모시네-파일배선도.md';
  withVault({
    [renamed]: '배선도',
    'Knowledge/Index.md': '[[므네모시네-파일배선도]]',
  }, (root) => {
    const planned = migrateVault(root);
    assert.equal(planned.basenameChangedLinks, 1);
    assert.deepEqual(planned.deferredBasenameLinks, []);
    const applied = migrateVault(root, { apply: true });
    assert.equal(applied.basenameChangedLinks, 1);
    assert.deepEqual(applied.brokenLinks, []);
    assert.equal(readFileSync(join(root, '90_Delphi/index.md'), 'utf8'), '[[경로 등록부]]');
  });
});

test('각 사전 중단 조건에서 --apply는 볼트를 바꾸지 않는다', () => {
  const cases = [
    { entries: { 'unknown.md': 'x' }, error: /매핑 없음/ },
    { entries: { 'Log/Reports/2026-01-01-a.md': 'x', 'Log/Research/2026-01-01-a.md': 'x' }, error: /충돌/ },
  ];
  for (const { entries, error } of cases) withVault(entries, (root) => {
    assert.throws(() => migrateVault(root, { apply: true }), error);
    assert.equal(git(root, 'status', '--porcelain'), '');
  });
  withVault({ [noteSource]: 'x' }, (root) => {
    writeFileSync(join(root, noteSource), 'dirty');
    assert.throws(() => migrateVault(root, { apply: true }), /깨끗하지/);
    assert.equal(readFileSync(join(root, noteSource), 'utf8'), 'dirty');
  });
  const ignoredSource = 'Knowledge/Topics/ignored.md';
  withVault({ [noteSource]: 'x', '.gitignore': `${ignoredSource}\n` }, (root) => {
    writeFileSync(join(root, ignoredSource), 'ignored');
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.throws(() => migrateVault(root, { apply: true }), /추적되지 않는/);
    assert.equal(existsSync(join(root, noteSource)), true);
  });
});

test('안전 상태 파일은 추적 여부와 이동 후 바이트 동일성을 보고한다', () => {
  const names = ['KillSwitch', 'ExecutionMode', 'ProposalMode'];
  const entries = Object.fromEntries(names.map((name) => [`State/${name}/${name}.md`, `---\nvalue: ${name}\n---\n`]));
  withVault(entries, (root) => {
    const applied = migrateVault(root, { apply: true });
    assert.equal(applied.safetyFiles.length, 3);
    assert.ok(applied.safetyFiles.every((file) => file.tracked && file.byteIdentical));
    const repeated = migrateVault(root, { apply: true });
    assert.equal(repeated.moveCount, 0);
    assert.ok(repeated.safetyFiles.every((file) => file.tracked && file.byteIdentical));
    for (const [index, absolute] of [VAULT_PATHS.state.killSwitch,
      VAULT_PATHS.state.executionMode, VAULT_PATHS.state.proposalMode].entries()) {
      const destination = absolute.slice(VAULT_ROOT.length + 1);
      assert.equal(readFileSync(join(root, destination), 'utf8'), entries[`State/${names[index]}/${names[index]}.md`]);
    }
  });
  withVault({ '.gitignore': 'State/KillSwitch/KillSwitch.md\n' }, (root) => {
    const source = join(root, 'State/KillSwitch/KillSwitch.md');
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, 'active: true\n');
    assert.throws(() => migrateVault(root, { apply: true }), /추적되지 않는/);
    assert.equal(readFileSync(source, 'utf8'), 'active: true\n');
  });
});

test('목적지 부모가 파일이면 이동 전에 중단한다', () => {
  withVault({ [noteSource]: '노트', '30_Wiki': '점유' }, (root) => {
    assert.throws(() => migrateVault(root, { apply: true }), /목적지 부모 경로/);
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.equal(readFileSync(join(root, noteSource), 'utf8'), '노트');
  });
});

test('--vault가 상위 저장소의 하위 폴더면 reset 범위를 넓히지 않고 중단한다', () => {
  withVault({ [`sub/${noteSource}`]: '노트' }, (root) => {
    assert.throws(() => migrateVault(join(root, 'sub'), { apply: true }), /git 작업 트리 루트/);
    assert.equal(git(root, 'status', '--porcelain'), '');
  });
});

test('첫 이동 직후 예외가 나면 시작 HEAD와 새 폴더를 복구하고 실패를 보고한다', () => {
  withVault({ [noteSource]: '노트', 'Knowledge/Index.md': '색인' }, (root) => {
    const report = join(tmpdir(), `migration-recovery-${process.pid}.json`);
    try {
      assert.throws(() => migrateVault(root, { apply: true, reportPath: report,
        afterMove: () => { throw new Error('강제 예외'); } }), /강제 예외; 복구: success/);
      assert.equal(git(root, 'status', '--porcelain'), '');
      assert.equal(readFileSync(join(root, noteSource), 'utf8'), '노트');
      assert.equal(existsSync(join(root, noteDestination)), false);
      assert.equal(JSON.parse(readFileSync(report, 'utf8')).recovery, 'success');
    } finally { rmSync(report, { force: true }); }
  });
});

test('적용 후 깨질 상대 링크는 기존 파손 여부와 관계없이 적용 전에 중단한다', () => {
  withVault({ [noteSource]: '[[../Meta/missing]]' }, (root) => {
    assert.equal(migrateVault(root).plannedBrokenLinks.length, 1);
    assert.throws(() => migrateVault(root, { apply: true }), /적용 후 깨진 링크/);
  });
  withVault({ [noteSource]: '[[../Kangto/deleted]]',
    'Knowledge/Kangto/deleted.md': '삭제 대상' }, (root) => {
    assert.ok(migrateVault(root).plannedBrokenLinks.length > 0);
    assert.throws(() => migrateVault(root, { apply: true }), /적용 후 깨진 링크/);
    assert.equal(git(root, 'status', '--porcelain'), '');
  });
});

test('dry-run은 --report를 주어도 파일을 쓰지 않고, --apply는 이동·삭제·링크 갱신 후 재실행 시 무작업이다', () => {
  const deleted = 'Knowledge/Kangto/original.txt';
  const link = `---\nrelated: "[[${reportSource.slice(0, -3)}]]"\n---\n[[${noteSource.slice(0, -3)}]]\n`;
  withVault({
    [reportSource]: '보고서', [noteSource]: '노트',
    'Knowledge/Index.md': link, [deleted]: '원문',
    '.obsidian/config': '{}',
  }, (root) => {
    for (const folder of ['Facts/Ledger/Exchanges', 'State/ExecutionConfirmations', 'State/Baselines']) {
      mkdirSync(join(root, folder), { recursive: true });
    }
    const reportPath = join(root, 'report.json');
    const before = git(root, 'status', '--porcelain');
    const dryRun = migrateVault(root, { reportPath });
    assert.equal(dryRun.moveCount, 3);
    assert.equal(dryRun.deleteCount, 1);
    assert.equal(dryRun.linkCount, 2);
    assert.equal(before, git(root, 'status', '--porcelain'));
    assert.equal(existsSync(reportPath), false);
    assert.equal(existsSync(join(root, reportSource)), true);

    const applied = migrateVault(root, { apply: true, reportPath });
    assert.equal(existsSync(join(root, reportDestination)), true);
    assert.equal(existsSync(join(root, deleted)), false);
    assert.equal(existsSync(join(root, 'Knowledge')), false);
    assert.equal(existsSync(join(root, 'Log')), false);
    assert.equal(existsSync(join(root, 'Facts')), false);
    assert.equal(existsSync(join(root, 'State')), false);
    assert.deepEqual(applied.remainingLegacyFiles, []);
    assert.equal(existsSync(join(root, '.obsidian/config')), true);
    assert.ok(git(root, 'status', '--porcelain').includes('R '));
    assert.ok(readFileSync(join(root, mapLegacyPath('Knowledge/Index.md').to), 'utf8')
      .includes(`[[${reportDestination.slice(0, -3)}]]`));
    assert.deepEqual(applied.brokenLinks, []);
    assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).moveCount, 3);
    rmSync(reportPath);
    const repeat = migrateVault(root, { apply: true });
    assert.equal(repeat.moveCount, 0);
    assert.equal(repeat.deleteCount, 0);
    assert.equal(repeat.linkCount, 0);
  });
});

test('CLI에서 --vault는 필수다', () => {
  const result = spawnSync(process.execPath, [CLI, '--apply'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--vault/);
});

test('CLI --apply도 가짜 git 볼트에서 이동하고 재실행 시 무작업이다', () => {
  withVault({ [noteSource]: '노트' }, (root) => {
    const first = spawnSync(process.execPath, [CLI, '--vault', root, '--apply'], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).moveCount, 1);
    assert.equal(existsSync(join(root, noteDestination)), true);
    const second = spawnSync(process.execPath, [CLI, '--vault', root, '--apply'], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).moveCount, 0);
  });
});

test('--map은 이동과 사전 병합된 redirect 링크를 치환하고 재실행은 무작업이다', () => {
  const from = '30_Wiki/34_Topics/옛 기능.md';
  const redirectFrom = '30_Wiki/34_Topics/병합 기능.md';
  const to = '40_Projects/banana-portfolio/Features/새 기능.md';
  const mapPath = join(tmpdir(), `vault-map-${process.pid}.json`);
  withVault({
    [from]: '본문', [redirectFrom]: '병합 전 본문',
    '90_Delphi/index.md': `[[${from.slice(0, -3)}|별칭]] [[병합 기능#제목]] [[../30_Wiki/34_Topics/옛 기능]]\n\`[[병합 기능]]\`\n\`\`\`md\n[[병합 기능]]\n\`\`\``,
  }, (root) => {
    try {
      writeFileSync(mapPath, JSON.stringify([
        { from, to, mode: 'move' }, { from: redirectFrom, to, mode: 'redirect' },
      ]));
      rmSync(join(root, redirectFrom));
      const applied = migrateVault(root, { apply: true, mapPath });
      assert.equal(applied.moveCount, 1);
      assert.equal(applied.linkCount, 3);
      assert.deepEqual(applied.brokenLinks, []);
      assert.equal(existsSync(join(root, to)), true);
      const index = readFileSync(join(root, '90_Delphi/index.md'), 'utf8');
      assert.ok(index.includes(`[[${to.slice(0, -3)}|별칭]]`));
      assert.ok(index.includes('[[새 기능#제목]]'));
      assert.ok(index.includes('`[[병합 기능]]`'));
      assert.equal(migrateVault(root, { apply: true, mapPath }).moveCount, 0);
      writeFileSync(join(root, '90_Delphi/index.md'), `${index}\n다른 수정`);
      assert.throws(() => migrateVault(root, { apply: true, mapPath }), /예상한 이관 내용과 다릅니다/);
      writeFileSync(join(root, '90_Delphi/index.md'), index);
      writeFileSync(join(root, 'unrelated.md'), '미추적');
      assert.throws(() => migrateVault(root, { apply: true, mapPath }), /깨끗하지/);
    } finally { rmSync(mapPath, { force: true }); }
  });
});

test('--map은 redirect 원본 D와 목적지 M만 허용하며 실패 복구에도 보존한다', () => {
  const from = '30_Wiki/34_Topics/기능.md';
  const redirectFrom = '30_Wiki/34_Topics/병합.md';
  const to = '40_Projects/banana-portfolio/Features/기능.md';
  const redirectTo = '40_Projects/banana-portfolio/Features/기존 기능.md';
  const mapPath = join(tmpdir(), `vault-map-status-${process.pid}.json`);
  withVault({ [from]: '원본', [redirectFrom]: '병합 전', [redirectTo]: '병합 대상',
    '90_Delphi/index.md': '[[병합]]' }, (root) => {
    try {
      writeFileSync(mapPath, JSON.stringify([
        { from, to, mode: 'move' }, { from: redirectFrom, to: redirectTo, mode: 'redirect' },
      ]));
      rmSync(join(root, redirectFrom));
      writeFileSync(join(root, redirectTo), '사람이 병합한 본문');
      assert.throws(() => migrateVault(root, { apply: true, mapPath,
        afterMove: () => { throw new Error('강제 예외'); } }), /강제 예외; 복구: success/);
      assert.equal(existsSync(join(root, redirectFrom)), false);
      assert.equal(readFileSync(join(root, redirectTo), 'utf8'), '사람이 병합한 본문');
      assert.equal(existsSync(join(root, from)), true);
      assert.equal(existsSync(join(root, to)), false);
      writeFileSync(join(root, '90_Delphi/index.md'), '다른 변경');
      assert.throws(() => migrateVault(root, { apply: true, mapPath }), /깨끗하지/);
    } finally { rmSync(mapPath, { force: true }); }
  });
});

test('--map은 없는 redirect 목적지와 적용 후 깨진 링크를 거부한다', () => {
  const from = '30_Wiki/34_Topics/기능.md';
  const to = '40_Projects/banana-portfolio/Features/기능.md';
  const mapPath = join(tmpdir(), `vault-map-broken-${process.pid}.json`);
  withVault({ [from]: '[[없는노트]]' }, (root) => {
    try {
      writeFileSync(mapPath, JSON.stringify([{ from, to, mode: 'move' }]));
      assert.throws(() => migrateVault(root, { apply: true, mapPath }), /적용 후 깨진 링크/);
      assert.equal(existsSync(join(root, from)), true);
      writeFileSync(mapPath, JSON.stringify([{ from: '30_Wiki/34_Topics/병합.md', to: '없는목적지.md', mode: 'redirect' }]));
      assert.throws(() => migrateVault(root, { apply: true, mapPath }), /redirect 목적지가 없습니다/);
    } finally { rmSync(mapPath, { force: true }); }
  });
});

test('CLI --map은 legacy 규칙을 적용하지 않는다', () => {
  const from = '30_Wiki/34_Topics/기능.md';
  const to = '40_Projects/banana-portfolio/Features/기능.md';
  const mapPath = join(tmpdir(), `vault-map-cli-${process.pid}.json`);
  withVault({ [from]: '본문' }, (root) => {
    try {
      writeFileSync(mapPath, JSON.stringify([{ from, to, mode: 'move' }]));
      const result = spawnSync(process.execPath,
        [CLI, '--vault', root, '--map', mapPath, '--apply'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).moveCount, 1);
      assert.equal(existsSync(join(root, to)), true);
    } finally { rmSync(mapPath, { force: true }); }
  });
});

test('--map 재실행은 원본만 지우고 기존 목적지를 남긴 상태를 완료로 오인하지 않는다', () => {
  const from = '30_Wiki/34_Topics/기능.md';
  const to = '40_Projects/banana-portfolio/Features/기능.md';
  const mapPath = join(tmpdir(), `vault-map-false-complete-${process.pid}.json`);
  withVault({ [from]: '원본 내용', [to]: '관련 없는 기존 내용' }, (root) => {
    try {
      writeFileSync(mapPath, JSON.stringify([{ from, to, mode: 'move' }]));
      rmSync(join(root, from));
      assert.throws(() => migrateVault(root, { apply: true, mapPath }), /이동 목적지가 원본과 다릅니다/);
      assert.equal(readFileSync(join(root, to), 'utf8'), '관련 없는 기존 내용');
      assert.equal(existsSync(join(root, from)), false);
    } finally { rmSync(mapPath, { force: true }); }
  });
});

test('줄바꿈과 대괄호 별칭은 원문을 보존하고 빈 줄과 코드 안 예시는 제외한다', () => {
  const target = reportSource.slice(0, -3);
  const destination = reportDestination.slice(0, -3);
  const content = `[[${target}|첫 줄\n[제우스] 둘째 줄]]\n[[${target}|빈 줄\n\n다음 문단]]\n`
    + `\`[[${target}|코드\n별칭]]\`\n\`\`\`md\n[[${target}|펜스\n별칭]]\n\`\`\``;
  const result = rewriteLinks(content, [{ from: reportSource, to: reportDestination }]);
  assert.equal(result.changedLinks, 1);
  assert.ok(result.content.includes(`[[${destination}|첫 줄\n[제우스] 둘째 줄]]`));
  assert.ok(result.content.includes(`[[${target}|빈 줄\n\n다음 문단]]`));
  assert.ok(result.content.includes(`\`[[${target}|코드\n별칭]]\``));
  assert.deepEqual(brokenFullPathLinks(`[[${target}|첫 줄\n[제우스] 둘째 줄]]`, [reportDestination]), [target]);
});

test('--fix-legacy-links는 파일 이동 없이 연도 폴더 경로를 찾아 링크만 고친다', () => {
  const index = '90_Delphi/index.md';
  const body = `[[${reportSource.slice(0, -3)}|첫 줄\n[제우스] 둘째 줄]] \`[[${reportSource.slice(0, -3)}]]\``;
  withVault({ [reportDestination]: '보고서', [index]: body }, (root) => {
    const planned = migrateVault(root, { fixLegacyLinks: true });
    assert.equal(planned.moveCount, 0);
    assert.equal(planned.linkCount, 1);
    assert.deepEqual(planned.unresolvedLegacyLinks, []);
    assert.deepEqual(planned.plannedBrokenLinks, []);
    assert.equal(git(root, 'status', '--porcelain'), '');
    const applied = migrateVault(root, { fixLegacyLinks: true, apply: true });
    assert.equal(applied.linkCount, 1);
    assert.deepEqual(applied.brokenLinks, []);
    assert.equal(readFileSync(join(root, index), 'utf8'),
      `[[${reportDestination.slice(0, -3)}|첫 줄\n[제우스] 둘째 줄]] \`[[${reportSource.slice(0, -3)}]]\``);
    assert.equal(existsSync(join(root, reportDestination)), true);
  });
});

test('--fix-legacy-links는 목적지 연도가 모호하면 링크를 보류하고 보고한다', () => {
  const other = reportDestination.replace('/2026/', '/2025/');
  withVault({ [reportDestination]: '2026', [other]: '2025', '90_Delphi/index.md': `[[${reportSource.slice(0, -3)}]]` }, (root) => {
    const planned = migrateVault(root, { fixLegacyLinks: true });
    assert.equal(planned.linkCount, 0);
    assert.equal(planned.unresolvedLegacyLinks.length, 1);
    assert.equal(planned.unresolvedLegacyLinks[0].candidates.length, 2);
    assert.equal(git(root, 'status', '--porcelain'), '');
  });
});

test('--fix-legacy-links는 미해결 링크를 보고하면서 해석 가능한 링크를 적용한다', () => {
  const other = reportDestination.replace('/2026/', '/2025/');
  const directFrom = noteSource.slice(0, -3);
  const index = '90_Delphi/index.md';
  withVault({ [reportDestination]: '2026', [other]: '2025', [noteDestination]: '노트',
    [index]: `[[${reportSource.slice(0, -3)}]] [[${directFrom}]]` }, (root) => {
    const result = migrateVault(root, { fixLegacyLinks: true, apply: true });
    assert.equal(result.linkCount, 1);
    assert.deepEqual(result.unresolvedLegacyLinks.map(({ target }) => target), [reportSource.slice(0, -3)]);
    assert.deepEqual(result.brokenLinks, [{ file: index, target: reportSource.slice(0, -3) }]);
    assert.equal(readFileSync(join(root, index), 'utf8'),
      `[[${reportSource.slice(0, -3)}]] [[${noteDestination.slice(0, -3)}]]`);
  });
});

test('--fix-legacy-links 직후 --map은 검증된 선행 수정만 허용하고 보존한다', () => {
  const from = noteDestination;
  const to = '40_Projects/banana-portfolio/Features/note.md';
  const index = '90_Delphi/index.md';
  const mapPath = join(tmpdir(), `vault-map-after-fix-${process.pid}.json`);
  withVault({ [from]: '본문', [index]: `[[${noteSource.slice(0, -3)}]]` }, (root) => {
    try {
      writeFileSync(mapPath, JSON.stringify([{ from, to, mode: 'move' }]));
      migrateVault(root, { fixLegacyLinks: true, apply: true });
      const fixed = readFileSync(join(root, index), 'utf8');
      assert.equal(fixed, `[[${from.slice(0, -3)}]]`);
      const mapped = migrateVault(root, { mapPath, apply: true });
      assert.equal(mapped.moveCount, 1);
      assert.equal(readFileSync(join(root, index), 'utf8'), `[[${to.slice(0, -3)}]]`);
      assert.equal(migrateVault(root, { mapPath, apply: true }).moveCount, 0);
      writeFileSync(join(root, index), '사람의 임의 수정');
      assert.throws(() => migrateVault(root, { mapPath, apply: true }), /예상한 이관 내용과 다릅니다/);
    } finally { rmSync(mapPath, { force: true }); }
  });
});

test('--fix-legacy-links는 링크 쓰기 후 오류가 나면 원본과 깨끗한 작업 트리를 복구한다', () => {
  const index = '90_Delphi/index.md';
  const original = `[[${noteSource.slice(0, -3)}]]`;
  withVault({ [noteDestination]: '노트', [index]: original }, (root) => {
    const reportPath = join(root, '없는-부모', 'report.json');
    assert.throws(() => migrateVault(root, { fixLegacyLinks: true, apply: true, reportPath }), /ENOENT/);
    assert.equal(readFileSync(join(root, index), 'utf8'), original);
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.equal(existsSync(reportPath), false);
  });
});
