import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const fixture = mkdtempSync(join(tmpdir(), 'adyton-guard-'));
const vault = join(fixture, 'Mouseion');
const adyton = join(vault, '99_Adyton');
const unlockFile = join(fixture, 'config', 'adyton-unlock.json');
mkdirSync(adyton, { recursive: true });
symlinkSync(adyton, join(fixture, 'alias'));
symlinkSync(adyton, join(fixture, 'alias dir'));
symlinkSync(adyton, join(vault, 'alias'));

function hook(toolName, toolInput, extraEnv = {}, hookCwd = fixture) {
  return spawnSync(process.execPath, ['scripts/hooks/adyton-guard.mjs'], {
    cwd: process.cwd(),
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: hookCwd }),
    encoding: 'utf8',
    env: { ...process.env, VAULT_PATH: vault, ADYTON_UNLOCK_FILE: unlockFile, ...extraEnv },
  });
}

function expectBlocked(result) {
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /금고/);
}

test('도구별 금고 접근 차단 및 일반 경로 통과', () => {
  const cases = [
    ['Read', { file_path: join(adyton, 'a.md') }],
    ['Write', { file_path: join(adyton, 'a.md'), content: 'test' }],
    ['Edit', { file_path: join(adyton, 'a.md'), old_string: 'a', new_string: 'b' }],
    ['NotebookEdit', { notebook_path: join(adyton, 'a.ipynb') }],
    ['Grep', { path: vault, glob: '**/99_Adyton/**' }],
    ['Grep', { path: vault, pattern: '99_Adyton' }],
    ['Glob', { path: vault, pattern: '**/99_Adyton/**' }],
    ['Bash', { command: `cat ${join(adyton, 'a.md')}` }],
    ['Other', { nested: { target: join(adyton, 'a.md') } }],
    ['Other', { nested: { target: join(fixture, 'alias', 'a.md') } }],
  ];
  for (const [tool, input] of cases) expectBlocked(hook(tool, input));
  for (const [tool, input] of [
    ['Read', { file_path: join(vault, 'notes', 'a.md') }],
    ['Grep', { path: join(vault, 'notes'), glob: '**/*.md' }],
    ['Glob', { path: join(vault, 'notes'), pattern: '**/*.md' }],
    ['Grep', { path: vault, glob: '**/*.md' }],
    ['Glob', { path: fixture, pattern: '**/*.md' }],
    ['Bash', { command: `cat ${join(vault, 'notes', 'a.md')}` }],
  ]) assert.equal(hook(tool, input).status, 0, tool);
});

test('상위 폴더의 일반 작업은 통과한다', () => {
  const allowed = [
    `ls ${vault}`, `cd ${vault} && git status`, `ls ${fixture}`,
    `git -C ${vault} status`, `git -C ${vault} add -A`,
    `git -C ${vault} commit -m test`, `git -C ${vault} log`,
    `git -C ${vault} diff`, `git -C ${vault} mv old.md new.md`,
    `rg pattern ${vault}`, `node ${join(vault, 'script.mjs')}`,
    `wc ${join(vault, 'notes', 'a.md')}`,
    `sed -n '1,3p' ${join(vault, 'notes', 'a.md')}`,
    `python3 ${join(vault, 'script.py')}`,
    `find ${vault} -type f`,
  ];
  for (const command of allowed) assert.equal(hook('Bash', { command }).status, 0, command);
});

test('상위 폴더를 재귀적으로 읽거나 복사하는 Bash 명령은 막는다', () => {
  const blocked = [
    `grep -r secret ${vault}`, `grep -R secret ${fixture}`,
    `grep --recursive secret ${vault}`, `egrep -r secret ${vault}`,
    `rg --no-ignore secret ${vault}`, `rg --no-ignore-vcs secret ${vault}`,
    `rg -u secret ${vault}`, `rg -uu secret ${vault}`,
    `rg -uuu secret ${vault}`, `rg --hidden secret ${vault}`,
    `cd ${vault} && rg --hidden secret`,
    `find ${vault} -exec cat {} \\;`,
    `find ${vault} -print0 | xargs -0 cat`,
    `cat ${vault}/**/*.md`, `head ${vault}/*/*.md`,
    `tail ${vault}/**/*.md`, `less ${vault}/*/*.md`,
    `cp -r ${vault} backup`, `cp -R ${fixture} backup`,
    `cp -a ${vault} backup`, `cp --recursive ${vault} backup`,
    `rsync -a ${vault}/ backup/`, `tar cf backup.tar ${vault}`,
    `zip -r backup.zip ${vault}`, `ditto ${vault} backup`,
    `ls -R ${vault}`, `ls --recursive ${vault}`,
  ];
  for (const command of blocked) expectBlocked(hook('Bash', { command }));
});

test('명시한 외부 대상은 허용하고 외부 cwd에서도 볼트 글롭은 막는다', () => {
  const outside = join(tmpdir(), 'unrelated-notes');
  for (const command of [
    `rg --hidden secret ${outside}`,
    `grep -r secret ${outside}`,
    `cd ${vault} && rg --hidden secret ${outside}`,
    `cd ${vault} && grep -r secret ${outside}`,
  ]) assert.equal(hook('Bash', { command }).status, 0, command);
  for (const command of [
    `cat ${vault}/*/*.md`,
    `head ${vault}/**/*.md`,
    `tail ${fixture}/Mouseion/*/*.md`,
  ]) expectBlocked(hook('Bash', { command }, {}, tmpdir()));
});

