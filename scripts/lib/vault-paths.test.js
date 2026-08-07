// vault-paths.mjs 테스트 — VAULT_PATH 환경변수로 경로가 바뀌는지, 4대분류 하위경로가
// 전부 그 루트 밑에 걸리는지 확인. 모듈은 import 시점에 env를 한 번 읽으므로, 오버라이드
// 테스트는 자식 프로세스로 분리 실행한다(같은 프로세스에서 재-import해도 캐시돼 반영 안 됨).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VAULT_ROOT, VAULT_PATHS } from './vault-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('기본값: VAULT_PATH 미설정 시 홈 디렉토리 아래 banana-vault', () => {
  assert.match(VAULT_ROOT, /banana-vault$/);
});

// facts.ledger는 이벤트 종류별 하위폴더가 있는 중첩 객체라(2026-08-04 확정) 재귀로 편다.
function flattenPaths(obj) {
  const out = [];
  for (const v of Object.values(obj)) {
    if (typeof v === 'string') out.push(v);
    else out.push(...flattenPaths(v));
  }
  return out;
}

test('4대분류 하위경로가 전부 VAULT_ROOT 밑에 걸린다', () => {
  const flat = [
    ...flattenPaths(VAULT_PATHS.facts),
    ...flattenPaths(VAULT_PATHS.state),
    ...flattenPaths(VAULT_PATHS.decisions),
    ...flattenPaths(VAULT_PATHS.knowledge),
  ];
  // facts: ledgerRoot(1) + ledger 하위 7종(Phase 7에서 profits·dailySnapshots 추가) +
  // marketPolls(1) = 9, state 7(+jobHealth, +Phase 8 macroOverlay, +Phase 9 killSwitch·
  // executionMode), decisions 4(+riskMonitor), knowledge 3
  assert.equal(flat.length, 23);
  for (const p of flat) assert.ok(p.startsWith(VAULT_ROOT), `${p} should start with ${VAULT_ROOT}`);
});

test('Ledger 이벤트 종류별 하위폴더 7종이 전부 Facts/Ledger 밑에 걸린다', () => {
  const subfolders = Object.values(VAULT_PATHS.facts.ledger);
  assert.equal(subfolders.length, 7);
  for (const p of subfolders) assert.ok(p.startsWith(VAULT_PATHS.facts.ledgerRoot));
});

test('VAULT_PATH 환경변수로 루트를 오버라이드할 수 있다(Drive 이전 시 코드 변경 없이 전환)', () => {
  const script = join(HERE, 'vault-paths.mjs');
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `import { VAULT_ROOT } from '${script.replace(/\\/g, '\\\\')}'; console.log(VAULT_ROOT);`],
    { env: { ...process.env, VAULT_PATH: '/tmp/custom-vault' } },
  ).toString().trim();
  assert.equal(out, '/tmp/custom-vault');
});
