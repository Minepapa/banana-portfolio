import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideGateRead } from './gate-read-guard.mjs';

// 임시 폴더로 볼트·저장소·바깥(자격증명 흉내)을 만든다. 실제 비밀 파일은 건드리지 않는다.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-read-'));
  const vault = join(dir, 'vault');
  const repo = join(dir, 'repo');
  const outside = join(dir, 'config');
  const adyton = join(vault, 'secret-room');
  for (const d of [vault, repo, outside, adyton]) mkdirSync(d, { recursive: true });
  writeFileSync(join(vault, 'a.md'), 'a');
  writeFileSync(join(repo, '.env'), 'K=1');
  writeFileSync(join(outside, 'token.json'), 't');
  symlinkSync(outside, join(vault, 'link-out'));
  return { dir, vault, repo, outside, adyton, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('허용 뿌리 안만 읽는다 — 바깥·심볼릭 링크로 나가기·금고·비밀 파일은 막는다', () => {
  const f = fixture();
  try {
    const base = { cwd: f.vault, roots: [f.vault, f.repo], deniedRoots: [f.adyton] };
    assert.equal(decideGateRead({ ...base, toolName: 'Read', toolInput: { file_path: join(f.vault, 'a.md') } }).block, false);
    assert.equal(decideGateRead({ ...base, toolName: 'Grep', toolInput: { pattern: 'x', path: f.repo } }).block, false);
    assert.equal(decideGateRead({ ...base, toolName: 'Glob', toolInput: { pattern: '**/*.md' } }).block, false, 'path 없으면 cwd(볼트)');
    assert.match(decideGateRead({ ...base, toolName: 'Read', toolInput: { file_path: join(f.outside, 'token.json') } }).reason, /볼트·저장소 안만/);
    assert.match(decideGateRead({ ...base, toolName: 'Read', toolInput: { file_path: join(f.vault, 'link-out', 'token.json') } }).reason, /볼트·저장소 안만/, '링크로 밖에 나가기');
    assert.match(decideGateRead({ ...base, toolName: 'Read', toolInput: { file_path: join(f.vault, '..', 'config', 'token.json') } }).reason, /볼트·저장소 안만/);
    assert.match(decideGateRead({ ...base, toolName: 'Glob', toolInput: { pattern: '*', path: f.adyton } }).reason, /금고/);
    assert.match(decideGateRead({ ...base, toolName: 'Read', toolInput: { file_path: join(f.repo, '.env') } }).reason, /비밀 파일/);
    assert.match(decideGateRead({ ...base, toolName: 'Glob', toolInput: { pattern: '**/.env*', path: f.repo } }).reason, /비밀 파일/);
    assert.match(decideGateRead({ ...base, toolName: 'Grep', toolInput: { pattern: 'K', path: f.repo, glob: '*.env' } }).reason, /비밀 파일/);
    assert.match(decideGateRead({ ...base, cwd: f.dir, toolName: 'Grep', toolInput: { pattern: 'x' } }).reason, /볼트·저장소 안만/, 'path 없고 cwd가 뿌리 밖');
    assert.match(decideGateRead({ ...base, roots: [], toolName: 'Read', toolInput: { file_path: join(f.vault, 'a.md') } }).reason, /허용 경로가 없어/, 'fail-closed');
    assert.equal(decideGateRead({ ...base, toolName: 'Agent', toolInput: {} }).block, false);
  } finally { f.cleanup(); }
});

test('훅 프로세스: 관문 실행(GATE=1)에서만 막고(exit 2), 다른 세션은 그대로 통과', () => {
  const f = fixture();
  try {
    const run = (env) => spawnSync(process.execPath, ['scripts/hooks/gate-read-guard.mjs'], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(f.outside, 'token.json') }, cwd: f.vault }),
      encoding: 'utf8', env: { PATH: process.env.PATH, ...env },
    });
    const blocked = run({ CLAUDE_TELEGRAM_GATE: '1', GATE_READ_ROOTS: `${f.vault}:${f.repo}` });
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /볼트·저장소 안만/);
    assert.equal(run({}).status, 0, '창구 실행이 아니면 관여하지 않음');
    assert.equal(run({ CLAUDE_TELEGRAM_GATE: '1' }).status, 2, '허용 뿌리가 없으면 막음');
  } finally { f.cleanup(); }
});