test('상대 대상은 cwd 기준으로 판정하고 cd 뒤의 링크도 추적한다', () => {
  for (const command of [
    'rg --hidden secret notes',
    'cp -r notes backup',
  ]) {
    const result = hook('Bash', { command }, {}, vault);
    assert.equal(result.status, 0, command);
  }
  expectBlocked(hook('Bash', { command: `cd ${vault} && cat alias/a.md` }));
  expectBlocked(hook('Bash', { command: `cd ${vault} && rg --hidden ${join(tmpdir(), 'unrelated-pattern')} .` }));
  expectBlocked(hook('Bash', { command: 'rg --hidden secret .' }, {}, vault));
  expectBlocked(hook('Bash', { command: 'cp -r . backup' }, {}, vault));
});

test('대소문자, 정규화, 심볼릭 링크 별칭을 막는다', () => {
  expectBlocked(hook('Read', { file_path: join(vault, '99_adyton', 'a.md') }));
  expectBlocked(hook('Bash', { command: `ls ${join(vault, '99_aDyToN')}` }));
  expectBlocked(hook('Glob', { path: fixture, pattern: '**/99_adyton/**' }));
  expectBlocked(hook('Read', { file_path: `${vault}/notes/../99_Adyton/a.md` }));
  expectBlocked(hook('Read', { file_path: join(fixture, 'alias', 'a.md') }));
  expectBlocked(hook('Bash', { command: `cat "${join(fixture, 'alias', 'a.md')}"` }));
  expectBlocked(hook('Bash', { command: `cat "${join(fixture, 'alias dir', 'a.md')}"` }));
});

test('해제 중 허용하고 만료되면 차단한다', () => {
  mkdirSync(join(fixture, 'config'), { recursive: true });
  writeFileSync(unlockFile, JSON.stringify({ expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  assert.equal(hook('Read', { file_path: join(adyton, 'a.md') }).status, 0);
  writeFileSync(unlockFile, JSON.stringify({ expiresAt: new Date(Date.now() - 60_000).toISOString() }));
  expectBlocked(hook('Read', { file_path: join(adyton, 'a.md') }));
});

test('해제 중에도 해제 장치 조작과 텔레그램 접근을 막는다', () => {
  writeFileSync(unlockFile, JSON.stringify({ expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  symlinkSync(unlockFile, join(fixture, 'state-alias'));
  expectBlocked(hook('Bash', { command: 'node scripts/tools/adyton-unlock.mjs 15m' }));
  expectBlocked(hook('Bash', { command: "node scripts/tools/adyton'-'unlock.mjs 15m" }));
  expectBlocked(hook('Bash', { command: `rm ${unlockFile}` }));
  expectBlocked(hook('Bash', { command: `rm ${join(fixture, 'state-alias')}` }));
  expectBlocked(hook('Write', { file_path: unlockFile, content: '{}' }));
  expectBlocked(hook('Edit', { file_path: unlockFile, old_string: 'a', new_string: 'b' }));
  expectBlocked(hook('Read', { file_path: join(adyton, 'a.md') }, { CLAUDE_TELEGRAM_SESSION: '1' }));
});

test('파싱 오류에서 금고 문자열만 차단한다', () => {
  for (const [input, status] of [['{"file_path":"99_Adyton",', 2], ['{not-json', 0]]) {
    const result = spawnSync(process.execPath, ['scripts/hooks/adyton-guard.mjs'], {
      input, encoding: 'utf8',
      env: { ...process.env, VAULT_PATH: vault, ADYTON_UNLOCK_FILE: unlockFile },
    });
    assert.equal(result.status, status);
  }
});

test('예기치 않은 훅 오류도 금고 문자열이 있을 때만 차단한다', () => {
  // JSON.parse는 성공하지만 JSON.stringify에서 호출 스택이 넘치는 입력.
  for (const [leaf, status] of [['ordinary', 0], ['99_Adyton', 2]]) {
    const nested = '{"a":'.repeat(12_000) + JSON.stringify(leaf) + '}'.repeat(12_000);
    const input = `{"tool_name":"Other","tool_input":${nested}}`;
    const result = spawnSync(process.execPath, ['scripts/hooks/adyton-guard.mjs'], {
      input, encoding: 'utf8',
      env: { ...process.env, VAULT_PATH: vault, ADYTON_UNLOCK_FILE: unlockFile },
    });
    assert.equal(result.status, status, result.stderr);
  }
});

test('CLI 시간 상한, TTY 거부, 잠금과 파일 권한', async () => {
  process.env.ADYTON_UNLOCK_FILE = unlockFile;
  const { run, durationMs } = await import('../tools/adyton-unlock.mjs?test');
  assert.equal(durationMs('15m'), 15 * 60_000);
  assert.equal(durationMs('2h'), 2 * 60 * 60_000);
  assert.throws(() => durationMs('3h'), /최대 2시간/);
  assert.throws(() => run(['15m'], { isTTY: false }), /TTY/);
  assert.match(run(['15m'], { isTTY: true }), /금고 열림: \d\d:\d\d까지/);
  assert.equal(JSON.parse(readFileSync(unlockFile, 'utf8')).expiresAt.length > 0, true);
  assert.equal(statSync(unlockFile).mode & 0o777, 0o600);
  assert.match(run(['--status'], { isTTY: true }), /금고 열림/);
  assert.equal(run(['--lock'], { isTTY: true }), '금고 잠김');
  assert.equal(run(['--status'], { isTTY: true }), '금고 잠김');
  const piped = spawnSync(process.execPath, ['scripts/tools/adyton-unlock.mjs', '15m'], {
    encoding: 'utf8', env: { ...process.env, ADYTON_UNLOCK_FILE: unlockFile },
  });
  assert.equal(piped.status, 1);
  assert.match(piped.stderr, /TTY/);
});
