import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPreviousFaberState, writeFaberState } from './macro-overlay-facts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'macro-overlay-facts-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('readPreviousFaberState: stateDir에 파일 없으면 둘 다 null(첫 확인)', () => {
  withTmpDir((dir) => {
    const r = readPreviousFaberState(dir);
    assert.deepEqual(r, { domestic: null, foreign: null });
  });
});

test('writeFaberState → readPreviousFaberState: 넘긴 stateDir에 쓰고 그 경로에서 그대로 읽힘', () => {
  withTmpDir((dir) => {
    writeFaberState(true, false, dir);
    const r = readPreviousFaberState(dir);
    assert.deepEqual(r, { domestic: true, foreign: false });
  });
});

test('writeFaberState: 서로 다른 stateDir은 완전히 독립(한쪽 갱신이 다른 쪽에 영향 없음)', () => {
  withTmpDir((dirA) => {
    withTmpDir((dirB) => {
      writeFaberState(true, true, dirA);
      writeFaberState(false, false, dirB);
      assert.deepEqual(readPreviousFaberState(dirA), { domestic: true, foreign: true });
      assert.deepEqual(readPreviousFaberState(dirB), { domestic: false, foreign: false });
    });
  });
});

// stateDir 생략 시 기본값이 VAULT_PATHS.state.macroOverlay(daily-asset-allocation-
// check.mjs가 공유하는 경로)로 고정돼 있는지 확인(2026-09-06 코드리뷰 지적, LOW —
// 이 프로퍼티가 무테스트면 다음 리팩터가 기본값을 조용히 바꿔도 그린으로 통과할 수
// 있었다). 실제 VAULT_PATH를 임시 디렉터리로 오버라이드한 별도 프로세스에서 확인해
// 진짜 ~/banana-vault를 건드리지 않는다(vault-paths.test.js와 동일 격리 기법).
test('writeFaberState/readPreviousFaberState: stateDir 생략하면 VAULT_PATHS.state.macroOverlay가 기본값(daily 잡과 공유하는 경로)', () => {
  withTmpDir((tmpVaultRoot) => {
    const script = join(HERE, 'macro-overlay-facts.mjs');
    const code = `
      import { writeFaberState, readPreviousFaberState } from '${script.replace(/\\/g, '\\\\')}';
      writeFaberState(true, false); // stateDir 생략 — 기본값 경로에 써야 함
      console.log(JSON.stringify(readPreviousFaberState()));
    `;
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', code],
      { env: { ...process.env, VAULT_PATH: tmpVaultRoot } },
    ).toString().trim();
    assert.deepEqual(JSON.parse(out), { domestic: true, foreign: false });
    assert.ok(existsSync(join(tmpVaultRoot, 'State', 'MacroOverlay', 'faber-state.md')));
  });
});
