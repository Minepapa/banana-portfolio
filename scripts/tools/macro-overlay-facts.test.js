import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPreviousFaberState, writeFaberState, renderSignalsReport } from './macro-overlay-facts.mjs';

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

// renderSignalsReport — 2026-09-12 신설(한국 국고채 스프레드 추가 시점). 이전엔
// 테스트가 아예 없어(이번에 처음 추가) 헤더 문구 변경·필드명 렌더링 경로가 회귀
// 감지 없이 바뀔 수 있었다.
const normal = () => ({
  faberDomestic: { aboveMA: true, deviationPct: 1.2 }, faberDomesticCrossed: false,
  faberForeign: { aboveMA: true, deviationPct: 0.8 }, faberForeignCrossed: false,
  usRateSpread: { currentSpread: 0.5, inverted: false },
  koreaRateSpread: { currentSpread: 0.6, inverted: false },
  dxy: { current: 100, breached: false }, vix: { current: 15, breached: false },
  wti: { current: 70, breached: false },
  anyMeaningfulChange: false,
});

test('[신설/2026-09-12] renderSignalsReport: ECOS 미연동 안내 문구가 사라짐(2026-09-12 연동 완료)', () => {
  const text = renderSignalsReport(normal());
  assert.doesNotMatch(text, /ECOS 한국채권스프레드 미연동/);
});

test('[신설/2026-09-12] renderSignalsReport: 한국·미국 금리차 둘 다 라인으로 렌더', () => {
  const text = renderSignalsReport(normal());
  assert.match(text, /한국금리차\(국고채10Y-3Y\): 0\.60%p/);
  assert.match(text, /미국금리차\(10Y-3M\): 0\.50%p/);
});

test('renderSignalsReport: 한국 금리차 역전이면 [경고] 표시', () => {
  const s = normal();
  s.koreaRateSpread = { currentSpread: -0.3, inverted: true };
  const text = renderSignalsReport(s);
  assert.match(text, /한국금리차\(국고채10Y-3Y\): -0\.30%p\n {4}→ \[경고\] 역전/);
});

test('[회귀방지/2026-09-12] renderSignalsReport: 역전은 안 됐지만 볼린저 ±2σ 이탈이면(변동성 이탈) 여전히 [경고] 표시 — 실측 라이브 dry-run 중 발견된 버그', () => {
  const s = normal();
  s.koreaRateSpread = { currentSpread: 0.53, inverted: false, bands: { zscore: 2.3 } };
  const text = renderSignalsReport(s);
  assert.match(text, /한국금리차\(국고채10Y-3Y\): 0\.53%p\n {4}→ \[경고\] 변동성 이탈\(z=2\.3\)/);
});

test('renderSignalsReport: 금리차 데이터 없으면(null) "데이터 없음"', () => {
  const s = normal();
  s.koreaRateSpread = null;
  const text = renderSignalsReport(s);
  assert.match(text, /한국금리차\(국고채10Y-3Y\): 데이터 없음/);
});

test('renderSignalsReport: anyMeaningfulChange=false면 [정상] 요약, true면 [경고] 요약(daily-asset-allocation-check.mjs가 .includes("[경고]")로 판정하는 신호이므로 문자열 자체를 회귀 고정)', () => {
  assert.match(renderSignalsReport(normal()), /\[정상\] 5개 신호\(한국·미국 금리차 포함 7개 계산\) 전부 조용함/);
  assert.match(renderSignalsReport({ ...normal(), anyMeaningfulChange: true }), /\[경고\] 의미있는 변화 감지/);
});
