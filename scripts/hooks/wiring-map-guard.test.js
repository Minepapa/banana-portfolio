import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { candidateRelPaths, buildReminderMessage } from './wiring-map-guard.mjs';

test('Pantheon 세션 cwd의 상대경로도 Vault와 저장소 경로로 분류한다', () => {
  const pantheonRoot = '/Users/test/Pantheon';
  const vaultRoot = join(pantheonRoot, 'Mouseion');
  const codeRepoRoot = join(pantheonRoot, 'Repos/banana-portfolio-v2');
  assert.deepEqual(candidateRelPaths(join(pantheonRoot, 'Mouseion/Knowledge/Meta/Index.md'), vaultRoot, codeRepoRoot),
    ['Knowledge/Meta/Index.md']);
  assert.deepEqual(candidateRelPaths(join(pantheonRoot, 'Repos/banana-portfolio-v2/scripts/lib/x.mjs'), vaultRoot, codeRepoRoot),
    ['scripts/lib/x.mjs']);
});

test('candidateRelPaths: 파일이 vaultRoot 안에 있으면 vault 상대경로만 반환', () => {
  const result = candidateRelPaths('/vault/Knowledge/Meta/Index.md', '/vault', '/code');
  assert.deepEqual(result, ['Knowledge/Meta/Index.md']);
});

test('candidateRelPaths: 파일이 codeRepoRoot 안에 있으면 code 상대경로만 반환', () => {
  const result = candidateRelPaths('/code/scripts/lib/x.mjs', '/vault', '/code');
  assert.deepEqual(result, ['scripts/lib/x.mjs']);
});

test('candidateRelPaths: 둘 다 밖이면(예: /tmp) 빈 배열', () => {
  assert.deepEqual(candidateRelPaths('/tmp/scratch.md', '/vault', '/code'), []);
});

test('buildReminderMessage: others가 있으면 수동/그 외 나눠 메시지 조립', () => {
  const related = [{
    name: '클러스터 1 — 테스트',
    isSource: false,
    others: [
      { path: 'a.mjs', guard: '수동' },
      { path: 'b.mjs', guard: '테스트' },
    ],
  }];
  const msg = buildReminderMessage('run.sh', related);
  assert.match(msg, /파일배선도/);
  assert.match(msg, /수동가드.*a\.mjs/);
  assert.match(msg, /그 외.*b\.mjs/);
});

test('buildReminderMessage: others 전부 비어있으면 null(알림 안 보냄)', () => {
  const related = [{ name: '클러스터 1', isSource: true, others: [] }];
  assert.equal(buildReminderMessage('x', related), null);
});

test('buildReminderMessage: 관련 클러스터 자체가 없으면 null', () => {
  assert.equal(buildReminderMessage('x', []), null);
});