test('훅: 허용 뿌리 안의 토큰 캐시 폴더·토큰·자격증명 파일 이름도 막는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-read-tok-'));
  try {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'scripts', '.cache'), { recursive: true });
    const base = { cwd: repo, roots: [repo] };
    assert.match(decideGateRead({ ...base, toolName: 'Read', toolInput: { file_path: join(repo, 'scripts', '.cache', 'kis-token.json') } }).reason, /토큰 캐시|비밀 파일/);
    assert.match(decideGateRead({ ...base, toolName: 'Grep', toolInput: { pattern: 'x', path: join(repo, 'scripts', '.cache') } }).reason, /토큰 캐시/);
    assert.match(decideGateRead({ ...base, toolName: 'Read', toolInput: { file_path: join(repo, 'credentials.json') } }).reason, /비밀 파일/);
    assert.match(decideGateRead({ ...base, toolName: 'Read', toolInput: { file_path: join(repo, 'nhplug-token.json.invalid-9') } }).reason, /비밀 파일/);
    assert.equal(decideGateRead({ ...base, toolName: 'Read', toolInput: { file_path: join(repo, 'scripts', 'lib', 'telegram.mjs') } }).block, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('저장소 scripts/.cache는 뿌리째 거부(파일 이름과 무관) — Read·Grep(path 지정)·Glob 모두', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-read-cache-'));
  try {
    const repo = join(dir, 'repo');
    const cache = join(repo, 'scripts', '.cache');
    mkdirSync(cache, { recursive: true });
    const base = { cwd: repo, roots: [repo], deniedRoots: [cache] };
    for (const decision of [
      decideGateRead({ ...base, toolName: 'Read', toolInput: { file_path: join(cache, 'kis-token.json') } }),
      decideGateRead({ ...base, toolName: 'Read', toolInput: { file_path: join(cache, 'some-state.bin') } }),
      decideGateRead({ ...base, toolName: 'Grep', toolInput: { pattern: 'access', path: cache } }),
      decideGateRead({ ...base, toolName: 'Glob', toolInput: { pattern: '*', path: cache } }),
    ]) assert.match(decision.reason, /토큰 캐시/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Glob pattern이 절대경로면 그 경로도 허용 뿌리 안인지 본다', () => {
  const f = fixture();
  try {
    const base = { cwd: f.vault, roots: [f.vault, f.repo], deniedRoots: [f.adyton] };
    assert.match(decideGateRead({ ...base, toolName: 'Glob', toolInput: { pattern: `${f.outside}/**/*.json`, path: f.vault } }).reason, /볼트·저장소 안만/);
    assert.match(decideGateRead({ ...base, toolName: 'Glob', toolInput: { pattern: `${f.adyton}/*`, path: f.vault } }).reason, /금고|비밀/);
    assert.equal(decideGateRead({ ...base, toolName: 'Glob', toolInput: { pattern: `${f.vault}/**/*.md`, path: f.vault } }).block, false);
    assert.match(decideGateRead({ ...base, toolName: 'Glob', toolInput: { pattern: '~/.config/**', path: f.vault } }).reason, /볼트·저장소 안만/);
  } finally { f.cleanup(); }
});

test('제우스 확인 다섯 입력: 저장소 전체 Grep의 비밀 glob·type, Glob 절대경로·상대 비밀 폴더·비밀 이름 패턴을 막는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-read-zeus-'));
  try {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'scripts', '.cache'), { recursive: true });
    const home = process.env.HOME;
    const base = { cwd: repo, roots: [repo], deniedRoots: [] };
    const cases = [
      ['Grep', { path: repo, glob: '**/*token*', pattern: 'access_token' }],
      ['Grep', { path: repo, type: 'env', pattern: 'KEY' }],
      ['Glob', { path: repo, pattern: `${home}/.config/**` }],
      ['Glob', { path: repo, pattern: 'scripts/.cache/*' }],
      ['Glob', { path: repo, pattern: '**/*credential*' }],
    ];
    for (const [toolName, toolInput] of cases) {
      const decision = decideGateRead({ ...base, toolName, toolInput });
      assert.equal(decision.block, true, `${toolName} ${JSON.stringify(toolInput)}`);
    }
    // 평범한 검색은 그대로 된다.
    assert.equal(decideGateRead({ ...base, toolName: 'Grep', toolInput: { path: repo, glob: '**/*.mjs', pattern: 'export' } }).block, false);
    assert.equal(decideGateRead({ ...base, toolName: 'Glob', toolInput: { path: repo, pattern: 'scripts/lib/*.mjs' } }).block, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('제우스 재확인 다섯 경우(거부 뿌리에 scripts/.cache): Read 토큰 파일·Grep 캐시 폴더·Grep 비밀 glob·Glob 상대 캐시·Glob 절대 ~/.config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-read-five-'));
  try {
    const repo = join(dir, 'banana-portfolio-v2');
    const cache = join(repo, 'scripts', '.cache');
    mkdirSync(cache, { recursive: true });
    const base = { cwd: repo, roots: [repo], deniedRoots: [cache] };
    const five = [
      ['Read', { file_path: join(cache, 'kis-token.json') }],
      ['Grep', { path: cache, pattern: 'x' }],
      ['Grep', { path: repo, pattern: 'access_token', glob: '**/*token*' }],
      ['Glob', { path: repo, pattern: 'scripts/.cache/*' }],
      ['Glob', { path: repo, pattern: `${process.env.HOME}/.config/**` }],
    ];
    for (const [toolName, toolInput] of five) assert.equal(decideGateRead({ ...base, toolName, toolInput }).block, true, `${toolName} ${JSON.stringify(toolInput)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('상대 Glob pattern은 path에 이어 붙인 고정 접두 경로를 거부 뿌리로 검사한다(비밀 단어가 없어도)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-read-prefix-'));
  try {
    const repo = join(dir, 'repo');
    const privateDir = join(repo, 'private-dir');
    mkdirSync(privateDir, { recursive: true });
    const base = { cwd: repo, roots: [repo], deniedRoots: [privateDir] };
    assert.match(decideGateRead({ ...base, toolName: 'Glob', toolInput: { path: repo, pattern: 'private-dir/*' } }).reason, /금고·토큰 캐시/);
    assert.match(decideGateRead({ ...base, toolName: 'Glob', toolInput: { path: repo, pattern: '../outside/*' } }).reason, /볼트·저장소 안만/);
    assert.equal(decideGateRead({ ...base, toolName: 'Glob', toolInput: { path: repo, pattern: 'public/*' } }).block, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
