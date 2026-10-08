#!/usr/bin/env node
// Pantheon 루트 세션용 훅 설정을 stdout에만 출력한다. 설치는 사람이 검토 후 수행한다.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function rootHookSettings(settings, repositoryRoot) {
  const hooks = structuredClone(settings.hooks);
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if (typeof hook.command === 'string') {
          hook.command = hook.command.replaceAll('$CLAUDE_PROJECT_DIR', repositoryRoot);
        }
      }
    }
  }
  return { hooks };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const settings = JSON.parse(readFileSync(join(REPOSITORY_ROOT, '.claude', 'settings.json'), 'utf8'));
  console.log(JSON.stringify(rootHookSettings(settings, REPOSITORY_ROOT), null, 2));
}
