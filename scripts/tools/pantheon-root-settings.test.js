import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootHookSettings } from './pantheon-root-settings.mjs';

test('루트 설정은 훅만 복사하고 명령의 프로젝트 변수만 저장소 절대경로로 바꾼다', () => {
  const settings = {
    permissions: { allow: ['Bash(*)'] },
    hooks: { Stop: [{ matcher: '*', hooks: [{
      type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/hooks/guard.mjs"', timeout: 10,
    }] }] },
  };
  const generated = rootHookSettings(settings, '/Users/test/Pantheon/Repos/banana-portfolio-v2');
  assert.deepEqual(generated, { hooks: { Stop: [{ matcher: '*', hooks: [{
    type: 'command', command: 'node "/Users/test/Pantheon/Repos/banana-portfolio-v2/scripts/hooks/guard.mjs"', timeout: 10,
  }] }] } });
  assert.match(settings.hooks.Stop[0].hooks[0].command, /\$CLAUDE_PROJECT_DIR/);
});

test('실제 저장소 설정의 훅 명령 10개를 모두 절대경로로 출력한다(2026-10-08 쓰기 관문 추가)', () => {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const settings = JSON.parse(readFileSync(join(repositoryRoot, '.claude/settings.json'), 'utf8'));
  const generated = rootHookSettings(settings, repositoryRoot);
  const commands = Object.values(generated.hooks).flatMap((entries) =>
    entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)));
  assert.equal(commands.length, 10);
  assert.equal(commands.every((command) => command.includes(`${repositoryRoot}/scripts/hooks/`)), true);
  assert.equal(commands.some((command) => command.includes('$CLAUDE_PROJECT_DIR')), false);
  assert.deepEqual(Object.keys(generated), ['hooks']);
});
