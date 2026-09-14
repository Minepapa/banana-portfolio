import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  expandBraces, parseWiringMapClusters, pathMatches, findRelatedClusters,
} from './wiring-map-parser.mjs';
import { VAULT_ROOT } from './vault-paths.mjs';

test('expandBraces: 중괄호 없으면 그대로 1개 반환', () => {
  assert.deepEqual(expandBraces('scripts/lib/x.mjs'), ['scripts/lib/x.mjs']);
});

test('expandBraces: {a,b,c} 전개', () => {
  const result = expandBraces('scripts/tools/{kill-switch,execution-mode}-cli.mjs');
  assert.deepEqual(result, ['scripts/tools/kill-switch-cli.mjs', 'scripts/tools/execution-mode-cli.mjs']);
});

test('expandBraces: .claude/agents/{a,b,c}.md 전개', () => {
  const result = expandBraces('.claude/agents/{zeus,athena}.md');
  assert.deepEqual(result, ['.claude/agents/zeus.md', '.claude/agents/athena.md']);
});

const SAMPLE = `
## 클러스터 1 — 무인 잡(launchd) 카탈로그

**정본**: \`scripts/launchd/com.banana2.*.plist\`(각 잡의 실제 스케줄)

| 종속 파일 | 무엇을 담는가 | 가드 |
|---|---|---|
| \`scripts/launchd/run.sh\` | 잡 이름→스크립트 경로 매핑 | 수동 |
| \`scripts/jobs/health-watcher.mjs\`(\`EXPECTED_INTERVALS_MS\`) | 잡별 기대 실행주기 | **테스트**(health-watcher.test.js) |
| \`scripts/tools/{kill-switch,execution-mode}-cli.mjs\` | CLI 2종 | 수동 |

## 클러스터 2 — 다른 것

**정본**: \`scripts/lib/rebalance-gap.mjs\`의 \`TARGET_ALLOCATION\`(현재 값)

| 종속 파일 | 무엇을 담는가 | 가드 |
|---|---|---|
| \`State/Allocation/*.md\`(현재 18개) | 대시보드 표시값 | **자동 갱신** |
`;

test('parseWiringMapClusters: 클러스터 2개, 각 종속파일·가드 파싱', () => {
  const clusters = parseWiringMapClusters(SAMPLE);
  assert.equal(clusters.length, 2);
  const c1 = clusters[0];
  assert.equal(c1.name, '클러스터 1 — 무인 잡(launchd) 카탈로그');
  assert.deepEqual(c1.sourcePaths, ['scripts/launchd/com.banana2.*.plist']);
  // run.sh(수동) + health-watcher.mjs(테스트) + kill-switch-cli.mjs·execution-mode-cli.mjs(수동, 중괄호 전개)
  assert.equal(c1.entries.length, 4);
  assert.deepEqual(c1.entries.map((e) => e.path), [
    'scripts/launchd/run.sh', 'scripts/jobs/health-watcher.mjs',
    'scripts/tools/kill-switch-cli.mjs', 'scripts/tools/execution-mode-cli.mjs',
  ]);
  assert.equal(c1.entries[0].guard, '수동');
  assert.equal(c1.entries[1].guard, '테스트');
  assert.equal(c1.entries[2].guard, '수동');
});

test('parseWiringMapClusters: 정본 줄에서 코드 상수(백틱, 슬래시·확장자 없음)는 경로로 안 잡음', () => {
  const clusters = parseWiringMapClusters(SAMPLE);
  const c2 = clusters[1];
  assert.deepEqual(c2.sourcePaths, ['scripts/lib/rebalance-gap.mjs']); // TARGET_ALLOCATION은 제외
});

test('parseWiringMapClusters: 와일드카드 종속경로(State/Allocation/*.md)도 그대로 보존', () => {
  const clusters = parseWiringMapClusters(SAMPLE);
  assert.equal(clusters[1].entries[0].path, 'State/Allocation/*.md');
});

test('pathMatches: 정확히 같은 경로', () => {
  assert.equal(pathMatches('scripts/lib/x.mjs', 'scripts/lib/x.mjs'), true);
  assert.equal(pathMatches('scripts/lib/x.mjs', 'scripts/lib/y.mjs'), false);
});

test('pathMatches: 와일드카드 접두사 매칭', () => {
  assert.equal(pathMatches('State/Allocation/*.md', 'State/Allocation/위탁-채권.md'), true);
  assert.equal(pathMatches('State/Allocation/*.md', 'State/Holdings/위탁-채권.md'), false);
});

test('pathMatches: .md 확장자 유무 차이는 무시(Vault relPath는 확장자 없이 옴)', () => {
  assert.equal(pathMatches('Knowledge/Meta/Index.md', 'Knowledge/Meta/Index'), true);
});

test('findRelatedClusters: 종속파일 하나를 건드리면 그 클러스터의 나머지(정본 제외)를 돌려줌', () => {
  const clusters = parseWiringMapClusters(SAMPLE);
  const result = findRelatedClusters(clusters, 'scripts/launchd/run.sh');
  assert.equal(result.length, 1);
  assert.equal(result[0].isSource, false);
  assert.equal(result[0].others.length, 3); // run.sh 자신 빼고 나머지 3개
  assert.ok(!result[0].others.some((o) => o.path === 'scripts/launchd/run.sh'));
});

test('findRelatedClusters: 정본 자체를 건드리면 isSource=true, others는 전체 종속파일', () => {
  const clusters = parseWiringMapClusters(SAMPLE);
  // 정본은 와일드카드 plist라 임의 플러그인 plist 경로로 매칭
  const result = findRelatedClusters(clusters, 'scripts/launchd/com.banana2.foo.plist');
  assert.equal(result.length, 1);
  assert.equal(result[0].isSource, true);
  assert.equal(result[0].others.length, 4);
});

test('findRelatedClusters: 아무 클러스터에도 안 걸리면 빈 배열', () => {
  const clusters = parseWiringMapClusters(SAMPLE);
  assert.deepEqual(findRelatedClusters(clusters, 'scripts/lib/completely-unrelated.mjs'), []);
});

// 실제 파일배선도.md 문서에 대해 파서가 안 죽고 뭔가 뽑아내는지 스모크 테스트 —
// 문서가 자유롭게 편집되므로 정확한 개수를 하드코딩하지 않고 "0개는 아니다"만 확인.
test('[스모크] 실제 므네모시네 파일배선도.md를 파싱해도 에러 없고 클러스터가 나온다', () => {
  const path = join(VAULT_ROOT, 'Knowledge', 'Meta', '므네모시네-파일배선도.md');
  const content = readFileSync(path, 'utf8');
  const clusters = parseWiringMapClusters(content);
  assert.ok(clusters.length > 0, '클러스터가 최소 1개는 파싱돼야 함');
  const totalEntries = clusters.reduce((s, c) => s + c.entries.length, 0);
  assert.ok(totalEntries > 0, '종속 파일이 최소 1개는 파싱돼야 함');
});
